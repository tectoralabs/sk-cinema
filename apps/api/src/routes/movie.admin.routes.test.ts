import { randomUUID } from 'node:crypto';
import {
  adminMovieResponseSchema,
  apiErrorSchema,
  publicMovieListResponseSchema,
  type AdminMovie,
  type MovieCreateBodyInput,
} from '@sk-cinema/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AdminRole, Movie } from '../generated/prisma/client.js';
import { hashPassword } from '../lib/password.js';
import {
  AUTO_SLUG_MAX_ATTEMPTS,
  SLUG_GENERATION_FAILED_MESSAGE,
  SLUG_IN_USE_MESSAGE,
  SLUG_REQUIRED_MESSAGE,
} from '../services/movie.admin.service.js';
import { PUBLIC_MOVIES_CACHE_PREFIX } from '../services/movie.public.service.js';
import { SESSION_EXPIRED_MESSAGE } from '../services/auth.service.js';
import {
  ADMIN_BASE,
  TEST_USER_AGENT,
  authClient,
  buildTestApp,
  inMemoryAuthDb,
  sessionFrom,
  testAdmin,
  testMovie,
  uniqueConstraintError,
  type AuthClient,
  type InMemoryAuthDb,
  type Session,
} from '../test/helpers.js';

const EMAIL = 'editor@skcinema.lk';
const PASSWORD = 'correct horse battery staple';
const UNAUTHORIZED_BODY = { error: { code: 'UNAUTHORIZED', message: SESSION_EXPIRED_MESSAGE } };
const CSRF_BODY = { error: { code: 'CSRF_INVALID', message: 'CSRF validation failed' } };
const INTERNAL_BODY = { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } };

const SINHALA_TITLE = 'ගැහැණු ළමයා';
const TAMIL_TITLE = 'விடுதலை';

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

interface Setup {
  app: Express;
  db: InMemoryAuthDb;
  cache: ReturnType<typeof buildTestApp>['cache'];
  adminId: string;
  client: AuthClient;
  session: Session;
}

async function setup(options: { role?: AdminRole; movies?: Movie[] } = {}): Promise<Setup> {
  const admin = testAdmin({ email: EMAIL, passwordHash, role: options.role ?? 'EDITOR' });
  const db = inMemoryAuthDb({ admins: [admin], movies: options.movies ?? [] });
  const { app, cache } = buildTestApp({ prisma: db.prisma });
  const client = await authClient(app);
  const login = await client.post('/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  expect(login.status).toBe(200);
  // Count only the calls the request under test makes (login has its own transaction).
  vi.clearAllMocks();
  return { app, db, cache, adminId: admin.id, client, session: sessionFrom(login) };
}

const createMovie = (s: Setup, body: object | string) =>
  s.client.post('/movies', { body, cookies: [s.session.access] });

const getMovie = (s: Setup, id: string) => s.client.get(`/movies/${id}`, [s.session.access]);

/** The audit rows about movies (login writes its own LOGIN rows). */
const movieAudits = (db: InMemoryAuthDb) => db.auditLogs.filter((row) => row.entity === 'Movie');

function expectCreated(res: request.Response): AdminMovie {
  expect(res.status).toBe(201);
  expect(res.headers['cache-control']).toBe('no-store');
  return adminMovieResponseSchema.parse(res.body).movie;
}

function expectError(res: request.Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const { error } = apiErrorSchema.parse(res.body);
  expect(error.code).toBe(code);
  return error;
}

/** No movie row and no movie audit row: nothing of a refused create survives. */
function expectNothingWritten(db: InMemoryAuthDb) {
  expect(db.movies).toEqual([]);
  expect(movieAudits(db)).toEqual([]);
}

const deleted = (overrides: Partial<Movie>) =>
  testMovie({ deletedAt: new Date('2026-10-01T00:00:00.000Z'), ...overrides });

describe('POST /api/admin/movies', () => {
  describe('happy path', () => {
    it.each<AdminRole>(['EDITOR', 'SUPER_ADMIN'])(
      'a %s creates a movie (201) with one CREATE audit row',
      async (role) => {
        const s = await setup({ role });
        const body: MovieCreateBodyInput = {
          title: '  Avatar: Fire and Ash  ',
          durationMinutes: 197,
          synopsis: 'Pandora again.',
          language: 'English',
          genres: ['Sci-Fi', 'sci-fi', 'Adventure'],
          rating: 'PG-13',
          director: 'James Cameron',
          cast: ['Sam Worthington', 'Zoe Saldaña'],
          releaseDate: '2026-12-19',
          trailerUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          status: 'NOW_SHOWING',
        };

        const movie = expectCreated(await createMovie(s, body));

        expect(movie).toMatchObject({
          slug: 'avatar-fire-and-ash',
          title: 'Avatar: Fire and Ash',
          durationMinutes: 197,
          synopsis: 'Pandora again.',
          language: 'English',
          genres: ['Sci-Fi', 'Adventure'],
          rating: 'PG-13',
          director: 'James Cameron',
          cast: ['Sam Worthington', 'Zoe Saldaña'],
          releaseDate: '2026-12-19',
          trailerUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          status: 'NOW_SHOWING',
          posterUrl: null,
          posterPublicId: null,
          bannerUrl: null,
          bannerPublicId: null,
          isActive: true,
          deletedAt: null,
        });
        expect(movie.createdAt).toBe(movie.updatedAt);

        // Stored as given: the date as UTC midnight (a DATE column), no zone shift.
        expect(s.db.movies).toHaveLength(1);
        expect(s.db.movies[0]).toMatchObject({ id: movie.id, slug: movie.slug });
        expect(s.db.movies[0]?.releaseDate?.toISOString()).toBe('2026-12-19T00:00:00.000Z');

        const login = s.db.auditLogs.find((row) => row.action === 'LOGIN');
        const audits = movieAudits(s.db);
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
          action: 'CREATE',
          adminId: s.adminId,
          entity: 'Movie',
          entityId: movie.id,
          details: { title: 'Avatar: Fire and Ash', slug: 'avatar-fire-and-ash' },
          // The same client that logged in.
          ipAddress: login?.ipAddress,
          userAgent: TEST_USER_AGENT,
        });
        expect(audits[0]?.ipAddress).toEqual(expect.any(String));
      },
    );

    it('applies the defaults for a minimal body', async () => {
      const s = await setup();

      const movie = expectCreated(await createMovie(s, { title: 'Minimal', durationMinutes: 90 }));

      expect(movie).toMatchObject({
        slug: 'minimal',
        synopsis: null,
        language: null,
        genres: [],
        rating: null,
        director: null,
        cast: [],
        releaseDate: null,
        trailerUrl: null,
        status: 'UPCOMING',
        isActive: true,
      });
    });
  });

  describe('validation (400, nothing written)', () => {
    const INVALID: [string, object | string][] = [
      ['missing title', { durationMinutes: 120 }],
      ['missing durationMinutes', { title: 'No Duration' }],
      ['an unknown key', { title: 'Avatar', durationMinutes: 120, foo: 1 }],
      ["'' in an optional text field", { title: 'Avatar', durationMinutes: 120, synopsis: '' }],
      ['whitespace-only title', { title: '   ', durationMinutes: 120 }],
      [
        'posterUrl (images have their own endpoint)',
        {
          title: 'Avatar',
          durationMinutes: 120,
          posterUrl: 'https://res.cloudinary.com/x/image/upload/p.jpg',
        },
      ],
      [
        'isActive (visibility has its own endpoint)',
        { title: 'A', durationMinutes: 1, isActive: false },
      ],
      ['a malformed slug', { title: 'Avatar', durationMinutes: 120, slug: 'Not A Slug' }],
      ['an impossible release date', { title: 'A', durationMinutes: 1, releaseDate: '2026-02-30' }],
      ['a non-YouTube trailer', { title: 'A', durationMinutes: 1, trailerUrl: 'https://evil.com' }],
      ['a JSON array body', '[]'],
    ];

    it.each(INVALID)('rejects %s', async (_name, body) => {
      const s = await setup();

      const res =
        typeof body === 'string'
          ? await s.client
              .post('/movies', { cookies: [s.session.access] })
              .set('Content-Type', 'application/json')
              .send(body)
          : await createMovie(s, body);

      expectError(res, 400, 'VALIDATION_ERROR');
      expect(s.db.spies.movie.create).not.toHaveBeenCalled();
      expectNothingWritten(s.db);
    });

    it('rejects query parameters', async () => {
      const s = await setup();

      const res = await s.client.post('/movies?draft=1', {
        body: { title: 'Avatar', durationMinutes: 120 },
        cookies: [s.session.access],
      });

      expectError(res, 400, 'VALIDATION_ERROR');
      expectNothingWritten(s.db);
    });

    it('points at body.slug when the body is wrong in several places', async () => {
      const s = await setup();

      const error = expectError(
        await createMovie(s, { title: '', durationMinutes: 0, slug: '-bad-' }),
        400,
        'VALIDATION_ERROR',
      );

      const paths = (error.details as { path: string[] }[]).map((d) => d.path.join('.'));
      expect(paths).toEqual(
        expect.arrayContaining(['body.title', 'body.durationMinutes', 'body.slug']),
      );
    });
  });

  describe('auth and CSRF', () => {
    it('answers 401 without a session, before reading the body', async () => {
      const s = await setup();

      const res = await s.client.post('/movies', { body: { title: 'Avatar', durationMinutes: 1 } });

      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED_BODY);
      expectNothingWritten(s.db);
    });

    it('answers 401 for an invalid session cookie', async () => {
      const s = await setup();

      const res = await s.client.post('/movies', {
        body: { title: 'Avatar', durationMinutes: 1 },
        cookies: [`${s.session.access}x`],
      });

      expect(res.status).toBe(401);
      expectNothingWritten(s.db);
    });

    it.each([
      ['a missing CSRF token', { token: null }],
      ['a wrong CSRF token', { token: 'not-the-token' }],
      ['a missing CSRF cookie', { csrfCookie: false }],
      ['a missing Origin', { origin: null }],
    ] as const)('answers 403 for %s, even with a session', async (_name, overrides) => {
      const s = await setup();

      const res = await s.client.post('/movies', {
        body: { title: 'Avatar', durationMinutes: 1 },
        cookies: [s.session.access],
        ...overrides,
      });

      expect(res.status).toBe(403);
      expect(res.body).toEqual(CSRF_BODY);
      expectNothingWritten(s.db);
    });
  });

  describe('slugs', () => {
    it.each([
      ['Sinhala', SINHALA_TITLE],
      ['Tamil', TAMIL_TITLE],
      ['punctuation-only', '!!! ???'],
    ])('a %s-only title without a slug is a 400 on body.slug', async (_name, title) => {
      const s = await setup();

      const error = expectError(
        await createMovie(s, { title, durationMinutes: 120 }),
        400,
        'VALIDATION_ERROR',
      );

      expect(error.message).toBe(SLUG_REQUIRED_MESSAGE);
      expect(error.details).toEqual([{ path: ['body', 'slug'], message: SLUG_REQUIRED_MESSAGE }]);
      expectNothingWritten(s.db);
    });

    it('the same Sinhala title with an explicit slug is created', async () => {
      const s = await setup();

      const movie = expectCreated(
        await createMovie(s, { title: SINHALA_TITLE, slug: 'gahanu-lamai', durationMinutes: 120 }),
      );

      expect(movie).toMatchObject({ title: SINHALA_TITLE, slug: 'gahanu-lamai' });
      expect(movieAudits(s.db)).toHaveLength(1);
    });

    it('suffixes -2, then -3, counting a soft-deleted movie that holds the base slug', async () => {
      const s = await setup({ movies: [deleted({ slug: 'avatar', title: 'Old Avatar' })] });

      const second = expectCreated(await createMovie(s, { title: 'Avatar', durationMinutes: 162 }));
      const third = expectCreated(await createMovie(s, { title: 'AVATAR!', durationMinutes: 162 }));

      expect(second.slug).toBe('avatar-2');
      expect(third.slug).toBe('avatar-3');
      expect(movieAudits(s.db).map((row) => row.details)).toEqual([
        { title: 'Avatar', slug: 'avatar-2' },
        { title: 'AVATAR!', slug: 'avatar-3' },
      ]);
    });

    it('fills the first free suffix, ignoring unrelated slugs with the same prefix', async () => {
      const s = await setup({
        movies: [
          testMovie({ slug: 'avatar', title: 'Avatar' }),
          testMovie({ slug: 'avatar-3', title: 'Avatar 3' }),
          testMovie({ slug: 'avatar-the-way-of-water', title: 'Avatar: The Way of Water' }),
        ],
      });

      const movie = expectCreated(await createMovie(s, { title: 'Avatar', durationMinutes: 162 }));

      expect(movie.slug).toBe('avatar-2');
    });

    it('an explicit slug that is taken (even by a deleted movie) is a 409, never altered', async () => {
      const s = await setup({ movies: [deleted({ slug: 'avatar', title: 'Old Avatar' })] });

      const error = expectError(
        await createMovie(s, { title: 'Avatar', slug: 'avatar', durationMinutes: 162 }),
        409,
        'CONFLICT',
      );

      expect(error.message).toBe(SLUG_IN_USE_MESSAGE);
      expect(error.details).toEqual([{ path: ['body', 'slug'], message: SLUG_IN_USE_MESSAGE }]);
      expect(s.db.spies.movie.create).not.toHaveBeenCalled();
      expect(s.db.movies).toHaveLength(1);
      expect(movieAudits(s.db)).toEqual([]);
    });

    it('an explicit slug that hits P2002 on insert is a 409 (not a 500), with no retry', async () => {
      const s = await setup();
      s.db.injectFault('movie', 'create', { error: uniqueConstraintError('movie', 'slug') });

      const error = expectError(
        await createMovie(s, { title: 'Avatar', slug: 'avatar', durationMinutes: 162 }),
        409,
        'CONFLICT',
      );

      expect(error.message).toBe(SLUG_IN_USE_MESSAGE);
      expect(s.db.spies.$transaction).toHaveBeenCalledTimes(1);
      expectNothingWritten(s.db);
    });

    it('an explicit slug taken by a concurrent insert after the check is a 409', async () => {
      const s = await setup();
      s.db.injectFault('movie', 'create', {
        before: () => s.db.addMovie({ slug: 'avatar', title: 'Racer', durationMinutes: 100 }),
      });

      expectError(
        await createMovie(s, { title: 'Avatar', slug: 'avatar', durationMinutes: 162 }),
        409,
        'CONFLICT',
      );

      expect(s.db.movies.map((m) => m.title)).toEqual(['Racer']);
      expect(movieAudits(s.db)).toEqual([]);
    });

    it('a generated slug that hits a one-off P2002 is retried with the next suffix', async () => {
      const s = await setup();
      s.db.injectFault('movie', 'create', { error: uniqueConstraintError('movie', 'slug') });

      const movie = expectCreated(await createMovie(s, { title: 'Avatar', durationMinutes: 162 }));

      expect(movie.slug).toBe('avatar-2');
      expect(s.db.spies.$transaction).toHaveBeenCalledTimes(2);
      expect(s.db.movies).toHaveLength(1);
      expect(movieAudits(s.db)).toHaveLength(1);
      expect(movieAudits(s.db)[0]?.details).toEqual({ title: 'Avatar', slug: 'avatar-2' });
    });

    it('a generated slug taken by a concurrent insert is retried with the next suffix', async () => {
      const s = await setup();
      s.db.injectFault('movie', 'create', {
        before: () => s.db.addMovie({ slug: 'avatar', title: 'Racer', durationMinutes: 100 }),
      });

      const movie = expectCreated(await createMovie(s, { title: 'Avatar', durationMinutes: 162 }));

      expect(movie.slug).toBe('avatar-2');
      expect(s.db.movies.map((m) => m.slug).sort()).toEqual(['avatar', 'avatar-2']);
      expect(movieAudits(s.db)).toHaveLength(1);
    });

    it(`a generated slug that clashes on all ${String(AUTO_SLUG_MAX_ATTEMPTS)} attempts is a 409`, async () => {
      const s = await setup();
      for (let i = 0; i < AUTO_SLUG_MAX_ATTEMPTS; i += 1) {
        s.db.spies.movie.create.mockRejectedValueOnce(uniqueConstraintError('movie', 'slug'));
      }

      const error = expectError(
        await createMovie(s, { title: 'Avatar', durationMinutes: 162 }),
        409,
        'CONFLICT',
      );

      expect(error.message).toBe(SLUG_GENERATION_FAILED_MESSAGE);
      expect(s.db.spies.$transaction).toHaveBeenCalledTimes(AUTO_SLUG_MAX_ATTEMPTS);
      expect(s.db.spies.movie.create.mock.calls.map(([args]) => args.data['slug'])).toEqual([
        'avatar',
        'avatar-2',
        'avatar-3',
      ]);
      expectNothingWritten(s.db);
    });
  });

  describe('failures', () => {
    it('rolls the movie back and answers a generic 500 when the audit write fails', async () => {
      const s = await setup();
      s.db.injectFault('auditLog', 'create', {
        error: new Error('relation "AuditLog" does not exist'),
      });

      const res = await createMovie(s, { title: 'Avatar', durationMinutes: 162 });

      expect(res.status).toBe(500);
      expect(res.body).toEqual(INTERNAL_BODY);
      expect(JSON.stringify(res.body)).not.toContain('AuditLog');
      // The insert ran inside the transaction and was undone.
      expect(s.db.spies.movie.create).toHaveBeenCalledTimes(1);
      expectNothingWritten(s.db);
    });

    it('answers a generic 500 when the database fails', async () => {
      const s = await setup();
      s.db.injectFault('movie', 'findMany', { error: new Error('connect ECONNREFUSED 10.0.0.1') });

      const res = await createMovie(s, { title: 'Avatar', durationMinutes: 162 });

      expect(res.status).toBe(500);
      expect(res.body).toEqual(INTERNAL_BODY);
      expectNothingWritten(s.db);
    });
  });

  describe('public cache', () => {
    it('a create drops the cached public list, after the transaction', async () => {
      const s = await setup();
      const publicList = async () =>
        publicMovieListResponseSchema
          .parse((await request(s.app).get('/api/movies')).body)
          .movies.map((m) => m.slug);

      expect(await publicList()).toEqual([]);
      expect(await publicList()).toEqual([]);
      expect(s.db.spies.movie.findMany).toHaveBeenCalledTimes(2); // one per status, then cached
      const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

      expectCreated(await createMovie(s, { title: 'Avatar', durationMinutes: 162 }));

      expect(invalidate).toHaveBeenCalledExactlyOnceWith(PUBLIC_MOVIES_CACHE_PREFIX);
      // After the transaction's last write (its audit row), not before.
      const auditOrder = s.db.spies.auditLog.create.mock.invocationCallOrder.at(-1) ?? Infinity;
      expect(invalidate.mock.invocationCallOrder[0]).toBeGreaterThan(auditOrder);
      expect(await publicList()).toEqual(['avatar']);
    });

    it('a refused or failed create leaves the cache alone', async () => {
      const s = await setup();
      const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');
      s.db.injectFault('auditLog', 'create', { error: new Error('down') });

      expect((await createMovie(s, { title: 'Avatar', durationMinutes: 162 })).status).toBe(500);
      expect((await createMovie(s, { title: SINHALA_TITLE, durationMinutes: 1 })).status).toBe(400);

      expect(invalidate).not.toHaveBeenCalled();
    });
  });
});

describe('GET /api/admin/movies/:id', () => {
  it('returns an active movie (200, strict admin shape)', async () => {
    const seeded = testMovie({
      slug: 'avatar',
      title: 'Avatar',
      releaseDate: new Date('2026-11-01T00:00:00.000Z'),
      posterUrl: 'https://res.cloudinary.com/sk/image/upload/poster.jpg',
      posterPublicId: 'sk/posters/avatar',
    });
    const s = await setup({ movies: [seeded] });

    const res = await getMovie(s, seeded.id);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(adminMovieResponseSchema.parse(res.body).movie).toEqual({
      id: seeded.id,
      slug: 'avatar',
      title: 'Avatar',
      synopsis: null,
      durationMinutes: 120,
      language: null,
      genres: [],
      rating: null,
      director: null,
      cast: [],
      releaseDate: '2026-11-01',
      trailerUrl: null,
      status: 'UPCOMING',
      posterUrl: 'https://res.cloudinary.com/sk/image/upload/poster.jpg',
      posterPublicId: 'sk/posters/avatar',
      bannerUrl: null,
      bannerPublicId: null,
      isActive: true,
      deletedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('returns soft-deleted and hidden movies too', async () => {
    const gone = deleted({ slug: 'gone', title: 'Gone', isActive: false });
    const s = await setup({ movies: [gone] });

    const res = await getMovie(s, gone.id);

    expect(res.status).toBe(200);
    expect(adminMovieResponseSchema.parse(res.body).movie).toMatchObject({
      id: gone.id,
      isActive: false,
      deletedAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('answers 404 for an unknown id', async () => {
    const s = await setup({ movies: [testMovie()] });

    const error = expectError(await getMovie(s, randomUUID()), 404, 'NOT_FOUND');

    expect(error.message).toBe('Movie not found');
  });

  it.each(['not-a-uuid', '123', 'avatar'])('answers 400 for the id %s', async (id) => {
    const s = await setup();

    const error = expectError(await getMovie(s, id), 400, 'VALIDATION_ERROR');

    expect(error.details).toEqual([expect.objectContaining({ path: ['params', 'id'] })]);
    expect(s.db.spies.movie.findUnique).not.toHaveBeenCalled();
  });

  it('answers 400 for query parameters', async () => {
    const seeded = testMovie();
    const s = await setup({ movies: [seeded] });

    const res = await s.client.get(`/movies/${seeded.id}?include=deleted`, [s.session.access]);

    expectError(res, 400, 'VALIDATION_ERROR');
  });

  it('answers 401 without a session', async () => {
    const seeded = testMovie();
    const s = await setup({ movies: [seeded] });

    const res = await request(s.app).get(`${ADMIN_BASE}/movies/${seeded.id}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
    expect(s.db.spies.movie.findUnique).not.toHaveBeenCalled();
  });

  it('serves a SUPER_ADMIN as well as an EDITOR', async () => {
    const seeded = testMovie();
    const s = await setup({ role: 'SUPER_ADMIN', movies: [seeded] });

    expect((await getMovie(s, seeded.id)).status).toBe(200);
  });
});
