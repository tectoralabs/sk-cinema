import { randomUUID } from 'node:crypto';
import {
  adminShowtimeListResponseSchema,
  adminShowtimeResponseSchema,
  apiErrorSchema,
  DEFAULT_BMS_BASE_URL,
  showtimeConflictErrorSchema,
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
  SHOWTIME_IN_PAST_MESSAGE,
  SHOWTIME_MOVIE_ENDED_MESSAGE,
  SHOWTIME_MOVIE_NOT_FOUND_MESSAGE,
  SHOWTIME_NOT_FOUND_MESSAGE,
  SHOWTIME_OVERLAP_MESSAGE,
  SHOWTIME_SCREEN_INACTIVE_MESSAGE,
  SHOWTIME_SCREEN_NOT_FOUND_MESSAGE,
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
