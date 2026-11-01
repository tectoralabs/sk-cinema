/**
 * The row locks of lib/locks.ts on real Postgres 18: the exact SQL the in-memory fake accepts
 * (LOCK_SQL) runs, finds rows (soft-deleted too), and really blocks a second transaction that
 * locks the same Screen row until the first one ends. Short on purpose; the concurrent bulk
 * create test comes with the showtime services.
 */
import { afterAll, beforeEach, expect, it } from 'vitest';
import type { Prisma } from '../../generated/prisma/client.js';
import { lockMovie, lockMovieAndScreens, lockScreen } from '../../lib/locks.js';
import { describePg, disconnectTestPrisma, resetDatabase, testPrisma } from './db.js';

const MISSING_ID = '00000000-0000-7000-8000-000000000999';

/**
 * How Prisma 7.10.1 + adapter-pg reports an expired `lock_timeout`: a raw query failure (P2010)
 * wrapping Postgres' SQLSTATE 55P03 (lock_not_available).
 */
const LOCK_TIMEOUT_ERROR = {
  name: 'PrismaClientKnownRequestError',
  code: 'P2010',
  meta: {
    driverAdapterError: {
      cause: { code: '55P03', message: 'canceling statement due to lock timeout' },
    },
  },
};

/** A promise plus the function that resolves it. */
function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Holds the Screen row lock in its own transaction until `release()`; resolves `locked` once
 * the lock is held. `done` settles when the holder's transaction has committed.
 */
function holdScreenLock(screenId: string) {
  const locked = signal();
  const released = signal();
  const done = testPrisma().$transaction(async (tx) => {
    const found = await lockScreen(tx, screenId);
    locked.resolve();
    await released.promise;
    return found;
  });
  return { locked: locked.promise, release: released.resolve, done };
}

/** Locks the screen in a new transaction that gives up after `lockTimeout`. */
function tryLockScreen(screenId: string, lockTimeout: '500ms' | '5s') {
  return testPrisma().$transaction(async (tx: Prisma.TransactionClient) => {
    // SET cannot take a bind parameter; the value is one of two literals above.
    if (lockTimeout === '500ms') await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
    else await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
    return lockScreen(tx, screenId);
  });
}

describePg('row locks on real Postgres', () => {
  beforeEach(resetDatabase);
  afterAll(disconnectTestPrisma);

  it('finds existing rows (soft-deleted too) and returns false for a missing ID', async () => {
    const prisma = testPrisma();
    const movie = await prisma.movie.create({
      data: { slug: 'dune', title: 'Dune', durationMinutes: 155 },
    });
    const screen = await prisma.screen.create({ data: { name: 'Screen 1' } });
    const closed = await prisma.screen.create({
      data: { name: 'Old Screen', deletedAt: new Date('2026-10-01T00:00:00.000Z') },
    });

    const results = await prisma.$transaction(async (tx) => ({
      movie: await lockMovie(tx, movie.id),
      missingMovie: await lockMovie(tx, MISSING_ID),
      screen: await lockScreen(tx, screen.id),
      closed: await lockScreen(tx, closed.id),
      missingScreen: await lockScreen(tx, MISSING_ID),
      both: await lockMovieAndScreens(tx, movie.id, [
        closed.id.toUpperCase(),
        screen.id,
        MISSING_ID,
      ]),
    }));

    expect(results).toEqual({
      movie: true,
      missingMovie: false,
      screen: true,
      closed: true,
      missingScreen: false,
      both: { movieFound: true, screensFound: new Set([screen.id, closed.id]) },
    });
  });

  it('makes a second transaction wait for the same Screen row until the first commits', async () => {
    const prisma = testPrisma();
    const screen = await prisma.screen.create({ data: { name: 'Screen 1' } });
    const other = await prisma.screen.create({ data: { name: 'Screen 2' } });

    const holder = holdScreenLock(screen.id);
    try {
      await holder.locked;

      // Same row: times out while the first transaction holds the lock.
      await expect(tryLockScreen(screen.id, '500ms')).rejects.toMatchObject(LOCK_TIMEOUT_ERROR);
      // Another screen and plain reads are not blocked.
      await expect(tryLockScreen(other.id, '500ms')).resolves.toBe(true);
      await expect(prisma.screen.findUnique({ where: { id: screen.id } })).resolves.toMatchObject({
        id: screen.id,
      });

      // A waiter with room to wait is still blocked after 300 ms, then gets the lock on commit.
      let waiterDone = false;
      const waiter = tryLockScreen(screen.id, '5s').finally(() => {
        waiterDone = true;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(waiterDone).toBe(false);

      holder.release();
      await expect(holder.done).resolves.toBe(true);
      await expect(waiter).resolves.toBe(true);
    } finally {
      holder.release();
      await holder.done.catch(() => undefined);
    }

    // Released: an immediate retry succeeds.
    await expect(tryLockScreen(screen.id, '500ms')).resolves.toBe(true);
  });
});
