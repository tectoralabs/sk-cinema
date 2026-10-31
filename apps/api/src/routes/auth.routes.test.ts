import {
  adminProfileResponseSchema,
  apiErrorSchema,
  csrfTokenResponseSchema,
} from '@sk-cinema/shared';
import { Writable } from 'node:stream';
import type { Express } from 'express';
import { pino, type Logger } from 'pino';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/env.js';
import type { Admin } from '../generated/prisma/client.js';
import {
  ACCESS_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
} from '../lib/authCookies.js';
import { hashPassword } from '../lib/password.js';
import { REFRESH_RATE_LIMIT } from '../middleware/rateLimiter.js';
import { INVALID_CREDENTIALS_MESSAGE, SESSION_EXPIRED_MESSAGE } from '../services/auth.service.js';
import {
  ADMIN_BASE,
  PUBLIC_ORIGIN,
  TEST_USER_AGENT,
  authClient,
  buildTestApp,
  cookiePair,
  fetchCsrf,
  inMemoryAuthDb,
  parseSetCookies,
  sessionFrom,
  testAdmin,
  testConfig,
  type AuthClient,
  type InMemoryAuthDb,
  type SendOptions,
  type Session,
} from '../test/helpers.js';

const BASE = ADMIN_BASE;
const EMAIL = 'editor@skcinema.lk';
const PASSWORD = 'correct horse battery staple';
const WRONG_PASSWORD = 'Tr0ub4dor&3-wrong-guess';
const EPOCH_EXPIRES = new Date(1).toUTCString();

const UNAUTHORIZED_BODY = { error: { code: 'UNAUTHORIZED', message: SESSION_EXPIRED_MESSAGE } };
const INVALID_CREDENTIALS_BODY = {
  error: { code: 'INVALID_CREDENTIALS', message: INVALID_CREDENTIALS_MESSAGE },
};
const CSRF_BODY = { error: { code: 'CSRF_INVALID', message: 'CSRF validation failed' } };

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

afterEach(() => {
  vi.useRealTimers();
});

interface Setup {
  app: Express;
  db: InMemoryAuthDb;
  admin: Admin;
}

function setup(
  options: { admin?: Partial<Admin>; config?: Partial<Config>; logger?: Logger } = {},
): Setup {
  const admin = testAdmin({ email: EMAIL, passwordHash, ...options.admin });
  const db = inMemoryAuthDb({ admins: [admin] });
  const { app } = buildTestApp({
    prisma: db.prisma,
    ...(options.config && { config: options.config }),
    ...(options.logger && { logger: options.logger }),
  });
  return { app, db, admin };
}

/** A raw pino logger (no app redaction, so leaks would show) writing parsed lines to an array. */
function captureLogs() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = pino({ level: 'debug' }, stream);
  const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { logger, lines, parsed };
}

/** The stored row, looked up by id (the store keeps row objects across rollbacks). */
function storedAdmin(db: InMemoryAuthDb, id: string): Admin {
  const row = db.admins.find((a) => a.id === id);
  if (!row) throw new Error('admin not found');
  return row;
}

async function logIn(c: AuthClient): Promise<Session> {
  const res = await c.post('/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  expect(res.status).toBe(200);
  return sessionFrom(res);
}

const setCookieNames = (res: request.Response) => Object.keys(parseSetCookies(res));

function expectAuthCookiesCleared(res: request.Response) {
  const cookies = parseSetCookies(res);
  expect(cookies[ACCESS_COOKIE_NAME]).toEqual({
    value: '',
    attributes: {
      path: '/',
      expires: EPOCH_EXPIRES,
      httponly: true,
      secure: true,
      samesite: 'Strict',
    },
  });
  expect(cookies[REFRESH_COOKIE_NAME]).toEqual({
    value: '',
    attributes: {
      path: REFRESH_COOKIE_PATH,
      expires: EPOCH_EXPIRES,
      httponly: true,
      secure: true,
      samesite: 'Strict',
    },
  });
}

function expectNoAuthCookiesSet(res: request.Response) {
  expect(setCookieNames(res)).not.toContain(ACCESS_COOKIE_NAME);
  expect(setCookieNames(res)).not.toContain(REFRESH_COOKIE_NAME);
}

/** The body may only be `{ admin }`, with no token or hash anywhere in it. */
function expectProfileOnly(res: request.Response, admin: Admin, db: InMemoryAuthDb) {
  expect(res.body).toEqual({
    admin: {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      mustChangePassword: admin.mustChangePassword,
    },
  });
  adminProfileResponseSchema.parse(res.body);
  const session = sessionFrom(res);
  expect(res.text).not.toContain(session.accessValue);
  expect(res.text).not.toContain(session.refreshValue);
  expect(res.text).not.toContain(passwordHash);
  for (const token of db.refreshTokens) expect(res.text).not.toContain(token.tokenHash);
}

describe('GET /api/admin/auth/csrf', () => {
  it('returns a token and sets the CSRF cookie, without needing a session', async () => {
    const { app } = setup();
    const res = await request(app).get(`${BASE}/auth/csrf`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(csrfTokenResponseSchema.parse(res.body).csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(parseSetCookies(res)[CSRF_COOKIE_NAME]).toEqual({
      value: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
      attributes: { path: '/', httponly: true, secure: true, samesite: 'Strict' },
    });
  });

  it('reuses an existing CSRF cookie, so every tab shares one token', async () => {
    const { app } = setup();
    const first = await fetchCsrf(app);
    const res = await request(app).get(`${BASE}/auth/csrf`).set('Cookie', first.cookie);

    expect(res.status).toBe(200);
    expect(csrfTokenResponseSchema.parse(res.body).csrfToken).toBe(first.token);
    expect(setCookieNames(res)).not.toContain(CSRF_COOKIE_NAME);
  });
});

describe('POST /api/admin/auth/login', () => {
  it('returns only { admin } and sets the session cookies', async () => {
    const { app, db, admin } = setup();
    const c = await authClient(app);
    const res = await c.post('/auth/login', { body: { email: EMAIL, password: PASSWORD } });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expectProfileOnly(res, admin, db);
    expect(db.refreshTokens).toHaveLength(1);
    expect(db.auditLogs.map((l) => l.action)).toEqual(['LOGIN']);
  });

  it('sets the access and refresh cookies with exact flags and paths', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = new Date('2026-11-01T04:30:00.000Z');
    vi.setSystemTime(now);
    const { app } = setup();
    const config = testConfig();
    const c = await authClient(app);

    const res = await c.post('/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    const cookies = parseSetCookies(res);
    const accessMs = config.auth.accessTokenTtlSeconds * 1000;
    const refreshMs = config.auth.refreshTokenTtlHours * 3_600_000;

    expect(Object.keys(cookies).sort()).toEqual([ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME].sort());
    expect(cookies[ACCESS_COOKIE_NAME]?.attributes).toEqual({
      'max-age': String(accessMs / 1000),
      path: '/',
      expires: new Date(now.getTime() + accessMs).toUTCString(),
      httponly: true,
      secure: true,
      samesite: 'Strict',
    });
    expect(cookies[REFRESH_COOKIE_NAME]?.attributes).toEqual({
      'max-age': String(refreshMs / 1000),
      path: '/api/admin/auth',
      expires: new Date(now.getTime() + refreshMs).toUTCString(),
      httponly: true,
      secure: true,
      samesite: 'Strict',
    });
  });

  it('records the client IP and user agent on the session', async () => {
    const { app, db } = setup();
    await logIn(await authClient(app));

    expect(db.refreshTokens[0]?.userAgent).toBe(TEST_USER_AGENT);
    expect(db.refreshTokens[0]?.ipAddress).toMatch(/127\.0\.0\.1|::1/);
  });

  it('normalises the email before looking the admin up', async () => {
    const { app } = setup();
    const c = await authClient(app);
    const res = await c.post('/auth/login', {
      body: { email: '  Editor@SKCinema.LK ', password: PASSWORD },
    });
    expect(res.status).toBe(200);
  });

  describe('validation', () => {
    it.each([
      ['a missing email', { password: PASSWORD }],
      ['a malformed email', { email: 'not-an-email', password: PASSWORD }],
      ['a missing password', { email: EMAIL }],
      ['a password over 128 characters', { email: EMAIL, password: `${PASSWORD}-`.repeat(5) }],
      ['an unknown key', { email: EMAIL, password: PASSWORD, remember: true }],
      ['an empty body', {}],
      ['an array body', [PASSWORD]],
    ])('rejects %s with 400 and never echoes the password', async (_name, body) => {
      const { app, db } = setup();
      const c = await authClient(app);
      const res = await c.post('/auth/login', { body });

      expect(res.status).toBe(400);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(apiErrorSchema.parse(res.body).error.code).toBe('VALIDATION_ERROR');
      expect(res.text).not.toContain(PASSWORD);
      expectNoAuthCookiesSet(res);
      expect(db.spies.admin.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a request with no body', async () => {
      const { app, db } = setup();
      const res = await (await authClient(app)).post('/auth/login');

      expect(res.status).toBe(400);
      expect(apiErrorSchema.parse(res.body).error.code).toBe('VALIDATION_ERROR');
      expect(db.spies.admin.findUnique).not.toHaveBeenCalled();
    });

    it('reports field paths and messages only, never input values', async () => {
      const { app } = setup();
      const res = await (
        await authClient(app)
      ).post('/auth/login', { body: { email: 'bad', password: PASSWORD, extra: PASSWORD } });

      const details = apiErrorSchema.parse(res.body).error.details as {
        path: unknown[];
        message: string;
      }[];
      expect(details.length).toBeGreaterThan(0);
      for (const issue of details) {
        expect(Object.keys(issue).sort()).toEqual(['message', 'path']);
        expect(issue.path[0]).toBe('body');
      }
      expect(res.text).not.toContain(PASSWORD);
    });
  });

  describe('refused credentials', () => {
    it('answers a wrong password with 401 INVALID_CREDENTIALS and no auth cookies', async () => {
      const { app, admin, db } = setup();
      const res = await (
        await authClient(app)
      ).post('/auth/login', { body: { email: EMAIL, password: WRONG_PASSWORD } });

      expect(res.status).toBe(401);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual(INVALID_CREDENTIALS_BODY);
      expectNoAuthCookiesSet(res);
      expect(storedAdmin(db, admin.id).failedLoginCount).toBe(1);
    });

    it('answers an unknown email exactly like a wrong password', async () => {
      const { app } = setup();
      const res = await (
        await authClient(app)
      ).post('/auth/login', { body: { email: 'nobody@skcinema.lk', password: PASSWORD } });

      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_CREDENTIALS_BODY);
      expectNoAuthCookiesSet(res);
    });

    it('refuses a deactivated admin with the same 401', async () => {
      const { app } = setup({ admin: { isActive: false } });
      const res = await (
        await authClient(app)
      ).post('/auth/login', { body: { email: EMAIL, password: PASSWORD } });

      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_CREDENTIALS_BODY);
      expectNoAuthCookiesSet(res);
    });
  });

  describe('CSRF', () => {
    it.each<[string, SendOptions]>([
      ['no CSRF header', { token: null }],
      ['a wrong CSRF token', { token: 'A'.repeat(43) }],
      ['no CSRF cookie', { csrfCookie: false }],
      ['a foreign Origin', { origin: 'https://evil.example' }],
      // The public site is same-site, so it would carry the cookies: only ADMIN_ORIGINS count.
      ['the public site Origin with a valid token', { origin: PUBLIC_ORIGIN }],
      ['no Origin or Referer', { origin: null }],
    ])('rejects %s with 403 before the service runs', async (_name, options) => {
      const { app, db } = setup();
      const c = await authClient(app);
      const res = await c.post('/auth/login', {
        body: { email: EMAIL, password: PASSWORD },
        ...options,
      });

      expect(res.status).toBe(403);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual(CSRF_BODY);
      expectNoAuthCookiesSet(res);
      expect(db.spies.admin.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('rate limiting', () => {
    it('answers the 11th attempt from one IP within the window with 429', async () => {
      const { app, db } = setup();
      const c = await authClient(app);
      expect(testConfig().auth.loginRateLimit.max).toBe(10);

      for (let i = 0; i < 10; i++) {
        // Invalid bodies still count: the limiter runs before validation.
        expect((await c.post('/auth/login', { body: { email: 'x', password: 'y' } })).status).toBe(
          400,
        );
      }
      const res = await c.post('/auth/login', { body: { email: EMAIL, password: PASSWORD } });

      expect(res.status).toBe(429);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({
        error: { code: 'RATE_LIMITED', message: 'Too many requests, try again later' },
      });
      expectNoAuthCookiesSet(res);
      expect(db.spies.admin.findUnique).not.toHaveBeenCalled();
    });

    it('counts successful logins too', async () => {
      const auth = { ...testConfig().auth, loginRateLimit: { windowMs: 60_000, max: 2 } };
      const { app } = setup({ config: { auth } });
      const c = await authClient(app);

      await logIn(c);
      await logIn(c);
      const res = await c.post('/auth/login', { body: { email: EMAIL, password: PASSWORD } });

      expect(res.status).toBe(429);
    });

    it('limits only login, and each app instance counts on its own', async () => {
      const auth = { ...testConfig().auth, loginRateLimit: { windowMs: 60_000, max: 1 } };
      const { app } = setup({ config: { auth } });
      const c = await authClient(app);
      const session = await logIn(c);
      expect((await c.post('/auth/login', { body: {} })).status).toBe(429);

      // Other auth routes still work from the same IP.
      expect((await c.post('/auth/refresh', { cookies: [session.refresh] })).status).toBe(200);
      expect((await c.get('/auth/csrf')).status).toBe(200);

      // A second app has fresh counters.
      const other = setup({ config: { auth } });
      await logIn(await authClient(other.app));
    });
  });
});

describe('POST /api/admin/auth/refresh', () => {
  it('rotates the session and returns only { admin }', async () => {
    const { app, db, admin } = setup();
    const c = await authClient(app);
    const first = await logIn(c);

    const res = await c.post('/auth/refresh', { cookies: [first.refresh] });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expectProfileOnly(res, admin, db);
    const second = sessionFrom(res);
    expect(second.refreshValue).not.toBe(first.refreshValue);
    expect(second.accessValue).not.toBe(first.accessValue);
    const cookies = parseSetCookies(res);
    expect(cookies[ACCESS_COOKIE_NAME]?.attributes).toMatchObject({
      path: '/',
      httponly: true,
      secure: true,
      samesite: 'Strict',
    });
    expect(cookies[REFRESH_COOKIE_NAME]?.attributes).toMatchObject({
      path: REFRESH_COOKIE_PATH,
      httponly: true,
      secure: true,
      samesite: 'Strict',
    });

    // The new access cookie is a working session.
    expect((await c.get('/me', [second.access])).status).toBe(200);
  });

  it('keeps the original absolute expiry on the new refresh cookie', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const loginAt = new Date('2026-11-01T04:30:00.000Z');
    vi.setSystemTime(loginAt);
    const { app } = setup();
    const c = await authClient(app);
    const first = await logIn(c);

    vi.setSystemTime(new Date(loginAt.getTime() + 3_600_000));
    const res = await c.post('/auth/refresh', { cookies: [first.refresh] });

    const refreshMs = testConfig().auth.refreshTokenTtlHours * 3_600_000;
    expect(parseSetCookies(res)[REFRESH_COOKIE_NAME]?.attributes).toMatchObject({
      'max-age': String((refreshMs - 3_600_000) / 1000),
      expires: new Date(loginAt.getTime() + refreshMs).toUTCString(),
    });
  });

  it('accepts an explicit empty JSON body', async () => {
    const { app } = setup();
    const c = await authClient(app);
    const session = await logIn(c);
    const res = await c.post('/auth/refresh', { cookies: [session.refresh], body: {} });
    expect(res.status).toBe(200);
  });

  it('refuses a replayed (already rotated) refresh cookie and clears the cookies', async () => {
    const { app } = setup();
    const c = await authClient(app);
    const first = await logIn(c);
    expect((await c.post('/auth/refresh', { cookies: [first.refresh] })).status).toBe(200);

    const res = await c.post('/auth/refresh', { cookies: [first.refresh] });

    expect(res.status).toBe(401);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
    expectAuthCookiesCleared(res);
  });

  it('answers a missing refresh cookie with the same 401 and clears the cookies', async () => {
    const { app, db } = setup();
    const res = await (await authClient(app)).post('/auth/refresh');

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
    expectAuthCookiesCleared(res);
    expect(db.spies.refreshToken.findUnique).not.toHaveBeenCalled();
  });

  it('answers an unknown refresh cookie with the same 401', async () => {
    const { app } = setup();
    const res = await (
      await authClient(app)
    ).post('/auth/refresh', { cookies: [cookiePair(REFRESH_COOKIE_NAME, 'not-a-real-token')] });

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
    expectAuthCookiesCleared(res);
  });

  it('refuses a deactivated admin', async () => {
    const { app, db, admin } = setup();
    const c = await authClient(app);
    const session = await logIn(c);
    storedAdmin(db, admin.id).isActive = false;

    const res = await c.post('/auth/refresh', { cookies: [session.refresh] });

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
    expectAuthCookiesCleared(res);
  });

  it.each([
    ['an unknown key', { refreshToken: 'smuggled' }],
    ['an array body', []],
  ])('rejects %s in the body with 400 before the service runs', async (_name, body) => {
    const { app, db } = setup();
    const c = await authClient(app);
    const session = await logIn(c);
    db.spies.refreshToken.findUnique.mockClear();

    const res = await c.post('/auth/refresh', { cookies: [session.refresh], body });

    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(res.body).error.code).toBe('VALIDATION_ERROR');
    expect(db.spies.refreshToken.findUnique).not.toHaveBeenCalled();
  });

  it.each<[string, SendOptions]>([
    ['no CSRF header', { token: null }],
    ['a foreign Origin', { origin: 'https://evil.example' }],
    ['the public site Origin', { origin: PUBLIC_ORIGIN }],
  ])('rejects %s with 403 and leaves the session alone', async (_name, options) => {
    const { app, db } = setup();
    const c = await authClient(app);
    const session = await logIn(c);
    db.spies.refreshToken.findUnique.mockClear();

    const res = await c.post('/auth/refresh', { cookies: [session.refresh], ...options });

    expect(res.status).toBe(403);
    expect(res.body).toEqual(CSRF_BODY);
    expect(setCookieNames(res)).toEqual([]);
    expect(db.spies.refreshToken.findUnique).not.toHaveBeenCalled();
    expect((await c.post('/auth/refresh', { cookies: [session.refresh] })).status).toBe(200);
  });

  it(`answers attempt ${REFRESH_RATE_LIMIT.max + 1} from one IP within the window with 429`, async () => {
    const { app, db } = setup();
    const c = await authClient(app);
    expect(REFRESH_RATE_LIMIT).toEqual({ windowMs: 15 * 60_000, max: 60 });

    for (let i = 0; i < REFRESH_RATE_LIMIT.max; i++) {
      expect((await c.post('/auth/refresh')).status).toBe(401);
    }
    const res = await c.post('/auth/refresh');

    expect(res.status).toBe(429);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(apiErrorSchema.parse(res.body).error.code).toBe('RATE_LIMITED');
    expect(db.spies.refreshToken.findUnique).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/auth/logout', () => {
  it('revokes the session, clears both cookies and returns 204', async () => {
    const { app, db } = setup();
    const c = await authClient(app);
    const session = await logIn(c);

    const res = await c.post('/auth/logout', { cookies: [session.access, session.refresh] });

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(res.headers['cache-control']).toBe('no-store');
    expectAuthCookiesCleared(res);
    expect(db.auditLogs.map((l) => l.action)).toEqual(['LOGIN', 'LOGOUT']);

    const after = await c.post('/auth/refresh', { cookies: [session.refresh] });
    expect(after.status).toBe(401);
  });

  it('works without a valid access cookie, so an expired session can still log out', async () => {
    const { app, db } = setup();
    const c = await authClient(app);
    const session = await logIn(c);

    const res = await c.post('/auth/logout', {
      cookies: [cookiePair(ACCESS_COOKIE_NAME, 'expired.or.garbage'), session.refresh],
    });

    expect(res.status).toBe(204);
    expect(db.refreshTokens.every((t) => t.revokedAt !== null)).toBe(true);
  });

  it('returns 204 and clears cookies when there is no session at all', async () => {
    const { app } = setup();
    const res = await (await authClient(app)).post('/auth/logout');

    expect(res.status).toBe(204);
    expectAuthCookiesCleared(res);
  });

  it('still clears the cookies when the token lookup fails, and hides the error', async () => {
    const { app, db } = setup();
    const c = await authClient(app);
    const session = await logIn(c);
    db.spies.refreshToken.findUnique.mockRejectedValueOnce(new Error('connection lost: secret'));

    const res = await c.post('/auth/logout', { cookies: [session.refresh] });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
    });
    expectAuthCookiesCleared(res);
  });

  it('answers 500 and still clears the cookies when the revocation itself fails', async () => {
    const { app, db } = setup();
    const c = await authClient(app);
    const session = await logIn(c);
    db.spies.refreshToken.updateMany.mockRejectedValueOnce(new Error('connection lost: secret'));

    const res = await c.post('/auth/logout', { cookies: [session.access, session.refresh] });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
    });
    expect(res.text).not.toContain('connection lost');
    expectAuthCookiesCleared(res);
    expect(db.refreshTokens[0]?.revokedAt).toBeNull();
    expect(db.auditLogs.map((l) => l.action)).toEqual(['LOGIN']);
  });

  it('rejects a body with keys with 400', async () => {
    const { app, db } = setup();
    const res = await (await authClient(app)).post('/auth/logout', { body: { all: true } });

    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(res.body).error.code).toBe('VALIDATION_ERROR');
    expect(db.spies.refreshToken.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a request without CSRF with 403 and keeps the session', async () => {
    const { app, db } = setup();
    const c = await authClient(app);
    const session = await logIn(c);
    db.spies.refreshToken.findUnique.mockClear();

    const res = await c.post('/auth/logout', { cookies: [session.refresh], token: null });

    expect(res.status).toBe(403);
    expect(res.body).toEqual(CSRF_BODY);
    expect(setCookieNames(res)).toEqual([]);
    expect(db.spies.refreshToken.findUnique).not.toHaveBeenCalled();
    expect((await c.post('/auth/refresh', { cookies: [session.refresh] })).status).toBe(200);
  });
});

describe('database failures inside auth transactions', () => {
  const INTERNAL_ERROR_BODY = {
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
  };
  const SECRET_DETAIL = 'pg://admin:hunter2@db.internal';

  /** A Prisma-like failure whose message must never reach the client. */
  const dbFailure = (code?: string) =>
    Object.assign(new Error(`statement failed on ${SECRET_DETAIL}`), code ? { code } : {});

  function expectGenericInternalError(res: request.Response) {
    expect(res.status).toBe(500);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual(INTERNAL_ERROR_BODY);
    expect(res.text).not.toContain(SECRET_DETAIL);
    expect(res.text).not.toContain('P2002');
    expect(res.text).not.toMatch(/stack|\bat .+:\d+:\d+/);
  }

  it('refresh: a failing child create answers the generic 500, keeps the cookies, and a retry rotates', async () => {
    const { app, db } = setup();
    const c = await authClient(app);
    const first = await logIn(c);
    db.spies.refreshToken.create.mockRejectedValueOnce(dbFailure('P2002'));

    const res = await c.post('/auth/refresh', { cookies: [first.refresh] });

    expectGenericInternalError(res);
    // Not a refused session (401), so the controller neither sets nor clears auth cookies.
    expectNoAuthCookiesSet(res);
    expect(db.refreshTokens).toHaveLength(1);
    expect(db.refreshTokens[0]).toMatchObject({ revokedAt: null, replacedById: null });
    expect(db.auditLogs.map((l) => l.action)).toEqual(['LOGIN']);

    const retry = await c.post('/auth/refresh', { cookies: [first.refresh] });

    expect(retry.status).toBe(200);
    const second = sessionFrom(retry);
    expect(second.refreshValue).not.toBe(first.refreshValue);
    expect(db.refreshTokens).toHaveLength(2);
    expect(db.refreshTokens[0]?.replacedById).toBe(db.refreshTokens[1]?.id);
    expect(db.auditLogs.map((l) => l.action)).toEqual(['LOGIN']);
    expect((await c.get('/me', [second.access])).status).toBe(200);
  });

  it('login: a failing session create answers the generic 500 with no auth cookies and no LOGIN audit', async () => {
    const { app, db, admin } = setup();
    const c = await authClient(app);
    db.spies.refreshToken.create.mockRejectedValueOnce(dbFailure());

    const res = await c.post('/auth/login', { body: { email: EMAIL, password: PASSWORD } });

    expectGenericInternalError(res);
    expectNoAuthCookiesSet(res);
    expect(db.refreshTokens).toHaveLength(0);
    expect(db.auditLogs).toEqual([]);
    // Only the attempt reserved before the transaction remains.
    expect(storedAdmin(db, admin.id)).toMatchObject({
      failedLoginCount: 1,
      lockedUntil: null,
      lastLoginAt: null,
    });

    await logIn(c);
    expect(storedAdmin(db, admin.id).failedLoginCount).toBe(0);
    expect(db.auditLogs.map((l) => l.action)).toEqual(['LOGIN']);
  });

  it('logout: a failing LOGOUT audit still revokes the session, answers 204 and logs the error without secrets', async () => {
    const { logger, lines, parsed } = captureLogs();
    const { app, db, admin } = setup({ logger });
    const c = await authClient(app);
    const session = await logIn(c);
    db.spies.auditLog.create.mockRejectedValueOnce(dbFailure());

    const res = await c.post('/auth/logout', { cookies: [session.access, session.refresh] });

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expectAuthCookiesCleared(res);
    expect(db.refreshTokens[0]?.revokedAt).not.toBeNull();
    expect(db.auditLogs.map((l) => l.action)).toEqual(['LOGIN']);
    // A copied cookie no longer works: neither the access token nor the refresh token.
    const me = await c.get('/me', [session.access]);
    expect(me.status).toBe(401);
    expect(me.body).toEqual(UNAUTHORIZED_BODY);
    const refreshed = await c.post('/auth/refresh', { cookies: [session.refresh] });
    expect(refreshed.status).toBe(401);
    expect(refreshed.body).toEqual(UNAUTHORIZED_BODY);
    expect(db.auditLogs.map((l) => l.action)).toEqual(['LOGIN']); // no reuse alarm either

    const auditErrors = parsed().filter((l) =>
      String(l['msg']).includes('LOGOUT audit write failed'),
    );
    expect(auditErrors).toHaveLength(1);
    expect(auditErrors[0]).toMatchObject({
      level: 50,
      adminId: admin.id,
      familyId: db.refreshTokens[0]?.familyId,
      revokedCount: 1,
      err: { message: expect.stringContaining('statement failed') as unknown },
    });
    const log = lines.join('');
    for (const secret of [
      session.accessValue,
      session.refreshValue,
      c.csrf.token,
      c.csrf.cookieValue,
      ...db.refreshTokens.map((t) => t.tokenHash),
    ]) {
      expect(log).not.toContain(secret);
    }
    for (const cookieName of [ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME]) {
      expect(log).not.toContain(cookieName);
    }
  });
});

describe('GET /api/admin/me', () => {
  it('returns { admin } for the access cookie, without CSRF', async () => {
    const { app, admin } = setup({ admin: { role: 'SUPER_ADMIN', mustChangePassword: true } });
    const c = await authClient(app);
    const session = await logIn(c);

    const res = await c.get('/me', [session.access]);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(adminProfileResponseSchema.parse(res.body)).toEqual({
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: 'SUPER_ADMIN',
        mustChangePassword: true,
      },
    });
  });

  it('answers a missing access cookie with 401', async () => {
    const { app } = setup();
    const res = await request(app).get(`${BASE}/me`);

    expect(res.status).toBe(401);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
  });

  it('answers an invalid access cookie with 401', async () => {
    const { app } = setup();
    const res = await request(app)
      .get(`${BASE}/me`)
      .set('Cookie', cookiePair(ACCESS_COOKIE_NAME, 'not.a.jwt'));

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
  });

  it('answers 401 once the admin is deactivated', async () => {
    const { app, db, admin } = setup();
    const c = await authClient(app);
    const session = await logIn(c);
    storedAdmin(db, admin.id).isActive = false;

    const res = await c.get('/me', [session.access]);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
  });

  it('does not accept the refresh cookie as a session', async () => {
    const { app } = setup();
    const c = await authClient(app);
    const session = await logIn(c);

    const res = await c.get('/me', [cookiePair(ACCESS_COOKIE_NAME, session.refreshValue)]);

    expect(res.status).toBe(401);
  });
});
