import { ERROR_CODES, type FutureShowtimesConflictDetails } from '@sk-cinema/shared';
import { Prisma } from '../generated/prisma/client.js';
import { AppError } from '../lib/errors.js';

/*
 * Checks shared by the admin services (movies, screens, showtimes).
 */

/**
 * True when `error` is Prisma's "record to update or delete not found" (P2025). A conditional
 * write matched no row: a concurrent request got there first.
 */
export const isRecordNotFound = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';

/**
 * 409 `message` with `{ futureShowtimeCount }` while the movie or screen has upcoming (startsAt
 * after `now`), non-deleted showtimes. Past and soft-deleted showtimes do not count.
 *
 * Call it only with that movie's or screen's row lock held: showtime writers lock both too, so
 * none can add a show between this count and the caller's commit.
 */
export async function refuseIfFutureShowtimes(
  tx: Pick<Prisma.TransactionClient, 'showtime'>,
  owner: { movieId: string } | { screenId: string },
  now: Date,
  message: string,
): Promise<void> {
  const futureShowtimeCount = await tx.showtime.count({
    where: { ...owner, deletedAt: null, startsAt: { gt: now } },
  });
  if (futureShowtimeCount > 0) {
    const details: FutureShowtimesConflictDetails = { futureShowtimeCount };
    throw new AppError(409, ERROR_CODES.CONFLICT, message, details);
  }
}
