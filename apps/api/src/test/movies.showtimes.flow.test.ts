/**
 * Phase 5 T15: movie writes versus showtimes. Permanent delete and soft delete are refused while
 * the movie has upcoming showtimes (D11, Phase 4 review L3), and a longer running time is refused
 * only for the clashes it causes (D12). Every scenario runs twice, through the service and through
 * the real routes (see DRIVERS), against the in-memory fake.
 */
import {
  apiErrorSchema,
  futureShowtimesConflictDetailsSchema,
  movieUpdateBodySchema,
  showtimeConflictErrorSchema,
  type MovieStatus,
} from '@sk-cinema/shared';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminRole, Movie, Screen, Setting, Showtime } from '../generated/prisma/client.js';
import { MemoryCache } from '../lib/cache.js';
import { addDays } from '../lib/colomboTime.js';
import { AppError } from '../lib/errors.js';
import { CSRF_HEADER } from '../middleware/csrf.js';
import {
  MOVIE_ALREADY_DELETED_MESSAGE,
  MOVIE_CHANGED_MESSAGE,
  MOVIE_DELETE_FIRST_MESSAGE,
  MOVIE_DELETE_HAS_SHOWTIMES_MESSAGE,
  MOVIE_HARD_DELETE_HAS_SHOWTIMES_MESSAGE,
  SLUG_IN_USE_MESSAGE,
  createMovieAdminService,
  movieLengthOverlapMessage,
} from '../services/movie.admin.service.js';
import { PUBLIC_MOVIES_CACHE_PREFIX } from '../services/movie.public.service.js';
import {
  ADMIN_BASE,
  ADMIN_ORIGIN,
  TEST_USER_AGENT,
  authClient,
  buildTestApp,
  inMemoryAuthDb,
  recordNotFoundError,
  sessionFrom,
  silentLogger,
  testAdmin,
  testMovie,
  testPasswordHash,
  testScreen,
  testSetting,
  testShowtime,
  type InMemoryAuthDb,
} from './helpers.js';

const EMAIL = 'admin@skcinema.lk';
const PASSWORD = 'correct horse battery staple';

/** The clock: 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');
const TODAY = '2026-11-01';
const DAY = '2026-11-02';
const TRASHED_AT = new Date('2026-10-01T00:00:00.000Z');
const CACHED_KEY = `${PUBLIC_MOVIES_CACHE_PREFIX}list:all`;

const colombo = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await testPasswordHash(PASSWORD);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// The two ways in
// ---------------------------------------------------------------------------

interface Seed {
  movies: Movie[];
  screens?: Screen[];
  showtimes?: Showtime[];
  settings?: Setting[];
}

interface Outcome {
  status: number;
  error?: { code: string; message: string; details?: unknown };
}

/** The writes under test, by either driver. */
interface Actions {
  patch: (id: string, body: Record<string, unknown>) => Promise<Outcome>;
  setStatus: (id: string, status: MovieStatus) => Promise<Outcome>;
  setActive: (id: string, isActive: boolean) => Promise<Outcome>;
  softDelete: (id: string) => Promise<Outcome>;
  restore: (id: string) => Promise<Outcome>;
  hardDelete: (id: string) => Promise<Outcome>;
}

interface Harness extends Actions {
  db: InMemoryAuthDb;
  cache: MemoryCache;
}

/** Through the service: an AppError is the refusal, anything else fails the test. */
function viaService(seed: Seed): Promise<Harness> {
  const admin = testAdmin({ email: EMAIL, passwordHash, role: 'SUPER_ADMIN' });
  const db = inMemoryAuthDb({ admins: [admin], ...seed });
  const cache = new MemoryCache();
  const service = createMovieAdminService({
    db: db.prisma,
    cache,
    logger: silentLogger,
    now: () => NOW,
  });
  const actor = { adminId: admin.id, ipAddress: '203.0.113.7', userAgent: 'test-agent' };
  const run = async (write: () => Promise<unknown>, status = 200): Promise<Outcome> => {
    try {
      await write();
      return { status };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      const { code, message, details } = error;
      return { status: error.status, error: { code, message, details } };
    }
  };
  return Promise.resolve({
    db,
    cache,
    patch: (id, body) => run(() => service.update(id, movieUpdateBodySchema.parse(body), actor)),
    setStatus: (id, status) => run(() => service.setStatus(id, status, actor)),
    setActive: (id, isActive) => run(() => service.setActive(id, isActive, actor)),
    softDelete: (id) => run(() => service.softDelete(id, actor)),
    restore: (id) => run(() => service.restore(id, actor)),
    hardDelete: (id) => run(() => service.hardDelete(id, actor), 204),
  });
}

interface Browser {
  app: Express;
  db: InMemoryAuthDb;
  cache: MemoryCache;
  send: (
    method: 'post' | 'patch' | 'delete',
    path: string,
    body?: object,
  ) => PromiseLike<request.Response>;
}

/** A browser-like admin signed in with `role`: session, CSRF token and Origin. */
async function signIn(seed: Seed, role: AdminRole = 'SUPER_ADMIN'): Promise<Browser> {
  const admin = testAdmin({ email: EMAIL, passwordHash, role });
  const db = inMemoryAuthDb({ admins: [admin], ...seed });
  const { app, cache } = buildTestApp({ prisma: db.prisma });
  const client = await authClient(app);
  const login = await client.post('/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  expect(login.status).toBe(200);
  const session = sessionFrom(login);
  return {
    app,
    db,
    cache,
    send: (method, path, body) => {
      const req = request(app)
        [method](`${ADMIN_BASE}${path}`)
        .set('User-Agent', TEST_USER_AGENT)
        .set('Cookie', [client.csrf.cookie, session.access].join('; '))
        .set('Origin', ADMIN_ORIGIN)
        .set(CSRF_HEADER, client.csrf.token);
      return body === undefined ? req : req.send(body);
    },
  };
}

/** Through the real routes: validation, auth, CSRF, the error handler and JSON included. */
async function viaRoutes(seed: Seed): Promise<Harness> {
  const { db, cache, send } = await signIn(seed);
  const outcome = async (pending: PromiseLike<request.Response>): Promise<Outcome> => {
    const res = await pending;
    if (res.status < 400) return { status: res.status };
    return { status: res.status, error: apiErrorSchema.parse(res.body).error };
  };
  return {
    db,
    cache,
    patch: (id, body) => outcome(send('patch', `/movies/${id}`, body)),
    setStatus: (id, status) => outcome(send('patch', `/movies/${id}/status`, { status })),
    setActive: (id, isActive) => outcome(send('patch', `/movies/${id}/active`, { isActive })),
    softDelete: (id) => outcome(send('delete', `/movies/${id}`)),
    restore: (id) => outcome(send('post', `/movies/${id}/restore`)),
    hardDelete: (id) => outcome(send('delete', `/movies/${id}/permanent`)),
  };
}

const DRIVERS = [
  { driver: 'service', start: viaService },
  { driver: 'routes', start: viaRoutes },
];

// ---------------------------------------------------------------------------
// Fixtures and expectations
// ---------------------------------------------------------------------------

const mainMovie = (overrides: Partial<Movie> = {}) =>
  testMovie({
    slug: 'main-feature',
    title: 'Main Feature',
    durationMinutes: 120,
    status: 'NOW_SHOWING',
    ...overrides,
  });

const otherMovie = (overrides: Partial<Movie> = {}) =>
  testMovie({
    slug: 'neighbour',
    title: 'Neighbour',
    durationMinutes: 100,
    status: 'NOW_SHOWING',
    ...overrides,
  });

const show = (
  movie: Movie,
  screen: Screen,
  time: string,
  overrides: Partial<Showtime> = {},
  date = DAY,
) =>
  testShowtime({
    movieId: movie.id,
    screenId: screen.id,
    startsAt: colombo(date, time),
    ...overrides,
  });

const gap = (minutes: number) => [testSetting('showGapMinutes', String(minutes))];

const movieAudits = (db: InMemoryAuthDb) => db.auditLogs.filter((row) => row.entity === 'Movie');

const storedMovie = (db: InMemoryAuthDb, id: string) => db.movies.find((m) => m.id === id);

/** Starts `driver` with a cached public response that a successful write must drop. */
async function begin(start: (seed: Seed) => Promise<Harness>, seed: Seed): Promise<Harness> {
  const h = await start(seed);
  h.cache.set(CACHED_KEY, ['cached'], 60_000);
  return h;
}

/** A snapshot of what a refused write must leave as it was. */
function snapshot(db: InMemoryAuthDb) {
  return { movies: structuredClone(db.movies), showtimes: structuredClone(db.showtimes) };
}

/** Nothing changed, nothing audited, the public cache kept. */
function expectNothingChanged(h: Harness, before: ReturnType<typeof snapshot>) {
  expect(h.db.movies).toEqual(before.movies);
  expect(h.db.showtimes).toEqual(before.showtimes);
  expect(movieAudits(h.db)).toEqual([]);
  expect(h.cache.get(CACHED_KEY)).toEqual(['cached']);
}

/** The body's `details`, checked against the shared overlap error schema. */
function overlapDetails(outcome: Outcome) {
  expect(outcome.status).toBe(409);
  return showtimeConflictErrorSchema.parse({ error: outcome.error }).error.details;
}

function expectFutureShowtimesConflict(outcome: Outcome, message: string, count: number) {
  expect(outcome.status).toBe(409);
  expect(outcome.error).toEqual({
    code: 'CONFLICT',
    message,
    details: { futureShowtimeCount: count },
  });
  expect(futureShowtimesConflictDetailsSchema.parse(outcome.error?.details)).toEqual({
    futureShowtimeCount: count,
  });
}

const screenLocks = (db: InMemoryAuthDb) => db.locks.filter((lock) => lock.table === 'Screen');

/** A length change that ran no overlap check at all. */
function expectNoOverlapCheck(db: InMemoryAuthDb) {
  expect(db.spies.showtime.findMany).not.toHaveBeenCalled();
  expect(db.spies.setting.findUnique).not.toHaveBeenCalled();
  expect(screenLocks(db)).toEqual([]);
}

describe.each(DRIVERS)('through the $driver', ({ start }) => {
  // -------------------------------------------------------------------------
  // Hard delete
  // -------------------------------------------------------------------------

  describe('hard delete', () => {
    const trashed = () => mainMovie({ deletedAt: TRASHED_AT });

    it('409 with the count while a future show exists: nothing changes, no audit', async () => {
      const movie = trashed();
      const screen = testScreen();
      const h = await begin(start, {
        movies: [movie],
        screens: [screen],
        showtimes: [
          show(movie, screen, '10:00'),
          show(movie, screen, '20:00'),
          show(movie, screen, '10:00', {}, TODAY),
        ],
      });
      const before = snapshot(h.db);

      const outcome = await h.hardDelete(movie.id);

      expectFutureShowtimesConflict(outcome, MOVIE_HARD_DELETE_HAS_SHOWTIMES_MESSAGE, 2);
      expect(h.db.spies.showtime.deleteMany).not.toHaveBeenCalled();
      expect(h.db.spies.movie.delete).not.toHaveBeenCalled();
      expectNothingChanged(h, before);
    });

    it('204 with only past shows: rows gone, audit counts them, cache dropped', async () => {
      const movie = trashed();
      const other = otherMovie();
      const screen = testScreen();
      const kept = show(other, screen, '12:00', {}, TODAY);
      const h = await begin(start, {
        movies: [movie, other],
        screens: [screen],
        showtimes: [
          show(movie, screen, '08:00', {}, TODAY),
          show(movie, screen, '10:00', {}, '2026-10-31'),
          kept,
        ],
      });

      const outcome = await h.hardDelete(movie.id);

      expect(outcome.status).toBe(204);
      expect(storedMovie(h.db, movie.id)).toBeUndefined();
      // Explicit, not left to the foreign key's cascade: its count is the audit's.
      expect(h.db.spies.showtime.deleteMany).toHaveBeenCalledExactlyOnceWith({
        where: { movieId: movie.id },
      });
      expect(h.db.showtimes.map((row) => row.id)).toEqual([kept.id]);
      expect(movieAudits(h.db)).toEqual([
        expect.objectContaining({
          action: 'DELETE',
          entityId: movie.id,
          details: {
            mode: 'hard',
            title: 'Main Feature',
            slug: 'main-feature',
            showtimesDeleted: 2,
          },
        }),
      ]);
      expect(h.cache.get(CACHED_KEY)).toBeUndefined();
    });

    it('past and soft-deleted rows are both counted and removed', async () => {
      const movie = trashed();
      const screen = testScreen();
      const h = await begin(start, {
        movies: [movie],
        screens: [screen],
        showtimes: [
          show(movie, screen, '08:00', {}, TODAY),
          show(movie, screen, '10:00', { deletedAt: TRASHED_AT }, TODAY),
          show(movie, screen, '10:00', { deletedAt: TRASHED_AT }),
        ],
      });

      expect((await h.hardDelete(movie.id)).status).toBe(204);

      expect(h.db.showtimes).toEqual([]);
      expect(movieAudits(h.db)[0]?.details).toMatchObject({ showtimesDeleted: 3 });
    });

    it('no showtimes: showtimesDeleted 0', async () => {
      const movie = trashed();
      const h = await begin(start, { movies: [movie] });

      expect((await h.hardDelete(movie.id)).status).toBe(204);

      expect(movieAudits(h.db)[0]?.details).toMatchObject({ showtimesDeleted: 0 });
    });

    it('a show starting exactly now, or a soft-deleted future show, does not block', async () => {
      const movie = trashed();
      const screen = testScreen();
      const h = await begin(start, {
        movies: [movie],
        screens: [screen],
        showtimes: [
          testShowtime({ movieId: movie.id, screenId: screen.id, startsAt: NOW }),
          show(movie, screen, '10:00', { deletedAt: TRASHED_AT }),
        ],
      });

      expect((await h.hardDelete(movie.id)).status).toBe(204);

      expect(movieAudits(h.db)[0]?.details).toMatchObject({ showtimesDeleted: 2 });
    });

    it('locks the movie before counting its shows', async () => {
      const movie = trashed();
      const h = await begin(start, { movies: [movie] });
      let locksAtCount: unknown;
      h.db.injectFault('showtime', 'count', {
        before: () => {
          locksAtCount = [...h.db.locks];
        },
      });

      expect((await h.hardDelete(movie.id)).status).toBe(204);

      expect(locksAtCount).toEqual([{ table: 'Movie', id: movie.id }]);
      expect(h.db.locks).toEqual([{ table: 'Movie', id: movie.id }]);
    });

    it('a live movie still gets "delete first", whatever its shows', async () => {
      const movie = mainMovie();
      const screen = testScreen();
      const h = await begin(start, {
        movies: [movie],
        screens: [screen],
        showtimes: [show(movie, screen, '10:00')],
      });
      const before = snapshot(h.db);

      const outcome = await h.hardDelete(movie.id);

      expect(outcome).toMatchObject({
        status: 409,
        error: { message: MOVIE_DELETE_FIRST_MESSAGE },
      });
      expect(outcome.error?.details).toBeUndefined();
      expect(h.db.spies.showtime.count).not.toHaveBeenCalled();
      expectNothingChanged(h, before);
    });

    it('an audit failure restores the movie and its showtimes', async () => {
      const movie = trashed();
      const screen = testScreen();
      const h = await begin(start, {
        movies: [movie],
        screens: [screen],
        showtimes: [show(movie, screen, '08:00', {}, TODAY)],
      });
      const before = snapshot(h.db);
      const failure = new Error('audit table unavailable');
      h.db.injectFault('auditLog', 'create', { error: failure });

      const outcome = await h.hardDelete(movie.id).catch((error: unknown) => error);

      // The service rethrows it as it is; the routes answer 500 without its text.
      if (outcome instanceof Error) expect(outcome).toBe(failure);
      else expect(outcome).toMatchObject({ status: 500, error: { code: 'INTERNAL_ERROR' } });
      expectNothingChanged(h, before);
    });

    it('a P2025 from the movie delete restores the deleted showtimes', async () => {
      const movie = trashed();
      const screen = testScreen();
      const h = await begin(start, {
        movies: [movie],
        screens: [screen],
        showtimes: [show(movie, screen, '08:00', {}, TODAY)],
      });
      const before = snapshot(h.db);
      h.db.injectFault('movie', 'delete', { error: recordNotFoundError('movie', 'a delete') });

      const outcome = await h.hardDelete(movie.id);

      expect(outcome).toMatchObject({ status: 409, error: { message: MOVIE_CHANGED_MESSAGE } });
      expectNothingChanged(h, before);
    });
  });

  // -------------------------------------------------------------------------
  // Soft delete, restore, deactivate, ENDED
  // -------------------------------------------------------------------------

  describe('soft delete', () => {
    it('409 with the count while a future show exists: nothing changes', async () => {
      const movie = mainMovie();
      const screen = testScreen();
      const h = await begin(start, {
        movies: [movie],
        screens: [screen],
        showtimes: [
          show(movie, screen, '10:00'),
          show(movie, screen, '20:00'),
          show(movie, screen, '10:00', {}, TODAY),
          show(movie, screen, '13:00', { deletedAt: TRASHED_AT }),
        ],
      });
      const before = snapshot(h.db);

      const outcome = await h.softDelete(movie.id);

      expectFutureShowtimesConflict(outcome, MOVIE_DELETE_HAS_SHOWTIMES_MESSAGE, 2);
      expect(h.db.spies.movie.update).not.toHaveBeenCalled();
      expectNothingChanged(h, before);
    });

    it('locks the movie before counting its shows', async () => {
      const movie = mainMovie();
      const h = await begin(start, { movies: [movie] });
      let locksAtCount: unknown;
      h.db.injectFault('showtime', 'count', {
        before: () => {
          locksAtCount = [...h.db.locks];
        },
      });

      expect((await h.softDelete(movie.id)).status).toBe(200);

      expect(locksAtCount).toEqual([{ table: 'Movie', id: movie.id }]);
    });

    it.each<[string, Partial<Showtime>, string]>([
      ['only past', {}, TODAY],
      ['only soft-deleted', { deletedAt: TRASHED_AT }, DAY],
    ])('200 with %s shows', async (_name, overrides, date) => {
      const movie = mainMovie();
      const screen = testScreen();
      const h = await begin(start, {
        movies: [movie],
        screens: [screen],
        showtimes: [show(movie, screen, '10:00', overrides, date)],
      });

      expect((await h.softDelete(movie.id)).status).toBe(200);

      expect(storedMovie(h.db, movie.id)?.deletedAt).toEqual(NOW);
      expect(movieAudits(h.db)).toEqual([
        expect.objectContaining({
          action: 'DELETE',
          details: { mode: 'soft', title: 'Main Feature', slug: 'main-feature' },
        }),
      ]);
      expect(h.cache.get(CACHED_KEY)).toBeUndefined();
    });

    it('a movie already in the trash gets "already deleted", whatever its shows', async () => {
      const movie = mainMovie({ deletedAt: TRASHED_AT });
      const screen = testScreen();
      const h = await begin(start, {
        movies: [movie],
        screens: [screen],
        showtimes: [show(movie, screen, '10:00')],
      });
      const before = snapshot(h.db);

      const outcome = await h.softDelete(movie.id);

      expect(outcome).toMatchObject({
        status: 409,
        error: { message: MOVIE_ALREADY_DELETED_MESSAGE },
      });
      expect(h.db.spies.showtime.count).not.toHaveBeenCalled();
      expectNothingChanged(h, before);
    });

    it('restore has no showtime check and takes no lock', async () => {
      const movie = mainMovie({ deletedAt: TRASHED_AT });
      const screen = testScreen();
      const h = await begin(start, {
        movies: [movie],
        screens: [screen],
        showtimes: [show(movie, screen, '10:00')],
      });

      expect((await h.restore(movie.id)).status).toBe(200);

      expect(storedMovie(h.db, movie.id)?.deletedAt).toBeNull();
      expect(h.db.spies.showtime.count).not.toHaveBeenCalled();
      expect(h.db.locks).toEqual([]);
    });

    it('deactivating and setting ENDED still succeed with future shows', async () => {
      const movie = mainMovie();
      const screen = testScreen();
      const future = show(movie, screen, '10:00');
      const h = await begin(start, {
        movies: [movie],
        screens: [screen],
        showtimes: [future],
      });

      expect((await h.setActive(movie.id, false)).status).toBe(200);
      expect((await h.setStatus(movie.id, 'ENDED')).status).toBe(200);

      expect(storedMovie(h.db, movie.id)).toMatchObject({ isActive: false, status: 'ENDED' });
      // The show stays: it keeps occupying the screen.
      expect(h.db.showtimes.map((row) => [row.id, row.deletedAt])).toEqual([[future.id, null]]);
      expect(h.db.spies.showtime.count).not.toHaveBeenCalled();
      expect(h.db.locks).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Movie length
  // -------------------------------------------------------------------------

  describe('a longer running time', () => {
    it('that overlaps the next show: 409 with details, the whole PATCH refused', async () => {
      const movie = mainMovie();
      const other = otherMovie();
      const screen = testScreen();
      const neighbour = show(other, screen, '12:30');
      const h = await begin(start, {
        movies: [movie, other],
        screens: [screen],
        showtimes: [show(movie, screen, '10:00'), neighbour],
        settings: gap(15),
      });
      const before = snapshot(h.db);

      const outcome = await h.patch(movie.id, { durationMinutes: 150, title: 'New Title' });

      expect(overlapDetails(outcome)).toEqual([
        {
          path: ['body', 'durationMinutes'],
          message: 'Overlaps "Neighbour" (12:30–14:10), counting the 15-minute gap between shows',
          requested: { date: DAY, time: '10:00' },
          conflict: {
            showtimeId: neighbour.id,
            movieTitle: 'Neighbour',
            startsAt: '2026-11-02T07:00:00.000Z',
            endsAt: '2026-11-02T08:40:00.000Z',
          },
        },
      ]);
      expect(outcome.error?.message).toBe(
        "A longer running time would make 1 of this movie's showtimes overlap another showtime",
      );
      expect(h.db.spies.movie.update).not.toHaveBeenCalled();
      expectNothingChanged(h, before);
    });

    it('that still fits exactly (touching at new end + gap): 200, audited', async () => {
      const movie = mainMovie();
      const other = otherMovie();
      const screen = testScreen();
      const h = await begin(start, {
        movies: [movie, other],
        screens: [screen],
        // 10:00 + 135 + 15 = 12:30.
        showtimes: [show(movie, screen, '10:00'), show(other, screen, '12:30')],
        settings: gap(15),
      });

      expect((await h.patch(movie.id, { durationMinutes: 135 })).status).toBe(200);

      expect(storedMovie(h.db, movie.id)?.durationMinutes).toBe(135);
      expect(movieAudits(h.db)).toEqual([
        expect.objectContaining({
          action: 'UPDATE',
          details: { changes: { durationMinutes: { from: 120, to: 135 } } },
        }),
      ]);
      expect(h.cache.get(CACHED_KEY)).toBeUndefined();
    });

    it('with no future shows: 200 without a screen lock or a settings read', async () => {
      const movie = mainMovie();
      const h = await begin(start, { movies: [movie] });

      expect((await h.patch(movie.id, { durationMinutes: 150 })).status).toBe(200);

      expect(h.db.spies.showtime.findMany).toHaveBeenCalledTimes(1);
      expect(h.db.spies.setting.findUnique).not.toHaveBeenCalled();
      expect(h.db.locks).toEqual([{ table: 'Movie', id: movie.id }]);
    });

    describe('clashes that exist already never block', () => {
      it('length unchanged, with a clash: 200, and no lock', async () => {
        const movie = mainMovie();
        const other = otherMovie();
        const screen = testScreen();
        const h = await begin(start, {
          movies: [movie, other],
          screens: [screen],
          showtimes: [show(movie, screen, '10:00'), show(other, screen, '11:00')],
          settings: gap(15),
        });

        const outcome = await h.patch(movie.id, { durationMinutes: 120, title: 'New Title' });

        expect(outcome.status).toBe(200);
        expect(storedMovie(h.db, movie.id)?.title).toBe('New Title');
        expectNoOverlapCheck(h.db);
        expect(h.db.locks).toEqual([]);
      });

      it('under a raised gap, an increase causing nothing new: 200', async () => {
        const movie = mainMovie();
        const other = otherMovie();
        const screen = testScreen();
        const h = await begin(start, {
          movies: [movie, other],
          screens: [screen],
          // 10:00 + 120 + 45 = 12:45: already over the 12:30 neighbour.
          showtimes: [show(movie, screen, '10:00'), show(other, screen, '12:30')],
          settings: gap(45),
        });

        expect((await h.patch(movie.id, { durationMinutes: 130 })).status).toBe(200);

        expect(storedMovie(h.db, movie.id)?.durationMinutes).toBe(130);
      });

      it('between two of this movie’s own shows, under a raised gap: 200', async () => {
        const movie = mainMovie();
        const screen = testScreen();
        const h = await begin(start, {
          movies: [movie],
          screens: [screen],
          showtimes: [show(movie, screen, '10:00'), show(movie, screen, '12:30')],
          settings: gap(45),
        });

        expect((await h.patch(movie.id, { durationMinutes: 130 })).status).toBe(200);
      });

      it('plus one new clash: 409 listing only the new one', async () => {
        const movie = mainMovie();
        const other = otherMovie();
        const screen = testScreen();
        const caused = show(other, screen, '19:00');
        const h = await begin(start, {
          movies: [movie, other],
          screens: [screen],
          showtimes: [
            show(movie, screen, '10:00'),
            show(other, screen, '12:30'), // 10:00 + 120 + 45 = 12:45: exists already.
            show(movie, screen, '16:00'),
            caused, // 16:00 + 120 + 45 = 18:45 fits; + 150 = 19:15 does not.
          ],
          settings: gap(45),
        });
        const before = snapshot(h.db);

        const outcome = await h.patch(movie.id, { durationMinutes: 150 });

        const details = overlapDetails(outcome);
        expect(details.map((detail) => detail.conflict.showtimeId)).toEqual([caused.id]);
        expect(details[0]?.requested).toEqual({ date: DAY, time: '16:00' });
        expect(outcome.error?.message).toBe(movieLengthOverlapMessage(1, 1));
        expectNothingChanged(h, before);
      });
    });

    it('between two of this movie’s own future shows: 409', async () => {
      const movie = mainMovie();
      const screen = testScreen();
      const first = show(movie, screen, '10:00');
      const h = await begin(start, {
        movies: [movie],
        screens: [screen],
        showtimes: [first, show(movie, screen, '12:30')],
        settings: gap(15),
      });
      const before = snapshot(h.db);

      const outcome = await h.patch(movie.id, { durationMinutes: 150 });

      expect(overlapDetails(outcome)).toEqual([
        expect.objectContaining({
          requested: { date: DAY, time: '12:30' },
          // The earlier show, at the longer length the clash is about.
          conflict: {
            showtimeId: first.id,
            movieTitle: 'Main Feature',
            startsAt: '2026-11-02T04:30:00.000Z',
            endsAt: '2026-11-02T07:00:00.000Z',
          },
        }),
      ]);
      // One clash, reported on the later show, but both of the movie's shows are in it.
      expect(outcome.error?.message).toBe(
        "A longer running time would make 2 of this movie's showtimes overlap other showtimes",
      );
      expectNothingChanged(h, before);
    });

    it('one show running into two neighbours is 1 showtime in the message, 2 in details', async () => {
      const movie = mainMovie();
      const other = otherMovie();
      const screen = testScreen();
      const h = await begin(start, {
        movies: [movie, other],
        screens: [screen],
        // 10:00 + 120 + 15 = 12:15 fits both; + 150 = 12:45 reaches both.
        showtimes: [
          show(movie, screen, '10:00'),
          show(other, screen, '12:20'),
          show(other, screen, '12:40'),
        ],
        settings: gap(15),
      });

      const outcome = await h.patch(movie.id, { durationMinutes: 150 });

      expect(overlapDetails(outcome)).toHaveLength(2);
      expect(outcome.error?.message).toBe(
        "A longer running time would make 1 of this movie's showtimes overlap other showtimes",
      );
    });

    it('a neighbour two shows run into counts each show once, not per clash', async () => {
      const movie = mainMovie();
      const other = otherMovie();
      const screen = testScreen();
      const h = await begin(start, {
        movies: [movie, other],
        screens: [screen],
        // At 120 all fit: 10:00 reaches 12:15, 12:20 reaches 14:35. At 300 the first reaches 15:15
        // and the second 17:35, so all 3 pairs clash, and only 2 of them are this movie's shows.
        showtimes: [
          show(movie, screen, '10:00'),
          show(movie, screen, '12:20'),
          show(other, screen, '14:40'),
        ],
        settings: gap(15),
      });

      const outcome = await h.patch(movie.id, { durationMinutes: 300 });

      expect(overlapDetails(outcome)).toHaveLength(3);
      expect(outcome.error?.message).toBe(
        "A longer running time would make 2 of this movie's showtimes overlap other showtimes",
      );
    });

    describe('neighbours', () => {
      it('on another screen: 200', async () => {
        const movie = mainMovie();
        const other = otherMovie();
        const screen = testScreen({ name: 'Screen 1' });
        const elsewhere = testScreen({ name: 'Screen 2' });
        const h = await begin(start, {
          movies: [movie, other],
          screens: [screen, elsewhere],
          showtimes: [show(movie, screen, '10:00'), show(other, elsewhere, '12:30')],
        });

        expect((await h.patch(movie.id, { durationMinutes: 150 })).status).toBe(200);

        // Only the screen of the movie's own show is locked.
        expect(screenLocks(h.db)).toEqual([{ table: 'Screen', id: screen.id }]);
      });

      it('soft-deleted: 200', async () => {
        const movie = mainMovie();
        const other = otherMovie();
        const screen = testScreen();
        const h = await begin(start, {
          movies: [movie, other],
          screens: [screen],
          showtimes: [
            show(movie, screen, '10:00'),
            show(other, screen, '12:30', { deletedAt: TRASHED_AT }),
          ],
        });

        expect((await h.patch(movie.id, { durationMinutes: 150 })).status).toBe(200);
      });

      it.each<[string, Partial<Movie>]>([
        ['inactive', { isActive: false }],
        ['ENDED', { status: 'ENDED' }],
        ['soft-deleted', { deletedAt: TRASHED_AT }],
      ])('of a movie that is %s: 409, it occupies the screen', async (_name, overrides) => {
        const movie = mainMovie();
        const other = otherMovie(overrides);
        const screen = testScreen();
        const neighbour = show(other, screen, '12:30');
        const h = await begin(start, {
          movies: [movie, other],
          screens: [screen],
          showtimes: [show(movie, screen, '10:00'), neighbour],
        });
        const before = snapshot(h.db);

        const outcome = await h.patch(movie.id, { durationMinutes: 150 });

        expect(overlapDetails(outcome)[0]?.conflict.showtimeId).toBe(neighbour.id);
        expectNothingChanged(h, before);
      });
    });

    describe('only future shows of this movie are candidates', () => {
      it('a soft-deleted future show is not', async () => {
        const movie = mainMovie();
        const other = otherMovie();
        const screen = testScreen();
        const h = await begin(start, {
          movies: [movie, other],
          screens: [screen],
          showtimes: [
            show(movie, screen, '10:00', { deletedAt: TRASHED_AT }),
            show(other, screen, '12:30'),
          ],
        });

        expect((await h.patch(movie.id, { durationMinutes: 150 })).status).toBe(200);

        expect(screenLocks(h.db)).toEqual([]);
      });

      it('a past show is not', async () => {
        const movie = mainMovie();
        const other = otherMovie();
        const screen = testScreen();
        const h = await begin(start, {
          movies: [movie, other],
          screens: [screen],
          showtimes: [
            show(movie, screen, '08:00', {}, TODAY),
            show(other, screen, '10:30', {}, TODAY),
          ],
        });

        expect((await h.patch(movie.id, { durationMinutes: 150 })).status).toBe(200);

        expect(screenLocks(h.db)).toEqual([]);
      });

      it.each<[string, string]>([
        ['running now', '14:30'],
        ['starting exactly now', '15:30'],
      ])('a show %s is not', async (_name, time) => {
        const movie = mainMovie();
        const other = otherMovie();
        const screen = testScreen();
        const h = await begin(start, {
          movies: [movie, other],
          screens: [screen],
          // Each fits at 120 minutes (+ 15 gap) and would not at 150.
          showtimes: [
            show(movie, screen, time, {}, TODAY),
            show(other, screen, time === '14:30' ? '17:00' : '18:00', {}, TODAY),
          ],
        });

        expect((await h.patch(movie.id, { durationMinutes: 150 })).status).toBe(200);
      });

      it('a show running now keeps its stored length against a later show of this movie', async () => {
        const movie = mainMovie();
        const screen = testScreen();
        const h = await begin(start, {
          movies: [movie],
          screens: [screen],
          // 14:30 + 120 + 15 = 16:45 fits; at 130 it would reach 16:55, past the 16:50 show.
          showtimes: [
            show(movie, screen, '14:30', {}, TODAY),
            show(movie, screen, '16:50', {}, TODAY),
          ],
        });

        expect((await h.patch(movie.id, { durationMinutes: 130 })).status).toBe(200);
      });
    });

    describe('the gap comes from the Setting row', () => {
      it.each([0, 15, 120])('gap %i: touching fits, a minute less clashes', async (minutes) => {
        const touching = new Date(colombo(DAY, '12:10').getTime() + minutes * 60_000);
        const movie = mainMovie();
        const other = otherMovie();
        const screen = testScreen();
        const seed = (startsAt: Date): Seed => ({
          movies: [movie, other],
          screens: [screen],
          showtimes: [
            show(movie, screen, '10:00'),
            testShowtime({ movieId: other.id, screenId: screen.id, startsAt }),
          ],
          settings: gap(minutes),
        });

        const fits = await begin(start, seed(touching));
        expect((await fits.patch(movie.id, { durationMinutes: 130 })).status).toBe(200);

        const clashes = await begin(start, seed(new Date(touching.getTime() - 60_000)));
        const outcome = await clashes.patch(movie.id, { durationMinutes: 130 });
        const [detail] = overlapDetails(outcome);
        if (minutes > 0) {
          expect(detail?.message).toContain(`counting the ${String(minutes)}-minute gap`);
        } else {
          expect(detail?.message).not.toContain('gap');
        }
      });

      it('no row: the default gap of 15', async () => {
        const movie = mainMovie();
        const other = otherMovie();
        const screen = testScreen();
        const h = await begin(start, {
          movies: [movie, other],
          screens: [screen],
          // 10:00 + 135 + 15 = 12:30; at 136 it no longer fits.
          showtimes: [show(movie, screen, '10:00'), show(other, screen, '12:30')],
        });

        expect((await h.patch(movie.id, { durationMinutes: 136 })).status).toBe(409);
        expect((await h.patch(movie.id, { durationMinutes: 135 })).status).toBe(200);
      });
    });

    it('locks Movie, then the sorted Screens, before reading the gap and the shows', async () => {
      const movie = mainMovie();
      const other = otherMovie();
      const low = testScreen({ name: 'Low' });
      const high = testScreen({ name: 'High' });
      expect(low.id < high.id).toBe(true);
      const h = await begin(start, {
        movies: [movie, other],
        screens: [high, low],
        // High first by time and by insertion, so only sorting can put Low first.
        showtimes: [
          show(movie, high, '10:00'),
          show(movie, low, '20:00'),
          show(other, high, '12:30'),
        ],
      });
      const expected = [
        { table: 'Movie', id: movie.id },
        { table: 'Screen', id: low.id },
        { table: 'Screen', id: high.id },
      ];
      let locksAtGapRead: unknown;
      h.db.injectFault('setting', 'findUnique', {
        before: () => {
          locksAtGapRead = [...h.db.locks];
        },
      });

      expect((await h.patch(movie.id, { durationMinutes: 150 })).status).toBe(409);

      expect(h.db.locks).toEqual(expected);
      expect(locksAtGapRead).toEqual(expected);
    });

    it('details are capped at 50, with the true total in the message', async () => {
      const movie = mainMovie();
      const other = otherMovie();
      const screen = testScreen();
      const showtimes = Array.from({ length: 60 }, (_, day) => addDays(DAY, day)).flatMap(
        (date) => [show(movie, screen, '10:00', {}, date), show(other, screen, '12:30', {}, date)],
      );
      const h = await begin(start, {
        movies: [movie, other],
        screens: [screen],
        showtimes,
      });
      const before = snapshot(h.db);

      const outcome = await h.patch(movie.id, { durationMinutes: 150 });

      expect(overlapDetails(outcome)).toHaveLength(50);
      expect(outcome.error?.message).toBe(
        "A longer running time would make 60 of this movie's showtimes overlap other showtimes. Showing the first 50 of 60 conflicts.",
      );
      expectNothingChanged(h, before);
    });

    it('a taken slug in the same PATCH is answered first, without a screen lock', async () => {
      const movie = mainMovie();
      const other = otherMovie();
      const screen = testScreen();
      const h = await begin(start, {
        movies: [movie, other],
        screens: [screen],
        showtimes: [show(movie, screen, '10:00'), show(other, screen, '12:30')],
      });
      const before = snapshot(h.db);

      const outcome = await h.patch(movie.id, { durationMinutes: 150, slug: other.slug });

      expect(outcome).toMatchObject({ status: 409, error: { message: SLUG_IN_USE_MESSAGE } });
      expect(screenLocks(h.db)).toEqual([]);
      expectNothingChanged(h, before);
    });

    describe('the length is decided under the Movie lock', () => {
      it('another admin got there first: now a no-op, 200 with no write', async () => {
        const movie = mainMovie();
        const h = await begin(start, { movies: [movie] });
        h.db.injectFault('$queryRaw', 'lock', {
          before: () => {
            const row = storedMovie(h.db, movie.id);
            if (row) row.durationMinutes = 150;
          },
        });

        expect((await h.patch(movie.id, { durationMinutes: 150 })).status).toBe(200);

        expect(h.db.spies.movie.update).not.toHaveBeenCalled();
        expect(movieAudits(h.db)).toEqual([]);
      });

      it('what looked like a decrease is an increase by now: checked, 409', async () => {
        const movie = mainMovie({ durationMinutes: 150 });
        const other = otherMovie();
        const screen = testScreen();
        const neighbour = show(other, screen, '12:30');
        const h = await begin(start, {
          movies: [movie, other],
          screens: [screen],
          showtimes: [show(movie, screen, '10:00'), neighbour],
        });
        // Shortened to 100 by someone else after our first read, so 140 now lengthens it:
        // 10:00 + 100 + 15 fits, 10:00 + 140 + 15 = 12:55 does not.
        h.db.injectFault('$queryRaw', 'lock', {
          before: () => {
            const row = storedMovie(h.db, movie.id);
            if (row) row.durationMinutes = 100;
          },
        });

        const outcome = await h.patch(movie.id, { durationMinutes: 140 });

        expect(overlapDetails(outcome)[0]?.conflict.showtimeId).toBe(neighbour.id);
        expect(storedMovie(h.db, movie.id)?.durationMinutes).toBe(100);
      });

      it('soft-deleted while waiting for the lock: "restore first", no check', async () => {
        const movie = mainMovie();
        const h = await begin(start, { movies: [movie] });
        h.db.injectFault('$queryRaw', 'lock', {
          before: () => {
            const row = storedMovie(h.db, movie.id);
            if (row) row.deletedAt = TRASHED_AT;
          },
        });

        const outcome = await h.patch(movie.id, { durationMinutes: 150 });

        expect(outcome).toMatchObject({ status: 409, error: { code: 'CONFLICT' } });
        expect(h.db.spies.showtime.findMany).not.toHaveBeenCalled();
      });
    });
  });

  describe('edits that never run the check', () => {
    /** A movie whose show already clashes at any length: a check would have something to find. */
    const clashing = (durationMinutes = 120) => {
      const movie = mainMovie({ durationMinutes });
      const other = otherMovie();
      const screen = testScreen();
      return {
        movie,
        seed: {
          movies: [movie, other],
          screens: [screen],
          showtimes: [show(movie, screen, '10:00'), show(other, screen, '10:30')],
        },
      };
    };

    it('a decrease: 200, the Movie lock only', async () => {
      const { movie, seed } = clashing();
      const h = await begin(start, seed);

      expect((await h.patch(movie.id, { durationMinutes: 90 })).status).toBe(200);

      expect(storedMovie(h.db, movie.id)?.durationMinutes).toBe(90);
      expectNoOverlapCheck(h.db);
      expect(h.db.locks).toEqual([{ table: 'Movie', id: movie.id }]);
    });

    it('an unchanged length: 200, no lock, no write', async () => {
      const { movie, seed } = clashing();
      const h = await begin(start, seed);

      expect((await h.patch(movie.id, { durationMinutes: 120 })).status).toBe(200);

      expectNoOverlapCheck(h.db);
      expect(h.db.locks).toEqual([]);
      expect(h.db.spies.movie.update).not.toHaveBeenCalled();
    });

    it('a title-only PATCH: 200, no lock', async () => {
      const { movie, seed } = clashing();
      const h = await begin(start, seed);

      expect((await h.patch(movie.id, { title: 'New Title' })).status).toBe(200);

      expectNoOverlapCheck(h.db);
      expect(h.db.locks).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Only through the routes
// ---------------------------------------------------------------------------

describe('through the routes only', () => {
  it('after POST /showtimes/bulk-delete of its shows, the soft delete succeeds', async () => {
    const movie = mainMovie();
    const screen = testScreen();
    const first = show(movie, screen, '10:00');
    const second = show(movie, screen, '20:00');
    const b = await signIn({ movies: [movie], screens: [screen], showtimes: [first, second] });

    const refused = await b.send('delete', `/movies/${movie.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error: {
        code: 'CONFLICT',
        message: MOVIE_DELETE_HAS_SHOWTIMES_MESSAGE,
        details: { futureShowtimeCount: 2 },
      },
    });

    const cleared = await b.send('post', '/showtimes/bulk-delete', { ids: [first.id, second.id] });
    expect(cleared.status).toBe(200);

    expect((await b.send('delete', `/movies/${movie.id}`)).status).toBe(200);
  });

  it('an EDITOR is still refused the permanent delete (403), with future shows too', async () => {
    const movie = mainMovie({ deletedAt: TRASHED_AT });
    const screen = testScreen();
    const b = await signIn(
      { movies: [movie], screens: [screen], showtimes: [show(movie, screen, '10:00')] },
      'EDITOR',
    );

    const res = await b.send('delete', `/movies/${movie.id}/permanent`);

    expect(res.status).toBe(403);
    expect(b.db.spies.showtime.count).not.toHaveBeenCalled();
    expect(b.db.locks).toEqual([]);
    expect(b.db.movies).toHaveLength(1);
    expect(b.db.showtimes).toHaveLength(1);
  });

  it('an EDITOR can make the length change the same rule applies to', async () => {
    const movie = mainMovie();
    const other = otherMovie();
    const screen = testScreen();
    const b = await signIn(
      {
        movies: [movie, other],
        screens: [screen],
        showtimes: [show(movie, screen, '10:00'), show(other, screen, '12:30')],
      },
      'EDITOR',
    );

    const refused = await b.send('patch', `/movies/${movie.id}`, { durationMinutes: 150 });
    expect(refused.status).toBe(409);

    const allowed = await b.send('patch', `/movies/${movie.id}`, { durationMinutes: 135 });
    expect(allowed.status).toBe(200);
  });

  it('validation still answers first: a bad length is a 400 with no lock', async () => {
    const movie = mainMovie();
    const b = await signIn({ movies: [movie] });

    const res = await b.send('patch', `/movies/${movie.id}`, { durationMinutes: 0 });

    expect(res.status).toBe(400);
    expect(b.db.locks).toEqual([]);
  });

  it('routes/index.ts wires the logger: an invalid stored gap falls back to 15', async () => {
    const movie = mainMovie();
    const other = otherMovie();
    const screen = testScreen();
    const b = await signIn({
      movies: [movie, other],
      screens: [screen],
      showtimes: [show(movie, screen, '10:00'), show(other, screen, '12:30')],
      settings: [testSetting('showGapMinutes', 'not-a-number')],
    });

    const res = await b.send('patch', `/movies/${movie.id}`, { durationMinutes: 136 });

    expect(res.status).toBe(409);
  });
});

describe('movieLengthOverlapMessage', () => {
  it.each([
    [1, 1, "would make 1 of this movie's showtimes overlap another showtime"],
    [1, 2, "would make 1 of this movie's showtimes overlap other showtimes"],
    [2, 1, "would make 2 of this movie's showtimes overlap other showtimes"],
    [2, 3, "would make 2 of this movie's showtimes overlap other showtimes"],
    [50, 50, "would make 50 of this movie's showtimes overlap other showtimes"],
    [
      51,
      51,
      "would make 51 of this movie's showtimes overlap other showtimes. Showing the first 50 of 51 conflicts.",
    ],
    [
      10,
      60,
      "would make 10 of this movie's showtimes overlap other showtimes. Showing the first 50 of 60 conflicts.",
    ],
  ])('%i shows, %i clashes', (showCount, clashCount, message) => {
    expect(movieLengthOverlapMessage(showCount, clashCount)).toBe(
      `A longer running time ${message}`,
    );
  });
});
