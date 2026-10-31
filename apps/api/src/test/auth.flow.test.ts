/**
 * Phase 3 flow tests: whole auth journeys through createApp + supertest, one test per
 * behaviour, grouped by the PLAN.md "Done when" item they prove. Per-endpoint details live
 * in routes/auth.routes.test.ts; this file checks that the pieces work together over time.
 *
 * Only Date is faked (argon2 and supertest need real timers), and it is frozen at T0, so
 * every timestamp, JWT exp, cookie Expires and lockout is deterministic.
 */
import { Writable } from 'node:stream';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { pino, type Logger } from 'pino';
import type request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/env.js';
import type { Admin } from '../generated/prisma/client.js';
import {
  ACCESS_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
} from '../lib/authCookies.js';
import { hashPassword } from '../lib/password.js';
import { FORBIDDEN_MESSAGE, requireAuth, requireRole } from '../middleware/auth.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestLogger } from '../middleware/requestLogger.js';
import { INVALID_CREDENTIALS_MESSAGE, SESSION_EXPIRED_MESSAGE } from '../services/auth.service.js';
import {
  ADMIN_BASE,
  TEST_USER_AGENT,
  authClient,
  buildTestApp,
  inMemoryAuthDb,
  parseSetCookies,
  sessionFrom,
  silentLogger,
  testAdmin,
  testConfig,
  type AuthClient,
  type InMemoryAuthDb,
  type Session,
} from './helpers.js';

const EMAIL = 'editor@skcinema.lk';
const UNKNOWN_EMAIL = 'nobody@skcinema.lk';
const PASSWORD = 'correct horse battery staple';
const WRONG_PASSWORD = 'Tr0ub4dor&3-wrong-guess';

/** 10:00 in Colombo. Frozen for every test; tests move it with `advance` / `setNow`. */
const T0 = new Date('2026-11-01T04:30:00.000Z');
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

const config = testConfig();
const ACCESS_TTL_MS = config.auth.accessTokenTtlSeconds * 1000;
const REFRESH_TTL_MS = config.auth.refreshTokenTtlHours * HOUR_MS;
const LOCKOUT_MS = config.auth.loginLockoutMinutes * MINUTE_MS;
const MAX_FAILED = config.auth.loginMaxFailedAttempts;

/** Raises the per-IP login limiter so it cannot interfere with lockout counting. */
const relaxedLoginLimit: Partial<Config> = {
  auth: { ...config.auth, loginRateLimit: { windowMs: 15 * MINUTE_MS, max: 100 } },
};

const UNAUTHORIZED_BODY = { error: { code: 'UNAUTHORIZED', message: SESSION_EXPIRED_MESSAGE } };
const INVALID_CREDENTIALS_BODY = {
  error: { code: 'INVALID_CREDENTIALS', message: INVALID_CREDENTIALS_MESSAGE },
};
const CSRF_BODY = { error: { code: 'CSRF_INVALID', message: 'CSRF validation failed' } };
const FORBIDDEN_BODY = { error: { code: 'FORBIDDEN', message: FORBIDDEN_MESSAGE } };
const EPOCH_EXPIRES = new Date(1).toUTCString();
const JWT_PATTERN = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

const setNow = (date: Date) => {
  vi.setSystemTime(date);
};
const advance = (ms: number) => {
  vi.setSystemTime(new Date(Date.now() + ms));
};

interface SetupOptions {
  admin?: Partial<Admin>;
  /** More admins in the same store. */
  others?: Admin[];
  config?: Partial<Config>;
  logger?: Logger;
}

function setup(options: SetupOptions = {}) {
  const admin = testAdmin({ email: EMAIL, passwordHash, ...options.admin });
  const db = inMemoryAuthDb({ admins: [admin, ...(options.others ?? [])] });
  const { app } = buildTestApp({
    prisma: db.prisma,
    ...(options.config && { config: options.config }),
    ...(options.logger && { logger: options.logger }),
  });
  return { app, db, admin };
}

/** The stored row (rollbacks replace row objects, so always look it up again). */
function stored(db: InMemoryAuthDb, id: string): Admin {
  const row = db.admins.find((a) => a.id === id);
  if (!row) throw new Error('admin not found');
  return row;
}

const attemptLogin = (c: AuthClient, password = PASSWORD, email = EMAIL) =>
  c.post('/auth/login', { body: { email, password } });

async function logIn(c: AuthClient, email = EMAIL): Promise<Session> {
  const res = await attemptLogin(c, PASSWORD, email);
  expect(res.status).toBe(200);
  return sessionFrom(res);
}

const refreshWith = (c: AuthClient, session: Session) =>
  c.post('/auth/refresh', { cookies: [session.refresh] });

const meWith = (c: AuthClient, session: Session) => c.get('/me', [session.access]);

async function lockAccount(c: AuthClient): Promise<void> {
  for (let i = 0; i < MAX_FAILED; i++) {
    expect((await attemptLogin(c, WRONG_PASSWORD)).status).toBe(401);
  }
}

const profileOf = (admin: Admin) => ({
  admin: {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
    mustChangePassword: admin.mustChangePassword,
  },
});

const auditActions = (db: InMemoryAuthDb) => db.auditLogs.map((l) => l.action);
const auditCount = (db: InMemoryAuthDb, action: string) =>
  db.auditLogs.filter((l) => l.action === action).length;
const reasonOf = (details: unknown) => (details as { reason?: string } | null)?.reason ?? undefined;

/** Exact access + refresh cookies for a session that ends at `refreshExpiresAt`. */
function expectSessionCookies(res: request.Response, refreshExpiresAt: Date) {
  const now = Date.now();
  const cookies = parseSetCookies(res);
  const remainingMs = refreshExpiresAt.getTime() - now;
  expect(Object.keys(cookies).sort()).toEqual([ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME].sort());
  expect(cookies[ACCESS_COOKIE_NAME]).toEqual({
    value: expect.stringMatching(JWT_PATTERN) as unknown,
    attributes: {
      'max-age': String(ACCESS_TTL_MS / 1000),
      path: '/',
      expires: new Date(now + ACCESS_TTL_MS).toUTCString(),
      httponly: true,
      secure: true,
      samesite: 'Strict',
    },
  });
  expect(cookies[REFRESH_COOKIE_NAME]).toEqual({
    value: expect.stringMatching(REFRESH_TOKEN_PATTERN) as unknown,
    attributes: {
      'max-age': String(Math.floor(remainingMs / 1000)),
      path: REFRESH_COOKIE_PATH,
      expires: refreshExpiresAt.toUTCString(),
      httponly: true,
      secure: true,
      samesite: 'Strict',
    },
  });
}

function expectAuthCookiesCleared(res: request.Response) {
  const cookies = parseSetCookies(res);
  const cleared = { httponly: true, secure: true, samesite: 'Strict', expires: EPOCH_EXPIRES };
  expect(Object.keys(cookies).sort()).toEqual([ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME].sort());
  expect(cookies[ACCESS_COOKIE_NAME]).toEqual({ value: '', attributes: { ...cleared, path: '/' } });
  expect(cookies[REFRESH_COOKIE_NAME]).toEqual({
    value: '',
    attributes: { ...cleared, path: REFRESH_COOKIE_PATH },
  });
}

function expectNoCookies(res: request.Response) {
  expect(res.headers['set-cookie']).toBeUndefined();
}

/** Status, body bytes and headers, minus the ones that differ per request by design. */
function comparable(res: request.Response) {
  const headers = { ...(res.headers as Record<string, unknown>) };
  delete headers['x-request-id'];
  delete headers['ratelimit']; // remaining-requests counter
  // Set by Node's http module from its own (real, unfaked) clock, so it can tick between requests.
  delete headers['date'];
  return { status: res.status, text: res.text, headers };
}

// ---------------------------------------------------------------------------

describe('Done when 1: login sets cookies; no tokens appear in response bodies', () => {
  it('csrf -> login -> me -> refresh -> me -> logout -> refresh: tokens only ever travel in cookies', async () => {
    const { app, db, admin } = setup();
    const responses: [string, request.Response][] = [];
    const track = (label: string, res: request.Response) => {
      responses.push([label, res]);
      return res;
    };
    const sessionEnd = new Date(T0.getTime() + REFRESH_TTL_MS);

    const c = await authClient(app);
    const csrf = track('GET /csrf', c.csrf.response);
    expect(csrf.status).toBe(200);
    expect(parseSetCookies(csrf)).toEqual({
      [CSRF_COOKIE_NAME]: {
        value: c.csrf.cookieValue,
        attributes: { path: '/', httponly: true, secure: true, samesite: 'Strict' },
      },
    });

    const login = track('POST /login', await attemptLogin(c));
    expect(login.status).toBe(200);
    expect(login.body).toEqual(profileOf(admin));
    expectSessionCookies(login, sessionEnd);
    const first = sessionFrom(login);

    advance(MINUTE_MS);
    const me = track('GET /me', await meWith(c, first));
    expect(me.status).toBe(200);
    expect(me.body).toEqual(profileOf(admin));
    expectNoCookies(me);

    const refresh = track('POST /refresh', await refreshWith(c, first));
    expect(refresh.status).toBe(200);
    expect(refresh.body).toEqual(profileOf(admin));
    expectSessionCookies(refresh, sessionEnd);
    const second = sessionFrom(refresh);
    expect(second.accessValue).not.toBe(first.accessValue);
    expect(second.refreshValue).not.toBe(first.refreshValue);

    const meAgain = track('GET /me (rotated)', await meWith(c, second));
    expect(meAgain.status).toBe(200);
    expect(meAgain.body).toEqual(profileOf(admin));
    expectNoCookies(meAgain);

    const logout = track(
      'POST /logout',
      await c.post('/auth/logout', { cookies: [second.access, second.refresh] }),
    );
    expect(logout.status).toBe(204);
    expect(logout.text).toBe('');
    expectAuthCookiesCleared(logout);

    const afterLogout = track('POST /refresh (logged out)', await refreshWith(c, second));
    expect(afterLogout.status).toBe(401);
    expect(afterLogout.body).toEqual(UNAUTHORIZED_BODY);
    expectAuthCookiesCleared(afterLogout);

    // Every secret that existed during the flow, taken from the actual Set-Cookie values.
    expect(db.refreshTokens).toHaveLength(2);
    const secrets = {
      'first access token': first.accessValue,
      'first refresh token': first.refreshValue,
      'second access token': second.accessValue,
      'second refresh token': second.refreshValue,
      'CSRF cookie value': c.csrf.cookieValue,
      'password hash': passwordHash,
      password: PASSWORD,
      ...Object.fromEntries(
        db.refreshTokens.map((t, i) => [`refresh token hash ${i}`, t.tokenHash]),
      ),
    };
    for (const [label, res] of responses) {
      const headersWithoutSetCookie = JSON.stringify({ ...res.headers, 'set-cookie': undefined });
      for (const [name, secret] of Object.entries(secrets)) {
        expect(res.text, `${name} in the body of ${label}`).not.toContain(secret);
        expect(headersWithoutSetCookie, `${name} in a header of ${label}`).not.toContain(secret);
      }
      // The CSRF token belongs in the /csrf body only.
      if (res !== csrf) expect(res.text, label).not.toContain(c.csrf.token);
      expect(res.headers['cache-control'], label).toBe('no-store');
    }
  });

  it('accepts the access cookie until its exp and refuses it from exp on', async () => {
    const { app } = setup();
    const c = await authClient(app);
    const session = await logIn(c);

    setNow(new Date(T0.getTime() + ACCESS_TTL_MS - 1000));
    expect((await meWith(c, session)).status).toBe(200);

    setNow(new Date(T0.getTime() + ACCESS_TTL_MS));
    const res = await meWith(c, session);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
  });

  it('after the access cookie expires, /me is 401, refresh issues a new one, and /me works again', async () => {
    const { app, admin } = setup();
    const c = await authClient(app);
    const first = await logIn(c);

    advance(ACCESS_TTL_MS + 1000);
    expect((await meWith(c, first)).status).toBe(401);

    const refresh = await refreshWith(c, first);
    expect(refresh.status).toBe(200);
    expectSessionCookies(refresh, new Date(T0.getTime() + REFRESH_TTL_MS));
    const second = sessionFrom(refresh);

    const me = await meWith(c, second);
    expect(me.status).toBe(200);
    expect(me.body).toEqual(profileOf(admin));
  });

  it('an expired refresh cookie gets 401 and the cookies are cleared', async () => {
    const { app, db } = setup();
    const c = await authClient(app);
    const session = await logIn(c);

    setNow(new Date(T0.getTime() + REFRESH_TTL_MS));
    const res = await refreshWith(c, session);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
    expectAuthCookiesCleared(res);
    expect(db.refreshTokens).toHaveLength(1);
    expect(auditActions(db)).toEqual(['LOGIN']);
  });

  it('the refresh cookie still works 1 ms before its absolute expiry', async () => {
    const { app } = setup();
    const c = await authClient(app);
    const session = await logIn(c);

    setNow(new Date(T0.getTime() + REFRESH_TTL_MS - 1));
    expect((await refreshWith(c, session)).status).toBe(200);
  });

  it('rotating repeatedly never extends the session past login time + refreshTokenTtlHours', async () => {
    const { app, db } = setup();
    const c = await authClient(app);
    const sessionEnd = new Date(T0.getTime() + REFRESH_TTL_MS);
    let session = await logIn(c);

    for (const hours of [1, 24, 100, config.auth.refreshTokenTtlHours - 1]) {
      setNow(new Date(T0.getTime() + hours * HOUR_MS));
      const res = await refreshWith(c, session);
      expect(res.status).toBe(200);
      expectSessionCookies(res, sessionEnd);
      session = sessionFrom(res);
    }

    expect(db.refreshTokens).toHaveLength(5);
    expect(new Set(db.refreshTokens.map((t) => t.familyId)).size).toBe(1);
    for (const token of db.refreshTokens) expect(token.expiresAt).toEqual(sessionEnd);

    setNow(sessionEnd);
    const res = await refreshWith(c, session);
    expect(res.status).toBe(401);
    expectAuthCookiesCleared(res);
  });
});

// ---------------------------------------------------------------------------

describe('Done when 2: repeated failed logins lock the account temporarily', () => {
  it(`locks the account after ${MAX_FAILED} wrong passwords: the correct password then gets the identical 401`, async () => {
    const { app, db, admin } = setup({ config: relaxedLoginLimit });
    const c = await authClient(app);

    const refusals: request.Response[] = [];
    for (let i = 0; i < MAX_FAILED; i++) refusals.push(await attemptLogin(c, WRONG_PASSWORD));
    for (const res of refusals) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_CREDENTIALS_BODY);
      expectNoCookies(res);
    }
    expect(stored(db, admin.id)).toMatchObject({
      failedLoginCount: MAX_FAILED,
      lockedUntil: new Date(T0.getTime() + LOCKOUT_MS),
    });

    const locked = await attemptLogin(c, PASSWORD);

    for (const res of refusals) expect(comparable(locked)).toEqual(comparable(res));
    expectNoCookies(locked);
    expect(db.refreshTokens).toHaveLength(0);
    expect(auditCount(db, 'ACCOUNT_LOCKED')).toBe(1);
    expect(db.auditLogs.find((l) => l.action === 'ACCOUNT_LOCKED')?.details).toEqual({
      failedLoginCount: MAX_FAILED,
      lockedUntil: new Date(T0.getTime() + LOCKOUT_MS).toISOString(),
      lockoutMinutes: config.auth.loginLockoutMinutes,
    });
    expect(reasonOf(db.auditLogs.at(-1)?.details)).toBe('locked');
  });

  it('keeps refusing the correct password until the last millisecond, without counting or re-locking', async () => {
    const { app, db, admin } = setup({ config: relaxedLoginLimit });
    const c = await authClient(app);
    await lockAccount(c);

    setNow(new Date(T0.getTime() + LOCKOUT_MS - 1));
    const res = await attemptLogin(c, PASSWORD);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(INVALID_CREDENTIALS_BODY);
    expect(stored(db, admin.id).failedLoginCount).toBe(MAX_FAILED);
    expect(stored(db, admin.id).lockedUntil).toEqual(new Date(T0.getTime() + LOCKOUT_MS));
    expect(auditCount(db, 'ACCOUNT_LOCKED')).toBe(1);
  });

  it('lets the correct password in once the lockout has passed, and resets the counter', async () => {
    const { app, db, admin } = setup({ config: relaxedLoginLimit });
    const c = await authClient(app);
    await lockAccount(c);

    const unlockAt = new Date(T0.getTime() + LOCKOUT_MS);
    setNow(unlockAt);
    const res = await attemptLogin(c, PASSWORD);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(profileOf(admin));
    expectSessionCookies(res, new Date(unlockAt.getTime() + REFRESH_TTL_MS));
    expect(stored(db, admin.id)).toMatchObject({
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: unlockAt,
    });
  });

  it('counts from zero after an expired lockout instead of re-locking on the next wrong password', async () => {
    const { app, db, admin } = setup({ config: relaxedLoginLimit });
    const c = await authClient(app);
    await lockAccount(c);

    advance(LOCKOUT_MS + MINUTE_MS);
    expect((await attemptLogin(c, WRONG_PASSWORD)).status).toBe(401);

    expect(stored(db, admin.id)).toMatchObject({ failedLoginCount: 1, lockedUntil: null });
    expect(auditCount(db, 'ACCOUNT_LOCKED')).toBe(1);
    expect((await attemptLogin(c, PASSWORD)).status).toBe(200);
  });

  it('a successful login before the limit resets the counter, so the next wrong passwords start over', async () => {
    const { app, db, admin } = setup({ config: relaxedLoginLimit });
    const c = await authClient(app);

    for (let i = 0; i < MAX_FAILED - 1; i++) await attemptLogin(c, WRONG_PASSWORD);
    await logIn(c);
    for (let i = 0; i < MAX_FAILED - 1; i++) await attemptLogin(c, WRONG_PASSWORD);

    expect(stored(db, admin.id)).toMatchObject({
      failedLoginCount: MAX_FAILED - 1,
      lockedUntil: null,
    });
    expect(auditCount(db, 'ACCOUNT_LOCKED')).toBe(0);
  });

  it('the per-IP login limiter answers 429 on its own, before the account lockout is reached', async () => {
    const limit = 3;
    expect(limit).toBeLessThan(MAX_FAILED);
    const { app, db, admin } = setup({
      config: {
        auth: { ...config.auth, loginRateLimit: { windowMs: 15 * MINUTE_MS, max: limit } },
      },
    });
    const c = await authClient(app);

    for (let i = 0; i < limit; i++)
      expect((await attemptLogin(c, WRONG_PASSWORD)).status).toBe(401);
    const res = await attemptLogin(c, PASSWORD);

    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many requests, try again later' },
    });
    expectNoCookies(res);
    expect(stored(db, admin.id)).toMatchObject({ failedLoginCount: limit, lockedUntil: null });
    expect(auditCount(db, 'ACCOUNT_LOCKED')).toBe(0);
    expect(db.spies.admin.findUnique).toHaveBeenCalledTimes(limit);
  });

  it('the lockout is per account: failures spread over several IPs still lock it, everywhere', async () => {
    const { app, db, admin } = setup({
      config: {
        trustProxy: 1,
        auth: { ...config.auth, loginRateLimit: { windowMs: 15 * MINUTE_MS, max: 3 } },
      },
    });
    const first = await authClient(app, { ip: '203.0.113.10' });
    const second = await authClient(app, { ip: '198.51.100.20' });
    const third = await authClient(app, { ip: '192.0.2.30' });

    for (let i = 0; i < 3; i++) await attemptLogin(first, WRONG_PASSWORD);
    // That IP is now rate limited, independently of the account.
    expect((await attemptLogin(first, PASSWORD)).status).toBe(429);
    for (let i = 0; i < MAX_FAILED - 3; i++) await attemptLogin(second, WRONG_PASSWORD);

    expect(stored(db, admin.id).failedLoginCount).toBe(MAX_FAILED);
    const res = await attemptLogin(third, PASSWORD);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(INVALID_CREDENTIALS_BODY);
    expect(auditCount(db, 'ACCOUNT_LOCKED')).toBe(1);
  });

  it('unknown email, wrong password, locked and deactivated accounts get byte-identical responses', async () => {
    const locked = testAdmin({
      email: 'locked@skcinema.lk',
      passwordHash,
      failedLoginCount: MAX_FAILED,
      lockedUntil: new Date(T0.getTime() + LOCKOUT_MS),
    });
    const inactive = testAdmin({ email: 'gone@skcinema.lk', passwordHash, isActive: false });
    const { app } = setup({ others: [locked, inactive], config: relaxedLoginLimit });
    const c = await authClient(app);

    const unknown = await attemptLogin(c, PASSWORD, UNKNOWN_EMAIL);
    const wrong = await attemptLogin(c, WRONG_PASSWORD);
    const lockedRes = await attemptLogin(c, PASSWORD, locked.email);
    const inactiveRes = await attemptLogin(c, PASSWORD, inactive.email);

    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(INVALID_CREDENTIALS_BODY);
    expectNoCookies(unknown);
    for (const res of [wrong, lockedRes, inactiveRes]) {
      expect(comparable(res)).toEqual(comparable(unknown));
    }
  });
});

// ---------------------------------------------------------------------------

describe('Done when 3: deactivated admins cannot log in or refresh', () => {
  it('refuses a deactivated admin with the correct password: same 401, no session, attempt not counted', async () => {
    const { app, db, admin } = setup({ admin: { isActive: false } });
    const c = await authClient(app);

    const res = await attemptLogin(c, PASSWORD);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(INVALID_CREDENTIALS_BODY);
    expectNoCookies(res);
    expect(db.refreshTokens).toHaveLength(0);
    expect(stored(db, admin.id)).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    expect(db.auditLogs.map((l) => [l.action, reasonOf(l.details)])).toEqual([
      ['LOGIN_FAILED', 'inactive'],
    ]);
  });

  it('an admin deactivated mid-session is refused by /me on the very next request', async () => {
    const { app, db, admin } = setup();
    const c = await authClient(app);
    const session = await logIn(c);
    expect((await meWith(c, session)).status).toBe(200);

    stored(db, admin.id).isActive = false;
    const res = await meWith(c, session);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
  });

  it('refresh after deactivation is refused, clears the cookies and revokes the whole family', async () => {
    const { app, db, admin } = setup();
    const c = await authClient(app);
    const first = await logIn(c);
    const second = sessionFrom(await refreshWith(c, first));
    advance(MINUTE_MS);

    stored(db, admin.id).isActive = false;
    const res = await refreshWith(c, second);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
    expectAuthCookiesCleared(res);
    expect(db.refreshTokens).toHaveLength(2);
    for (const token of db.refreshTokens) expect(token.revokedAt).not.toBeNull();
    expect(db.refreshTokens.at(-1)?.revokedAt).toEqual(new Date(T0.getTime() + MINUTE_MS));
  });

  it('re-activating the admin does not revive the revoked refresh token; a new login is needed', async () => {
    const { app, db, admin } = setup();
    const c = await authClient(app);
    const session = await logIn(c);
    stored(db, admin.id).isActive = false;
    expect((await refreshWith(c, session)).status).toBe(401);

    stored(db, admin.id).isActive = true;
    const res = await refreshWith(c, session);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
    expectAuthCookiesCleared(res);
    // A token revoked without a successor is not a replay, so this is not audited as reuse.
    expect(auditCount(db, 'TOKEN_REUSE_DETECTED')).toBe(0);
    await logIn(c);
  });

  it('re-activation does not revive the pre-deactivation access cookie once its session was ended', async () => {
    // The access token carries its refresh family as `sid`; the refused refresh after
    // deactivation revoked that family, so requireAuth keeps refusing the token.
    const { app, db, admin } = setup();
    const c = await authClient(app);
    const session = await logIn(c);
    stored(db, admin.id).isActive = false;
    expect((await meWith(c, session)).status).toBe(401);
    expect((await refreshWith(c, session)).status).toBe(401);

    stored(db, admin.id).isActive = true;
    const res = await meWith(c, session);

    expect(res.status).toBe(401);
    expect(comparable(res)).toEqual(comparable(await c.get('/me')));
  });

  it('deactivate -> refresh ends the session -> re-activate: every old access cookie of that session is refused, a new login works', async () => {
    const { app, db, admin } = setup();
    const c = await authClient(app);
    const first = await logIn(c);
    advance(MINUTE_MS);
    const second = sessionFrom(await refreshWith(c, first));
    expect((await meWith(c, first)).status).toBe(200);
    expect((await meWith(c, second)).status).toBe(200);

    stored(db, admin.id).isActive = false;
    const ended = await refreshWith(c, second);
    expect(ended.status).toBe(401);
    expectAuthCookiesCleared(ended);
    expect(db.refreshTokens.every((t) => t.revokedAt !== null)).toBe(true);

    stored(db, admin.id).isActive = true;
    for (const old of [first, second]) {
      const res = await meWith(c, old);
      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED_BODY);
    }
    expect((await meWith(c, await logIn(c))).status).toBe(200);
  });

  it('DOCUMENTS CURRENT BEHAVIOUR (Phase 7): re-activation before the session was ended revives the access cookie', async () => {
    // Deactivation itself does not revoke refresh families yet; only a refused refresh does.
    // So if nothing touched the session while the admin was inactive, the family is still
    // live and the access cookie works again on re-activation (until its exp). Phase 7
    // (deactivating admins) must revoke all of the admin's families; then flip this test.
    const { app, db, admin } = setup();
    const c = await authClient(app);
    const session = await logIn(c);
    stored(db, admin.id).isActive = false;
    expect((await meWith(c, session)).status).toBe(401);

    stored(db, admin.id).isActive = true;
    expect((await meWith(c, session)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe('refresh token reuse', () => {
  it('replaying a rotated refresh token revokes the whole family: the replay and the current token both get 401', async () => {
    const { app, db, admin } = setup();
    const c = await authClient(app);
    const tokenA = await logIn(c);
    const tokenB = sessionFrom(await refreshWith(c, tokenA));

    const replay = await refreshWith(c, tokenA);
    expect(replay.status).toBe(401);
    expect(replay.body).toEqual(UNAUTHORIZED_BODY);
    expectAuthCookiesCleared(replay);

    const current = await refreshWith(c, tokenB);
    expect(current.status).toBe(401);
    expect(current.body).toEqual(UNAUTHORIZED_BODY);

    expect(auditCount(db, 'TOKEN_REUSE_DETECTED')).toBe(1);
    const reuse = db.auditLogs.find((l) => l.action === 'TOKEN_REUSE_DETECTED');
    expect(reuse).toMatchObject({ adminId: admin.id });
    // tokenB was still live, so the replay revoked one token: a live-family theft.
    expect(reuse?.details).toEqual({ familyId: db.refreshTokens[0]?.familyId, revokedCount: 1 });
    expect(db.refreshTokens.every((t) => t.revokedAt !== null)).toBe(true);
    // Reuse ends the stolen family only; the account itself is not locked.
    await logIn(c);
  });

  it('a temporary lock deliberately does not end a live session: refresh and /me keep working', async () => {
    // Anyone who knows an admin's email can trigger a lock, so it must not log real admins out.
    const { app, db, admin } = setup({ config: relaxedLoginLimit });
    const owner = await authClient(app);
    const attacker = await authClient(app);
    const session = await logIn(owner);

    await lockAccount(attacker);
    expect(stored(db, admin.id).lockedUntil).not.toBeNull();

    expect((await meWith(owner, session)).status).toBe(200);
    const refresh = await refreshWith(owner, session);
    expect(refresh.status).toBe(200);
    expect((await meWith(owner, sessionFrom(refresh))).status).toBe(200);
    // ...but a new login is still refused while the lock lasts.
    expect((await attemptLogin(owner, PASSWORD)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------

describe('role enforcement with real login cookies', () => {
  /**
   * createApp has no role-restricted route yet, so a test-only one is mounted in front of it,
   * sharing the store, so it sees the cookies that the real login issued.
   */
  function appWithSuperAdminRoute(db: InMemoryAuthDb, inner: Express): Express {
    const outer = express();
    outer.use(
      `${ADMIN_BASE}/test-only/super`,
      requestLogger(silentLogger),
      cookieParser(),
      requireAuth({ db: db.prisma, config }),
      requireRole('SUPER_ADMIN'),
      (req: express.Request, res: express.Response) => {
        res.json({ admin: req.admin });
      },
      errorHandler,
    );
    outer.use(inner);
    return outer;
  }

  const superAdmin = () =>
    testAdmin({ email: 'super@skcinema.lk', passwordHash, role: 'SUPER_ADMIN' });

  it('lets a logged-in SUPER_ADMIN through and answers an EDITOR with 403 FORBIDDEN', async () => {
    const boss = superAdmin();
    const { app, db } = setup({ others: [boss] });
    const outer = appWithSuperAdminRoute(db, app);
    const c = await authClient(outer);
    const editorSession = await logIn(c);
    const superSession = await logIn(c, boss.email);

    const allowed = await c.get('/test-only/super', [superSession.access]);
    const refused = await c.get('/test-only/super', [editorSession.access]);
    const anonymous = await c.get('/test-only/super');

    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ admin: { id: boss.id, role: 'SUPER_ADMIN' } });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual(FORBIDDEN_BODY);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toEqual(UNAUTHORIZED_BODY);
  });

  it('a SUPER_ADMIN demoted mid-session gets 403 on the next request, with the same cookie', async () => {
    const boss = superAdmin();
    const { app, db } = setup({ others: [boss] });
    const c = await authClient(appWithSuperAdminRoute(db, app));
    const session = await logIn(c, boss.email);
    expect((await c.get('/test-only/super', [session.access])).status).toBe(200);

    stored(db, boss.id).role = 'EDITOR';
    const res = await c.get('/test-only/super', [session.access]);

    expect(res.status).toBe(403);
    expect(res.body).toEqual(FORBIDDEN_BODY);
  });
});

// ---------------------------------------------------------------------------

describe('CSRF over HTTP', () => {
  it('cross-origin login attempts get 403 before the service runs: no audit row, no counter change', async () => {
    const { app, db, admin } = setup({ config: relaxedLoginLimit });
    const c = await authClient(app);

    // Even with the right password, and as many tries as would otherwise lock the account.
    for (const password of [
      PASSWORD,
      ...Array.from({ length: MAX_FAILED }, () => WRONG_PASSWORD),
    ]) {
      const res = await c.post('/auth/login', {
        body: { email: EMAIL, password },
        origin: 'https://evil.example',
      });
      expect(res.status).toBe(403);
      expect(res.body).toEqual(CSRF_BODY);
      expectNoCookies(res);
    }

    expect(db.spies.admin.findUnique).not.toHaveBeenCalled();
    expect(db.auditLogs).toEqual([]);
    expect(stored(db, admin.id)).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    expect(db.refreshTokens).toEqual([]);
  });

  it("one browser's CSRF token does not work with another browser's CSRF cookie", async () => {
    const { app, db } = setup();
    const browserA = await authClient(app);
    const browserB = await authClient(app);
    expect(browserA.csrf.cookieValue).not.toBe(browserB.csrf.cookieValue);

    const crossed = await browserA.post('/auth/login', {
      body: { email: EMAIL, password: PASSWORD },
      token: browserB.csrf.token,
    });
    expect(crossed.status).toBe(403);
    expect(crossed.body).toEqual(CSRF_BODY);
    expect(db.spies.admin.findUnique).not.toHaveBeenCalled();

    // Each browser's own pair works.
    await logIn(browserA);
    await logIn(browserB);
  });
});

// ---------------------------------------------------------------------------

describe('logout and access tokens', () => {
  it('after logout, a copied old access cookie gets the identical 401 on /me immediately', async () => {
    // The access token carries its refresh family as `sid`; logout revokes the family, so
    // requireAuth refuses the token at once instead of at its exp.
    const { app } = setup();
    const c = await authClient(app);
    const session = await logIn(c);
    const other = await logIn(c);
    expect((await meWith(c, session)).status).toBe(200);
    expect((await c.post('/auth/logout', { cookies: [session.refresh] })).status).toBe(204);

    const res = await meWith(c, session);

    expect(res.status).toBe(401);
    expect(comparable(res)).toEqual(comparable(await c.get('/me')));
    expect((await refreshWith(c, session)).status).toBe(401);
    // Another session of the same admin is untouched.
    expect((await meWith(c, other)).status).toBe(200);
  });

  it('after reuse detection, the already-issued access cookies get the identical 401 immediately', async () => {
    const { app } = setup();
    const c = await authClient(app);
    const tokenA = await logIn(c);
    const tokenB = sessionFrom(await refreshWith(c, tokenA));
    expect((await meWith(c, tokenB)).status).toBe(200);
    expect((await refreshWith(c, tokenA)).status).toBe(401);

    const anonymous = comparable(await c.get('/me'));
    for (const session of [tokenB, tokenA]) {
      const res = await meWith(c, session);
      expect(res.status).toBe(401);
      expect(comparable(res)).toEqual(anonymous);
    }
  });

  it('after a normal rotation the pre-rotation access cookie keeps working until its own exp', async () => {
    // Rotation revokes the parent but leaves a live child in the family, so the session is alive.
    const { app } = setup();
    const c = await authClient(app);
    const first = await logIn(c);
    advance(MINUTE_MS);
    const second = sessionFrom(await refreshWith(c, first));

    expect((await meWith(c, first)).status).toBe(200);
    setNow(new Date(T0.getTime() + ACCESS_TTL_MS - 1000));
    expect((await meWith(c, first)).status).toBe(200);

    setNow(new Date(T0.getTime() + ACCESS_TTL_MS));
    const res = await meWith(c, first);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
    // Issued a minute later, the rotated cookie is still inside its own lifetime.
    expect((await meWith(c, second)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe('log hygiene', () => {
  /** A raw pino logger at debug level, without the app logger's redaction, so leaks show. */
  function captureLogs() {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    return { logger: pino({ level: 'debug' }, stream), lines };
  }

  it('never logs the password, email, tokens, token hashes or CSRF values during a whole journey', async () => {
    const { logger, lines } = captureLogs();
    const { app, db } = setup({ logger, config: relaxedLoginLimit });
    const c = await authClient(app);
    let requests = 1;
    const count = <T>(res: T) => {
      requests++;
      return res;
    };

    count(await attemptLogin(c, PASSWORD, UNKNOWN_EMAIL));
    count(await attemptLogin(c, WRONG_PASSWORD));
    count(
      await c.post('/auth/login', { body: { email: EMAIL, password: PASSWORD, extra: PASSWORD } }),
    );
    count(await c.post('/auth/login', { body: { email: EMAIL, password: PASSWORD }, token: null }));
    const first = sessionFrom(count(await attemptLogin(c)));
    count(await meWith(c, first));
    count(await c.get('/me'));
    const second = sessionFrom(count(await refreshWith(c, first)));
    count(await refreshWith(c, first)); // reuse
    count(await c.post('/auth/logout', { cookies: [second.access, second.refresh] }));
    advance(ACCESS_TTL_MS);
    count(await meWith(c, second)); // expired

    const log = lines.join('');
    // Sanity: the capture saw every request, and debug lines too.
    expect(lines.filter((l) => l.includes('"msg":"request completed"'))).toHaveLength(requests);
    expect(log).toContain('"reason":"token_mismatch"');
    expect(log).toContain('"reason":"no_cookie"');

    const secrets = {
      password: PASSWORD,
      'wrong password': WRONG_PASSWORD,
      email: EMAIL,
      'unknown email': UNKNOWN_EMAIL,
      'password hash': passwordHash,
      'CSRF token': c.csrf.token,
      'CSRF cookie': c.csrf.cookieValue,
      'JWT secret': config.auth.jwtAccessSecret,
      'CSRF secret': config.auth.csrfSecret,
      ...Object.fromEntries(
        [first, second].flatMap((s, i) => [
          [`access token ${i}`, s.accessValue],
          [`access token signature ${i}`, s.accessValue.split('.')[2] ?? ''],
          [`refresh token ${i}`, s.refreshValue],
        ]),
      ),
      ...Object.fromEntries(db.refreshTokens.map((t, i) => [`token hash ${i}`, t.tokenHash])),
    };
    for (const [name, secret] of Object.entries(secrets)) {
      expect(secret).not.toBe('');
      expect(log, name).not.toContain(secret);
    }
    for (const cookieName of [ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME]) {
      expect(log).not.toContain(cookieName);
    }
  });
});

// ---------------------------------------------------------------------------

describe('audit trail', () => {
  it('records the exact ordered audit trail for a scripted sequence, without any secret', async () => {
    const { app, db, admin } = setup({ config: relaxedLoginLimit });
    const c = await authClient(app);

    await attemptLogin(c, PASSWORD, UNKNOWN_EMAIL);
    await lockAccount(c);
    await attemptLogin(c, PASSWORD); // refused while locked
    advance(LOCKOUT_MS);
    const tokenA = await logIn(c);
    const tokenB = sessionFrom(await refreshWith(c, tokenA));
    expect((await refreshWith(c, tokenA)).status).toBe(401); // reuse
    const tokenC = await logIn(c);
    expect((await c.post('/auth/logout', { cookies: [tokenC.refresh] })).status).toBe(204);

    const failed = (reason: string) => ['LOGIN_FAILED', admin.id, reason];
    expect(db.auditLogs.map((l) => [l.action, l.adminId, reasonOf(l.details)])).toEqual([
      ['LOGIN_FAILED', null, 'unknown_email'],
      ...Array.from({ length: MAX_FAILED - 1 }, () => failed('bad_password')),
      ['ACCOUNT_LOCKED', admin.id, undefined],
      failed('bad_password'),
      failed('locked'),
      ['LOGIN', admin.id, undefined],
      ['TOKEN_REUSE_DETECTED', admin.id, undefined],
      ['LOGIN', admin.id, undefined],
      ['LOGOUT', admin.id, undefined],
    ]);
    const familyA = db.refreshTokens[0]?.familyId;
    expect(familyA).toBeDefined();
    expect(db.auditLogs.find((l) => l.action === 'TOKEN_REUSE_DETECTED')?.details).toEqual({
      familyId: familyA,
      revokedCount: 1,
    });
    for (const row of db.auditLogs) {
      expect(row).toMatchObject({
        entity: 'Admin',
        entityId: row.adminId,
        userAgent: TEST_USER_AGENT,
        ipAddress: expect.stringMatching(/127\.0\.0\.1|::1/) as unknown,
      });
    }

    const serialised = JSON.stringify(db.auditLogs);
    const secrets = [
      PASSWORD,
      WRONG_PASSWORD,
      UNKNOWN_EMAIL,
      EMAIL,
      passwordHash,
      c.csrf.token,
      c.csrf.cookieValue,
      ...[tokenA, tokenB, tokenC].flatMap((s) => [s.accessValue, s.refreshValue]),
      ...db.refreshTokens.map((t) => t.tokenHash),
    ];
    for (const secret of secrets) expect(serialised).not.toContain(secret);
  });
});
