/**
 * Phase 5 T19b (S5-04): a row lock that stays taken answers 409 "The schedule is busy", through
 * the real routes on real Postgres 18, with a real competing transaction as the holder.
 *   1. Four writers (create, bulk create, hide a screen, a longer running time) wait at the same
 *      time, each on its own held Screen row. Each is refused with the exact 409 after about LOCK_TIMEOUT,
 *      with nothing written, audited or dropped from the cache.
 *   2. `lock_timeout` does not leak out of the rolled-back transactions into the pool, and the
 *      refused create succeeds once the lock is free.
 * `SET LOCAL lock_timeout` being accepted by Prisma + adapter-pg is proven by the 409 itself: a
 * rejected statement would be a 500, and a missing one would hang until the holder lets go.
 */
import { apiErrorSchema } from '@sk-cinema/shared';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LOCK_BUSY_MESSAGE, LOCK_TIMEOUT } from '../../lib/locks.js';
import { PUBLIC_MOVIES_CACHE_PREFIX } from '../../services/movie.public.service.js';
import { describePg, disconnectTestPrisma, resetDatabase, testPrisma } from './db.js';
import { freezeClock, signedInAdmin } from './http.js';
import { holdScreenLock, lockWaiters, untilLockWaiter } from './interleave.js';

/** 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');
const LOCK_TIMEOUT_MS = Number.parseInt(LOCK_TIMEOUT, 10) * 1000;
const CACHED_KEY = `${PUBLIC_MOVIES_CACHE_PREFIX}list:all`;

async function fixtures() {
  const prisma = testPrisma();
  // One movie and one screen per writer, each screen held by its own transaction. Several waiters
  // on ONE row do not all stop at the limit: Postgres queues them on the row's tuple lock first,
  // and a waiter that gets the tuple lock as the first one gives up starts a new wait for the
  // holder, so its total can reach twice the limit (see the report of T19b). One waiter per row
  // is the case that always ends at the limit, whatever the scheduler does.
  const movieFor = (slug: string) =>
    prisma.movie.create({
      data: { slug, title: slug, durationMinutes: 100, status: 'NOW_SHOWING' },
    });
  const screenFor = (name: string) => prisma.screen.create({ data: { name } });
  const create = await movieFor('create');
  const bulk = await movieFor('bulk');
  const longer = await movieFor('longer');
  const screens = {
    create: await screenFor('Create'),
    bulk: await screenFor('Bulk'),
    hide: await screenFor('Hide'),
    longer: await screenFor('Longer'),
  };
  await prisma.setting.create({ data: { key: 'showGapMinutes', value: '15' } });
  // The longer running time has to lock its screen: it has a future show there.
  await prisma.showtime.create({
    data: {
      movieId: longer.id,
      screenId: screens.longer.id,
      startsAt: new Date('2026-11-02T04:30:00.000Z'),
    },
  });
  const api = await signedInAdmin({ role: 'SUPER_ADMIN' });
  api.cache.set(CACHED_KEY, ['cached'], 60_000);
  return { create, bulk, longer, screens, api };
}

const stored = async () => {
  const prisma = testPrisma();
  return {
    showtimes: await prisma.showtime.count(),
    movies: await prisma.movie.findMany({ orderBy: { slug: 'asc' } }),
    screens: await prisma.screen.findMany(),
    audits: await prisma.auditLog.count({ where: { entity: { not: 'Admin' } } }),
  };
};

describePg('a held screen lock through the routes on real Postgres', () => {
  beforeEach(async () => {
    freezeClock(NOW);
    await resetDatabase();
  });
  afterEach(async () => {
    vi.useRealTimers();
    expect(await lockWaiters()).toEqual([]);
  });
  afterAll(disconnectTestPrisma);

  it('four writers, each waiting on its own held Screen row, answer the exact 409 after the limit, writing nothing', async () => {
    const { create, bulk, longer, screens, api } = await fixtures();
    const before = await stored();
    const holds = await Promise.all(
      Object.values(screens).map((screen) => holdScreenLock(screen.id)),
    );

    const timed = <T>(request: Promise<T>) => {
      const started = performance.now();
      return request.then((res) => ({ res, elapsed: performance.now() - started }));
    };
    const requests = {
      'POST /showtimes': timed(
        api.post('/showtimes', {
          movieId: create.id,
          screenId: screens.create.id,
          date: '2026-11-03',
          time: '12:00',
        }),
      ),
      'POST /showtimes/bulk': timed(
        api.post('/showtimes/bulk', {
          movieId: bulk.id,
          screenId: screens.bulk.id,
          dateFrom: '2026-11-03',
          dateTo: '2026-11-04',
          times: ['12:00'],
        }),
      ),
      'PATCH /screens/:id/active': timed(
        api.patch(`/screens/${screens.hide.id}/active`, { isActive: false }),
      ),
      'PATCH /movies/:id (a longer running time)': timed(
        api.patch(`/movies/${longer.id}`, { durationMinutes: 150 }),
      ),
    };

    let outcomes: Record<string, { status: number; body: unknown; elapsed: number }>;
    let quickRead: { status: number; elapsed: number };
    try {
      await untilLockWaiter(/FROM "(Screen|Movie)".*FOR UPDATE/s);
      const settled = await Promise.all(
        Object.entries(requests).map(async ([name, pending]) => {
          const { res, elapsed } = await pending;
          return [name, { status: res.status, body: res.body as unknown, elapsed }] as const;
        }),
      );
      outcomes = Object.fromEntries(settled);
      // The failed requests gave their pooled connections back, while the holder still holds.
      const started = performance.now();
      const read = await api.get('/screens');
      quickRead = { status: read.status, elapsed: performance.now() - started };
    } finally {
      await Promise.all(holds.map((held) => held.release()));
    }

    for (const [name, outcome] of Object.entries(outcomes)) {
      expect(outcome.status, name).toBe(409);
      expect(apiErrorSchema.parse(outcome.body), name).toEqual({
        error: { code: 'CONFLICT', message: LOCK_BUSY_MESSAGE },
      });
      // The exact body, with no details and nothing from the database.
      expect(outcome.body, name).toEqual({
        error: { code: 'CONFLICT', message: 'The schedule is busy. Try again in a moment.' },
      });
      // About LOCK_TIMEOUT: not at once, and well before the 10 s transaction timeout.
      expect(outcome.elapsed, name).toBeGreaterThanOrEqual(LOCK_TIMEOUT_MS - 300);
      expect(outcome.elapsed, name).toBeLessThan(LOCK_TIMEOUT_MS + 3000);
    }

    expect(quickRead.status).toBe(200);
    expect(quickRead.elapsed).toBeLessThan(1000);

    // Nothing written: same rows, no audit row, the cached public list still there.
    expect(await stored()).toEqual(before);
    expect(api.cache.get(CACHED_KEY)).toEqual(['cached']);

    // lock_timeout did not leak from the rolled-back transactions into the pool. Sixteen
    // concurrent reads reach every pooled connection (the pool holds at most ten).
    const limits = await Promise.all(
      Array.from(
        { length: 16 },
        () => testPrisma().$queryRaw<{ lock_timeout: string }[]>`SHOW lock_timeout`,
      ),
    );
    expect(limits.map((rows) => rows[0]?.lock_timeout)).toEqual(Array<string>(16).fill('0'));

    // With the lock free, the refused create now succeeds.
    const retry = await api.post('/showtimes', {
      movieId: create.id,
      screenId: screens.create.id,
      date: '2026-11-03',
      time: '12:00',
    });
    expect(retry.status).toBe(201);
  });
});
