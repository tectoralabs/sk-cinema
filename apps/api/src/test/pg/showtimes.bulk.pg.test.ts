/**
 * Phase 5 T18b: bulk create at its edges, through the route on real Postgres.
 *   1. A slot that passes while the request waits for the screen lock: the second past check, on a
 *      real lock wait. The competing transaction holds the row until the clock has moved on.
 *   2. The largest request the schema accepts (31 days x 12 times), with every show touching the
 *      next one exactly, well inside the 10 s transaction timeout, in full or not at all.
 */
import {
  ERROR_CODES,
  SHOWTIME_BULK_MAX_DAYS,
  SHOWTIME_BULK_MAX_TIMES,
  showtimeBulkCreateResponseSchema,
  showtimeConflictErrorSchema,
  showtimePastSlotErrorSchema,
} from '@sk-cinema/shared';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TRANSACTION_OPTIONS } from '../../lib/prisma.js';
import {
  SHOWTIME_SLOT_IN_PAST_MESSAGE,
  showtimeBulkOverlapMessage,
  showtimeBulkPastMessage,
} from '../../services/showtime.admin.service.js';
import { describePg, disconnectTestPrisma, resetDatabase, testPrisma } from './db.js';
import { freezeClock, signedInAdmin } from './http.js';
import { holdScreenLock, lockWaiters, untilLockWaiter } from './interleave.js';

/** 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');
const WAITING_ON_SCREEN_LOCK = /FROM "Screen".*FOR UPDATE/s;

/** A 105-minute movie and a 15-minute gap: a show every 2 hours touches the next exactly. */
async function fixtures() {
  const prisma = testPrisma();
  const movie = await prisma.movie.create({
    data: { slug: 'm', title: 'Main Feature', durationMinutes: 105, status: 'NOW_SHOWING' },
  });
  const screen = await prisma.screen.create({ data: { name: 'Screen 1' } });
  await prisma.setting.create({ data: { key: 'showGapMinutes', value: '15' } });
  return { movie, screen, api: await signedInAdmin() };
}

const showtimeAudits = () =>
  testPrisma().auditLog.findMany({
    where: { entity: 'Showtime' },
    select: { action: true, entityId: true, details: true, adminId: true },
  });

describePg('bulk showtime create at its edges through the route on real Postgres', () => {
  beforeEach(async () => {
    freezeClock(NOW);
    await resetDatabase();
  });
  afterEach(async () => {
    vi.useRealTimers();
    // Every request has finished, so nothing may be left waiting.
    expect(await lockWaiters()).toEqual([]);
  });
  afterAll(disconnectTestPrisma);

  it('a slot that passes during a real wait for the screen lock: 400, nothing written, no audit', async () => {
    const { movie, screen, api } = await fixtures();
    const held = await holdScreenLock(screen.id);
    // Both slots are in the future when the request starts, so the first check lets it through.
    const responded = api
      .post('/showtimes/bulk', {
        movieId: movie.id,
        screenId: screen.id,
        dateFrom: '2026-11-01',
        dateTo: '2026-11-01',
        times: ['15:35', '23:00'],
      })
      .then((res) => res);
    let waitedOn: string;
    try {
      waitedOn = await untilLockWaiter(WAITING_ON_SCREEN_LOCK);
      // 15:40 in Colombo: 15:35 is gone, 23:00 is not.
      vi.setSystemTime(new Date('2026-11-01T10:10:00.000Z'));
    } finally {
      await held.release();
      await responded;
    }
    const res = await responded;

    expect(waitedOn).toMatch(WAITING_ON_SCREEN_LOCK);
    expect(res.status).toBe(400);
    expect(showtimePastSlotErrorSchema.parse(res.body).error).toEqual({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: showtimeBulkPastMessage(1),
      details: [
        {
          path: ['body', 'times', 0],
          message: SHOWTIME_SLOT_IN_PAST_MESSAGE,
          requested: { date: '2026-11-01', time: '15:35' },
        },
      ],
    });
    expect(await testPrisma().showtime.count()).toBe(0);
    expect(await showtimeAudits()).toEqual([]);
  });

  describePg('the largest request: 31 days x 12 times', () => {
    const LARGEST_TIMES = Array.from(
      { length: SHOWTIME_BULK_MAX_TIMES },
      (_, i) => `${String(i * 2).padStart(2, '0')}:00`,
    );
    const LARGEST_SLOTS = SHOWTIME_BULK_MAX_DAYS * SHOWTIME_BULK_MAX_TIMES;
    /** Half the transaction timeout: headroom for a slow machine, far from a failure. */
    const WELL_INSIDE_TIMEOUT_MS = TRANSACTION_OPTIONS.timeout / 2;

    const largestBody = (movieId: string, screenId: string) => ({
      movieId,
      screenId,
      dateFrom: '2026-12-01',
      dateTo: '2026-12-31',
      times: LARGEST_TIMES,
    });

    it('is a 201 with 372 rows and 372 audit rows sharing one batchId', async () => {
      const { movie, screen, api } = await fixtures();
      expect(LARGEST_SLOTS).toBe(372);

      const started = performance.now();
      const res = await api.post('/showtimes/bulk', largestBody(movie.id, screen.id));
      const elapsedMs = performance.now() - started;
      console.info(`[pg] 372-slot bulk create: ${elapsedMs.toFixed(0)} ms`);

      expect(res.status).toBe(201);
      expect(elapsedMs).toBeLessThan(WELL_INSIDE_TIMEOUT_MS);
      const { created, items } = showtimeBulkCreateResponseSchema.parse(res.body);
      expect(created).toBe(372);
      expect(items).toHaveLength(372);
      // In order, in Colombo time: 2026-12-01 00:00 and 2026-12-31 22:00.
      expect(items[0]?.startsAt).toBe('2026-11-30T18:30:00.000Z');
      expect(items[371]?.startsAt).toBe('2026-12-31T16:30:00.000Z');

      const rows = await testPrisma().showtime.findMany({ select: { id: true } });
      expect(new Set(rows.map((row) => row.id))).toEqual(new Set(items.map((item) => item.id)));
      expect(rows).toHaveLength(372);
      const audits = await showtimeAudits();
      expect(audits).toHaveLength(372);
      expect(new Set(audits.map((row) => row.entityId))).toEqual(
        new Set(items.map((item) => item.id)),
      );
      expect(audits.every((row) => row.action === 'CREATE' && row.adminId === api.admin.id)).toBe(
        true,
      );
      const batchIds = new Set(
        audits.map((row) => (row.details as Record<string, unknown> | null)?.['batchId']),
      );
      expect(batchIds.size).toBe(1);
      expect([...batchIds][0]).toEqual(expect.any(String));
    });

    it('with one clash is a 409 naming that slot, and nothing is written', async () => {
      const { movie, screen, api } = await fixtures();
      // Exactly on the grid: it touches the slots either side, and clashes with this one only.
      const existing = await testPrisma().showtime.create({
        data: {
          movieId: movie.id,
          screenId: screen.id,
          startsAt: new Date('2026-12-15T12:00:00+05:30'),
        },
      });

      const started = performance.now();
      const res = await api.post('/showtimes/bulk', largestBody(movie.id, screen.id));
      const elapsedMs = performance.now() - started;
      console.info(`[pg] 372-slot bulk create with one clash: ${elapsedMs.toFixed(0)} ms`);

      expect(res.status).toBe(409);
      expect(elapsedMs).toBeLessThan(WELL_INSIDE_TIMEOUT_MS);
      const { error } = showtimeConflictErrorSchema.parse(res.body);
      expect(error.message).toBe(showtimeBulkOverlapMessage(1, 1));
      expect(error.details).toHaveLength(1);
      expect(error.details[0]).toMatchObject({
        path: ['body', 'times', 6],
        requested: { date: '2026-12-15', time: '12:00' },
        conflict: { showtimeId: existing.id },
      });
      const rows = await testPrisma().showtime.findMany({ select: { id: true } });
      expect(rows).toEqual([{ id: existing.id }]);
      expect(await showtimeAudits()).toEqual([]);
    });
  });
});
