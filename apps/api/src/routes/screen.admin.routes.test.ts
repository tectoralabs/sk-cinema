import { randomUUID } from 'node:crypto';
import {
  adminScreenListResponseSchema,
  adminScreenResponseSchema,
  apiErrorSchema,
  type AdminScreen,
} from '@sk-cinema/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { AdminRole, Screen, Showtime } from '../generated/prisma/client.js';
import type { MemoryCache } from '../lib/cache.js';
import { CSRF_HEADER } from '../middleware/csrf.js';
import { SESSION_EXPIRED_MESSAGE } from '../services/auth.service.js';
import { PUBLIC_MOVIES_CACHE_PREFIX } from '../services/movie.public.service.js';
import {
  SCREEN_ALREADY_DELETED_MESSAGE,
  SCREEN_CHANGED_MESSAGE,
  SCREEN_DEACTIVATE_HAS_SHOWTIMES_MESSAGE,
  SCREEN_DELETE_HAS_SHOWTIMES_MESSAGE,
  SCREEN_NAME_DELETED_MESSAGE,
  SCREEN_NAME_IN_USE_MESSAGE,
  SCREEN_NOT_DELETED_MESSAGE,
  SCREEN_NOT_FOUND_MESSAGE,
  SCREEN_RESTORE_FIRST_MESSAGE,
  SCREEN_RESTORE_NAME_IN_USE_MESSAGE,
} from '../services/screen.admin.service.js';
import {
  ADMIN_BASE,
  ADMIN_ORIGIN,
  TEST_USER_AGENT,
  authClient,
  buildTestApp,
  inMemoryAuthDb,
  recordNotFoundError,
  sessionFrom,
  testAdmin,
  testMovie,
  testPasswordHash,
  testScreen,
  testShowtime,
  uniqueConstraintError,
  type AuthClient,
  type InMemoryAuthDb,
  type SendOptions,
  type Session,
} from '../test/helpers.js';

const EMAIL = 'editor@skcinema.lk';
const PASSWORD = 'correct horse battery staple';
const UNAUTHORIZED_BODY = { error: { code: 'UNAUTHORIZED', message: SESSION_EXPIRED_MESSAGE } };
const CSRF_BODY = { error: { code: 'CSRF_INVALID', message: 'CSRF validation failed' } };
const INTERNAL_BODY = { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } };

// The app uses the real clock here, so "upcoming" and "past" are far from today.
const FAR_FUTURE = new Date('2099-01-01T13:30:00.000Z');
const LONG_AGO = new Date('2000-01-01T13:30:00.000Z');
const DELETED_AT = new Date('2026-10-01T00:00:00.000Z');
const SEEDED_AT = '2026-01-01T00:00:00.000Z';

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await testPasswordHash(PASSWORD);
});

interface Setup {
  app: Express;
  db: InMemoryAuthDb;
  cache: ReturnType<typeof buildTestApp>['cache'];
  adminId: string;
  client: AuthClient;
  session: Session;
}

/** A showtime of a seeded movie on the first seeded screen. */
type ShowtimeOnScreen = Partial<Showtime> & Pick<Showtime, 'startsAt'>;

async function setup(
  options: { role?: AdminRole; screens?: Screen[]; showtimes?: ShowtimeOnScreen[] } = {},
): Promise<Setup> {
  const admin = testAdmin({ email: EMAIL, passwordHash, role: options.role ?? 'EDITOR' });
  const movie = testMovie();
  const screens = options.screens ?? [];
  const screenId = screens[0]?.id ?? '';
  const db = inMemoryAuthDb({
    admins: [admin],
    movies: [movie],
    screens,
    showtimes: (options.showtimes ?? []).map((x) =>
      testShowtime({ movieId: movie.id, screenId, ...x }),
    ),
  });
  const { app, cache } = buildTestApp({ prisma: db.prisma });
  const client = await authClient(app);
  const login = await client.post('/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  expect(login.status).toBe(200);
  // Count only the calls the request under test makes (login has its own transaction).
  vi.clearAllMocks();
  return { app, db, cache, adminId: admin.id, client, session: sessionFrom(login) };
}

/**
 * A browser-like POST, PATCH or DELETE to /screens{path} with the session (by default), CSRF
 * cookie and token, and Origin.
 */
function send(
  s: Setup,
  method: 'post' | 'patch' | 'delete',
  path: string,
  options: SendOptions = {},
) {
  const {
    body,
    cookies = [s.session.access],
    origin = ADMIN_ORIGIN,
    token = s.client.csrf.token,
  } = options;
  const all = [...(options.csrfCookie === false ? [] : [s.client.csrf.cookie]), ...cookies];
  let req = request(s.app)
    [method](`${ADMIN_BASE}/screens${path}`)
    .set('User-Agent', TEST_USER_AGENT);
  if (all.length > 0) req = req.set('Cookie', all.join('; '));
  if (origin !== null) req = req.set('Origin', origin);
  if (token !== null) req = req.set(CSRF_HEADER, token);
  if (body === undefined) return req;
  return typeof body === 'string'
    ? req.set('Content-Type', 'application/json').send(body)
    : req.send(body);
}

const createScreen = (s: Setup, body: object | string) => send(s, 'post', '', { body });
const patchScreen = (s: Setup, id: string, body: object | string) =>
  send(s, 'patch', `/${id}`, { body });
const patchActive = (s: Setup, id: string, body: object | string) =>
  send(s, 'patch', `/${id}/active`, { body });
const deleteScreen = (s: Setup, id: string, options: SendOptions = {}) =>
  send(s, 'delete', `/${id}`, options);
const restoreScreen = (s: Setup, id: string, options: SendOptions = {}) =>
  send(s, 'post', `/${id}/restore`, options);
const getScreen = (s: Setup, path: string, cookies = [s.session.access]) =>
  s.client.get(`/screens${path}`, cookies);

/** The audit rows about screens (login writes its own LOGIN rows). */
const screenAudits = (db: InMemoryAuthDb) => db.auditLogs.filter((row) => row.entity === 'Screen');

const stored = (s: Setup, id: string) => structuredClone(s.db.screens.find((row) => row.id === id));

function expectOk(res: request.Response, status = 200): AdminScreen {
  expect(res.status).toBe(status);
  expect(res.headers['cache-control']).toBe('no-store');
  return adminScreenResponseSchema.parse(res.body).screen;
}

function expectError(res: request.Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers['cache-control']).toBe('no-store');
  const { error } = apiErrorSchema.parse(res.body);
  expect(error.code).toBe(code);
  return error;
}

type InvalidateSpy = MockInstance<MemoryCache['invalidatePrefix']>;

/** The public cache was dropped exactly once, after the request's audit row. */
function expectInvalidatedAfterAudit(s: Setup, invalidate: InvalidateSpy) {
  expect(invalidate).toHaveBeenCalledExactlyOnceWith(PUBLIC_MOVIES_CACHE_PREFIX);
  const auditOrder = s.db.spies.auditLog.create.mock.invocationCallOrder.at(-1) ?? Infinity;
  expect(invalidate.mock.invocationCallOrder[0]).toBeGreaterThan(auditOrder);
}

const screen1 = (overrides: Partial<Screen> = {}) =>
  testScreen({ name: 'Screen 1', capacity: 300, ...overrides });

// ---------------------------------------------------------------------------
// Every unsafe endpoint: session and CSRF
// ---------------------------------------------------------------------------

interface UnsafeEndpoint {
  name: string;
  method: 'post' | 'patch' | 'delete';
  path: (id: string) => string;
  body?: object;
  /** Seed a deleted screen (restore) instead of a live one. */
  deleted?: boolean;
}

const UNSAFE_ENDPOINTS: UnsafeEndpoint[] = [
  { name: 'POST /screens', method: 'post', path: () => '', body: { name: 'Screen 9' } },
  { name: 'PATCH /screens/:id', method: 'patch', path: (id) => `/${id}`, body: { capacity: 10 } },
  {
    name: 'PATCH /screens/:id/active',
    method: 'patch',
    path: (id) => `/${id}/active`,
    body: { isActive: false },
  },
  { name: 'DELETE /screens/:id', method: 'delete', path: (id) => `/${id}` },
  {
    name: 'POST /screens/:id/restore',
    method: 'post',
    path: (id) => `/${id}/restore`,
    deleted: true,
  },
];

describe.each(UNSAFE_ENDPOINTS)('$name: session and CSRF', ({ method, path, body, deleted }) => {
  const seeded = () => screen1(deleted ? { deletedAt: DELETED_AT } : {});
  /** The endpoint's valid body, if it takes one. */
  const withBody: SendOptions = body === undefined ? {} : { body };

  it('answers 401 without a session, before touching the database', async () => {
    const screen = seeded();
    const s = await setup({ screens: [screen] });

    const res = await send(s, method, path(screen.id), { ...withBody, cookies: [] });

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    expect(s.db.screens).toEqual([screen]);
    expect(screenAudits(s.db)).toEqual([]);
  });

  it('answers 401 for an invalid session cookie, even with a bad body and id', async () => {
    const s = await setup({ screens: [seeded()] });

    const res = await send(s, method, path('not-a-uuid'), {
      body: { foo: 1 },
      cookies: [`${s.session.access}x`],
    });

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
  });

  it.each([
    ['a missing CSRF token', { token: null }],
    ['a wrong CSRF token', { token: 'not-the-token' }],
    ['a missing CSRF cookie', { csrfCookie: false }],
    ['a missing Origin', { origin: null }],
    ['a foreign Origin', { origin: 'https://evil.example' }],
  ] as const)('answers 403 for %s, even with a session', async (_name, overrides) => {
    const screen = seeded();
    const s = await setup({ screens: [screen] });

    const res = await send(s, method, path(screen.id), { ...withBody, ...overrides });

    expect(res.status).toBe(403);
    expect(res.body).toEqual(CSRF_BODY);
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    expect(s.db.screens).toEqual([screen]);
    expect(screenAudits(s.db)).toEqual([]);
  });

  it.each<AdminRole>(['EDITOR', 'SUPER_ADMIN'])('serves a %s', async (role) => {
    const screen = seeded();
    const s = await setup({ role, screens: [screen] });

    const res = await send(s, method, path(screen.id), withBody);

    expect(res.status).toBe(method === 'post' && !deleted ? 201 : 200);
    expect(screenAudits(s.db)).toHaveLength(1);
    expect(screenAudits(s.db)[0]).toMatchObject({ adminId: s.adminId, userAgent: TEST_USER_AGENT });
  });

  it('answers 400 for query parameters', async () => {
    const screen = seeded();
    const s = await setup({ screens: [screen] });

    const error = expectError(
      await send(s, method, `${path(screen.id)}?x=1`, withBody),
      400,
      'VALIDATION_ERROR',
    );

    expect(error.details).toEqual([expect.objectContaining({ path: ['query'] })]);
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/screens
// ---------------------------------------------------------------------------

describe('POST /api/admin/screens', () => {
  it('creates an active screen (201): one CREATE audit row, then the public cache is dropped', async () => {
    const s = await setup();
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    const screen = expectOk(await createScreen(s, { name: '  Screen 1  ', capacity: 300 }), 201);

    expect(screen).toMatchObject({
      name: 'Screen 1',
      capacity: 300,
      isActive: true,
      deletedAt: null,
    });
    expect(s.db.screens).toHaveLength(1);
    const login = s.db.auditLogs.find((row) => row.action === 'LOGIN');
    expect(screenAudits(s.db)).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        adminId: s.adminId,
        entity: 'Screen',
        entityId: screen.id,
        details: { name: 'Screen 1', capacity: 300 },
        ipAddress: login?.ipAddress,
        userAgent: TEST_USER_AGENT,
      }),
    ]);
    expectInvalidatedAfterAudit(s, invalidate);
  });

  it('a capacity left out or null is stored as null', async () => {
    const s = await setup();
    expect(expectOk(await createScreen(s, { name: 'A' }), 201).capacity).toBeNull();
    expect(expectOk(await createScreen(s, { name: 'B', capacity: null }), 201).capacity).toBeNull();
  });

  describe('validation (400, nothing written)', () => {
    it.each<[string, object | string, (string | number)[]]>([
      ['a missing name', { capacity: 10 }, ['body', 'name']],
      ['an empty name', { name: '' }, ['body', 'name']],
      ['a whitespace-only name', { name: '   ' }, ['body', 'name']],
      ['a name over 50 characters', { name: 'a'.repeat(51) }, ['body', 'name']],
      ['a numeric name', { name: 1 }, ['body', 'name']],
      ['capacity 0', { name: 'A', capacity: 0 }, ['body', 'capacity']],
      ['capacity 2001', { name: 'A', capacity: 2001 }, ['body', 'capacity']],
      ['capacity 1.5', { name: 'A', capacity: 1.5 }, ['body', 'capacity']],
      ['capacity as a string', { name: 'A', capacity: '10' }, ['body', 'capacity']],
      ['an unknown key', { name: 'A', isActive: false }, ['body']],
      ['an array body', [{ name: 'A' }], ['body']],
    ])('rejects %s', async (_name, body, path) => {
      const s = await setup();
      const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

      const error = expectError(await createScreen(s, body), 400, 'VALIDATION_ERROR');

      expect(error.details).toEqual([expect.objectContaining({ path })]);
      expect(s.db.screens).toEqual([]);
      expect(screenAudits(s.db)).toEqual([]);
      expect(s.db.spies.$transaction).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
    });

    it('accepts a 50-character name', async () => {
      const s = await setup();
      expect(expectOk(await createScreen(s, { name: 'a'.repeat(50) }), 201).name).toHaveLength(50);
    });

    it('rejects malformed JSON', async () => {
      const s = await setup();
      // Parsed by the app-level JSON parser, before the admin router (and its no-store).
      const res = await createScreen(s, '{"name":');
      expect(res.status).toBe(400);
      expect(apiErrorSchema.parse(res.body).error.code).toBe('INVALID_JSON');
      expect(s.db.screens).toEqual([]);
    });
  });

  describe('unique names, ignoring case (409 on body.name)', () => {
    it.each([
      ['the exact name', 'Screen 1'],
      ['"screen 1" for "Screen 1"', 'screen 1'],
      ['the name with spaces around it', '  Screen 1  '],
    ])('refuses %s', async (_name, name) => {
      const existing = screen1();
      const s = await setup({ screens: [existing] });
      const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

      const error = expectError(await createScreen(s, { name }), 409, 'CONFLICT');

      expect(error).toEqual({
        code: 'CONFLICT',
        message: SCREEN_NAME_IN_USE_MESSAGE,
        details: [{ path: ['body', 'name'], message: SCREEN_NAME_IN_USE_MESSAGE }],
      });
      expect(s.db.screens).toEqual([existing]);
      expect(screenAudits(s.db)).toEqual([]);
      expect(invalidate).not.toHaveBeenCalled();
    });

    it('a deleted "Screen 1" blocks the name, with a hint to restore it', async () => {
      const s = await setup({ screens: [screen1({ deletedAt: DELETED_AT })] });

      const error = expectError(await createScreen(s, { name: 'SCREEN 1' }), 409, 'CONFLICT');

      expect(error).toEqual({
        code: 'CONFLICT',
        message: SCREEN_NAME_DELETED_MESSAGE,
        details: [{ path: ['body', 'name'], message: SCREEN_NAME_DELETED_MESSAGE }],
      });
    });

    it.each([
      ['A_C', 'ABC'],
      ['50%', '500'],
      ['A\\C', 'AC'],
    ])('matches %j literally: an existing %j does not block it', async (name, existing) => {
      const s = await setup({ screens: [testScreen({ name: existing })] });
      expect(expectOk(await createScreen(s, { name }), 201).name).toBe(name);
    });

    it('a P2002 from the insert is a 409, never a 500', async () => {
      const s = await setup();
      s.db.injectFault('screen', 'create', { error: uniqueConstraintError('screen', 'name') });

      const error = expectError(await createScreen(s, { name: 'Screen 1' }), 409, 'CONFLICT');

      expect(error.message).toBe(SCREEN_NAME_IN_USE_MESSAGE);
      expect(s.db.screens).toEqual([]);
      expect(screenAudits(s.db)).toEqual([]);
    });
  });

  it('rolls back and answers a generic 500 when the audit write fails', async () => {
    const s = await setup();
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');
    s.db.injectFault('auditLog', 'create', {
      error: new Error('relation "AuditLog" does not exist'),
    });

    const res = await createScreen(s, { name: 'Screen 1' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual(INTERNAL_BODY);
    expect(s.db.screens).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/screens and /:id
// ---------------------------------------------------------------------------

describe('GET /api/admin/screens', () => {
  const SCREENS = () => [
    testScreen({ name: 'Screen 2' }),
    testScreen({ name: 'Screen 10', capacity: 120 }),
    testScreen({ name: 'Hidden', isActive: false }),
    testScreen({ name: 'Old', deletedAt: DELETED_AT }),
    testScreen({ name: 'A_C' }),
    testScreen({ name: 'ABC' }),
  ];

  const names = (res: request.Response) => {
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    return adminScreenListResponseSchema.parse(res.body).items.map((x) => x.name);
  };

  it.each<AdminRole>(['EDITOR', 'SUPER_ADMIN'])(
    'serves a %s: live screens by name, page 1 of 20, no audit',
    async (role) => {
      const s = await setup({ role, screens: SCREENS() });

      const res = await getScreen(s, '');

      expect(names(res)).toEqual(['ABC', 'A_C', 'Hidden', 'Screen 10', 'Screen 2']);
      expect(res.body).toMatchObject({ page: 1, pageSize: 20, total: 5 });
      expect(screenAudits(s.db)).toEqual([]);
    },
  );

  it.each<[string, string, string[]]>([
    ['isActive=false', 'isActive=false', ['Hidden']],
    ['deleted=only', 'deleted=only', ['Old']],
    ['deleted=include&search=o', 'deleted=include&search=o', ['Old']],
    ['search=screen (case-insensitive)', 'search=screen', ['Screen 10', 'Screen 2']],
    ['search=_ (literal)', 'search=_', ['A_C']],
    ['search=%25 (literal)', 'search=%25', []],
    [
      'a whitespace-only search is no search',
      'search=%20%20',
      ['ABC', 'A_C', 'Hidden', 'Screen 10', 'Screen 2'],
    ],
    ['pageSize=2&page=2', 'pageSize=2&page=2', ['Hidden', 'Screen 10']],
    ['a page past the end', 'page=9', []],
  ])('%s', async (_name, query, expected) => {
    const s = await setup({ screens: SCREENS() });
    expect(names(await getScreen(s, `?${query}`))).toEqual(expected);
  });

  it.each<[string, string, (string | number)[]]>([
    ['an unknown key', 'sort=name', ['query']],
    ['isActive=1', 'isActive=1', ['query', 'isActive']],
    ['deleted=yes', 'deleted=yes', ['query', 'deleted']],
    ['pageSize=101', 'pageSize=101', ['query', 'pageSize']],
    ['page=0', 'page=0', ['query', 'page']],
    ['a search over 100 characters', `search=${'a'.repeat(101)}`, ['query', 'search']],
  ])('answers 400 for %s', async (_name, query, path) => {
    const s = await setup({ screens: SCREENS() });

    const error = expectError(await getScreen(s, `?${query}`), 400, 'VALIDATION_ERROR');

    expect(error.details).toEqual([expect.objectContaining({ path })]);
    expect(s.db.spies.screen.findMany).not.toHaveBeenCalled();
  });

  it('answers 401 without a session', async () => {
    const s = await setup({ screens: SCREENS() });
    const res = await getScreen(s, '', []);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
    expect(s.db.spies.screen.findMany).not.toHaveBeenCalled();
  });

  it('answers a generic 500 when the database fails', async () => {
    const s = await setup({ screens: SCREENS() });
    s.db.injectFault('screen', 'count', { error: new Error('connection reset') });
    const res = await getScreen(s, '');
    expect(res.status).toBe(500);
    expect(res.body).toEqual(INTERNAL_BODY);
  });
});

describe('GET /api/admin/screens/:id', () => {
  it.each<AdminRole>(['EDITOR', 'SUPER_ADMIN'])('returns a screen to a %s', async (role) => {
    const seeded = screen1();
    const s = await setup({ role, screens: [seeded] });

    expect(expectOk(await getScreen(s, `/${seeded.id}`))).toEqual({
      id: seeded.id,
      name: 'Screen 1',
      capacity: 300,
      isActive: true,
      deletedAt: null,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    });
  });

  it('returns a deleted screen too', async () => {
    const seeded = screen1({ deletedAt: DELETED_AT });
    const s = await setup({ screens: [seeded] });
    expect(expectOk(await getScreen(s, `/${seeded.id}`)).deletedAt).toBe(DELETED_AT.toISOString());
  });

  it('answers 404 for an unknown id', async () => {
    const s = await setup();
    const error = expectError(await getScreen(s, `/${randomUUID()}`), 404, 'NOT_FOUND');
    expect(error.message).toBe(SCREEN_NOT_FOUND_MESSAGE);
  });

  it.each(['not-a-uuid', '123'])('answers 400 for the id %s', async (id) => {
    const s = await setup();
    const error = expectError(await getScreen(s, `/${id}`), 400, 'VALIDATION_ERROR');
    expect(error.details).toEqual([expect.objectContaining({ path: ['params', 'id'] })]);
  });

  it('answers 400 for query parameters', async () => {
    const seeded = screen1();
    const s = await setup({ screens: [seeded] });
    expectError(await getScreen(s, `/${seeded.id}?x=1`), 400, 'VALIDATION_ERROR');
  });

  it('answers 401 without a session', async () => {
    const seeded = screen1();
    const s = await setup({ screens: [seeded] });
    const res = await getScreen(s, `/${seeded.id}`, []);
    expect(res.status).toBe(401);
    expect(s.db.spies.screen.findUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/screens/:id
// ---------------------------------------------------------------------------

describe('PATCH /api/admin/screens/:id', () => {
  it('changes the fields that differ, audits them, then drops the public cache', async () => {
    const seeded = screen1();
    const s = await setup({ screens: [seeded] });
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    const screen = expectOk(await patchScreen(s, seeded.id, { name: 'Gold Class', capacity: 300 }));

    expect(screen).toMatchObject({ id: seeded.id, name: 'Gold Class', capacity: 300 });
    expect(screen.updatedAt > SEEDED_AT).toBe(true);
    expect(screenAudits(s.db)).toEqual([
      expect.objectContaining({
        action: 'UPDATE',
        adminId: s.adminId,
        entity: 'Screen',
        entityId: seeded.id,
        details: { changes: { name: { from: 'Screen 1', to: 'Gold Class' } } },
        userAgent: TEST_USER_AGENT,
      }),
    ]);
    expectInvalidatedAfterAudit(s, invalidate);
  });

  it('capacity null clears it', async () => {
    const seeded = screen1();
    const s = await setup({ screens: [seeded] });
    expect(expectOk(await patchScreen(s, seeded.id, { capacity: null })).capacity).toBeNull();
    expect(screenAudits(s.db)[0]?.details).toEqual({
      changes: { capacity: { from: 300, to: null } },
    });
  });

  it('renaming to its own name in another case is allowed', async () => {
    const seeded = screen1();
    const s = await setup({ screens: [seeded] });
    expect(expectOk(await patchScreen(s, seeded.id, { name: 'SCREEN 1' })).name).toBe('SCREEN 1');
  });

  it('a no-op answers 200 with the screen: no update, no audit, the cache kept', async () => {
    const seeded = screen1();
    const s = await setup({ screens: [seeded] });
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    const screen = expectOk(await patchScreen(s, seeded.id, { name: ' Screen 1 ', capacity: 300 }));

    expect(screen.updatedAt).toBe(SEEDED_AT);
    expect(s.db.spies.screen.update).not.toHaveBeenCalled();
    expect(screenAudits(s.db)).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it.each([
    ['a live screen', null, SCREEN_NAME_IN_USE_MESSAGE],
    ['a deleted screen', DELETED_AT, SCREEN_NAME_DELETED_MESSAGE],
  ])('answers 409 for a name %s has (ignoring case)', async (_name, deletedAt, message) => {
    const seeded = screen1();
    const s = await setup({ screens: [seeded, testScreen({ name: 'Screen 2', deletedAt })] });

    const error = expectError(
      await patchScreen(s, seeded.id, { name: 'screen 2' }),
      409,
      'CONFLICT',
    );

    expect(error).toEqual({
      code: 'CONFLICT',
      message,
      details: [{ path: ['body', 'name'], message }],
    });
    expect(stored(s, seeded.id)).toEqual(seeded);
    expect(screenAudits(s.db)).toEqual([]);
  });

  it('a P2002 from the update is a 409, changing nothing', async () => {
    const seeded = screen1();
    const s = await setup({ screens: [seeded] });
    s.db.injectFault('screen', 'update', { error: uniqueConstraintError('screen', 'name') });

    const error = expectError(
      await patchScreen(s, seeded.id, { name: 'Screen 9' }),
      409,
      'CONFLICT',
    );

    expect(error.message).toBe(SCREEN_NAME_IN_USE_MESSAGE);
    expect(stored(s, seeded.id)).toEqual(seeded);
  });

  it.each<[string, object | string, (string | number)[]]>([
    ['an empty body', {}, ['body']],
    ['an unknown key', { capacity: 10, isActive: false }, ['body']],
    ['an empty name', { name: '' }, ['body', 'name']],
    ['a name over 50 characters', { name: 'a'.repeat(51) }, ['body', 'name']],
    ['capacity 0', { capacity: 0 }, ['body', 'capacity']],
    ['capacity 2001', { capacity: 2001 }, ['body', 'capacity']],
    ['capacity 1.5', { capacity: 1.5 }, ['body', 'capacity']],
  ])('answers 400 for %s', async (_name, body, path) => {
    const seeded = screen1();
    const s = await setup({ screens: [seeded] });

    const error = expectError(await patchScreen(s, seeded.id, body), 400, 'VALIDATION_ERROR');

    expect(error.details).toEqual([expect.objectContaining({ path })]);
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
  });

  it('answers 400 for a bad id, 404 for an unknown one, 409 for a deleted screen', async () => {
    const deleted = screen1({ deletedAt: DELETED_AT });
    const s = await setup({ screens: [deleted] });

    expectError(await patchScreen(s, 'not-a-uuid', { capacity: 1 }), 400, 'VALIDATION_ERROR');
    expect(
      expectError(await patchScreen(s, randomUUID(), { capacity: 1 }), 404, 'NOT_FOUND').message,
    ).toBe(SCREEN_NOT_FOUND_MESSAGE);
    expect(
      expectError(await patchScreen(s, deleted.id, { capacity: 1 }), 409, 'CONFLICT').message,
    ).toBe(SCREEN_RESTORE_FIRST_MESSAGE);
    expect(screenAudits(s.db)).toEqual([]);
  });

  it('answers 409 when the screen is soft-deleted between the read and the update', async () => {
    const seeded = screen1();
    const s = await setup({ screens: [seeded] });
    s.db.injectFault('screen', 'update', {
      before: () => {
        const row = s.db.screens.find((x) => x.id === seeded.id);
        if (row) row.deletedAt = DELETED_AT;
      },
    });

    const error = expectError(await patchScreen(s, seeded.id, { capacity: 1 }), 409, 'CONFLICT');

    expect(error.message).toBe(SCREEN_RESTORE_FIRST_MESSAGE);
    expect(screenAudits(s.db)).toEqual([]);
  });

  it('answers 404 when the screen is removed between the read and the update', async () => {
    const seeded = screen1();
    const s = await setup({ screens: [seeded] });
    s.db.injectFault('screen', 'update', {
      before: () => {
        s.db.screens.splice(
          s.db.screens.findIndex((x) => x.id === seeded.id),
          1,
        );
      },
    });

    expectError(await patchScreen(s, seeded.id, { capacity: 1 }), 404, 'NOT_FOUND');
    expect(screenAudits(s.db)).toEqual([]);
  });

  it('answers 409 "changed" for a P2025 when the screen is still live afterwards', async () => {
    const seeded = screen1();
    const s = await setup({ screens: [seeded] });
    s.db.injectFault('screen', 'update', { error: recordNotFoundError('screen', 'an update') });

    const error = expectError(await patchScreen(s, seeded.id, { capacity: 1 }), 409, 'CONFLICT');

    expect(error.message).toBe(SCREEN_CHANGED_MESSAGE);
  });
});

// ---------------------------------------------------------------------------
// PATCH /:id/active, DELETE /:id: the future-showtime guard
// ---------------------------------------------------------------------------

describe('PATCH /api/admin/screens/:id/active', () => {
  it('hides a screen: STATUS_CHANGE audit, then the public cache is dropped', async () => {
    const seeded = screen1();
    const s = await setup({ screens: [seeded], showtimes: [{ startsAt: LONG_AGO }] });
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    expect(expectOk(await patchActive(s, seeded.id, { isActive: false })).isActive).toBe(false);

    expect(screenAudits(s.db)).toEqual([
      expect.objectContaining({
        action: 'STATUS_CHANGE',
        entity: 'Screen',
        entityId: seeded.id,
        details: { field: 'isActive', from: true, to: false },
      }),
    ]);
    expect(s.db.locks).toEqual([{ table: 'Screen', id: seeded.id }]);
    expectInvalidatedAfterAudit(s, invalidate);
  });

  it('shows a hidden screen, even with upcoming showtimes', async () => {
    const seeded = screen1({ isActive: false });
    const s = await setup({ screens: [seeded], showtimes: [{ startsAt: FAR_FUTURE }] });

    expect(expectOk(await patchActive(s, seeded.id, { isActive: true })).isActive).toBe(true);
    expect(screenAudits(s.db)[0]?.details).toEqual({ field: 'isActive', from: false, to: true });
  });

  it('showing a shown screen is a no-op: 200, no audit', async () => {
    const seeded = screen1();
    const s = await setup({ screens: [seeded] });
    expect(expectOk(await patchActive(s, seeded.id, { isActive: true })).updatedAt).toBe(SEEDED_AT);
    expect(screenAudits(s.db)).toEqual([]);
  });

  it.each<[string, object | string]>([
    ['an empty body', {}],
    ['a string isActive', { isActive: 'false' }],
    ['an unknown key', { isActive: false, name: 'x' }],
  ])('answers 400 for %s', async (_name, body) => {
    const seeded = screen1();
    const s = await setup({ screens: [seeded] });
    expectError(await patchActive(s, seeded.id, body), 400, 'VALIDATION_ERROR');
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
  });
});

interface GuardedEndpoint {
  name: string;
  run: (s: Setup, id: string) => request.Test;
  message: string;
}

const GUARDED: GuardedEndpoint[] = [
  {
    name: 'PATCH /api/admin/screens/:id/active (false)',
    run: (s, id) => patchActive(s, id, { isActive: false }),
    message: SCREEN_DEACTIVATE_HAS_SHOWTIMES_MESSAGE,
  },
  {
    name: 'DELETE /api/admin/screens/:id',
    run: (s, id) => deleteScreen(s, id),
    message: SCREEN_DELETE_HAS_SHOWTIMES_MESSAGE,
  },
];

describe.each(GUARDED)('$name: future-showtime guard', ({ run, message }) => {
  it('answers 409 with futureShowtimeCount 1 for one upcoming showtime, changing nothing', async () => {
    const seeded = screen1();
    const s = await setup({
      screens: [seeded],
      showtimes: [
        { startsAt: FAR_FUTURE },
        { startsAt: LONG_AGO },
        { startsAt: FAR_FUTURE, deletedAt: DELETED_AT },
      ],
    });
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    const res = await run(s, seeded.id);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { code: 'CONFLICT', message, details: { futureShowtimeCount: 1 } },
    });
    expect(stored(s, seeded.id)).toEqual(seeded);
    expect(s.db.spies.screen.update).not.toHaveBeenCalled();
    expect(screenAudits(s.db)).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
    // The screen row was locked before the count.
    expect(s.db.locks).toEqual([{ table: 'Screen', id: seeded.id }]);
    const lockOrder = s.db.spies.$queryRaw.mock.invocationCallOrder[0] ?? Infinity;
    const countOrder = s.db.spies.showtime.count.mock.invocationCallOrder[0] ?? -Infinity;
    expect(lockOrder).toBeLessThan(countOrder);
  });

  it.each<[string, ShowtimeOnScreen[]]>([
    ['only past showtimes', [{ startsAt: LONG_AGO }]],
    ['only soft-deleted upcoming showtimes', [{ startsAt: FAR_FUTURE, deletedAt: DELETED_AT }]],
  ])('is allowed with %s', async (_name, showtimes) => {
    const seeded = screen1();
    const s = await setup({ screens: [seeded], showtimes });

    const res = await run(s, seeded.id);

    expect(res.status).toBe(200);
    expect(screenAudits(s.db)).toHaveLength(1);
  });

  it('an upcoming showtime on another screen does not block', async () => {
    const seeded = screen1();
    const other = testScreen({ name: 'Screen 2' });
    const s = await setup({ screens: [other, seeded], showtimes: [{ startsAt: FAR_FUTURE }] });

    expect((await run(s, seeded.id)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// DELETE /:id and POST /:id/restore
// ---------------------------------------------------------------------------

describe('DELETE /api/admin/screens/:id (soft delete)', () => {
  it('soft-deletes: DELETE soft audit, then the cache is dropped; admins still see it', async () => {
    const seeded = screen1();
    const s = await setup({ screens: [seeded] });
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    const screen = expectOk(await deleteScreen(s, seeded.id));

    expect(screen.deletedAt).not.toBeNull();
    expect(screen.isActive).toBe(true);
    expect(screenAudits(s.db)).toEqual([
      expect.objectContaining({
        action: 'DELETE',
        entity: 'Screen',
        entityId: seeded.id,
        details: { mode: 'soft', name: 'Screen 1' },
      }),
    ]);
    expectInvalidatedAfterAudit(s, invalidate);
    expect(expectOk(await getScreen(s, `/${seeded.id}`)).deletedAt).toBe(screen.deletedAt);
  });

  it('accepts an empty JSON object as the body; rejects any key', async () => {
    const seeded = screen1();
    const s = await setup({ screens: [seeded] });
    expectError(
      await deleteScreen(s, seeded.id, { body: { hard: true } }),
      400,
      'VALIDATION_ERROR',
    );
    expectOk(await deleteScreen(s, seeded.id, { body: {} }));
  });

  it('answers 409 when already deleted, 404 when unknown, 400 for a bad id', async () => {
    const deleted = screen1({ deletedAt: DELETED_AT });
    const s = await setup({ screens: [deleted] });
    expect(expectError(await deleteScreen(s, deleted.id), 409, 'CONFLICT').message).toBe(
      SCREEN_ALREADY_DELETED_MESSAGE,
    );
    expect(expectError(await deleteScreen(s, randomUUID()), 404, 'NOT_FOUND').message).toBe(
      SCREEN_NOT_FOUND_MESSAGE,
    );
    expectError(await deleteScreen(s, 'not-a-uuid'), 400, 'VALIDATION_ERROR');
    expect(screenAudits(s.db)).toEqual([]);
  });

  it('a deleted screen cannot be edited or hidden until restored', async () => {
    const seeded = screen1();
    const s = await setup({ screens: [seeded] });
    expectOk(await deleteScreen(s, seeded.id));

    for (const res of [
      await patchScreen(s, seeded.id, { capacity: 1 }),
      await patchActive(s, seeded.id, { isActive: false }),
    ]) {
      expect(expectError(res, 409, 'CONFLICT').message).toBe(SCREEN_RESTORE_FIRST_MESSAGE);
    }
  });

  it('there is no hard delete route', async () => {
    const seeded = screen1({ deletedAt: DELETED_AT });
    const s = await setup({ screens: [seeded] });
    expectError(await send(s, 'delete', `/${seeded.id}/permanent`), 404, 'NOT_FOUND');
    expect(s.db.screens).toEqual([seeded]);
  });
});

describe('POST /api/admin/screens/:id/restore', () => {
  it('restores: UPDATE restored audit, visibility kept, then the cache is dropped', async () => {
    const seeded = screen1({ isActive: false, deletedAt: DELETED_AT });
    const s = await setup({ screens: [seeded] });
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    const screen = expectOk(await restoreScreen(s, seeded.id));

    expect(screen).toMatchObject({ deletedAt: null, isActive: false });
    expect(screenAudits(s.db)).toEqual([
      expect.objectContaining({
        action: 'UPDATE',
        entity: 'Screen',
        entityId: seeded.id,
        details: { restored: true, name: 'Screen 1' },
      }),
    ]);
    expectInvalidatedAfterAudit(s, invalidate);
  });

  it('answers 409 when not deleted, 404 when unknown, 400 for a body key', async () => {
    const live = screen1();
    const s = await setup({ screens: [live] });
    expect(expectError(await restoreScreen(s, live.id), 409, 'CONFLICT').message).toBe(
      SCREEN_NOT_DELETED_MESSAGE,
    );
    expectError(await restoreScreen(s, randomUUID()), 404, 'NOT_FOUND');
    expectError(await restoreScreen(s, live.id, { body: { x: 1 } }), 400, 'VALIDATION_ERROR');
    expect(screenAudits(s.db)).toEqual([]);
  });

  it('answers 409 while a live screen has the name (ignoring case), changing nothing', async () => {
    const deleted = screen1({ deletedAt: DELETED_AT });
    const s = await setup({ screens: [deleted, testScreen({ name: 'SCREEN 1' })] });

    const res = await restoreScreen(s, deleted.id);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { code: 'CONFLICT', message: SCREEN_RESTORE_NAME_IN_USE_MESSAGE },
    });
    expect(stored(s, deleted.id)).toEqual(deleted);
    expect(screenAudits(s.db)).toEqual([]);
  });

  it('a restored screen can be edited again', async () => {
    const deleted = screen1({ deletedAt: DELETED_AT });
    const s = await setup({ screens: [deleted] });
    expectOk(await restoreScreen(s, deleted.id));
    expect(expectOk(await patchScreen(s, deleted.id, { capacity: 10 })).capacity).toBe(10);
  });
});

describe('screen lifecycle', () => {
  it('create -> rename -> hide -> show -> delete -> restore, all audited in order', async () => {
    const s = await setup({ role: 'SUPER_ADMIN' });

    const { id } = expectOk(await createScreen(s, { name: 'Screen 1' }), 201);
    expectOk(await patchScreen(s, id, { name: 'Screen One', capacity: 200 }));
    expectOk(await patchActive(s, id, { isActive: false }));
    expectOk(await patchActive(s, id, { isActive: true }));
    expectOk(await deleteScreen(s, id));
    // The deleted name blocks a new screen with the restore hint...
    expect(
      expectError(await createScreen(s, { name: 'screen one' }), 409, 'CONFLICT').message,
    ).toBe(SCREEN_NAME_DELETED_MESSAGE);
    expectOk(await restoreScreen(s, id));

    expect(screenAudits(s.db).map((row) => [row.action, row.details])).toEqual([
      ['CREATE', { name: 'Screen 1', capacity: null }],
      [
        'UPDATE',
        {
          changes: {
            name: { from: 'Screen 1', to: 'Screen One' },
            capacity: { from: null, to: 200 },
          },
        },
      ],
      ['STATUS_CHANGE', { field: 'isActive', from: true, to: false }],
      ['STATUS_CHANGE', { field: 'isActive', from: false, to: true }],
      ['DELETE', { mode: 'soft', name: 'Screen One' }],
      ['UPDATE', { restored: true, name: 'Screen One' }],
    ]);
    expect(screenAudits(s.db).every((row) => row.entityId === id)).toBe(true);
  });
});
