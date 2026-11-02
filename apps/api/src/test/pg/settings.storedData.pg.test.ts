/**
 * Phase 5 T18b: the settings screen on data the API would never have stored, through the routes on
 * real Postgres. Rows like these are only possible through manual SQL (the database has no CHECK
 * on them yet: Phase 10), and an admin must still be able to open the screen and repair them.
 *   1. A movie with an unusable running time is left out of the gap count, with one warning that
 *      holds no stored value.
 *   2. A setting row holding an invalid value is overwritten by the real upsert when a save names
 *      that key, even with the default it already reads as, and the audit row never holds the raw
 *      value.
 */
import { randomUUID } from 'node:crypto';
import {
  adminSettingsResponseSchema,
  apiErrorSchema,
  DEFAULT_BMS_BASE_URL,
  DEFAULT_SHOW_GAP_MINUTES,
  ERROR_CODES,
} from '@sk-cinema/shared';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UNUSABLE_DURATION_REASON } from '../../services/settings.admin.service.js';
import { INVALID_STORED_SETTING } from '../../services/settings.service.js';
import { describePg, disconnectTestPrisma, resetDatabase, testPrisma } from './db.js';
import { capturingLogger, freezeClock, signedInAdmin } from './http.js';

/** 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');

const minutesAfterNow = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const BROKEN_TITLE = 'Broken Length Feature';

describePg('settings on stored data the API would refuse, on real Postgres', () => {
  beforeEach(async () => {
    freezeClock(NOW);
    await resetDatabase();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(disconnectTestPrisma);

  describePg('a movie with durationMinutes = 0, inserted by raw SQL', () => {
    /**
     * On one screen, two good 120-minute shows: 20 minutes apart, so fine at a gap of 15 and too
     * close at 30. Between them, a show of the broken movie that would clash with both.
     */
    async function fixtures() {
      const log = capturingLogger();
      const prisma = testPrisma();
      const brokenId = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO "Movie" ("id", "slug", "title", "durationMinutes", "status", "updatedAt")
        VALUES (${brokenId}::uuid, 'broken', ${BROKEN_TITLE}, 0, 'NOW_SHOWING'::"MovieStatus", ${NOW})`;
      const good = await prisma.movie.create({
        data: { slug: 'good', title: 'Good Feature', durationMinutes: 120, status: 'NOW_SHOWING' },
      });
      const screen = await prisma.screen.create({ data: { name: 'Screen 1' } });
      await prisma.showtime.createMany({
        data: [
          { movieId: good.id, screenId: screen.id, startsAt: minutesAfterNow(60) },
          { movieId: good.id, screenId: screen.id, startsAt: minutesAfterNow(200) },
        ],
      });
      const brokenShow = await prisma.showtime.create({
        data: { movieId: brokenId, screenId: screen.id, startsAt: minutesAfterNow(70) },
      });
      await prisma.setting.create({
        data: { key: 'showGapMinutes', value: String(DEFAULT_SHOW_GAP_MINUTES) },
      });
      const api = await signedInAdmin({ role: 'SUPER_ADMIN', logger: log.logger });
      log.clear();
      return { log, api, brokenId, brokenShow, good, screen };
    }

    const expectOneSkipWarning = (log: ReturnType<typeof capturingLogger>, showtimeId: string) => {
      const warnings = log.withReason(UNUSABLE_DURATION_REASON);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ level: 40, showtimeId, skippedCount: 1 });
      // Keys, not values: an ID, a count and a reason. No title, no running time.
      expect(log.raw()).not.toContain(BROKEN_TITLE);
      expect(log.raw()).not.toContain('durationMinutes');
    };

    it('GET settings is a 200: the count ignores that row, with one warning', async () => {
      const { log, api, brokenShow } = await fixtures();

      const res = await api.get('/settings');

      expect(res.status).toBe(200);
      expect(adminSettingsResponseSchema.parse(res.body).futureShowtimesBelowGap).toBe(0);
      expectOneSkipWarning(log, brokenShow.id);
    });

    it('PATCH settings saves: a 200, the count ignores that row, with one warning', async () => {
      const { log, api, brokenShow } = await fixtures();

      const res = await api.patch('/settings', { showGapMinutes: 30 });

      expect(res.status).toBe(200);
      const body = adminSettingsResponseSchema.parse(res.body);
      expect(body.settings.showGapMinutes).toBe(30);
      // Only the good pair, 20 minutes apart. Counted, the broken show would add one more.
      expect(body.futureShowtimesBelowGap).toBe(1);
      const stored = await testPrisma().setting.findUniqueOrThrow({
        where: { key: 'showGapMinutes' },
      });
      expect(stored.value).toBe('30');
      expectOneSkipWarning(log, brokenShow.id);
    });

    /*
     * What a showtime write does near such a row today: the overlap check refuses the running time
     * as a programmer error, so the request is a generic 500 with nothing written and nothing
     * leaked. Not a promise to keep: the Phase 10 CHECK makes the row impossible, and this test
     * must then go, along with the raw insert above.
     */
    it('a showtime write next to that row is still a generic 500, nothing written', async () => {
      const { api, good, screen } = await fixtures();
      const before = await testPrisma().showtime.count();

      const res = await api.post('/showtimes', {
        movieId: good.id,
        screenId: screen.id,
        // Free of the good shows, but the broken one is within the longest run a show can have.
        date: '2026-11-01',
        time: '23:00',
      });

      expect(res.status).toBe(500);
      expect(apiErrorSchema.parse(res.body).error.code).toBe(ERROR_CODES.INTERNAL_ERROR);
      expect(JSON.stringify(res.body)).not.toContain('durationMinutes');
      expect(await testPrisma().showtime.count()).toBe(before);
      expect(await testPrisma().auditLog.count({ where: { entity: 'Showtime' } })).toBe(0);
    });

    it('a showtime of that movie itself is also a generic 500, nothing written', async () => {
      const { api, brokenId, screen } = await fixtures();
      const before = await testPrisma().showtime.count();

      const res = await api.post('/showtimes', {
        movieId: brokenId,
        screenId: screen.id,
        date: '2026-12-20',
        time: '10:00',
      });

      expect(res.status).toBe(500);
      expect(apiErrorSchema.parse(res.body).error.code).toBe(ERROR_CODES.INTERNAL_ERROR);
      expect(await testPrisma().showtime.count()).toBe(before);
    });

    it('a showtime on that screen far enough from the row still saves', async () => {
      const { api, good, screen } = await fixtures();

      const res = await api.post('/showtimes', {
        movieId: good.id,
        screenId: screen.id,
        date: '2026-12-20',
        time: '10:00',
      });

      expect(res.status).toBe(201);
    });
  });

  describePg('a setting row holding an invalid value', () => {
    const RAW_BASE = 'https://evil.example.com/buytickets/raw-value';
    const RAW_GAP = 'abc';
    const OTHER_BASE = 'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/cinema-snlk-SKCM-NEW';

    async function fixtures(rows: { key: string; value: string }[]) {
      const log = capturingLogger();
      await testPrisma().setting.createMany({ data: rows });
      const api = await signedInAdmin({ role: 'SUPER_ADMIN', logger: log.logger });
      log.clear();
      return { log, api };
    }

    const settingAudits = () =>
      testPrisma().auditLog.findMany({
        where: { entity: 'Setting' },
        select: { action: true, entityId: true, adminId: true, details: true },
      });

    it.each([
      {
        label: 'bmsBaseUrl',
        key: 'bmsBaseUrl',
        raw: RAW_BASE,
        body: { bmsBaseUrl: DEFAULT_BMS_BASE_URL },
        details: { from: DEFAULT_BMS_BASE_URL, to: DEFAULT_BMS_BASE_URL },
        stored: DEFAULT_BMS_BASE_URL,
      },
      {
        label: 'showGapMinutes',
        key: 'showGapMinutes',
        raw: RAW_GAP,
        body: { showGapMinutes: DEFAULT_SHOW_GAP_MINUTES },
        details: { from: DEFAULT_SHOW_GAP_MINUTES, to: DEFAULT_SHOW_GAP_MINUTES },
        stored: String(DEFAULT_SHOW_GAP_MINUTES),
      },
    ])(
      'sending the default for $label overwrites the row, audited, and the next read is quiet',
      async ({ key, raw, body, details, stored }) => {
        const { log, api } = await fixtures([{ key, value: raw }]);

        // Before the repair: it reads as its default, with a warning.
        expect((await api.get('/settings')).status).toBe(200);
        expect(log.withReason(INVALID_STORED_SETTING)).toHaveLength(1);

        const saved = await api.patch('/settings', body);

        expect(saved.status).toBe(200);
        expect(await testPrisma().setting.findUniqueOrThrow({ where: { key } })).toMatchObject({
          value: stored,
          updatedById: api.admin.id,
        });
        const audits = await settingAudits();
        expect(audits).toEqual([
          { action: 'UPDATE', entityId: key, adminId: api.admin.id, details },
        ]);
        expect(JSON.stringify(audits)).not.toContain(raw);

        log.clear();
        const read = await api.get('/settings');
        expect(read.status).toBe(200);
        expect(log.withReason(INVALID_STORED_SETTING)).toEqual([]);
        expect(log.raw()).not.toContain(raw);
      },
    );

    it('a save naming both repairs both rows, and neither raw value reaches the log or the audit', async () => {
      const { log, api } = await fixtures([
        { key: 'bmsBaseUrl', value: RAW_BASE },
        { key: 'showGapMinutes', value: RAW_GAP },
      ]);

      const saved = await api.patch('/settings', {
        bmsBaseUrl: DEFAULT_BMS_BASE_URL,
        showGapMinutes: DEFAULT_SHOW_GAP_MINUTES,
      });

      expect(saved.status).toBe(200);
      expect(await testPrisma().setting.count()).toBe(2);
      const audits = JSON.stringify(await settingAudits());
      expect(audits).not.toContain(RAW_BASE);
      expect(audits).not.toContain(`"${RAW_GAP}"`);
      expect(await settingAudits()).toHaveLength(2);

      log.clear();
      expect((await api.get('/settings')).status).toBe(200);
      expect(log.withReason(INVALID_STORED_SETTING)).toEqual([]);
    });

    it('a different valid value replaces the row; the audit `from` is the default, not the raw value', async () => {
      const { api } = await fixtures([{ key: 'bmsBaseUrl', value: RAW_BASE }]);

      const saved = await api.patch('/settings', { bmsBaseUrl: OTHER_BASE });

      expect(saved.status).toBe(200);
      expect(adminSettingsResponseSchema.parse(saved.body).settings.bmsBaseUrl).toBe(OTHER_BASE);
      expect(await settingAudits()).toEqual([
        {
          action: 'UPDATE',
          entityId: 'bmsBaseUrl',
          adminId: api.admin.id,
          details: { from: DEFAULT_BMS_BASE_URL, to: OTHER_BASE },
        },
      ]);
    });

    it('a save naming only the other key leaves the invalid row alone, still warning', async () => {
      const { log, api } = await fixtures([{ key: 'bmsBaseUrl', value: RAW_BASE }]);

      const saved = await api.patch('/settings', { showGapMinutes: 30 });

      expect(saved.status).toBe(200);
      const row = await testPrisma().setting.findUniqueOrThrow({ where: { key: 'bmsBaseUrl' } });
      expect(row.value).toBe(RAW_BASE);
      log.clear();
      expect((await api.get('/settings')).status).toBe(200);
      expect(log.withReason(INVALID_STORED_SETTING)).toHaveLength(1);
    });
  });
});
