/**
 * Phase 5 T10 admin showtime create / list proven on real Postgres 18, where the in-memory fake
 * can only imitate it:
 *   1. the real Prisma client accepts the create (nested movie/screen select), the overlap
 *      query and the list filters, and stores the Colombo date + time as the UTC instant;
 *   2. an overlap is refused with 409 and nothing written;
 *   3. two concurrent overlapping creates on one screen: the movie and screen row locks
 *      serialise them, so exactly one is saved and the other gets the 409.
 * T11 bulk create:
 *   4. createMany, the `startsAt IN (...)` read-back and auditLog.createMany work on real
 *      Postgres: every row returned once, sorted, one audit row each sharing a batchId;
 *   5. a clash inside the batch writes nothing.
 */
import {
  adminShowtimeListQuerySchema,
  showtimeBulkCreateBodySchema,
  showtimeBulkCreateResponseSchema,
  showtimeConflictDetailsSchema,
  showtimeCreateBodySchema,
  type ShowtimeBulkCreateBodyInput,
  type ShowtimeCreateBodyInput,
} from '@sk-cinema/shared';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { MemoryCache } from '../../lib/cache.js';
import { AppError } from '../../lib/errors.js';
import type { AuditActor } from '../../services/audit.service.js';
import { createSettingsService } from '../../services/settings.service.js';
import {
  SHOWTIME_OVERLAP_MESSAGE,
  createShowtimeAdminService,
} from '../../services/showtime.admin.service.js';
import { silentLogger } from '../helpers.js';
import { describePg, disconnectTestPrisma, resetDatabase, testPrisma } from './db.js';

/** The injected clock: 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');

async function fixtures() {
  const prisma = testPrisma();
  const admin = await prisma.admin.create({
    data: { email: 'pg-admin@skcinema.lk', name: 'PG', passwordHash: '$argon2id$placeholder' },
  });
  const movie = await prisma.movie.create({
    data: { slug: 'm', title: 'Main Feature', durationMinutes: 120, status: 'NOW_SHOWING' },
  });
  const screen = await prisma.screen.create({ data: { name: 'Screen 1' } });
  await prisma.setting.create({ data: { key: 'showGapMinutes', value: '15' } });
  const by: AuditActor = { adminId: admin.id, ipAddress: '203.0.113.7', userAgent: 'pg test' };
  return { movie, screen, by };
}

const service = () =>
  createShowtimeAdminService({
    db: testPrisma(),
    settings: createSettingsService({ db: testPrisma(), logger: silentLogger }),
    cache: new MemoryCache(),
    logger: silentLogger,
    now: () => NOW,
  });

describePg('admin showtimes on real Postgres', () => {
  beforeEach(resetDatabase);
  afterAll(disconnectTestPrisma);

  it('creates at the UTC instant, lists it under its Colombo date, refuses an overlap', async () => {
    const { movie, screen, by } = await fixtures();
    const body = (input: Partial<ShowtimeCreateBodyInput>) =>
      showtimeCreateBodySchema.parse({
        movieId: movie.id,
        screenId: screen.id,
        date: '2026-11-02',
        time: '00:30',
        ...input,
      });

    const created = await service().create(body({ format: 'imax 3d' }), by);
    expect(created).toMatchObject({
      startsAt: '2026-11-01T19:00:00.000Z',
      colomboDate: '2026-11-02',
      time: '00:30',
      format: 'IMAX 3D',
      movie: { title: 'Main Feature' },
      screen: { name: 'Screen 1' },
    });
    expect(created.bookingUrl.endsWith('/20261102')).toBe(true);
    expect(await testPrisma().auditLog.count({ where: { entity: 'Showtime' } })).toBe(1);

    const error = await service()
      .create(body({ time: '02:44' }), by)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 409, message: SHOWTIME_OVERLAP_MESSAGE });
    expect(showtimeConflictDetailsSchema.parse((error as AppError).details)[0]?.conflict).toEqual(
      expect.objectContaining({ showtimeId: created.id }),
    );
    // Touching (00:30 + 120 + 15 = 02:45) is allowed.
    await service().create(body({ time: '02:45' }), by);
    expect(await testPrisma().showtime.count()).toBe(2);

    const nov2 = await service().list(
      adminShowtimeListQuerySchema.parse({ from: '2026-11-02', to: '2026-11-02' }),
    );
    expect(nov2.items.map((item) => item.time)).toEqual(['00:30', '02:45']);
    const nov1 = await service().list(
      adminShowtimeListQuerySchema.parse({ from: '2026-11-01', to: '2026-11-01' }),
    );
    expect(nov1.total).toBe(0);
  });

  it('two concurrent overlapping creates: the locks let exactly one in', async () => {
    const { movie, screen, by } = await fixtures();
    const body = (time: string) =>
      showtimeCreateBodySchema.parse({
        movieId: movie.id,
        screenId: screen.id,
        date: '2026-11-03',
        time,
      });

    const results = await Promise.allSettled([
      service().create(body('19:00'), by),
      service().create(body('19:30'), by),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ status: 409, message: SHOWTIME_OVERLAP_MESSAGE });
    expect(await testPrisma().showtime.count()).toBe(1);
    expect(await testPrisma().auditLog.count({ where: { entity: 'Showtime' } })).toBe(1);
  });

  it('bulk creates 4 days x 2 times in one batch: rows, sorted response, audit batch', async () => {
    const { movie, screen, by } = await fixtures();
    const body = (input: Partial<ShowtimeBulkCreateBodyInput>) =>
      showtimeBulkCreateBodySchema.parse({
        movieId: movie.id,
        screenId: screen.id,
        dateFrom: '2026-11-29',
        dateTo: '2026-12-02',
        times: ['19:00', '00:30'],
        ...input,
      });

    const result = await service().bulkCreate(body({ format: '3d' }), by);

    expect(showtimeBulkCreateResponseSchema.parse(result)).toEqual(result);
    expect(result.created).toBe(8);
    expect(result.items.map((item) => `${item.colomboDate} ${item.time}`)).toEqual([
      '2026-11-29 00:30',
      '2026-11-29 19:00',
      '2026-11-30 00:30',
      '2026-11-30 19:00',
      '2026-12-01 00:30',
      '2026-12-01 19:00',
      '2026-12-02 00:30',
      '2026-12-02 19:00',
    ]);
    expect(result.items[0]).toMatchObject({ startsAt: '2026-11-28T19:00:00.000Z', format: '3D' });
    expect(result.items[0]?.bookingUrl.endsWith('/20261129')).toBe(true);

    const rows = await testPrisma().showtime.findMany({ select: { id: true } });
    expect(new Set(rows.map((row) => row.id))).toEqual(
      new Set(result.items.map((item) => item.id)),
    );
    const audits = await testPrisma().auditLog.findMany({
      where: { entity: 'Showtime', action: 'CREATE' },
      select: { entityId: true, details: true, adminId: true },
    });
    expect(audits).toHaveLength(8);
    expect(new Set(audits.map((row) => row.entityId))).toEqual(
      new Set(result.items.map((item) => item.id)),
    );
    const batchIds = new Set(
      audits.map((row) => (row.details as Record<string, unknown> | null)?.['batchId']),
    );
    expect(batchIds.size).toBe(1);
    expect(audits.every((row) => row.adminId === by.adminId)).toBe(true);
  });

  it('a bulk create with a clash inside the batch writes nothing', async () => {
    const { movie, screen, by } = await fixtures();

    const error = await service()
      .bulkCreate(
        showtimeBulkCreateBodySchema.parse({
          movieId: movie.id,
          screenId: screen.id,
          dateFrom: '2026-11-02',
          dateTo: '2026-11-04',
          times: ['10:00', '19:00', '20:00'],
        }),
        by,
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 409 });
    const details = showtimeConflictDetailsSchema.parse((error as AppError).details);
    expect(details).toHaveLength(3);
    expect(details.every((detail) => detail.conflict.showtimeId === null)).toBe(true);
    expect(await testPrisma().showtime.count()).toBe(0);
    expect(await testPrisma().auditLog.count({ where: { entity: 'Showtime' } })).toBe(0);
  });
});
