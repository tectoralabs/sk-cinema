import { DEFAULT_BMS_BASE_URL } from '@sk-cinema/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Movie, Screen, Setting, Showtime } from '../generated/prisma/client.js';
import { MemoryCache } from '../lib/cache.js';
import { UNNORMALISABLE_FORMAT } from '../lib/showtimeFormat.js';
import {
  inMemoryAuthDb,
  testMovie,
  testScreen,
  testSetting,
  testShowtime,
} from '../test/helpers.js';
import { INVALID_BOOKING_URL_OVERRIDE } from './bmsLink.js';
import {
  PUBLIC_MOVIES_CACHE_PREFIX,
  PUBLIC_MOVIES_TTL_MS,
  invalidatePublicMovies,
} from './movie.public.service.js';
import { createSettingsService, INVALID_STORED_SETTING } from './settings.service.js';
import {
  PUBLIC_SHOWTIME_HORIZON_DAYS,
  PUBLIC_SHOWTIME_LIMIT_REACHED,
  PUBLIC_SHOWTIME_MAX_ROWS,
  createPublicShowtimeService,
  publicShowtimesCacheKey,
} from './showtime.public.service.js';

/** The injected clock: 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');
const INVALID_OVERRIDE = 'https://evil.example/buytickets/stolen-path';

const colombo = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);

interface SetupOptions {
  movie?: Partial<Movie>;
  screens?: Screen[];
  showtimes?: (Partial<Showtime> & Pick<Showtime, 'startsAt'>)[];
  settings?: Setting[];
}

function setup(options: SetupOptions = {}) {
  let nowMs = NOW.getTime();
  const movie = testMovie({ slug: 'main', title: 'Main', status: 'NOW_SHOWING', ...options.movie });
  const screen = testScreen({ name: 'Screen 1' });
  const db = inMemoryAuthDb({
    movies: [movie],
    screens: [screen, ...(options.screens ?? [])],
    showtimes: (options.showtimes ?? []).map((seed) =>
      testShowtime({ movieId: movie.id, screenId: screen.id, ...seed }),
    ),
    settings: options.settings ?? [],
  });
  const cache = new MemoryCache({ now: () => nowMs });
  const logger = { warn: vi.fn() };
  const service = createPublicShowtimeService({
    db: db.prisma,
    settings: createSettingsService({ db: db.prisma, logger }),
    cache,
    logger,
    now: () => new Date(nowMs),
  });
  const setClock = (at: Date | number) => {
    nowMs = at instanceof Date ? at.getTime() : at;
  };
  return { db, cache, logger, service, setClock, movie, screen };
}

describe('the database query', () => {
  it('reads the visible movie, then its live future shows on live active screens', async () => {
    const { db, service, movie } = setup();

    await service.listDates(movie.id);

    expect(db.spies.movie.findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { id: movie.id, isActive: true, deletedAt: null },
      select: { status: true },
    });
    expect(db.spies.showtime.findMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        movieId: movie.id,
        deletedAt: null,
        // Today + 60 days: to the end of 2026-12-31 in Colombo.
        startsAt: { gt: NOW, lt: colombo('2027-01-01', '00:00') },
        movie: { is: { isActive: true, deletedAt: null } },
        screen: { is: { deletedAt: null, isActive: true } },
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: 500,
      select: {
        id: true,
        startsAt: true,
        format: true,
        bookingUrlOverride: true,
        screen: { select: { name: true } },
      },
    });
  });

  it('counts the 60 days from the Colombo date, not the UTC date', async () => {
    const { db, service, movie, setClock } = setup();
    // 19:00Z on 1 Nov is already 00:30 on 2 Nov in Colombo.
    setClock(new Date('2026-11-01T19:00:00.000Z'));

    await service.listDates(movie.id);

    const [args] = db.spies.showtime.findMany.mock.calls[0] ?? [];
    expect(args).toMatchObject({ where: { startsAt: { lt: colombo('2027-01-02', '00:00') } } });
  });
});

describe('the limits', () => {
  it('are the documented values', () => {
    expect(PUBLIC_SHOWTIME_HORIZON_DAYS).toBe(60);
    expect(PUBLIC_SHOWTIME_MAX_ROWS).toBe(500);
  });

  it('lists every show up to the end of the 60th day, whole days, and none after', async () => {
    const { service, movie } = setup({
      showtimes: [
        { startsAt: colombo('2026-12-31', '00:00') },
        { startsAt: colombo('2026-12-31', '23:59') },
        { startsAt: colombo('2027-01-01', '00:00') },
        { startsAt: colombo('2027-01-15', '19:00') },
      ],
    });

    expect(await service.listDates(movie.id)).toEqual(['2026-12-31']);
    const items = await service.listForDate(movie.id, '2026-12-31');
    expect(items.map((item) => item.time)).toEqual(['00:00', '23:59']);
    expect(await service.listForDate(movie.id, '2027-01-01')).toEqual([]);
  });

  it('a show beyond the 60 days appears once its date comes into range', async () => {
    const { cache, service, movie, setClock } = setup({
      showtimes: [{ startsAt: colombo('2027-01-01', '19:00') }],
    });
    expect(await service.listDates(movie.id)).toEqual([]);

    setClock(colombo('2026-11-02', '00:00'));
    invalidatePublicMovies(cache);

    expect(await service.listDates(movie.id)).toEqual(['2027-01-01']);
  });

  it('holds the 500 soonest shows and warns once per fill', async () => {
    const start = colombo('2026-11-02', '10:00').getTime();
    // Every 2 hours: 505 shows fit well inside the 60 days, so only the row limit applies.
    const showtimes = Array.from({ length: PUBLIC_SHOWTIME_MAX_ROWS + 5 }, (_, i) => ({
      startsAt: new Date(start + i * 2 * 3_600_000),
    }));
    const { db, logger, service, movie } = setup({ showtimes });

    const dates = await service.listDates(movie.id);
    const last = showtimes[PUBLIC_SHOWTIME_MAX_ROWS - 1]?.startsAt;
    const firstLeftOut = showtimes[PUBLIC_SHOWTIME_MAX_ROWS]?.startsAt;
    if (!last || !firstLeftOut) throw new Error('fixture missing');

    const lastDate = dates.at(-1) ?? '';
    const items = await service.listForDate(movie.id, lastDate);
    expect(items.at(-1)?.startsAt).toBe(last.toISOString());
    expect(items.map((item) => item.startsAt)).not.toContain(firstLeftOut.toISOString());

    expect(db.spies.showtime.findMany).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      { movieId: movie.id, reason: PUBLIC_SHOWTIME_LIMIT_REACHED },
      expect.any(String),
    );
  });

  it('does not warn below the row limit', async () => {
    const start = colombo('2026-11-02', '10:00').getTime();
    const { logger, service, movie } = setup({
      showtimes: Array.from({ length: PUBLIC_SHOWTIME_MAX_ROWS - 1 }, (_, i) => ({
        startsAt: new Date(start + i * 2 * 3_600_000),
      })),
    });

    await service.listDates(movie.id);

    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('the booking settings', () => {
  const SHOWS = [
    { startsAt: colombo('2026-11-02', '10:00') },
    { startsAt: colombo('2026-11-02', '13:00') },
    { startsAt: colombo('2026-11-03', '10:00') },
  ];

  it('are read once per fill, not per row or per request', async () => {
    const { db, service, movie } = setup({ showtimes: SHOWS });

    await service.listForDate(movie.id, '2026-11-02');
    await service.listForDate(movie.id, '2026-11-03');
    await service.listDates(movie.id);

    expect(db.spies.setting.findMany).toHaveBeenCalledTimes(1);
  });

  it('are not read for a 404 or an ENDED movie', async () => {
    const ended = setup({ movie: { status: 'ENDED' }, showtimes: SHOWS });
    await ended.service.listDates(ended.movie.id);
    expect(ended.db.spies.setting.findMany).not.toHaveBeenCalled();

    const hidden = setup({ movie: { isActive: false }, showtimes: SHOWS });
    await expect(hidden.service.listDates(hidden.movie.id)).rejects.toMatchObject({ status: 404 });
    expect(hidden.db.spies.setting.findMany).not.toHaveBeenCalled();
  });
});

describe('warnings', () => {
  it('an unnormalisable format warns once per fill, without the stored value', async () => {
    const { logger, service, movie, db, cache } = setup({
      showtimes: [{ startsAt: colombo('2026-11-02', '10:00'), format: '2D/3D' }],
    });
    const id = db.showtimes[0]?.id;

    const [item] = await service.listForDate(movie.id, '2026-11-02');
    await service.listForDate(movie.id, '2026-11-02');
    await service.listDates(movie.id);

    expect(item?.format).toBeNull();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      { showtimeId: id, reason: UNNORMALISABLE_FORMAT },
      expect.any(String),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('2D/3D');

    invalidatePublicMovies(cache);
    await service.listDates(movie.id);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('a stored format in another case is normalised without a warning', async () => {
    const { logger, service, movie } = setup({
      showtimes: [{ startsAt: colombo('2026-11-02', '10:00'), format: '2d' }],
    });

    const [item] = await service.listForDate(movie.id, '2026-11-02');

    expect(item?.format).toBe('2D');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('an invalid override uses the generated link and warns once, without the URL', async () => {
    const { logger, service, movie, db } = setup({
      showtimes: [
        { startsAt: colombo('2026-11-02', '10:00'), bookingUrlOverride: INVALID_OVERRIDE },
      ],
    });
    const id = db.showtimes[0]?.id;

    const [item] = await service.listForDate(movie.id, '2026-11-02');
    await service.listForDate(movie.id, '2026-11-02');

    expect(item?.bookingUrl).toBe(`${DEFAULT_BMS_BASE_URL}/20261102`);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      { showtimeId: id, reason: INVALID_BOOKING_URL_OVERRIDE },
      expect.any(String),
    );
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).not.toContain('evil.example');
    expect(logged).not.toContain('stolen-path');
  });

  it('an invalid base URL row uses the default and warns, without the value', async () => {
    const { logger, service, movie } = setup({
      showtimes: [{ startsAt: colombo('2026-11-02', '10:00') }],
      settings: [testSetting('bmsBaseUrl', 'https://evil.example/buytickets/stolen-path')],
    });

    const [item] = await service.listForDate(movie.id, '2026-11-02');

    expect(item?.bookingUrl).toBe(`${DEFAULT_BMS_BASE_URL}/20261102`);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      { settingKey: 'bmsBaseUrl', reason: INVALID_STORED_SETTING },
      expect.any(String),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('evil.example');
  });
});

describe('the cache entry', () => {
  const SHOWS = [{ startsAt: colombo('2026-11-02', '19:00') }];

  it('is one key per movie under the public movies prefix, for the TTL', async () => {
    const { cache, db, service, movie, setClock } = setup({ showtimes: SHOWS });

    await service.listDates(movie.id);

    expect(publicShowtimesCacheKey(movie.id)).toBe(
      `${PUBLIC_MOVIES_CACHE_PREFIX}showtimes:${movie.id}`,
    );
    expect(cache.get(publicShowtimesCacheKey(movie.id))).toBeDefined();
    expect(cache.size).toBe(1);

    setClock(NOW.getTime() + PUBLIC_MOVIES_TTL_MS - 1);
    await service.listDates(movie.id);
    expect(db.spies.showtime.findMany).toHaveBeenCalledTimes(1);

    setClock(NOW.getTime() + PUBLIC_MOVIES_TTL_MS);
    await service.listDates(movie.id);
    expect(db.spies.showtime.findMany).toHaveBeenCalledTimes(2);
  });

  it('is cleared by invalidatePublicMovies', async () => {
    const { cache, service, movie } = setup({ showtimes: SHOWS });
    await service.listDates(movie.id);

    invalidatePublicMovies(cache);

    expect(cache.size).toBe(0);
  });

  it('is not stored for a 404', async () => {
    const { cache, service, movie } = setup({ movie: { deletedAt: NOW }, showtimes: SHOWS });

    await expect(service.listDates(movie.id)).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });

    expect(cache.size).toBe(0);
  });

  it('stores no stored override, only the resolved link', async () => {
    const { cache, service, movie } = setup({
      showtimes: [
        { startsAt: colombo('2026-11-02', '19:00'), bookingUrlOverride: INVALID_OVERRIDE },
      ],
    });

    await service.listDates(movie.id);

    expect(JSON.stringify(cache.get(publicShowtimesCacheKey(movie.id)))).not.toContain(
      'evil.example',
    );
  });
});

describe('the clock', () => {
  it('is read after the cache: a show that starts during a slow fill is left out', async () => {
    const startsAt = colombo('2026-11-01', '19:00');
    const { db, service, movie, setClock } = setup({ showtimes: [{ startsAt }] });
    const read = db.spies.showtime.findMany.getMockImplementation();
    if (!read) throw new Error('the fake has no implementation to wrap');
    db.spies.showtime.findMany.mockImplementationOnce(async (args) => {
      const rows = await read(args);
      setClock(startsAt); // the database took long enough for the show to start
      return rows;
    });

    expect(await service.listDates(movie.id)).toEqual([]);
  });

  it('filters the entry on every request, without a new query', async () => {
    // Inside the 5-minute TTL: the entry is still cached when the show starts.
    const startsAt = colombo('2026-11-01', '15:32');
    const { db, service, movie, setClock } = setup({ showtimes: [{ startsAt }] });

    expect(await service.listDates(movie.id)).toEqual(['2026-11-01']);
    setClock(startsAt.getTime() - 1);
    expect(await service.listDates(movie.id)).toEqual(['2026-11-01']);
    setClock(startsAt);
    expect(await service.listDates(movie.id)).toEqual([]);
    expect(await service.listForDate(movie.id, '2026-11-01')).toEqual([]);

    expect(db.spies.showtime.findMany).toHaveBeenCalledTimes(1);
  });
});
