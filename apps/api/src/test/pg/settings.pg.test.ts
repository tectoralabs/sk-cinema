/**
 * Phase 5 T14 settings proven on real Postgres 18, where the in-memory fake can only imitate it:
 *   1. the real Prisma client accepts the upserts, the nested `updatedBy` read and the audit
 *      insert, and a second save updates the rows in place;
 *   2. the count works on real rows, under the raised and the lowered gap;
 *   3. two concurrent first saves of a missing row both succeed: the upsert is Prisma's atomic
 *      ON CONFLICT one, so neither hits P2002 (which would abort its whole transaction).
 */
import { adminSettingsResponseSchema, DEFAULT_BMS_BASE_URL } from '@sk-cinema/shared';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { MemoryCache } from '../../lib/cache.js';
import type { AuditActor } from '../../services/audit.service.js';
import { createSettingsAdminService } from '../../services/settings.admin.service.js';
import { silentLogger } from '../helpers.js';
import { describePg, disconnectTestPrisma, resetDatabase, testPrisma } from './db.js';

const NEW_BASE = 'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/cinema-snlk-SKCM-NEW';

/** The injected clock: 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');

const minutesAfterNow = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

async function actor(): Promise<AuditActor> {
  const admin = await testPrisma().admin.create({
    data: {
      email: 'pg-owner@skcinema.lk',
      name: 'Owner',
      role: 'SUPER_ADMIN',
      passwordHash: '$argon2id$placeholder',
    },
  });
  return { adminId: admin.id, ipAddress: '203.0.113.7', userAgent: 'pg test' };
}

const service = () =>
  createSettingsAdminService({
    db: testPrisma(),
    cache: new MemoryCache(),
    logger: silentLogger,
    now: () => NOW,
  });

const settingAudits = () =>
  testPrisma().auditLog.findMany({
    where: { entity: 'Setting' },
    orderBy: { id: 'asc' },
    select: { action: true, adminId: true, entityId: true, details: true },
  });

describePg('admin settings on real Postgres', () => {
  beforeEach(resetDatabase);
  afterAll(disconnectTestPrisma);

  it('upserts only the changed rows, writes the audit rows, and reports who saved', async () => {
    const by = await actor();
    await testPrisma().setting.create({ data: { key: 'showGapMinutes', value: '15' } });

    const seeded = adminSettingsResponseSchema.parse(await service().get());
    expect(seeded.settings).toMatchObject({
      bmsBaseUrl: DEFAULT_BMS_BASE_URL,
      showGapMinutes: 15,
      updatedBy: null,
    });
    expect(seeded.settings.updatedAt).not.toBeNull();

    const saved = adminSettingsResponseSchema.parse(
      await service().update({ bmsBaseUrl: NEW_BASE, showGapMinutes: 30 }, by),
    );
    expect(saved.settings).toMatchObject({
      bmsBaseUrl: NEW_BASE,
      showGapMinutes: 30,
      updatedBy: { id: by.adminId, name: 'Owner' },
    });
    expect(await testPrisma().setting.findMany({ orderBy: { key: 'asc' } })).toMatchObject([
      { key: 'bmsBaseUrl', value: NEW_BASE, updatedById: by.adminId },
      { key: 'showGapMinutes', value: '30', updatedById: by.adminId },
    ]);
    expect(await settingAudits()).toEqual(
      expect.arrayContaining([
        {
          action: 'UPDATE',
          adminId: by.adminId,
          entityId: 'bmsBaseUrl',
          details: { from: DEFAULT_BMS_BASE_URL, to: NEW_BASE },
        },
        {
          action: 'UPDATE',
          adminId: by.adminId,
          entityId: 'showGapMinutes',
          details: { from: 15, to: 30 },
        },
      ]),
    );
    expect(await settingAudits()).toHaveLength(2);

    // A second save is a partial no-op: one more audit row, the row updated in place.
    await service().update({ bmsBaseUrl: NEW_BASE, showGapMinutes: 45 }, by);
    expect(await testPrisma().setting.count()).toBe(2);
    expect(await settingAudits()).toHaveLength(3);
    expect(adminSettingsResponseSchema.parse(await service().get()).settings.showGapMinutes).toBe(
      45,
    );
  });

  it('counts real rows: running neighbour, past, soft-deleted and other screens', async () => {
    const by = await actor();
    const prisma = testPrisma();
    const movie = await prisma.movie.create({
      data: { slug: 'm', title: 'Main Feature', durationMinutes: 120 },
    });
    const screen = await prisma.screen.create({ data: { name: 'Screen 1' } });
    const other = await prisma.screen.create({ data: { name: 'Screen 2', isActive: false } });
    const show = (screenId: string, minutes: number, deleted = false) => ({
      movieId: movie.id,
      screenId,
      startsAt: minutesAfterNow(minutes),
      deletedAt: deleted ? NOW : null,
    });
    await prisma.showtime.createMany({
      data: [
        // Finished long ago and clashing with each other: ignored.
        show(screen.id, -2000),
        show(screen.id, -1990),
        // Running now, ends in 60 minutes; 20 minutes after that is fine at 15, not at 30.
        show(screen.id, -60),
        show(screen.id, 80),
        // Further on: 20 minutes after the previous show's end again.
        show(screen.id, 220),
        // Soft-deleted: would clash with anything.
        show(screen.id, 230, true),
        // On a hidden screen, 20 minutes after the end again: its own clash, not with the above.
        show(other.id, 500),
        show(other.id, 640),
      ],
    });
    const before = await prisma.showtime.findMany({ orderBy: { id: 'asc' } });

    expect((await service().get()).futureShowtimesBelowGap).toBe(0);

    const raised = await service().update({ showGapMinutes: 30 }, by);
    expect(raised.futureShowtimesBelowGap).toBe(3);
    expect((await service().get()).futureShowtimesBelowGap).toBe(3);

    const lowered = await service().update({ showGapMinutes: 15 }, by);
    expect(lowered.futureShowtimesBelowGap).toBe(0);

    expect(await prisma.showtime.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });

  it('two concurrent first saves of a missing row both succeed; one row remains', async () => {
    const by = await actor();

    const results = await Promise.allSettled([
      service().update({ showGapMinutes: 30 }, by),
      service().update({ showGapMinutes: 45 }, by),
    ]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    const rows = await testPrisma().setting.findMany({ where: { key: 'showGapMinutes' } });
    expect(rows).toHaveLength(1);
    expect(['30', '45']).toContain(rows[0]?.value);
    expect(await settingAudits()).toHaveLength(2);
  });
});
