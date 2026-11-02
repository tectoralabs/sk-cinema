import { futureShowtimesConflictDetailsSchema } from '@sk-cinema/shared';
import { describe, expect, it } from 'vitest';
import type { Showtime } from '../generated/prisma/client.js';
import { AppError } from '../lib/errors.js';
import {
  inMemoryAuthDb,
  recordNotFoundError,
  testMovie,
  testScreen,
  testShowtime,
  uniqueConstraintError,
} from '../test/helpers.js';
import { isRecordNotFound, refuseIfFutureShowtimes } from './adminGuards.js';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const LATER = new Date('2026-11-02T10:00:00.000Z');
const EARLIER = new Date('2026-10-30T10:00:00.000Z');
const MESSAGE = 'Clear the upcoming showtimes first';

describe('isRecordNotFound', () => {
  it('is true only for P2025', () => {
    expect(isRecordNotFound(recordNotFoundError('movie', 'an update'))).toBe(true);
    expect(isRecordNotFound(uniqueConstraintError('movie', 'slug'))).toBe(false);
    expect(isRecordNotFound(new Error('P2025'))).toBe(false);
    expect(isRecordNotFound(undefined)).toBe(false);
  });
});

describe('refuseIfFutureShowtimes', () => {
  const movie = testMovie({ slug: 'main' });
  const otherMovie = testMovie({ slug: 'other' });
  const screen = testScreen({ name: 'Screen 1' });
  const otherScreen = testScreen({ name: 'Screen 2' });

  const dbWith = (...showtimes: (Partial<Showtime> & Pick<Showtime, 'startsAt'>)[]) =>
    inMemoryAuthDb({
      movies: [movie, otherMovie],
      screens: [screen, otherScreen],
      showtimes: showtimes.map((show) =>
        testShowtime({ movieId: movie.id, screenId: screen.id, ...show }),
      ),
    }).prisma;

  it.each([
    ['a movie', { movieId: movie.id }],
    ['a screen', { screenId: screen.id }],
  ])('409 with the message and the count for %s with upcoming shows', async (_name, owner) => {
    const db = dbWith({ startsAt: LATER }, { startsAt: new Date(LATER.getTime() + 86_400_000) });

    const error = await refuseIfFutureShowtimes(db, owner, NOW, MESSAGE).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 409, code: 'CONFLICT', message: MESSAGE });
    expect(futureShowtimesConflictDetailsSchema.parse((error as AppError).details)).toEqual({
      futureShowtimeCount: 2,
    });
  });

  it('does not count past, started or soft-deleted shows, or those of another owner', async () => {
    const db = dbWith(
      { startsAt: EARLIER },
      { startsAt: NOW },
      { startsAt: LATER, deletedAt: EARLIER },
      { startsAt: LATER, movieId: otherMovie.id, screenId: otherScreen.id },
    );

    await expect(
      refuseIfFutureShowtimes(db, { movieId: movie.id }, NOW, MESSAGE),
    ).resolves.toBeUndefined();
    await expect(
      refuseIfFutureShowtimes(db, { screenId: screen.id }, NOW, MESSAGE),
    ).resolves.toBeUndefined();
  });
});
