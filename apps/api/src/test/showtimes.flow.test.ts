/**
 * Phase 5 T16 flow tests: the PLAN.md "Done when" and "Carried forward" promises for showtimes and
 * BookMyShow links, proven end to end through createApp + supertest, against the in-memory fake.
 * The describe names quote PLAN.md, so each item can be found by searching for its wording.
 *
 * Each test is a journey as an admin and a visitor see it: a signed-in admin (session, CSRF token,
 * Origin) writes through the admin API, a visitor reads the public API. Rows are seeded directly
 * only where the API cannot make them (a past show, a bad URL "edited in the database", a trashed
 * movie with upcoming shows), and each such test says why. Validation details live in the route
 * tests; the same behaviours on real Postgres are T17.
 *
 * Only Date is faked. The clock stands still at NOW unless a test moves it, always by less than
 * the public cache's 5 minutes unless it means to, and less than the access token's 15 minutes.
 */
import {
  adminMovieResponseSchema,
  adminScreenResponseSchema,
  adminSettingsResponseSchema,
  adminShowtimeListResponseSchema,
  adminShowtimeResponseSchema,
  apiErrorSchema,
  publicShowtimeDatesResponseSchema,
  publicShowtimeListResponseSchema,
  showtimeBulkCreateResponseSchema,
  showtimeBulkDeleteResponseSchema,
  showtimeConflictErrorSchema,
  type AdminMovie,
  type AdminScreen,
  type AdminShowtime,
} from '@sk-cinema/shared';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditAction } from '../generated/prisma/client.js';
import type { MemoryCache } from '../lib/cache.js';
import { FORBIDDEN_MESSAGE } from '../middleware/auth.js';
import { CSRF_HEADER } from '../middleware/csrf.js';
import {
  MOVIE_DELETE_FIRST_MESSAGE,
  MOVIE_DELETE_HAS_SHOWTIMES_MESSAGE,
  MOVIE_HARD_DELETE_HAS_SHOWTIMES_MESSAGE,
} from '../services/movie.admin.service.js';
import {
  ADMIN_BASE,
  ADMIN_ORIGIN,
  TEST_USER_AGENT,
  authClient,
  buildTestApp,
  inMemoryAuthDb,
  sessionFrom,
  testAdmin,
  testMovie,
  testPasswordHash,
  type Csrf,
  type InMemoryAuthDb,
  type Session,
} from './helpers.js';

const SUPER_ADMIN_EMAIL = 'super@skcinema.lk';
const EDITOR_EMAIL = 'editor@skcinema.lk';
const PASSWORD = 'correct horse battery staple';

/** Written out, not DEFAULT_BMS_BASE_URL: this is the link PLAN.md promises. */
const BMS_BASE = 'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/cinema-snlk-SKCM-MT';
const NEW_BMS_BASE = 'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/cinema-snlk-SKCM-NEW';
const OVERRIDE = 'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/special-premiere/20261102';

/** The clock: 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');
const YESTERDAY = '2026-10-31';
const TODAY = '2026-11-01';
const NOV_2 = '2026-11-02';
const NOV_3 = '2026-11-03';
const NOV_4 = '2026-11-04';
const TRASHED_AT = new Date('2026-10-01T00:00:00.000Z');

const colombo = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);

const MOVIE_404_BODY = { error: { code: 'NOT_FOUND', message: 'Movie not found' } };
const FORBIDDEN_BODY = { error: { code: 'FORBIDDEN', message: FORBIDDEN_MESSAGE } };
const CSRF_BODY = { error: { code: 'CSRF_INVALID', message: 'CSRF validation failed' } };

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await testPasswordHash(PASSWORD);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A signed-in admin's browser: its CSRF cookie + token and its session. */
interface Browser {
  csrf: Csrf;
  session: Session;
}

interface Flow {
  app: Express;
  db: InMemoryAuthDb;
  cache: MemoryCache;
  /** The SUPER_ADMIN every admin request is sent as, unless it says otherwise. */
  browser: Browser;
  adminId: string;
}

/** The API's starting point of most tests: a NOW_SHOWING movie of 120 minutes and two screens. */
interface Scene extends Flow {
  movie: AdminMovie;
  screen: AdminScreen;
  otherScreen: AdminScreen;
}

type Method = 'get' | 'post' | 'patch' | 'delete';

interface AdminOptions {
  /** Default: the SUPER_ADMIN. */
  as?: Browser;
  /** false: no X-CSRF-Token header. */
  withCsrf?: boolean;
}

async function signIn(app: Express, email: string): Promise<Browser> {
  const client = await authClient(app);
  const login = await client.post('/auth/login', { body: { email, password: PASSWORD } });
  expect(login.status).toBe(200);
  return { csrf: client.csrf, session: sessionFrom(login) };
}

/** An empty database with a SUPER_ADMIN (signed in) and an EDITOR (see signIn). */
async function start(): Promise<Flow> {
  const superAdmin = testAdmin({
    email: SUPER_ADMIN_EMAIL,
    name: 'Super Admin',
    passwordHash,
    role: 'SUPER_ADMIN',
  });
  const editor = testAdmin({ email: EDITOR_EMAIL, passwordHash, role: 'EDITOR' });
  const db = inMemoryAuthDb({ admins: [superAdmin, editor] });
  const { app, cache } = buildTestApp({ prisma: db.prisma });
  return { app, db, cache, adminId: superAdmin.id, browser: await signIn(app, SUPER_ADMIN_EMAIL) };
}

/** A browser-like request to /api/admin: session, CSRF token, Origin and user agent. */
function admin(
  f: Flow,
  method: Method,
  path: string,
  body?: object,
  { as = f.browser, withCsrf = true }: AdminOptions = {},
) {
  let req = request(f.app)
    [method](`${ADMIN_BASE}${path}`)
    .set('User-Agent', TEST_USER_AGENT)
    .set('Origin', ADMIN_ORIGIN)
    .set('Cookie', [as.csrf.cookie, as.session.access].join('; '));
  if (withCsrf) req = req.set(CSRF_HEADER, as.csrf.token);
  return body === undefined ? req : req.send(body);
}

async function createMovie(f: Flow, body: object = {}): Promise<AdminMovie> {
  const res = await admin(f, 'post', '/movies', {
    title: 'Main Feature',
    durationMinutes: 120,
    status: 'NOW_SHOWING',
    ...body,
  });
  expect(res.status).toBe(201);
  return adminMovieResponseSchema.parse(res.body).movie;
}

async function createScreen(f: Flow, name: string): Promise<AdminScreen> {
  const res = await admin(f, 'post', '/screens', { name });
  expect(res.status).toBe(201);
  return adminScreenResponseSchema.parse(res.body).screen;
}

async function scene(): Promise<Scene> {
  const f = await start();
  return {
    ...f,
    movie: await createMovie(f),
    screen: await createScreen(f, 'Screen 1'),
    otherScreen: await createScreen(f, 'Screen 2'),
  };
}

const showBody = (s: Scene, date: string, time: string, overrides: object = {}) => ({
  movieId: s.movie.id,
  screenId: s.screen.id,
  date,
  time,
  ...overrides,
});

const bulkBody = (s: Scene, date: string, times: string[], overrides: object = {}) => ({
  movieId: s.movie.id,
  screenId: s.screen.id,
  dateFrom: date,
  dateTo: date,
  times,
  ...overrides,
});

async function createShow(
  s: Scene,
  date: string,
  time: string,
  overrides: object = {},
): Promise<AdminShowtime> {
  const res = await admin(s, 'post', '/showtimes', showBody(s, date, time, overrides));
  expect(res.status).toBe(201);
  return adminShowtimeResponseSchema.parse(res.body).showtime;
}

const datesPath = (movieId: string) => `/api/movies/${movieId}/dates`;
const showsPath = (movieId: string, date: string) =>
  `/api/movies/${movieId}/showtimes?date=${date}`;

/** What a visitor sees: GET /dates, 200 and accepted by the strict shared schema. */
async function publicDates(f: Flow, movieId: string): Promise<string[]> {
  const res = await request(f.app).get(datesPath(movieId));
  expect(res.status).toBe(200);
  return publicShowtimeDatesResponseSchema.parse(res.body).dates;
}

/** What a visitor sees: GET /showtimes, 200 and accepted by the strict shared schema. */
async function publicShows(f: Flow, movieId: string, date: string) {
  const res = await request(f.app).get(showsPath(movieId, date));
  expect(res.status).toBe(200);
  return publicShowtimeListResponseSchema.parse(res.body).items;
}

/** Forgets the reads so far, so that expectNoDatabaseRead can prove the cache answered. */
function forgetReads(f: Flow) {
  f.db.spies.movie.findUnique.mockClear();
  f.db.spies.showtime.findMany.mockClear();
  f.db.spies.setting.findUnique.mockClear();
  f.db.spies.setting.findMany.mockClear();
}

function expectNoDatabaseRead(f: Flow) {
  expect(f.db.spies.movie.findUnique).not.toHaveBeenCalled();
  expect(f.db.spies.showtime.findMany).not.toHaveBeenCalled();
  expect(f.db.spies.setting.findUnique).not.toHaveBeenCalled();
  expect(f.db.spies.setting.findMany).not.toHaveBeenCalled();
}

/** Both public endpoints answer exactly like an unknown movie, with no show or link in them. */
async function expectPublicHidden(f: Flow, movieId: string, showIds: readonly string[] = []) {
  for (const path of [datesPath(movieId), showsPath(movieId, NOV_2)]) {
    const res = await request(f.app).get(path);
    expect(res.status, path).toBe(404);
    expect(res.body, path).toEqual(MOVIE_404_BODY);
    expect(res.text, path).not.toContain('bookingUrl');
    for (const id of showIds) expect(res.text, path).not.toContain(id);
  }
}

/** A copy of what a refused write must leave as it was. */
function snapshot(f: Flow) {
  return {
    showtimes: structuredClone(f.db.showtimes),
    settings: structuredClone(f.db.settings),
    movies: structuredClone(f.db.movies),
    screens: structuredClone(f.db.screens),
    auditCount: f.db.auditLogs.length,
  };
}

function expectNothingChanged(f: Flow, before: ReturnType<typeof snapshot>) {
  expect(f.db.showtimes).toEqual(before.showtimes);
  expect(f.db.settings).toEqual(before.settings);
  expect(f.db.movies).toEqual(before.movies);
  expect(f.db.screens).toEqual(before.screens);
  expect(f.db.auditLogs).toHaveLength(before.auditCount);
}

/** The 409 of an overlap, and the show it reports (`null`: a slot of the same request). */
function expectOverlap(res: request.Response, conflictingShowId: string | null) {
  expect(res.status).toBe(409);
  const { error } = showtimeConflictErrorSchema.parse(res.body);
  expect(error.details.map((detail) => detail.conflict.showtimeId)).toContain(conflictingShowId);
  return error;
}

// ---------------------------------------------------------------------------
// Done when
// ---------------------------------------------------------------------------

describe('Done when: Link for a 1 Nov show is .../cinema-snlk-SKCM-MT/20261101', () => {
  it('a show on 2026-11-01 links to exactly that URL, publicly and in the admin response', async () => {
    const s = await scene();

    const created = await createShow(s, TODAY, '19:00');

    const link =
      'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/cinema-snlk-SKCM-MT/20261101';
    expect(created.bookingUrl).toBe(link);
    const [listed] = await publicShows(s, s.movie.id, TODAY);
    expect(listed?.id).toBe(created.id);
    expect(listed?.bookingUrl).toBe(link);
  });

  describe('a 00:30 Colombo show on 2 Nov (stored 2026-11-01T19:00:00.000Z) belongs to 2 Nov', () => {
    /** The whole promise: stored in UTC, dated in Colombo, on the link and in the listing. */
    async function expectBelongsToNov2(s: Scene, show: AdminShowtime | undefined) {
      expect(show).toMatchObject({
        startsAt: '2026-11-01T19:00:00.000Z',
        colomboDate: NOV_2,
        time: '00:30',
        bookingUrl: `${BMS_BASE}/20261102`,
      });
      const [stored] = s.db.showtimes;
      expect(stored?.startsAt).toEqual(new Date('2026-11-01T19:00:00.000Z'));

      expect(await publicDates(s, s.movie.id)).toEqual([NOV_2]);
      expect(await publicShows(s, s.movie.id, TODAY)).toEqual([]);
      const listed = await publicShows(s, s.movie.id, NOV_2);
      expect(listed.map((item) => [item.id, item.time, item.bookingUrl])).toEqual([
        [show?.id, '00:30', `${BMS_BASE}/20261102`],
      ]);
    }

    it('through POST /showtimes', async () => {
      const s = await scene();

      await expectBelongsToNov2(s, await createShow(s, NOV_2, '00:30'));
    });

    it('through POST /showtimes/bulk', async () => {
      const s = await scene();

      const res = await admin(s, 'post', '/showtimes/bulk', bulkBody(s, NOV_2, ['00:30']));

      expect(res.status).toBe(201);
      await expectBelongsToNov2(s, showtimeBulkCreateResponseSchema.parse(res.body).items[0]);
    });
  });

  it.each([
    ['the last minute of 1 Nov', TODAY, '23:59', '2026-11-01T18:29:00.000Z', '20261101'],
    ['the first minute of 2 Nov', NOV_2, '00:00', '2026-11-01T18:30:00.000Z', '20261102'],
  ])('%s is dated in Colombo, not UTC', async (_name, date, time, startsAt, linkDate) => {
    const s = await scene();

    const created = await createShow(s, date, time);

    expect(created.startsAt).toBe(startsAt);
    expect(await publicDates(s, s.movie.id)).toEqual([date]);
    const [listed] = await publicShows(s, s.movie.id, date);
    expect(listed?.bookingUrl).toBe(`${BMS_BASE}/${linkDate}`);
  });
});

describe('Done when: Past showtimes never appear publicly', () => {
  /** The next minute: 15:31 today, a show that starts while the tests below watch it. */
  const ALMOST_TIME = '15:31';
  const ALMOST_STARTS_AT = colombo(TODAY, ALMOST_TIME).getTime();

  it('a past row is in neither endpoint, on an earlier date or earlier today', async () => {
    const s = await scene();
    // Seeded: the admin API refuses a start in the past.
    const yesterday = s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: colombo(YESTERDAY, '19:00'),
    });
    const earlierToday = s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: colombo(TODAY, '09:00'),
    });
    const later = await createShow(s, TODAY, '19:00');

    expect(await publicDates(s, s.movie.id)).toEqual([TODAY]);
    expect(await publicShows(s, s.movie.id, YESTERDAY)).toEqual([]);
    const today = await publicShows(s, s.movie.id, TODAY);
    expect(today.map((item) => item.id)).toEqual([later.id]);
    expect(today.map((item) => item.id)).not.toContain(earlierToday.id);
    expect(s.db.showtimes.map((row) => row.id)).toContain(yesterday.id);
  });

  it('a show starting in a minute is listed, and leaves the moment it starts: both endpoints, from the cached list', async () => {
    const s = await scene();
    const almost = await createShow(s, TODAY, ALMOST_TIME);
    const later = await createShow(s, TODAY, '19:00');
    const ids = async () => (await publicShows(s, s.movie.id, TODAY)).map((item) => item.id);

    expect(await ids()).toEqual([almost.id, later.id]);
    expect(await publicDates(s, s.movie.id)).toEqual([TODAY]);
    forgetReads(s);

    vi.setSystemTime(ALMOST_STARTS_AT - 1);
    expect(await ids()).toEqual([almost.id, later.id]);

    vi.setSystemTime(ALMOST_STARTS_AT);
    expect(await ids()).toEqual([later.id]);
    expect(await publicDates(s, s.movie.id)).toEqual([TODAY]);

    // All of that came from the entry cached before the show started.
    expectNoDatabaseRead(s);
  });

  it('/dates drops a date the moment its last show starts, from the cached list', async () => {
    const s = await scene();
    await createShow(s, TODAY, ALMOST_TIME);
    await createShow(s, NOV_2, '19:00');
    expect(await publicDates(s, s.movie.id)).toEqual([TODAY, NOV_2]);
    forgetReads(s);

    vi.setSystemTime(ALMOST_STARTS_AT);

    expect(await publicDates(s, s.movie.id)).toEqual([NOV_2]);
    expectNoDatabaseRead(s);
  });

  it('a started show stays away after the cache refills', async () => {
    const s = await scene();
    const almost = await createShow(s, TODAY, ALMOST_TIME);
    await publicDates(s, s.movie.id);

    vi.setSystemTime(ALMOST_STARTS_AT);
    s.cache.clear();

    expect(await publicDates(s, s.movie.id)).toEqual([]);
    expect(s.db.spies.showtime.findMany).toHaveBeenCalled();
    expect(s.db.showtimes.map((row) => row.id)).toEqual([almost.id]);
  });

  it('the admin list still shows a started show with includePast=true, and only then', async () => {
    const s = await scene();
    const almost = await createShow(s, TODAY, ALMOST_TIME);
    vi.setSystemTime(ALMOST_STARTS_AT);
    const list = async (query: string) => {
      const res = await admin(s, 'get', `/showtimes?movieId=${s.movie.id}${query}`);
      expect(res.status).toBe(200);
      return adminShowtimeListResponseSchema.parse(res.body).items.map((item) => item.id);
    };

    expect(await list('&includePast=true')).toEqual([almost.id]);
    expect(await list('')).toEqual([]);
    expect(await publicShows(s, s.movie.id, TODAY)).toEqual([]);
  });
});

describe('Done when: Overlapping showtimes on the same screen are rejected', () => {
  // The movie runs 120 minutes and the default gap is 15, so a show on Screen 1 at 19:00 holds the
  // screen until 21:15.
  const SHOW_AT = '19:00';

  async function sceneWithShow() {
    const s = await scene();
    return { s, saved: await createShow(s, NOV_2, SHOW_AT) };
  }

  describe('every way in is a 409 and saves nothing', () => {
    it('POST /showtimes, against a saved show', async () => {
      const { s, saved } = await sceneWithShow();
      const before = snapshot(s);

      const res = await admin(s, 'post', '/showtimes', showBody(s, NOV_2, '20:00'));

      expectOverlap(res, saved.id);
      expectNothingChanged(s, before);
    });

    it('POST /showtimes/bulk, against a saved show: the free slot is not saved either', async () => {
      const { s, saved } = await sceneWithShow();
      const before = snapshot(s);

      const res = await admin(s, 'post', '/showtimes/bulk', bulkBody(s, NOV_2, ['10:00', '20:00']));

      expectOverlap(res, saved.id);
      expectNothingChanged(s, before);
    });

    it('POST /showtimes/bulk, inside the batch', async () => {
      const { s } = await sceneWithShow();
      const before = snapshot(s);

      const res = await admin(s, 'post', '/showtimes/bulk', bulkBody(s, NOV_3, ['10:00', '11:00']));

      // Not saved yet, so the show it clashes with has no ID.
      expectOverlap(res, null);
      expectNothingChanged(s, before);
    });

    it('PATCH /showtimes/:id, moved to a time that overlaps', async () => {
      const { s, saved } = await sceneWithShow();
      const other = await createShow(s, NOV_3, SHOW_AT);
      const before = snapshot(s);

      const res = await admin(s, 'patch', `/showtimes/${other.id}`, {
        date: NOV_2,
        time: '20:00',
      });

      expectOverlap(res, saved.id);
      expectNothingChanged(s, before);
    });

    it('PATCH /showtimes/:id, moved to a screen where it overlaps', async () => {
      const { s, saved } = await sceneWithShow();
      const other = await createShow(s, NOV_2, SHOW_AT, { screenId: s.otherScreen.id });
      const before = snapshot(s);

      const res = await admin(s, 'patch', `/showtimes/${other.id}`, { screenId: s.screen.id });

      expectOverlap(res, saved.id);
      expectNothingChanged(s, before);
    });
  });

  it('a show on another screen at the same time is fine', async () => {
    const { s, saved } = await sceneWithShow();

    const other = await createShow(s, NOV_2, SHOW_AT, { screenId: s.otherScreen.id });

    const listed = await publicShows(s, s.movie.id, NOV_2);
    expect(listed.map((item) => [item.id, item.time, item.screen.name])).toEqual([
      [saved.id, SHOW_AT, 'Screen 1'],
      [other.id, SHOW_AT, 'Screen 2'],
    ]);
  });

  describe('shows that touch exactly at start + duration + gap are allowed', () => {
    it.each([
      ['starting exactly when the saved show has freed the screen', '21:15'],
      ['ending, with its gap, exactly when the saved show starts', '16:45'],
    ])('POST /showtimes: 201 for a show %s', async (_name, time) => {
      const { s } = await sceneWithShow();

      expect((await admin(s, 'post', '/showtimes', showBody(s, NOV_2, time))).status).toBe(201);
    });

    it.each([
      ['starting a minute before the saved show has freed the screen', '21:14'],
      ['ending, with its gap, a minute after the saved show starts', '16:46'],
    ])('POST /showtimes: 409 for a show %s', async (_name, time) => {
      const { s, saved } = await sceneWithShow();

      expectOverlap(await admin(s, 'post', '/showtimes', showBody(s, NOV_2, time)), saved.id);
    });

    it('POST /showtimes/bulk: 201 for two slots that touch inside the batch', async () => {
      const s = await scene();

      const res = await admin(s, 'post', '/showtimes/bulk', bulkBody(s, NOV_3, ['19:00', '21:15']));

      expect(res.status).toBe(201);
      expect(showtimeBulkCreateResponseSchema.parse(res.body).created).toBe(2);
    });
  });

  describe('the gap comes from the showGapMinutes setting', () => {
    async function setGap(s: Scene, showGapMinutes: number) {
      const res = await admin(s, 'patch', '/settings', { showGapMinutes });
      expect(res.status).toBe(200);
      expect(adminSettingsResponseSchema.parse(res.body).settings.showGapMinutes).toBe(
        showGapMinutes,
      );
    }

    it('raised to 30: the slot that touched at a gap of 15 now clashes, and 30 touches', async () => {
      const { s, saved } = await sceneWithShow();

      await setGap(s, 30);

      const refused = await admin(s, 'post', '/showtimes', showBody(s, NOV_2, '21:15'));
      const { details } = expectOverlap(refused, saved.id);
      expect(details[0]?.message).toContain('counting the 30-minute gap');
      expect((await admin(s, 'post', '/showtimes', showBody(s, NOV_2, '21:30'))).status).toBe(201);
    });

    it('lowered to 0: the slot refused at a gap of 15 is now free', async () => {
      const { s, saved } = await sceneWithShow();
      expectOverlap(await admin(s, 'post', '/showtimes', showBody(s, NOV_2, '21:00')), saved.id);

      await setGap(s, 0);

      expect((await admin(s, 'post', '/showtimes', showBody(s, NOV_2, '21:00'))).status).toBe(201);
    });

    it('raised to 30: the next bulk create and move use it too', async () => {
      const { s, saved } = await sceneWithShow();
      const other = await createShow(s, NOV_3, SHOW_AT);

      await setGap(s, 30);

      expectOverlap(
        await admin(s, 'post', '/showtimes/bulk', bulkBody(s, NOV_2, ['21:15'])),
        saved.id,
      );
      expectOverlap(
        await admin(s, 'patch', `/showtimes/${other.id}`, { date: NOV_2, time: '21:15' }),
        saved.id,
      );
    });
  });
});

describe('Done when: Non-BMS URLs are rejected for base URL and overrides', () => {
  const BAD_URLS: [string, string][] = [
    ['http', 'http://lk.bookmyshow.com/buytickets/sk-cinema-matara/x'],
    ['another host', 'https://evil.example/buytickets/sk-cinema-matara/x'],
    ['a look-alike host', 'https://lk.bookmyshow.com.evil.example/buytickets/x'],
    ['userinfo before another host', 'https://lk.bookmyshow.com@evil.example/buytickets/x'],
    ['userinfo before the real host', 'https://user:pass@lk.bookmyshow.com/buytickets/x'],
    ['a port', 'https://lk.bookmyshow.com:8443/buytickets/x'],
    ['an encoded slash (%2f)', 'https://lk.bookmyshow.com/buytickets/x%2f..%2fy'],
    ['a backslash', 'https://lk.bookmyshow.com/buytickets/x\\y'],
    ['a ".." segment', 'https://lk.bookmyshow.com/buytickets/../../evil'],
    ['a query string', 'https://lk.bookmyshow.com/buytickets/x?next=evil'],
    ['a fragment', 'https://lk.bookmyshow.com/buytickets/x#evil'],
  ];

  /** A URL as it would appear inside a JSON response (a backslash is escaped there). */
  const inJson = (url: string) => JSON.stringify(url).slice(1, -1);

  interface Surface {
    surface: string;
    send: (s: Scene, show: AdminShowtime, url: string) => PromiseLike<request.Response>;
  }

  const SURFACES: Surface[] = [
    {
      surface: 'POST /showtimes bookingUrlOverride',
      send: (s, _show, url) =>
        admin(s, 'post', '/showtimes', showBody(s, NOV_3, '19:00', { bookingUrlOverride: url })),
    },
    {
      surface: 'PATCH /showtimes/:id bookingUrlOverride',
      send: (s, show, url) =>
        admin(s, 'patch', `/showtimes/${show.id}`, { bookingUrlOverride: url }),
    },
    {
      surface: 'PATCH /settings bmsBaseUrl',
      send: (s, _show, url) => admin(s, 'patch', '/settings', { bmsBaseUrl: url }),
    },
  ];

  describe.each(SURFACES)('$surface', ({ send }) => {
    it.each(BAD_URLS)('400 for %s: nothing saved, no audit', async (_name, url) => {
      const s = await scene();
      const show = await createShow(s, NOV_2, '19:00');
      const before = snapshot(s);

      const res = await send(s, show, url);

      expect(res.status).toBe(400);
      expect(apiErrorSchema.parse(res.body).error.code).toBe('VALIDATION_ERROR');
      expect(res.text).not.toContain(inJson(url));
      expectNothingChanged(s, before);
      const [listed] = await publicShows(s, s.movie.id, NOV_2);
      expect(listed?.bookingUrl).toBe(`${BMS_BASE}/20261102`);
    });
  });

  it('a valid override wins over the generated link on the public API', async () => {
    const s = await scene();

    const created = await createShow(s, NOV_2, '19:00', { bookingUrlOverride: OVERRIDE });

    expect(created).toMatchObject({ bookingUrlOverride: OVERRIDE, bookingUrl: OVERRIDE });
    const [listed] = await publicShows(s, s.movie.id, NOV_2);
    expect(listed?.bookingUrl).toBe(OVERRIDE);
  });

  it('removing the override brings the generated link back', async () => {
    const s = await scene();
    const created = await createShow(s, NOV_2, '19:00', { bookingUrlOverride: OVERRIDE });

    const res = await admin(s, 'patch', `/showtimes/${created.id}`, { bookingUrlOverride: null });

    expect(res.status).toBe(200);
    const [listed] = await publicShows(s, s.movie.id, NOV_2);
    expect(listed?.bookingUrl).toBe(`${BMS_BASE}/20261102`);
  });

  it('a valid base URL is saved and used for the next generated link', async () => {
    const s = await scene();
    await createShow(s, NOV_2, '19:00');

    const res = await admin(s, 'patch', '/settings', { bmsBaseUrl: NEW_BMS_BASE });

    expect(res.status).toBe(200);
    expect(adminSettingsResponseSchema.parse(res.body).settings.bmsBaseUrl).toBe(NEW_BMS_BASE);
    const [listed] = await publicShows(s, s.movie.id, NOV_2);
    expect(listed?.bookingUrl).toBe(`${NEW_BMS_BASE}/20261102`);
  });

  describe('a bad override placed directly in the database', () => {
    it.each(BAD_URLS)(
      '%s: the generated link instead, and the URL is never sent',
      async (_n, url) => {
        const s = await scene();
        // Seeded: the admin API refuses it. This is the row someone edited by hand.
        const row = s.db.addShowtime({
          movieId: s.movie.id,
          screenId: s.screen.id,
          startsAt: colombo(NOV_2, '19:00'),
          bookingUrlOverride: url,
        });

        const res = await request(s.app).get(showsPath(s.movie.id, NOV_2));

        expect(res.status).toBe(200);
        expect(publicShowtimeListResponseSchema.parse(res.body).items).toMatchObject([
          { id: row.id, bookingUrl: `${BMS_BASE}/20261102` },
        ]);
        expect(res.text).not.toContain(inJson(url));
      },
    );

    it('the admin response links to the generated URL too, and shows the row for fixing', async () => {
      const s = await scene();
      const bad = 'https://evil.example/buytickets/x';
      const row = s.db.addShowtime({
        movieId: s.movie.id,
        screenId: s.screen.id,
        startsAt: colombo(NOV_2, '19:00'),
        bookingUrlOverride: bad,
      });

      const res = await admin(s, 'get', `/showtimes/${row.id}`);

      expect(res.status).toBe(200);
      expect(adminShowtimeResponseSchema.parse(res.body).showtime).toMatchObject({
        bookingUrlOverride: bad,
        bookingUrl: `${BMS_BASE}/20261102`,
      });
    });
  });

  it('a bad base URL placed directly in the database falls back to the default link', async () => {
    const s = await scene();
    await createShow(s, NOV_2, '19:00');
    // Seeded: the admin API refuses it.
    s.db.addSetting({ key: 'bmsBaseUrl', value: 'https://evil.example/buytickets/x' });

    const res = await request(s.app).get(showsPath(s.movie.id, NOV_2));

    expect(res.status).toBe(200);
    expect(publicShowtimeListResponseSchema.parse(res.body).items[0]?.bookingUrl).toBe(
      `${BMS_BASE}/20261102`,
    );
    expect(res.text).not.toContain('evil.example');
  });
});

// ---------------------------------------------------------------------------
// Carried forward from Phase 4
// ---------------------------------------------------------------------------

describe('Carried forward: Showtimes of soft-deleted or inactive movies never appear in public endpoints', () => {
  describe('through the admin API', () => {
    it('deactivated with a cached list: 404 on both endpoints; reactivated: the shows are back', async () => {
      const s = await scene();
      const show = await createShow(s, NOV_2, '19:00');
      expect(await publicDates(s, s.movie.id)).toEqual([NOV_2]);
      expect(await publicShows(s, s.movie.id, NOV_2)).toHaveLength(1);

      const hide = await admin(s, 'patch', `/movies/${s.movie.id}/active`, { isActive: false });
      expect(hide.status).toBe(200);

      await expectPublicHidden(s, s.movie.id, [show.id]);

      const unhide = await admin(s, 'patch', `/movies/${s.movie.id}/active`, { isActive: true });
      expect(unhide.status).toBe(200);
      expect(await publicDates(s, s.movie.id)).toEqual([NOV_2]);
      const listed = await publicShows(s, s.movie.id, NOV_2);
      expect(listed.map((item) => item.id)).toEqual([show.id]);
    });

    it('soft-deleted after clearing its shows (they block it): 404 on both endpoints; restored: public again', async () => {
      const s = await scene();
      const show = await createShow(s, NOV_2, '19:00');
      expect(await publicDates(s, s.movie.id)).toEqual([NOV_2]);
      expect((await admin(s, 'delete', `/movies/${s.movie.id}`)).status).toBe(409);

      const cleared = await admin(s, 'post', '/showtimes/bulk-delete', { ids: [show.id] });
      expect(cleared.status).toBe(200);
      expect((await admin(s, 'delete', `/movies/${s.movie.id}`)).status).toBe(200);

      await expectPublicHidden(s, s.movie.id, [show.id]);

      expect((await admin(s, 'post', `/movies/${s.movie.id}/restore`)).status).toBe(200);
      expect(await publicDates(s, s.movie.id)).toEqual([]);
    });
  });

  // Seeded with live upcoming shows. The API refuses to soft-delete such a movie (T15), so only a
  // row from before that rule or a manual edit gets here, and a hidden movie's shows are the case
  // that matters: nothing else stands between them and a visitor.
  describe.each([
    {
      state: 'inactive',
      seed: { isActive: false },
      bringBack: (s: Scene, id: string) =>
        admin(s, 'patch', `/movies/${id}/active`, { isActive: true }),
    },
    {
      state: 'soft-deleted',
      seed: { deletedAt: TRASHED_AT },
      bringBack: (s: Scene, id: string) => admin(s, 'post', `/movies/${id}/restore`),
    },
  ])('seeded $state, with a live upcoming show', ({ seed, bringBack }) => {
    function seedHiddenMovie(s: Scene) {
      const hidden = s.db.addMovie(
        testMovie({
          slug: 'hidden',
          title: 'Hidden',
          durationMinutes: 120,
          status: 'NOW_SHOWING',
          ...seed,
        }),
      );
      const show = s.db.addShowtime({
        movieId: hidden.id,
        screenId: s.screen.id,
        startsAt: colombo(NOV_2, '19:00'),
      });
      return { hidden, show };
    }

    it('404 on both endpoints, with no show or booking link in them', async () => {
      const s = await scene();
      const { hidden, show } = seedHiddenMovie(s);

      await expectPublicHidden(s, hidden.id, [show.id]);
    });

    it('brought back through the admin API: the show is public', async () => {
      const s = await scene();
      const { hidden, show } = seedHiddenMovie(s);
      await expectPublicHidden(s, hidden.id, [show.id]);

      expect((await bringBack(s, hidden.id)).status).toBe(200);

      expect(await publicDates(s, hidden.id)).toEqual([NOV_2]);
      const listed = await publicShows(s, hidden.id, NOV_2);
      expect(listed.map((item) => [item.id, item.bookingUrl])).toEqual([
        [show.id, `${BMS_BASE}/20261102`],
      ]);
    });
  });

  it('ENDED: 200 with empty lists, and the shows are back if it runs again', async () => {
    const s = await scene();
    const show = await createShow(s, NOV_2, '19:00');
    expect(await publicDates(s, s.movie.id)).toEqual([NOV_2]);

    const ended = await admin(s, 'patch', `/movies/${s.movie.id}/status`, { status: 'ENDED' });
    expect(ended.status).toBe(200);

    expect(await publicDates(s, s.movie.id)).toEqual([]);
    expect(await publicShows(s, s.movie.id, NOV_2)).toEqual([]);

    const back = await admin(s, 'patch', `/movies/${s.movie.id}/status`, { status: 'NOW_SHOWING' });
    expect(back.status).toBe(200);
    const listed = await publicShows(s, s.movie.id, NOV_2);
    expect(listed.map((item) => item.id)).toEqual([show.id]);
  });

  it('UPCOMING: 200 with its showtimes (advance booking)', async () => {
    const s = await scene();
    const upcoming = await createMovie(s, { title: 'Next Month', status: 'UPCOMING' });
    expect(upcoming.status).toBe('UPCOMING');

    const created = await createShow(s, NOV_2, '19:00', { movieId: upcoming.id });

    expect(await publicDates(s, upcoming.id)).toEqual([NOV_2]);
    const listed = await publicShows(s, upcoming.id, NOV_2);
    expect(listed.map((item) => [item.id, item.bookingUrl])).toEqual([
      [created.id, `${BMS_BASE}/20261102`],
    ]);
  });
});

describe('Carried forward: Permanent movie delete is refused while the movie has future showtimes', () => {
  it('409 with futureShowtimeCount; after removing them, 204 and the audit row counts every show deleted', async () => {
    const s = await scene();
    // Seeded: a soft delete is refused while future shows exist (T15), so the API cannot put a
    // movie in the trash with shows ahead of it. A past show goes with the movie.
    const trashed = s.db.addMovie(
      testMovie({
        slug: 'trashed',
        title: 'Trashed',
        durationMinutes: 120,
        status: 'NOW_SHOWING',
        deletedAt: TRASHED_AT,
      }),
    );
    const onScreen = { movieId: trashed.id, screenId: s.screen.id };
    const first = s.db.addShowtime({ ...onScreen, startsAt: colombo(NOV_2, '10:00') });
    const second = s.db.addShowtime({ ...onScreen, startsAt: colombo(NOV_2, '19:00') });
    s.db.addShowtime({ ...onScreen, startsAt: colombo(TODAY, '09:00') });
    const before = snapshot(s);

    const refused = await admin(s, 'delete', `/movies/${trashed.id}/permanent`);

    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error: {
        code: 'CONFLICT',
        message: MOVIE_HARD_DELETE_HAS_SHOWTIMES_MESSAGE,
        details: { futureShowtimeCount: 2 },
      },
    });
    expectNothingChanged(s, before);

    const cleared = await admin(s, 'post', '/showtimes/bulk-delete', {
      ids: [first.id, second.id],
    });
    expect(showtimeBulkDeleteResponseSchema.parse(cleared.body)).toEqual({ deleted: 2 });

    const removed = await admin(s, 'delete', `/movies/${trashed.id}/permanent`);

    expect(removed.status).toBe(204);
    expect(s.db.movies.map((movie) => movie.id)).not.toContain(trashed.id);
    expect(s.db.showtimes.filter((row) => row.movieId === trashed.id)).toEqual([]);
    expect(s.db.auditLogs.at(-1)).toMatchObject({
      action: 'DELETE',
      entity: 'Movie',
      entityId: trashed.id,
      details: { mode: 'hard', title: 'Trashed', slug: 'trashed', showtimesDeleted: 3 },
    });
  });

  it('the whole journey through the API: refused twice, shows cleared, soft delete, permanent delete', async () => {
    const s = await scene();
    const show = await createShow(s, NOV_2, '19:00');

    const softRefused = await admin(s, 'delete', `/movies/${s.movie.id}`);
    expect(softRefused.status).toBe(409);
    expect(softRefused.body).toEqual({
      error: {
        code: 'CONFLICT',
        message: MOVIE_DELETE_HAS_SHOWTIMES_MESSAGE,
        details: { futureShowtimeCount: 1 },
      },
    });
    const hardRefused = await admin(s, 'delete', `/movies/${s.movie.id}/permanent`);
    expect(hardRefused.status).toBe(409);
    expect(apiErrorSchema.parse(hardRefused.body).error.message).toBe(MOVIE_DELETE_FIRST_MESSAGE);

    const cleared = await admin(s, 'post', '/showtimes/bulk-delete', { ids: [show.id] });
    expect(cleared.status).toBe(200);
    expect((await admin(s, 'delete', `/movies/${s.movie.id}`)).status).toBe(200);
    expect((await admin(s, 'delete', `/movies/${s.movie.id}/permanent`)).status).toBe(204);

    expect(s.db.showtimes).toEqual([]);
    expect(s.db.auditLogs.at(-1)).toMatchObject({
      action: 'DELETE',
      entityId: s.movie.id,
      details: { mode: 'hard', showtimesDeleted: 1 },
    });
    await expectPublicHidden(s, s.movie.id, [show.id]);
  });
});

// ---------------------------------------------------------------------------
// Audit completeness
// ---------------------------------------------------------------------------

describe('Audit completeness: every admin write leaves its row, nothing else does', () => {
  interface AuditKey {
    action: AuditAction;
    entity: string;
    entityId: string | null;
  }

  const auditKeys = (f: Flow, from: number): AuditKey[] =>
    f.db.auditLogs
      .slice(from)
      .map(({ action, entity, entityId }) => ({ action, entity, entityId }));

  const row = (action: AuditAction, entity: string, entityId: string | null): AuditKey => ({
    action,
    entity,
    entityId,
  });

  it('a whole journey leaves exactly these rows, in this order, by this admin', async () => {
    const f = await start();
    const editor = await signIn(f.app, EDITOR_EMAIL);
    const from = f.db.auditLogs.length;
    const write = async (
      method: Method,
      path: string,
      status: number,
      body?: object,
    ): Promise<request.Response> => {
      const res = await admin(f, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(status);
      return res;
    };

    // Screens: create, rename, hide, show.
    const screen = await createScreen(f, 'Screen 1');
    await write('patch', `/screens/${screen.id}`, 200, { name: 'Dolby Hall' });
    await write('patch', `/screens/${screen.id}/active`, 200, { isActive: false });
    await write('patch', `/screens/${screen.id}/active`, 200, { isActive: true });

    // A spare screen: create, soft delete, restore.
    const spare = await createScreen(f, 'Spare');
    await write('delete', `/screens/${spare.id}`, 200);
    await write('post', `/screens/${spare.id}/restore`, 200);

    const movie = await createMovie(f, { status: 'UPCOMING' });
    const onScreen = { movieId: movie.id, screenId: screen.id };

    // Showtimes: create, bulk, move, delete, bulk delete.
    const createdRes = await write('post', '/showtimes', 201, {
      ...onScreen,
      date: NOV_2,
      time: '19:00',
    });
    const show = adminShowtimeResponseSchema.parse(createdRes.body).showtime;
    const bulkRes = await write('post', '/showtimes/bulk', 201, {
      ...onScreen,
      dateFrom: NOV_3,
      dateTo: NOV_3,
      times: ['10:00', '19:00'],
    });
    const bulk = showtimeBulkCreateResponseSchema.parse(bulkRes.body).items;
    const [bulkFirst, bulkSecond] = bulk;
    if (!bulkFirst || !bulkSecond) throw new Error('expected two bulk showtimes');

    // One refusal of each kind, in the middle of the journey: none may leave a row.
    await write('post', '/showtimes', 409, { ...onScreen, date: NOV_3, time: '11:00' });
    await write('post', '/showtimes', 400, { ...onScreen, date: NOV_4, time: 'soon' });
    const asEditor = await admin(f, 'patch', '/settings', { showGapMinutes: 30 }, { as: editor });
    expect(asEditor.status).toBe(403);
    const noCsrf = await admin(f, 'post', '/screens', { name: 'No CSRF' }, { withCsrf: false });
    expect(noCsrf.status).toBe(403);

    await write('patch', `/showtimes/${show.id}`, 200, { date: NOV_4, time: '19:00' });
    await write('delete', `/showtimes/${show.id}`, 200);
    await write('post', '/showtimes/bulk-delete', 200, { ids: [bulkFirst.id, bulkSecond.id] });

    // Reads in the middle of the journey: none may leave a row.
    await write('get', '/screens', 200);
    await write('get', '/showtimes?includePast=true&deleted=include', 200);
    await write('get', '/settings', 200);
    await publicDates(f, movie.id);

    // Settings, one key each, then the movie's status.
    await write('patch', '/settings', 200, { bmsBaseUrl: NEW_BMS_BASE });
    await write('patch', '/settings', 200, { showGapMinutes: 30 });
    await write('patch', `/movies/${movie.id}/status`, 200, { status: 'NOW_SHOWING' });

    expect(auditKeys(f, from)).toEqual([
      row('CREATE', 'Screen', screen.id),
      row('UPDATE', 'Screen', screen.id),
      row('STATUS_CHANGE', 'Screen', screen.id),
      row('STATUS_CHANGE', 'Screen', screen.id),
      row('CREATE', 'Screen', spare.id),
      row('DELETE', 'Screen', spare.id),
      row('UPDATE', 'Screen', spare.id),
      row('CREATE', 'Movie', movie.id),
      row('CREATE', 'Showtime', show.id),
      row('CREATE', 'Showtime', bulkFirst.id),
      row('CREATE', 'Showtime', bulkSecond.id),
      row('UPDATE', 'Showtime', show.id),
      row('DELETE', 'Showtime', show.id),
      row('DELETE', 'Showtime', bulkFirst.id),
      row('DELETE', 'Showtime', bulkSecond.id),
      row('UPDATE', 'Setting', 'bmsBaseUrl'),
      row('UPDATE', 'Setting', 'showGapMinutes'),
      row('STATUS_CHANGE', 'Movie', movie.id),
    ]);
    for (const audit of f.db.auditLogs.slice(from)) {
      expect(audit).toMatchObject({ adminId: f.adminId, userAgent: TEST_USER_AGENT });
    }
  });

  it('reads leave no row: every admin GET and both public endpoints', async () => {
    const s = await scene();
    const show = await createShow(s, NOV_2, '19:00');
    const before = snapshot(s);

    const paths = [
      '/screens',
      `/screens/${s.screen.id}`,
      '/showtimes',
      `/showtimes/${show.id}`,
      '/settings',
      '/movies',
      `/movies/${s.movie.id}`,
    ];
    for (const path of paths) {
      expect((await admin(s, 'get', path)).status, path).toBe(200);
    }
    await publicDates(s, s.movie.id);
    await publicShows(s, s.movie.id, NOV_2);

    expectNothingChanged(s, before);
  });

  describe('a refused write leaves no row and changes nothing', () => {
    it('overlap: 409', async () => {
      const s = await scene();
      await createShow(s, NOV_2, '19:00');
      const before = snapshot(s);

      const res = await admin(s, 'post', '/showtimes', showBody(s, NOV_2, '20:00'));

      expect(res.status).toBe(409);
      expectNothingChanged(s, before);
    });

    it('validation: 400', async () => {
      const s = await scene();
      const before = snapshot(s);

      const res = await admin(s, 'post', '/showtimes', showBody(s, NOV_2, 'soon'));

      expect(res.status).toBe(400);
      expectNothingChanged(s, before);
    });

    it('role: 403 for an EDITOR changing settings', async () => {
      const s = await scene();
      const editor = await signIn(s.app, EDITOR_EMAIL);
      const before = snapshot(s);

      const res = await admin(s, 'patch', '/settings', { showGapMinutes: 30 }, { as: editor });

      expect(res.status).toBe(403);
      expect(res.body).toEqual(FORBIDDEN_BODY);
      expectNothingChanged(s, before);
    });

    it('CSRF: 403 without the token', async () => {
      const s = await scene();
      const before = snapshot(s);

      const res = await admin(s, 'post', '/showtimes', showBody(s, NOV_2, '19:00'), {
        withCsrf: false,
      });

      expect(res.status).toBe(403);
      expect(res.body).toEqual(CSRF_BODY);
      expectNothingChanged(s, before);
    });
  });
});

// ---------------------------------------------------------------------------
// Public response whitelist
// ---------------------------------------------------------------------------

describe('Public response whitelist: only the public fields ever leave', () => {
  const FORBIDDEN_FIELDS = [
    'bookingUrlOverride',
    'deletedAt',
    'isActive',
    'movieId',
    'screenId',
    'updatedAt',
    'createdAt',
  ];

  function expectNoForbiddenField(text: string) {
    for (const field of FORBIDDEN_FIELDS) expect(text, field).not.toContain(field);
  }

  /** One show with an override, one generated, one soft-deleted, one on a hidden screen. */
  async function sceneWithEveryKindOfShow() {
    const s = await scene();
    const withOverride = await createShow(s, NOV_2, '10:00', { bookingUrlOverride: OVERRIDE });
    const generated = await createShow(s, NOV_2, '19:00', { format: '3D' });
    s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.otherScreen.id,
      startsAt: colombo(NOV_2, '10:00'),
      deletedAt: TRASHED_AT,
    });
    const hiddenScreen = s.db.addScreen({ name: 'Hidden', isActive: false });
    s.db.addShowtime({
      movieId: s.movie.id,
      screenId: hiddenScreen.id,
      startsAt: colombo(NOV_2, '13:00'),
    });
    return { s, withOverride, generated };
  }

  it('GET /dates: only the dates', async () => {
    const { s } = await sceneWithEveryKindOfShow();

    const res = await request(s.app).get(datesPath(s.movie.id));

    expect(res.status).toBe(200);
    expect(publicShowtimeDatesResponseSchema.parse(res.body)).toEqual({ dates: [NOV_2] });
    expect(res.body).toEqual({ dates: [NOV_2] });
    expectNoForbiddenField(res.text);
  });

  it('GET /showtimes: exactly the whitelisted fields of each show, with the override only as bookingUrl', async () => {
    const { s, withOverride, generated } = await sceneWithEveryKindOfShow();

    const res = await request(s.app).get(showsPath(s.movie.id, NOV_2));

    expect(res.status).toBe(200);
    const parsed = publicShowtimeListResponseSchema.parse(res.body);
    expect(res.body).toEqual({
      date: NOV_2,
      items: [
        {
          id: withOverride.id,
          startsAt: colombo(NOV_2, '10:00').toISOString(),
          time: '10:00',
          format: '2D',
          screen: { name: 'Screen 1' },
          bookingUrl: OVERRIDE,
        },
        {
          id: generated.id,
          startsAt: colombo(NOV_2, '19:00').toISOString(),
          time: '19:00',
          format: '3D',
          screen: { name: 'Screen 1' },
          bookingUrl: `${BMS_BASE}/20261102`,
        },
      ],
    });
    expect(parsed.items).toHaveLength(2);
    expectNoForbiddenField(res.text);
  });

  it('the admin response of the same show has those fields, so this check can fail', async () => {
    const { s, withOverride } = await sceneWithEveryKindOfShow();

    const res = await admin(s, 'get', `/showtimes/${withOverride.id}`);

    for (const field of ['bookingUrlOverride', 'deletedAt', 'updatedAt', 'createdAt']) {
      expect(res.text, field).toContain(field);
    }
  });

  it('a date with no shows and a 404 carry none of them either', async () => {
    const { s } = await sceneWithEveryKindOfShow();
    const hide = await admin(s, 'patch', `/movies/${s.movie.id}/active`, { isActive: false });
    expect(hide.status).toBe(200);

    const hidden = await request(s.app).get(showsPath(s.movie.id, NOV_2));
    expect(hidden.status).toBe(404);
    expectNoForbiddenField(hidden.text);

    const unhide = await admin(s, 'patch', `/movies/${s.movie.id}/active`, { isActive: true });
    expect(unhide.status).toBe(200);
    const empty = await request(s.app).get(showsPath(s.movie.id, NOV_3));
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ date: NOV_3, items: [] });
    expectNoForbiddenField(empty.text);
  });
});

// ---------------------------------------------------------------------------
// Route walk. The 401 half lives in routes/admin.routes.test.ts, which walks the real router and
// names every /screens, /showtimes and /settings route; only the role half is a flow.
// ---------------------------------------------------------------------------

describe('Route walk: /settings is SUPER_ADMIN only', () => {
  it('EDITOR gets 403 on GET /settings; the SUPER_ADMIN gets the settings', async () => {
    const f = await start();
    const editor = await signIn(f.app, EDITOR_EMAIL);

    const refused = await admin(f, 'get', '/settings', undefined, { as: editor });

    expect(refused.status).toBe(403);
    expect(refused.body).toEqual(FORBIDDEN_BODY);
    expect(refused.text).not.toContain('bmsBaseUrl');
    const allowed = await admin(f, 'get', '/settings');
    expect(allowed.status).toBe(200);
    expect(adminSettingsResponseSchema.parse(allowed.body).settings.bmsBaseUrl).toBe(BMS_BASE);
  });

  it('EDITOR gets 403 on PATCH /settings, even with a valid body; the SUPER_ADMIN may save it', async () => {
    const f = await start();
    const editor = await signIn(f.app, EDITOR_EMAIL);
    const before = snapshot(f);

    const refused = await admin(
      f,
      'patch',
      '/settings',
      { bmsBaseUrl: NEW_BMS_BASE },
      { as: editor },
    );

    expect(refused.status).toBe(403);
    expect(refused.body).toEqual(FORBIDDEN_BODY);
    expectNothingChanged(f, before);
    const allowed = await admin(f, 'patch', '/settings', { bmsBaseUrl: NEW_BMS_BASE });
    expect(allowed.status).toBe(200);
  });
});
