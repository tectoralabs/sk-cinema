import { randomUUID } from 'node:crypto';
import {
  adminMovieListResponseSchema,
  adminMovieResponseSchema,
  apiErrorSchema,
  publicMovieListResponseSchema,
  publicMovieResponseSchema,
  type AdminMovie,
  type AdminMovieListResponse,
  type MovieCreateBodyInput,
} from '@sk-cinema/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AdminRole, Movie } from '../generated/prisma/client.js';
import { FORBIDDEN_MESSAGE } from '../middleware/auth.js';
import { CSRF_HEADER } from '../middleware/csrf.js';
import {
  AUTO_SLUG_MAX_ATTEMPTS,
  adminMovieSelect,
  MOVIE_ALREADY_DELETED_MESSAGE,
  MOVIE_CHANGED_MESSAGE,
  MOVIE_DELETE_FIRST_MESSAGE,
  MOVIE_NOT_DELETED_MESSAGE,
  MOVIE_NOT_FOUND_MESSAGE,
  MOVIE_RESTORE_FIRST_MESSAGE,
  SLUG_GENERATION_FAILED_MESSAGE,
  SLUG_IN_USE_MESSAGE,
  SLUG_REQUIRED_MESSAGE,
} from '../services/movie.admin.service.js';
import { PUBLIC_MOVIES_CACHE_PREFIX } from '../services/movie.public.service.js';
import { SESSION_EXPIRED_MESSAGE } from '../services/auth.service.js';
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

const SINHALA_TITLE = 'ගැහැණු ළමයා';
const TAMIL_TITLE = 'விடுதலை';

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

    it('a Sinhala-only title end to end: 400 without a slug, 201 with one, then public by it', async () => {
      const s = await setup();

      expectError(
        await createMovie(s, { title: SINHALA_TITLE, durationMinutes: 120, status: 'NOW_SHOWING' }),
        400,
        'VALIDATION_ERROR',
      );
      const movie = expectCreated(
        await createMovie(s, {
          title: SINHALA_TITLE,
          slug: 'gahanu-lamai',
          durationMinutes: 120,
          status: 'NOW_SHOWING',
        }),
      );

      const detail = await publicGet(s, '/gahanu-lamai');
      expect(detail.status).toBe(200);
      expect(publicMovieResponseSchema.parse(detail.body).movie).toMatchObject({
        id: movie.id,
        slug: 'gahanu-lamai',
        title: SINHALA_TITLE,
      });
      const list = publicMovieListResponseSchema.parse((await publicGet(s, '')).body).movies;
      expect(list.map((m) => [m.slug, m.title])).toEqual([['gahanu-lamai', SINHALA_TITLE]]);
      // Only the successful create is audited.
      expect(movieAudits(s.db).map((row) => row.details)).toEqual([
        { title: SINHALA_TITLE, slug: 'gahanu-lamai' },
      ]);
    });

    it('concurrent creates of the same title both succeed, with distinct slugs and audit rows', async () => {
      const s = await setup();
      const body = { title: 'Avatar', durationMinutes: 162 };

      const responses = await Promise.all([createMovie(s, body), createMovie(s, body)]);

      const movies = responses.map(expectCreated);
      expect(movies.map((m) => m.slug).sort()).toEqual(['avatar', 'avatar-2']);
      expect(new Set(movies.map((m) => m.id)).size).toBe(2);
      expect(s.db.movies.map((m) => m.slug).sort()).toEqual(['avatar', 'avatar-2']);
      const audits = movieAudits(s.db);
      expect(audits.map((row) => row.action)).toEqual(['CREATE', 'CREATE']);
      expect(audits.map((row) => row.entityId).sort()).toEqual(movies.map((m) => m.id).sort());
      expect(audits.map((row) => row.details)).toEqual(
        expect.arrayContaining(movies.map((m) => ({ title: 'Avatar', slug: m.slug }))),
      );
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

    it('a short base ignores the many slugs that merely start with it, and loads none of `theatre`', async () => {
      const neighbours = ['theatre', 'the-batman', 'the-matrix', 'the-2-towers'].map((slug) =>
        testMovie({ slug, title: slug }),
      );
      const s = await setup({ movies: neighbours });

      const first = expectCreated(await createMovie(s, { title: 'The', durationMinutes: 90 }));
      const second = expectCreated(await createMovie(s, { title: 'THE!', durationMinutes: 90 }));

      expect([first.slug, second.slug]).toEqual(['the', 'the-2']);
      expect(s.db.spies.movie.findMany).toHaveBeenCalledWith({
        where: { OR: [{ slug: 'the' }, { slug: { startsWith: 'the-' } }] },
        select: { slug: true },
      });
      // What each slug lookup returned: rows under `the-` (filtered later), never `theatre`.
      const loaded = await Promise.all(
        s.db.spies.movie.findMany.mock.results.map(
          (result) => result.value as Promise<{ slug: string }[]>,
        ),
      );
      expect(loaded.map((rows) => rows.map((row) => row.slug).sort())).toEqual([
        ['the-2-towers', 'the-batman', 'the-matrix'],
        ['the', 'the-2-towers', 'the-batman', 'the-matrix'],
      ]);
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
      for (let call = 1; call <= AUTO_SLUG_MAX_ATTEMPTS; call += 1) {
        s.db.injectFault('movie', 'create', {
          onCall: call,
          error: uniqueConstraintError('movie', 'slug'),
        });
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

describe('GET /api/admin/movies', () => {
  const day = (n: number) => new Date(Date.UTC(2026, 0, n));
  const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  const listMovies = (s: Setup, query: Record<string, string> | string = {}) => {
    const qs = typeof query === 'string' ? query : new URLSearchParams(query).toString();
    return s.client.get(qs === '' ? '/movies' : `/movies?${qs}`, [s.session.access]);
  };

  /** 200, no-store, and a body the strict shared response schema accepts. */
  function expectPage(res: request.Response): AdminMovieListResponse {
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    return adminMovieListResponseSchema.parse(res.body);
  }

  const slugsOf = (page: AdminMovieListResponse) => page.items.map((m) => m.slug);
  const listSlugs = async (s: Setup, query: Record<string, string> | string = {}) =>
    slugsOf(expectPage(await listMovies(s, query)));

  describe('defaults', () => {
    it('excludes deleted movies, sorts by updatedAt desc, page 1 of 20', async () => {
      const movies = Array.from({ length: 25 }, (_, i) =>
        testMovie({
          slug: `movie-${String(i + 1)}`,
          title: `Movie ${String(i + 1)}`,
          updatedAt: day(i + 1),
        }),
      );
      const s = await setup({
        movies: [...movies, deleted({ slug: 'gone', title: 'Gone', updatedAt: day(31) })],
      });

      const page = expectPage(await listMovies(s));

      expect(page).toMatchObject({ page: 1, pageSize: 20, total: 25 });
      expect(slugsOf(page)).toEqual(
        Array.from({ length: 20 }, (_, i) => `movie-${String(25 - i)}`),
      );
    });

    it('returns each movie in the same admin shape as GET /:id', async () => {
      const seeded = testMovie({
        slug: 'avatar',
        title: 'Avatar',
        genres: ['Sci-Fi'],
        releaseDate: date('2026-11-01'),
        posterUrl: 'https://res.cloudinary.com/sk/image/upload/poster.jpg',
        posterPublicId: 'sk/posters/avatar',
        isActive: false,
      });
      const s = await setup({ movies: [seeded] });

      const page = expectPage(await listMovies(s));
      const single = adminMovieResponseSchema.parse((await getMovie(s, seeded.id)).body).movie;

      expect(page).toEqual({ items: [single], page: 1, pageSize: 20, total: 1 });
    });

    it('an empty table is an empty first page', async () => {
      const s = await setup();

      expect(expectPage(await listMovies(s))).toEqual({
        items: [],
        page: 1,
        pageSize: 20,
        total: 0,
      });
    });

    it('is never cached: a movie added between two reads is in the second', async () => {
      const s = await setup({ movies: [testMovie({ slug: 'first', title: 'First' })] });

      expect(await listSlugs(s)).toEqual(['first']);
      s.db.addMovie({ slug: 'second', title: 'Second', durationMinutes: 90, updatedAt: day(2) });

      expect(await listSlugs(s)).toEqual(['second', 'first']);
      expect(s.db.spies.movie.findMany).toHaveBeenCalledTimes(2);
    });
  });

  describe('filters', () => {
    const catalogue = () => [
      testMovie({ slug: 'now', title: 'Now', status: 'NOW_SHOWING' }),
      testMovie({ slug: 'soon', title: 'Soon', status: 'UPCOMING' }),
      testMovie({ slug: 'old', title: 'Old', status: 'ENDED' }),
      testMovie({ slug: 'hidden', title: 'Hidden', status: 'NOW_SHOWING', isActive: false }),
      deleted({ slug: 'gone', title: 'Gone', status: 'NOW_SHOWING' }),
      deleted({ slug: 'gone-hidden', title: 'Gone Hidden', status: 'UPCOMING', isActive: false }),
    ];

    // Expected slugs in alphabetical order (the response order is checked in "sorting").
    it.each<[string, Record<string, string>, string[]]>([
      ['none', {}, ['hidden', 'now', 'old', 'soon']],
      ['status=NOW_SHOWING', { status: 'NOW_SHOWING' }, ['hidden', 'now']],
      ['status=UPCOMING', { status: 'UPCOMING' }, ['soon']],
      ['status=ENDED', { status: 'ENDED' }, ['old']],
      ['isActive=true', { isActive: 'true' }, ['now', 'old', 'soon']],
      ['isActive=false', { isActive: 'false' }, ['hidden']],
      ['deleted=exclude', { deleted: 'exclude' }, ['hidden', 'now', 'old', 'soon']],
      [
        'deleted=include',
        { deleted: 'include' },
        ['gone', 'gone-hidden', 'hidden', 'now', 'old', 'soon'],
      ],
      ['deleted=only', { deleted: 'only' }, ['gone', 'gone-hidden']],
      ['status + isActive', { status: 'NOW_SHOWING', isActive: 'true' }, ['now']],
      [
        'status + isActive + deleted=include',
        { status: 'NOW_SHOWING', isActive: 'true', deleted: 'include' },
        ['gone', 'now'],
      ],
      ['isActive=false + deleted=only', { isActive: 'false', deleted: 'only' }, ['gone-hidden']],
      [
        'isActive=false + deleted=include',
        { isActive: 'false', deleted: 'include' },
        ['gone-hidden', 'hidden'],
      ],
      ['status + deleted=only', { status: 'UPCOMING', deleted: 'only' }, ['gone-hidden']],
      ['a combination nothing matches', { status: 'ENDED', isActive: 'false' }, []],
    ])('%s', async (_name, query, expected) => {
      const s = await setup({ movies: catalogue() });

      const page = expectPage(await listMovies(s, query));

      expect(slugsOf(page).sort()).toEqual(expected);
      expect(page.total).toBe(expected.length);
    });

    it('isActive=false returns only hidden movies, deleted=only only deleted ones', async () => {
      const s = await setup({ movies: catalogue() });

      const hidden = expectPage(await listMovies(s, { isActive: 'false', deleted: 'include' }));
      const gone = expectPage(await listMovies(s, { deleted: 'only' }));
      const kept = expectPage(await listMovies(s));

      expect(hidden.items).toHaveLength(2);
      expect(hidden.items.every((m) => !m.isActive)).toBe(true);
      expect(gone.items).toHaveLength(2);
      expect(gone.items.every((m) => m.deletedAt !== null)).toBe(true);
      expect(kept.items.every((m) => m.deletedAt === null)).toBe(true);
    });
  });

  describe('search', () => {
    const searchable = () => [
      testMovie({ slug: 'avatar-fire-and-ash', title: 'Avatar: Fire and Ash' }),
      testMovie({ slug: 'mission-x', title: 'Rogue Agent' }),
      testMovie({ slug: 'gajaman', title: 'Gajaman' }),
      deleted({ slug: 'avatar-old', title: 'Avatar (old cut)' }),
    ];

    it.each<[string, string, string[]]>([
      ['the title, in any case', 'aVaTaR', ['avatar-fire-and-ash']],
      ['the middle of the title', 'FIRE AND', ['avatar-fire-and-ash']],
      ['the slug only', 'MISSION-X', ['mission-x']],
      ['the title only', 'rogue', ['mission-x']],
      ['a term with surrounding whitespace (trimmed)', '  gajaman  ', ['gajaman']],
    ])('matches %s', async (_name, search, expected) => {
      const s = await setup({ movies: searchable() });

      const page = expectPage(await listMovies(s, { search }));

      expect(slugsOf(page)).toEqual(expected);
      expect(page.total).toBe(expected.length);
    });

    it('combines with the deleted filter', async () => {
      const s = await setup({ movies: searchable() });

      expect(await listSlugs(s, { search: 'avatar' })).toEqual(['avatar-fire-and-ash']);
      expect((await listSlugs(s, { search: 'avatar', deleted: 'include' })).sort()).toEqual([
        'avatar-fire-and-ash',
        'avatar-old',
      ]);
      expect(await listSlugs(s, { search: 'avatar', deleted: 'only' })).toEqual(['avatar-old']);
    });

    it('no match is an empty page with total 0', async () => {
      const s = await setup({ movies: searchable() });

      expect(expectPage(await listMovies(s, { search: 'zzz' }))).toEqual({
        items: [],
        page: 1,
        pageSize: 20,
        total: 0,
      });
    });

    it('a whitespace-only search is no search', async () => {
      const s = await setup({ movies: searchable() });

      expect(expectPage(await listMovies(s, { search: '   ' })).total).toBe(3);
    });

    const wildcards = () => [
      testMovie({ slug: 'fifty-percent-off', title: '50% Off' }),
      testMovie({ slug: 'five-hundred-days', title: '500 Days' }),
      testMovie({ slug: 'a-b', title: 'a_b' }),
      testMovie({ slug: 'axb', title: 'axb' }),
      testMovie({ slug: 'back-slash', title: 'back\\slash' }),
      testMovie({ slug: 'backslash', title: 'backslash' }),
    ];

    it('control: unescaped, these terms over-match (the fake reads LIKE like Postgres)', async () => {
      const db = inMemoryAuthDb({ movies: wildcards() });
      const titles = async (term: string) =>
        (
          await db.prisma.movie.findMany({
            where: { title: { contains: term, mode: 'insensitive' } },
            orderBy: [{ title: 'asc' }],
            select: { title: true },
          })
        ).map((m) => m.title);

      expect(await titles('50%')).toEqual(['50% Off', '500 Days']);
      expect(await titles('a_b')).toEqual(['a_b', 'axb']);
      // `\s` is a literal "s", so the title with a real backslash is missed...
      expect(await titles('back\\slash')).toEqual(['backslash']);
      // ...and a lone `\` escapes the closing `%`: the pattern `%\%` means "ends with a
      // percent sign", so it misses the backslash title too.
      expect(await titles('\\')).toEqual([]);
    });

    it.each<[string, string[]]>([
      ['50%', ['fifty-percent-off']],
      ['%', ['fifty-percent-off']],
      ['a_b', ['a-b']],
      ['_', ['a-b']],
      ['\\', ['back-slash']],
      ['back\\slash', ['back-slash']],
      ['50%_', []],
    ])('search %j matches only the literal text', async (search, expected) => {
      const s = await setup({ movies: wildcards() });

      const page = expectPage(await listMovies(s, { search }));

      expect(slugsOf(page)).toEqual(expected);
      expect(page.total).toBe(expected.length);
    });
  });

  describe('sorting', () => {
    /**
     * Created in this order, so ids ascend m1..m5. Each sort column has ties (and releaseDate
     * NULLs), so the order within a tie shows the id tie-breaker.
     */
    const sortable = (): [Movie, Movie, Movie, Movie, Movie] => [
      testMovie({
        slug: 'm1',
        title: 'Echo',
        createdAt: day(1),
        updatedAt: day(5),
        releaseDate: date('2026-03-01'),
      }),
      testMovie({ slug: 'm2', title: 'Alpha', createdAt: day(2), updatedAt: day(5) }),
      testMovie({
        slug: 'm3',
        title: 'Echo',
        createdAt: day(2),
        updatedAt: day(3),
        releaseDate: date('2026-03-01'),
      }),
      testMovie({
        slug: 'm4',
        title: 'Charlie',
        createdAt: day(4),
        updatedAt: day(1),
        releaseDate: date('2026-01-15'),
      }),
      testMovie({ slug: 'm5', title: 'Bravo', createdAt: day(3), updatedAt: day(3) }),
    ];

    it.each<[string, string, string[]]>([
      ['updatedAt', 'asc', ['m4', 'm3', 'm5', 'm1', 'm2']],
      ['updatedAt', 'desc', ['m2', 'm1', 'm5', 'm3', 'm4']],
      ['createdAt', 'asc', ['m1', 'm2', 'm3', 'm5', 'm4']],
      ['createdAt', 'desc', ['m4', 'm5', 'm3', 'm2', 'm1']],
      ['title', 'asc', ['m2', 'm5', 'm4', 'm1', 'm3']],
      ['title', 'desc', ['m3', 'm1', 'm4', 'm5', 'm2']],
      // Undated movies last in both directions.
      ['releaseDate', 'asc', ['m4', 'm1', 'm3', 'm2', 'm5']],
      ['releaseDate', 'desc', ['m3', 'm1', 'm4', 'm5', 'm2']],
    ])('sort=%s order=%s, ties by id in the same direction', async (sort, order, expected) => {
      const [m1, m2, m3, m4, m5] = sortable();
      // Table order must not matter: once in id order, once shuffled.
      for (const movies of [
        [m1, m2, m3, m4, m5],
        [m5, m3, m1, m4, m2],
      ]) {
        const s = await setup({ movies });

        expect(await listSlugs(s, { sort, order })).toEqual(expected);
      }
    });

    it('defaults to updatedAt desc; order and sort each work alone', async () => {
      const s = await setup({ movies: sortable() });

      expect(await listSlugs(s)).toEqual(['m2', 'm1', 'm5', 'm3', 'm4']);
      expect(await listSlugs(s, { order: 'asc' })).toEqual(['m4', 'm3', 'm5', 'm1', 'm2']);
      expect(await listSlugs(s, { sort: 'title' })).toEqual(['m3', 'm1', 'm4', 'm5', 'm2']);
    });

    it('queries with the escaped term, the id tie-breaker and the page window', async () => {
      const s = await setup();

      expectPage(
        await listMovies(s, {
          search: '50%_\\',
          status: 'ENDED',
          sort: 'title',
          order: 'asc',
          page: '3',
          pageSize: '7',
        }),
      );

      const where = {
        status: 'ENDED',
        deletedAt: null,
        OR: [
          { title: { contains: '50\\%\\_\\\\', mode: 'insensitive' } },
          { slug: { contains: '50\\%\\_\\\\', mode: 'insensitive' } },
        ],
      };
      expect(s.db.spies.movie.findMany).toHaveBeenCalledExactlyOnceWith({
        where,
        orderBy: [{ title: 'asc' }, { id: 'asc' }],
        skip: 14,
        take: 7,
        select: adminMovieSelect,
      });
      expect(s.db.spies.movie.count).toHaveBeenCalledExactlyOnceWith({ where });
    });

    it('releaseDate asks for NULLs last explicitly (Postgres puts them first for desc)', async () => {
      const s = await setup();

      expectPage(await listMovies(s, { sort: 'releaseDate', order: 'desc' }));

      expect(s.db.spies.movie.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ releaseDate: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
        }),
      );
    });
  });

  describe('paging', () => {
    const titleOrder = { sort: 'title', order: 'asc' };
    const fiveMovies = () => [
      testMovie({ slug: 'm1', title: 'Echo' }),
      testMovie({ slug: 'm2', title: 'Alpha' }),
      testMovie({ slug: 'm3', title: 'Echo' }),
      testMovie({ slug: 'm4', title: 'Charlie' }),
      testMovie({ slug: 'm5', title: 'Bravo' }),
    ];

    it('walks pages of 2 with no gap or overlap; past the end is empty with the total', async () => {
      const s = await setup({ movies: fiveMovies() });
      const pageOf = async (page: number) =>
        expectPage(await listMovies(s, { ...titleOrder, page: String(page), pageSize: '2' }));

      expect(await pageOf(1)).toMatchObject({ page: 1, pageSize: 2, total: 5 });
      expect(slugsOf(await pageOf(1))).toEqual(['m2', 'm5']);
      expect(slugsOf(await pageOf(2))).toEqual(['m4', 'm1']);
      expect(slugsOf(await pageOf(3))).toEqual(['m3']);
      expect(await pageOf(4)).toEqual({ items: [], page: 4, pageSize: 2, total: 5 });
      expect(await pageOf(999_999)).toEqual({ items: [], page: 999_999, pageSize: 2, total: 5 });
    });

    it('pageSize=1 returns one movie per page', async () => {
      const s = await setup({ movies: fiveMovies() });

      const page = expectPage(await listMovies(s, { ...titleOrder, page: '3', pageSize: '1' }));

      expect(page).toMatchObject({ page: 3, pageSize: 1, total: 5 });
      expect(slugsOf(page)).toEqual(['m4']);
    });

    it('pageSize=100 returns 100 movies, then the rest', async () => {
      const movies = Array.from({ length: 105 }, (_, i) =>
        testMovie({ slug: `movie-${String(i + 1).padStart(3, '0')}`, title: 'Same Title' }),
      );
      const s = await setup({ movies });

      const first = expectPage(await listMovies(s, { pageSize: '100', order: 'asc' }));
      const second = expectPage(await listMovies(s, { pageSize: '100', order: 'asc', page: '2' }));

      expect(first).toMatchObject({ page: 1, pageSize: 100, total: 105 });
      expect(first.items).toHaveLength(100);
      expect(second).toMatchObject({ page: 2, pageSize: 100, total: 105 });
      // Equal updatedAt everywhere: only the id tie-breaker orders them, without gaps.
      expect([...slugsOf(first), ...slugsOf(second)]).toEqual(movies.map((m) => m.slug));
    });

    it('a page past the end of a filtered list keeps the filtered total', async () => {
      const s = await setup({
        movies: [...fiveMovies(), deleted({ slug: 'gone', title: 'Gone' })],
      });

      expect(expectPage(await listMovies(s, { deleted: 'only', page: '2' }))).toEqual({
        items: [],
        page: 2,
        pageSize: 20,
        total: 1,
      });
    });
  });

  describe('validation (400)', () => {
    it.each<[string, string, (string | number)[]]>([
      ['pageSize=101', 'pageSize=101', ['query', 'pageSize']],
      ['pageSize=0', 'pageSize=0', ['query', 'pageSize']],
      ['page=0', 'page=0', ['query', 'page']],
      ['page=-1', 'page=-1', ['query', 'page']],
      ['page=1.5', 'page=1.5', ['query', 'page']],
      ['page=1e3', 'page=1e3', ['query', 'page']],
      ['page=1000000', 'page=1000000', ['query', 'page']],
      ['an empty page', 'page=', ['query', 'page']],
      ['a repeated page', 'page=1&page=2', ['query', 'page']],
      ['isActive=maybe', 'isActive=maybe', ['query', 'isActive']],
      ['isActive=TRUE', 'isActive=TRUE', ['query', 'isActive']],
      ['isActive=1', 'isActive=1', ['query', 'isActive']],
      ['status=DRAFT', 'status=DRAFT', ['query', 'status']],
      ['deleted=yes', 'deleted=yes', ['query', 'deleted']],
      ['sort=id', 'sort=id', ['query', 'sort']],
      ['sort=slug', 'sort=slug', ['query', 'sort']],
      ['order=up', 'order=up', ['query', 'order']],
      ['a search over 100 characters', `search=${'a'.repeat(101)}`, ['query', 'search']],
      ['an unknown key', 'include=deleted', ['query']],
      ['bracket syntax', 'search[]=avatar', ['query']],
    ])('rejects %s', async (_name, query, path) => {
      const s = await setup({ movies: [testMovie()] });

      const error = expectError(await listMovies(s, query), 400, 'VALIDATION_ERROR');

      expect(error.message).toBe('Invalid request');
      expect(error.details).toEqual([expect.objectContaining({ path })]);
      expect(s.db.spies.movie.findMany).not.toHaveBeenCalled();
      expect(s.db.spies.movie.count).not.toHaveBeenCalled();
    });
  });

  describe('auth', () => {
    it('answers 401 without a session', async () => {
      const s = await setup({ movies: [testMovie()] });

      const res = await request(s.app).get(`${ADMIN_BASE}/movies`);

      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED_BODY);
      expect(s.db.spies.movie.findMany).not.toHaveBeenCalled();
      expect(s.db.spies.movie.count).not.toHaveBeenCalled();
    });

    it('answers 401 for an invalid session cookie, even with a bad query', async () => {
      const s = await setup({ movies: [testMovie()] });

      const res = await s.client.get('/movies?page=0', [`${s.session.access}x`]);

      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED_BODY);
    });

    it.each<AdminRole>(['EDITOR', 'SUPER_ADMIN'])(
      'serves a %s without a CSRF token, and writes no audit row',
      async (role) => {
        const s = await setup({ role, movies: [testMovie()] });

        // client.get sends neither the CSRF header nor an Origin.
        expect(expectPage(await listMovies(s)).total).toBe(1);
        expect(movieAudits(s.db)).toEqual([]);
        expect(s.db.spies.auditLog.create).not.toHaveBeenCalled();
        expect(s.db.spies.$transaction).not.toHaveBeenCalled();
      },
    );
  });

  describe('failures', () => {
    it.each(['findMany', 'count'] as const)(
      'answers a generic 500 when movie.%s fails',
      async (operation) => {
        const s = await setup({ movies: [testMovie()] });
        s.db.injectFault('movie', operation, {
          error: new Error('connect ECONNREFUSED 10.0.0.1'),
        });

        const res = await listMovies(s);

        expect(res.status).toBe(500);
        expect(res.body).toEqual(INTERNAL_BODY);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/movies/:id, /:id/status, /:id/active
// ---------------------------------------------------------------------------

/**
 * A browser-like PATCH, POST or DELETE to /movies/{path} with the session (by default), CSRF
 * cookie and token, and Origin: the same request authClient.post sends, as the auth client only
 * has post and get.
 */
function sendMovie(
  s: Setup,
  method: 'patch' | 'post' | 'delete',
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
    [method](`${ADMIN_BASE}/movies/${path}`)
    .set('User-Agent', TEST_USER_AGENT);
  if (all.length > 0) req = req.set('Cookie', all.join('; '));
  if (origin !== null) req = req.set('Origin', origin);
  if (token !== null) req = req.set(CSRF_HEADER, token);
  if (body === undefined) return req;
  return typeof body === 'string'
    ? req.set('Content-Type', 'application/json').send(body)
    : req.send(body);
}

const patchMovie = (s: Setup, path: string, options: SendOptions = {}) =>
  sendMovie(s, 'patch', path, options);

const patchDetails = (s: Setup, id: string, body: object | string) => patchMovie(s, id, { body });
const patchStatus = (s: Setup, id: string, body: object | string) =>
  patchMovie(s, `${id}/status`, { body });
const patchActive = (s: Setup, id: string, body: object | string) =>
  patchMovie(s, `${id}/active`, { body });

/** 200, no-store, and a body the strict shared response schema accepts. */
function expectOk(res: request.Response): AdminMovie {
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  return adminMovieResponseSchema.parse(res.body).movie;
}

/** A visitor's request (no cookies) to the public movie API. */
const publicGet = (s: Setup, path: string) => request(s.app).get(`/api/movies${path}`);

const publicSlugs = async (s: Setup, query = '') => {
  const res = await publicGet(s, query);
  expect(res.status).toBe(200);
  return publicMovieListResponseSchema.parse(res.body).movies.map((m) => m.slug);
};

/** The live row (a copy, so later writes do not change it). */
const storedMovie = (s: Setup, id: string): Movie => {
  const row = s.db.movies.find((m) => m.id === id);
  if (!row) throw new Error(`no movie ${id}`);
  return structuredClone(row);
};

const SEEDED_AT = '2026-01-01T00:00:00.000Z';

/** An UPCOMING, active movie with every editable field filled in. */
const avatar = (overrides: Partial<Movie> = {}) =>
  testMovie({
    slug: 'avatar',
    title: 'Avatar',
    synopsis: 'Pandora.',
    durationMinutes: 162,
    language: 'English',
    genres: ['Sci-Fi', 'Adventure'],
    rating: 'PG-13',
    director: 'James Cameron',
    cast: ['Sam Worthington', 'Zoe Saldaña'],
    releaseDate: new Date('2026-11-01T00:00:00.000Z'),
    trailerUrl: 'https://youtu.be/dQw4w9WgXcQ',
    ...overrides,
  });

interface PatchEndpoint {
  name: string;
  path: (id: string) => string;
  /** A body that changes avatar(). */
  change: object;
  /** A body equal to what avatar() already has. */
  noop: object;
}

const PATCH_ENDPOINTS: PatchEndpoint[] = [
  {
    name: 'PATCH /api/admin/movies/:id',
    path: (id) => id,
    change: { title: 'Avatar 2' },
    noop: { title: 'Avatar' },
  },
  {
    name: 'PATCH /api/admin/movies/:id/status',
    path: (id) => `${id}/status`,
    change: { status: 'NOW_SHOWING' },
    noop: { status: 'UPCOMING' },
  },
  {
    name: 'PATCH /api/admin/movies/:id/active',
    path: (id) => `${id}/active`,
    change: { isActive: false },
    noop: { isActive: true },
  },
];

describe.each(PATCH_ENDPOINTS)('$name: shared behaviour', ({ path, change, noop }) => {
  const send = (s: Setup, id: string, options: SendOptions = {}) =>
    patchMovie(s, path(id), options);

  it.each<AdminRole>(['EDITOR', 'SUPER_ADMIN'])(
    'a %s makes a change: one audit row, then the public cache is dropped',
    async (role) => {
      const seeded = avatar();
      const s = await setup({ role, movies: [seeded] });
      const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

      const movie = expectOk(await send(s, seeded.id, { body: change }));

      expect(movie.id).toBe(seeded.id);
      expect(movie.updatedAt > SEEDED_AT).toBe(true);
      expect(s.db.spies.movie.update).toHaveBeenCalledTimes(1);
      const audits = movieAudits(s.db);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        adminId: s.adminId,
        entity: 'Movie',
        entityId: seeded.id,
        userAgent: TEST_USER_AGENT,
      });
      expect(audits[0]?.ipAddress).toEqual(expect.any(String));
      expect(invalidate).toHaveBeenCalledExactlyOnceWith(PUBLIC_MOVIES_CACHE_PREFIX);
      const auditOrder = s.db.spies.auditLog.create.mock.invocationCallOrder.at(-1) ?? Infinity;
      expect(invalidate.mock.invocationCallOrder[0]).toBeGreaterThan(auditOrder);
    },
  );

  it('a no-op answers 200 with the movie: no update, no audit, the public cache kept', async () => {
    const seeded = avatar();
    const s = await setup({ movies: [seeded] });
    const before = adminMovieResponseSchema.parse((await getMovie(s, seeded.id)).body).movie;
    expect(await publicSlugs(s)).toEqual(['avatar']);
    const listLoads = s.db.spies.movie.findMany.mock.calls.length;
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    const movie = expectOk(await send(s, seeded.id, { body: noop }));

    expect(movie).toEqual(before);
    expect(movie.updatedAt).toBe(SEEDED_AT);
    expect(s.db.spies.movie.update).not.toHaveBeenCalled();
    expect(s.db.spies.auditLog.create).not.toHaveBeenCalled();
    expect(movieAudits(s.db)).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
    // Still served from the cache: no new list query.
    expect(await publicSlugs(s)).toEqual(['avatar']);
    expect(s.db.spies.movie.findMany).toHaveBeenCalledTimes(listLoads);
    expect(storedMovie(s, seeded.id)).toEqual(seeded);
  });

  it('answers 401 without a session, before reading anything', async () => {
    const seeded = avatar();
    const s = await setup({ movies: [seeded] });

    const res = await send(s, seeded.id, { body: change, cookies: [] });

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    expect(storedMovie(s, seeded.id)).toEqual(seeded);
  });

  it('answers 401 for an invalid session cookie, even with a bad body', async () => {
    const seeded = avatar();
    const s = await setup({ movies: [seeded] });

    const res = await send(s, seeded.id, { body: {}, cookies: [`${s.session.access}x`] });

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
    const seeded = avatar();
    const s = await setup({ movies: [seeded] });

    const res = await send(s, seeded.id, { body: change, ...overrides });

    expect(res.status).toBe(403);
    expect(res.body).toEqual(CSRF_BODY);
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    expect(movieAudits(s.db)).toEqual([]);
  });

  it.each([
    ['a change', change],
    ['a no-op', noop],
  ])('answers 404 for an unknown id (%s)', async (_name, body) => {
    const s = await setup({ movies: [avatar()] });

    const error = expectError(await send(s, randomUUID(), { body }), 404, 'NOT_FOUND');

    expect(error.message).toBe(MOVIE_NOT_FOUND_MESSAGE);
    expect(s.db.spies.movie.update).not.toHaveBeenCalled();
    expect(movieAudits(s.db)).toEqual([]);
  });

  it.each([
    ['a change', change],
    ['a no-op', noop],
  ])('answers 409 for a soft-deleted movie (%s), changing nothing', async (_name, body) => {
    const gone = avatar({ deletedAt: new Date('2026-10-01T00:00:00.000Z') });
    const s = await setup({ movies: [gone] });
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    const error = expectError(await send(s, gone.id, { body }), 409, 'CONFLICT');

    expect(error.message).toBe(MOVIE_RESTORE_FIRST_MESSAGE);
    expect(s.db.spies.movie.update).not.toHaveBeenCalled();
    expect(movieAudits(s.db)).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
    expect(storedMovie(s, gone.id)).toEqual(gone);
  });

  it.each(['not-a-uuid', '123', 'avatar'])('answers 400 for the id %s', async (id) => {
    const s = await setup({ movies: [avatar()] });

    const error = expectError(await send(s, id, { body: change }), 400, 'VALIDATION_ERROR');

    expect(error.details).toEqual([expect.objectContaining({ path: ['params', 'id'] })]);
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
  });

  it('answers 400 for query parameters', async () => {
    const seeded = avatar();
    const s = await setup({ movies: [seeded] });

    const error = expectError(
      await patchMovie(s, `${path(seeded.id)}?force=1`, { body: change }),
      400,
      'VALIDATION_ERROR',
    );

    expect(error.details).toEqual([expect.objectContaining({ path: ['query'] })]);
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    expect(movieAudits(s.db)).toEqual([]);
  });

  it.each<[string, object | string | undefined]>([
    ['an empty body', {}],
    ['no body', undefined],
    ['an unknown key', { ...change, foo: 1 }],
    ['a JSON array', '[]'],
    ['posterUrl', { ...change, posterUrl: 'https://res.cloudinary.com/x/image/upload/p.jpg' }],
    ['bannerPublicId', { ...change, bannerPublicId: 'sk/banners/x' }],
    ['deletedAt', { ...change, deletedAt: null }],
  ])('answers 400 for %s, writing nothing', async (_name, body) => {
    const seeded = avatar();
    const s = await setup({ movies: [seeded] });

    const res = await send(s, seeded.id, body === undefined ? {} : { body });

    expectError(res, 400, 'VALIDATION_ERROR');

    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    expect(movieAudits(s.db)).toEqual([]);
    expect(storedMovie(s, seeded.id)).toEqual(seeded);
  });

  it('rolls the change back and answers a generic 500 when the audit write fails', async () => {
    const seeded = avatar();
    const s = await setup({ movies: [seeded] });
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');
    s.db.injectFault('auditLog', 'create', {
      error: new Error('relation "AuditLog" does not exist'),
    });

    const res = await send(s, seeded.id, { body: change });

    expect(res.status).toBe(500);
    expect(res.body).toEqual(INTERNAL_BODY);
    // The update ran inside the transaction and was undone.
    expect(s.db.spies.movie.update).toHaveBeenCalledTimes(1);
    expect(storedMovie(s, seeded.id)).toEqual(seeded);
    expect(movieAudits(s.db)).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('answers 409 when the movie is soft-deleted between the read and the update', async () => {
    const seeded = avatar();
    const s = await setup({ movies: [seeded] });
    s.db.injectFault('movie', 'update', {
      before: () => {
        const row = s.db.movies.find((m) => m.id === seeded.id);
        if (row) row.deletedAt = new Date('2026-10-31T00:00:00.000Z');
      },
    });

    const error = expectError(await send(s, seeded.id, { body: change }), 409, 'CONFLICT');

    expect(error.message).toBe(MOVIE_RESTORE_FIRST_MESSAGE);
    expect(movieAudits(s.db)).toEqual([]);
  });

  it('answers 404 when the movie is hard-deleted between the read and the update', async () => {
    const seeded = avatar();
    const s = await setup({ movies: [seeded] });
    s.db.injectFault('movie', 'update', {
      before: () => {
        s.db.movies.splice(
          s.db.movies.findIndex((m) => m.id === seeded.id),
          1,
        );
      },
    });

    const error = expectError(await send(s, seeded.id, { body: change }), 404, 'NOT_FOUND');

    expect(error.message).toBe(MOVIE_NOT_FOUND_MESSAGE);
    expect(movieAudits(s.db)).toEqual([]);
  });
});

describe('PATCH /api/admin/movies/:id (details)', () => {
  it('changes several fields, audits only the changed ones and keeps the slug', async () => {
    const seeded = avatar();
    const s = await setup({ movies: [seeded] });

    const movie = expectOk(
      await patchDetails(s, seeded.id, {
        title: '  Avatar: The Way of Water  ',
        synopsis: null,
        durationMinutes: 192,
        language: 'English', // unchanged
        genres: ['Sci-Fi', 'Action', 'action'],
        rating: 'PG-13', // unchanged
        director: null,
        cast: ['Sam Worthington'],
        releaseDate: '2026-12-16',
      }),
    );

    expect(movie).toEqual({
      ...adminMovieResponseSchema.parse((await getMovie(s, seeded.id)).body).movie,
      id: seeded.id,
      slug: 'avatar',
      title: 'Avatar: The Way of Water',
      synopsis: null,
      durationMinutes: 192,
      language: 'English',
      genres: ['Sci-Fi', 'Action'],
      rating: 'PG-13',
      director: null,
      cast: ['Sam Worthington'],
      releaseDate: '2026-12-16',
      trailerUrl: 'https://youtu.be/dQw4w9WgXcQ',
      status: 'UPCOMING',
      isActive: true,
      deletedAt: null,
      createdAt: SEEDED_AT,
    });
    expect(movie.updatedAt > SEEDED_AT).toBe(true);

    // Only the changed columns are written; the date as UTC midnight (a DATE column).
    expect(s.db.spies.movie.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: seeded.id, deletedAt: null },
      data: {
        title: 'Avatar: The Way of Water',
        synopsis: null,
        durationMinutes: 192,
        genres: ['Sci-Fi', 'Action'],
        director: null,
        cast: ['Sam Worthington'],
        releaseDate: new Date('2026-12-16T00:00:00.000Z'),
      },
      select: adminMovieSelect,
    });
    expect(storedMovie(s, seeded.id).releaseDate?.toISOString()).toBe('2026-12-16T00:00:00.000Z');

    const audits = movieAudits(s.db);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'UPDATE', entityId: seeded.id });
    expect(audits[0]?.details).toEqual({
      changes: {
        title: { from: 'Avatar', to: 'Avatar: The Way of Water' },
        synopsis: { from: 'Pandora.', to: null },
        durationMinutes: { from: 162, to: 192 },
        genres: { from: ['Sci-Fi', 'Adventure'], to: ['Sci-Fi', 'Action'] },
        director: { from: 'James Cameron', to: null },
        cast: { from: ['Sam Worthington', 'Zoe Saldaña'], to: ['Sam Worthington'] },
        releaseDate: { from: '2026-11-01', to: '2026-12-16' },
      },
    });
  });

  it('fills fields that were empty, auditing from null', async () => {
    const seeded = testMovie({ slug: 'bare', title: 'Bare' });
    const s = await setup({ movies: [seeded] });

    expectOk(
      await patchDetails(s, seeded.id, {
        language: 'Sinhala',
        releaseDate: '2026-11-07',
        trailerUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      }),
    );

    expect(movieAudits(s.db)[0]?.details).toEqual({
      changes: {
        language: { from: null, to: 'Sinhala' },
        releaseDate: { from: null, to: '2026-11-07' },
        trailerUrl: { from: null, to: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      },
    });
  });

  it('a title change keeps the slug, and the public detail shows the new title', async () => {
    const seeded = avatar();
    const s = await setup({ movies: [seeded] });
    expect((await publicGet(s, '/avatar')).status).toBe(200); // cached now

    const movie = expectOk(await patchDetails(s, seeded.id, { title: 'Avatar Remastered' }));

    expect(movie.slug).toBe('avatar');
    const detail = await publicGet(s, '/avatar');
    expect(detail.status).toBe(200);
    expect(publicMovieResponseSchema.parse(detail.body).movie.title).toBe('Avatar Remastered');
    expect(s.db.spies.movie.update.mock.calls[0]?.[0].data).toEqual({ title: 'Avatar Remastered' });
  });

  it('an explicit slug changes it: the old public slug is gone, the new one served', async () => {
    const seeded = avatar();
    const s = await setup({ movies: [seeded] });
    expect((await publicGet(s, '/avatar')).status).toBe(200); // cached now

    const movie = expectOk(await patchDetails(s, seeded.id, { slug: 'avatar-2009' }));

    expect(movie).toMatchObject({ slug: 'avatar-2009', title: 'Avatar' });
    expect(movieAudits(s.db)[0]?.details).toEqual({
      changes: { slug: { from: 'avatar', to: 'avatar-2009' } },
    });
    expect((await publicGet(s, '/avatar')).status).toBe(404);
    expect((await publicGet(s, '/avatar-2009')).status).toBe(200);
  });

  it('the current slug is not a change: no slug lookup, only the other fields written', async () => {
    const seeded = avatar();
    const s = await setup({ movies: [seeded] });

    expectOk(await patchDetails(s, seeded.id, { slug: 'avatar', title: 'Avatar (2009)' }));

    // Only the read of the movie itself.
    expect(s.db.spies.movie.findUnique).toHaveBeenCalledTimes(1);
    expect(s.db.spies.movie.update.mock.calls[0]?.[0].data).toEqual({ title: 'Avatar (2009)' });
    expect(movieAudits(s.db)[0]?.details).toEqual({
      changes: { title: { from: 'Avatar', to: 'Avatar (2009)' } },
    });
  });

  it.each([
    ['an active movie', testMovie({ slug: 'taken', title: 'Taken' })],
    ['a soft-deleted movie', deleted({ slug: 'taken', title: 'Taken' })],
    ['a hidden movie', testMovie({ slug: 'taken', title: 'Taken', isActive: false })],
  ])('a slug held by %s is a 409 on body.slug, changing nothing', async (_name, holder) => {
    const seeded = avatar();
    const s = await setup({ movies: [seeded, holder] });

    const error = expectError(
      await patchDetails(s, seeded.id, { slug: 'taken', title: 'Renamed' }),
      409,
      'CONFLICT',
    );

    expect(error.message).toBe(SLUG_IN_USE_MESSAGE);
    expect(error.details).toEqual([{ path: ['body', 'slug'], message: SLUG_IN_USE_MESSAGE }]);
    expect(s.db.spies.movie.update).not.toHaveBeenCalled();
    expect(storedMovie(s, seeded.id)).toEqual(seeded);
    expect(movieAudits(s.db)).toEqual([]);
  });

  it('a P2002 from the update is a 409 (never a 500), changing nothing', async () => {
    const seeded = avatar();
    const s = await setup({ movies: [seeded] });
    s.db.injectFault('movie', 'update', { error: uniqueConstraintError('movie', 'slug') });

    const error = expectError(
      await patchDetails(s, seeded.id, { slug: 'avatar-2009' }),
      409,
      'CONFLICT',
    );

    expect(error.message).toBe(SLUG_IN_USE_MESSAGE);
    expect(s.db.spies.$transaction).toHaveBeenCalledTimes(1);
    expect(storedMovie(s, seeded.id)).toEqual(seeded);
    expect(movieAudits(s.db)).toEqual([]);
  });

  it('a slug taken by a concurrent insert after the check is a 409', async () => {
    const seeded = avatar();
    const s = await setup({ movies: [seeded] });
    s.db.injectFault('movie', 'update', {
      before: () => s.db.addMovie({ slug: 'avatar-2009', title: 'Racer', durationMinutes: 100 }),
    });

    expectError(await patchDetails(s, seeded.id, { slug: 'avatar-2009' }), 409, 'CONFLICT');

    expect(storedMovie(s, seeded.id).slug).toBe('avatar');
    expect(movieAudits(s.db)).toEqual([]);
  });

  it('a P2002 from the audit write is a generic 500, not a slug clash', async () => {
    const seeded = avatar();
    const s = await setup({ movies: [seeded] });
    s.db.injectFault('auditLog', 'create', { error: uniqueConstraintError('auditLog', 'id') });

    const res = await patchDetails(s, seeded.id, { slug: 'avatar-2009' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual(INTERNAL_BODY);
    expect(storedMovie(s, seeded.id)).toEqual(seeded);
    expect(movieAudits(s.db)).toEqual([]);
  });

  describe('no-op detection', () => {
    it('every field equal to the stored value (lists, the date, nulls) is a no-op', async () => {
      const seeded = avatar({ rating: null });
      const s = await setup({ movies: [seeded] });

      const movie = expectOk(
        await patchDetails(s, seeded.id, {
          title: '  Avatar ',
          slug: 'avatar',
          synopsis: 'Pandora.',
          durationMinutes: 162,
          language: 'English',
          genres: ['Sci-Fi', 'Adventure', 'sci-fi'], // the duplicate is dropped by the schema
          rating: null,
          director: 'James Cameron',
          cast: ['Sam Worthington', 'Zoe Saldaña'],
          releaseDate: '2026-11-01',
          trailerUrl: 'https://youtu.be/dQw4w9WgXcQ',
        }),
      );

      expect(movie.updatedAt).toBe(SEEDED_AT);
      expect(s.db.spies.movie.update).not.toHaveBeenCalled();
      expect(movieAudits(s.db)).toEqual([]);
    });

    it.each<[string, object]>([
      ['reordered genres', { genres: ['Adventure', 'Sci-Fi'] }],
      ['a re-cased genre', { genres: ['sci-fi', 'Adventure'] }],
      ['one cast member fewer', { cast: ['Sam Worthington'] }],
      ['an empty list', { genres: [] }],
      ['the next day', { releaseDate: '2026-11-02' }],
      ['a cleared date', { releaseDate: null }],
    ])('%s is a change', async (_name, body) => {
      const seeded = avatar();
      const s = await setup({ movies: [seeded] });

      expectOk(await patchDetails(s, seeded.id, body));

      expect(s.db.spies.movie.update).toHaveBeenCalledTimes(1);
      expect(Object.keys(movieAudits(s.db)[0]?.details as object)).toEqual(['changes']);
      expect(movieAudits(s.db)).toHaveLength(1);
    });
  });

  describe('validation (400, nothing written)', () => {
    it.each<[string, object]>([
      ['null title', { title: null }],
      ['null slug', { slug: null }],
      ['null durationMinutes', { durationMinutes: null }],
      ['null genres', { genres: null }],
      ['null cast', { cast: null }],
      ["'' synopsis", { synopsis: '' }],
      ["'' language", { language: '' }],
      ['whitespace-only title', { title: '   ' }],
      ['a malformed slug', { slug: 'Not A Slug' }],
      ['an impossible date', { releaseDate: '2026-02-30' }],
      ['a non-YouTube trailer', { trailerUrl: 'https://evil.example/watch?v=dQw4w9WgXcQ' }],
      ['a zero duration', { durationMinutes: 0 }],
      ['status (its own endpoint)', { title: 'X', status: 'ENDED' }],
      ['isActive (its own endpoint)', { title: 'X', isActive: false }],
      ['posterPublicId', { posterPublicId: 'sk/posters/x' }],
      ['bannerUrl', { bannerUrl: 'https://res.cloudinary.com/x/image/upload/b.jpg' }],
    ])('rejects %s', async (_name, body) => {
      const seeded = avatar();
      const s = await setup({ movies: [seeded] });

      expectError(await patchDetails(s, seeded.id, body), 400, 'VALIDATION_ERROR');

      expect(s.db.spies.$transaction).not.toHaveBeenCalled();
      expect(movieAudits(s.db)).toEqual([]);
      expect(storedMovie(s, seeded.id)).toEqual(seeded);
    });
  });
});

describe('PATCH /api/admin/movies/:id/status', () => {
  it.each<[Movie['status'], Movie['status']]>([
    ['UPCOMING', 'NOW_SHOWING'],
    ['UPCOMING', 'ENDED'],
    ['NOW_SHOWING', 'ENDED'],
    ['NOW_SHOWING', 'UPCOMING'],
    ['ENDED', 'NOW_SHOWING'],
    ['ENDED', 'UPCOMING'],
  ])('%s -> %s is written and audited as a STATUS_CHANGE', async (from, to) => {
    const seeded = avatar({ status: from });
    const s = await setup({ movies: [seeded] });

    const movie = expectOk(await patchStatus(s, seeded.id, { status: to }));

    expect(movie.status).toBe(to);
    expect(storedMovie(s, seeded.id).status).toBe(to);
    expect(s.db.spies.movie.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: seeded.id, deletedAt: null },
      data: { status: to },
      select: adminMovieSelect,
    });
    const audits = movieAudits(s.db);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'STATUS_CHANGE',
      entityId: seeded.id,
      details: { field: 'status', from, to },
    });
  });

  it('UPCOMING -> NOW_SHOWING moves the movie between cached public lists at once', async () => {
    const seeded = avatar({ status: 'UPCOMING' });
    const s = await setup({ movies: [seeded] });
    expect(await publicSlugs(s, '?status=NOW_SHOWING')).toEqual([]);
    expect(await publicSlugs(s, '?status=UPCOMING')).toEqual(['avatar']);
    expect(await publicSlugs(s, '?status=NOW_SHOWING')).toEqual([]); // from the cache

    expectOk(await patchStatus(s, seeded.id, { status: 'NOW_SHOWING' }));

    expect(await publicSlugs(s, '?status=NOW_SHOWING')).toEqual(['avatar']);
    expect(await publicSlugs(s, '?status=UPCOMING')).toEqual([]);
  });

  it('NOW_SHOWING -> ENDED drops it from the default public list; its page stays', async () => {
    const seeded = avatar({ status: 'NOW_SHOWING' });
    const s = await setup({ movies: [seeded] });
    expect(await publicSlugs(s)).toEqual(['avatar']);
    expect((await publicGet(s, '/avatar')).status).toBe(200);

    expectOk(await patchStatus(s, seeded.id, { status: 'ENDED' }));

    expect(await publicSlugs(s)).toEqual([]);
    const detail = await publicGet(s, '/avatar');
    expect(detail.status).toBe(200);
    expect(publicMovieResponseSchema.parse(detail.body).movie.status).toBe('ENDED');
  });

  it.each<[string, object]>([
    ['status=DRAFT', { status: 'DRAFT' }],
    ['a lower-case status', { status: 'ended' }],
    ['null', { status: null }],
    ['another field too', { status: 'ENDED', title: 'X' }],
    ['isActive instead', { isActive: false }],
  ])('rejects %s (400, nothing written)', async (_name, body) => {
    const seeded = avatar();
    const s = await setup({ movies: [seeded] });

    const error = expectError(await patchStatus(s, seeded.id, body), 400, 'VALIDATION_ERROR');

    const where = (error.details as { path: (string | number)[] }[]).map((d) => d.path[0]);
    expect(where.length).toBeGreaterThan(0);
    expect(new Set(where)).toEqual(new Set(['body']));
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    expect(movieAudits(s.db)).toEqual([]);
  });
});

describe('PATCH /api/admin/movies/:id/active', () => {
  it('hiding a cached movie removes it from the list and its page; showing brings it back', async () => {
    const seeded = avatar({ status: 'NOW_SHOWING' });
    const s = await setup({ movies: [seeded] });
    expect(await publicSlugs(s)).toEqual(['avatar']);
    expect((await publicGet(s, '/avatar')).status).toBe(200);

    const hidden = expectOk(await patchActive(s, seeded.id, { isActive: false }));

    expect(hidden.isActive).toBe(false);
    expect(storedMovie(s, seeded.id).isActive).toBe(false);
    expect(await publicSlugs(s)).toEqual([]);
    expect(await publicSlugs(s, '?status=NOW_SHOWING')).toEqual([]);
    expect((await publicGet(s, '/avatar')).status).toBe(404);

    const shown = expectOk(await patchActive(s, seeded.id, { isActive: true }));

    expect(shown.isActive).toBe(true);
    expect(await publicSlugs(s)).toEqual(['avatar']);
    expect((await publicGet(s, '/avatar')).status).toBe(200);

    expect(movieAudits(s.db).map((row) => [row.action, row.details])).toEqual([
      ['STATUS_CHANGE', { field: 'isActive', from: true, to: false }],
      ['STATUS_CHANGE', { field: 'isActive', from: false, to: true }],
    ]);
    expect(s.db.spies.movie.update.mock.calls.map(([args]) => args.data)).toEqual([
      { isActive: false },
      { isActive: true },
    ]);
  });

  it('showing an already shown movie and hiding a hidden one are no-ops', async () => {
    const shown = avatar();
    const hidden = testMovie({ slug: 'hidden', title: 'Hidden', isActive: false });
    const s = await setup({ movies: [shown, hidden] });

    expect(expectOk(await patchActive(s, shown.id, { isActive: true })).isActive).toBe(true);
    expect(expectOk(await patchActive(s, hidden.id, { isActive: false })).isActive).toBe(false);

    expect(s.db.spies.movie.update).not.toHaveBeenCalled();
    expect(movieAudits(s.db)).toEqual([]);
  });

  it.each<[string, object]>([
    ['the string "false"', { isActive: 'false' }],
    ['the number 0', { isActive: 0 }],
    ['null', { isActive: null }],
    ['another field too', { isActive: false, status: 'ENDED' }],
    ['status instead', { status: 'ENDED' }],
  ])('rejects %s (400, nothing written)', async (_name, body) => {
    const seeded = avatar();
    const s = await setup({ movies: [seeded] });

    expectError(await patchActive(s, seeded.id, body), 400, 'VALIDATION_ERROR');

    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    expect(storedMovie(s, seeded.id)).toEqual(seeded);
    expect(movieAudits(s.db)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/movies/:id, POST /:id/restore, DELETE /:id/permanent
// ---------------------------------------------------------------------------

const FORBIDDEN_BODY = { error: { code: 'FORBIDDEN', message: FORBIDDEN_MESSAGE } };

const softDeletePath = (id: string) => id;
const restorePath = (id: string) => `${id}/restore`;
const hardDeletePath = (id: string) => `${id}/permanent`;

const softDelete = (s: Setup, id: string, options: SendOptions = {}) =>
  sendMovie(s, 'delete', softDeletePath(id), options);
const restore = (s: Setup, id: string, options: SendOptions = {}) =>
  sendMovie(s, 'post', restorePath(id), options);
const hardDelete = (s: Setup, id: string, options: SendOptions = {}) =>
  sendMovie(s, 'delete', hardDeletePath(id), options);

/** avatar() in the trash (soft-deleted). */
const trashedAvatar = (overrides: Partial<Movie> = {}) =>
  avatar({ deletedAt: new Date('2026-10-01T00:00:00.000Z'), ...overrides });

const isStored = (s: Setup, id: string) => s.db.movies.some((m) => m.id === id);

/** A 204 with no body, not cached. */
function expectNoContent(res: request.Response) {
  expect(res.status).toBe(204);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.text).toBe('');
  expect(res.headers['content-type']).toBeUndefined();
}

interface MoveEndpoint {
  name: string;
  method: 'post' | 'delete';
  /** The path below /movies/. */
  path: (id: string) => string;
  /** The role the shared tests sign in as (hard delete is SUPER_ADMIN only). */
  role: AdminRole;
  /** A movie the endpoint accepts. */
  movable: (overrides?: Partial<Movie>) => Movie;
  /** A movie the endpoint refuses with a 409 (`conflictMessage`). */
  misplaced: () => Movie;
  conflictMessage: string;
  /** The conditional write the endpoint makes. */
  write: 'update' | 'delete';
  /** What a concurrent request does to the row to make it misplaced. */
  misplace: (row: Movie) => void;
  /** The success response check. */
  expectSuccess: (res: request.Response) => void;
}

const MOVE_ENDPOINTS: MoveEndpoint[] = [
  {
    name: 'DELETE /api/admin/movies/:id',
    method: 'delete',
    path: softDeletePath,
    role: 'EDITOR',
    movable: avatar,
    misplaced: trashedAvatar,
    conflictMessage: MOVIE_ALREADY_DELETED_MESSAGE,
    write: 'update',
    misplace: (row) => {
      row.deletedAt = new Date('2026-10-31T00:00:00.000Z');
    },
    expectSuccess: (res) => {
      expect(expectOk(res).deletedAt).not.toBeNull();
    },
  },
  {
    name: 'POST /api/admin/movies/:id/restore',
    method: 'post',
    path: restorePath,
    role: 'EDITOR',
    movable: trashedAvatar,
    misplaced: avatar,
    conflictMessage: MOVIE_NOT_DELETED_MESSAGE,
    write: 'update',
    misplace: (row) => {
      row.deletedAt = null;
    },
    expectSuccess: (res) => {
      expect(expectOk(res).deletedAt).toBeNull();
    },
  },
  {
    name: 'DELETE /api/admin/movies/:id/permanent',
    method: 'delete',
    path: hardDeletePath,
    role: 'SUPER_ADMIN',
    movable: trashedAvatar,
    misplaced: avatar,
    conflictMessage: MOVIE_DELETE_FIRST_MESSAGE,
    write: 'delete',
    misplace: (row) => {
      row.deletedAt = null;
    },
    expectSuccess: expectNoContent,
  },
];

describe.each(MOVE_ENDPOINTS)(
  '$name: shared behaviour',
  ({ method, path, role, movable, misplaced, conflictMessage, write, misplace, expectSuccess }) => {
    const send = (s: Setup, id: string, options: SendOptions = {}) =>
      sendMovie(s, method, path(id), options);

    it('accepts no body and an empty JSON object as the body', async () => {
      const first = movable();
      const second = movable({ slug: 'avatar-2' });
      const s = await setup({ role, movies: [first, second] });

      expectSuccess(await send(s, first.id));
      expectSuccess(await send(s, second.id, { body: {} }));

      expect(s.db.spies.movie[write]).toHaveBeenCalledTimes(2);
      expect(movieAudits(s.db)).toHaveLength(2);
    });

    it('answers 401 without a session, before reading anything', async () => {
      const seeded = movable();
      const s = await setup({ role, movies: [seeded] });

      const res = await send(s, seeded.id, { cookies: [] });

      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED_BODY);
      expect(s.db.spies.$transaction).not.toHaveBeenCalled();
      expect(storedMovie(s, seeded.id)).toEqual(seeded);
    });

    it('answers 401 for an invalid session cookie, even with a bad body and id', async () => {
      const s = await setup({ role, movies: [movable()] });

      const res = await send(s, 'not-a-uuid', {
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
      const seeded = movable();
      const s = await setup({ role, movies: [seeded] });

      const res = await send(s, seeded.id, overrides);

      expect(res.status).toBe(403);
      expect(res.body).toEqual(CSRF_BODY);
      expect(s.db.spies.$transaction).not.toHaveBeenCalled();
      expect(storedMovie(s, seeded.id)).toEqual(seeded);
      expect(movieAudits(s.db)).toEqual([]);
    });

    it('answers 404 for an unknown id', async () => {
      const seeded = movable();
      const s = await setup({ role, movies: [seeded] });
      const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

      const error = expectError(await send(s, randomUUID()), 404, 'NOT_FOUND');

      expect(error.message).toBe(MOVIE_NOT_FOUND_MESSAGE);
      expect(s.db.spies.movie[write]).not.toHaveBeenCalled();
      expect(movieAudits(s.db)).toEqual([]);
      expect(invalidate).not.toHaveBeenCalled();
      expect(storedMovie(s, seeded.id)).toEqual(seeded);
    });

    it(`answers 409 "${conflictMessage}", changing nothing`, async () => {
      const seeded = misplaced();
      const s = await setup({ role, movies: [seeded] });
      const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

      const error = expectError(await send(s, seeded.id), 409, 'CONFLICT');

      expect(error.message).toBe(conflictMessage);
      expect(error.details).toBeUndefined();
      expect(s.db.spies.movie[write]).not.toHaveBeenCalled();
      expect(movieAudits(s.db)).toEqual([]);
      expect(invalidate).not.toHaveBeenCalled();
      expect(storedMovie(s, seeded.id)).toEqual(seeded);
    });

    it.each(['not-a-uuid', '123', 'avatar'])('answers 400 for the id %s', async (id) => {
      const s = await setup({ role, movies: [movable()] });

      const error = expectError(await send(s, id), 400, 'VALIDATION_ERROR');

      expect(error.details).toEqual([expect.objectContaining({ path: ['params', 'id'] })]);
      expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    });

    it('answers 400 for query parameters', async () => {
      const seeded = movable();
      const s = await setup({ role, movies: [seeded] });

      const res = await sendMovie(s, method, `${path(seeded.id)}?force=1`);

      const error = expectError(res, 400, 'VALIDATION_ERROR');

      expect(error.details).toEqual([expect.objectContaining({ path: ['query'] })]);
      expect(s.db.spies.$transaction).not.toHaveBeenCalled();
      expect(storedMovie(s, seeded.id)).toEqual(seeded);
    });

    it.each<[string, object | string]>([
      ['an unknown key', { foo: 1 }],
      ['deletedAt', { deletedAt: null }],
      ['a JSON array', '[]'],
    ])('answers 400 for a body with %s, writing nothing', async (_name, body) => {
      const seeded = movable();
      const s = await setup({ role, movies: [seeded] });

      const error = expectError(await send(s, seeded.id, { body }), 400, 'VALIDATION_ERROR');

      expect(error.details).toEqual([expect.objectContaining({ path: ['body'] })]);
      expect(s.db.spies.$transaction).not.toHaveBeenCalled();
      expect(storedMovie(s, seeded.id)).toEqual(seeded);
      expect(movieAudits(s.db)).toEqual([]);
    });

    it('rolls the write back and answers a generic 500 when the audit write fails', async () => {
      const seeded = movable();
      const s = await setup({ role, movies: [seeded] });
      const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');
      s.db.injectFault('auditLog', 'create', {
        error: new Error('relation "AuditLog" does not exist'),
      });

      const res = await send(s, seeded.id);

      expect(res.status).toBe(500);
      expect(res.body).toEqual(INTERNAL_BODY);
      // The write ran inside the transaction and was undone.
      expect(s.db.spies.movie[write]).toHaveBeenCalledTimes(1);
      expect(storedMovie(s, seeded.id)).toEqual(seeded);
      expect(movieAudits(s.db)).toEqual([]);
      expect(invalidate).not.toHaveBeenCalled();
    });

    it('answers a generic 500 when the database fails', async () => {
      const seeded = movable();
      const s = await setup({ role, movies: [seeded] });
      s.db.injectFault('movie', write, { error: new Error('connection reset') });

      const res = await send(s, seeded.id);

      expect(res.status).toBe(500);
      expect(res.body).toEqual(INTERNAL_BODY);
      expect(storedMovie(s, seeded.id)).toEqual(seeded);
      expect(movieAudits(s.db)).toEqual([]);
    });

    it('answers 409 when a concurrent request moves the movie before the write', async () => {
      const seeded = movable();
      const s = await setup({ role, movies: [seeded] });
      const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');
      s.db.injectFault('movie', write, {
        before: () => {
          const row = s.db.movies.find((m) => m.id === seeded.id);
          if (row) misplace(row);
        },
      });

      const error = expectError(await send(s, seeded.id), 409, 'CONFLICT');

      expect(error.message).toBe(conflictMessage);
      expect(isStored(s, seeded.id)).toBe(true);
      expect(movieAudits(s.db)).toEqual([]);
      expect(invalidate).not.toHaveBeenCalled();
    });

    it('answers 404 when a concurrent request hard-deletes the movie before the write', async () => {
      const seeded = movable();
      const s = await setup({ role, movies: [seeded] });
      s.db.injectFault('movie', write, {
        before: () => {
          s.db.movies.splice(
            s.db.movies.findIndex((m) => m.id === seeded.id),
            1,
          );
        },
      });

      const error = expectError(await send(s, seeded.id), 404, 'NOT_FOUND');

      expect(error.message).toBe(MOVIE_NOT_FOUND_MESSAGE);
      expect(movieAudits(s.db)).toEqual([]);
    });
  },
);

/** When the other admins put a trashed movie back in the trash (see RACE_ENDPOINTS). */
const TRASHED_AGAIN_AT = new Date('2026-10-31T12:00:00.000Z');

interface RaceEndpoint {
  name: string;
  role: AdminRole;
  /** A request the endpoint accepts for `seed()`. */
  send: (s: Setup, id: string) => request.Test;
  seed: () => Movie;
  /** The conditional write the endpoint makes. */
  write: 'update' | 'delete';
  /** What other admins do between our read and our write: move the movie away from `seed()`. */
  away: (row: Movie) => void;
}

const RACE_ENDPOINTS: RaceEndpoint[] = [
  ...PATCH_ENDPOINTS.map(({ name, path, change }): RaceEndpoint => ({
    name,
    role: 'EDITOR',
    send: (s, id) => patchMovie(s, path(id), { body: change }),
    seed: avatar,
    write: 'update',
    away: (row) => {
      row.deletedAt = new Date('2026-10-31T00:00:00.000Z');
    },
  })),
  ...MOVE_ENDPOINTS.map(({ name, method, path, role, movable, write, misplace }): RaceEndpoint => ({
    name,
    role,
    send: (s, id) => sendMovie(s, method, path(id)),
    seed: () => movable(),
    write,
    away: misplace,
  })),
];

describe.each(RACE_ENDPOINTS)('$name: concurrent change', ({ role, send, seed, write, away }) => {
  it('answers 409 "changed" when the movie leaves and comes back between our read and write', async () => {
    const seeded = seed();
    // Where the other admins leave the movie: back where our request needed it.
    const final: Movie = {
      ...seeded,
      deletedAt: seeded.deletedAt === null ? null : TRASHED_AGAIN_AT,
    };
    const s = await setup({ role, movies: [seeded] });
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');
    const row = () => {
      const found = s.db.movies.find((m) => m.id === seeded.id);
      if (!found) throw new Error('movie vanished');
      return found;
    };
    const events: string[] = [];
    // Other admins move the movie away just before our conditional write (so it gets P2025)...
    s.db.injectFault('movie', write, {
      before: () => {
        away(row());
        events.push('away');
      },
    });
    // ...and back just before our re-read (findUnique call 1 is our read inside the transaction).
    s.db.injectFault('movie', 'findUnique', {
      onCall: 2,
      before: () => {
        row().deletedAt = final.deletedAt;
        events.push('back');
      },
    });

    const res = await send(s, seeded.id);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'CONFLICT', message: MOVIE_CHANGED_MESSAGE } });
    // The scenario really happened: read, write (P2025 after "away"), re-read (after "back").
    expect(events).toEqual(['away', 'back']);
    const findUnique = s.db.spies.movie.findUnique;
    const writeSpy = s.db.spies.movie[write];
    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(findUnique.mock.calls[0]?.[0]).toMatchObject({ where: { id: seeded.id } });
    expect(findUnique.mock.calls[1]).toEqual([
      { where: { id: seeded.id }, select: { deletedAt: true } },
    ]);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.settledResults[0]).toMatchObject({
      type: 'rejected',
      value: { code: 'P2025' },
    });
    const [readOrder, reReadOrder] = findUnique.mock.invocationCallOrder;
    const writeOrder = writeSpy.mock.invocationCallOrder[0] ?? NaN;
    expect(writeOrder).toBeGreaterThan(readOrder ?? Infinity);
    expect(reReadOrder).toBeGreaterThan(writeOrder);
    // Not retried, nothing of ours written, and the other admins' final state kept.
    expect(s.db.spies.$transaction).toHaveBeenCalledTimes(1);
    expect(s.db.spies.auditLog.create).not.toHaveBeenCalled();
    expect(movieAudits(s.db)).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
    expect(storedMovie(s, seeded.id)).toEqual(final);
  });
});

describe('DELETE /api/admin/movies/:id (soft delete)', () => {
  it.each<AdminRole>(['EDITOR', 'SUPER_ADMIN'])(
    'a %s moves the movie to the trash: one DELETE audit row, then the cache is dropped',
    async (role) => {
      const seeded = avatar({ status: 'NOW_SHOWING' });
      const s = await setup({ role, movies: [seeded] });
      const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

      const movie = expectOk(await softDelete(s, seeded.id));

      expect(movie.id).toBe(seeded.id);
      expect(movie.deletedAt).not.toBeNull();
      expect(movie.updatedAt > SEEDED_AT).toBe(true);
      // Only deletedAt changes: slug, visibility and status are kept for a restore.
      expect(movie).toMatchObject({ slug: 'avatar', isActive: true, status: 'NOW_SHOWING' });
      expect(storedMovie(s, seeded.id)).toEqual({
        ...seeded,
        deletedAt: new Date(movie.deletedAt ?? ''),
        updatedAt: new Date(movie.updatedAt),
      });
      expect(s.db.spies.movie.update).toHaveBeenCalledExactlyOnceWith({
        where: { id: seeded.id, deletedAt: null },
        data: { deletedAt: expect.any(Date) as unknown },
        select: adminMovieSelect,
      });
      const audits = movieAudits(s.db);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: 'DELETE',
        adminId: s.adminId,
        entity: 'Movie',
        entityId: seeded.id,
        details: { mode: 'soft', title: 'Avatar', slug: 'avatar' },
        userAgent: TEST_USER_AGENT,
      });
      expect(audits[0]?.ipAddress).toEqual(expect.any(String));
      expect(invalidate).toHaveBeenCalledExactlyOnceWith(PUBLIC_MOVIES_CACHE_PREFIX);
      const auditOrder = s.db.spies.auditLog.create.mock.invocationCallOrder.at(-1) ?? Infinity;
      expect(invalidate.mock.invocationCallOrder[0]).toBeGreaterThan(auditOrder);
    },
  );

  it('the movie leaves the cached public list and page at once; admins still see it', async () => {
    const seeded = avatar({ status: 'NOW_SHOWING' });
    const s = await setup({ movies: [seeded] });
    expect(await publicSlugs(s)).toEqual(['avatar']);
    expect(await publicSlugs(s, '?status=NOW_SHOWING')).toEqual(['avatar']);
    expect((await publicGet(s, '/avatar')).status).toBe(200);

    const movie = expectOk(await softDelete(s, seeded.id));

    expect(await publicSlugs(s)).toEqual([]);
    expect(await publicSlugs(s, '?status=NOW_SHOWING')).toEqual([]);
    expectError(await publicGet(s, '/avatar'), 404, 'NOT_FOUND');
    // The admin detail and the trash list still have it; the default list does not.
    expect(expectOk(await getMovie(s, seeded.id))).toEqual(movie);
    const trash = await s.client.get('/movies?deleted=only', [s.session.access]);
    expect(adminMovieListResponseSchema.parse(trash.body).items).toEqual([movie]);
    const live = await s.client.get('/movies', [s.session.access]);
    expect(adminMovieListResponseSchema.parse(live.body).items).toEqual([]);
  });

  it('keeps the slug taken: a new movie cannot have it', async () => {
    const seeded = avatar();
    const s = await setup({ movies: [seeded] });
    expectOk(await softDelete(s, seeded.id));

    const explicit = await createMovie(s, { title: 'Avatar', slug: 'avatar', durationMinutes: 90 });
    expect(expectError(explicit, 409, 'CONFLICT').message).toBe(SLUG_IN_USE_MESSAGE);
    const generated = expectCreated(await createMovie(s, { title: 'Avatar', durationMinutes: 90 }));
    expect(generated.slug).toBe('avatar-2');
  });

  it('a soft-deleted movie cannot be edited until it is restored', async () => {
    const seeded = avatar();
    const s = await setup({ movies: [seeded] });
    expectOk(await softDelete(s, seeded.id));

    const error = expectError(await patchDetails(s, seeded.id, { title: 'X' }), 409, 'CONFLICT');

    expect(error.message).toBe(MOVIE_RESTORE_FIRST_MESSAGE);
  });
});

describe('POST /api/admin/movies/:id/restore', () => {
  it.each<AdminRole>(['EDITOR', 'SUPER_ADMIN'])(
    'a %s restores the movie: one UPDATE audit row, then the cache is dropped',
    async (role) => {
      const seeded = trashedAvatar();
      const s = await setup({ role, movies: [seeded] });
      const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

      const movie = expectOk(await restore(s, seeded.id));

      expect(movie.id).toBe(seeded.id);
      expect(movie.deletedAt).toBeNull();
      expect(movie.updatedAt > SEEDED_AT).toBe(true);
      expect(storedMovie(s, seeded.id)).toEqual({
        ...seeded,
        deletedAt: null,
        updatedAt: new Date(movie.updatedAt),
      });
      expect(s.db.spies.movie.update).toHaveBeenCalledExactlyOnceWith({
        where: { id: seeded.id, deletedAt: { not: null } },
        data: { deletedAt: null },
        select: adminMovieSelect,
      });
      const audits = movieAudits(s.db);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: 'UPDATE',
        adminId: s.adminId,
        entity: 'Movie',
        entityId: seeded.id,
        details: { restored: true, title: 'Avatar', slug: 'avatar' },
        userAgent: TEST_USER_AGENT,
      });
      expect(invalidate).toHaveBeenCalledExactlyOnceWith(PUBLIC_MOVIES_CACHE_PREFIX);
      const auditOrder = s.db.spies.auditLog.create.mock.invocationCallOrder.at(-1) ?? Infinity;
      expect(invalidate.mock.invocationCallOrder[0]).toBeGreaterThan(auditOrder);
    },
  );

  it('an active, listable movie reappears in the cached public list and page at once', async () => {
    const seeded = trashedAvatar({ status: 'NOW_SHOWING' });
    const s = await setup({ movies: [seeded] });
    expect(await publicSlugs(s)).toEqual([]);
    expectError(await publicGet(s, '/avatar'), 404, 'NOT_FOUND');

    const movie = expectOk(await restore(s, seeded.id));

    expect(movie.slug).toBe('avatar');
    expect(await publicSlugs(s)).toEqual(['avatar']);
    expect(await publicSlugs(s, '?status=NOW_SHOWING')).toEqual(['avatar']);
    expect((await publicGet(s, '/avatar')).status).toBe(200);
  });

  it('keeps the visibility and status it had: a hidden movie stays hidden', async () => {
    const seeded = trashedAvatar({ isActive: false, status: 'ENDED' });
    const s = await setup({ movies: [seeded] });

    const movie = expectOk(await restore(s, seeded.id));

    expect(movie).toMatchObject({ slug: 'avatar', isActive: false, status: 'ENDED' });
    expect(await publicSlugs(s)).toEqual([]);
    expectError(await publicGet(s, '/avatar'), 404, 'NOT_FOUND');
  });

  it('a restored movie can be edited again', async () => {
    const seeded = trashedAvatar();
    const s = await setup({ movies: [seeded] });
    expectError(await patchDetails(s, seeded.id, { title: 'Avatar 2' }), 409, 'CONFLICT');

    expectOk(await restore(s, seeded.id));
    const edited = expectOk(await patchDetails(s, seeded.id, { title: 'Avatar 2' }));

    expect(edited).toMatchObject({ title: 'Avatar 2', slug: 'avatar', deletedAt: null });
    expect(movieAudits(s.db).map((row) => row.action)).toEqual(['UPDATE', 'UPDATE']);
  });
});

describe('DELETE /api/admin/movies/:id/permanent (hard delete)', () => {
  it.each<[string, () => Movie, (id: string) => string]>([
    ['a soft-deleted movie', () => trashedAvatar(), (id) => id],
    ['a live movie', () => avatar(), (id) => id],
    ['an unknown id', () => trashedAvatar(), () => randomUUID()],
    ['a bad id and body', () => trashedAvatar(), () => 'not-a-uuid'],
  ])('an EDITOR is refused (403) for %s, before any database access', async (_n, seed, idOf) => {
    const seeded = seed();
    const s = await setup({ role: 'EDITOR', movies: [seeded] });
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');
    const id = idOf(seeded.id);

    const res = await hardDelete(s, id, id === seeded.id ? {} : { body: { foo: 1 } });

    expect(res.status).toBe(403);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual(FORBIDDEN_BODY);
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    expect(s.db.spies.movie.findUnique).not.toHaveBeenCalled();
    expect(s.db.spies.movie.delete).not.toHaveBeenCalled();
    expect(storedMovie(s, seeded.id)).toEqual(seeded);
    expect(movieAudits(s.db)).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('a SUPER_ADMIN removes a soft-deleted movie for good: 204, one DELETE audit row', async () => {
    const seeded = trashedAvatar();
    const other = testMovie({ slug: 'other', title: 'Other' });
    const s = await setup({ role: 'SUPER_ADMIN', movies: [seeded, other] });
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    expectNoContent(await hardDelete(s, seeded.id));

    expect(isStored(s, seeded.id)).toBe(false);
    expect(storedMovie(s, other.id)).toEqual(other);
    expect(s.db.spies.movie.delete).toHaveBeenCalledExactlyOnceWith({
      where: { id: seeded.id, deletedAt: { not: null } },
      select: { id: true, title: true, slug: true },
    });
    const audits = movieAudits(s.db);
    expect(audits).toHaveLength(1);
    // The audit row outlives the movie and records what it was.
    expect(audits[0]).toMatchObject({
      action: 'DELETE',
      adminId: s.adminId,
      entity: 'Movie',
      entityId: seeded.id,
      details: { mode: 'hard', title: 'Avatar', slug: 'avatar' },
      userAgent: TEST_USER_AGENT,
    });
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(PUBLIC_MOVIES_CACHE_PREFIX);
    const auditOrder = s.db.spies.auditLog.create.mock.invocationCallOrder.at(-1) ?? Infinity;
    expect(invalidate.mock.invocationCallOrder[0]).toBeGreaterThan(auditOrder);
    // Gone for admins too.
    expectError(await getMovie(s, seeded.id), 404, 'NOT_FOUND');
    expectError(await restore(s, seeded.id), 404, 'NOT_FOUND');
  });

  it('frees the slug: a new movie can take it', async () => {
    const seeded = trashedAvatar();
    const s = await setup({ role: 'SUPER_ADMIN', movies: [seeded] });

    expectNoContent(await hardDelete(s, seeded.id));
    const created = expectCreated(await createMovie(s, { title: 'Avatar', durationMinutes: 90 }));

    expect(created.slug).toBe('avatar');
    expect(created.id).not.toBe(seeded.id);
  });

  describe('order of checks, with several failures in one request', () => {
    // The real order: express.json (app.ts) -> csrfProtection -> requireAuth (admin.routes.ts)
    // -> requireRole('SUPER_ADMIN', 'EDITOR') at the /movies mount -> requireRole('SUPER_ADMIN')
    // on the route -> validate (params, query, body) -> the service (404, then 409).
    // Each row has every failure of the rows below it, and must get only its own answer.
    const BAD = 'not-a-uuid/permanent?force=1';
    const BAD_BODY = { foo: 1 };

    interface OrderCase {
      role: AdminRole;
      /** The path below /movies/ (a function of the seeded live movie's id). */
      path: (id: string) => string;
      options: SendOptions;
      status: number;
      code: string;
      /** Whether the request gets as far as the database (only 404 and 409 do). */
      reachesDb: boolean;
    }

    const ORDER: [string, OrderCase][] = [
      [
        'a malformed JSON body, before CSRF and session (app-level body parser)',
        {
          role: 'EDITOR',
          path: () => BAD,
          options: { body: '{"foo":', token: 'wrong', cookies: [] },
          status: 400,
          code: 'INVALID_JSON',
          reachesDb: false,
        },
      ],
      [
        'a bad CSRF token, no session, a bad id, query and body',
        {
          role: 'EDITOR',
          path: () => BAD,
          options: { body: BAD_BODY, token: 'wrong', cookies: [] },
          status: 403,
          code: 'CSRF_INVALID',
          reachesDb: false,
        },
      ],
      [
        'a bad CSRF token with an EDITOR session (CSRF before the role)',
        {
          role: 'EDITOR',
          path: () => BAD,
          options: { body: BAD_BODY, token: 'wrong' },
          status: 403,
          code: 'CSRF_INVALID',
          reachesDb: false,
        },
      ],
      [
        'good CSRF, no session, a bad id, query and body',
        {
          role: 'SUPER_ADMIN',
          path: () => BAD,
          options: { body: BAD_BODY, cookies: [] },
          status: 401,
          code: 'UNAUTHORIZED',
          reachesDb: false,
        },
      ],
      [
        'an EDITOR with a bad id, query and body (role before validation)',
        {
          role: 'EDITOR',
          path: () => BAD,
          options: { body: BAD_BODY },
          status: 403,
          code: 'FORBIDDEN',
          reachesDb: false,
        },
      ],
      [
        'a SUPER_ADMIN with a bad id, query and body',
        {
          role: 'SUPER_ADMIN',
          path: () => BAD,
          options: { body: BAD_BODY },
          status: 400,
          code: 'VALIDATION_ERROR',
          reachesDb: false,
        },
      ],
      [
        'a SUPER_ADMIN with an unknown id',
        {
          role: 'SUPER_ADMIN',
          path: () => `${randomUUID()}/permanent`,
          options: {},
          status: 404,
          code: 'NOT_FOUND',
          reachesDb: true,
        },
      ],
      [
        'a SUPER_ADMIN with a live (not yet deleted) movie',
        {
          role: 'SUPER_ADMIN',
          path: (id) => `${id}/permanent`,
          options: {},
          status: 409,
          code: 'CONFLICT',
          reachesDb: true,
        },
      ],
    ];

    it.each(ORDER)('%s', async (_name, { role, path, options, status, code, reachesDb }) => {
      const seeded = avatar();
      const s = await setup({ role, movies: [seeded] });

      const res = await sendMovie(s, 'delete', path(seeded.id), options);

      const error = expectError(res, status, code);
      if (code === 'VALIDATION_ERROR') {
        // Every part is reported at once: validation runs after all the guards.
        const parts = ['params', 'query', 'body'].map((part): unknown =>
          expect.objectContaining({ path: expect.arrayContaining([part]) as unknown }),
        );
        expect(error.details).toEqual(expect.arrayContaining(parts));
      }
      if (code === 'CONFLICT') expect(error.message).toBe(MOVIE_DELETE_FIRST_MESSAGE);
      // The body parser runs before the admin router (and its no-store), so only that 400 lacks it.
      if (code !== 'INVALID_JSON') expect(res.headers['cache-control']).toBe('no-store');
      expect(s.db.spies.movie.findUnique).toHaveBeenCalledTimes(reachesDb ? 1 : 0);
      expect(s.db.spies.movie.delete).not.toHaveBeenCalled();
      expect(storedMovie(s, seeded.id)).toEqual(seeded);
      expect(movieAudits(s.db)).toEqual([]);
    });
  });

  it('a second hard delete of the same movie is a 404', async () => {
    const seeded = trashedAvatar();
    const s = await setup({ role: 'SUPER_ADMIN', movies: [seeded] });

    expectNoContent(await hardDelete(s, seeded.id));
    const error = expectError(await hardDelete(s, seeded.id), 404, 'NOT_FOUND');

    expect(error.message).toBe(MOVIE_NOT_FOUND_MESSAGE);
    expect(movieAudits(s.db)).toHaveLength(1);
  });
});

describe('movie lifecycle', () => {
  it('create -> soft delete -> restore -> soft delete -> permanent delete, all audited', async () => {
    const s = await setup({ role: 'SUPER_ADMIN' });

    const created = expectCreated(await createMovie(s, { title: 'Avatar', durationMinutes: 162 }));
    const { id } = created;
    expect(expectOk(await softDelete(s, id)).deletedAt).not.toBeNull();
    expect(expectOk(await restore(s, id)).deletedAt).toBeNull();
    expect(expectOk(await softDelete(s, id)).deletedAt).not.toBeNull();
    expectNoContent(await hardDelete(s, id));

    expect(s.db.movies).toEqual([]);
    const audits = movieAudits(s.db);
    expect(audits.map((row) => [row.action, row.details])).toEqual([
      ['CREATE', { title: 'Avatar', slug: 'avatar' }],
      ['DELETE', { mode: 'soft', title: 'Avatar', slug: 'avatar' }],
      ['UPDATE', { restored: true, title: 'Avatar', slug: 'avatar' }],
      ['DELETE', { mode: 'soft', title: 'Avatar', slug: 'avatar' }],
      ['DELETE', { mode: 'hard', title: 'Avatar', slug: 'avatar' }],
    ]);
    expect(new Set(audits.map((row) => row.entityId))).toEqual(new Set([id]));
    expect(new Set(audits.map((row) => row.adminId))).toEqual(new Set([s.adminId]));
  });
});
