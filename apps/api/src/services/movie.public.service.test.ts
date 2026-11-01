import { movieStatusSchema, publicMovieStatusSchema } from '@sk-cinema/shared';
import { describe, expect, it } from 'vitest';
import { MovieStatus } from '../generated/prisma/enums.js';
import { MemoryCache } from '../lib/cache.js';
import { inMemoryAuthDb, testMovie } from '../test/helpers.js';
import {
  PUBLIC_MOVIES_CACHE_PREFIX,
  PUBLIC_MOVIES_TTL_MS,
  createPublicMovieService,
  formatDateOnly,
  invalidatePublicMovies,
} from './movie.public.service.js';

describe('movie status enum parity', () => {
  it('the shared Zod enum matches the Prisma MovieStatus enum, in order', () => {
    expect(movieStatusSchema.options).toEqual(Object.values(MovieStatus));
  });

  it('the public list statuses are a subset without ENDED', () => {
    expect(publicMovieStatusSchema.options).toEqual(['UPCOMING', 'NOW_SHOWING']);
    for (const status of publicMovieStatusSchema.options) {
      expect(Object.values(MovieStatus)).toContain(status);
    }
  });
});

describe('formatDateOnly', () => {
  it.each([
    ['2026-11-01T00:00:00.000Z', '2026-11-01'],
    ['2026-12-31T00:00:00.000Z', '2026-12-31'],
    ['2027-01-01T00:00:00.000Z', '2027-01-01'],
    ['2028-02-29T00:00:00.000Z', '2028-02-29'],
    // Uses UTC getters: no shift to Asia/Colombo (+05:30) or the server's zone.
    ['2026-11-01T23:59:59.999Z', '2026-11-01'],
  ])('%s -> %s', (instant, expected) => {
    expect(formatDateOnly(new Date(instant))).toBe(expected);
  });

  it('pads years below 1000 to four digits', () => {
    const date = new Date(0);
    date.setUTCFullYear(999, 0, 5);
    expect(formatDateOnly(date)).toBe('0999-01-05');
  });
});

describe('createPublicMovieService', () => {
  const setup = () => {
    const db = inMemoryAuthDb({
      movies: [
        testMovie({ slug: 'ns', title: 'NS', status: 'NOW_SHOWING' }),
        testMovie({ slug: 'up', title: 'UP', status: 'UPCOMING' }),
      ],
    });
    const cache = new MemoryCache();
    return { db, cache, service: createPublicMovieService({ db: db.prisma, cache }) };
  };

  it('queries each status with its own order: release date, then title, then id', async () => {
    const { db, service } = setup();
    await service.list(undefined);

    const calls = db.spies.movie.findMany.mock.calls.map(([args]) => args as object);
    expect(calls).toEqual([
      expect.objectContaining({
        where: { isActive: true, deletedAt: null, status: 'NOW_SHOWING' },
        orderBy: [
          { releaseDate: { sort: 'desc', nulls: 'last' } },
          { title: 'asc' },
          { id: 'asc' },
        ],
        take: 100,
      }),
      expect.objectContaining({
        where: { isActive: true, deletedAt: null, status: 'UPCOMING' },
        orderBy: [{ releaseDate: { sort: 'asc', nulls: 'last' } }, { title: 'asc' }, { id: 'asc' }],
        take: 100,
      }),
    ]);
  });

  it('caches under movies:public: keys for PUBLIC_MOVIES_TTL_MS', async () => {
    let now = 0;
    const db = inMemoryAuthDb({ movies: [testMovie({ slug: 'up', status: 'UPCOMING' })] });
    const cache = new MemoryCache({ now: () => now });
    const service = createPublicMovieService({ db: db.prisma, cache });

    await service.list('UPCOMING');
    await service.list(undefined);
    await service.getBySlug('up');

    expect(cache.get(`${PUBLIC_MOVIES_CACHE_PREFIX}list:UPCOMING`)).toBeDefined();
    expect(cache.get(`${PUBLIC_MOVIES_CACHE_PREFIX}list:all`)).toBeDefined();
    expect(cache.get(`${PUBLIC_MOVIES_CACHE_PREFIX}slug:up`)).toBeDefined();
    expect(PUBLIC_MOVIES_TTL_MS).toBe(5 * 60_000);

    now = PUBLIC_MOVIES_TTL_MS - 1;
    await service.getBySlug('up');
    expect(db.spies.movie.findUnique).toHaveBeenCalledTimes(1);

    now = PUBLIC_MOVIES_TTL_MS;
    await service.getBySlug('up');
    expect(db.spies.movie.findUnique).toHaveBeenCalledTimes(2);
  });

  it('does not store a miss in the cache', async () => {
    const { cache, service } = setup();

    await expect(service.getBySlug('missing')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(cache.size).toBe(0);
  });

  it('invalidatePublicMovies drops only public movie keys', async () => {
    const { cache, service } = setup();
    cache.set('health:db', true, 60_000);
    await service.list(undefined);
    await service.getBySlug('ns');

    invalidatePublicMovies(cache);

    expect(cache.size).toBe(1);
    expect(cache.get('health:db')).toBe(true);
  });
});
