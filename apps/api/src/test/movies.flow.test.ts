/**
 * Phase 4 flow tests: the PLAN.md "Done when" items for the Movies API, proven across
 * endpoints through createApp + supertest. Per-endpoint details live in
 * routes/movie.admin.routes.test.ts and routes/movie.public.routes.test.ts; this file checks
 * the three promises end to end:
 *   1. deactivated or deleted movies never appear publicly;
 *   2. an EDITOR cannot hard delete;
 *   3. every admin change creates an audit log row (and nothing else does).
 *
 * Nothing here depends on the clock: no assertion reads a timestamp, and the public cache TTL
 * (5 min) is far longer than any test.
 */
import { randomUUID } from 'node:crypto';
import {
  adminMovieResponseSchema,
  apiErrorSchema,
  publicMovieListResponseSchema,
  publicMovieResponseSchema,
} from '@sk-cinema/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMovieAdminController } from '../controllers/movie.admin.controller.js';
import type { AdminRole, AuditAction, Movie, MovieStatus } from '../generated/prisma/client.js';
import { MemoryCache } from '../lib/cache.js';
import { FORBIDDEN_MESSAGE } from '../middleware/auth.js';
import { CSRF_HEADER } from '../middleware/csrf.js';
import { SESSION_EXPIRED_MESSAGE } from '../services/auth.service.js';
import {
  MOVIE_ALREADY_DELETED_MESSAGE,
  MOVIE_DELETE_FIRST_MESSAGE,
  MOVIE_NOT_DELETED_MESSAGE,
  MOVIE_NOT_FOUND_MESSAGE,
  MOVIE_RESTORE_FIRST_MESSAGE,
  SLUG_IN_USE_MESSAGE,
  createMovieAdminService,
} from '../services/movie.admin.service.js';
import { movieAdminRoutes } from '../routes/movie.admin.routes.js';
import {
  ADMIN_BASE,
  ADMIN_ORIGIN,
  TEST_USER_AGENT,
  authClient,
  buildTestApp,
  inMemoryAuthDb,
  sessionFrom,
  testAdmin,
  testMovie,
  testPasswordHash,
  type AuthClient,
  type InMemoryAuthDb,
  type Session,
} from './helpers.js';

const EMAIL = 'admin@skcinema.lk';
const PASSWORD = 'correct horse battery staple';
/** The client address every request claims (X-Forwarded-For, honoured with trustProxy: 1). */
const CLIENT_IP = '203.0.113.7';
const TRASHED_AT = new Date('2026-10-01T00:00:00.000Z');

const UNAUTHORIZED_BODY = { error: { code: 'UNAUTHORIZED', message: SESSION_EXPIRED_MESSAGE } };
const CSRF_BODY = { error: { code: 'CSRF_INVALID', message: 'CSRF validation failed' } };
const FORBIDDEN_BODY = { error: { code: 'FORBIDDEN', message: FORBIDDEN_MESSAGE } };
const INTERNAL_BODY = { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } };

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await testPasswordHash(PASSWORD);
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Flow {
  app: Express;
  db: InMemoryAuthDb;
  cache: MemoryCache;
  adminId: string;
  client: AuthClient;
  /** Undefined when set up with `signedIn: false`. */
  session: Session | undefined;
  /** Audit rows before the request under test (login writes its own). */
  auditsBefore: number;
}

interface SetupOptions {
  role?: AdminRole;
  movies?: Movie[];
  /** false: CSRF cookie + token only, no login. */
  signedIn?: boolean;
}

async function setup({ role = 'EDITOR', movies = [], signedIn = true }: SetupOptions = {}) {
  const admin = testAdmin({ email: EMAIL, passwordHash, role });
  const db = inMemoryAuthDb({ admins: [admin], movies });
  const { app, cache } = buildTestApp({ prisma: db.prisma, config: { trustProxy: 1 } });
  const client = await authClient(app, { ip: CLIENT_IP });
  let session: Session | undefined;
  if (signedIn) {
    const login = await client.post('/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    expect(login.status).toBe(200);
    session = sessionFrom(login);
  }
  // Count only what the request under test does.
  vi.clearAllMocks();
  const flow: Flow = {
    app,
    db,
    cache,
    adminId: admin.id,
    client,
    session,
    auditsBefore: db.auditLogs.length,
  };
  return flow;
}

type Method = 'get' | 'post' | 'patch' | 'delete';

interface SendOptions {
  body?: object;
  /** false: no access cookie. */
  withSession?: boolean;
  /** false: no X-CSRF-Token header. */
  withCsrf?: boolean;
  /** Appended to the path, e.g. "?force=1". */
  query?: string;
}

/**
 * A request from the admin app: its Origin, CSRF cookie + token, session cookie, user agent
 * and client IP. `path` is below /api/admin/movies ('' for the collection).
 */
function send(f: Flow, method: Method, path: string, options: SendOptions = {}) {
  const { body, withSession = true, withCsrf = true, query = '' } = options;
  const cookies = [f.client.csrf.cookie];
  if (withSession && f.session) cookies.push(f.session.access);
  let req = request(f.app)
    [method](`${ADMIN_BASE}/movies${path}${query}`)
    .set('User-Agent', TEST_USER_AGENT)
    .set('X-Forwarded-For', CLIENT_IP)
    .set('Origin', ADMIN_ORIGIN)
    .set('Cookie', cookies.join('; '));
  if (withCsrf) req = req.set(CSRF_HEADER, f.client.csrf.token);
  return body === undefined ? req : req.send(body);
}

const movieAudits = (db: InMemoryAuthDb) => db.auditLogs.filter((row) => row.entity === 'Movie');

/** A copy of the movies table, to compare with later (no write may change it). */
const snapshot = (db: InMemoryAuthDb): Movie[] => structuredClone(db.movies);

function expectError(res: request.Response, status: number, code: string, message?: string) {
  expect(res.status).toBe(status);
  const { error } = apiErrorSchema.parse(res.body);
  expect(error.code).toBe(code);
  if (message !== undefined) expect(error.message).toBe(message);
}

/** An UPCOMING, active, live movie "Avatar". */
const avatar = (overrides: Partial<Movie> = {}) =>
  testMovie({ slug: 'avatar', title: 'Avatar', durationMinutes: 162, ...overrides });
const trashedAvatar = (overrides: Partial<Movie> = {}) =>
  avatar({ deletedAt: TRASHED_AT, ...overrides });

// ---------------------------------------------------------------------------
// Every admin movie endpoint, with a request it accepts
// ---------------------------------------------------------------------------

interface Endpoint {
  /** "METHOD /path" as registered in routes/movie.admin.routes.ts. */
  route: string;
  method: Method;
  /** The path below /api/admin/movies for the movie `id`. */
  path: (id: string) => string;
  /** The movie the request is accepted for (null: the request needs none). */
  seed: (() => Movie) | null;
  body?: object;
  /** The success status. */
  status: number;
  /** Roles allowed to call it. */
  roles: readonly AdminRole[];
  /** Whether it changes data (and so must be audited). */
  mutation: boolean;
}

const BOTH_ROLES = ['SUPER_ADMIN', 'EDITOR'] as const;

const ENDPOINTS: Endpoint[] = [
  {
    route: 'POST /',
    method: 'post',
    path: () => '',
    seed: null,
    body: { title: 'Avatar', durationMinutes: 162 },
    status: 201,
    roles: BOTH_ROLES,
    mutation: true,
  },
  {
    route: 'GET /',
    method: 'get',
    path: () => '',
    seed: avatar,
    status: 200,
    roles: BOTH_ROLES,
    mutation: false,
  },
  {
    route: 'GET /:id',
    method: 'get',
    path: (id) => `/${id}`,
    seed: avatar,
    status: 200,
    roles: BOTH_ROLES,
    mutation: false,
  },
  {
    route: 'PATCH /:id',
    method: 'patch',
    path: (id) => `/${id}`,
    seed: avatar,
    body: { title: 'Avatar 2' },
    status: 200,
    roles: BOTH_ROLES,
    mutation: true,
  },
  {
    route: 'PATCH /:id/status',
    method: 'patch',
    path: (id) => `/${id}/status`,
    seed: avatar,
    body: { status: 'NOW_SHOWING' },
    status: 200,
    roles: BOTH_ROLES,
    mutation: true,
  },
  {
    route: 'PATCH /:id/active',
    method: 'patch',
    path: (id) => `/${id}/active`,
    seed: avatar,
    body: { isActive: false },
    status: 200,
    roles: BOTH_ROLES,
    mutation: true,
  },
  {
    route: 'DELETE /:id',
    method: 'delete',
    path: (id) => `/${id}`,
    seed: avatar,
    status: 200,
    roles: BOTH_ROLES,
    mutation: true,
  },
  {
    route: 'POST /:id/restore',
    method: 'post',
    path: (id) => `/${id}/restore`,
    seed: trashedAvatar,
    status: 200,
    roles: BOTH_ROLES,
    mutation: true,
  },
  {
    route: 'DELETE /:id/permanent',
    method: 'delete',
    path: (id) => `/${id}/permanent`,
    seed: trashedAvatar,
    status: 204,
    roles: ['SUPER_ADMIN'],
    mutation: true,
  },
];

/** A seeded movie list and the id to call the endpoint with. */
function seedFor(endpoint: Endpoint): { movies: Movie[]; id: string } {
  const movie = endpoint.seed?.();
  return movie ? { movies: [movie], id: movie.id } : { movies: [], id: randomUUID() };
}

interface RouteLayerLike {
  route?: { path: unknown; methods: Record<string, boolean | undefined> };
}

/** "METHOD /path" for every route registered by movieAdminRoutes, in registration order. */
function registeredMovieAdminRoutes(): string[] {
  const service = createMovieAdminService({
    db: inMemoryAuthDb().prisma,
    cache: new MemoryCache(),
  });
  const router = movieAdminRoutes(createMovieAdminController(service)) as unknown as {
    stack: RouteLayerLike[];
  };
  return router.stack.flatMap(({ route }) =>
    route
      ? Object.entries(route.methods)
          .filter(([, enabled]) => enabled)
          .map(([method]) => `${method.toUpperCase()} ${String(route.path)}`)
      : [],
  );
}

// ---------------------------------------------------------------------------
// Done when 1
// ---------------------------------------------------------------------------

describe('Done when 1: deactivated or deleted movies never appear publicly', () => {
  const STATUSES: MovieStatus[] = ['UPCOMING', 'NOW_SHOWING', 'ENDED'];

  interface Visibility {
    isActive: boolean;
    deleted: boolean;
    status: MovieStatus;
  }

  const CASES: Visibility[] = STATUSES.flatMap((status) =>
    [true, false].flatMap((isActive) =>
      [false, true].map((deleted) => ({ isActive, deleted, status })),
    ),
  );

  const describeCase = ({ isActive, deleted, status }: Visibility) =>
    `${status}, ${isActive ? 'active' : 'inactive'}, ${deleted ? 'soft-deleted' : 'not deleted'}`;

  /** Where the subject may be seen: only when active and not deleted; ENDED only by slug. */
  const expectedVisibility = ({ isActive, deleted, status }: Visibility) => {
    const visible = isActive && !deleted;
    return {
      defaultList: visible && status !== 'ENDED',
      upcomingList: visible && status === 'UPCOMING',
      nowShowingList: visible && status === 'NOW_SHOWING',
      detail: visible,
    };
  };

  const SUBJECT = 'subject';
  /** Always-visible movies, so every list is shown to work while the subject is checked. */
  const controls = () => [
    testMovie({ slug: 'control-upcoming', title: 'Control Upcoming', status: 'UPCOMING' }),
    testMovie({ slug: 'control-now-showing', title: 'Control Now', status: 'NOW_SHOWING' }),
  ];

  async function publicListSlugs(app: Express, query: string): Promise<string[]> {
    const res = await request(app).get(`/api/movies${query}`);
    expect(res.status).toBe(200);
    return publicMovieListResponseSchema.parse(res.body).movies.map((m) => m.slug);
  }

  /** What a visitor sees of the subject through every public endpoint. */
  async function observe(app: Express) {
    const [all, upcoming, nowShowing] = await Promise.all([
      publicListSlugs(app, ''),
      publicListSlugs(app, '?status=UPCOMING'),
      publicListSlugs(app, '?status=NOW_SHOWING'),
    ]);
    // The controls prove each list is served (and filtered per movie, not emptied).
    expect(all).toEqual(expect.arrayContaining(['control-upcoming', 'control-now-showing']));
    expect(upcoming).toContain('control-upcoming');
    expect(nowShowing).toContain('control-now-showing');

    const detail = await request(app).get(`/api/movies/${SUBJECT}`);
    if (detail.status === 200) {
      expect(publicMovieResponseSchema.parse(detail.body).movie.slug).toBe(SUBJECT);
    } else {
      // Exactly like an unknown slug: nothing tells a visitor the movie exists.
      expect(detail.status).toBe(404);
      expect(detail.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Movie not found' } });
    }

    return {
      defaultList: all.includes(SUBJECT),
      upcomingList: upcoming.includes(SUBJECT),
      nowShowingList: nowShowing.includes(SUBJECT),
      detail: detail.status === 200,
    };
  }

  describe('cold cache: seeded in each state', () => {
    it.each(CASES.map((c) => [describeCase(c), c] as const))('%s', async (_name, state) => {
      const subject = testMovie({
        slug: SUBJECT,
        title: 'Subject',
        status: state.status,
        isActive: state.isActive,
        deletedAt: state.deleted ? TRASHED_AT : null,
      });
      const db = inMemoryAuthDb({ movies: [subject, ...controls()] });
      const { app } = buildTestApp({ prisma: db.prisma });

      expect(await observe(app)).toEqual(expectedVisibility(state));
    });
  });

  describe('warm cache: visible and cached, then changed through the admin API', () => {
    it.each(CASES.map((c) => [describeCase(c), c] as const))('%s', async (_name, state) => {
      const subject = testMovie({ slug: SUBJECT, title: 'Subject', status: state.status });
      const f = await setup({ movies: [subject, ...controls()] });

      // Warm every public response while the movie is visible.
      expect(await observe(f.app)).toEqual(
        expectedVisibility({ isActive: true, deleted: false, status: state.status }),
      );
      // Three lists and the detail are cached.
      expect(f.cache.size).toBe(4);

      // Hide first: a soft-deleted movie can no longer be hidden (409 restore first).
      if (!state.isActive) {
        const res = await send(f, 'patch', `/${subject.id}/active`, { body: { isActive: false } });
        expect(res.status).toBe(200);
      }
      if (state.deleted) {
        expect((await send(f, 'delete', `/${subject.id}`)).status).toBe(200);
      }

      expect(await observe(f.app)).toEqual(expectedVisibility(state));
    });
  });
});

// ---------------------------------------------------------------------------
// Done when 2
// ---------------------------------------------------------------------------

describe('Done when 2: EDITOR cannot hard delete', () => {
  it('the matrix below covers every route of the admin movie router', () => {
    expect(registeredMovieAdminRoutes().sort()).toEqual(ENDPOINTS.map((e) => e.route).sort());
  });

  it('only DELETE /:id/permanent is closed to EDITOR', () => {
    expect(ENDPOINTS.filter((e) => !e.roles.includes('EDITOR')).map((e) => e.route)).toEqual([
      'DELETE /:id/permanent',
    ]);
  });

  describe.each(ENDPOINTS)('$route', (endpoint) => {
    it.each<AdminRole>(['SUPER_ADMIN', 'EDITOR'])('as %s', async (role) => {
      const { movies, id } = seedFor(endpoint);
      const f = await setup({ role, movies });
      const before = snapshot(f.db);
      const allowed = endpoint.roles.includes(role);

      const res = await send(f, endpoint.method, endpoint.path(id), {
        ...(endpoint.body && { body: endpoint.body }),
      });

      if (allowed) {
        expect(res.status).toBe(endpoint.status);
        expect(movieAudits(f.db)).toHaveLength(endpoint.mutation ? 1 : 0);
        return;
      }
      expect(res.status).toBe(403);
      expect(res.body).toEqual(FORBIDDEN_BODY);
      // Refused before any database access: the movie is still there, untouched and unaudited.
      expect(f.db.movies).toEqual(before);
      expect(f.db.spies.$transaction).not.toHaveBeenCalled();
      expect(f.db.spies.movie.findUnique).not.toHaveBeenCalled();
      expect(f.db.spies.movie.delete).not.toHaveBeenCalled();
      expect(f.db.spies.movie.update).not.toHaveBeenCalled();
      expect(f.db.spies.auditLog.create).not.toHaveBeenCalled();
      expect(f.db.auditLogs).toHaveLength(f.auditsBefore);
    });

    it('without a session: 401, nothing read or written', async () => {
      const { movies, id } = seedFor(endpoint);
      const f = await setup({ movies, signedIn: false });
      const before = snapshot(f.db);

      const res = await send(f, endpoint.method, endpoint.path(id), {
        ...(endpoint.body && { body: endpoint.body }),
      });

      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED_BODY);
      expect(f.db.movies).toEqual(before);
      expect(f.db.spies.$transaction).not.toHaveBeenCalled();
      expect(f.db.spies.movie.findUnique).not.toHaveBeenCalled();
      expect(f.db.spies.movie.findMany).not.toHaveBeenCalled();
      expect(f.db.auditLogs).toEqual([]);
    });
  });

  it('a SUPER_ADMIN can permanently delete the movie an EDITOR could not', async () => {
    const movie = trashedAvatar();
    const editor = await setup({ role: 'EDITOR', movies: [movie] });
    expect((await send(editor, 'delete', `/${movie.id}/permanent`)).status).toBe(403);
    expect(editor.db.movies.map((m) => m.id)).toEqual([movie.id]);

    const superAdmin = await setup({ role: 'SUPER_ADMIN', movies: [movie] });
    expect((await send(superAdmin, 'delete', `/${movie.id}/permanent`)).status).toBe(204);
    expect(superAdmin.db.movies).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Done when 3
// ---------------------------------------------------------------------------

interface Mutation {
  name: string;
  method: Method;
  path: (id: string) => string;
  /** Signs in as this role (hard delete is SUPER_ADMIN only). */
  role: AdminRole;
  /** The movie the change is made to (null: create). */
  seed: (() => Movie) | null;
  body?: object;
  status: number;
  action: AuditAction;
  details: object;
  /** A request refused with 409, and the movies seeded for it. */
  conflict: { seed: () => Movie; body?: object; message: string };
  /** A body equal to the seeded movie's values (PATCH endpoints only). */
  noop?: object;
}

const MUTATIONS: Mutation[] = [
  {
    name: 'POST / (create)',
    method: 'post',
    path: () => '',
    role: 'EDITOR',
    seed: null,
    body: { title: 'Avatar', durationMinutes: 162 },
    status: 201,
    action: 'CREATE',
    details: { title: 'Avatar', slug: 'avatar' },
    conflict: {
      seed: avatar,
      body: { title: 'Avatar', slug: 'avatar', durationMinutes: 162 },
      message: SLUG_IN_USE_MESSAGE,
    },
  },
  {
    name: 'PATCH /:id (details)',
    method: 'patch',
    path: (id) => `/${id}`,
    role: 'EDITOR',
    seed: avatar,
    body: { title: 'Avatar 2' },
    status: 200,
    action: 'UPDATE',
    details: { changes: { title: { from: 'Avatar', to: 'Avatar 2' } } },
    conflict: {
      seed: trashedAvatar,
      body: { title: 'Avatar 2' },
      message: MOVIE_RESTORE_FIRST_MESSAGE,
    },
    noop: { title: 'Avatar' },
  },
  {
    name: 'PATCH /:id/status',
    method: 'patch',
    path: (id) => `/${id}/status`,
    role: 'EDITOR',
    seed: avatar,
    body: { status: 'NOW_SHOWING' },
    status: 200,
    action: 'STATUS_CHANGE',
    details: { field: 'status', from: 'UPCOMING', to: 'NOW_SHOWING' },
    conflict: {
      seed: trashedAvatar,
      body: { status: 'NOW_SHOWING' },
      message: MOVIE_RESTORE_FIRST_MESSAGE,
    },
    noop: { status: 'UPCOMING' },
  },
  {
    name: 'PATCH /:id/active',
    method: 'patch',
    path: (id) => `/${id}/active`,
    role: 'EDITOR',
    seed: avatar,
    body: { isActive: false },
    status: 200,
    action: 'STATUS_CHANGE',
    details: { field: 'isActive', from: true, to: false },
    conflict: {
      seed: trashedAvatar,
      body: { isActive: false },
      message: MOVIE_RESTORE_FIRST_MESSAGE,
    },
    noop: { isActive: true },
  },
  {
    name: 'DELETE /:id (soft delete)',
    method: 'delete',
    path: (id) => `/${id}`,
    role: 'EDITOR',
    seed: avatar,
    status: 200,
    action: 'DELETE',
    details: { mode: 'soft', title: 'Avatar', slug: 'avatar' },
    conflict: { seed: trashedAvatar, message: MOVIE_ALREADY_DELETED_MESSAGE },
  },
  {
    name: 'POST /:id/restore',
    method: 'post',
    path: (id) => `/${id}/restore`,
    role: 'EDITOR',
    seed: trashedAvatar,
    status: 200,
    action: 'UPDATE',
    details: { restored: true, title: 'Avatar', slug: 'avatar' },
    conflict: { seed: avatar, message: MOVIE_NOT_DELETED_MESSAGE },
  },
  {
    name: 'DELETE /:id/permanent (hard delete)',
    method: 'delete',
    path: (id) => `/${id}/permanent`,
    role: 'SUPER_ADMIN',
    seed: trashedAvatar,
    status: 204,
    action: 'DELETE',
    details: { mode: 'hard', title: 'Avatar', slug: 'avatar' },
    conflict: { seed: avatar, message: MOVIE_DELETE_FIRST_MESSAGE },
  },
];

describe('Done when 3: every admin change creates an audit log row', () => {
  it('covers every mutating admin movie endpoint', () => {
    expect(MUTATIONS.map((m) => m.name.split(' (')[0]).sort()).toEqual(
      ENDPOINTS.filter((e) => e.mutation)
        .map((e) => e.route)
        .sort(),
    );
  });

  /** No audit row of any kind since setup, and the movies table exactly as `before`. */
  function expectNothingRecorded(f: Flow, before: Movie[]) {
    expect(f.db.auditLogs).toHaveLength(f.auditsBefore);
    expect(movieAudits(f.db)).toEqual([]);
    expect(f.db.movies).toEqual(before);
  }

  describe.each(MUTATIONS)('$name', (mutation) => {
    const seedMovies = () => {
      const movie = mutation.seed?.();
      return { movies: movie ? [movie] : [], id: movie?.id ?? randomUUID() };
    };
    const sendMutation = (f: Flow, id: string, options: SendOptions = {}) =>
      send(f, mutation.method, mutation.path(id), {
        ...(mutation.body && { body: mutation.body }),
        ...options,
      });

    it('a change writes exactly one row: action, entity, entityId, adminId, IP and user agent', async () => {
      const { movies, id } = seedMovies();
      const f = await setup({ role: mutation.role, movies });

      const res = await sendMutation(f, id);

      expect(res.status).toBe(mutation.status);
      const entityId =
        mutation.seed === null ? adminMovieResponseSchema.parse(res.body).movie.id : id;
      expect(f.db.auditLogs).toHaveLength(f.auditsBefore + 1);
      const audits = movieAudits(f.db);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: mutation.action,
        entity: 'Movie',
        entityId,
        adminId: f.adminId,
        details: mutation.details,
        ipAddress: CLIENT_IP,
        userAgent: TEST_USER_AGENT,
      });
    });

    it('no row on 400 (validation)', async () => {
      const { movies, id } = seedMovies();
      const f = await setup({ role: mutation.role, movies });
      const before = snapshot(f.db);

      expectError(await sendMutation(f, id, { query: '?force=1' }), 400, 'VALIDATION_ERROR');
      expectNothingRecorded(f, before);
    });

    it('no row on 401 (no session)', async () => {
      const { movies, id } = seedMovies();
      const f = await setup({ role: mutation.role, movies });
      const before = snapshot(f.db);

      const res = await sendMutation(f, id, { withSession: false });

      expect(res.body).toEqual(UNAUTHORIZED_BODY);
      expectNothingRecorded(f, before);
    });

    it('no row on 403 (CSRF)', async () => {
      const { movies, id } = seedMovies();
      const f = await setup({ role: mutation.role, movies });
      const before = snapshot(f.db);

      const res = await sendMutation(f, id, { withCsrf: false });

      expect(res.status).toBe(403);
      expect(res.body).toEqual(CSRF_BODY);
      expectNothingRecorded(f, before);
    });

    it('no row on 409', async () => {
      const seeded = mutation.conflict.seed();
      const f = await setup({ role: mutation.role, movies: [seeded] });
      const before = snapshot(f.db);

      const res = await send(f, mutation.method, mutation.path(seeded.id), {
        ...(mutation.conflict.body && { body: mutation.conflict.body }),
      });

      expectError(res, 409, 'CONFLICT', mutation.conflict.message);
      expectNothingRecorded(f, before);
    });

    it('no row when the audit write fails: the change is rolled back (500)', async () => {
      const { movies, id } = seedMovies();
      const f = await setup({ role: mutation.role, movies });
      const before = snapshot(f.db);
      f.db.injectFault('auditLog', 'create', { error: new Error('audit table unavailable') });

      const res = await sendMutation(f, id);

      expect(res.status).toBe(500);
      expect(res.body).toEqual(INTERNAL_BODY);
      expect(f.db.spies.auditLog.create).toHaveBeenCalledTimes(1);
      expectNothingRecorded(f, before);
    });

    if (mutation.seed !== null) {
      it('no row on 404 (unknown id)', async () => {
        const { movies } = seedMovies();
        const f = await setup({ role: mutation.role, movies });
        const before = snapshot(f.db);

        const res = await sendMutation(f, randomUUID());

        expectError(res, 404, 'NOT_FOUND', MOVIE_NOT_FOUND_MESSAGE);
        expectNothingRecorded(f, before);
      });
    }

    const { noop } = mutation;
    if (noop !== undefined) {
      it('no row on a no-op (every value already stored)', async () => {
        const { movies, id } = seedMovies();
        const f = await setup({ role: mutation.role, movies });
        const before = snapshot(f.db);

        const res = await send(f, mutation.method, mutation.path(id), { body: noop });

        expect(res.status).toBe(200);
        expect(f.db.spies.movie.update).not.toHaveBeenCalled();
        expectNothingRecorded(f, before);
      });
    }
  });

  it('no row on 403 (role): an EDITOR permanently deleting', async () => {
    const seeded = trashedAvatar();
    const f = await setup({ role: 'EDITOR', movies: [seeded] });
    const before = snapshot(f.db);

    const res = await send(f, 'delete', `/${seeded.id}/permanent`);

    expect(res.body).toEqual(FORBIDDEN_BODY);
    expectNothingRecorded(f, before);
  });

  it('a sequence of changes leaves one row per change, in order, all by the same admin', async () => {
    const f = await setup({ role: 'SUPER_ADMIN' });

    const created = await send(f, 'post', '', { body: { title: 'Avatar', durationMinutes: 162 } });
    const { id } = adminMovieResponseSchema.parse(created.body).movie;
    const steps: [Method, string, object | undefined][] = [
      ['patch', `/${id}`, { synopsis: 'Pandora.' }],
      ['patch', `/${id}/status`, { status: 'NOW_SHOWING' }],
      ['patch', `/${id}/status`, { status: 'NOW_SHOWING' }], // no-op
      ['patch', `/${id}/active`, { isActive: false }],
      ['patch', `/${id}/active`, { isActive: true }],
      ['delete', `/${id}`, undefined],
      ['delete', `/${id}`, undefined], // 409: already deleted
      ['post', `/${id}/restore`, undefined],
      ['delete', `/${id}`, undefined],
      ['delete', `/${id}/permanent`, undefined],
    ];
    const statuses: number[] = [];
    for (const [method, path, body] of steps) {
      statuses.push((await send(f, method, path, body === undefined ? {} : { body })).status);
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 409, 200, 200, 204]);
    const audits = movieAudits(f.db);
    expect(audits.map((row) => row.action)).toEqual([
      'CREATE',
      'UPDATE',
      'STATUS_CHANGE',
      'STATUS_CHANGE',
      'STATUS_CHANGE',
      'DELETE',
      'UPDATE',
      'DELETE',
      'DELETE',
    ]);
    expect(f.db.auditLogs).toHaveLength(f.auditsBefore + audits.length);
    for (const row of audits) {
      expect(row).toMatchObject({
        entityId: id,
        adminId: f.adminId,
        ipAddress: CLIENT_IP,
        userAgent: TEST_USER_AGENT,
      });
    }
  });
});
