import cookieParser from 'cookie-parser';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSetCookies, testConfig } from '../test/helpers.js';
import {
  ACCESS_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  clearAuthCookies,
  readAccessToken,
  readCsrfCookie,
  readRefreshToken,
  setAuthCookies,
  setCsrfCookie,
} from './authCookies.js';

const NOW = new Date('2026-11-01T04:30:00.000Z');
const EPOCH_EXPIRES = new Date(1).toUTCString();

function appWith(handler: (req: Request, res: Response) => void) {
  const app = express();
  app.use(cookieParser());
  app.get('/', (req, res) => {
    handler(req, res);
    res.status(204).end();
  });
  return app;
}

describe('auth cookies', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the approved cookie names and refresh path', () => {
    expect(ACCESS_COOKIE_NAME).toBe('__Host-sk_access');
    expect(REFRESH_COOKIE_NAME).toBe('__Secure-sk_refresh');
    expect(CSRF_COOKIE_NAME).toBe('__Host-sk_csrf');
    expect(REFRESH_COOKIE_PATH).toBe('/api/admin/auth');
  });

  describe('setAuthCookies', () => {
    const config = testConfig();
    const refreshExpiresAt = new Date(NOW.getTime() + 3 * 24 * 3600 * 1000);

    async function setCookies(expiresAt = refreshExpiresAt) {
      const res = await request(
        appWith((_req, r) => {
          setAuthCookies(
            r,
            {
              accessToken: 'access.jwt.value',
              refreshToken: 'refresh-value',
              refreshExpiresAt: expiresAt,
            },
            config,
          );
        }),
      ).get('/');
      return parseSetCookies(res);
    }

    it('sets the access cookie with exact attributes', async () => {
      const cookies = await setCookies();
      expect(cookies[ACCESS_COOKIE_NAME]).toEqual({
        value: 'access.jwt.value',
        attributes: {
          'max-age': String(config.auth.accessTokenTtlSeconds),
          path: '/',
          expires: new Date(NOW.getTime() + config.auth.accessTokenTtlSeconds * 1000).toUTCString(),
          httponly: true,
          secure: true,
          samesite: 'Strict',
        },
      });
    });

    it('sets the refresh cookie with exact attributes and Max-Age from expiresAt', async () => {
      const cookies = await setCookies();
      expect(cookies[REFRESH_COOKIE_NAME]).toEqual({
        value: 'refresh-value',
        attributes: {
          'max-age': String(3 * 24 * 3600),
          path: '/api/admin/auth',
          expires: refreshExpiresAt.toUTCString(),
          httponly: true,
          secure: true,
          samesite: 'Strict',
        },
      });
    });

    it('keeps the original absolute expiry on rotation', async () => {
      // Two hours later, the same expiresAt leaves two hours less Max-Age.
      vi.setSystemTime(new Date(NOW.getTime() + 2 * 3600 * 1000));
      const cookies = await setCookies();
      expect(cookies[REFRESH_COOKIE_NAME]?.attributes['max-age']).toBe(
        String(3 * 24 * 3600 - 2 * 3600),
      );
      expect(cookies[REFRESH_COOKIE_NAME]?.attributes['expires']).toBe(
        refreshExpiresAt.toUTCString(),
      );
    });

    it('rounds partial seconds down', async () => {
      const cookies = await setCookies(new Date(NOW.getTime() + 60_999));
      expect(cookies[REFRESH_COOKIE_NAME]?.attributes['max-age']).toBe('60');
    });

    it('uses Max-Age=0 when expiresAt is already past', async () => {
      const cookies = await setCookies(new Date(NOW.getTime() - 1000));
      expect(cookies[REFRESH_COOKIE_NAME]?.attributes['max-age']).toBe('0');
    });

    it('never sets a Domain attribute', async () => {
      const cookies = await setCookies();
      for (const cookie of Object.values(cookies)) {
        expect(cookie.attributes).not.toHaveProperty('domain');
      }
    });
  });

  describe('clearAuthCookies', () => {
    it('expires both cookies with the same name, path and attributes', async () => {
      const res = await request(
        appWith((_req, r) => {
          clearAuthCookies(r);
        }),
      ).get('/');
      const cookies = parseSetCookies(res);

      expect(Object.keys(cookies).sort()).toEqual([ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME].sort());
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
          path: '/api/admin/auth',
          expires: EPOCH_EXPIRES,
          httponly: true,
          secure: true,
          samesite: 'Strict',
        },
      });
    });
  });

  describe('setCsrfCookie', () => {
    it('sets a host-only session cookie with exact attributes', async () => {
      const res = await request(
        appWith((_req, r) => {
          setCsrfCookie(r, 'csrf-value');
        }),
      ).get('/');
      expect(parseSetCookies(res)[CSRF_COOKIE_NAME]).toEqual({
        value: 'csrf-value',
        attributes: { path: '/', httponly: true, secure: true, samesite: 'Strict' },
      });
    });
  });

  describe('read helpers', () => {
    async function readWith(cookieHeader?: string) {
      let result: Record<string, string | undefined> = {};
      const app = appWith((req) => {
        result = {
          access: readAccessToken(req),
          refresh: readRefreshToken(req),
          csrf: readCsrfCookie(req),
        };
      });
      const req = request(app).get('/');
      await (cookieHeader === undefined ? req : req.set('Cookie', cookieHeader));
      return result;
    }

    it('returns each cookie value', async () => {
      expect(
        await readWith(
          `${ACCESS_COOKIE_NAME}=a.b.c; ${REFRESH_COOKIE_NAME}=r-1; ${CSRF_COOKIE_NAME}=c-1`,
        ),
      ).toEqual({ access: 'a.b.c', refresh: 'r-1', csrf: 'c-1' });
    });

    it('returns undefined when there are no cookies', async () => {
      expect(await readWith()).toEqual({
        access: undefined,
        refresh: undefined,
        csrf: undefined,
      });
    });

    it('returns undefined for missing, empty or JSON cookies', async () => {
      expect(
        await readWith(`other=x; ${ACCESS_COOKIE_NAME}=; ${REFRESH_COOKIE_NAME}=j:{"a":1}`),
      ).toEqual({ access: undefined, refresh: undefined, csrf: undefined });
    });

    it('returns undefined when cookie-parser is not mounted', () => {
      const req = {} as Request;
      expect(readAccessToken(req)).toBeUndefined();
      expect(readRefreshToken(req)).toBeUndefined();
    });
  });
});
