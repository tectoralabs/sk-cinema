import {
  apiErrorSchema,
  publicMovieListResponseSchema,
  publicMovieResponseSchema,
  type PublicMovie,
} from '@sk-cinema/shared';
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Movie } from '../generated/prisma/client.js';
import {
  PUBLIC_MOVIE_LIST_LIMIT,
  invalidatePublicMovies,
} from '../services/movie.public.service.js';
import {
  ADMIN_ORIGIN,
  PUBLIC_ORIGIN,
  buildTestApp,
  inMemoryAuthDb,
  testMovie,
} from '../test/helpers.js';

const BASE = '/api/movies';

/** Columns that must never appear in a public response. */
const ADMIN_ONLY_KEYS = [
  'deletedAt',
  'isActive',
  'posterPublicId',
  'bannerPublicId',
  'createdAt',
  'updatedAt',
] as const;

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/**
 * A fully filled movie, so a leaked admin column would carry a value. Every fixture uses it,
 * with admin-only columns set, even on the visible movies.
 */
const movie = (overrides: Partial<Movie> & Pick<Movie, 'slug' | 'title'>): Movie =>
  testMovie({
    synopsis: `About ${overrides.title}`,
    durationMinutes: 130,
    language: 'Sinhala',
    genres: ['Drama'],
    rating: 'PG',
    director: 'A Director',
    cast: ['Lead One', 'Lead Two'],
    trailerUrl: 'https://youtu.be/dQw4w9WgXcQ',
    posterUrl: 'https://res.cloudinary.com/sk/image/upload/poster.jpg',
    posterPublicId: 'sk/posters/secret-poster-id',
    bannerUrl: 'https://res.cloudinary.com/sk/image/upload/banner.jpg',
    bannerPublicId: 'sk/banners/secret-banner-id',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    updatedAt: new Date('2026-01-03T03:04:05.000Z'),
    ...overrides,
  });

// Two movies that tie on status, date and title: only `id` orders them. The one with the
// larger id is seeded first, so the fake's stable sort would get it wrong without the id key.
const tieLow = movie({
  slug: 'tie-low',
  title: 'Echo',
  status: 'NOW_SHOWING',
  releaseDate: day('2026-10-01'),
});
const tieHigh = movie({
  slug: 'tie-high',
  title: 'Echo',
  status: 'NOW_SHOWING',
  releaseDate: day('2026-10-01'),
});

const VISIBLE_MOVIES: Movie[] = [
  movie({ slug: 'up-later', title: 'Golf', status: 'UPCOMING', releaseDate: day('2026-12-25') }),
  movie({ slug: 'ns-old', title: 'Alpha', status: 'NOW_SHOWING', releaseDate: day('2026-09-01') }),
  movie({ slug: 'up-undated', title: 'Hotel', status: 'UPCOMING', releaseDate: null }),
  movie({ slug: 'ns-undated', title: 'Charlie', status: 'NOW_SHOWING', releaseDate: null }),
  tieHigh,
  movie({ slug: 'ns-new', title: 'Bravo', status: 'NOW_SHOWING', releaseDate: day('2026-10-20') }),
  movie({ slug: 'up-soon', title: 'Foxtrot', status: 'UPCOMING', releaseDate: day('2026-11-15') }),
  tieLow,
  movie({
    slug: 'ns-delta',
    title: 'Delta',
    status: 'NOW_SHOWING',
    releaseDate: day('2026-10-01'),
  }),
  movie({ slug: 'ended', title: 'India', status: 'ENDED', releaseDate: day('2026-06-01') }),
];

/** Never public: deactivated, soft-deleted, or both. One of each per listable status. */
const HIDDEN_MOVIES: Movie[] = [
  movie({ slug: 'hidden-inactive-ns', title: 'Juliet', status: 'NOW_SHOWING', isActive: false }),
  movie({ slug: 'hidden-inactive-up', title: 'Kilo', status: 'UPCOMING', isActive: false }),
  movie({
    slug: 'hidden-deleted-ns',
    title: 'Lima',
    status: 'NOW_SHOWING',
    deletedAt: new Date('2026-10-01T00:00:00.000Z'),
  }),
  movie({
    slug: 'hidden-deleted-up',
    title: 'Mike',
    status: 'UPCOMING',
    deletedAt: new Date('2026-10-01T00:00:00.000Z'),
  }),
  movie({
    slug: 'hidden-both-ns',
    title: 'November',
    status: 'NOW_SHOWING',
    isActive: false,
    deletedAt: new Date('2026-10-01T00:00:00.000Z'),
  }),
  movie({
    slug: 'hidden-both-ended',
    title: 'Oscar',
    status: 'ENDED',
    isActive: false,
    deletedAt: new Date('2026-10-01T00:00:00.000Z'),
  }),
];

const HIDDEN_SLUGS = HIDDEN_MOVIES.map((m) => m.slug);

const EXPECTED_NOW_SHOWING = ['ns-new', 'ns-delta', 'tie-low', 'tie-high', 'ns-old', 'ns-undated'];
const EXPECTED_UPCOMING = ['up-soon', 'up-later', 'up-undated'];

function setup(movies: Movie[] = [...VISIBLE_MOVIES, ...HIDDEN_MOVIES]) {
  const db = inMemoryAuthDb({ movies });
  const { app, cache } = buildTestApp({ prisma: db.prisma });
  return { app, cache, db };
}

/** GET a list and check the body against the strict public response schema. */
async function getList(app: Express, query = '') {
  const res = await request(app).get(`${BASE}${query}`);
  expect(res.status).toBe(200);
  const body = publicMovieListResponseSchema.parse(res.body);
  return { res, movies: body.movies };
}

async function getOne(app: Express, slug: string) {
  const res = await request(app).get(`${BASE}/${slug}`);
  expect(res.status).toBe(200);
  return { res, movie: publicMovieResponseSchema.parse(res.body).movie };
}

const slugs = (movies: PublicMovie[]) => movies.map((m) => m.slug);

function expectNoAdminKeys(value: object) {
  for (const key of ADMIN_ONLY_KEYS) expect(value).not.toHaveProperty(key);
}

function expectError(res: request.Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const { error } = apiErrorSchema.parse(res.body);
  expect(error.code).toBe(code);
  expect(res.text).not.toMatch(/stack|at .+\.ts/i);
  return error;
}

describe('GET /api/movies', () => {
  it('lists NOW_SHOWING (newest first) then UPCOMING (soonest first), never ENDED', async () => {
    const { app } = setup();
    const { movies } = await getList(app);

    expect(slugs(movies)).toEqual([...EXPECTED_NOW_SHOWING, ...EXPECTED_UPCOMING]);
    expect(movies.some((m) => m.status === 'ENDED')).toBe(false);
  });

  it('breaks ties on title, then id (not table order)', async () => {
    const { app } = setup();
    const { movies } = await getList(app, '?status=NOW_SHOWING');

    expect(tieLow.id < tieHigh.id).toBe(true);
    const order = slugs(movies);
    // Delta < Echo by title; the two Echos by id.
    expect(order.indexOf('ns-delta')).toBeLessThan(order.indexOf('tie-low'));
    expect(order.indexOf('tie-low')).toBeLessThan(order.indexOf('tie-high'));
  });

  it('?status=NOW_SHOWING returns only now-showing movies, newest release first, undated last', async () => {
    const { app } = setup();
    const { movies } = await getList(app, '?status=NOW_SHOWING');

    expect(slugs(movies)).toEqual(EXPECTED_NOW_SHOWING);
  });

  it('?status=UPCOMING returns only upcoming movies, soonest release first, undated last', async () => {
    const { app } = setup();
    const { movies } = await getList(app, '?status=UPCOMING');

    expect(slugs(movies)).toEqual(EXPECTED_UPCOMING);
  });

  it('returns an empty list when nothing is visible', async () => {
    const { app } = setup(HIDDEN_MOVIES);
    const { movies } = await getList(app);

    expect(movies).toEqual([]);
  });

  it('never lists inactive, soft-deleted or inactive+deleted movies, whatever the status filter', async () => {
    const { app } = setup();

    for (const query of ['', '?status=NOW_SHOWING', '?status=UPCOMING']) {
      const { movies } = await getList(app, query);
      for (const slug of HIDDEN_SLUGS) expect(slugs(movies)).not.toContain(slug);
    }
  });

  it('only asks the database for visible movies and public columns', async () => {
    const { app, db } = setup();
    await getList(app);

    expect(db.spies.movie.findMany).toHaveBeenCalledTimes(2);
    for (const [args] of db.spies.movie.findMany.mock.calls) {
      expect(args).toMatchObject({
        where: { isActive: true, deletedAt: null },
        take: PUBLIC_MOVIE_LIST_LIMIT,
      });
      const selected = Object.keys((args as { select: object }).select);
      for (const key of ADMIN_ONLY_KEYS) expect(selected).not.toContain(key);
    }
  });

  describe('caps the list at 100', () => {
    const many = (status: Movie['status'], count: number, prefix: string) =>
      Array.from({ length: count }, (_, i) =>
        testMovie({
          slug: `${prefix}-${String(i).padStart(3, '0')}`,
          title: `${prefix} ${String(i).padStart(3, '0')}`,
          status,
        }),
      );

    it('per status', async () => {
      const { app } = setup(many('UPCOMING', 105, 'up'));
      const { movies } = await getList(app, '?status=UPCOMING');

      expect(movies).toHaveLength(100);
      expect(movies[0]?.slug).toBe('up-000');
      expect(movies[99]?.slug).toBe('up-099');
    });

    it('in total by default, now-showing movies first', async () => {
      const { app } = setup([...many('UPCOMING', 5, 'up'), ...many('NOW_SHOWING', 98, 'ns')]);
      const { movies } = await getList(app);

      expect(movies).toHaveLength(100);
      expect(movies.slice(0, 98).every((m) => m.status === 'NOW_SHOWING')).toBe(true);
      expect(slugs(movies.slice(98))).toEqual(['up-000', 'up-001']);
    });

    it('in total by default, when now-showing alone fills it', async () => {
      const { app } = setup([...many('UPCOMING', 3, 'up'), ...many('NOW_SHOWING', 101, 'ns')]);
      const { movies } = await getList(app);

      expect(movies).toHaveLength(100);
      expect(movies.every((m) => m.status === 'NOW_SHOWING')).toBe(true);
    });
  });

  describe('validation', () => {
    it('rejects status=ENDED with 400 VALIDATION_ERROR', async () => {
      const { app, db } = setup();
      const res = await request(app).get(`${BASE}?status=ENDED`);

      const error = expectError(res, 400, 'VALIDATION_ERROR');
      expect(error.message).toBe('Invalid request');
      expect(error.details).toEqual([
        { path: ['query', 'status'], message: expect.any(String) as unknown },
      ]);
      expect(db.spies.movie.findMany).not.toHaveBeenCalled();
    });

    it.each([
      ['an unknown status', '?status=SHOWING'],
      ['a lowercase status', '?status=now_showing'],
      ['an empty status', '?status='],
      ['a repeated status', '?status=UPCOMING&status=NOW_SHOWING'],
    ])('rejects %s with 400', async (_name, query) => {
      const { app } = setup();
      expectError(await request(app).get(`${BASE}${query}`), 400, 'VALIDATION_ERROR');
    });

    it('rejects unknown query keys with 400 and names the key', async () => {
      const { app, db } = setup();
      const res = await request(app).get(`${BASE}?status=UPCOMING&page=2`);

      const error = expectError(res, 400, 'VALIDATION_ERROR');
      expect(JSON.stringify(error.details)).toContain('page');
      expect(db.spies.movie.findMany).not.toHaveBeenCalled();
    });
  });
});

describe('GET /api/movies/:slug', () => {
  it('returns a visible movie with exactly the public fields', async () => {
    const { app } = setup();
    const source = VISIBLE_MOVIES.find((m) => m.slug === 'ns-new');
    if (!source) throw new Error('fixture missing');
    const { movie: body } = await getOne(app, 'ns-new');

    expect(body).toEqual({
      id: source.id,
      slug: 'ns-new',
      title: 'Bravo',
      synopsis: 'About Bravo',
      durationMinutes: 130,
      language: 'Sinhala',
      genres: ['Drama'],
      rating: 'PG',
      director: 'A Director',
      cast: ['Lead One', 'Lead Two'],
      releaseDate: '2026-10-20',
      trailerUrl: 'https://youtu.be/dQw4w9WgXcQ',
      status: 'NOW_SHOWING',
      posterUrl: 'https://res.cloudinary.com/sk/image/upload/poster.jpg',
      bannerUrl: 'https://res.cloudinary.com/sk/image/upload/banner.jpg',
    } satisfies PublicMovie);
  });

  it('returns an UPCOMING movie', async () => {
    const { app } = setup();
    const { movie: body } = await getOne(app, 'up-soon');
    expect(body.status).toBe('UPCOMING');
  });

  it('returns an ENDED movie, so old links keep working', async () => {
    const { app } = setup();
    const { movie: body } = await getOne(app, 'ended');
    expect(body).toMatchObject({ slug: 'ended', status: 'ENDED' });
  });

  it('answers inactive, soft-deleted and inactive+deleted movies exactly like an unknown slug', async () => {
    const { app } = setup();
    const unknown = await request(app).get(`${BASE}/no-such-movie`);
    expectError(unknown, 404, 'NOT_FOUND');
    expect(unknown.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Movie not found' } });

    for (const slug of HIDDEN_SLUGS) {
      const res = await request(app).get(`${BASE}/${slug}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual(unknown.body);
    }
  });

  it('only asks the database for a visible movie and public columns', async () => {
    const { app, db } = setup();
    await getOne(app, 'ns-new');

    expect(db.spies.movie.findUnique).toHaveBeenCalledTimes(1);
    const [args] = db.spies.movie.findUnique.mock.calls[0] ?? [];
    expect(args).toMatchObject({ where: { slug: 'ns-new', isActive: true, deletedAt: null } });
    const selected = Object.keys((args as { select: object }).select);
    for (const key of ADMIN_ONLY_KEYS) expect(selected).not.toContain(key);
  });

  describe('validation', () => {
    it.each([
      ['uppercase letters', 'NS-New'],
      ['an underscore', 'ns_new'],
      ['a double hyphen', 'ns--new'],
      ['a leading hyphen', '-ns-new'],
      ['an encoded slash', 'ns%2Fnew'],
      ['a space', 'ns%20new'],
      ['more than 160 characters', 'a'.repeat(161)],
    ])('rejects a slug with %s with 400', async (_name, slug) => {
      const { app, db } = setup();
      const res = await request(app).get(`${BASE}/${slug}`);

      const error = expectError(res, 400, 'VALIDATION_ERROR');
      expect(error.details).toEqual([
        { path: ['params', 'slug'], message: expect.any(String) as unknown },
      ]);
      expect(db.spies.movie.findUnique).not.toHaveBeenCalled();
    });

    it('rejects any query key with 400', async () => {
      const { app, db } = setup();
      const res = await request(app).get(`${BASE}/ns-new?status=NOW_SHOWING`);

      const error = expectError(res, 400, 'VALIDATION_ERROR');
      expect(JSON.stringify(error.details)).toContain('status');
      expect(db.spies.movie.findUnique).not.toHaveBeenCalled();
    });
  });
});

describe('public movie responses never carry admin data', () => {
  it('in the list (every status filter) and in the detail of every visible movie', async () => {
    const { app } = setup();

    for (const query of ['', '?status=NOW_SHOWING', '?status=UPCOMING']) {
      const { res, movies } = await getList(app, query);
      expect(movies.length).toBeGreaterThan(0);
      for (const m of (res.body as { movies: object[] }).movies) expectNoAdminKeys(m);
      expect(res.text).not.toContain('secret-poster-id');
      expect(res.text).not.toContain('secret-banner-id');
    }

    for (const { slug } of VISIBLE_MOVIES) {
      const { res } = await getOne(app, slug);
      expectNoAdminKeys((res.body as { movie: object }).movie);
      expect(res.text).not.toContain('secret-poster-id');
      expect(res.text).not.toContain('secret-banner-id');
    }
  });
});

describe('releaseDate', () => {
  it('formats a @db.Date (UTC midnight) as the same calendar day, and keeps null', async () => {
    const { app } = setup([
      movie({ slug: 'new-year', title: 'A', releaseDate: day('2027-01-01') }),
      movie({ slug: 'year-end', title: 'B', releaseDate: day('2026-12-31') }),
      movie({ slug: 'undated', title: 'C', releaseDate: null }),
    ]);

    expect((await getOne(app, 'new-year')).movie.releaseDate).toBe('2027-01-01');
    expect((await getOne(app, 'year-end')).movie.releaseDate).toBe('2026-12-31');
    expect((await getOne(app, 'undated')).movie.releaseDate).toBeNull();
  });
});

describe('caching', () => {
  it('serves a second identical list request from the cache', async () => {
    const { app, db } = setup();

    const first = await getList(app, '?status=UPCOMING');
    const second = await getList(app, '?status=UPCOMING');

    expect(db.spies.movie.findMany).toHaveBeenCalledTimes(1);
    expect(second.movies).toEqual(first.movies);
  });

  it('caches the default list (two queries, once) separately from each status', async () => {
    const { app, db } = setup();

    await getList(app);
    await getList(app);
    expect(db.spies.movie.findMany).toHaveBeenCalledTimes(2);

    await getList(app, '?status=NOW_SHOWING');
    expect(db.spies.movie.findMany).toHaveBeenCalledTimes(3);
  });

  it('serves a second identical detail request from the cache', async () => {
    const { app, db } = setup();

    await getOne(app, 'ns-new');
    await getOne(app, 'ns-new');

    expect(db.spies.movie.findUnique).toHaveBeenCalledTimes(1);
  });

  it('shares one database query between concurrent identical requests', async () => {
    const { app, db } = setup();

    await Promise.all([getList(app, '?status=UPCOMING'), getList(app, '?status=UPCOMING')]);

    expect(db.spies.movie.findMany).toHaveBeenCalledTimes(1);
  });

  it('does not cache a 404: the next request asks the database again', async () => {
    const { app, db } = setup();

    expect((await request(app).get(`${BASE}/coming-later`)).status).toBe(404);
    expect((await request(app).get(`${BASE}/coming-later`)).status).toBe(404);
    expect(db.spies.movie.findUnique).toHaveBeenCalledTimes(2);

    db.addMovie(movie({ slug: 'coming-later', title: 'Later' }));
    await getOne(app, 'coming-later');
  });

  it('does not cache a database failure', async () => {
    const { app, db } = setup();
    db.injectFault('movie', 'findMany', { error: new Error('Connection terminated unexpectedly') });

    const failed = await request(app).get(`${BASE}?status=UPCOMING`);
    expectError(failed, 500, 'INTERNAL_ERROR');
    expect(failed.text).not.toContain('Connection terminated');

    const { movies } = await getList(app, '?status=UPCOMING');
    expect(slugs(movies)).toEqual(EXPECTED_UPCOMING);
  });

  it('keeps serving cached data until invalidatePublicMovies, then reloads lists and details', async () => {
    const { app, cache, db } = setup();

    await getList(app, '?status=UPCOMING');
    await getOne(app, 'up-soon');

    // A write the cache knows nothing about yet (as an admin write before it invalidates).
    await db.prisma.movie.update({
      where: { slug: 'up-soon' },
      data: { title: 'Foxtrot Renamed' },
    });
    expect((await getOne(app, 'up-soon')).movie.title).toBe('Foxtrot');
    expect(db.spies.movie.findMany).toHaveBeenCalledTimes(1);
    expect(db.spies.movie.findUnique).toHaveBeenCalledTimes(1);

    invalidatePublicMovies(cache);

    expect((await getOne(app, 'up-soon')).movie.title).toBe('Foxtrot Renamed');
    const { movies } = await getList(app, '?status=UPCOMING');
    expect(movies.find((m) => m.slug === 'up-soon')?.title).toBe('Foxtrot Renamed');
    expect(db.spies.movie.findMany).toHaveBeenCalledTimes(2);
    expect(db.spies.movie.findUnique).toHaveBeenCalledTimes(2);
  });

  it('a movie hidden after being cached disappears once the cache is invalidated', async () => {
    const { app, cache, db } = setup();
    await getOne(app, 'ns-new');
    expect(slugs((await getList(app)).movies)).toContain('ns-new');

    await db.prisma.movie.update({ where: { slug: 'ns-new' }, data: { isActive: false } });
    invalidatePublicMovies(cache);

    expectError(await request(app).get(`${BASE}/ns-new`), 404, 'NOT_FOUND');
    expect(slugs((await getList(app)).movies)).not.toContain('ns-new');
  });
});

describe('CORS', () => {
  it('allows the public origin without credentials', async () => {
    const { app } = setup();

    for (const path of [BASE, `${BASE}/ns-new`]) {
      const res = await request(app).get(path).set('Origin', PUBLIC_ORIGIN);
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(PUBLIC_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    }
  });

  it('also on errors, so the public site can read a 400 or 404', async () => {
    const { app } = setup();

    for (const path of [`${BASE}?status=ENDED`, `${BASE}/no-such-movie`]) {
      const res = await request(app).get(path).set('Origin', PUBLIC_ORIGIN);
      expect(res.headers['access-control-allow-origin']).toBe(PUBLIC_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    }
  });

  it('gives the admin origin its usual credentialed CORS (it is outside /api/admin)', async () => {
    const { app } = setup();
    const res = await request(app).get(BASE).set('Origin', ADMIN_ORIGIN);

    expect(res.headers['access-control-allow-origin']).toBe(ADMIN_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('needs no session or CSRF token', async () => {
    const { app } = setup();
    const res = await request(app).get(BASE);

    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});
