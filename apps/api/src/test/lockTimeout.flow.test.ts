/**
 * Phase 5 T19a (S5-04): a row lock that cannot be taken within the lock wait limit answers 409
 * "The schedule is busy" on every writer that locks, with nothing written, audited or dropped
 * from the cache. The wait limit itself (`SET LOCAL lock_timeout`) is issued once per
 * transaction before the first lock. Run against the in-memory fake, which injects the
 * Postgres 55P03 error as Prisma 7.10.1 + adapter-pg raise it; the real wait is T19b.
 */
import { apiErrorSchema } from '@sk-cinema/shared';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCK_BUSY_MESSAGE } from '../lib/locks.js';
import { CSRF_HEADER } from '../middleware/csrf.js';
import { PUBLIC_MOVIES_CACHE_PREFIX } from '../services/movie.public.service.js';
import {
  ADMIN_BASE,
  ADMIN_ORIGIN,
  TEST_USER_AGENT,
  authClient,
  buildTestApp,
  inMemoryAuthDb,
  lockTimeoutError,
  sessionFrom,
  testAdmin,
  testMovie,
  testPasswordHash,
  testScreen,
  testSetting,
  testShowtime,
} from './helpers.js';

const EMAIL = 'admin@skcinema.lk';
const PASSWORD = 'correct horse battery staple';
const NOW = new Date('2026-11-01T10:00:00.000Z');
const colombo = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);
const CACHED_KEY = `${PUBLIC_MOVIES_CACHE_PREFIX}list:all`;

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

async function scene() {
  const admin = testAdmin({ email: EMAIL, passwordHash, role: 'SUPER_ADMIN' });
  const movie = testMovie({ slug: 'main', title: 'Main', durationMinutes: 120 });
  const other = testMovie({ slug: 'other', title: 'Other', durationMinutes: 100 });
  const screen = testScreen({ name: 'Screen 1' });
  const second = testScreen({ name: 'Screen 2' });
  const show = testShowtime({
    movieId: movie.id,
    screenId: screen.id,
    startsAt: colombo('2026-11-02', '10:00'),
  });
  const db = inMemoryAuthDb({
    admins: [admin],
    movies: [movie, other],
    screens: [screen, second],
    showtimes: [show],
    settings: [testSetting('showGapMinutes', '15')],
  });
  const { app, cache } = buildTestApp({ prisma: db.prisma });
  const client = await authClient(app);
  const login = await client.post('/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  expect(login.status).toBe(200);
  const session = sessionFrom(login);
  const send = (method: 'post' | 'patch' | 'delete', path: string, body?: object) => {
    const req = request(app)
      [method](`${ADMIN_BASE}${path}`)
      .set('User-Agent', TEST_USER_AGENT)
      .set('Cookie', [client.csrf.cookie, session.access].join('; '))
      .set('Origin', ADMIN_ORIGIN)
      .set(CSRF_HEADER, client.csrf.token);
    return body === undefined ? req : req.send(body);
  };
  cache.set(CACHED_KEY, ['cached'], 60_000);
  return { db, cache, send, movie, other, screen, second, show };
}

type Scene = Awaited<ReturnType<typeof scene>>;

const WRITERS: [string, (s: Scene) => PromiseLike<request.Response>][] = [
  [
    'POST /showtimes',
    (s) =>
      s.send('post', '/showtimes', {
        movieId: s.other.id,
        screenId: s.second.id,
        date: '2026-11-03',
        time: '12:00',
      }),
  ],
  [
    'POST /showtimes/bulk',
    (s) =>
      s.send('post', '/showtimes/bulk', {
        movieId: s.other.id,
        screenId: s.second.id,
        dateFrom: '2026-11-03',
        dateTo: '2026-11-04',
        times: ['12:00'],
      }),
  ],
  [
    'PATCH /showtimes/:id',
    (s) => s.send('patch', `/showtimes/${s.show.id}`, { date: '2026-11-03', time: '12:00' }),
  ],
  [
    'PATCH /screens/:id/active (hide)',
    (s) => s.send('patch', `/screens/${s.second.id}/active`, { isActive: false }),
  ],
  ['DELETE /screens/:id', (s) => s.send('delete', `/screens/${s.second.id}`)],
  ['DELETE /movies/:id', (s) => s.send('delete', `/movies/${s.other.id}`)],
  [
    'PATCH /movies/:id (a longer running time)',
    (s) => s.send('patch', `/movies/${s.movie.id}`, { durationMinutes: 150 }),
  ],
];

describe('a lock that cannot be taken in time', () => {
  it.each(WRITERS)('%s: 409, nothing written, audited or invalidated', async (_name, write) => {
    const s = await scene();
    const before = {
      movies: structuredClone(s.db.movies),
      screens: structuredClone(s.db.screens),
      showtimes: structuredClone(s.db.showtimes),
    };
    s.db.injectFault('$queryRaw', 'lock', { error: lockTimeoutError() });

    const res = await write(s);

    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(res.body)).toEqual({
      error: { code: 'CONFLICT', message: LOCK_BUSY_MESSAGE },
    });
    expect(s.db.movies).toEqual(before.movies);
    expect(s.db.screens).toEqual(before.screens);
    expect(s.db.showtimes).toEqual(before.showtimes);
    expect(s.db.auditLogs.filter((row) => row.entity !== 'Admin')).toEqual([]);
    expect(s.cache.get(CACHED_KEY)).toEqual(['cached']);
  });

  it.each(WRITERS)(
    '%s: the wait limit is set once, before the first lock',
    async (_name, write) => {
      const s = await scene();

      await write(s);

      expect(s.db.lockTimeouts).toEqual([{ locksBefore: 0 }]);
      expect(s.db.locks.length).toBeGreaterThan(0);
      const [setOrder] = s.db.spies.$executeRaw.mock.invocationCallOrder;
      const [firstLockOrder] = s.db.spies.$queryRaw.mock.invocationCallOrder;
      expect(setOrder).toBeLessThan(firstLockOrder ?? Infinity);
      expect(s.db.spies.$executeRaw).toHaveBeenCalledTimes(1);
    },
  );

  it('a different raw failure from a lock stays a generic 500', async () => {
    const s = await scene();
    s.db.injectFault('$queryRaw', 'lock', {
      error: Object.assign(new Error('deadlock detected'), {
        code: 'P2010',
        meta: { driverAdapterError: { cause: { code: '40P01' } } },
      }),
    });

    const res = await s.send('post', '/showtimes', {
      movieId: s.other.id,
      screenId: s.second.id,
      date: '2026-11-03',
      time: '12:00',
    });

    expect(res.status).toBe(500);
    expect(apiErrorSchema.parse(res.body)).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
    });
    expect(res.text).not.toContain('deadlock');
    expect(s.db.showtimes).toHaveLength(1);
    expect(s.db.auditLogs.filter((row) => row.entity !== 'Admin')).toEqual([]);
  });
});
