import { randomUUID } from 'node:crypto';
import {
  apiErrorSchema,
  DEFAULT_BMS_BASE_URL,
  publicShowtimeDatesResponseSchema,
  publicShowtimeListResponseSchema,
  type PublicShowtime,
} from '@sk-cinema/shared';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Movie, Screen, Setting, Showtime } from '../generated/prisma/client.js';
import { PUBLIC_MOVIES_TTL_MS, invalidatePublicMovies } from '../services/movie.public.service.js';
import {
  ADMIN_ORIGIN,
  PUBLIC_ORIGIN,
  buildTestApp,
  inMemoryAuthDb,
  testMovie,
  testScreen,
  testSetting,
  testShowtime,
} from '../test/helpers.js';

/** The app's clock (only Date is faked): 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');
const DELETED_AT = new Date('2026-10-01T00:00:00.000Z');
const OVERRIDE = 'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/special-premiere/20261102';
const CUSTOM_BASE = 'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/cinema-snlk-SKCM-MT2';

const colombo = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);

const MOVIE_404_BODY = { error: { code: 'NOT_FOUND', message: 'Movie not found' } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

interface SetupOptions {
  /** Overrides on the main movie. */
  movie?: Partial<Movie>;
  movies?: Movie[];
  screens?: Screen[];
  /** Showtimes; `movieId` / `screenId` default to the main movie and screen. */
  showtimes?: (Partial<Showtime> & Pick<Showtime, 'startsAt'>)[];
  settings?: Setting[];
}

function setup(options: SetupOptions = {}) {
  const movie = testMovie({
    slug: 'main-feature',
    title: 'Main Feature',
    status: 'NOW_SHOWING',
    ...options.movie,
  });
  const screen = testScreen({ name: 'Screen 1' });
  const db = inMemoryAuthDb({
    movies: [movie, ...(options.movies ?? [])],
    screens: [screen, ...(options.screens ?? [])],
    showtimes: (options.showtimes ?? []).map((seed) =>
      testShowtime({ movieId: movie.id, screenId: screen.id, ...seed }),
    ),
    settings: options.settings ?? [],
  });
  const { app, cache } = buildTestApp({ prisma: db.prisma });
  return { app, cache, db, movie, screen };
}

const datesPath = (id: string) => `/api/movies/${id}/dates`;
const showtimesPath = (id: string, date: string) => `/api/movies/${id}/showtimes?date=${date}`;

/** GET /dates: 200, no-store, and a body the strict shared schema accepts. */
async function getDates(app: Express, id: string) {
  const res = await request(app).get(datesPath(id));
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  return { res, dates: publicShowtimeDatesResponseSchema.parse(res.body).dates };
}

/** GET /showtimes: 200, no-store, and a body the strict shared schema accepts. */
async function getItems(app: Express, id: string, date: string) {
  const res = await request(app).get(showtimesPath(id, date));
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  const body = publicShowtimeListResponseSchema.parse(res.body);
  expect(body.date).toBe(date);
  return { res, items: body.items };
}

const ids = (items: PublicShowtime[]) => items.map((item) => item.id);

function expectError(res: request.Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers['cache-control']).toBe('no-store');
  const { error } = apiErrorSchema.parse(res.body);
  expect(error.code).toBe(code);
  expect(res.text).not.toMatch(/stack|at .+\.ts/i);
  return error;
}

describe('GET /api/movies/:id/dates', () => {
  it('lists each future Colombo date once, ascending', async () => {
    const { app, movie } = setup({
      showtimes: [
        { startsAt: colombo('2026-11-03', '19:00') },
        { startsAt: colombo('2026-11-01', '21:00') },
        { startsAt: colombo('2026-11-03', '10:00') },
        { startsAt: colombo('2026-11-02', '10:00') },
      ],
    });

    const { res, dates } = await getDates(app, movie.id);

    expect(dates).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    expect(res.body).toEqual({ dates: ['2026-11-01', '2026-11-02', '2026-11-03'] });
  });

  it('is an empty list for a movie without shows', async () => {
    const { app, movie } = setup();
    expect((await getDates(app, movie.id)).dates).toEqual([]);
  });

  it('crosses month and year ends in calendar order', async () => {
    vi.setSystemTime(colombo('2026-12-15', '10:00'));
    const { app, movie } = setup({
      showtimes: [
        { startsAt: colombo('2027-01-01', '10:00') },
        { startsAt: colombo('2026-12-31', '10:00') },
        { startsAt: colombo('2027-02-01', '10:00') },
      ],
    });
    expect((await getDates(app, movie.id)).dates).toEqual([
      '2026-12-31',
      '2027-01-01',
      '2027-02-01',
    ]);
  });
});

describe('GET /api/movies/:id/showtimes', () => {
  it('returns exactly the public fields of each show of that date, by start time', async () => {
    const screen2 = testScreen({ name: 'Screen 2' });
    const { app, movie, screen, db } = setup({
      screens: [screen2],
      showtimes: [
        { startsAt: colombo('2026-11-02', '21:15'), format: '3D', screenId: screen2.id },
        { startsAt: colombo('2026-11-02', '10:00') },
        { startsAt: colombo('2026-11-03', '10:00') },
      ],
    });
    const [late, morning] = db.showtimes;
    if (!late || !morning) throw new Error('fixture missing');

    const { res, items } = await getItems(app, movie.id, '2026-11-02');

    expect(items).toEqual([
      {
        id: morning.id,
        startsAt: '2026-11-02T04:30:00.000Z',
        time: '10:00',
        format: '2D',
        screen: { name: screen.name },
        bookingUrl: `${DEFAULT_BMS_BASE_URL}/20261102`,
      },
      {
        id: late.id,
        startsAt: '2026-11-02T15:45:00.000Z',
        time: '21:15',
        format: '3D',
        screen: { name: 'Screen 2' },
        bookingUrl: `${DEFAULT_BMS_BASE_URL}/20261102`,
      },
    ] satisfies PublicShowtime[]);
    expect(Object.keys(res.body as object)).toEqual(['date', 'items']);
  });

  it('breaks a tie on start time by id', async () => {
    const screen2 = testScreen({ name: 'Screen 2' });
    const startsAt = colombo('2026-11-02', '19:00');
    const { app, movie, screen, db } = setup({ screens: [screen2] });
    // The higher id goes in first, so the fake's stable sort would get it wrong without the id.
    const low = testShowtime({ movieId: movie.id, screenId: screen.id, startsAt });
    const high = testShowtime({ movieId: movie.id, screenId: screen2.id, startsAt });
    db.addShowtime(high);
    db.addShowtime(low);

    const { items } = await getItems(app, movie.id, '2026-11-02');

    expect(low.id < high.id).toBe(true);
    expect(ids(items)).toEqual([low.id, high.id]);
  });

  it('a 1 Nov show links to .../cinema-snlk-SKCM-MT/20261101 (PLAN Done-when)', async () => {
    const { app, movie } = setup({ showtimes: [{ startsAt: colombo('2026-11-01', '19:00') }] });

    const { items } = await getItems(app, movie.id, '2026-11-01');

    expect(items.map((item) => item.bookingUrl)).toEqual([
      'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/cinema-snlk-SKCM-MT/20261101',
    ]);
  });

  it('a 00:30 Colombo show on 2 Nov belongs to 2 Nov, not to its UTC date (PLAN required)', async () => {
    const { app, movie } = setup({
      showtimes: [{ startsAt: new Date('2026-11-01T19:00:00.000Z') }],
    });

    expect((await getDates(app, movie.id)).dates).toEqual(['2026-11-02']);
    expect((await getItems(app, movie.id, '2026-11-01')).items).toEqual([]);
    const { items } = await getItems(app, movie.id, '2026-11-02');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      startsAt: '2026-11-01T19:00:00.000Z',
      time: '00:30',
      bookingUrl: `${DEFAULT_BMS_BASE_URL}/20261102`,
    });
  });

  it('a 23:59 Colombo show stays on its date', async () => {
    const { app, movie } = setup({ showtimes: [{ startsAt: colombo('2026-11-02', '23:59') }] });

    expect((await getDates(app, movie.id)).dates).toEqual(['2026-11-02']);
    const { items } = await getItems(app, movie.id, '2026-11-02');
    expect(items[0]).toMatchObject({ time: '23:59' });
  });

  it.each([
    ['a date without shows', '2026-11-20'],
    ['a past date', '2020-01-01'],
    ['yesterday', '2026-10-31'],
    ['a date beyond the listing limit', '2030-01-01'],
  ])('answers 200 with no items for %s', async (_name, date) => {
    const { app, movie } = setup({ showtimes: [{ startsAt: colombo('2026-11-02', '19:00') }] });

    const { res, items } = await getItems(app, movie.id, date);

    expect(items).toEqual([]);
    expect(res.body).toEqual({ date, items: [] });
  });

  it.each([
    ['2d', '2D'],
    [' imax 3d ', 'IMAX 3D'],
    ['2D/3D', null],
  ])('format: stored %j is returned as %j', async (stored, expected) => {
    const { app, movie } = setup({
      showtimes: [{ startsAt: colombo('2026-11-02', '19:00'), format: stored }],
    });

    const { res, items } = await getItems(app, movie.id, '2026-11-02');

    expect(items[0]?.format).toBe(expected);
    if (expected === null) expect(res.text).not.toContain('2D/3D');
  });

  it('booking link: a valid override is used as it is, for its own show only', async () => {
    const { app, movie } = setup({
      showtimes: [
        { startsAt: colombo('2026-11-02', '10:00'), bookingUrlOverride: OVERRIDE },
        { startsAt: colombo('2026-11-02', '19:00') },
      ],
    });

    const { items } = await getItems(app, movie.id, '2026-11-02');

    expect(items.map((item) => item.bookingUrl)).toEqual([
      OVERRIDE,
      `${DEFAULT_BMS_BASE_URL}/20261102`,
    ]);
  });

  it.each([
    ['another site', 'https://evil.example/buytickets/x'],
    ['another path', 'https://lk.bookmyshow.com/other/x'],
    ['http', 'http://lk.bookmyshow.com/buytickets/x'],
  ])('booking link: an override to %s in the database is not sent', async (_name, stored) => {
    const { app, movie } = setup({
      showtimes: [{ startsAt: colombo('2026-11-02', '19:00'), bookingUrlOverride: stored }],
    });

    const { res, items } = await getItems(app, movie.id, '2026-11-02');

    expect(items[0]?.bookingUrl).toBe(`${DEFAULT_BMS_BASE_URL}/20261102`);
    expect(res.text).not.toContain(stored);
  });

  it('booking link: a custom bmsBaseUrl setting is used', async () => {
    const { app, movie } = setup({
      showtimes: [{ startsAt: colombo('2026-11-02', '19:00') }],
      settings: [testSetting('bmsBaseUrl', CUSTOM_BASE)],
    });

    const { items } = await getItems(app, movie.id, '2026-11-02');

    expect(items[0]?.bookingUrl).toBe(`${CUSTOM_BASE}/20261102`);
  });

  it('booking link: an invalid bmsBaseUrl setting falls back to the default', async () => {
    const { app, movie } = setup({
      showtimes: [{ startsAt: colombo('2026-11-02', '19:00') }],
      settings: [testSetting('bmsBaseUrl', 'https://evil.example/buytickets/x')],
    });

    const { res, items } = await getItems(app, movie.id, '2026-11-02');

    expect(items[0]?.bookingUrl).toBe(`${DEFAULT_BMS_BASE_URL}/20261102`);
    expect(res.text).not.toContain('evil.example');
  });

  it('never carries admin data, in the keys or the values', async () => {
    const SECRET_OVERRIDE = 'https://lk.bookmyshow.com/buytickets/never-shown';
    const { app, movie, screen } = setup({
      showtimes: [
        { startsAt: colombo('2026-11-02', '10:00'), bookingUrlOverride: OVERRIDE },
        { startsAt: colombo('2026-11-02', '19:00'), bookingUrlOverride: 'https://evil.example/' },
        {
          startsAt: colombo('2026-11-02', '21:00'),
          bookingUrlOverride: SECRET_OVERRIDE,
          deletedAt: DELETED_AT,
        },
      ],
    });

    const { res } = await getItems(app, movie.id, '2026-11-02');

    for (const key of [
      'bookingUrlOverride',
      'deletedAt',
      'isActive',
      'movieId',
      'screenId',
      'createdAt',
      'updatedAt',
      'adminId',
      'capacity',
    ]) {
      expect(res.text).not.toContain(key);
    }
    expect(res.text).not.toContain(SECRET_OVERRIDE);
    expect(res.text).not.toContain(movie.id);
    expect(res.text).not.toContain(screen.id);
  });
});

describe.each([
  ['/dates', (id: string) => datesPath(id)],
  ['/showtimes', (id: string) => showtimesPath(id, '2026-11-02')],
])('%s: which movies are public', (_endpoint, path) => {
  const SHOW = { startsAt: colombo('2026-11-02', '19:00') };

  it.each<[string, Partial<Movie>]>([
    ['inactive', { isActive: false }],
    ['soft-deleted', { deletedAt: DELETED_AT }],
    ['inactive and soft-deleted', { isActive: false, deletedAt: DELETED_AT }],
    ['ended and inactive', { status: 'ENDED', isActive: false }],
  ])('answers an %s movie exactly like an unknown one', async (_name, overrides) => {
    const { app, movie, db } = setup({ movie: overrides, showtimes: [SHOW] });

    const unknown = await request(app).get(path(randomUUID()));
    const hidden = await request(app).get(path(movie.id));

    expectError(unknown, 404, 'NOT_FOUND');
    expectError(hidden, 404, 'NOT_FOUND');
    expect(unknown.body).toEqual(MOVIE_404_BODY);
    expect(hidden.body).toEqual(MOVIE_404_BODY);
    expect(db.spies.showtime.findMany).not.toHaveBeenCalled();
  });

  it('uses the same 404 body as the slug detail endpoint', async () => {
    const { app } = setup();

    const detail = await request(app).get('/api/movies/no-such-movie');
    const res = await request(app).get(path(randomUUID()));

    expect(res.status).toBe(detail.status);
    expect(res.body).toEqual(detail.body);
  });

  it('does not cache a 404: the movie reappears on the next request', async () => {
    const { app, movie, db } = setup({ movie: { isActive: false }, showtimes: [SHOW] });

    expect((await request(app).get(path(movie.id))).status).toBe(404);
    expect((await request(app).get(path(movie.id))).status).toBe(404);
    expect(db.spies.movie.findUnique).toHaveBeenCalledTimes(2);

    await db.prisma.movie.update({ where: { id: movie.id }, data: { isActive: true } });

    expect((await request(app).get(path(movie.id))).status).toBe(200);
  });

  /** The length of `dates` or `items`, whichever this endpoint answers with. */
  const listed = (res: request.Response) => {
    const body = res.body as { dates?: unknown[]; items?: unknown[] };
    const list = body.dates ?? body.items;
    if (!list) throw new Error('no list in the response');
    return list.length;
  };

  it.each(['UPCOMING', 'NOW_SHOWING'] as const)(
    'a %s movie returns its shows (advance booking)',
    async (status) => {
      const { app, movie } = setup({ movie: { status }, showtimes: [SHOW] });

      const res = await request(app).get(path(movie.id));

      expect(res.status).toBe(200);
      expect(listed(res)).toBe(1);
    },
  );

  it('an ENDED movie answers 200 with nothing, without reading its shows', async () => {
    const { app, movie, db } = setup({ movie: { status: 'ENDED' }, showtimes: [SHOW] });

    const res = await request(app).get(path(movie.id));

    expect(res.status).toBe(200);
    expect(listed(res)).toBe(0);
    expect(db.spies.showtime.findMany).not.toHaveBeenCalled();
    expect(db.spies.setting.findMany).not.toHaveBeenCalled();
  });
});

describe('which shows are public', () => {
  it('leaves out past, soft-deleted, hidden-screen, deleted-screen and other-movie shows', async () => {
    const hiddenScreen = testScreen({ name: 'Hidden', isActive: false });
    const deletedScreen = testScreen({ name: 'Deleted', deletedAt: DELETED_AT });
    const other = testMovie({ slug: 'other', title: 'Other', status: 'NOW_SHOWING' });
    const startsAt = colombo('2026-11-02', '19:00');
    const { app, movie, db } = setup({
      movies: [other],
      screens: [hiddenScreen, deletedScreen],
      showtimes: [
        { startsAt: colombo('2026-11-02', '10:00') }, // the only public one
        { startsAt: colombo('2026-11-01', '15:00') }, // earlier today
        { startsAt: colombo('2026-10-31', '19:00') }, // yesterday
        { startsAt: NOW }, // starting right now
        { startsAt, deletedAt: DELETED_AT },
        { startsAt, screenId: hiddenScreen.id },
        { startsAt, screenId: deletedScreen.id },
        { startsAt: colombo('2026-11-05', '19:00'), screenId: hiddenScreen.id },
        { startsAt, movieId: other.id },
      ],
    });
    const visible = db.showtimes[0];
    if (!visible) throw new Error('fixture missing');

    expect((await getDates(app, movie.id)).dates).toEqual(['2026-11-02']);
    expect(ids((await getItems(app, movie.id, '2026-11-02')).items)).toEqual([visible.id]);
    expect((await getItems(app, movie.id, '2026-11-01')).items).toEqual([]);
    expect((await getItems(app, movie.id, '2026-10-31')).items).toEqual([]);
  });

  it('a show one millisecond in the future is public; one starting now is not', async () => {
    const { app, movie, db } = setup({
      showtimes: [{ startsAt: new Date(NOW.getTime() + 1) }, { startsAt: NOW }],
    });
    const future = db.showtimes[0];

    const { items } = await getItems(app, movie.id, '2026-11-01');

    expect(ids(items)).toEqual([future?.id]);
  });
});

// Everything here happens within the 5-minute TTL, around midnight in Colombo so that two dates
// are in play: the single query proves it is the entry being filtered, not a refill.
describe('a show disappears when it starts, with the cache still in place', () => {
  const FILLED_AT = colombo('2026-11-01', '23:57');
  const FIRST = colombo('2026-11-01', '23:58');
  const LAST_OF_DAY = colombo('2026-11-01', '23:59');
  const NEXT_DAY = colombo('2026-11-02', '00:01');

  beforeEach(() => {
    vi.setSystemTime(FILLED_AT);
  });

  const started = () =>
    setup({
      showtimes: [{ startsAt: FIRST }, { startsAt: LAST_OF_DAY }, { startsAt: NEXT_DAY }],
    });

  it('removes it from the list without a new database query', async () => {
    const { app, movie, db } = started();
    const [firstId, lastId] = db.showtimes.map((show) => show.id);
    expect(ids((await getItems(app, movie.id, '2026-11-01')).items)).toEqual([firstId, lastId]);

    vi.setSystemTime(FIRST.getTime() - 1);
    expect(ids((await getItems(app, movie.id, '2026-11-01')).items)).toEqual([firstId, lastId]);

    vi.setSystemTime(FIRST);
    expect(ids((await getItems(app, movie.id, '2026-11-01')).items)).toEqual([lastId]);

    expect(db.spies.showtime.findMany).toHaveBeenCalledTimes(1);
  });

  it('/dates drops a date when its last show starts, without a new database query', async () => {
    const { app, movie, db } = started();
    expect((await getDates(app, movie.id)).dates).toEqual(['2026-11-01', '2026-11-02']);

    // One of the date's shows has started, another has not.
    vi.setSystemTime(FIRST);
    expect((await getDates(app, movie.id)).dates).toEqual(['2026-11-01', '2026-11-02']);

    vi.setSystemTime(LAST_OF_DAY.getTime() - 1);
    expect((await getDates(app, movie.id)).dates).toEqual(['2026-11-01', '2026-11-02']);

    vi.setSystemTime(LAST_OF_DAY);
    expect((await getDates(app, movie.id)).dates).toEqual(['2026-11-02']);

    vi.setSystemTime(NEXT_DAY);
    expect((await getDates(app, movie.id)).dates).toEqual([]);

    expect(db.spies.showtime.findMany).toHaveBeenCalledTimes(1);
  });

  it('stays gone after the entry expires and is refilled', async () => {
    const { app, movie, db } = started();
    await getDates(app, movie.id);

    vi.setSystemTime(FILLED_AT.getTime() + PUBLIC_MOVIES_TTL_MS);

    expect((await getDates(app, movie.id)).dates).toEqual([]);
    expect(db.spies.showtime.findMany).toHaveBeenCalledTimes(2);
  });
});

describe('caching', () => {
  const SHOWS = [{ startsAt: colombo('2026-11-02', '19:00') }];

  it('the two endpoints and every date share one cache entry per movie', async () => {
    const { app, movie, db } = setup({ showtimes: SHOWS });

    await getDates(app, movie.id);
    await getDates(app, movie.id);
    await getItems(app, movie.id, '2026-11-02');
    await getItems(app, movie.id, '2026-11-03');

    expect(db.spies.movie.findUnique).toHaveBeenCalledTimes(1);
    expect(db.spies.showtime.findMany).toHaveBeenCalledTimes(1);
    expect(db.spies.setting.findMany).toHaveBeenCalledTimes(1);
  });

  it('caches per movie', async () => {
    const other = testMovie({ slug: 'other', title: 'Other', status: 'NOW_SHOWING' });
    const { app, movie, db } = setup({ movies: [other], showtimes: SHOWS });

    expect((await getDates(app, movie.id)).dates).toEqual(['2026-11-02']);
    expect((await getDates(app, other.id)).dates).toEqual([]);

    expect(db.spies.showtime.findMany).toHaveBeenCalledTimes(2);
  });

  it('refetches once the TTL has passed, not before', async () => {
    const { app, movie, db } = setup({ showtimes: SHOWS });
    await getDates(app, movie.id);

    vi.setSystemTime(NOW.getTime() + PUBLIC_MOVIES_TTL_MS - 1);
    await getDates(app, movie.id);
    expect(db.spies.showtime.findMany).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW.getTime() + PUBLIC_MOVIES_TTL_MS);
    await getDates(app, movie.id);
    expect(db.spies.showtime.findMany).toHaveBeenCalledTimes(2);
  });

  it('shares one fill between concurrent requests', async () => {
    const { app, movie, db } = setup({ showtimes: SHOWS });

    await Promise.all([
      getDates(app, movie.id),
      getDates(app, movie.id),
      getItems(app, movie.id, '2026-11-02'),
    ]);

    expect(db.spies.showtime.findMany).toHaveBeenCalledTimes(1);
  });

  it('an ENDED movie is cached too', async () => {
    const { app, movie, db } = setup({ movie: { status: 'ENDED' }, showtimes: SHOWS });

    await getDates(app, movie.id);
    await getDates(app, movie.id);

    expect(db.spies.movie.findUnique).toHaveBeenCalledTimes(1);
  });

  it('treats the id case-insensitively: one movie has one cache entry', async () => {
    const { app, movie, db } = setup({ showtimes: SHOWS });

    expect((await getDates(app, movie.id)).dates).toEqual(['2026-11-02']);
    expect((await getDates(app, movie.id.toUpperCase())).dates).toEqual(['2026-11-02']);

    expect(db.spies.movie.findUnique).toHaveBeenCalledTimes(1);
  });

  it('does not cache a database failure, and hides it from the client', async () => {
    const { app, movie, db } = setup({ showtimes: SHOWS });
    db.injectFault('showtime', 'findMany', {
      error: new Error('Connection terminated unexpectedly'),
    });

    const failed = await request(app).get(datesPath(movie.id));
    expectError(failed, 500, 'INTERNAL_ERROR');
    expect(failed.text).not.toContain('Connection terminated');

    expect((await getDates(app, movie.id)).dates).toEqual(['2026-11-02']);
  });

  it('does not cache a settings failure', async () => {
    const { app, movie, db } = setup({ showtimes: SHOWS });
    db.injectFault('setting', 'findMany', { error: new Error('settings down') });

    expectError(await request(app).get(datesPath(movie.id)), 500, 'INTERNAL_ERROR');

    expect((await getDates(app, movie.id)).dates).toEqual(['2026-11-02']);
  });

  it('serves the entry until invalidatePublicMovies, then reloads', async () => {
    const { app, cache, movie, db } = setup({ showtimes: SHOWS });
    await getDates(app, movie.id);

    db.addShowtime({
      movieId: movie.id,
      screenId: db.screens[0]?.id ?? '',
      startsAt: colombo('2026-11-05', '19:00'),
    });
    expect((await getDates(app, movie.id)).dates).toEqual(['2026-11-02']);

    invalidatePublicMovies(cache);

    expect((await getDates(app, movie.id)).dates).toEqual(['2026-11-02', '2026-11-05']);
  });
});

describe('HTTP caching', () => {
  it('sends no-store on 200, 400 and 404, cached or not', async () => {
    const { app, movie } = setup({ showtimes: [{ startsAt: colombo('2026-11-02', '19:00') }] });

    for (const path of [
      datesPath(movie.id),
      datesPath(movie.id), // from the cache
      showtimesPath(movie.id, '2026-11-02'),
      datesPath(randomUUID()),
      showtimesPath(randomUUID(), '2026-11-02'),
      datesPath('not-a-uuid'),
      `/api/movies/${movie.id}/showtimes`,
    ]) {
      const res = await request(app).get(path);
      expect(res.headers['cache-control'], path).toBe('no-store');
    }
  });

  it('leaves the other public movie endpoints as they are', async () => {
    const { app } = setup();
    for (const path of ['/api/movies', '/api/movies/main-feature']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control'], path).toBeUndefined();
    }
  });
});

describe('validation', () => {
  it.each([
    ['a non-UUID', 'not-a-uuid'],
    ['a slug', 'main-feature'],
    ['a too-short UUID', '0190b0c0-0000-7000-8000-00000000000'],
    ['an encoded slash', '0190b0c0-0000-7000%2F8000-000000000000'],
  ])('rejects %s as the id with 400, on both endpoints', async (_name, id) => {
    const { app, db } = setup();

    for (const path of [datesPath(id), showtimesPath(id, '2026-11-02')]) {
      const error = expectError(await request(app).get(path), 400, 'VALIDATION_ERROR');
      expect(error.details).toEqual([
        { path: ['params', 'id'], message: expect.any(String) as unknown },
      ]);
    }
    expect(db.spies.movie.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing date', ''],
    ['an empty date', '?date='],
    ['an impossible date', '?date=2026-02-30'],
    ['a badly formatted date', '?date=02-11-2026'],
    ['a date with a time', '?date=2026-11-02T00:00:00Z'],
    ['a repeated date', '?date=2026-11-02&date=2026-11-03'],
    ['an unknown key', '?date=2026-11-02&page=2'],
    ['only an unknown key', '?movieId=1'],
  ])('/showtimes rejects %s with 400', async (_name, query) => {
    const { app, movie, db } = setup();

    const res = await request(app).get(`/api/movies/${movie.id}/showtimes${query}`);

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(db.spies.movie.findUnique).not.toHaveBeenCalled();
  });

  it('/showtimes names the bad field', async () => {
    const { app, movie } = setup();

    const res = await request(app).get(`/api/movies/${movie.id}/showtimes?date=2026-02-30`);

    const error = expectError(res, 400, 'VALIDATION_ERROR');
    expect(error.details).toEqual([
      { path: ['query', 'date'], message: expect.any(String) as unknown },
    ]);
  });

  it.each([
    ['a date', '?date=2026-11-02'],
    ['an unknown key', '?page=1'],
  ])('/dates rejects %s in the query with 400', async (_name, query) => {
    const { app, movie, db } = setup();

    const res = await request(app).get(`/api/movies/${movie.id}/dates${query}`);

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(db.spies.movie.findUnique).not.toHaveBeenCalled();
  });

  it('only GET is routed', async () => {
    const { app, movie } = setup();
    const res = await request(app).post(datesPath(movie.id)).send({});
    expect(res.status).toBe(404);
  });
});

describe('CORS', () => {
  it('allows the public origin without credentials, also on errors', async () => {
    const { app, movie } = setup();

    for (const path of [
      datesPath(movie.id),
      showtimesPath(movie.id, '2026-11-02'),
      datesPath(randomUUID()),
      datesPath('not-a-uuid'),
    ]) {
      const res = await request(app).get(path).set('Origin', PUBLIC_ORIGIN);
      expect(res.headers['access-control-allow-origin'], path).toBe(PUBLIC_ORIGIN);
      expect(res.headers['access-control-allow-credentials'], path).toBeUndefined();
    }
  });

  it('gives the admin origin its usual credentialed CORS', async () => {
    const { app, movie } = setup();
    const res = await request(app).get(datesPath(movie.id)).set('Origin', ADMIN_ORIGIN);

    expect(res.headers['access-control-allow-origin']).toBe(ADMIN_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('needs no session or CSRF token, and sets no cookie', async () => {
    const { app, movie } = setup();
    const res = await request(app).get(datesPath(movie.id));

    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});
