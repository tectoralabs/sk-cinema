/**
 * Phase 5 T13 flow tests: a CACHED public showtime list really changes after an admin write.
 * Every test goes GET public (fill) -> GET public (proves the cache answers) -> write through
 * the admin API -> GET public, through createApp + supertest, and asserts that:
 *   1. the write invalidated only after its transaction committed, exactly once;
 *   2. the next GET went back to the database and shows the change.
 * A write that fails (409, or a fault mid-transaction) must leave the entry alone: the next GET
 * does not query the database.
 *
 * A fill always starts with movie.findUnique, so that spy, cleared after the write, counts fills.
 * (showtime.findMany would not do: admin writes use it too, and an ENDED movie skips it.)
 */
import {
  DEFAULT_BMS_BASE_URL,
  publicShowtimeDatesResponseSchema,
  publicShowtimeListResponseSchema,
  type PublicShowtime,
} from '@sk-cinema/shared';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Movie, Screen } from '../generated/prisma/client.js';
import type { MemoryCache } from '../lib/cache.js';
import { CSRF_HEADER } from '../middleware/csrf.js';
import {
  PUBLIC_MOVIES_CACHE_PREFIX,
  invalidatePublicMovies,
} from '../services/movie.public.service.js';
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
  testScreen,
  testShowtime,
  type AuthClient,
  type InMemoryAuthDb,
  type Session,
} from './helpers.js';

const EMAIL = 'admin@skcinema.lk';
const PASSWORD = 'correct horse battery staple';
const OVERRIDE = 'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/special-premiere/20261102';
const NEW_BMS_BASE = 'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/cinema-snlk-SKCM-NEW';

/** The app's clock (only Date is faked): 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');
const DELETED_AT = new Date('2026-10-01T00:00:00.000Z');

const DAY_1 = '2026-11-02';
const DAY_2 = '2026-11-03';
const DAY_3 = '2026-11-04';

const colombo = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);

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

interface Setup {
  app: Express;
  db: InMemoryAuthDb;
  cache: MemoryCache;
  client: AuthClient;
  session: Session;
  movie: Movie;
  /** The screen the two shows are on: it cannot be hidden or deleted while they are upcoming. */
  screen: Screen;
  /** A screen with no shows, free to be hidden or deleted. */
  spare: Screen;
  /** The show on DAY_1 at 19:00. */
  show1: string;
  /** The show on DAY_2 at 19:00. */
  show2: string;
}

async function setup(screens: Screen[] = []): Promise<Setup> {
  const admin = testAdmin({ email: EMAIL, passwordHash, role: 'SUPER_ADMIN' });
  const movie = testMovie({
    slug: 'main-feature',
    title: 'Main Feature',
    durationMinutes: 120,
    status: 'NOW_SHOWING',
  });
  const screen = testScreen({ name: 'Screen 1' });
  const spare = testScreen({ name: 'Screen 2' });
  const show1 = testShowtime({
    movieId: movie.id,
    screenId: screen.id,
    startsAt: colombo(DAY_1, '19:00'),
  });
  const show2 = testShowtime({
    movieId: movie.id,
    screenId: screen.id,
    startsAt: colombo(DAY_2, '19:00'),
  });
  const db = inMemoryAuthDb({
    admins: [admin],
    movies: [movie],
    screens: [screen, spare, ...screens],
    showtimes: [show1, show2],
  });
  const { app, cache } = buildTestApp({ prisma: db.prisma });
  const client = await authClient(app);
  const login = await client.post('/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  expect(login.status).toBe(200);
  return {
    app,
    db,
    cache,
    client,
    session: sessionFrom(login),
    movie,
    screen,
    spare,
    show1: show1.id,
    show2: show2.id,
  };
}

/** A browser-like admin request: session, CSRF token and Origin. */
function admin(s: Setup, method: 'post' | 'patch' | 'delete', path: string, body?: object) {
  const req = request(s.app)
    [method](`${ADMIN_BASE}${path}`)
    .set('User-Agent', TEST_USER_AGENT)
    .set('Cookie', [s.client.csrf.cookie, s.session.access].join('; '))
    .set('Origin', ADMIN_ORIGIN)
    .set(CSRF_HEADER, s.client.csrf.token);
  return body === undefined ? req : req.send(body);
}

/** What a visitor sees: 404, or the dates and each day's shows (strict shared schemas). */
type PublicView =
  { status: 404 } | { status: 200; dates: string[]; days: Record<string, PublicShowtime[]> };

async function readPublic(s: Setup): Promise<PublicView> {
  const base = `/api/movies/${s.movie.id}`;
  const datesRes = await request(s.app).get(`${base}/dates`);
  if (datesRes.status === 404) return { status: 404 };
  expect(datesRes.status).toBe(200);
  const { dates } = publicShowtimeDatesResponseSchema.parse(datesRes.body);

  const days: Record<string, PublicShowtime[]> = {};
  for (const date of [DAY_1, DAY_2, DAY_3]) {
    const res = await request(s.app).get(`${base}/showtimes?date=${date}`);
    expect(res.status).toBe(200);
    days[date] = publicShowtimeListResponseSchema.parse(res.body).items;
  }
  return { status: 200, dates, days };
}

function visible(view: PublicView) {
  if (view.status !== 200) throw new Error('expected the movie to be public');
  return view;
}

const fillCount = (s: Setup) => s.db.spies.movie.findUnique.mock.calls.length;

/** Records 'commit' / 'rollback' when a transaction settles and 'invalidate' when one happens. */
function trackWrite(s: Setup) {
  const events: string[] = [];
  const transaction = s.db.spies.$transaction.getMockImplementation();
  if (!transaction) throw new Error('the fake has no implementation to wrap');
  s.db.spies.$transaction.mockImplementation((fn, options) =>
    transaction(fn, options).then(
      (value) => {
        events.push('commit');
        return value;
      },
      (error: unknown) => {
        events.push('rollback');
        throw error;
      },
    ),
  );
  const invalidate = s.cache.invalidatePrefix.bind(s.cache);
  const spy = vi.spyOn(s.cache, 'invalidatePrefix').mockImplementation((prefix) => {
    events.push('invalidate');
    invalidate(prefix);
  });
  return { events, spy };
}

/** Fills the cache and proves a second read costs no query. Returns what is cached. */
async function fillCache(s: Setup): Promise<PublicView> {
  const filled = await readPublic(s);
  s.db.spies.movie.findUnique.mockClear();
  expect(await readPublic(s)).toEqual(filled);
  expect(fillCount(s)).toBe(0);
  return filled;
}

interface WriteOutcome {
  before: PublicView;
  after: PublicView;
}

/**
 * The whole story of a write that succeeds: fill, write, invalidated once and only after the
 * commit, next read goes to the database. `beforeWrite` changes a row behind the cache's back,
 * for writes (hiding a screen) that cannot themselves change what is listed.
 */
async function afterWrite(
  s: Setup,
  write: () => PromiseLike<request.Response>,
  { status = 200, beforeWrite }: { status?: number; beforeWrite?: () => void } = {},
): Promise<WriteOutcome> {
  const before = await fillCache(s);
  beforeWrite?.();
  const { events, spy } = trackWrite(s);

  const res = await write();
  expect(res.status).toBe(status);

  expect(events).toEqual(['commit', 'invalidate']);
  expect(spy).toHaveBeenCalledExactlyOnceWith(PUBLIC_MOVIES_CACHE_PREFIX);

  s.db.spies.movie.findUnique.mockClear();
  const after = await readPublic(s);
  // One fill serves all four GETs; a 404 is not cached, but readPublic stops at the first.
  expect(fillCount(s)).toBe(1);
  return { before, after };
}

/**
 * The whole story of a write that fails: fill, write refused, no invalidation, the next read
 * costs no query and is unchanged. Then, with the cache dropped by hand, the database shows
 * the same thing: the write really did not happen.
 */
async function afterFailedWrite(
  s: Setup,
  write: () => PromiseLike<request.Response>,
  status: number,
): Promise<void> {
  const before = await fillCache(s);
  const { spy } = trackWrite(s);

  const res = await write();
  expect(res.status).toBe(status);

  expect(spy).not.toHaveBeenCalled();
  s.db.spies.movie.findUnique.mockClear();
  expect(await readPublic(s)).toEqual(before);
  expect(fillCount(s)).toBe(0);

  invalidatePublicMovies(s.cache);
  expect(await readPublic(s)).toEqual(before);
}

const createBody = (s: Setup, overrides: object = {}) => ({
  movieId: s.movie.id,
  screenId: s.screen.id,
  date: DAY_3,
  time: '19:00',
  ...overrides,
});

const bulkBody = (s: Setup, overrides: object = {}) => ({
  movieId: s.movie.id,
  screenId: s.screen.id,
  dateFrom: DAY_3,
  dateTo: DAY_3,
  times: ['10:00', '19:00'],
  ...overrides,
});

const AUDIT_DOWN = () => new Error('audit table unavailable');

// ---------------------------------------------------------------------------
// T10-T12: showtime writes
// ---------------------------------------------------------------------------

describe('showtime writes change the cached public list', () => {
  it('T10 POST /showtimes: the new show and its date appear', async () => {
    const s = await setup();

    const { before, after } = await afterWrite(
      s,
      () => admin(s, 'post', '/showtimes', createBody(s)),
      { status: 201 },
    );

    expect(visible(before).dates).toEqual([DAY_1, DAY_2]);
    expect(visible(after).dates).toEqual([DAY_1, DAY_2, DAY_3]);
    expect(visible(after).days[DAY_3]?.map((item) => item.time)).toEqual(['19:00']);
  });

  it('T11 POST /showtimes/bulk: every new show appears', async () => {
    const s = await setup();

    const { after } = await afterWrite(s, () => admin(s, 'post', '/showtimes/bulk', bulkBody(s)), {
      status: 201,
    });

    expect(visible(after).dates).toEqual([DAY_1, DAY_2, DAY_3]);
    expect(visible(after).days[DAY_3]?.map((item) => item.time)).toEqual(['10:00', '19:00']);
  });

  it('T12 PATCH /showtimes/:id, moved date: leaves the old date, joins the new one, new link', async () => {
    const s = await setup();

    const { before, after } = await afterWrite(s, () =>
      admin(s, 'patch', `/showtimes/${s.show1}`, { date: DAY_3, time: '10:00' }),
    );

    expect(visible(before).days[DAY_1]?.map((item) => item.id)).toEqual([s.show1]);
    expect(visible(after).dates).toEqual([DAY_2, DAY_3]);
    expect(visible(after).days[DAY_1]).toEqual([]);
    const [moved] = visible(after).days[DAY_3] ?? [];
    expect(moved).toMatchObject({ id: s.show1, time: '10:00' });
    expect(moved?.bookingUrl.endsWith('/20261104')).toBe(true);
  });

  it('T12 PATCH /showtimes/:id, format change: the new format is listed', async () => {
    const s = await setup();

    const { before, after } = await afterWrite(s, () =>
      admin(s, 'patch', `/showtimes/${s.show1}`, { format: 'imax 3d' }),
    );

    expect(visible(before).days[DAY_1]?.[0]?.format).toBe('2D');
    expect(visible(after).days[DAY_1]?.[0]?.format).toBe('IMAX 3D');
  });

  it('T12 PATCH /showtimes/:id, override: the booking link changes', async () => {
    const s = await setup();

    const { before, after } = await afterWrite(s, () =>
      admin(s, 'patch', `/showtimes/${s.show1}`, { bookingUrlOverride: OVERRIDE }),
    );

    expect(visible(before).days[DAY_1]?.[0]?.bookingUrl).not.toBe(OVERRIDE);
    expect(visible(after).days[DAY_1]?.[0]?.bookingUrl).toBe(OVERRIDE);
  });

  it('T12 PATCH /showtimes/:id, other screen: the new screen name is listed', async () => {
    const s = await setup();

    const { before, after } = await afterWrite(s, () =>
      admin(s, 'patch', `/showtimes/${s.show1}`, { screenId: s.spare.id }),
    );

    expect(visible(before).days[DAY_1]?.[0]?.screen.name).toBe('Screen 1');
    expect(visible(after).days[DAY_1]?.[0]?.screen.name).toBe('Screen 2');
  });

  it('T12 DELETE /showtimes/:id: the show and its now empty date disappear', async () => {
    const s = await setup();

    const { after } = await afterWrite(s, () => admin(s, 'delete', `/showtimes/${s.show1}`));

    expect(visible(after).dates).toEqual([DAY_2]);
    expect(visible(after).days[DAY_1]).toEqual([]);
  });

  it('T12 POST /showtimes/bulk-delete: every selected show disappears', async () => {
    const s = await setup();

    const { after } = await afterWrite(s, () =>
      admin(s, 'post', '/showtimes/bulk-delete', { ids: [s.show1, s.show2] }),
    );

    expect(visible(after).dates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T9: screen writes
// ---------------------------------------------------------------------------

describe('screen writes change the cached public list', () => {
  const rogueShow = (s: Setup) => ({
    movieId: s.movie.id,
    screenId: s.screen.id,
    startsAt: colombo(DAY_3, '10:00'),
  });

  it('T9 PATCH /screens/:id, rename: the new name is listed', async () => {
    const s = await setup();

    const { before, after } = await afterWrite(s, () =>
      admin(s, 'patch', `/screens/${s.screen.id}`, { name: 'Dolby Hall' }),
    );

    expect(visible(before).days[DAY_1]?.[0]?.screen.name).toBe('Screen 1');
    expect(visible(after).days[DAY_1]?.[0]?.screen.name).toBe('Dolby Hall');
    expect(visible(after).days[DAY_2]?.[0]?.screen.name).toBe('Dolby Hall');
  });

  // Hiding or deleting a screen is refused while it has upcoming shows (409, tested below), so
  // these writes can never remove a listed show. They must still drop the entry: the row added
  // behind the cache's back only shows up if the next read really went to the database.
  it('T9 PATCH /screens/:id/active, hide: the entry is dropped', async () => {
    const s = await setup();

    const { before, after } = await afterWrite(
      s,
      () => admin(s, 'patch', `/screens/${s.spare.id}/active`, { isActive: false }),
      { beforeWrite: () => s.db.addShowtime(rogueShow(s)) },
    );

    expect(visible(before).dates).toEqual([DAY_1, DAY_2]);
    expect(visible(after).dates).toEqual([DAY_1, DAY_2, DAY_3]);
  });

  it('T9 DELETE /screens/:id, soft delete: the entry is dropped', async () => {
    const s = await setup();

    const { before, after } = await afterWrite(
      s,
      () => admin(s, 'delete', `/screens/${s.spare.id}`),
      { beforeWrite: () => s.db.addShowtime(rogueShow(s)) },
    );

    expect(visible(before).dates).toEqual([DAY_1, DAY_2]);
    expect(visible(after).dates).toEqual([DAY_1, DAY_2, DAY_3]);
  });

  it('T9 PATCH /screens/:id/active, show: shows on it become public', async () => {
    const hidden = testScreen({ name: 'Hidden', isActive: false });
    const s = await setup([hidden]);
    s.db.addShowtime({ ...rogueShow(s), screenId: hidden.id });

    const { before, after } = await afterWrite(s, () =>
      admin(s, 'patch', `/screens/${hidden.id}/active`, { isActive: true }),
    );

    expect(visible(before).dates).toEqual([DAY_1, DAY_2]);
    expect(visible(after).days[DAY_3]?.[0]?.screen.name).toBe('Hidden');
  });

  it('T9 POST /screens/:id/restore: shows on it become public', async () => {
    const deleted = testScreen({ name: 'Deleted', deletedAt: DELETED_AT });
    const s = await setup([deleted]);
    s.db.addShowtime({ ...rogueShow(s), screenId: deleted.id });

    const { before, after } = await afterWrite(s, () =>
      admin(s, 'post', `/screens/${deleted.id}/restore`),
    );

    expect(visible(before).dates).toEqual([DAY_1, DAY_2]);
    expect(visible(after).days[DAY_3]?.[0]?.screen.name).toBe('Deleted');
  });
});

// ---------------------------------------------------------------------------
// Movie writes
// ---------------------------------------------------------------------------

describe('movie writes change the cached public list', () => {
  it('PATCH /movies/:id/status to ENDED: the lists empty', async () => {
    const s = await setup();

    const { before, after } = await afterWrite(s, () =>
      admin(s, 'patch', `/movies/${s.movie.id}/status`, { status: 'ENDED' }),
    );

    expect(visible(before).dates).toEqual([DAY_1, DAY_2]);
    expect(visible(after).dates).toEqual([]);
    expect(visible(after).days[DAY_1]).toEqual([]);
  });

  it('PATCH /movies/:id/status back from ENDED: the shows return', async () => {
    const s = await setup();
    await admin(s, 'patch', `/movies/${s.movie.id}/status`, { status: 'ENDED' });

    const { before, after } = await afterWrite(s, () =>
      admin(s, 'patch', `/movies/${s.movie.id}/status`, { status: 'NOW_SHOWING' }),
    );

    expect(visible(before).dates).toEqual([]);
    expect(visible(after).dates).toEqual([DAY_1, DAY_2]);
  });

  it('PATCH /movies/:id/active, deactivate: 404', async () => {
    const s = await setup();

    const { after } = await afterWrite(s, () =>
      admin(s, 'patch', `/movies/${s.movie.id}/active`, { isActive: false }),
    );

    expect(after).toEqual({ status: 404 });
  });

  it('DELETE /movies/:id, soft delete: 404', async () => {
    const s = await setup();

    const { after } = await afterWrite(s, () => admin(s, 'delete', `/movies/${s.movie.id}`));

    expect(after).toEqual({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// T14: settings
// ---------------------------------------------------------------------------

describe('settings writes change the cached public list', () => {
  it('T14 settings bmsBaseUrl change: every generated booking link changes', async () => {
    const s = await setup();
    const withOverride = s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: colombo(DAY_3, '19:00'),
      bookingUrlOverride: OVERRIDE,
    });

    const { before, after } = await afterWrite(s, () =>
      admin(s, 'patch', '/settings', { bmsBaseUrl: NEW_BMS_BASE }),
    );

    expect(visible(before).days[DAY_1]?.[0]?.bookingUrl).toBe(`${DEFAULT_BMS_BASE_URL}/20261102`);
    expect(visible(before).days[DAY_2]?.[0]?.bookingUrl).toBe(`${DEFAULT_BMS_BASE_URL}/20261103`);
    expect(visible(after).days[DAY_1]?.[0]?.bookingUrl).toBe(`${NEW_BMS_BASE}/20261102`);
    expect(visible(after).days[DAY_2]?.[0]?.bookingUrl).toBe(`${NEW_BMS_BASE}/20261103`);

    // The override is the show's own link: untouched, in the response and in the row.
    expect(visible(before).days[DAY_3]?.[0]).toMatchObject({
      id: withOverride.id,
      bookingUrl: OVERRIDE,
    });
    expect(visible(after).days[DAY_3]?.[0]).toMatchObject({
      id: withOverride.id,
      bookingUrl: OVERRIDE,
    });
    expect(s.db.showtimes.find((row) => row.id === withOverride.id)?.bookingUrlOverride).toBe(
      OVERRIDE,
    );
  });

  it('T14 settings showGapMinutes change: the entry is dropped, the list is the same', async () => {
    const s = await setup();

    const { before, after } = await afterWrite(s, () =>
      admin(s, 'patch', '/settings', { showGapMinutes: 30 }),
    );

    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Failed writes
// ---------------------------------------------------------------------------

describe('a failed write leaves the cached entry in place', () => {
  it('409 overlap on POST /showtimes', async () => {
    const s = await setup();
    await afterFailedWrite(
      s,
      () => admin(s, 'post', '/showtimes', createBody(s, { date: DAY_1, time: '19:30' })),
      409,
    );
  });

  it('409 overlap on POST /showtimes/bulk', async () => {
    const s = await setup();
    await afterFailedWrite(
      s,
      () => admin(s, 'post', '/showtimes/bulk', bulkBody(s, { dateFrom: DAY_1, dateTo: DAY_1 })),
      409,
    );
  });

  it('409 overlap on PATCH /showtimes/:id', async () => {
    const s = await setup();
    await afterFailedWrite(
      s,
      () => admin(s, 'patch', `/showtimes/${s.show1}`, { date: DAY_2, time: '19:30' }),
      409,
    );
  });

  it('400 past time on POST /showtimes', async () => {
    const s = await setup();
    await afterFailedWrite(
      s,
      () => admin(s, 'post', '/showtimes', createBody(s, { date: '2026-11-01', time: '09:00' })),
      400,
    );
  });

  it('409 hiding a screen with upcoming shows', async () => {
    const s = await setup();
    await afterFailedWrite(
      s,
      () => admin(s, 'patch', `/screens/${s.screen.id}/active`, { isActive: false }),
      409,
    );
  });

  it('409 deleting a screen with upcoming shows', async () => {
    const s = await setup();
    await afterFailedWrite(s, () => admin(s, 'delete', `/screens/${s.screen.id}`), 409);
  });

  it('a fault in POST /showtimes rolls back', async () => {
    const s = await setup();
    await afterFailedWrite(
      s,
      () => {
        s.db.injectFault('auditLog', 'create', { error: AUDIT_DOWN() });
        return admin(s, 'post', '/showtimes', createBody(s));
      },
      500,
    );
  });

  it('a fault in POST /showtimes/bulk rolls back', async () => {
    const s = await setup();
    await afterFailedWrite(
      s,
      () => {
        s.db.injectFault('auditLog', 'createMany', { error: AUDIT_DOWN() });
        return admin(s, 'post', '/showtimes/bulk', bulkBody(s));
      },
      500,
    );
  });

  it('a fault in PATCH /showtimes/:id rolls back', async () => {
    const s = await setup();
    await afterFailedWrite(
      s,
      () => {
        s.db.injectFault('auditLog', 'create', { error: AUDIT_DOWN() });
        return admin(s, 'patch', `/showtimes/${s.show1}`, { format: '3D' });
      },
      500,
    );
  });

  it('a fault in DELETE /showtimes/:id rolls back', async () => {
    const s = await setup();
    await afterFailedWrite(
      s,
      () => {
        s.db.injectFault('auditLog', 'create', { error: AUDIT_DOWN() });
        return admin(s, 'delete', `/showtimes/${s.show1}`);
      },
      500,
    );
  });

  it('a fault in POST /showtimes/bulk-delete rolls back', async () => {
    const s = await setup();
    await afterFailedWrite(
      s,
      () => {
        s.db.injectFault('auditLog', 'createMany', { error: AUDIT_DOWN() });
        return admin(s, 'post', '/showtimes/bulk-delete', { ids: [s.show1, s.show2] });
      },
      500,
    );
  });

  it('a fault in a screen rename rolls back', async () => {
    const s = await setup();
    await afterFailedWrite(
      s,
      () => {
        s.db.injectFault('auditLog', 'create', { error: AUDIT_DOWN() });
        return admin(s, 'patch', `/screens/${s.screen.id}`, { name: 'Dolby Hall' });
      },
      500,
    );
  });

  it('a fault in a movie status change rolls back', async () => {
    const s = await setup();
    await afterFailedWrite(
      s,
      () => {
        s.db.injectFault('auditLog', 'create', { error: AUDIT_DOWN() });
        return admin(s, 'patch', `/movies/${s.movie.id}/status`, { status: 'ENDED' });
      },
      500,
    );
  });

  it('400 for a settings base URL that is not a BookMyShow link', async () => {
    const s = await setup();
    await afterFailedWrite(
      s,
      () => admin(s, 'patch', '/settings', { bmsBaseUrl: 'https://evil.example/buytickets/x' }),
      400,
    );
  });

  it('a fault in a settings upsert rolls back', async () => {
    const s = await setup();
    await afterFailedWrite(
      s,
      () => {
        s.db.injectFault('setting', 'upsert', { error: new Error('settings table unavailable') });
        return admin(s, 'patch', '/settings', { bmsBaseUrl: NEW_BMS_BASE });
      },
      500,
    );
  });

  it('a fault in a settings audit row rolls back', async () => {
    const s = await setup();
    await afterFailedWrite(
      s,
      () => {
        s.db.injectFault('auditLog', 'createMany', { error: AUDIT_DOWN() });
        return admin(s, 'patch', '/settings', { bmsBaseUrl: NEW_BMS_BASE });
      },
      500,
    );
  });

  it('a no-op settings PATCH changes nothing and keeps the entry', async () => {
    const s = await setup();
    await afterFailedWrite(
      s,
      () => admin(s, 'patch', '/settings', { bmsBaseUrl: DEFAULT_BMS_BASE_URL }),
      200,
    );
  });

  it('a no-op PATCH /showtimes/:id changes nothing and keeps the entry', async () => {
    const s = await setup();
    await afterFailedWrite(
      s,
      () => admin(s, 'patch', `/showtimes/${s.show1}`, { format: '2D' }),
      200,
    );
  });
});

// ---------------------------------------------------------------------------
// The fill-versus-invalidate race
// ---------------------------------------------------------------------------

describe('a fill that overlaps an admin write', () => {
  it('is answered to its own request but never stored', async () => {
    const s = await setup();
    const read = s.db.spies.showtime.findMany.getMockImplementation();
    if (!read) throw new Error('the fake has no implementation to wrap');

    // The fill reads the rows, then stalls before it can store them.
    let reached: () => void = () => undefined;
    let release: () => void = () => undefined;
    const atGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.db.spies.showtime.findMany.mockImplementationOnce(async (args) => {
      const rows = await read(args);
      reached();
      await gate;
      return rows;
    });

    const staleRequest = request(s.app)
      .get(`/api/movies/${s.movie.id}/dates`)
      .then((res) => res);
    await atGate;

    // The write commits and invalidates while the fill is still in flight.
    const write = await admin(s, 'post', '/showtimes', createBody(s));
    expect(write.status).toBe(201);

    release();
    const stale = await staleRequest;
    expect(publicShowtimeDatesResponseSchema.parse(stale.body).dates).toEqual([DAY_1, DAY_2]);

    // Nothing stale was stored: the next request goes to the database and sees the new show.
    s.db.spies.movie.findUnique.mockClear();
    expect(visible(await readPublic(s)).dates).toEqual([DAY_1, DAY_2, DAY_3]);
    expect(fillCount(s)).toBe(1);
  });
});
