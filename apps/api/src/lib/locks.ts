import type { Prisma } from '../generated/prisma/client.js';

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
 */

/** What the lock helpers need: the raw tagged-template query of a transaction client. */
export type LockClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** Locks the Movie row. Resolves `true` if it exists (soft-deleted or not), else `false`. */
export async function lockMovie(tx: LockClient, movieId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Movie" WHERE "id" = ${movieId}::uuid FOR UPDATE`;
  return rows.length > 0;
}

/** Locks the Screen row. Resolves `true` if it exists (soft-deleted or not), else `false`. */
export async function lockScreen(tx: LockClient, screenId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Screen" WHERE "id" = ${screenId}::uuid FOR UPDATE`;
  return rows.length > 0;
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
