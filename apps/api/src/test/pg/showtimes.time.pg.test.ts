/**
 * Phase 5 T17: time handling of public and admin showtimes on real Postgres 18.
 *   1. The public query's own `startsAt > now` filter, on its own. The service filters its cache
 *      entry against the clock again on every request, which hides any break in the query, so
 *      these tests look at what the query returned, below the cache.
 *   2. `timestamptz` round trip around Colombo midnight, under several process time zones: stored
 *      and read back to the millisecond, listed under the right Colombo date, and the raw text in
 *      Postgres agrees.
 */
import { adminShowtimeListQuerySchema, showtimeCreateBodySchema } from '@sk-cinema/shared';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { MemoryCache } from '../../lib/cache.js';
import type { AuditActor } from '../../services/audit.service.js';
import { createSettingsService } from '../../services/settings.service.js';
import { createShowtimeAdminService } from '../../services/showtime.admin.service.js';
import { createPublicShowtimeService } from '../../services/showtime.public.service.js';
import { silentLogger } from '../helpers.js';
import { describePg, disconnectTestPrisma, resetDatabase, testPrisma } from './db.js';

/** The injected clock: 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');

/** Every fill goes to the query: nothing is kept, and each raw result is recorded. */
class RecordingCache extends MemoryCache {
  readonly loaded: unknown[] = [];

  override async getOrSet<T>(_key: string, _ttlMs: number, load: () => Promise<T>): Promise<T> {
    const value = await load();
    this.loaded.push(value);
    return value;
  }
}

async function showFixtures() {
  const prisma = testPrisma();
  const movie = await prisma.movie.create({
    data: { slug: 'm', title: 'Main Feature', durationMinutes: 120, status: 'NOW_SHOWING' },
  });
  const screen = await prisma.screen.create({ data: { name: 'Screen 1' } });
  return { movie, screen };
}

const settings = () => createSettingsService({ db: testPrisma(), logger: silentLogger });

describePg('the public showtime query below the cache on real Postgres', () => {
  beforeEach(resetDatabase);
  afterAll(disconnectTestPrisma);

  it('returns only shows starting strictly after now: not before, not exactly at now', async () => {
    const { movie, screen } = await showFixtures();
    const offsetsMs = [-3_600_000, -1, 0, 1, 60_000];
    await testPrisma().showtime.createMany({
      data: offsetsMs.map((offset) => ({
        movieId: movie.id,
        screenId: screen.id,
        startsAt: new Date(NOW.getTime() + offset),
      })),
    });
    const cache = new RecordingCache();
    const service = createPublicShowtimeService({
      db: testPrisma(),
      settings: settings(),
      cache,
      logger: silentLogger,
      now: () => NOW,
    });

    await service.listDates(movie.id);

    expect(cache.loaded).toHaveLength(1);
    const raw = cache.loaded[0] as { startsAtMs: number }[];
    expect(raw.map((show) => show.startsAtMs - NOW.getTime())).toEqual([1, 60_000]);
  });
});

describePg('timestamptz around Colombo midnight on real Postgres', () => {
  beforeEach(resetDatabase);
  afterAll(disconnectTestPrisma);

  const originalTz = process.env['TZ'];
  afterEach(() => {
    if (originalTz === undefined) delete process.env['TZ'];
    else process.env['TZ'] = originalTz;
  });

  const LAST_MOMENT_OF_NOV_1 = '2026-11-01T18:29:59.999Z';
  const COLOMBO_MIDNIGHT = '2026-11-01T18:30:00.000Z';
  const HALF_PAST_MIDNIGHT = '2026-11-01T19:00:00.000Z';

  /** The bookable links are per Colombo date. */
  const BMS_BASE = 'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/cinema-snlk-SKCM-MT';

  // Both sides of UTC, a half-hour offset and a zone that changes offset that very day (Los
  // Angeles leaves daylight saving at 2026-11-01T09:00Z). Offsets are at the instants above.
  it.each([
    ['UTC', 0],
    ['Asia/Colombo', -330],
    ['Pacific/Kiritimati', -840],
    ['America/Los_Angeles', 480],
  ])(
    'with TZ=%s the instants, the Colombo dates and the raw text all agree',
    async (tz, offset) => {
      process.env['TZ'] = tz;
      // Precondition: the zone really applies to this process.
      expect(new Date(COLOMBO_MIDNIGHT).getTimezoneOffset()).toBe(offset);

      const prisma = testPrisma();
      const { movie, screen } = await showFixtures();
      const admin = await prisma.admin.create({
        data: { email: 'pg-admin@skcinema.lk', name: 'PG', passwordHash: '$argon2id$placeholder' },
      });
      const by: AuditActor = { adminId: admin.id, ipAddress: '203.0.113.7', userAgent: 'pg test' };
      const adminService = createShowtimeAdminService({
        db: prisma,
        settings: settings(),
        cache: new MemoryCache(),
        logger: silentLogger,
        now: () => NOW,
      });
      // The API only takes whole minutes, so the last millisecond goes in directly; the two others
      // go through the service, each on its own screen as they would overlap.
      await prisma.showtime.create({
        data: { movieId: movie.id, screenId: screen.id, startsAt: new Date(LAST_MOMENT_OF_NOV_1) },
      });
      const screen2 = await prisma.screen.create({ data: { name: 'Screen 2' } });
      const screen3 = await prisma.screen.create({ data: { name: 'Screen 3' } });
      await adminService.create(
        showtimeCreateBodySchema.parse({
          movieId: movie.id,
          screenId: screen2.id,
          date: '2026-11-02',
          time: '00:00',
        }),
        by,
      );
      await adminService.create(
        showtimeCreateBodySchema.parse({
          movieId: movie.id,
          screenId: screen3.id,
          date: '2026-11-02',
          time: '00:30',
        }),
        by,
      );

      // Read back through Prisma, to the millisecond.
      const rows = await prisma.showtime.findMany({ orderBy: { startsAt: 'asc' } });
      expect(rows.map((row) => row.startsAt.toISOString())).toEqual([
        LAST_MOMENT_OF_NOV_1,
        COLOMBO_MIDNIGHT,
        HALF_PAST_MIDNIGHT,
      ]);

      // The raw text in Postgres, whatever the session's own zone is.
      const rawIn = await prisma.$transaction(async (tx) => {
        const read = () =>
          tx.$queryRaw<{ text: string }[]>`
          SELECT "startsAt"::text AS text FROM "Showtime" ORDER BY "startsAt"`;
        await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
        const utc = await read();
        await tx.$executeRaw`SET LOCAL TIME ZONE 'Asia/Colombo'`;
        return { utc, colombo: await read() };
      });
      expect(rawIn.utc.map((row) => row.text)).toEqual([
        '2026-11-01 18:29:59.999+00',
        '2026-11-01 18:30:00+00',
        '2026-11-01 19:00:00+00',
      ]);
      expect(rawIn.colombo.map((row) => row.text)).toEqual([
        '2026-11-01 23:59:59.999+05:30',
        '2026-11-02 00:00:00+05:30',
        '2026-11-02 00:30:00+05:30',
      ]);

      // The public site lists them under their Colombo dates, with that date's booking link.
      const publicService = createPublicShowtimeService({
        db: prisma,
        settings: settings(),
        cache: new MemoryCache(),
        logger: silentLogger,
        now: () => NOW,
      });
      expect(await publicService.listDates(movie.id)).toEqual(['2026-11-01', '2026-11-02']);
      const nov1 = await publicService.listForDate(movie.id, '2026-11-01');
      expect(nov1.map((show) => [show.startsAt, show.time, show.bookingUrl])).toEqual([
        [LAST_MOMENT_OF_NOV_1, '23:59', `${BMS_BASE}/20261101`],
      ]);
      const nov2 = await publicService.listForDate(movie.id, '2026-11-02');
      expect(nov2.map((show) => [show.startsAt, show.time, show.bookingUrl])).toEqual([
        [COLOMBO_MIDNIGHT, '00:00', `${BMS_BASE}/20261102`],
        [HALF_PAST_MIDNIGHT, '00:30', `${BMS_BASE}/20261102`],
      ]);

      // The admin date filter draws the same line.
      const onDate = async (date: string) => {
        const { items } = await adminService.list(
          adminShowtimeListQuerySchema.parse({ from: date, to: date }),
        );
        return items.map((item) => [item.startsAt, item.colomboDate]);
      };
      expect(await onDate('2026-11-01')).toEqual([[LAST_MOMENT_OF_NOV_1, '2026-11-01']]);
      expect(await onDate('2026-11-02')).toEqual([
        [COLOMBO_MIDNIGHT, '2026-11-02'],
        [HALF_PAST_MIDNIGHT, '2026-11-02'],
      ]);
    },
  );
});
