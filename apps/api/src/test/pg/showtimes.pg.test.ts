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
 * T12 update and bulk delete:
 *   6. a PATCH move into a neighbour is refused with 409 under the real locks and leaves the
 *      row as it was; a valid move commits with its UPDATE audit row;
 *   7. a bulk delete soft-deletes every row with one conditional updateMany and writes one
 *      DELETE audit row each, sharing a batchId.
 * T13 public listing:
 *   8. the relation filters return exactly the right rows, and a 00:30 Colombo show groups under
 *      its Colombo date, whatever the database session's time zone;
 *   9. hidden and deleted movies are a 404, an ENDED movie has no shows.
 */
import {
  adminShowtimeListQuerySchema,
  showtimeBulkCreateBodySchema,
  showtimeBulkCreateResponseSchema,
  showtimeConflictDetailsSchema,
  showtimeBulkDeleteBodySchema,
  showtimeCreateBodySchema,
  showtimeUpdateBodySchema,
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
import { createPublicShowtimeService } from '../../services/showtime.public.service.js';
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

  it('a PATCH move into a neighbour is a 409 and leaves the row unchanged; a valid move commits', async () => {
    const { movie, screen, by } = await fixtures();
    const create = (time: string) =>
      service().create(
        showtimeCreateBodySchema.parse({
          movieId: movie.id,
          screenId: screen.id,
          date: '2026-11-02',
          time,
        }),
        by,
      );
    const moving = await create('10:00');
    const neighbour = await create('19:00');
    const before = await testPrisma().showtime.findUniqueOrThrow({ where: { id: moving.id } });

    const error = await service()
      .update(moving.id, showtimeUpdateBodySchema.parse({ date: '2026-11-02', time: '17:00' }), by)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 409, message: SHOWTIME_OVERLAP_MESSAGE });
    expect(showtimeConflictDetailsSchema.parse((error as AppError).details)[0]).toMatchObject({
      path: ['body', 'time'],
      requested: { date: '2026-11-02', time: '17:00' },
      conflict: { showtimeId: neighbour.id },
    });
    expect(await testPrisma().showtime.findUniqueOrThrow({ where: { id: moving.id } })).toEqual(
      before,
    );
    expect(await testPrisma().auditLog.count({ where: { action: 'UPDATE' } })).toBe(0);

    // 16:45 + 120 + 15 = 19:00: touching the neighbour is allowed.
    const moved = await service().update(
      moving.id,
      showtimeUpdateBodySchema.parse({ date: '2026-11-02', time: '16:45', format: '3d' }),
      by,
    );
    expect(moved).toMatchObject({ time: '16:45', format: '3D' });
    const audit = await testPrisma().auditLog.findFirstOrThrow({
      where: { entity: 'Showtime', action: 'UPDATE' },
      select: { entityId: true, details: true },
    });
    expect(audit).toEqual({
      entityId: moving.id,
      details: {
        changes: {
          startsAt: { from: '2026-11-02T04:30:00.000Z', to: '2026-11-02T11:15:00.000Z' },
          format: { from: '2D', to: '3D' },
        },
      },
    });
  });

  it('a bulk delete soft-deletes every row and writes one DELETE audit row each, in one batch', async () => {
    const { movie, screen, by } = await fixtures();
    const { items } = await service().bulkCreate(
      showtimeBulkCreateBodySchema.parse({
        movieId: movie.id,
        screenId: screen.id,
        dateFrom: '2026-11-02',
        dateTo: '2026-11-04',
        times: ['10:00'],
      }),
      by,
    );
    const ids = items.map((item) => item.id);

    const result = await service().bulkDelete(showtimeBulkDeleteBodySchema.parse({ ids }), by);

    expect(result).toEqual({ deleted: 3 });
    const rows = await testPrisma().showtime.findMany({ select: { deletedAt: true } });
    expect(rows.map((row) => row.deletedAt)).toEqual([NOW, NOW, NOW]);
    const audits = await testPrisma().auditLog.findMany({
      where: { entity: 'Showtime', action: 'DELETE' },
      select: { entityId: true, details: true },
    });
    expect(new Set(audits.map((row) => row.entityId))).toEqual(new Set(ids));
    const details = audits.map((row) => row.details as Record<string, unknown> | null);
    expect(details.every((d) => d?.['mode'] === 'soft')).toBe(true);
    expect(new Set(details.map((d) => d?.['batchId'])).size).toBe(1);

    // A second bulk delete of the same rows changes nothing: 409 listing every one.
    const again = await service()
      .bulkDelete(showtimeBulkDeleteBodySchema.parse({ ids }), by)
      .catch((e: unknown) => e);
    expect(again).toMatchObject({ status: 409 });
    expect(await testPrisma().auditLog.count({ where: { action: 'DELETE' } })).toBe(3);
  });
});

describePg('public showtimes on real Postgres', () => {
  beforeEach(resetDatabase);
  afterAll(disconnectTestPrisma);

  const publicService = () =>
    createPublicShowtimeService({
      db: testPrisma(),
      settings: createSettingsService({ db: testPrisma(), logger: silentLogger }),
      cache: new MemoryCache(),
      logger: silentLogger,
      now: () => NOW,
    });

  const colombo = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);

  it('the relation filters return the right rows; a 00:30 show groups under its Colombo date', async () => {
    const prisma = testPrisma();
    const { movie, screen } = await fixtures();
    const other = await prisma.movie.create({
      data: { slug: 'other', title: 'Other', durationMinutes: 90, status: 'NOW_SHOWING' },
    });
    const hidden = await prisma.screen.create({ data: { name: 'Hidden', isActive: false } });
    const deleted = await prisma.screen.create({ data: { name: 'Deleted', deletedAt: NOW } });

    const shows = { movieId: movie.id, screenId: screen.id };
    const late = await prisma.showtime.create({
      data: { ...shows, startsAt: new Date('2026-11-01T19:00:00.000Z'), format: '2d' },
    });
    const evening = await prisma.showtime.create({
      data: { ...shows, startsAt: colombo('2026-11-02', '19:00') },
    });
    const lastDay = await prisma.showtime.create({
      data: { ...shows, startsAt: colombo('2026-12-31', '23:59') },
    });
    await prisma.showtime.createMany({
      data: [
        { ...shows, startsAt: colombo('2026-11-01', '09:00') }, // past
        { ...shows, startsAt: NOW }, // starting now
        { ...shows, startsAt: colombo('2026-11-03', '19:00'), deletedAt: NOW },
        { ...shows, startsAt: colombo('2027-01-01', '00:00') }, // beyond the 60 days
        { ...shows, screenId: hidden.id, startsAt: colombo('2026-11-04', '19:00') },
        { ...shows, screenId: deleted.id, startsAt: colombo('2026-11-05', '19:00') },
        { ...shows, movieId: other.id, startsAt: colombo('2026-11-06', '19:00') },
      ],
    });

    const service = publicService();

    expect(await service.listDates(movie.id)).toEqual(['2026-11-02', '2026-12-31']);
    expect(await service.listForDate(movie.id, '2026-11-01')).toEqual([]);
    const items = await service.listForDate(movie.id, '2026-11-02');
    expect(items.map((item) => item.id)).toEqual([late.id, evening.id]);
    expect(items[0]).toEqual({
      id: late.id,
      startsAt: '2026-11-01T19:00:00.000Z',
      time: '00:30',
      format: '2D',
      screen: { name: 'Screen 1' },
      bookingUrl:
        'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/cinema-snlk-SKCM-MT/20261102',
    });
    expect((await service.listForDate(movie.id, '2026-12-31')).map((item) => item.id)).toEqual([
      lastDay.id,
    ]);
  });

  it('hidden and deleted movies are a 404; an ENDED movie has no shows', async () => {
    const prisma = testPrisma();
    const { movie, screen } = await fixtures();
    await prisma.showtime.create({
      data: { movieId: movie.id, screenId: screen.id, startsAt: colombo('2026-11-02', '19:00') },
    });
    const expectDates = async (expected: string[]) => {
      expect(await publicService().listDates(movie.id)).toEqual(expected);
    };
    const expect404 = async () => {
      await expect(publicService().listDates(movie.id)).rejects.toMatchObject({ status: 404 });
    };

    await expectDates(['2026-11-02']);

    await prisma.movie.update({ where: { id: movie.id }, data: { isActive: false } });
    await expect404();

    await prisma.movie.update({
      where: { id: movie.id },
      data: { isActive: true, deletedAt: NOW },
    });
    await expect404();

    await prisma.movie.update({
      where: { id: movie.id },
      data: { deletedAt: null, status: 'ENDED' },
    });
    await expectDates([]);

    await prisma.movie.update({ where: { id: movie.id }, data: { status: 'UPCOMING' } });
    await expectDates(['2026-11-02']);
  });
});
