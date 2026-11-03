import { describe, expect, it } from 'vitest';
import type { Prisma } from '../generated/prisma/client.js';
import {
  LOCK_SQL,
  LOCK_TIMEOUT_SQL,
  UnsupportedByFakeError,
  inMemoryAuthDb,
  lockTimeoutError,
  testMovie,
  testScreen,
} from '../test/helpers.js';
import { AppError } from './errors.js';
import {
  LOCK_BUSY_MESSAGE,
  LOCK_TIMEOUT,
  lockMovie,
  lockMovieAndScreens,
  lockScreen,
  lockScreens,
} from './locks.js';

const MISSING_ID = '00000000-0000-7000-8000-000000000999';
// Fixed IDs so the expected lock order does not depend on generation order.
const SCREEN_A = '00000000-0000-7000-8000-00000000000a';
const SCREEN_B = '00000000-0000-7000-8000-00000000000b';
const SCREEN_C = '00000000-0000-7000-8000-00000000000c';

function cinema() {
  const movie = testMovie({ slug: 'dune', title: 'Dune', durationMinutes: 155 });
  const gone = testMovie({
    slug: 'gone',
    title: 'Gone',
    durationMinutes: 90,
    deletedAt: new Date('2026-10-01T00:00:00.000Z'),
  });
  const screens = [
    testScreen({ id: SCREEN_C, name: 'Screen C' }),
    testScreen({ id: SCREEN_A, name: 'Screen A' }),
    testScreen({
      id: SCREEN_B,
      name: 'Old Screen B',
      deletedAt: new Date('2026-10-01T00:00:00.000Z'),
    }),
  ];
  const db = inMemoryAuthDb({ movies: [movie, gone], screens });
  /** Runs `fn` in an interactive transaction on the fake. */
  const inTx = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => db.prisma.$transaction(fn);
  return { db, movie, gone, inTx };
}

describe('lockMovie / lockScreen', () => {
  it('lock the row and resolve true when it exists, false when it does not', async () => {
    const { db, movie, inTx } = cinema();
    const results = await inTx(async (tx) => [
      await lockMovie(tx, movie.id),
      await lockMovie(tx, MISSING_ID),
      await lockScreen(tx, SCREEN_A),
      await lockScreen(tx, MISSING_ID),
    ]);
    expect(results).toEqual([true, false, true, false]);
    expect(db.locks).toEqual([
      { table: 'Movie', id: movie.id },
      { table: 'Movie', id: MISSING_ID },
      { table: 'Screen', id: SCREEN_A },
      { table: 'Screen', id: MISSING_ID },
    ]);
  });

  it('send exactly the LOCK_SQL statements, with the ID as the one bound value', async () => {
    const { db, movie, inTx } = cinema();
    await inTx(async (tx) => {
      await lockMovie(tx, movie.id);
      await lockScreen(tx, SCREEN_A);
    });
    const calls = db.spies.$queryRaw.mock.calls as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ][];
    const sql = calls.map(([strings, ...values]) => ({
      text: strings.join('$1').replace(/\s+/g, ' ').trim(),
      values,
    }));
    expect(sql).toEqual([
      { text: LOCK_SQL.Movie, values: [movie.id] },
      { text: LOCK_SQL.Screen, values: [SCREEN_A] },
    ]);
  });

  it('find soft-deleted rows too (the caller decides what deleted means)', async () => {
    const { gone, inTx } = cinema();
    await inTx(async (tx) => {
      await expect(lockMovie(tx, gone.id)).resolves.toBe(true);
      await expect(lockScreen(tx, SCREEN_B)).resolves.toBe(true);
    });
  });

  it('are rejected outside a transaction (a lock there would protect nothing)', async () => {
    const { db, movie } = cinema();
    await expect(lockMovie(db.prisma, movie.id)).rejects.toBeInstanceOf(UnsupportedByFakeError);
    await expect(lockScreen(db.prisma, SCREEN_A)).rejects.toBeInstanceOf(UnsupportedByFakeError);
    expect(db.locks).toEqual([]);
  });

  it('propagate a lock failure (e.g. a lock timeout) and the transaction rolls back', async () => {
    const { db, movie, inTx } = cinema();
    const timeout = new Error('canceling statement due to lock timeout');
    db.injectFault('$queryRaw', 'lock', { onCall: 2, error: timeout });
    await expect(
      inTx(async (tx) => {
        await lockMovie(tx, movie.id);
        await tx.movie.update({ where: { id: movie.id }, data: { title: 'Never saved' } });
        await lockScreen(tx, SCREEN_A);
      }),
    ).rejects.toBe(timeout);
    expect(db.locks).toEqual([{ table: 'Movie', id: movie.id }]);
    expect(db.movies.find((m) => m.id === movie.id)?.title).toBe('Dune');
  });
});

describe('lockScreens', () => {
  it('de-dupes (case-insensitively) and locks in ID order, resolving the found IDs', async () => {
    const { db, inTx } = cinema();
    const found = await inTx((tx) =>
      lockScreens(tx, [SCREEN_C, MISSING_ID, SCREEN_A, SCREEN_C.toUpperCase(), SCREEN_B, SCREEN_A]),
    );
    expect(db.locks).toEqual([
      { table: 'Screen', id: SCREEN_A },
      { table: 'Screen', id: SCREEN_B },
      { table: 'Screen', id: SCREEN_C },
      { table: 'Screen', id: MISSING_ID },
    ]);
    expect([...found].sort()).toEqual([SCREEN_A, SCREEN_B, SCREEN_C]);
  });

  it('returns lower-cased IDs, so an upper-case input is found with toLowerCase()', async () => {
    const { inTx } = cinema();
    const input = SCREEN_C.toUpperCase();
    const found = await inTx((tx) => lockScreens(tx, [input]));
    expect(found.has(input.toLowerCase())).toBe(true);
    expect(found.has(input)).toBe(false);
  });

  it('takes no lock for no IDs', async () => {
    const { db, inTx } = cinema();
    await expect(inTx((tx) => lockScreens(tx, []))).resolves.toEqual(new Set());
    expect(db.locks).toEqual([]);
  });

  it('stops at the first failed lock', async () => {
    const { db, inTx } = cinema();
    const timeout = new Error('lock timeout');
    db.injectFault('$queryRaw', 'lock', { onCall: 2, error: timeout });
    await expect(inTx((tx) => lockScreens(tx, [SCREEN_C, SCREEN_A, SCREEN_B]))).rejects.toBe(
      timeout,
    );
    expect(db.locks).toEqual([{ table: 'Screen', id: SCREEN_A }]);
  });
});

describe('lockMovieAndScreens', () => {
  it('locks the movie first, then the screens in ID order', async () => {
    const { db, movie, inTx } = cinema();
    const result = await inTx((tx) => lockMovieAndScreens(tx, movie.id, [SCREEN_C, SCREEN_A]));
    expect(result).toEqual({ movieFound: true, screensFound: new Set([SCREEN_A, SCREEN_C]) });
    expect(db.locks).toEqual([
      { table: 'Movie', id: movie.id },
      { table: 'Screen', id: SCREEN_A },
      { table: 'Screen', id: SCREEN_C },
    ]);
  });

  it('still locks the screens when the movie is missing, and reports both', async () => {
    const { db, inTx } = cinema();
    const result = await inTx((tx) => lockMovieAndScreens(tx, MISSING_ID, [MISSING_ID]));
    expect(result).toEqual({ movieFound: false, screensFound: new Set() });
    expect(db.locks.map((lock) => lock.table)).toEqual(['Movie', 'Screen']);
  });
});

describe('the lock wait limit', () => {
  it('is set once per transaction, before the first lock, with a parameter-free statement', async () => {
    const { db, movie, inTx } = cinema();
    await inTx(async (tx) => {
      await lockMovie(tx, movie.id);
      await lockScreens(tx, [SCREEN_A, SCREEN_C]);
    });

    expect(db.lockTimeouts).toEqual([{ locksBefore: 0 }]);
    expect(db.locks).toHaveLength(3);
    const [strings, ...values] = db.spies.$executeRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join('$1').trim()).toBe(LOCK_TIMEOUT_SQL);
    expect(LOCK_TIMEOUT_SQL).toContain(`'${LOCK_TIMEOUT}'`);
    expect(values).toEqual([]);
    // Never the unsafe variants.
    expect(db.spies.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(db.spies.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('is set again in the next transaction', async () => {
    const { db, movie, inTx } = cinema();
    await inTx((tx) => lockMovie(tx, movie.id));
    await inTx((tx) => lockScreen(tx, SCREEN_A));
    expect(db.lockTimeouts).toEqual([{ locksBefore: 0 }, { locksBefore: 1 }]);
  });

  it('is not set when no lock is taken', async () => {
    const { db, inTx } = cinema();
    await inTx((tx) => lockScreens(tx, []));
    expect(db.lockTimeouts).toEqual([]);
  });

  it('turns a lock timeout (55P03) into a 409 without details, and rolls back', async () => {
    const { db, movie, inTx } = cinema();
    db.injectFault('$queryRaw', 'lock', { onCall: 2, error: lockTimeoutError() });

    const error = await inTx(async (tx) => {
      await lockMovie(tx, movie.id);
      await tx.movie.update({ where: { id: movie.id }, data: { title: 'Never saved' } });
      await lockScreen(tx, SCREEN_A);
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: LOCK_BUSY_MESSAGE,
      details: undefined,
    });
    expect(LOCK_BUSY_MESSAGE).toBe('The schedule is busy. Try again in a moment.');
    expect(db.movies.find((m) => m.id === movie.id)?.title).toBe('Dune');
  });

  const failure = (props: object) => Object.assign(new Error('driver failure'), props);
  it.each([
    [
      'a P2010 for another SQLSTATE',
      failure({ code: 'P2010', meta: { driverAdapterError: { cause: { code: '40P01' } } } }),
    ],
    [
      '55P03 under another Prisma code',
      failure({ code: 'P2034', meta: { driverAdapterError: { cause: { code: '55P03' } } } }),
    ],
    ['a P2010 without meta', failure({ code: 'P2010' })],
    ['a plain error', new Error('canceling statement due to lock timeout')],
  ])('leaves %s as it is', async (_name, thrown) => {
    const { db, movie, inTx } = cinema();
    db.injectFault('$queryRaw', 'lock', { error: thrown });
    await expect(inTx((tx) => lockMovie(tx, movie.id))).rejects.toBe(thrown);
  });
});
