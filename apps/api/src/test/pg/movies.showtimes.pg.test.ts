/**
 * Phase 5 T15 movie writes versus showtimes, proven on real Postgres 18 where the in-memory fake
 * can only imitate them: the row locks, the overlap read and the conditional writes run on the
 * real client, and a refusal leaves the row as it was.
 *   1. a longer running time is refused with 409 for the clash it causes, and committed when it
 *      still fits exactly;
 *   2. a soft delete is refused with 409 while future showtimes exist, and succeeds once they
 *      are cleared with a bulk delete.
 * T17 owns the hard-delete cascade and the concurrency tests.
 */
import {
  futureShowtimesConflictDetailsSchema,
  movieUpdateBodySchema,
  showtimeBulkDeleteBodySchema,
  showtimeConflictDetailsSchema,
} from '@sk-cinema/shared';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { MemoryCache } from '../../lib/cache.js';
import { AppError } from '../../lib/errors.js';
import type { AuditActor } from '../../services/audit.service.js';
import {
  MOVIE_DELETE_HAS_SHOWTIMES_MESSAGE,
  createMovieAdminService,
} from '../../services/movie.admin.service.js';
import { createSettingsService } from '../../services/settings.service.js';
import { createShowtimeAdminService } from '../../services/showtime.admin.service.js';
import { silentLogger } from '../helpers.js';
import { describePg, disconnectTestPrisma, resetDatabase, testPrisma } from './db.js';

/** The injected clock: 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');
const NEXT_DAY_10_00 = new Date('2026-11-02T04:30:00.000Z');
const NEXT_DAY_12_30 = new Date('2026-11-02T07:00:00.000Z');

async function fixtures() {
  const prisma = testPrisma();
  const admin = await prisma.admin.create({
    data: { email: 'pg-admin@skcinema.lk', name: 'PG', passwordHash: '$argon2id$placeholder' },
  });
  const movie = await prisma.movie.create({
    data: { slug: 'm', title: 'Main Feature', durationMinutes: 120, status: 'NOW_SHOWING' },
  });
  const other = await prisma.movie.create({
    data: { slug: 'n', title: 'Neighbour', durationMinutes: 100, status: 'NOW_SHOWING' },
  });
  const screen = await prisma.screen.create({ data: { name: 'Screen 1' } });
  await prisma.setting.create({ data: { key: 'showGapMinutes', value: '15' } });
  const by: AuditActor = { adminId: admin.id, ipAddress: '203.0.113.7', userAgent: 'pg test' };
  return { movie, other, screen, by };
}

const movieService = () =>
  createMovieAdminService({
    db: testPrisma(),
    cache: new MemoryCache(),
    logger: silentLogger,
    now: () => NOW,
  });

const showtimeService = () =>
  createShowtimeAdminService({
    db: testPrisma(),
    settings: createSettingsService({ db: testPrisma(), logger: silentLogger }),
    cache: new MemoryCache(),
    logger: silentLogger,
    now: () => NOW,
  });

const movieAudits = () => testPrisma().auditLog.findMany({ where: { entity: 'Movie' } });

describePg('movie writes versus showtimes on real Postgres', () => {
  beforeEach(resetDatabase);
  afterAll(disconnectTestPrisma);

  it('refuses a longer running time for the clash it causes, allows one that fits', async () => {
    const { movie, other, screen, by } = await fixtures();
    await testPrisma().showtime.create({
      data: { movieId: movie.id, screenId: screen.id, startsAt: NEXT_DAY_10_00 },
    });
    const neighbour = await testPrisma().showtime.create({
      data: { movieId: other.id, screenId: screen.id, startsAt: NEXT_DAY_12_30 },
    });

    const error = await movieService()
      .update(movie.id, movieUpdateBodySchema.parse({ durationMinutes: 150, title: 'Longer' }), by)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      status: 409,
      message:
        "A longer running time would make 1 of this movie's showtimes overlap another showtime",
    });
    const details = showtimeConflictDetailsSchema.parse((error as AppError).details);
    expect(details).toEqual([
      expect.objectContaining({
        path: ['body', 'durationMinutes'],
        requested: { date: '2026-11-02', time: '10:00' },
        conflict: {
          showtimeId: neighbour.id,
          movieTitle: 'Neighbour',
          startsAt: NEXT_DAY_12_30.toISOString(),
          endsAt: '2026-11-02T08:40:00.000Z',
        },
      }),
    ]);
    expect(await testPrisma().movie.findUniqueOrThrow({ where: { id: movie.id } })).toMatchObject({
      durationMinutes: 120,
      title: 'Main Feature',
    });
    expect(await movieAudits()).toEqual([]);

    // 10:00 + 135 + 15 = 12:30: touching is allowed, and commits with its audit row.
    const updated = await movieService().update(
      movie.id,
      movieUpdateBodySchema.parse({ durationMinutes: 135 }),
      by,
    );

    expect(updated.durationMinutes).toBe(135);
    expect(await movieAudits()).toEqual([
      expect.objectContaining({
        action: 'UPDATE',
        details: { changes: { durationMinutes: { from: 120, to: 135 } } },
      }),
    ]);
  });

  it('refuses a soft delete while future showtimes exist, allows it once cleared', async () => {
    const { movie, screen, by } = await fixtures();
    // Past: does not block.
    await testPrisma().showtime.create({
      data: {
        movieId: movie.id,
        screenId: screen.id,
        startsAt: new Date('2026-11-01T04:30:00.000Z'),
      },
    });
    const future = await testPrisma().showtime.create({
      data: { movieId: movie.id, screenId: screen.id, startsAt: NEXT_DAY_10_00 },
    });

    const error = await movieService()
      .softDelete(movie.id, by)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 409, message: MOVIE_DELETE_HAS_SHOWTIMES_MESSAGE });
    expect(futureShowtimesConflictDetailsSchema.parse((error as AppError).details)).toEqual({
      futureShowtimeCount: 1,
    });
    const untouched = await testPrisma().movie.findUniqueOrThrow({ where: { id: movie.id } });
    expect(untouched.deletedAt).toBeNull();
    expect(await movieAudits()).toEqual([]);

    await showtimeService().bulkDelete(
      showtimeBulkDeleteBodySchema.parse({ ids: [future.id] }),
      by,
    );

    const deleted = await movieService().softDelete(movie.id, by);

    expect(deleted.deletedAt).toBe(NOW.toISOString());
    expect((await movieAudits()).map((row) => row.action)).toEqual(['DELETE']);
  });
});
