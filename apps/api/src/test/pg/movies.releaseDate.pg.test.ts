/**
 * Phase 5 T19b (S5-07): the release date range of a movie request, through the routes on real
 * Postgres. Postgres `date` refuses year 0 (a 500 before T19a); a request now accepts 1900 to 2099
 * only, with a 400 and nothing stored. Rows outside the range (possible through manual SQL only)
 * still read back, and the public `?date=` filter is unchanged.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { describePg, disconnectTestPrisma, resetDatabase, testPrisma } from './db.js';
import { expectValidationError, freezeClock, signedInAdmin } from './http.js';
import request from 'supertest';

/** 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');

const create = (api: Awaited<ReturnType<typeof signedInAdmin>>, releaseDate: string, slug = 'm') =>
  api.post('/movies', { title: 'Dated', slug, durationMinutes: 100, releaseDate });

const movieCount = () => testPrisma().movie.count();
const adminAudits = () => testPrisma().auditLog.count({ where: { entity: 'Movie' } });

/** A movie stored by raw SQL, the only way to get a release date outside the request range. */
async function insertRaw(slug: string, releaseDate: string): Promise<string> {
  const id = randomUUID();
  await testPrisma().$executeRaw`
    INSERT INTO "Movie" ("id", "slug", "title", "durationMinutes", "status", "releaseDate", "updatedAt")
    VALUES (${id}::uuid, ${slug}, ${`Raw ${slug}`}, 100, 'NOW_SHOWING'::"MovieStatus",
            ${releaseDate}::date, ${NOW})`;
  return id;
}

describePg('movie release dates on real Postgres', () => {
  beforeEach(async () => {
    freezeClock(NOW);
    await resetDatabase();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(disconnectTestPrisma);

  it.each(['0000-01-01', '1899-12-31', '2100-01-01', '9999-12-31'])(
    'POST releaseDate %s: 400 on body.releaseDate, nothing stored or audited',
    async (releaseDate) => {
      const api = await signedInAdmin();

      const res = await create(api, releaseDate);

      expectValidationError(res, ['body', 'releaseDate']);
      expect(res.text).not.toContain(releaseDate);
      expect(await movieCount()).toBe(0);
      expect(await adminAudits()).toBe(0);
    },
  );

  it.each([
    { label: 'the first allowed day', releaseDate: '1900-01-01' },
    { label: 'the last allowed day', releaseDate: '2099-12-31' },
    { label: 'a leap day', releaseDate: '2024-02-29' },
  ])('POST $label ($releaseDate): 201 and reads back unchanged', async ({ releaseDate }) => {
    const api = await signedInAdmin();

    const res = await create(api, releaseDate);

    expect(res.status).toBe(201);
    const { id } = (res.body as { movie: { id: string; releaseDate: string } }).movie;
    expect((res.body as { movie: { releaseDate: string } }).movie.releaseDate).toBe(releaseDate);
    const read = await api.get(`/movies/${id}`);
    expect(read.status).toBe(200);
    expect((read.body as { movie: { releaseDate: string } }).movie.releaseDate).toBe(releaseDate);
    const stored = await testPrisma().$queryRaw<{ day: string }[]>`
      SELECT "releaseDate"::text AS day FROM "Movie" WHERE "id" = ${id}::uuid`;
    expect(stored[0]?.day).toBe(releaseDate);
  });

  it.each(['0000-01-01', '1899-12-31', '2100-01-01'])(
    'PATCH releaseDate %s: 400, the stored date is unchanged',
    async (releaseDate) => {
      const api = await signedInAdmin();
      const created = await create(api, '2026-12-25');
      const { id } = (created.body as { movie: { id: string } }).movie;

      const res = await api.patch(`/movies/${id}`, { releaseDate });

      expectValidationError(res, ['body', 'releaseDate']);
      const read = await api.get(`/movies/${id}`);
      expect((read.body as { movie: { releaseDate: string } }).movie.releaseDate).toBe(
        '2026-12-25',
      );
    },
  );

  it.each(['0999-01-05', '2150-01-05'])(
    'a stored release date of %s reads back through admin GET, admin list and public GET',
    async (releaseDate) => {
      const api = await signedInAdmin();
      const id = await insertRaw('raw', releaseDate);

      const admin = await api.get(`/movies/${id}`);
      const list = await api.get('/movies');
      const publicGet = await request(api.app).get('/api/movies/raw');
      const publicList = await request(api.app).get('/api/movies');

      expect(admin.status).toBe(200);
      expect((admin.body as { movie: { releaseDate: string } }).movie.releaseDate).toBe(
        releaseDate,
      );
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).toContain(releaseDate);
      expect(publicGet.status).toBe(200);
      expect(JSON.stringify(publicGet.body)).toContain(releaseDate);
      expect(publicList.status).toBe(200);
    },
  );

  it('a stored out-of-range date can be repaired with a valid one', async () => {
    const api = await signedInAdmin();
    const id = await insertRaw('raw', '0999-01-05');

    const res = await api.patch(`/movies/${id}`, { releaseDate: '2026-12-25' });

    expect(res.status).toBe(200);
    expect((res.body as { movie: { releaseDate: string } }).movie.releaseDate).toBe('2026-12-25');
  });

  it('the public ?date= filter still takes any real date: out-of-range days are a 200 with no shows', async () => {
    const api = await signedInAdmin();
    const id = await insertRaw('raw', '2026-12-25');

    for (const date of ['0001-01-01', '1899-12-31', '2100-01-01', '2026-11-02']) {
      const res = await request(api.app).get(`/api/movies/${id}/showtimes?date=${date}`);
      expect(res.status, date).toBe(200);
    }
    // Not a real date: still the same 400 as before.
    const bad = await request(api.app).get(`/api/movies/${id}/showtimes?date=2026-02-30`);
    expect(bad.status).toBe(400);
  });
});
