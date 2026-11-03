/**
 * Phase 5 T19b (S5-08): repairing a movie whose stored running time is 0 (possible only through
 * manual SQL; the Phase 10 CHECK will forbid it), through PATCH /api/admin/movies/:id on real
 * Postgres. Its future shows used to make every PATCH a 500, because the overlap check refuses an
 * unusable length. Now a normal length saves when it clashes with nothing, and is the usual 409
 * (with nothing changed) when it does.
 * The "showtime write next to that row is a 500" tests stay in settings.storedData.pg.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { showtimeConflictErrorSchema } from '@sk-cinema/shared';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { movieLengthOverlapMessage } from '../../services/movie.admin.service.js';
import { describePg, disconnectTestPrisma, resetDatabase, testPrisma } from './db.js';
import { freezeClock, signedInAdmin } from './http.js';

/** 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');
/** 2026-11-02 at 10:00 and 12:00 in Colombo. */
const TEN = new Date('2026-11-02T04:30:00.000Z');
const NOON = new Date('2026-11-02T06:30:00.000Z');
const THREE_PM = new Date('2026-11-02T09:30:00.000Z');

/**
 * The broken movie (0 minutes) shows at 10:00 on screen 1 and 10:00 on screen 2. Another
 * 100-minute movie shows on screen 1 at `otherAt`. Gap 15: a 120-minute show at 10:00 ends at
 * 12:00 and needs until 12:15, so it clashes with a show at 12:00 and not with one at 15:00.
 */
async function fixtures(otherAt: Date) {
  const prisma = testPrisma();
  const brokenId = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "Movie" ("id", "slug", "title", "durationMinutes", "status", "updatedAt")
    VALUES (${brokenId}::uuid, 'broken', 'Broken Length Feature', 0, 'NOW_SHOWING'::"MovieStatus", ${NOW})`;
  const other = await prisma.movie.create({
    data: { slug: 'other', title: 'Other Feature', durationMinutes: 100, status: 'NOW_SHOWING' },
  });
  const one = await prisma.screen.create({ data: { name: 'Screen 1' } });
  const two = await prisma.screen.create({ data: { name: 'Screen 2' } });
  await prisma.setting.create({ data: { key: 'showGapMinutes', value: '15' } });
  await prisma.showtime.createMany({
    data: [
      { movieId: brokenId, screenId: one.id, startsAt: TEN },
      { movieId: brokenId, screenId: two.id, startsAt: TEN },
      { movieId: other.id, screenId: one.id, startsAt: otherAt },
    ],
  });
  return { brokenId, other, api: await signedInAdmin() };
}

const durationOf = async (id: string) =>
  (await testPrisma().movie.findUniqueOrThrow({ where: { id } })).durationMinutes;
const movieAudits = () =>
  testPrisma().auditLog.findMany({
    where: { entity: 'Movie' },
    select: { action: true, entityId: true, details: true },
  });

describePg('repairing a movie stored with a running time of 0, on real Postgres', () => {
  beforeEach(async () => {
    freezeClock(NOW);
    await resetDatabase();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(disconnectTestPrisma);

  it('PATCH durationMinutes 120 when nothing clashes: 200, saved and audited, shows untouched', async () => {
    const { brokenId, api } = await fixtures(THREE_PM);
    const before = await testPrisma().showtime.findMany({ orderBy: { id: 'asc' } });

    const res = await api.patch(`/movies/${brokenId}`, { durationMinutes: 120 });

    expect(res.status).toBe(200);
    expect((res.body as { movie: { durationMinutes: number } }).movie.durationMinutes).toBe(120);
    expect(await durationOf(brokenId)).toBe(120);
    expect(await movieAudits()).toEqual([
      expect.objectContaining({ action: 'UPDATE', entityId: brokenId }),
    ]);
    expect(await testPrisma().showtime.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });

  it('PATCH durationMinutes 120 when it would clash with another movie: the usual 409, nothing changed', async () => {
    const { brokenId, api } = await fixtures(NOON);

    const res = await api.patch(`/movies/${brokenId}`, { durationMinutes: 120 });

    expect(res.status).toBe(409);
    const { error } = showtimeConflictErrorSchema.parse(res.body);
    // One of its shows (screen 1, 10:00) would overlap the other movie's show at 12:00.
    expect(error.message).toBe(movieLengthOverlapMessage(1, 1));
    expect(error.details).toHaveLength(1);
    expect(await durationOf(brokenId)).toBe(0);
    expect(await movieAudits()).toEqual([]);
  });

  it('a shorter repair that fits next to the other movie is a 200', async () => {
    // 10:00 + 90 minutes + 15 minutes gap = 11:45, before the 12:00 show.
    const { brokenId, api } = await fixtures(NOON);

    const res = await api.patch(`/movies/${brokenId}`, { durationMinutes: 90 });

    expect(res.status).toBe(200);
    expect(await durationOf(brokenId)).toBe(90);
  });

  it('a PATCH that does not touch the running time is a 200 on the broken movie', async () => {
    const { brokenId, api } = await fixtures(NOON);

    const res = await api.patch(`/movies/${brokenId}`, { title: 'Fixed Title' });

    expect(res.status).toBe(200);
    expect(await durationOf(brokenId)).toBe(0);
  });
});
