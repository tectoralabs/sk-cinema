import {
  adminSettingsResponseSchema,
  apiErrorSchema,
  BMS_BOOKING_URL_PREFIX,
  DEFAULT_BMS_BASE_URL,
  showtimeConflictErrorSchema,
  type AdminSettingsResponse,
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
import { SHOWTIME_OVERLAP_MESSAGE } from '../services/showtime.admin.service.js';
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

const EMAIL = 'owner@skcinema.lk';
const PASSWORD = 'correct horse battery staple';
const UNAUTHORIZED_BODY = { error: { code: 'UNAUTHORIZED', message: SESSION_EXPIRED_MESSAGE } };
const CSRF_BODY = { error: { code: 'CSRF_INVALID', message: 'CSRF validation failed' } };
const INTERNAL_BODY = { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } };
const NEW_BASE = 'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/cinema-snlk-SKCM-NEW';

/** The app's clock (only Date is faked): 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');
const SEEDED_AT = new Date('2026-01-01T00:00:00.000Z');
const DELETED_AT = new Date('2026-10-01T00:00:00.000Z');
const DAY = '2026-11-02';
const NEXT_DAY = '2026-11-03';

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
  adminName: string;
  client: AuthClient;
  session: Session;
  movie: Movie;
  screen: Screen;
  invalidate: MockInstance<MemoryCache['invalidatePrefix']>;
}

interface SetupOptions {
  role?: AdminRole;
  settings?: Setting[];
  /** Shows of the main movie (120 minutes) on the main screen, unless given. */
  showtimes?: (Partial<Showtime> & Pick<Showtime, 'startsAt'>)[];
  screens?: Screen[];
  movies?: Movie[];
}

async function setup(options: SetupOptions = {}): Promise<Setup> {
  const admin = testAdmin({
    email: EMAIL,
    name: 'Owner',
    passwordHash,
    role: options.role ?? 'SUPER_ADMIN',
  });
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
    adminName: admin.name,
    client,
    session: sessionFrom(login),
    movie,
    screen,
    invalidate: vi.spyOn(cache, 'invalidatePrefix'),
  };
}

/** A browser-like admin request with the session (by default), CSRF and Origin. */
function send(
  s: Setup,
  method: 'post' | 'patch',
  path: string,
  options: SendOptions = {},
): request.Test {
  const {
    body,
    cookies = [s.session.access],
    origin = ADMIN_ORIGIN,
    token = s.client.csrf.token,
  } = options;
  const all = [...(options.csrfCookie === false ? [] : [s.client.csrf.cookie]), ...cookies];
  let req = request(s.app)[method](`${ADMIN_BASE}${path}`).set('User-Agent', TEST_USER_AGENT);
  if (all.length > 0) req = req.set('Cookie', all.join('; '));
  if (origin !== null) req = req.set('Origin', origin);
  if (token !== null) req = req.set(CSRF_HEADER, token);
  if (body === undefined) return req;
  return typeof body === 'string'
    ? req.set('Content-Type', 'application/json').send(body)
    : req.send(body);
}

const patchSettings = (s: Setup, body: object | string, options: SendOptions = {}) =>
  send(s, 'patch', '/settings', { ...options, body });
const getSettings = (s: Setup, path = '', cookies = [s.session.access]) =>
  s.client.get(`/settings${path}`, cookies);

const settingAudits = (db: InMemoryAuthDb) =>
  db.auditLogs.filter((row) => row.entity === 'Setting');

const storedValues = (db: InMemoryAuthDb) =>
  Object.fromEntries(db.settings.map((row) => [row.key, row.value]));

function expectOk(res: request.Response): AdminSettingsResponse {
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  return adminSettingsResponseSchema.parse(res.body);
}

function expectError(res: request.Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers['cache-control']).toBe('no-store');
  const { error } = apiErrorSchema.parse(res.body);
  expect(error.code).toBe(code);
  return error;
}

function expectNothingWritten(s: Setup, settings: Setting[] = []) {
  expect(s.db.settings).toEqual(settings);
  expect(s.db.spies.setting.upsert).not.toHaveBeenCalled();
  expect(settingAudits(s.db)).toEqual([]);
  expect(s.invalidate).not.toHaveBeenCalled();
}

function expectInvalidatedOnceAfterAudit(s: Setup) {
  expect(s.invalidate).toHaveBeenCalledExactlyOnceWith(PUBLIC_MOVIES_CACHE_PREFIX);
  const auditOrder = s.db.spies.auditLog.createMany.mock.invocationCallOrder.at(-1) ?? Infinity;
  expect(s.invalidate.mock.invocationCallOrder[0]).toBeGreaterThan(auditOrder);
}

// ---------------------------------------------------------------------------
// Session, CSRF and roles
// ---------------------------------------------------------------------------

describe('/api/admin/settings: session, role and CSRF', () => {
  it('GET answers 401 without a session, before touching the database', async () => {
    const s = await setup();

    const res = await getSettings(s, '', []);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
    expect(s.db.spies.setting.findMany).not.toHaveBeenCalled();
  });

  it('PATCH answers 401 without a session, before touching the database', async () => {
    const s = await setup();

    const res = await patchSettings(s, { showGapMinutes: 30 }, { cookies: [] });

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    expectNothingWritten(s);
  });

  it('PATCH answers 401 for an invalid session cookie, even with a bad body', async () => {
    const s = await setup();

    const res = await patchSettings(s, { nope: true }, { cookies: [`${s.session.access}x`] });

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
    expectNothingWritten(s);
  });

  it('EDITOR gets 403 on GET and reads nothing', async () => {
    const s = await setup({ role: 'EDITOR' });

    expectError(await getSettings(s), 403, 'FORBIDDEN');

    expect(s.db.spies.setting.findMany).not.toHaveBeenCalled();
    expect(s.db.spies.showtime.findMany).not.toHaveBeenCalled();
  });

  it('EDITOR gets 403 on PATCH with no audit and no change', async () => {
    const seeded = [testSetting('showGapMinutes', '20')];
    const s = await setup({ role: 'EDITOR', settings: seeded });

    expectError(await patchSettings(s, { showGapMinutes: 30 }), 403, 'FORBIDDEN');

    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    expectNothingWritten(s, seeded);
  });

  it('EDITOR gets 403 before the body is validated', async () => {
    const s = await setup({ role: 'EDITOR' });

    expectError(await patchSettings(s, { nope: true }), 403, 'FORBIDDEN');
  });

  it.each([
    ['a missing CSRF token', { token: null }],
    ['a wrong CSRF token', { token: 'not-the-token' }],
    ['a missing CSRF cookie', { csrfCookie: false }],
    ['a missing Origin', { origin: null }],
    ['a foreign Origin', { origin: 'https://evil.example' }],
  ] as const)('PATCH answers 403 for %s, even with a session', async (_name, overrides) => {
    const s = await setup();

    const res = await patchSettings(s, { showGapMinutes: 30 }, overrides);

    expect(res.status).toBe(403);
    expect(res.body).toEqual(CSRF_BODY);
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    expectNothingWritten(s);
  });

  it('GET does not need a CSRF token', async () => {
    const s = await setup();

    const res = await request(s.app).get(`${ADMIN_BASE}/settings`).set('Cookie', s.session.access);

    expectOk(res);
  });
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

describe('GET /api/admin/settings', () => {
  it('answers the defaults and nulls with no rows', async () => {
    const s = await setup();

    expect(expectOk(await getSettings(s))).toEqual({
      settings: {
        bmsBaseUrl: DEFAULT_BMS_BASE_URL,
        showGapMinutes: 15,
        updatedAt: null,
        updatedBy: null,
      },
      futureShowtimesBelowGap: 0,
    });
  });

  it('answers seeded rows: updatedAt set, updatedBy null', async () => {
    const s = await setup({
      settings: [testSetting('bmsBaseUrl', NEW_BASE), testSetting('showGapMinutes', '30')],
    });

    expect(expectOk(await getSettings(s))).toEqual({
      settings: {
        bmsBaseUrl: NEW_BASE,
        showGapMinutes: 30,
        updatedAt: SEEDED_AT.toISOString(),
        updatedBy: null,
      },
      futureShowtimesBelowGap: 0,
    });
  });

  it('reads an invalid stored value as its default', async () => {
    const s = await setup({
      settings: [
        testSetting('bmsBaseUrl', 'https://evil.example/x'),
        testSetting('showGapMinutes', 'abc'),
      ],
    });

    const { settings } = expectOk(await getSettings(s));

    expect(settings).toMatchObject({ bmsBaseUrl: DEFAULT_BMS_BASE_URL, showGapMinutes: 15 });
    expect(JSON.stringify(settings)).not.toContain('evil');
  });

  it('answers with a movie of 0 minutes and a future show, the count ignoring it', async () => {
    const broken = testMovie({ slug: 'broken', durationMinutes: 0 });
    const s = await setup({
      movies: [broken],
      showtimes: [
        { startsAt: colombo(DAY, '09:00'), movieId: broken.id },
        { startsAt: colombo(DAY, '10:00') },
        { startsAt: colombo(DAY, '12:00') },
      ],
    });

    expect(expectOk(await getSettings(s)).futureShowtimesBelowGap).toBe(1);
  });

  it('counts future shows below the stored gap', async () => {
    const s = await setup({
      settings: [testSetting('showGapMinutes', '30')],
      showtimes: [{ startsAt: colombo(DAY, '10:00') }, { startsAt: colombo(DAY, '12:20') }],
    });

    expect(expectOk(await getSettings(s)).futureShowtimesBelowGap).toBe(1);
  });

  it.each(['?extra=1', '?showGapMinutes=30'])('answers 400 for the query %s', async (query) => {
    const s = await setup();

    expectError(await getSettings(s, query), 400, 'VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// PATCH: writes
// ---------------------------------------------------------------------------

describe('PATCH /api/admin/settings', () => {
  it('saves the base URL alone: value, updatedById, one audit row, one invalidation', async () => {
    const s = await setup();

    const res = expectOk(await patchSettings(s, { bmsBaseUrl: NEW_BASE }));

    expect(res).toEqual({
      settings: {
        bmsBaseUrl: NEW_BASE,
        showGapMinutes: 15,
        updatedAt: NOW.toISOString(),
        updatedBy: { id: s.adminId, name: s.adminName },
      },
      futureShowtimesBelowGap: 0,
    });
    expect(s.db.settings).toEqual([
      { key: 'bmsBaseUrl', value: NEW_BASE, updatedById: s.adminId, updatedAt: NOW },
    ]);
    expect(settingAudits(s.db)).toHaveLength(1);
    expect(settingAudits(s.db)[0]).toMatchObject({
      action: 'UPDATE',
      entity: 'Setting',
      entityId: 'bmsBaseUrl',
      adminId: s.adminId,
      details: { from: DEFAULT_BMS_BASE_URL, to: NEW_BASE },
      userAgent: TEST_USER_AGENT,
    });
    expectInvalidatedOnceAfterAudit(s);
  });

  it('saves the gap alone, as text, and audits numbers', async () => {
    const s = await setup();

    const res = expectOk(await patchSettings(s, { showGapMinutes: 30 }));

    expect(res.settings).toMatchObject({ bmsBaseUrl: DEFAULT_BMS_BASE_URL, showGapMinutes: 30 });
    expect(s.db.settings).toEqual([
      { key: 'showGapMinutes', value: '30', updatedById: s.adminId, updatedAt: NOW },
    ]);
    expect(settingAudits(s.db)).toHaveLength(1);
    expect(settingAudits(s.db)[0]).toMatchObject({
      action: 'UPDATE',
      entity: 'Setting',
      entityId: 'showGapMinutes',
      details: { from: 15, to: 30 },
    });
    expectInvalidatedOnceAfterAudit(s);
  });

  it.each([0, 120])('accepts the boundary gap %d', async (showGapMinutes) => {
    const s = await setup();

    expect(expectOk(await patchSettings(s, { showGapMinutes })).settings.showGapMinutes).toBe(
      showGapMinutes,
    );
    expect(storedValues(s.db)).toEqual({ showGapMinutes: String(showGapMinutes) });
  });

  it('saves both: two rows, two audit rows, one invalidation', async () => {
    const s = await setup();

    const res = expectOk(await patchSettings(s, { bmsBaseUrl: NEW_BASE, showGapMinutes: 30 }));

    expect(res.settings).toMatchObject({ bmsBaseUrl: NEW_BASE, showGapMinutes: 30 });
    expect(storedValues(s.db)).toEqual({ bmsBaseUrl: NEW_BASE, showGapMinutes: '30' });
    expect(s.db.settings.every((row) => row.updatedById === s.adminId)).toBe(true);
    expect(settingAudits(s.db).map((row) => [row.entityId, row.details])).toEqual([
      ['bmsBaseUrl', { from: DEFAULT_BMS_BASE_URL, to: NEW_BASE }],
      ['showGapMinutes', { from: 15, to: 30 }],
    ]);
    expectInvalidatedOnceAfterAudit(s);
  });

  it('updates an existing row in place, from its stored value', async () => {
    const s = await setup({ settings: [testSetting('showGapMinutes', '20')] });

    expectOk(await patchSettings(s, { showGapMinutes: 25 }));

    expect(s.db.settings).toEqual([
      { key: 'showGapMinutes', value: '25', updatedById: s.adminId, updatedAt: NOW },
    ]);
    expect(settingAudits(s.db)[0]?.details).toEqual({ from: 20, to: 25 });
  });

  it('trims the base URL before storing and comparing it', async () => {
    const s = await setup();

    expectOk(await patchSettings(s, { bmsBaseUrl: `  ${NEW_BASE} ` }));
    expect(storedValues(s.db)).toEqual({ bmsBaseUrl: NEW_BASE });

    s.invalidate.mockClear();
    expectOk(await patchSettings(s, { bmsBaseUrl: ` ${NEW_BASE}` }));
    expect(s.invalidate).not.toHaveBeenCalled();
    expect(settingAudits(s.db)).toHaveLength(1);
  });

  it('GET afterwards answers exactly what PATCH did', async () => {
    const s = await setup();

    const patched = expectOk(await patchSettings(s, { bmsBaseUrl: NEW_BASE, showGapMinutes: 30 }));

    expect(expectOk(await getSettings(s))).toEqual(patched);
  });

  it('never touches showtime overrides', async () => {
    const override = `${BMS_BOOKING_URL_PREFIX}sk-cinema-matara/special/20261102`;
    const s = await setup({
      showtimes: [{ startsAt: colombo(DAY, '19:00'), bookingUrlOverride: override }],
    });
    const before = structuredClone(s.db.showtimes);

    expectOk(await patchSettings(s, { bmsBaseUrl: NEW_BASE }));

    expect(s.db.showtimes).toEqual(before);
  });

  it('saves with a movie of 0 minutes and a future show, the count ignoring it', async () => {
    const broken = testMovie({ slug: 'broken', durationMinutes: 0 });
    const s = await setup({
      movies: [broken],
      showtimes: [
        { startsAt: colombo(DAY, '09:00'), movieId: broken.id },
        { startsAt: colombo(DAY, '10:00') },
        { startsAt: colombo(DAY, '12:00') },
      ],
    });

    const res = expectOk(await patchSettings(s, { showGapMinutes: 20 }));

    expect(res.settings.showGapMinutes).toBe(20);
    expect(res.futureShowtimesBelowGap).toBe(1);
    expect(storedValues(s.db)).toEqual({ showGapMinutes: '20' });
  });

  describe('an invalid stored row is never a no-op', () => {
    it.each([
      ['showGapMinutes', 'not-a-gap', 15, '15'],
      ['bmsBaseUrl', 'https://evil.example/stored', DEFAULT_BMS_BASE_URL, DEFAULT_BMS_BASE_URL],
    ] as const)(
      'sending the default for %s overwrites the row: audit, invalidation, no more warnings',
      async (key, raw, effective, written) => {
        const s = await setup({ settings: [testSetting(key, raw)] });

        const res = expectOk(await patchSettings(s, { [key]: effective }));

        expect(res.settings).toMatchObject({
          [key]: effective,
          updatedBy: { id: s.adminId, name: s.adminName },
        });
        expect(storedValues(s.db)).toEqual({ [key]: written });
        expect(settingAudits(s.db)).toEqual([
          expect.objectContaining({
            action: 'UPDATE',
            adminId: s.adminId,
            entityId: key,
            details: { from: effective, to: effective },
          }),
        ]);
        expectInvalidatedOnceAfterAudit(s);
        expect(JSON.stringify([settingAudits(s.db), res])).not.toContain(raw);
      },
    );
  });

  describe('no-ops', () => {
    it('answers the normal shape with no write, audit or invalidation', async () => {
      const seeded = [testSetting('showGapMinutes', '20')];
      const s = await setup({ settings: seeded });

      expect(expectOk(await patchSettings(s, { showGapMinutes: 20 }))).toEqual({
        settings: {
          bmsBaseUrl: DEFAULT_BMS_BASE_URL,
          showGapMinutes: 20,
          updatedAt: SEEDED_AT.toISOString(),
          updatedBy: null,
        },
        futureShowtimesBelowGap: 0,
      });
      expectNothingWritten(s, seeded);
    });

    it('a missing row whose default is sent is a no-op: no row is created', async () => {
      const s = await setup();

      const res = expectOk(
        await patchSettings(s, { bmsBaseUrl: DEFAULT_BMS_BASE_URL, showGapMinutes: 15 }),
      );

      expect(res.settings.updatedAt).toBeNull();
      expectNothingWritten(s);
    });

    it('a partial no-op writes only the key that changes', async () => {
      const s = await setup({
        settings: [testSetting('showGapMinutes', '15')],
      });

      const res = expectOk(await patchSettings(s, { bmsBaseUrl: NEW_BASE, showGapMinutes: 15 }));

      expect(res.settings).toMatchObject({ bmsBaseUrl: NEW_BASE, showGapMinutes: 15 });
      expect(s.db.spies.setting.upsert).toHaveBeenCalledTimes(1);
      expect(settingAudits(s.db).map((row) => row.entityId)).toEqual(['bmsBaseUrl']);
      expect(s.db.settings.find((row) => row.key === 'showGapMinutes')?.updatedById).toBeNull();
      expectInvalidatedOnceAfterAudit(s);
    });
  });

  // -------------------------------------------------------------------------
  // PATCH: validation
  // -------------------------------------------------------------------------

  describe('validation', () => {
    const P = BMS_BOOKING_URL_PREFIX;

    it.each([
      ['http', 'http://lk.bookmyshow.com/buytickets/sk-cinema-matara/x'],
      ['another host', 'https://example.com/buytickets/sk-cinema-matara/x'],
      ['a look-alike subdomain', 'https://lk.bookmyshow.com.evil.example/buytickets/x'],
      ['a look-alike host', 'https://lk-bookmyshow.com/buytickets/x'],
      ['another BookMyShow host', 'https://in.bookmyshow.com/buytickets/x'],
      ['upper case host', 'https://LK.BOOKMYSHOW.COM/buytickets/x'],
      ['userinfo before the host', 'https://user:pw@lk.bookmyshow.com/buytickets/x'],
      ['the BMS host as userinfo', 'https://lk.bookmyshow.com@evil.example/buytickets/x'],
      ['a port', 'https://lk.bookmyshow.com:8443/buytickets/x'],
      ['the default port', 'https://lk.bookmyshow.com:443/buytickets/x'],
      ['another path', 'https://lk.bookmyshow.com/movies/x'],
      ['no path after /buytickets/', P],
      ['an encoded slash', `${P}a%2fb`],
      ['an encoded slash in capitals', `${P}a%2Fb`],
      ['a backslash', `${P}a\\b`],
      ['a dot-dot segment', `${P}a/../b`],
      ['a dot segment', `${P}a/./b`],
      ['a double slash', `${P}a//b`],
      ['a query string', `${P}a?x=1`],
      ['a fragment', `${P}a#x`],
      ['a trailing slash', `${P}a/`],
      ['a space inside', `${P}a b`],
      ['a tab inside', `${P}a\tb`],
      ['a newline inside', `${P}a\nb`],
      ['a javascript link', 'javascript:alert(1)'],
      ['an empty value', ''],
      ['only spaces', '   '],
      ['over 500 characters', `${P}${'a'.repeat(500)}`],
    ])('answers 400 for a base URL with %s, with no audit', async (_name, bmsBaseUrl) => {
      const s = await setup();

      expectError(await patchSettings(s, { bmsBaseUrl }), 400, 'VALIDATION_ERROR');

      expect(s.db.spies.$transaction).not.toHaveBeenCalled();
      expectNothingWritten(s);
    });

    it.each([[-1], [121], [1.5], ['15'], [null], [true], [[15]]])(
      'answers 400 for showGapMinutes %j, with no audit',
      async (showGapMinutes) => {
        const s = await setup();

        expectError(await patchSettings(s, { showGapMinutes }), 400, 'VALIDATION_ERROR');

        expect(s.db.spies.$transaction).not.toHaveBeenCalled();
        expectNothingWritten(s);
      },
    );

    it.each([
      ['an empty body', {}],
      ['an unknown key', { showGapMinutes: 30, theme: 'dark' }],
      ['only an unknown key', { theme: 'dark' }],
      ['a read-only field', { updatedAt: '2026-10-01T00:00:00.000Z' }],
      ['updatedById', { showGapMinutes: 30, updatedById: 'x' }],
      ['one good and one bad value', { bmsBaseUrl: NEW_BASE, showGapMinutes: 121 }],
      ['the key as bmsBaseURL', { bmsBaseURL: NEW_BASE }],
    ])('answers 400 for %s, with no audit', async (_name, body) => {
      const s = await setup();

      expectError(await patchSettings(s, body), 400, 'VALIDATION_ERROR');

      expect(s.db.spies.$transaction).not.toHaveBeenCalled();
      expectNothingWritten(s);
    });

    it('answers 400 for malformed JSON', async () => {
      const s = await setup();

      // Parsed by the app-level JSON parser, before the admin router (and its no-store).
      const res = await patchSettings(s, '{"showGapMinutes":');

      expect(res.status).toBe(400);
      expect(apiErrorSchema.parse(res.body).error.code).toBe('INVALID_JSON');
      expectNothingWritten(s);
    });

    it('answers 400 for an array', async () => {
      const s = await setup();

      expectError(await patchSettings(s, '[]'), 400, 'VALIDATION_ERROR');

      expectNothingWritten(s);
    });

    it('answers 400 for an extra query key', async () => {
      const s = await setup();

      const res = await send(s, 'patch', '/settings?extra=1', { body: { showGapMinutes: 30 } });

      expectError(res, 400, 'VALIDATION_ERROR');
      expectNothingWritten(s);
    });
  });

  // -------------------------------------------------------------------------
  // PATCH: faults
  // -------------------------------------------------------------------------

  describe('faults', () => {
    const SECRET = 'connection to db.internal:5432 failed';
    const both = { bmsBaseUrl: NEW_BASE, showGapMinutes: 30 };

    /** A generic 500, no internals, every value as it was, and the cache left alone. */
    function expectRolledBack(s: Setup, res: request.Response, seeded: Setting[]) {
      expect(res.status).toBe(500);
      expect(res.body).toEqual(INTERNAL_BODY);
      expect(res.text).not.toContain('db.internal');
      expect(s.db.settings).toEqual(seeded);
      expect(settingAudits(s.db)).toEqual([]);
      expect(s.invalidate).not.toHaveBeenCalled();
    }

    it.each([
      ['the first upsert', 'setting', 'upsert', 1],
      ['the second upsert: the first key rolls back', 'setting', 'upsert', 2],
      ['the audit rows: both keys roll back', 'auditLog', 'createMany', 1],
    ] as const)('%s', async (_name, model, operation, onCall) => {
      const seeded = [testSetting('showGapMinutes', '20')];
      const s = await setup({ settings: seeded });
      s.db.injectFault(model, operation, { onCall, error: new Error(SECRET) });

      expectRolledBack(s, await patchSettings(s, both), seeded);
    });

    it('the count failing after the writes rolls both keys and the audit rows back', async () => {
      const seeded = [testSetting('showGapMinutes', '20')];
      const s = await setup({ settings: seeded });
      s.db.injectFault('showtime', 'findMany', { error: new Error(SECRET) });

      expectRolledBack(s, await patchSettings(s, both), seeded);
    });

    it('a fault on GET is a generic 500 too', async () => {
      const s = await setup();
      s.db.injectFault('setting', 'findMany', { error: new Error(SECRET) });

      const res = await getSettings(s);

      expect(res.status).toBe(500);
      expect(res.body).toEqual(INTERNAL_BODY);
    });
  });
});

// ---------------------------------------------------------------------------
// futureShowtimesBelowGap and the gap rule
// ---------------------------------------------------------------------------

describe('futureShowtimesBelowGap', () => {
  const at = (time: string, date = DAY) => ({ startsAt: colombo(date, time) });

  const countAfterGap = async (
    showtimes: NonNullable<SetupOptions['showtimes']>,
    showGapMinutes: number,
  ) => {
    const s = await setup({ showtimes });
    return expectOk(await patchSettings(s, { showGapMinutes })).futureShowtimesBelowGap;
  };

  it.each([
    ['no shows', [], 30, 0],
    ['touching at the new gap', [at('10:00'), at('12:30')], 30, 0],
    ['one minute too close', [at('10:00'), at('12:29')], 30, 1],
    ['three in a row all too close', [at('10:00'), at('12:20'), at('14:40')], 30, 2],
  ])('%s', async (_name, showtimes, gap, expected) => {
    await expect(countAfterGap(showtimes, gap)).resolves.toBe(expected);
  });

  it('past shows are ignored as candidates, a running show counts as a neighbour', async () => {
    await expect(
      countAfterGap(
        [
          // Two finished shows that clash with each other.
          { startsAt: new Date('2026-10-30T10:00:00.000Z') },
          { startsAt: new Date('2026-10-30T10:30:00.000Z') },
          // Running now (ends 11:00 UTC), and a future show too close to it under the new gap.
          { startsAt: new Date('2026-11-01T09:00:00.000Z') },
          { startsAt: new Date('2026-11-01T11:20:00.000Z') },
        ],
        30,
      ),
    ).resolves.toBe(1);
  });

  it('soft-deleted shows are ignored', async () => {
    await expect(
      countAfterGap([at('10:00'), { ...at('12:20'), deletedAt: DELETED_AT }], 30),
    ).resolves.toBe(0);
  });

  it('different screens are ignored', async () => {
    const other = testScreen({ name: 'Screen 2' });
    const s = await setup({
      screens: [other],
      showtimes: [at('10:00'), { ...at('12:20'), screenId: other.id }],
    });

    expect(expectOk(await patchSettings(s, { showGapMinutes: 30 })).futureShowtimesBelowGap).toBe(
      0,
    );
  });

  it('a show on a hidden screen or of a hidden movie still counts', async () => {
    const hiddenScreen = testScreen({ name: 'Hidden', isActive: false });
    const hiddenMovie = testMovie({ slug: 'hidden', isActive: false, durationMinutes: 120 });
    const s = await setup({
      screens: [hiddenScreen],
      movies: [hiddenMovie],
      showtimes: [
        { ...at('10:00'), screenId: hiddenScreen.id },
        { ...at('12:20'), screenId: hiddenScreen.id },
        at('10:00'),
        { ...at('12:20'), movieId: hiddenMovie.id },
      ],
    });

    expect(expectOk(await patchSettings(s, { showGapMinutes: 30 })).futureShowtimesBelowGap).toBe(
      2,
    );
  });

  it('raising then lowering the gap changes the count', async () => {
    const s = await setup({ showtimes: [at('10:00'), at('12:20')] });
    expect(expectOk(await getSettings(s)).futureShowtimesBelowGap).toBe(0);

    expect(expectOk(await patchSettings(s, { showGapMinutes: 30 })).futureShowtimesBelowGap).toBe(
      1,
    );
    expect(expectOk(await getSettings(s)).futureShowtimesBelowGap).toBe(1);

    expect(expectOk(await patchSettings(s, { showGapMinutes: 15 })).futureShowtimesBelowGap).toBe(
      0,
    );
    expect(expectOk(await getSettings(s)).futureShowtimesBelowGap).toBe(0);
  });

  it('saving a larger gap succeeds with a count > 0 and leaves every showtime unchanged', async () => {
    const s = await setup({ showtimes: [at('10:00'), at('12:20'), at('14:40')] });
    const before = structuredClone(s.db.showtimes);

    const res = expectOk(await patchSettings(s, { showGapMinutes: 120 }));

    expect(res.settings.showGapMinutes).toBe(120);
    expect(res.futureShowtimesBelowGap).toBe(2);
    expect(s.db.showtimes).toEqual(before);
    expect(s.db.spies.showtime.update).not.toHaveBeenCalled();
    expect(s.db.spies.showtime.updateMany).not.toHaveBeenCalled();
  });

  it('a base URL change alone reports the count under the unchanged gap', async () => {
    const s = await setup({
      settings: [testSetting('showGapMinutes', '30')],
      showtimes: [at('10:00'), at('12:20')],
    });

    expect(expectOk(await patchSettings(s, { bmsBaseUrl: NEW_BASE })).futureShowtimesBelowGap).toBe(
      1,
    );
  });
});

describe('the gap rule: a change applies only to shows created or moved afterwards', () => {
  /** Two saved shows 20 minutes apart (fine at 15, clashing at 30) and a spare one next day. */
  async function raisedGap() {
    const s = await setup({
      showtimes: [
        { startsAt: colombo(DAY, '10:00') },
        { startsAt: colombo(DAY, '12:20') },
        { startsAt: colombo(NEXT_DAY, '10:00') },
      ],
    });
    const [first, second, spare] = s.db.showtimes.map((row) => row.id);
    if (first === undefined || second === undefined || spare === undefined) {
      throw new Error('expected three showtimes');
    }
    const res = expectOk(await patchSettings(s, { showGapMinutes: 30 }));
    expect(res.futureShowtimesBelowGap).toBe(1);
    return { s, first, second, spare };
  }

  const createShow = (s: Setup, date: string, time: string) =>
    send(s, 'post', '/showtimes', {
      body: { movieId: s.movie.id, screenId: s.screen.id, date, time },
    });
  const moveShow = (s: Setup, id: string, body: object) =>
    send(s, 'patch', `/showtimes/${id}`, { body });

  it('a new show is held to the new gap, touching it is fine', async () => {
    const { s } = await raisedGap();

    // The spare ends at 12:00: 12:20 passed the old gap of 15 and fails the new 30.
    const refused = await createShow(s, NEXT_DAY, '12:20');
    expect(refused.status).toBe(409);
    expect(showtimeConflictErrorSchema.parse(refused.body).error.message).toBe(
      SHOWTIME_OVERLAP_MESSAGE,
    );

    expect((await createShow(s, NEXT_DAY, '12:30')).status).toBe(201);
  });

  it('another show can be moved while two other saved shows clash under the new gap', async () => {
    const { s, spare } = await raisedGap();

    const res = await moveShow(s, spare, { date: NEXT_DAY, time: '18:00' });

    expect(res.status).toBe(200);
    // The two clashing shows are still there and still counted.
    expect(expectOk(await getSettings(s)).futureShowtimesBelowGap).toBe(1);
  });

  it('a moved show is held to the new gap against its own neighbours', async () => {
    const { s, second, spare } = await raisedGap();

    expect((await moveShow(s, spare, { date: DAY, time: '14:40' })).status).toBe(409);
    expect((await moveShow(s, second, { date: DAY, time: '12:25' })).status).toBe(409);
    expect((await moveShow(s, second, { date: DAY, time: '12:30' })).status).toBe(200);
    expect(expectOk(await getSettings(s)).futureShowtimesBelowGap).toBe(0);
  });

  it('editing a too-close show without moving it still works', async () => {
    const { s, second } = await raisedGap();

    expect((await moveShow(s, second, { format: '3D' })).status).toBe(200);
  });
});
