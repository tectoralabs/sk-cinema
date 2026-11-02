/**
 * Phase 5 T17: what the foreign keys of Showtime really do on Postgres 18, which the in-memory
 * fake can only imitate.
 *   1. Permanent delete (PLAN.md Phase 5, carried from Phase 4): removes the movie's past and
 *      soft-deleted showtimes with it, audits the count, and is refused while a future show exists.
 *   2. `Showtime.movieId` is ON DELETE CASCADE, independently of the service's explicit deleteMany.
 *   3. `Showtime.screenId` is ON DELETE RESTRICT, and throws what helpers.ts restrictError models.
 */
import { afterAll, beforeEach, expect, it } from 'vitest';
import { MemoryCache } from '../../lib/cache.js';
import { AppError } from '../../lib/errors.js';
import type { AuditActor } from '../../services/audit.service.js';
import {
  MOVIE_HARD_DELETE_HAS_SHOWTIMES_MESSAGE,
  createMovieAdminService,
} from '../../services/movie.admin.service.js';
import { restrictError, silentLogger } from '../helpers.js';
import { describePg, disconnectTestPrisma, resetDatabase, testPrisma } from './db.js';

/** The injected clock: 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');
const YESTERDAY = new Date('2026-10-31T10:00:00.000Z');
const TOMORROW = new Date('2026-11-02T10:00:00.000Z');
const NEXT_WEEK = new Date('2026-11-08T10:00:00.000Z');

const service = () =>
  createMovieAdminService({
    db: testPrisma(),
    cache: new MemoryCache(),
    logger: silentLogger,
    now: () => NOW,
  });

async function fixtures() {
  const prisma = testPrisma();
  const admin = await prisma.admin.create({
    data: { email: 'pg-admin@skcinema.lk', name: 'PG', passwordHash: '$argon2id$placeholder' },
  });
  const trashed = await prisma.movie.create({
    data: { slug: 'gone', title: 'Gone', durationMinutes: 120, deletedAt: YESTERDAY },
  });
  const other = await prisma.movie.create({
    data: { slug: 'other', title: 'Other', durationMinutes: 120 },
  });
  const screen = await prisma.screen.create({ data: { name: 'Screen 1' } });
  const by: AuditActor = { adminId: admin.id, ipAddress: '203.0.113.7', userAgent: 'pg test' };
  return { trashed, other, screen, by };
}

describePg('permanent delete of a movie on real Postgres', () => {
  beforeEach(resetDatabase);
  afterAll(disconnectTestPrisma);

  it("Permanent delete removes the movie's showtimes", async () => {
    const prisma = testPrisma();
    const { trashed, other, screen, by } = await fixtures();
    await prisma.showtime.createMany({
      data: [
        { movieId: trashed.id, screenId: screen.id, startsAt: YESTERDAY },
        { movieId: trashed.id, screenId: screen.id, startsAt: TOMORROW, deletedAt: YESTERDAY },
        { movieId: trashed.id, screenId: screen.id, startsAt: NEXT_WEEK, deletedAt: YESTERDAY },
      ],
    });
    const kept = await prisma.showtime.create({
      data: { movieId: other.id, screenId: screen.id, startsAt: TOMORROW },
    });

    await service().hardDelete(trashed.id, by);

    expect(await prisma.movie.findUnique({ where: { id: trashed.id } })).toBeNull();
    // Every row of that movie is gone, and only those.
    const left = await prisma.showtime.findMany({ select: { id: true } });
    expect(left).toEqual([{ id: kept.id }]);
    const audits = await prisma.auditLog.findMany({
      select: { action: true, entity: true, entityId: true, adminId: true, details: true },
    });
    expect(audits).toEqual([
      {
        action: 'DELETE',
        entity: 'Movie',
        entityId: trashed.id,
        adminId: by.adminId,
        details: { mode: 'hard', title: 'Gone', slug: 'gone', showtimesDeleted: 3 },
      },
    ]);
  });

  it('a permanent delete with a future showtime is a 409 with the count, and changes nothing', async () => {
    const prisma = testPrisma();
    const { trashed, screen, by } = await fixtures();
    await prisma.showtime.createMany({
      data: [
        { movieId: trashed.id, screenId: screen.id, startsAt: YESTERDAY },
        { movieId: trashed.id, screenId: screen.id, startsAt: TOMORROW },
        { movieId: trashed.id, screenId: screen.id, startsAt: NEXT_WEEK, deletedAt: YESTERDAY },
      ],
    });
    const movieBefore = await prisma.movie.findUniqueOrThrow({ where: { id: trashed.id } });
    const showtimesBefore = await prisma.showtime.findMany({ orderBy: { id: 'asc' } });

    const error = await service()
      .hardDelete(trashed.id, by)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      status: 409,
      message: MOVIE_HARD_DELETE_HAS_SHOWTIMES_MESSAGE,
      // Only the live future show counts: not the past one, nor the soft-deleted one.
      details: { futureShowtimeCount: 1 },
    });
    expect(await prisma.movie.findUniqueOrThrow({ where: { id: trashed.id } })).toEqual(
      movieBefore,
    );
    expect(await prisma.showtime.findMany({ orderBy: { id: 'asc' } })).toEqual(showtimesBefore);
    expect(await prisma.auditLog.count()).toBe(0);
  });
});

describePg('the foreign keys of Showtime on real Postgres', () => {
  beforeEach(resetDatabase);
  afterAll(disconnectTestPrisma);

  it('a raw movie.delete removes its showtimes, soft-deleted too: the database rule itself', async () => {
    const prisma = testPrisma();
    const { trashed, other, screen } = await fixtures();
    await prisma.showtime.createMany({
      data: [
        { movieId: trashed.id, screenId: screen.id, startsAt: TOMORROW },
        { movieId: trashed.id, screenId: screen.id, startsAt: NEXT_WEEK, deletedAt: YESTERDAY },
      ],
    });
    const kept = await prisma.showtime.create({
      data: { movieId: other.id, screenId: screen.id, startsAt: TOMORROW },
    });

    await prisma.movie.delete({ where: { id: trashed.id } });

    const left = await prisma.showtime.findMany({ select: { id: true } });
    expect(left).toEqual([{ id: kept.id }]);
  });

  /** What matters of a known request error, comparable between real and fake. */
  function shapeOf(error: unknown) {
    const { name, code, message, meta } = error as {
      name: string;
      code: string;
      message: string;
      meta: { modelName: string; driverAdapterError: { name: string; cause: unknown } };
    };
    return {
      name,
      code,
      // The real message starts with where it was called from; the fake's has no such prefix.
      message: message.trim().split('\n').at(-1),
      modelName: meta.modelName,
      driverError: meta.driverAdapterError.name,
      cause: meta.driverAdapterError.cause,
    };
  }

  it.each([
    ['a live showtime', null],
    ['only a soft-deleted showtime', YESTERDAY],
  ])('a raw screen.delete with %s throws the P2003 the fake models', async (_, deletedAt) => {
    const prisma = testPrisma();
    const { other, screen } = await fixtures();
    const show = await prisma.showtime.create({
      data: { movieId: other.id, screenId: screen.id, startsAt: TOMORROW, deletedAt },
    });

    const error = await prisma.screen.delete({ where: { id: screen.id } }).catch((e: unknown) => e);

    expect(shapeOf(error)).toEqual(shapeOf(restrictError('screen', 'showtime', 'screenId')));
    expect(error).toMatchObject({
      code: 'P2003',
      meta: {
        modelName: 'Screen',
        driverAdapterError: { cause: { constraint: { index: 'Showtime_screenId_fkey' } } },
      },
    });
    expect(await prisma.screen.count()).toBe(1);

    // Only the showtime was in the way.
    await prisma.showtime.delete({ where: { id: show.id } });
    await prisma.screen.delete({ where: { id: screen.id } });
    expect(await prisma.screen.count()).toBe(0);
  });
});
