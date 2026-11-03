import { ERROR_CODES } from '@sk-cinema/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AppError } from './errors.js';

/*
 * Row locks that serialise showtime writers (`SELECT ... FOR UPDATE`).
 *
 * Two admins creating overlapping shows on one screen at the same time would both pass the
 * overlap check if each only read the other's committed rows. Locking the Screen row (and the
 * Movie row, whose duration the check depends on) inside the transaction makes the second
 * writer wait until the first commits or rolls back, then re-read the showtimes.
 *
 * Rules:
 * - Only inside an interactive transaction (`db.$transaction(async (tx) => ...)`): a lock on
 *   the root client ends with its own statement and protects nothing. The locks are released
 *   when the transaction ends, so they work through Neon's transaction-mode pooler.
 * - Lock order, everywhere, to avoid deadlocks: the movie first, then the screens sorted by
 *   lower-cased ID (lockScreens / lockMovieAndScreens do this). Never lock a screen and then
 *   a movie in the same transaction.
 * - Lock before reading the rows the decision depends on (gap setting, existing showtimes,
 *   movie duration), so the reads see every earlier writer's commit.
 * - IDs must already be validated UUIDs (Zod `z.uuid()`); anything else is a database error.
 * - Soft-deleted rows lock too (and count as found): the caller decides what a deleted movie
 *   or screen means.
 * - Waiting is bounded: before the first lock of a transaction the helpers run
 *   `SET LOCAL lock_timeout` (LOCK_TIMEOUT), so a lock queued behind a long holder fails after
 *   that long (Postgres 55P03) instead of holding its pooled connection until the holder ends.
 *   That failure is thrown as a 409 AppError (LOCK_BUSY_MESSAGE); the transaction rolls back.
 *   The setting stays in force for the rest of the transaction.
 */

/** What the lock helpers need: the raw tagged-template queries of a transaction client. */
export type LockClient = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

/**
 * How long one lock may wait. MUST equal the literal in the SET LOCAL statement below (SET takes
 * no bind parameter, and the statement is a fixed, parameter-free template on purpose).
 */
export const LOCK_TIMEOUT = '5s';

/** 409 message when a row lock could not be taken within LOCK_TIMEOUT. */
export const LOCK_BUSY_MESSAGE = 'The schedule is busy. Try again in a moment.';

/** Transaction clients that already got their lock_timeout (one client per transaction). */
const timeoutSet = new WeakSet<object>();

/** Sets the lock wait limit once per transaction, before its first lock. */
async function ensureLockTimeout(tx: LockClient): Promise<void> {
  if (timeoutSet.has(tx)) return;
  timeoutSet.add(tx);
  await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
}

/**
 * Postgres 55P03 (lock_not_available) as Prisma 7.10.1 + adapter-pg raise it: a raw query
 * failure P2010 whose `meta.driverAdapterError.cause.code` is the SQLSTATE.
 */
function isLockTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, meta } = error as { code?: unknown; meta?: unknown };
  if (code !== 'P2010' || typeof meta !== 'object' || meta === null) return false;
  const adapterError = (meta as { driverAdapterError?: unknown }).driverAdapterError;
  if (typeof adapterError !== 'object' || adapterError === null) return false;
  const cause = (adapterError as { cause?: unknown }).cause;
  return (
    typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === '55P03'
  );
}

/** Runs one FOR UPDATE statement; a lock timeout becomes the 409, anything else propagates. */
async function lockRow(
  tx: LockClient,
  query: (tx: LockClient) => PromiseLike<{ id: string }[]>,
): Promise<boolean> {
  await ensureLockTimeout(tx);
  try {
    return (await query(tx)).length > 0;
  } catch (error) {
    if (isLockTimeout(error)) {
      throw new AppError(409, ERROR_CODES.CONFLICT, LOCK_BUSY_MESSAGE);
    }
    throw error;
  }
}

/** Locks the Movie row. Resolves `true` if it exists (soft-deleted or not), else `false`. */
export function lockMovie(tx: LockClient, movieId: string): Promise<boolean> {
  return lockRow(
    tx,
    (t) => t.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Movie" WHERE "id" = ${movieId}::uuid FOR UPDATE`,
  );
}

/** Locks the Screen row. Resolves `true` if it exists (soft-deleted or not), else `false`. */
export function lockScreen(tx: LockClient, screenId: string): Promise<boolean> {
  return lockRow(
    tx,
    (t) => t.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Screen" WHERE "id" = ${screenId}::uuid FOR UPDATE`,
  );
}

/**
 * Locks Screen rows one at a time in a fixed order: duplicates removed (case-insensitively,
 * as UUIDs) and sorted by lower-cased ID. Resolves the lower-cased IDs of the screens that
 * exist, so check with `found.has(id.toLowerCase())`. Lock the movie first, if any.
 */
export async function lockScreens(
  tx: LockClient,
  screenIds: Iterable<string>,
): Promise<ReadonlySet<string>> {
  const ids = [...new Set(Array.from(screenIds, (id) => id.toLowerCase()))].sort();
  const found = new Set<string>();
  // Sequential on purpose: the order is what prevents deadlocks.
  for (const id of ids) {
    if (await lockScreen(tx, id)) found.add(id);
  }
  return found;
}

export interface MovieAndScreenLocks {
  /** The movie row exists (soft-deleted or not). */
  movieFound: boolean;
  /** Lower-cased IDs of the screens that exist (see lockScreens). */
  screensFound: ReadonlySet<string>;
}

/** Locks the movie, then the screens in lockScreens order: the one safe order. */
export async function lockMovieAndScreens(
  tx: LockClient,
  movieId: string,
  screenIds: Iterable<string>,
): Promise<MovieAndScreenLocks> {
  const movieFound = await lockMovie(tx, movieId);
  const screensFound = await lockScreens(tx, screenIds);
  return { movieFound, screensFound };
}
