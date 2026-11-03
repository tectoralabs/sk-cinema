/**
 * Phase 5 T18b: control characters in free text, through the routes on real Postgres. Postgres
 * refuses NUL in text (a 500 if it got that far) and stores the other control characters as sent,
 * so the request schemas refuse them all with a 400. Line breaks and tabs stay legal in a synopsis,
 * and a row that already holds a control character (legal in Postgres, and possible through manual
 * SQL or data from before the rule) still reads back.
 */
import { randomUUID } from 'node:crypto';
import {
  adminMovieListResponseSchema,
  adminMovieResponseSchema,
  adminScreenListResponseSchema,
  adminScreenResponseSchema,
  publicMovieListResponseSchema,
  publicMovieResponseSchema,
} from '@sk-cinema/shared';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { describePg, disconnectTestPrisma, resetDatabase, testPrisma } from './db.js';
import { expectValidationError, freezeClock, signedInAdmin } from './http.js';

/** 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');

const MOVIE = { title: 'Main Feature', durationMinutes: 120 };

const counts = async () => ({
  screens: await testPrisma().screen.count(),
  movies: await testPrisma().movie.count(),
  audits: await testPrisma().auditLog.count({ where: { entity: { in: ['Screen', 'Movie'] } } }),
});
const NOTHING_STORED = { screens: 0, movies: 0, audits: 0 };

describePg('control characters through the routes on real Postgres', () => {
  beforeEach(async () => {
    freezeClock(NOW);
    await resetDatabase();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(disconnectTestPrisma);

  it.each([
    ['NUL', 'a\u0000b'],
    ['U+0001', 'a\u0001b'],
  ])('a screen name with %s is a 400 and nothing is stored', async (_label, name) => {
    const api = await signedInAdmin();

    const res = await api.post('/screens', { name });

    expectValidationError(res, ['body', 'name']);
    expect(await counts()).toEqual(NOTHING_STORED);
  });

  it.each(['screens', 'movies'])('?search with NUL on the %s list is a 400', async (list) => {
    const api = await signedInAdmin();

    const res = await api.get(`/${list}?search=a%00`);

    expectValidationError(res, ['query', 'search']);
  });

  it('a movie title with NUL is a 400 and nothing is stored', async () => {
    const api = await signedInAdmin();

    const res = await api.post('/movies', { ...MOVIE, title: 'a\u0000b' });

    expectValidationError(res, ['body', 'title']);
    expect(await counts()).toEqual(NOTHING_STORED);
  });

  it('a genres entry with NUL is a 400 and nothing is stored', async () => {
    const api = await signedInAdmin();

    const res = await api.post('/movies', { ...MOVIE, genres: ['Drama', 'a\u0000b'] });

    expectValidationError(res, ['body', 'genres', 1]);
    expect(await counts()).toEqual(NOTHING_STORED);
  });

  it('a synopsis with NUL is a 400 and nothing is stored', async () => {
    const api = await signedInAdmin();

    const res = await api.post('/movies', { ...MOVIE, synopsis: 'First line\n\u0000second' });

    expectValidationError(res, ['body', 'synopsis']);
    expect(await counts()).toEqual(NOTHING_STORED);
  });

  it('a synopsis with line breaks and tabs stores and reads back exactly', async () => {
    const api = await signedInAdmin();
    const synopsis = 'First line\n\tIndented line\r\nThird\tline';

    const created = await api.post('/movies', { ...MOVIE, synopsis });

    expect(created.status).toBe(201);
    const { movie } = adminMovieResponseSchema.parse(created.body);
    expect(movie.synopsis).toBe(synopsis);
    const stored = await testPrisma().movie.findUniqueOrThrow({ where: { id: movie.id } });
    expect(stored.synopsis).toBe(synopsis);
    const read = await api.get(`/movies/${movie.id}`);
    expect(read.status).toBe(200);
    expect(adminMovieResponseSchema.parse(read.body).movie.synopsis).toBe(synopsis);
  });

  it('a screen row already holding U+0001 still reads back through the admin routes', async () => {
    const api = await signedInAdmin();
    const id = randomUUID();
    const name = 'Old\u0001Screen';
    await testPrisma().$executeRaw`
      INSERT INTO "Screen" ("id", "name", "updatedAt") VALUES (${id}::uuid, ${name}, ${NOW})`;

    const one = await api.get(`/screens/${id}`);
    const list = await api.get('/screens');

    expect(one.status).toBe(200);
    expect(adminScreenResponseSchema.parse(one.body).screen.name).toBe(name);
    expect(list.status).toBe(200);
    expect(adminScreenListResponseSchema.parse(list.body).items.map((s) => s.name)).toEqual([name]);
  });

  it('a movie row already holding U+0001 still reads back, admin and public', async () => {
    const api = await signedInAdmin();
    const id = randomUUID();
    const title = 'Old\u0001Title';
    await testPrisma().$executeRaw`
      INSERT INTO "Movie" ("id", "slug", "title", "durationMinutes", "status", "updatedAt")
      VALUES (${id}::uuid, 'old-title', ${title}, 120, 'NOW_SHOWING'::"MovieStatus", ${NOW})`;

    const adminOne = await api.get(`/movies/${id}`);
    const adminList = await api.get('/movies');
    const publicOne = await request(api.app).get('/api/movies/old-title');
    const publicList = await request(api.app).get('/api/movies');

    expect(adminOne.status).toBe(200);
    expect(adminMovieResponseSchema.parse(adminOne.body).movie.title).toBe(title);
    expect(adminList.status).toBe(200);
    expect(adminMovieListResponseSchema.parse(adminList.body).items.map((m) => m.title)).toEqual([
      title,
    ]);
    expect(publicOne.status).toBe(200);
    expect(publicMovieResponseSchema.parse(publicOne.body).movie.title).toBe(title);
    expect(publicList.status).toBe(200);
    expect(publicMovieListResponseSchema.parse(publicList.body).movies.map((m) => m.title)).toEqual(
      [title],
    );
  });
});
