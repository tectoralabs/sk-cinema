import { randomUUID } from 'node:crypto';
import {
  adminShowtimeListResponseSchema,
  adminShowtimeResponseSchema,
  apiErrorSchema,
  DEFAULT_BMS_BASE_URL,
  showtimeBulkCreateResponseSchema,
  showtimeBulkDeleteResponseSchema,
  showtimeConflictErrorSchema,
  showtimePastSlotErrorSchema,
  type AdminShowtime,
} from '@sk-cinema/shared';
import type { Express } from 'express';
import request from 'supertest';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import type { AdminRole, Movie, Screen, Setting, Showtime } from '../generated/prisma/client.js';
import type { MemoryCache } from '../lib/cache.js';
import { CSRF_HEADER } from '../middleware/csrf.js';
import { SESSION_EXPIRED_MESSAGE } from '../services/auth.service.js';
import { PUBLIC_MOVIES_CACHE_PREFIX } from '../services/movie.public.service.js';
import {
  showtimeBulkDeleteAlreadyDeletedMessage,
  showtimeBulkDeleteNotFoundMessage,
  showtimeBulkPastMessage,
  SHOWTIME_ALREADY_DELETED_MESSAGE,
  SHOWTIME_BULK_DELETE_DELETED_ID_MESSAGE,
  SHOWTIME_BULK_DELETE_UNKNOWN_ID_MESSAGE,
  SHOWTIME_DELETED_MESSAGE,
  SHOWTIME_IN_PAST_MESSAGE,
  SHOWTIME_MOVE_MOVIE_ENDED_MESSAGE,
  SHOWTIME_MOVE_SCREEN_INACTIVE_MESSAGE,
  SHOWTIME_MOVIE_ENDED_MESSAGE,
  SHOWTIME_MOVIE_NOT_FOUND_MESSAGE,
  SHOWTIME_NOT_FOUND_MESSAGE,
  SHOWTIME_OVERLAP_MESSAGE,
  SHOWTIME_SCREEN_INACTIVE_MESSAGE,
  SHOWTIME_SCREEN_NOT_FOUND_MESSAGE,
  SHOWTIME_SLOT_IN_PAST_MESSAGE,
  SHOWTIME_STARTED_MESSAGE,
} from '../services/showtime.admin.service.js';
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
  testSetting,
  testShowtime,
  type AuthClient,
  type InMemoryAuthDb,
  type SendOptions,
  type Session,
} from '../test/helpers.js';

const EMAIL = 'editor@skcinema.lk';
const PASSWORD = 'correct horse battery staple';
const UNAUTHORIZED_BODY = { error: { code: 'UNAUTHORIZED', message: SESSION_EXPIRED_MESSAGE } };
const CSRF_BODY = { error: { code: 'CSRF_INVALID', message: 'CSRF validation failed' } };
const INTERNAL_BODY = { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } };
const OVERRIDE = 'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/special-premiere/20261102';

/** The app's clock (only Date is faked): 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');
const DELETED_AT = new Date('2026-10-01T00:00:00.000Z');

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
  cache: ReturnType<typeof buildTestApp>['cache'];
  adminId: string;
  client: AuthClient;
  session: Session;
  movie: Movie;
  screen: Screen;
}

interface SetupOptions {
  role?: AdminRole;
  movies?: Movie[];
  screens?: Screen[];
  /** Showtimes of the main movie on the main screen, unless given. */
  showtimes?: (Partial<Showtime> & Pick<Showtime, 'startsAt'>)[];
  settings?: Setting[];
}

async function setup(options: SetupOptions = {}): Promise<Setup> {
  const admin = testAdmin({ email: EMAIL, passwordHash, role: options.role ?? 'EDITOR' });
  const movie = testMovie({
    slug: 'main-feature',
    title: 'Main Feature',
    durationMinutes: 120,
    status: 'NOW_SHOWING',
  });
  const screen = testScreen({ name: 'Screen 1' });
  const db = inMemoryAuthDb({
    admins: [admin],
    movies: [movie, ...(options.movies ?? [])],
    screens: [screen, ...(options.screens ?? [])],
    showtimes: (options.showtimes ?? []).map((seed) =>
      testShowtime({ movieId: movie.id, screenId: screen.id, ...seed }),
    ),
    settings: options.settings ?? [],
  });
  const { app, cache } = buildTestApp({ prisma: db.prisma });
  const client = await authClient(app);
  const login = await client.post('/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  expect(login.status).toBe(200);
  // Count only the calls the request under test makes (login has its own transaction).
  vi.clearAllMocks();
  return {
    app,
    db,
    cache,
    adminId: admin.id,
    client,
    session: sessionFrom(login),
    movie,
    screen,
  };
}

/** A browser-like POST to /showtimes{path} with the session (by default), CSRF and Origin. */
function post(s: Setup, path: string, options: SendOptions = {}) {
  const {
    body,
    cookies = [s.session.access],
    origin = ADMIN_ORIGIN,
    token = s.client.csrf.token,
  } = options;
  const all = [...(options.csrfCookie === false ? [] : [s.client.csrf.cookie]), ...cookies];
  let req = request(s.app)
    .post(`${ADMIN_BASE}/showtimes${path}`)
    .set('User-Agent', TEST_USER_AGENT);
  if (all.length > 0) req = req.set('Cookie', all.join('; '));
  if (origin !== null) req = req.set('Origin', origin);
  if (token !== null) req = req.set(CSRF_HEADER, token);
  if (body === undefined) return req;
  return typeof body === 'string'
    ? req.set('Content-Type', 'application/json').send(body)
    : req.send(body);
}

const validBody = (s: Setup, overrides: object = {}) => ({
  movieId: s.movie.id,
  screenId: s.screen.id,
  date: '2026-11-02',
  time: '19:00',
  ...overrides,
});

const createShowtime = (s: Setup, body: object | string, options: SendOptions = {}) =>
  post(s, '', { ...options, body });
const getShowtimes = (s: Setup, path: string, cookies = [s.session.access]) =>
  s.client.get(`/showtimes${path}`, cookies);

const showtimeAudits = (db: InMemoryAuthDb) =>
  db.auditLogs.filter((row) => row.entity === 'Showtime');

function expectOk(res: request.Response, status = 200): AdminShowtime {
  expect(res.status).toBe(status);
  expect(res.headers['cache-control']).toBe('no-store');
  return adminShowtimeResponseSchema.parse(res.body).showtime;
}

function expectError(res: request.Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers['cache-control']).toBe('no-store');
  const { error } = apiErrorSchema.parse(res.body);
  expect(error.code).toBe(code);
  return error;
}

type InvalidateSpy = MockInstance<MemoryCache['invalidatePrefix']>;

/** Nothing written by the request: no showtime, no audit row, no cache invalidation. */
function expectNothingWritten(s: Setup, invalidate: InvalidateSpy, before = 0) {
  expect(s.db.showtimes).toHaveLength(before);
  expect(showtimeAudits(s.db)).toEqual([]);
  expect(invalidate).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------
// Session, CSRF and roles
// ---------------------------------------------------------------------------

describe('POST /api/admin/showtimes: session and CSRF', () => {
  it('answers 401 without a session, before touching the database', async () => {
    const s = await setup();

    const res = await createShowtime(s, validBody(s), { cookies: [] });

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    expect(s.db.showtimes).toEqual([]);
  });

  it('answers 401 for an invalid session cookie, even with a bad body', async () => {
    const s = await setup();

    const res = await createShowtime(s, { foo: 1 }, { cookies: [`${s.session.access}x`] });

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
  });

  it.each([
    ['a missing CSRF token', { token: null }],
    ['a wrong CSRF token', { token: 'not-the-token' }],
    ['a missing CSRF cookie', { csrfCookie: false }],
    ['a missing Origin', { origin: null }],
    ['a foreign Origin', { origin: 'https://evil.example' }],
  ] as const)('answers 403 for %s, even with a session', async (_name, overrides) => {
    const s = await setup();

    const res = await createShowtime(s, validBody(s), overrides);

    expect(res.status).toBe(403);
    expect(res.body).toEqual(CSRF_BODY);
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    expect(s.db.showtimes).toEqual([]);
    expect(showtimeAudits(s.db)).toEqual([]);
  });

  it.each<AdminRole>(['EDITOR', 'SUPER_ADMIN'])('serves a %s', async (role) => {
    const s = await setup({ role });

    expectOk(await createShowtime(s, validBody(s)), 201);

    expect(showtimeAudits(s.db)).toEqual([
      expect.objectContaining({ adminId: s.adminId, userAgent: TEST_USER_AGENT }),
    ]);
  });

  it('answers 400 for query parameters', async () => {
    const s = await setup();

    const error = expectError(
      await post(s, '?x=1', { body: validBody(s) }),
      400,
      'VALIDATION_ERROR',
    );

    expect(error.details).toEqual([expect.objectContaining({ path: ['query'] })]);
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/showtimes and /:id: session and roles', () => {
  it.each(['', `/${randomUUID()}`])(
    'GET /showtimes%s answers 401 without a session',
    async (path) => {
      const s = await setup();

      const res = await getShowtimes(s, path, []);

      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED_BODY);
      expect(s.db.spies.showtime.findMany).not.toHaveBeenCalled();
      expect(s.db.spies.showtime.findUnique).not.toHaveBeenCalled();
    },
  );

  it.each<AdminRole>(['EDITOR', 'SUPER_ADMIN'])('serves a %s (list and get)', async (role) => {
    const s = await setup({ role, showtimes: [{ startsAt: colombo('2026-11-02', '19:00') }] });
    const id = s.db.showtimes[0]?.id ?? '';

    const list = await getShowtimes(s, '');
    expect(list.status).toBe(200);
    expect(adminShowtimeListResponseSchema.parse(list.body).items).toHaveLength(1);
    expect(expectOk(await getShowtimes(s, `/${id}`)).id).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/showtimes
// ---------------------------------------------------------------------------

describe('POST /api/admin/showtimes', () => {
  it('creates a showtime (201) at the Colombo date + time, audits it, then drops the public cache', async () => {
    const s = await setup();
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    const showtime = expectOk(
      await createShowtime(s, validBody(s, { date: '2026-11-02', time: '00:30' })),
      201,
    );

    expect(showtime).toMatchObject({
      movie: { id: s.movie.id, title: 'Main Feature', durationMinutes: 120, status: 'NOW_SHOWING' },
      screen: { id: s.screen.id, name: 'Screen 1' },
      startsAt: '2026-11-01T19:00:00.000Z',
      endsAt: '2026-11-01T21:00:00.000Z',
      colomboDate: '2026-11-02',
      time: '00:30',
      format: '2D',
      bookingUrlOverride: null,
      bookingUrl: `${DEFAULT_BMS_BASE_URL}/20261102`,
      deletedAt: null,
    });
    expect(s.db.showtimes.map((row) => row.startsAt.toISOString())).toEqual([
      '2026-11-01T19:00:00.000Z',
    ]);
    expect(s.db.locks).toEqual([
      { table: 'Movie', id: s.movie.id },
      { table: 'Screen', id: s.screen.id },
    ]);
    expect(showtimeAudits(s.db)).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        adminId: s.adminId,
        entityId: showtime.id,
        details: {
          movieId: s.movie.id,
          screenId: s.screen.id,
          startsAt: '2026-11-01T19:00:00.000Z',
          format: '2D',
          bookingUrlOverride: null,
        },
        userAgent: TEST_USER_AGENT,
      }),
    ]);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(PUBLIC_MOVIES_CACHE_PREFIX);
    const auditOrder = s.db.spies.auditLog.create.mock.invocationCallOrder.at(-1) ?? Infinity;
    expect(invalidate.mock.invocationCallOrder[0]).toBeGreaterThan(auditOrder);
  });

  it('normalises the format ("imax 3d" -> "IMAX 3D") and returns the override as the link', async () => {
    const s = await setup();

    const showtime = expectOk(
      await createShowtime(s, validBody(s, { format: 'imax 3d', bookingUrlOverride: OVERRIDE })),
      201,
    );

    expect(showtime).toMatchObject({
      format: 'IMAX 3D',
      bookingUrlOverride: OVERRIDE,
      bookingUrl: OVERRIDE,
    });
    expect(s.db.showtimes[0]).toMatchObject({ format: 'IMAX 3D', bookingUrlOverride: OVERRIDE });
  });

  describe('validation (400, nothing written)', () => {
    it.each([
      // Zod reports unknown keys on the object itself.
      ['an unknown key', { extra: 1 }, ['body']],
      ['an impossible date', { date: '2026-02-30' }, ['body', 'date']],
      ['24:00', { time: '24:00' }, ['body', 'time']],
      ['a time with seconds', { time: '19:00:00' }, ['body', 'time']],
      [
        'a non-BookMyShow override',
        { bookingUrlOverride: 'https://evil.example/buytickets/x' },
        ['body', 'bookingUrlOverride'],
      ],
      [
        'a BookMyShow URL outside /buytickets/',
        { bookingUrlOverride: 'https://lk.bookmyshow.com/other' },
        ['body', 'bookingUrlOverride'],
      ],
      ['an empty format', { format: '  ' }, ['body', 'format']],
      ['a bad movie id', { movieId: 'not-a-uuid' }, ['body', 'movieId']],
    ] as const)('rejects %s', async (_name, overrides, path) => {
      const s = await setup();
      const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

      const error = expectError(
        await createShowtime(s, validBody(s, overrides)),
        400,
        'VALIDATION_ERROR',
      );

      expect(error.details).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
      expect(s.db.spies.$transaction).not.toHaveBeenCalled();
      expectNothingWritten(s, invalidate);
    });

    it('rejects a missing field', async () => {
      const s = await setup();
      const { time: _time, ...rest } = validBody(s);

      const error = expectError(await createShowtime(s, rest), 400, 'VALIDATION_ERROR');

      expect(error.details).toEqual([expect.objectContaining({ path: ['body', 'time'] })]);
    });

    it('rejects a start in the past (by the app clock) on body.time', async () => {
      const s = await setup();
      const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

      const error = expectError(
        await createShowtime(s, validBody(s, { date: '2026-11-01', time: '15:30' })),
        400,
        'VALIDATION_ERROR',
      );

      expect(error).toEqual({
        code: 'VALIDATION_ERROR',
        message: SHOWTIME_IN_PAST_MESSAGE,
        details: [{ path: ['body', 'time'], message: SHOWTIME_IN_PAST_MESSAGE }],
      });
      expectNothingWritten(s, invalidate);
    });

    it('rejects malformed JSON', async () => {
      const s = await setup();
      // Parsed by the app-level JSON parser, before the admin router (and its no-store).
      const res = await createShowtime(s, '{"movieId":');
      expect(res.status).toBe(400);
      expect(apiErrorSchema.parse(res.body).error.code).toBe('INVALID_JSON');
      expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    });
  });

  it('answers 404 for an unknown movie or screen, on the field', async () => {
    const s = await setup();
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    expect(
      expectError(
        await createShowtime(s, validBody(s, { movieId: randomUUID() })),
        404,
        'NOT_FOUND',
      ),
    ).toEqual({
      code: 'NOT_FOUND',
      message: SHOWTIME_MOVIE_NOT_FOUND_MESSAGE,
      details: [{ path: ['body', 'movieId'], message: SHOWTIME_MOVIE_NOT_FOUND_MESSAGE }],
    });
    expect(
      expectError(
        await createShowtime(s, validBody(s, { screenId: randomUUID() })),
        404,
        'NOT_FOUND',
      ),
    ).toEqual({
      code: 'NOT_FOUND',
      message: SHOWTIME_SCREEN_NOT_FOUND_MESSAGE,
      details: [{ path: ['body', 'screenId'], message: SHOWTIME_SCREEN_NOT_FOUND_MESSAGE }],
    });
    expectNothingWritten(s, invalidate);
  });

  it('answers 409 for an ENDED movie and a hidden screen; allows an UPCOMING hidden movie', async () => {
    const ended = testMovie({ slug: 'ended', title: 'Ended', status: 'ENDED' });
    const upcoming = testMovie({
      slug: 'soon',
      title: 'Soon',
      status: 'UPCOMING',
      isActive: false,
    });
    const hidden = testScreen({ name: 'Screen 2', isActive: false });
    const s = await setup({ movies: [ended, upcoming], screens: [hidden] });

    expect(
      expectError(await createShowtime(s, validBody(s, { movieId: ended.id })), 409, 'CONFLICT'),
    ).toMatchObject({
      message: SHOWTIME_MOVIE_ENDED_MESSAGE,
      details: [{ path: ['body', 'movieId'] }],
    });
    expect(
      expectError(await createShowtime(s, validBody(s, { screenId: hidden.id })), 409, 'CONFLICT'),
    ).toMatchObject({
      message: SHOWTIME_SCREEN_INACTIVE_MESSAGE,
      details: [{ path: ['body', 'screenId'] }],
    });
    expect(s.db.showtimes).toEqual([]);

    expectOk(await createShowtime(s, validBody(s, { movieId: upcoming.id })), 201);
  });

  it('answers 409 with conflict details for an overlap on the same screen; nothing written', async () => {
    const s = await setup({
      settings: [testSetting('showGapMinutes', '30')],
      showtimes: [{ startsAt: colombo('2026-11-02', '19:00') }],
    });
    const existing = s.db.showtimes[0];
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    const res = await createShowtime(s, validBody(s, { time: '21:29' }));

    expect(res.status).toBe(409);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(showtimeConflictErrorSchema.parse(res.body)).toEqual({
      error: {
        code: 'CONFLICT',
        message: SHOWTIME_OVERLAP_MESSAGE,
        details: [
          {
            path: ['body', 'time'],
            message:
              'Overlaps "Main Feature" (19:00–21:00), counting the 30-minute gap between shows',
            requested: { date: '2026-11-02', time: '21:29' },
            conflict: {
              showtimeId: existing?.id,
              movieTitle: 'Main Feature',
              startsAt: '2026-11-02T13:30:00.000Z',
              endsAt: '2026-11-02T15:30:00.000Z',
            },
          },
        ],
      },
    });
    expectNothingWritten(s, invalidate, 1);

    // Touching (end + gap == start) is allowed.
    expectOk(await createShowtime(s, validBody(s, { time: '21:30' })), 201);
  });

  it('answers a generic 500 and writes nothing when the audit write fails', async () => {
    const s = await setup();
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');
    s.db.injectFault('auditLog', 'create', { error: new Error('db exploded at 10.0.0.5') });

    const res = await createShowtime(s, validBody(s));

    expect(res.status).toBe(500);
    expect(res.body).toEqual(INTERNAL_BODY);
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
    expectNothingWritten(s, invalidate);
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/showtimes
// ---------------------------------------------------------------------------

describe('GET /api/admin/showtimes', () => {
  async function seeded() {
    return setup({
      showtimes: [
        { startsAt: colombo('2026-11-01', '14:30') }, // past
        { startsAt: colombo('2026-11-02', '00:30'), format: '2d' },
        { startsAt: colombo('2026-11-02', '19:00'), deletedAt: DELETED_AT },
        { startsAt: colombo('2026-11-03', '10:00') },
      ],
    });
  }

  it('defaults to live, future showtimes in start order (no-store, strict shape)', async () => {
    const s = await seeded();

    const res = await getShowtimes(s, '');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const page = adminShowtimeListResponseSchema.parse(res.body);
    expect(page.items.map((item) => item.startsAt)).toEqual([
      '2026-11-01T19:00:00.000Z',
      '2026-11-03T04:30:00.000Z',
    ]);
    expect(page.items[0]).toMatchObject({ colomboDate: '2026-11-02', time: '00:30', format: '2D' });
    expect(page).toMatchObject({ page: 1, pageSize: 20, total: 2 });
    expect(s.db.spies.setting.findMany).toHaveBeenCalledTimes(1);
  });

  it('parses the query: includePast, deleted, from / to (Colombo days), paging', async () => {
    const s = await seeded();

    const all = adminShowtimeListResponseSchema.parse(
      (await getShowtimes(s, '?includePast=true&deleted=include')).body,
    );
    expect(all.total).toBe(4);

    const nov2 = adminShowtimeListResponseSchema.parse(
      (await getShowtimes(s, '?from=2026-11-02&to=2026-11-02&deleted=include')).body,
    );
    expect(nov2.items.map((item) => item.colomboDate)).toEqual(['2026-11-02', '2026-11-02']);

    const paged = adminShowtimeListResponseSchema.parse(
      (await getShowtimes(s, '?includePast=true&pageSize=1&page=2')).body,
    );
    expect(paged).toMatchObject({ page: 2, pageSize: 1, total: 3 });
    expect(paged.items.map((item) => item.time)).toEqual(['00:30']);

    const byScreen = adminShowtimeListResponseSchema.parse(
      (await getShowtimes(s, `?screenId=${randomUUID()}`)).body,
    );
    expect(byScreen).toMatchObject({ items: [], total: 0 });
  });

  it.each([
    ['an unknown key', '?x=1', ['query']],
    ['includePast=yes', '?includePast=yes', ['query', 'includePast']],
    ['a bad date', '?from=2026-02-30', ['query', 'from']],
    ['to before from', '?from=2026-11-03&to=2026-11-02', ['query', 'to']],
    ['a bad movie id', '?movieId=abc', ['query', 'movieId']],
    ['pageSize 101', '?pageSize=101', ['query', 'pageSize']],
  ] as const)('answers 400 for %s', async (_name, query, path) => {
    const s = await setup();

    const error = expectError(await getShowtimes(s, query), 400, 'VALIDATION_ERROR');

    expect(error.details).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
    expect(s.db.spies.showtime.findMany).not.toHaveBeenCalled();
  });

  it('answers a generic 500 when the database fails', async () => {
    const s = await setup();
    s.db.injectFault('showtime', 'findMany', { error: new Error('connection reset by 10.0.0.5') });

    const res = await getShowtimes(s, '');

    expect(res.status).toBe(500);
    expect(res.body).toEqual(INTERNAL_BODY);
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/showtimes/:id
// ---------------------------------------------------------------------------

describe('GET /api/admin/showtimes/:id', () => {
  it('returns a showtime, past or soft-deleted too', async () => {
    const s = await setup({
      showtimes: [
        { startsAt: colombo('2026-10-01', '19:00') },
        { startsAt: colombo('2026-11-05', '19:00'), deletedAt: DELETED_AT },
      ],
    });
    for (const row of s.db.showtimes) {
      const showtime = expectOk(await getShowtimes(s, `/${row.id}`));
      expect(showtime).toMatchObject({
        id: row.id,
        startsAt: row.startsAt.toISOString(),
        deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
      });
    }
  });

  it('answers 404 for an unknown id', async () => {
    const s = await setup();
    expect(expectError(await getShowtimes(s, `/${randomUUID()}`), 404, 'NOT_FOUND')).toEqual({
      code: 'NOT_FOUND',
      message: SHOWTIME_NOT_FOUND_MESSAGE,
    });
  });

  it('answers 400 for a bad id or query parameters', async () => {
    const s = await setup({ showtimes: [{ startsAt: colombo('2026-11-02', '19:00') }] });
    const id = s.db.showtimes[0]?.id ?? '';

    const badId = expectError(await getShowtimes(s, '/not-a-uuid'), 400, 'VALIDATION_ERROR');
    expect(badId.details).toEqual([expect.objectContaining({ path: ['params', 'id'] })]);
    const query = expectError(await getShowtimes(s, `/${id}?x=1`), 400, 'VALIDATION_ERROR');
    expect(query.details).toEqual([expect.objectContaining({ path: ['query'] })]);
    expect(s.db.spies.showtime.findUnique).not.toHaveBeenCalled();
  });

  it('answers a generic 500 when the database fails', async () => {
    const s = await setup();
    s.db.injectFault('showtime', 'findUnique', { error: new Error('timeout') });

    const res = await getShowtimes(s, `/${randomUUID()}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual(INTERNAL_BODY);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle through the API
// ---------------------------------------------------------------------------

describe('showtime create -> get -> list', () => {
  it('a created showtime is readable straight away and blocks an overlapping one', async () => {
    const s = await setup();

    const created = expectOk(await createShowtime(s, validBody(s)), 201);
    expect(expectOk(await getShowtimes(s, `/${created.id}`))).toEqual(created);
    const page = adminShowtimeListResponseSchema.parse((await getShowtimes(s, '')).body);
    expect(page.items).toEqual([created]);

    expectError(await createShowtime(s, validBody(s, { time: '20:00' })), 409, 'CONFLICT');
    expect(s.db.showtimes).toHaveLength(1);
    expect(showtimeAudits(s.db)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/showtimes/bulk
// ---------------------------------------------------------------------------

const validBulkBody = (s: Setup, overrides: object = {}) => ({
  movieId: s.movie.id,
  screenId: s.screen.id,
  dateFrom: '2026-11-02',
  dateTo: '2026-11-08',
  times: ['18:00', '10:00', '14:00'],
  ...overrides,
});

const bulkCreate = (s: Setup, body: object | string, options: SendOptions = {}) =>
  post(s, '/bulk', { ...options, body });

function expectBulkOk(res: request.Response) {
  expect(res.status).toBe(201);
  expect(res.headers['cache-control']).toBe('no-store');
  return showtimeBulkCreateResponseSchema.parse(res.body);
}

describe('POST /api/admin/showtimes/bulk: session, CSRF and roles', () => {
  it('answers 401 without a session, before touching the database', async () => {
    const s = await setup();

    const res = await bulkCreate(s, validBulkBody(s), { cookies: [] });

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    expect(s.db.showtimes).toEqual([]);
  });

  it.each([
    ['a missing CSRF token', { token: null }],
    ['a wrong CSRF token', { token: 'not-the-token' }],
    ['a foreign Origin', { origin: 'https://evil.example' }],
  ] as const)('answers 403 for %s, even with a session', async (_name, overrides) => {
    const s = await setup();

    const res = await bulkCreate(s, validBulkBody(s), overrides);

    expect(res.status).toBe(403);
    expect(res.body).toEqual(CSRF_BODY);
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    expect(s.db.showtimes).toEqual([]);
    expect(showtimeAudits(s.db)).toEqual([]);
  });

  it.each<AdminRole>(['EDITOR', 'SUPER_ADMIN'])('serves a %s', async (role) => {
    const s = await setup({ role });

    expect(
      expectBulkOk(await bulkCreate(s, validBulkBody(s, { dateTo: '2026-11-02' }))).created,
    ).toBe(3);

    expect(showtimeAudits(s.db)).toEqual(
      Array(3).fill(expect.objectContaining({ adminId: s.adminId, userAgent: TEST_USER_AGENT })),
    );
  });
});

describe('POST /api/admin/showtimes/bulk', () => {
  it('creates 7 days x 3 times (201): sorted items, 21 audits in one batch, then drops the public cache', async () => {
    const s = await setup();
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    const result = expectBulkOk(await bulkCreate(s, validBulkBody(s)));

    expect(result.created).toBe(21);
    const starts = result.items.map((item) => item.startsAt);
    expect(starts).toEqual([...starts].sort());
    expect(s.db.showtimes).toHaveLength(21);
    expect(s.db.locks).toEqual([
      { table: 'Movie', id: s.movie.id },
      { table: 'Screen', id: s.screen.id },
    ]);
    const audits = showtimeAudits(s.db);
    expect(audits).toHaveLength(21);
    expect(new Set(audits.map((row) => row.entityId))).toEqual(
      new Set(result.items.map((item) => item.id)),
    );
    const batchIds = new Set(
      audits.map((row) => (row.details as Record<string, unknown>)['batchId']),
    );
    expect(batchIds.size).toBe(1);
    expect(audits[0]).toMatchObject({ action: 'CREATE', adminId: s.adminId, entity: 'Showtime' });
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(PUBLIC_MOVIES_CACHE_PREFIX);
    const auditOrder = s.db.spies.auditLog.createMany.mock.invocationCallOrder[0] ?? Infinity;
    expect(invalidate.mock.invocationCallOrder[0]).toBeGreaterThan(auditOrder);
  });

  it('00:30 is the UTC instant of the evening before; "imax 3d" is stored as "IMAX 3D"', async () => {
    const s = await setup();

    const { items } = expectBulkOk(
      await bulkCreate(
        s,
        validBulkBody(s, { dateTo: '2026-11-02', times: ['00:30'], format: 'imax 3d' }),
      ),
    );

    expect(items).toEqual([
      expect.objectContaining({
        startsAt: '2026-11-01T19:00:00.000Z',
        colomboDate: '2026-11-02',
        time: '00:30',
        format: 'IMAX 3D',
        bookingUrl: `${DEFAULT_BMS_BASE_URL}/20261102`,
      }),
    ]);
    expect(s.db.showtimes[0]).toMatchObject({ format: 'IMAX 3D', bookingUrlOverride: null });
  });

  describe('validation (400, nothing written)', () => {
    it.each([
      ['more than 31 days', { dateFrom: '2026-11-02', dateTo: '2026-12-03' }, ['body', 'dateTo']],
      [
        'dateTo before dateFrom',
        { dateFrom: '2026-11-05', dateTo: '2026-11-04' },
        ['body', 'dateTo'],
      ],
      [
        '13 times',
        { times: Array.from({ length: 13 }, (_, i) => `${String(i + 10)}:00`) },
        ['body', 'times'],
      ],
      ['duplicate times', { times: ['10:00', '14:00', '10:00'] }, ['body', 'times', 2]],
      ['no times', { times: [] }, ['body', 'times']],
      ['a bad time', { times: ['10:00', '24:00'] }, ['body', 'times', 1]],
      ['a booking URL override', { bookingUrlOverride: OVERRIDE }, ['body']],
      ['an unknown key', { extra: 1 }, ['body']],
      ['an impossible date', { dateFrom: '2026-02-30' }, ['body', 'dateFrom']],
      ['a bad screen id', { screenId: 'nope' }, ['body', 'screenId']],
    ] as const)('rejects %s', async (_name, overrides, path) => {
      const s = await setup();
      const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

      const error = expectError(
        await bulkCreate(s, validBulkBody(s, overrides)),
        400,
        'VALIDATION_ERROR',
      );

      expect(error.details).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
      expect(s.db.spies.$transaction).not.toHaveBeenCalled();
      expectNothingWritten(s, invalidate);
    });

    it('rejects query parameters', async () => {
      const s = await setup();

      const error = expectError(
        await post(s, '/bulk?dryRun=true', { body: validBulkBody(s) }),
        400,
        'VALIDATION_ERROR',
      );

      expect(error.details).toEqual([expect.objectContaining({ path: ['query'] })]);
      expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    });

    it('rejects slots in the past (by the app clock), listing each one', async () => {
      const s = await setup();
      const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

      const res = await bulkCreate(
        s,
        validBulkBody(s, { dateFrom: '2026-11-01', times: ['20:00', '09:00'] }),
      );

      expect(res.status).toBe(400);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(showtimePastSlotErrorSchema.parse(res.body)).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: showtimeBulkPastMessage(1),
          details: [
            {
              path: ['body', 'times', 1],
              message: SHOWTIME_SLOT_IN_PAST_MESSAGE,
              requested: { date: '2026-11-01', time: '09:00' },
            },
          ],
        },
      });
      expect(s.db.spies.$transaction).not.toHaveBeenCalled();
      expectNothingWritten(s, invalidate);
    });
  });

  it('answers 404 for an unknown movie or screen and 409 for an ENDED movie or a hidden screen', async () => {
    const ended = testMovie({ slug: 'ended', title: 'Ended', status: 'ENDED' });
    const hidden = testScreen({ name: 'Screen 2', isActive: false });
    const s = await setup({ movies: [ended], screens: [hidden] });
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    expect(
      expectError(
        await bulkCreate(s, validBulkBody(s, { movieId: randomUUID() })),
        404,
        'NOT_FOUND',
      ),
    ).toEqual({
      code: 'NOT_FOUND',
      message: SHOWTIME_MOVIE_NOT_FOUND_MESSAGE,
      details: [{ path: ['body', 'movieId'], message: SHOWTIME_MOVIE_NOT_FOUND_MESSAGE }],
    });
    expect(
      expectError(
        await bulkCreate(s, validBulkBody(s, { screenId: randomUUID() })),
        404,
        'NOT_FOUND',
      ),
    ).toMatchObject({ message: SHOWTIME_SCREEN_NOT_FOUND_MESSAGE });
    expect(
      expectError(await bulkCreate(s, validBulkBody(s, { movieId: ended.id })), 409, 'CONFLICT'),
    ).toMatchObject({
      message: SHOWTIME_MOVIE_ENDED_MESSAGE,
      details: [{ path: ['body', 'movieId'] }],
    });
    expect(
      expectError(await bulkCreate(s, validBulkBody(s, { screenId: hidden.id })), 409, 'CONFLICT'),
    ).toMatchObject({
      message: SHOWTIME_SCREEN_INACTIVE_MESSAGE,
      details: [{ path: ['body', 'screenId'] }],
    });
    expectNothingWritten(s, invalidate);
  });

  it('answers 409 with conflict details (saved and in-batch); nothing written', async () => {
    const s = await setup({ showtimes: [{ startsAt: colombo('2026-11-02', '15:00') }] });
    const existing = s.db.showtimes[0];
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    const res = await bulkCreate(
      s,
      validBulkBody(s, { dateTo: '2026-11-02', times: ['14:00', '21:00', '22:00'] }),
    );

    expect(res.status).toBe(409);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(showtimeConflictErrorSchema.parse(res.body)).toEqual({
      error: {
        code: 'CONFLICT',
        message: '2 of the requested showtimes overlap other showtimes on this screen',
        details: [
          {
            path: ['body', 'times', 0],
            message:
              'Overlaps "Main Feature" (15:00–17:00), counting the 15-minute gap between shows',
            requested: { date: '2026-11-02', time: '14:00' },
            conflict: {
              showtimeId: existing?.id,
              movieTitle: 'Main Feature',
              startsAt: '2026-11-02T09:30:00.000Z',
              endsAt: '2026-11-02T11:30:00.000Z',
            },
          },
          {
            path: ['body', 'times', 2],
            message:
              'Overlaps another showtime in this request: "Main Feature" (21:00–23:00), counting the 15-minute gap between shows',
            requested: { date: '2026-11-02', time: '22:00' },
            conflict: {
              showtimeId: null,
              movieTitle: 'Main Feature',
              startsAt: '2026-11-02T15:30:00.000Z',
              endsAt: '2026-11-02T17:30:00.000Z',
            },
          },
        ],
      },
    });
    expectNothingWritten(s, invalidate, 1);
  });

  it.each([
    ['the showtime insert', 'showtime', 'createMany'],
    ['the audit insert', 'auditLog', 'createMany'],
  ] as const)(
    'answers a generic 500 and writes nothing when %s fails',
    async (_name, model, operation) => {
      const s = await setup();
      const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');
      s.db.injectFault(model, operation, { error: new Error('db exploded at 10.0.0.5') });

      const res = await bulkCreate(s, validBulkBody(s));

      expect(res.status).toBe(500);
      expect(res.body).toEqual(INTERNAL_BODY);
      expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
      expectNothingWritten(s, invalidate);
    },
  );

  it('bulk-created showtimes are listed straight away and block an overlapping single create', async () => {
    const s = await setup();

    const { items } = expectBulkOk(await bulkCreate(s, validBulkBody(s, { dateTo: '2026-11-03' })));

    const page = adminShowtimeListResponseSchema.parse((await getShowtimes(s, '')).body);
    expect(page.items).toEqual(items);
    expectError(await createShowtime(s, validBody(s, { time: '11:00' })), 409, 'CONFLICT');
    expect(s.db.showtimes).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// T12: PATCH /:id, DELETE /:id, POST /bulk-delete
// ---------------------------------------------------------------------------

/** A browser-like PATCH, DELETE or POST to /showtimes{path} (session, CSRF and Origin by default). */
function send(
  s: Setup,
  method: 'post' | 'patch' | 'delete',
  path: string,
  options: SendOptions = {},
) {
  const {
    body,
    cookies = [s.session.access],
    origin = ADMIN_ORIGIN,
    token = s.client.csrf.token,
  } = options;
  const all = [...(options.csrfCookie === false ? [] : [s.client.csrf.cookie]), ...cookies];
  let req = request(s.app)
    [method](`${ADMIN_BASE}/showtimes${path}`)
    .set('User-Agent', TEST_USER_AGENT);
  if (all.length > 0) req = req.set('Cookie', all.join('; '));
  if (origin !== null) req = req.set('Origin', origin);
  if (token !== null) req = req.set(CSRF_HEADER, token);
  if (body === undefined) return req;
  return typeof body === 'string'
    ? req.set('Content-Type', 'application/json').send(body)
    : req.send(body);
}

const patchShowtime = (s: Setup, id: string, body: object | string) =>
  send(s, 'patch', `/${id}`, { body });
const deleteShowtime = (s: Setup, id: string, options: SendOptions = {}) =>
  send(s, 'delete', `/${id}`, options);
const bulkDeleteShowtimes = (s: Setup, body: object | string) =>
  send(s, 'post', '/bulk-delete', { body });

/** The seeded show of setupWithShow: 2026-11-02 19:00 Colombo, main movie, Screen 1. */
const SHOW_START = colombo('2026-11-02', '19:00');

async function setupWithShow(options: SetupOptions = {}) {
  const s = await setup({
    ...options,
    showtimes: [{ startsAt: SHOW_START }, ...(options.showtimes ?? [])],
  });
  const show = s.db.showtimes[0];
  if (!show) throw new Error('no seeded showtime');
  return { ...s, show };
}

const storedShowtime = (s: Setup, id: string) =>
  structuredClone(s.db.showtimes.find((row) => row.id === id));

/** The public cache was dropped exactly once, after the request's last audit write. */
function expectInvalidatedAfterAudit(
  s: Setup,
  invalidate: InvalidateSpy,
  method: 'create' | 'createMany' = 'create',
) {
  expect(invalidate).toHaveBeenCalledExactlyOnceWith(PUBLIC_MOVIES_CACHE_PREFIX);
  const auditOrder = s.db.spies.auditLog[method].mock.invocationCallOrder.at(-1) ?? Infinity;
  expect(invalidate.mock.invocationCallOrder[0]).toBeGreaterThan(auditOrder);
}

interface UnsafeEndpoint {
  name: string;
  method: 'post' | 'patch' | 'delete';
  path: (id: string) => string;
  body?: (id: string) => object;
}

const T12_ENDPOINTS: UnsafeEndpoint[] = [
  {
    name: 'PATCH /showtimes/:id',
    method: 'patch',
    path: (id) => `/${id}`,
    body: () => ({ date: '2026-11-02', time: '21:30' }),
  },
  { name: 'DELETE /showtimes/:id', method: 'delete', path: (id) => `/${id}` },
  {
    name: 'POST /showtimes/bulk-delete',
    method: 'post',
    path: () => '/bulk-delete',
    body: (id) => ({ ids: [id] }),
  },
];

describe.each(T12_ENDPOINTS)('$name: session, CSRF and roles', ({ method, path, body }) => {
  const withBody = (id: string): SendOptions => (body === undefined ? {} : { body: body(id) });

  it('answers 401 without a session, before touching the database', async () => {
    const s = await setupWithShow();
    const before = storedShowtime(s, s.show.id);

    const res = await send(s, method, path(s.show.id), { ...withBody(s.show.id), cookies: [] });

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
    expect(s.db.spies.showtime.findUnique).not.toHaveBeenCalled();
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    expect(storedShowtime(s, s.show.id)).toEqual(before);
  });

  it('answers 401 for an invalid session cookie, even with a bad body and id', async () => {
    const s = await setupWithShow();

    const res = await send(s, method, path('not-a-uuid'), {
      body: { foo: 1 },
      cookies: [`${s.session.access}x`],
    });

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
  });

  it.each([
    ['a missing CSRF token', { token: null }],
    ['a wrong CSRF token', { token: 'not-the-token' }],
    ['a missing CSRF cookie', { csrfCookie: false }],
    ['a missing Origin', { origin: null }],
    ['a foreign Origin', { origin: 'https://evil.example' }],
  ] as const)('answers 403 for %s, even with a session', async (_name, overrides) => {
    const s = await setupWithShow();
    const before = storedShowtime(s, s.show.id);

    const res = await send(s, method, path(s.show.id), {
      ...withBody(s.show.id),
      ...overrides,
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual(CSRF_BODY);
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    expect(storedShowtime(s, s.show.id)).toEqual(before);
    expect(showtimeAudits(s.db)).toEqual([]);
  });

  it.each<AdminRole>(['EDITOR', 'SUPER_ADMIN'])('serves a %s', async (role) => {
    const s = await setupWithShow({ role });

    const res = await send(s, method, path(s.show.id), withBody(s.show.id));

    expect(res.status).toBe(200);
    expect(showtimeAudits(s.db)).toEqual([
      expect.objectContaining({ adminId: s.adminId, userAgent: TEST_USER_AGENT }),
    ]);
  });

  it('answers 400 for query parameters', async () => {
    const s = await setupWithShow();

    const error = expectError(
      await send(s, method, `${path(s.show.id)}?x=1`, withBody(s.show.id)),
      400,
      'VALIDATION_ERROR',
    );

    expect(error.details).toEqual([expect.objectContaining({ path: ['query'] })]);
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/admin/showtimes/:id', () => {
  it('moves the start (200): strict shape, UPDATE audit with changes, then drops the public cache', async () => {
    const s = await setupWithShow();
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    const showtime = expectOk(
      await patchShowtime(s, s.show.id, { date: '2026-11-03', time: '00:30' }),
    );

    expect(showtime).toMatchObject({
      id: s.show.id,
      startsAt: '2026-11-02T19:00:00.000Z',
      colomboDate: '2026-11-03',
      time: '00:30',
      bookingUrl: `${DEFAULT_BMS_BASE_URL}/20261103`,
    });
    expect(s.db.locks).toEqual([
      { table: 'Movie', id: s.movie.id },
      { table: 'Screen', id: s.screen.id },
    ]);
    expect(showtimeAudits(s.db)).toEqual([
      expect.objectContaining({
        action: 'UPDATE',
        adminId: s.adminId,
        entityId: s.show.id,
        details: {
          changes: {
            startsAt: { from: '2026-11-02T13:30:00.000Z', to: '2026-11-02T19:00:00.000Z' },
          },
        },
        userAgent: TEST_USER_AGENT,
      }),
    ]);
    expectInvalidatedAfterAudit(s, invalidate);
  });

  it('moves to another screen, normalises the format and sets / clears the override', async () => {
    const screen2 = testScreen({ name: 'Screen 2' });
    const s = await setupWithShow({ screens: [screen2] });

    const moved = expectOk(
      await patchShowtime(s, s.show.id, {
        screenId: screen2.id,
        format: ' imax 3d ',
        bookingUrlOverride: OVERRIDE,
      }),
    );
    expect(moved).toMatchObject({
      screen: { id: screen2.id, name: 'Screen 2' },
      format: 'IMAX 3D',
      bookingUrlOverride: OVERRIDE,
      bookingUrl: OVERRIDE,
    });

    const cleared = expectOk(await patchShowtime(s, s.show.id, { bookingUrlOverride: null }));
    expect(cleared).toMatchObject({
      bookingUrlOverride: null,
      bookingUrl: `${DEFAULT_BMS_BASE_URL}/20261102`,
    });
  });

  it('a no-op answers 200 with the showtime, without an audit row or invalidation', async () => {
    const s = await setupWithShow();
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    const showtime = expectOk(
      await patchShowtime(s, s.show.id, { date: '2026-11-02', time: '19:00', format: '2d' }),
    );

    expect(showtime).toMatchObject({ id: s.show.id, time: '19:00', format: '2D' });
    expect(showtimeAudits(s.db)).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
  });

  describe('validation (400, nothing written)', () => {
    it.each([
      ['an empty body', {}, ['body']],
      ['a date without a time', { date: '2026-11-03' }, ['body', 'time']],
      ['a time without a date', { time: '10:00' }, ['body', 'date']],
      ['a movieId', { movieId: randomUUID() }, ['body']],
      ['an unknown key', { extra: 1, format: '3D' }, ['body']],
      [
        'a non-BookMyShow override',
        { bookingUrlOverride: 'https://evil.example/buytickets/x' },
        ['body', 'bookingUrlOverride'],
      ],
      ['an empty format', { format: '  ' }, ['body', 'format']],
      ['a bad screenId', { screenId: 'screen-1' }, ['body', 'screenId']],
      ['24:00', { date: '2026-11-03', time: '24:00' }, ['body', 'time']],
    ] as const)('rejects %s', async (_name, body, path) => {
      const s = await setupWithShow();
      const before = storedShowtime(s, s.show.id);

      const error = expectError(await patchShowtime(s, s.show.id, body), 400, 'VALIDATION_ERROR');

      expect(error.details).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
      expect(s.db.spies.$transaction).not.toHaveBeenCalled();
      expect(storedShowtime(s, s.show.id)).toEqual(before);
    });

    it('rejects a bad id', async () => {
      const s = await setupWithShow();

      const error = expectError(
        await patchShowtime(s, 'not-a-uuid', { format: '3D' }),
        400,
        'VALIDATION_ERROR',
      );

      expect(error.details).toEqual([expect.objectContaining({ path: ['params', 'id'] })]);
    });

    it('rejects a new start in the past (by the app clock) on body.time', async () => {
      const s = await setupWithShow();
      const before = storedShowtime(s, s.show.id);

      const error = expectError(
        await patchShowtime(s, s.show.id, { date: '2026-11-01', time: '15:30' }),
        400,
        'VALIDATION_ERROR',
      );

      expect(error).toEqual({
        code: 'VALIDATION_ERROR',
        message: SHOWTIME_IN_PAST_MESSAGE,
        details: [{ path: ['body', 'time'], message: SHOWTIME_IN_PAST_MESSAGE }],
      });
      expect(storedShowtime(s, s.show.id)).toEqual(before);
    });
  });

  it('answers 404 for an unknown showtime and 409 for a deleted or started one', async () => {
    const s = await setupWithShow({
      showtimes: [
        { startsAt: colombo('2026-11-05', '19:00'), deletedAt: DELETED_AT },
        { startsAt: colombo('2026-11-01', '14:00') },
      ],
    });
    const [, deleted, started] = s.db.showtimes;

    expect(
      expectError(await patchShowtime(s, randomUUID(), { format: '3D' }), 404, 'NOT_FOUND'),
    ).toEqual({ code: 'NOT_FOUND', message: SHOWTIME_NOT_FOUND_MESSAGE });
    expect(
      expectError(await patchShowtime(s, deleted?.id ?? '', { format: '3D' }), 409, 'CONFLICT'),
    ).toEqual({ code: 'CONFLICT', message: SHOWTIME_DELETED_MESSAGE });
    expect(
      expectError(await patchShowtime(s, started?.id ?? '', { format: '3D' }), 409, 'CONFLICT'),
    ).toEqual({ code: 'CONFLICT', message: SHOWTIME_STARTED_MESSAGE });
    expect(showtimeAudits(s.db)).toEqual([]);
  });

  it('answers 409 for a hidden target screen (on body.screenId) and for moving an ENDED movie', async () => {
    const hidden = testScreen({ name: 'Hidden', isActive: false });
    const s = await setupWithShow({ screens: [hidden] });

    expect(
      expectError(await patchShowtime(s, s.show.id, { screenId: hidden.id }), 409, 'CONFLICT'),
    ).toEqual({
      code: 'CONFLICT',
      message: SHOWTIME_MOVE_SCREEN_INACTIVE_MESSAGE,
      details: [{ path: ['body', 'screenId'], message: SHOWTIME_MOVE_SCREEN_INACTIVE_MESSAGE }],
    });

    const movie = s.db.movies.find((row) => row.id === s.movie.id);
    if (movie) movie.status = 'ENDED';
    expect(
      expectError(
        await patchShowtime(s, s.show.id, { date: '2026-11-02', time: '20:00' }),
        409,
        'CONFLICT',
      ),
    ).toEqual({ code: 'CONFLICT', message: SHOWTIME_MOVE_MOVIE_ENDED_MESSAGE });
    // A format-only edit is still allowed.
    expect(expectOk(await patchShowtime(s, s.show.id, { format: '3D' })).format).toBe('3D');
  });

  it('answers 409 with conflict details when the move overlaps a neighbour; nothing written', async () => {
    const s = await setupWithShow({
      settings: [testSetting('showGapMinutes', '30')],
      showtimes: [{ startsAt: colombo('2026-11-02', '23:00') }],
    });
    const neighbour = s.db.showtimes[1];
    const before = storedShowtime(s, s.show.id);
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    const res = await patchShowtime(s, s.show.id, { date: '2026-11-02', time: '20:31' });

    expect(res.status).toBe(409);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(showtimeConflictErrorSchema.parse(res.body)).toEqual({
      error: {
        code: 'CONFLICT',
        message: SHOWTIME_OVERLAP_MESSAGE,
        details: [
          {
            path: ['body', 'time'],
            message:
              'Overlaps "Main Feature" (23:00–01:00), counting the 30-minute gap between shows',
            requested: { date: '2026-11-02', time: '20:31' },
            conflict: {
              showtimeId: neighbour?.id,
              movieTitle: 'Main Feature',
              startsAt: '2026-11-02T17:30:00.000Z',
              endsAt: '2026-11-02T19:30:00.000Z',
            },
          },
        ],
      },
    });
    expect(storedShowtime(s, s.show.id)).toEqual(before);
    expect(showtimeAudits(s.db)).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();

    // Touching (end + gap == the neighbour's start) is allowed.
    expectOk(await patchShowtime(s, s.show.id, { date: '2026-11-02', time: '20:30' }));
  });

  it('answers a generic 500 and changes nothing when the audit write fails', async () => {
    const s = await setupWithShow();
    const before = storedShowtime(s, s.show.id);
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');
    s.db.injectFault('auditLog', 'create', { error: new Error('db exploded at 10.0.0.5') });

    const res = await patchShowtime(s, s.show.id, { format: '3D' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual(INTERNAL_BODY);
    expect(storedShowtime(s, s.show.id)).toEqual(before);
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/admin/showtimes/:id', () => {
  it('soft-deletes (200): the showtime with deletedAt, DELETE audit, then drops the public cache', async () => {
    const s = await setupWithShow();
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    const showtime = expectOk(await deleteShowtime(s, s.show.id));

    expect(showtime).toMatchObject({ id: s.show.id, deletedAt: NOW.toISOString() });
    expect(storedShowtime(s, s.show.id)?.deletedAt).toEqual(NOW);
    expect(showtimeAudits(s.db)).toEqual([
      expect.objectContaining({
        action: 'DELETE',
        adminId: s.adminId,
        entityId: s.show.id,
        details: { mode: 'soft' },
        userAgent: TEST_USER_AGENT,
      }),
    ]);
    expectInvalidatedAfterAudit(s, invalidate);
    // Gone from the default list; still readable by id.
    const page = adminShowtimeListResponseSchema.parse((await getShowtimes(s, '')).body);
    expect(page.items).toEqual([]);
    expect(expectOk(await getShowtimes(s, `/${s.show.id}`)).deletedAt).toBe(NOW.toISOString());
  });

  it('deletes a past show (D8)', async () => {
    const s = await setup({ showtimes: [{ startsAt: colombo('2026-10-01', '19:00') }] });
    const id = s.db.showtimes[0]?.id ?? '';

    expect(expectOk(await deleteShowtime(s, id)).deletedAt).toBe(NOW.toISOString());
  });

  it('answers 409 when already deleted and 404 when unknown; nothing written', async () => {
    const s = await setup({
      showtimes: [{ startsAt: SHOW_START, deletedAt: DELETED_AT }],
    });
    const id = s.db.showtimes[0]?.id ?? '';
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    expect(expectError(await deleteShowtime(s, id), 409, 'CONFLICT')).toEqual({
      code: 'CONFLICT',
      message: SHOWTIME_ALREADY_DELETED_MESSAGE,
    });
    expect(expectError(await deleteShowtime(s, randomUUID()), 404, 'NOT_FOUND')).toEqual({
      code: 'NOT_FOUND',
      message: SHOWTIME_NOT_FOUND_MESSAGE,
    });
    expectNothingWritten(s, invalidate, 1);
  });

  it('answers 400 for a body or a bad id', async () => {
    const s = await setupWithShow();

    const withBody = expectError(
      await deleteShowtime(s, s.show.id, { body: { force: true } }),
      400,
      'VALIDATION_ERROR',
    );
    expect(withBody.details).toEqual([expect.objectContaining({ path: ['body'] })]);
    expectError(await deleteShowtime(s, 'not-a-uuid'), 400, 'VALIDATION_ERROR');
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/showtimes/bulk-delete', () => {
  async function setupThree() {
    return setup({
      showtimes: [
        { startsAt: colombo('2026-10-20', '19:00') },
        { startsAt: colombo('2026-11-02', '19:00') },
        { startsAt: colombo('2026-11-03', '19:00') },
      ],
    });
  }

  it('soft-deletes 3 showtimes (200 { deleted: 3 }): 3 audits in one batch, the cache dropped once', async () => {
    const s = await setupThree();
    const ids = s.db.showtimes.map((row) => row.id);
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    const res = await bulkDeleteShowtimes(s, { ids });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(showtimeBulkDeleteResponseSchema.parse(res.body)).toEqual({ deleted: 3 });
    expect(s.db.showtimes.every((row) => row.deletedAt?.getTime() === NOW.getTime())).toBe(true);
    const audits = showtimeAudits(s.db);
    expect(audits.map((row) => row.entityId)).toEqual(ids);
    const batchIds = new Set(
      audits.map((row) => (row.details as { batchId?: unknown } | null)?.batchId),
    );
    expect(batchIds.size).toBe(1);
    for (const row of audits) {
      expect(row).toMatchObject({
        action: 'DELETE',
        adminId: s.adminId,
        details: { mode: 'soft' },
        userAgent: TEST_USER_AGENT,
      });
    }
    expectInvalidatedAfterAudit(s, invalidate, 'createMany');
  });

  it('answers 404 listing the unknown ID; nothing changed', async () => {
    const s = await setupThree();
    const unknown = randomUUID();
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    const error = expectError(
      await bulkDeleteShowtimes(s, { ids: [s.db.showtimes[0]?.id, unknown] }),
      404,
      'NOT_FOUND',
    );

    expect(error).toEqual({
      code: 'NOT_FOUND',
      message: showtimeBulkDeleteNotFoundMessage(1),
      details: [{ path: ['body', 'ids', 1], message: SHOWTIME_BULK_DELETE_UNKNOWN_ID_MESSAGE }],
    });
    expect(s.db.showtimes.every((row) => row.deletedAt === null)).toBe(true);
    expectNothingWritten(s, invalidate, 3);
  });

  it('answers 409 listing the already-deleted ID; nothing changed', async () => {
    const s = await setup({
      showtimes: [
        { startsAt: colombo('2026-11-02', '19:00') },
        { startsAt: colombo('2026-11-03', '19:00'), deletedAt: DELETED_AT },
      ],
    });
    const ids = s.db.showtimes.map((row) => row.id);
    const invalidate = vi.spyOn(s.cache, 'invalidatePrefix');

    const error = expectError(await bulkDeleteShowtimes(s, { ids }), 409, 'CONFLICT');

    expect(error).toEqual({
      code: 'CONFLICT',
      message: showtimeBulkDeleteAlreadyDeletedMessage(1),
      details: [{ path: ['body', 'ids', 1], message: SHOWTIME_BULK_DELETE_DELETED_ID_MESSAGE }],
    });
    expect(s.db.showtimes[0]?.deletedAt).toBeNull();
    expectNothingWritten(s, invalidate, 2);
  });

  describe('validation (400, nothing written)', () => {
    const id = randomUUID();
    it.each([
      ['duplicate IDs', { ids: [id, id] }, ['body', 'ids', 1]],
      ['case-only duplicates', { ids: [id, id.toUpperCase()] }, ['body', 'ids', 1]],
      ['no IDs', { ids: [] }, ['body', 'ids']],
      ['201 IDs', { ids: Array.from({ length: 201 }, () => randomUUID()) }, ['body', 'ids']],
      ['a bad ID', { ids: ['nope'] }, ['body', 'ids', 0]],
      ['a missing ids', {}, ['body', 'ids']],
      ['an unknown key', { ids: [id], force: true }, ['body']],
    ] as const)('rejects %s', async (_name, body, path) => {
      const s = await setupThree();

      const error = expectError(await bulkDeleteShowtimes(s, body), 400, 'VALIDATION_ERROR');

      expect(error.details).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
      expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    });
  });

  it('is not shadowed by /:id: GET /bulk-delete is a 400 for the id, not a bulk delete', async () => {
    const s = await setupThree();

    const res = await getShowtimes(s, '/bulk-delete');

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(s.db.spies.showtime.updateMany).not.toHaveBeenCalled();
  });

  it('bulk-deleted showtimes leave the list and free their slots for a new show', async () => {
    const s = await setupThree();
    const ids = s.db.showtimes.map((row) => row.id);

    expect((await bulkDeleteShowtimes(s, { ids })).status).toBe(200);

    const page = adminShowtimeListResponseSchema.parse((await getShowtimes(s, '')).body);
    expect(page.items).toEqual([]);
    expectOk(await createShowtime(s, validBody(s, { date: '2026-11-02', time: '19:30' })), 201);
  });
});
