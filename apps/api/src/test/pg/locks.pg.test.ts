/**
 * The row locks of lib/locks.ts on real Postgres 18: the exact SQL the in-memory fake accepts
 * (LOCK_SQL) runs, finds rows (soft-deleted too), and really blocks a second transaction that
 * locks the same Screen row until the first one ends. Short on purpose; the concurrent bulk
 * create test comes with the showtime services.
 */
import { afterAll, beforeEach, expect, it } from 'vitest';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import {
  LOCK_BUSY_MESSAGE,
  LOCK_TIMEOUT,
  lockMovie,
  lockMovieAndScreens,
  lockScreen,
} from '../../lib/locks.js';
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

/** The helpers' wait limit in ms (LOCK_TIMEOUT is '<n>s'). */
const LOCK_TIMEOUT_MS = Number.parseInt(LOCK_TIMEOUT, 10) * 1000;

/** Locks the screen through the helper, in a new transaction (its own wait limit applies). */
function tryLockScreen(screenId: string) {
  return testPrisma().$transaction((tx: Prisma.TransactionClient) => lockScreen(tx, screenId));
}

/**
 * Locks the screen with raw SQL (no helper) after a 500 ms limit of its own: the unmapped
 * Prisma error of an expired lock_timeout.
 */
function rawLockScreen(screenId: string) {
  return testPrisma().$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
    return tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Screen" WHERE "id" = ${screenId}::uuid FOR UPDATE`;
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

  it('a blocked raw FOR UPDATE fails with the Prisma P2010 / 55P03 shape the helpers map', async () => {
    const prisma = testPrisma();
    const screen = await prisma.screen.create({ data: { name: 'Screen 1' } });

    const holder = holdScreenLock(screen.id);
    try {
      await holder.locked;
      await expect(rawLockScreen(screen.id)).rejects.toMatchObject(LOCK_TIMEOUT_ERROR);
    } finally {
      holder.release();
      await holder.done.catch(() => undefined);
    }
  });

  it(
    'makes a second transaction wait for the same Screen row, then answers 409 after the limit',
    async () => {
      const prisma = testPrisma();
      const screen = await prisma.screen.create({ data: { name: 'Screen 1' } });
      const other = await prisma.screen.create({ data: { name: 'Screen 2' } });

      const holder = holdScreenLock(screen.id);
      try {
        await holder.locked;

        // Same row: the helper gives up after LOCK_TIMEOUT (about 5 s, not the 10 s transaction
        // timeout or the 15 s test timeout) with the mapped 409.
        const started = Date.now();
        const error = await tryLockScreen(screen.id).catch((e: unknown) => e);
        const elapsed = Date.now() - started;
        expect(error).toBeInstanceOf(AppError);
        expect(error).toMatchObject({ status: 409, code: 'CONFLICT', message: LOCK_BUSY_MESSAGE });
        expect(elapsed).toBeGreaterThanOrEqual(LOCK_TIMEOUT_MS - 300);
        expect(elapsed).toBeLessThan(LOCK_TIMEOUT_MS + 2000);

        // The pooled connection came back: plain reads and transactions run at once.
        const free = Date.now();
        await expect(prisma.screen.findUnique({ where: { id: screen.id } })).resolves.toMatchObject(
          { id: screen.id },
        );
        // Another screen is not blocked.
        await expect(tryLockScreen(other.id)).resolves.toBe(true);
        expect(Date.now() - free).toBeLessThan(1000);

        // A waiter with room to wait is still blocked after 300 ms, then gets the lock on commit.
        let waiterDone = false;
        const waiter = tryLockScreen(screen.id).finally(() => {
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
      await expect(tryLockScreen(screen.id)).resolves.toBe(true);
    },
    LOCK_TIMEOUT_MS + 2000,
  );
});
