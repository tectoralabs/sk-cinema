/**
 * Phase 5 T19b (S5-03): the settings save commits before the gap count runs, on a large schedule,
 * through PATCH /api/admin/settings on real Postgres.
 *   1. With 200,000 future shows inserted by raw SQL, the save answers 200 with the saved
 *      settings and the right count, the setting and its audit row are stored, and the count's
 *      queries ran on the root client AFTER the commit: when the first one ran, a second
 *      connection already saw the new value and its audit row. A count made inside the
 *      transaction would read through the transaction client, and see neither from outside.
 *   2. A failing count is a generic 500 after the save, which stays committed and audited.
 */
import {
  adminSettingsResponseSchema,
  apiErrorSchema,
  DEFAULT_BMS_BASE_URL,
} from '@sk-cinema/shared';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { describePg, disconnectTestPrisma, resetDatabase, testPrisma } from './db.js';
import { freezeClock, signedInAdmin } from './http.js';
import { interceptDb, type DbCall } from './interleave.js';

/** 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');
const NEW_BASE_URL = 'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/cinema-snlk-SKCM-MT2';

/** Ten screens of SHOWS_PER_SCREEN shows each: 200,000 future shows in all. */
const BIG_SCREENS = 10;
const SHOWS_PER_SCREEN = 20_000;
/** A 100-minute movie every 120 minutes with a 15-minute gap: no show is too close. */
const SPACING_MINUTES = 120;

async function fixtures(showsPerScreen = SHOWS_PER_SCREEN) {
  const prisma = testPrisma();
  for (const slug of ['a', 'b', 'c', 'd']) {
    await prisma.movie.create({
      data: { slug, title: `Movie ${slug}`, durationMinutes: 100, status: 'NOW_SHOWING' },
    });
  }
  for (let i = 1; i <= BIG_SCREENS + 1; i += 1) {
    await prisma.screen.create({ data: { name: `Screen ${String(i).padStart(2, '0')}` } });
  }
  await prisma.setting.create({ data: { key: 'showGapMinutes', value: '15' } });

  // 200,000 shows, spread over the four movies and the ten big screens, one statement.
  await prisma.$executeRaw`
    INSERT INTO "Showtime" ("id", "movieId", "screenId", "startsAt", "updatedAt")
    SELECT gen_random_uuid(),
           (SELECT array_agg("id" ORDER BY "slug") FROM "Movie")[1 + (g % 4)],
           s."id",
           ${NOW}::timestamptz + ((g + 1) * ${SPACING_MINUTES} * interval '1 minute'),
           now()
    FROM generate_series(0, ${showsPerScreen - 1}) AS g
    CROSS JOIN (SELECT "id" FROM "Screen" ORDER BY "name" LIMIT ${BIG_SCREENS}) AS s`;

  // The last screen has three shows of the same 100-minute movie at 0, 60 and 90 minutes: the
  // second and the third start too soon after the one before, so the count is exactly 2.
  const [movie] = await prisma.movie.findMany({ orderBy: { slug: 'asc' }, take: 1 });
  const lastScreen = await prisma.screen.findFirstOrThrow({ orderBy: { name: 'desc' } });
  await prisma.showtime.createMany({
    data: [0, 60, 90].map((minutes) => ({
      movieId: movie?.id ?? '',
      screenId: lastScreen.id,
      startsAt: new Date(NOW.getTime() + (minutes + 1) * 60_000),
    })),
  });
  return { prisma };
}

/** What a second connection could see at the moment a call was made. */
async function visibleFromOutside() {
  const prisma = testPrisma();
  return {
    baseUrl: (await prisma.setting.findUnique({ where: { key: 'bmsBaseUrl' } }))?.value ?? null,
    audits: await prisma.auditLog.count({ where: { entity: 'Setting' } }),
  };
}

describePg('the settings save before its gap count, on a large schedule, on real Postgres', () => {
  beforeEach(async () => {
    freezeClock(NOW);
    await resetDatabase();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(disconnectTestPrisma);

  it('saves, audits and answers 200 with the count, which was made after the commit', async () => {
    await fixtures();
    const countCalls: { call: DbCall; seen: Awaited<ReturnType<typeof visibleFromOutside>> }[] = [];
    const watched = interceptDb(testPrisma(), async (call, proceed) => {
      if (call.model === 'showtime') {
        countCalls.push({ call, seen: await visibleFromOutside() });
      }
      return proceed();
    });
    const api = await signedInAdmin({ role: 'SUPER_ADMIN', prisma: watched });
    // The sign-in itself reads no showtimes.
    expect(countCalls).toEqual([]);

    const res = await api.patch('/settings', { bmsBaseUrl: NEW_BASE_URL });

    expect(res.status).toBe(200);
    const body = adminSettingsResponseSchema.parse(res.body);
    expect(body.settings.bmsBaseUrl).toBe(NEW_BASE_URL);
    expect(body.settings.showGapMinutes).toBe(15);
    expect(body.futureShowtimesBelowGap).toBe(2);

    // Saved and audited, once.
    const prisma = testPrisma();
    expect(await visibleFromOutside()).toEqual({ baseUrl: NEW_BASE_URL, audits: 1 });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entity: 'Setting' } });
    expect(audit).toMatchObject({ action: 'UPDATE', entityId: 'bmsBaseUrl' });
    expect(audit.details).toEqual({ from: DEFAULT_BMS_BASE_URL, to: NEW_BASE_URL });

    // The count read the shows through the root client only, and every one of its queries ran
    // when the save was already visible to another connection.
    expect(countCalls.length).toBeGreaterThan(0);
    expect(countCalls.map(({ call }) => call.scope)).toEqual(
      Array<string>(countCalls.length).fill('root'),
    );
    for (const { seen } of countCalls) {
      expect(seen).toEqual({ baseUrl: NEW_BASE_URL, audits: 1 });
    }
  });

  it('a count that fails is a generic 500 after the save, which stays committed and audited', async () => {
    // The volume does not matter here: a few shows are enough for the count to run.
    await fixtures(10);
    const watched = interceptDb(testPrisma(), (call, proceed) =>
      call.scope === 'root' && call.model === 'showtime'
        ? Promise.reject(new Error('count blew up: secret-detail'))
        : proceed(),
    );
    const api = await signedInAdmin({ role: 'SUPER_ADMIN', prisma: watched });

    const res = await api.patch('/settings', { bmsBaseUrl: NEW_BASE_URL });

    expect(res.status).toBe(500);
    expect(apiErrorSchema.parse(res.body)).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
    });
    expect(res.text).not.toContain('secret-detail');
    expect(await visibleFromOutside()).toEqual({ baseUrl: NEW_BASE_URL, audits: 1 });

    // The admin reads the result with a GET (the watched client fails its count too, so use a
    // fresh app on the plain client).
    const reader = await signedInAdmin({ role: 'SUPER_ADMIN' });
    const read = await reader.get('/settings');
    expect(read.status).toBe(200);
    expect(adminSettingsResponseSchema.parse(read.body).settings.bmsBaseUrl).toBe(NEW_BASE_URL);
  });
});
