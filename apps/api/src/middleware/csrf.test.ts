import { createHmac, randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import cookieParser from 'cookie-parser';
import express from 'express';
import { pino, type Logger } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { CSRF_COOKIE_NAME } from '../lib/authCookies.js';
import { silentLogger, testConfig } from '../test/helpers.js';
import { CSRF_HEADER, csrfProtection, issueCsrfToken } from './csrf.js';
import { errorHandler } from './errorHandler.js';
import { requestLogger } from './requestLogger.js';

const config = testConfig();
const ALLOWED_ORIGIN = 'http://localhost:5174';
const CSRF_ERROR = { error: { code: 'CSRF_INVALID', message: 'CSRF validation failed' } };

const newCookieValue = () => randomBytes(32).toString('base64url');
const hmac = (value: string, secret = config.auth.csrfSecret) =>
  createHmac('sha256', secret).update(value).digest('base64url');

function csrfApp(logger: Logger = silentLogger) {
  const app = express();
  app.use(requestLogger(logger));
  app.use(cookieParser());
  app.get('/csrf', (req, res) => {
    res.json({ csrfToken: issueCsrfToken(req, res, config) });
  });
  app.use(csrfProtection(config));
  app.all('/action', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

const app = csrfApp();

interface Attempt {
  method?: 'post' | 'put' | 'patch' | 'delete';
  origin?: string;
  referer?: string;
  cookie?: string;
  token?: string;
}

/** Sends a request to the protected route; defaults are a fully valid request. */
function attempt(overrides: Attempt = {}) {
  const cookieValue = newCookieValue();
  const opts = {
    method: 'post',
    origin: ALLOWED_ORIGIN,
    cookie: cookieValue,
    token: hmac(cookieValue),
    ...overrides,
  } as const;
  let req = request(app)[opts.method]('/action');
  if (opts.origin) req = req.set('Origin', opts.origin);
  if (opts.referer) req = req.set('Referer', opts.referer);
  if (opts.cookie) req = req.set('Cookie', `${CSRF_COOKIE_NAME}=${opts.cookie}`);
  if (opts.token) req = req.set(CSRF_HEADER, opts.token);
  return req;
}

function setCookieHeaders(res: request.Response): string[] {
  const header = res.headers['set-cookie'] as string[] | string | undefined;
  return header === undefined ? [] : Array.isArray(header) ? header : [header];
}

function expectRejected(res: request.Response) {
  expect(res.status).toBe(403);
  expect(res.body).toEqual(CSRF_ERROR);
}

describe('csrfProtection', () => {
  describe('rejects with 403 CSRF_INVALID', () => {
    it('when the header is missing', async () => {
      expectRejected(await attempt({ token: '' }));
    });

    it('when the cookie is missing', async () => {
      expectRejected(await attempt({ cookie: '', token: hmac(newCookieValue()) }));
    });

    it('when the token is tampered with', async () => {
      const cookie = newCookieValue();
      const token = hmac(cookie);
      const tampered = (token.startsWith('A') ? 'B' : 'A') + token.slice(1);
      expectRejected(await attempt({ cookie, token: tampered }));
      expectRejected(await attempt({ cookie, token: `${token}x` }));
      expectRejected(await attempt({ cookie, token: token.slice(0, -1) }));
    });

    it('when the token was made with a different secret', async () => {
      const cookie = newCookieValue();
      const token = hmac(cookie, 'another-csrf-secret-0123456789abcdef-xyz');
      expectRejected(await attempt({ cookie, token }));
    });

    it('when the token belongs to a different cookie value', async () => {
      expectRejected(await attempt({ cookie: newCookieValue(), token: hmac(newCookieValue()) }));
    });

    it('when the cookie value itself is sent as the token', async () => {
      const cookie = newCookieValue();
      expect(hmac(cookie)).not.toBe(cookie);
      expectRejected(await attempt({ cookie, token: cookie }));
    });

    it('when the cookie is malformed, even with a matching HMAC', async () => {
      expectRejected(await attempt({ cookie: 'short', token: hmac('short') }));
    });

    it('when the Origin is not allowed', async () => {
      expectRejected(await attempt({ origin: 'https://evil.example' }));
      expectRejected(await attempt({ origin: 'null' }));
      expectRejected(await attempt({ origin: `${ALLOWED_ORIGIN}.evil.example` }));
    });

    it('when the Origin is not allowed, even with an allowed Referer', async () => {
      expectRejected(
        await attempt({ origin: 'https://evil.example', referer: `${ALLOWED_ORIGIN}/movies` }),
      );
    });

    it('when the Origin is missing and the Referer is not allowed', async () => {
      expectRejected(await attempt({ origin: '', referer: 'https://evil.example/page' }));
      expectRejected(await attempt({ origin: '', referer: 'not a url' }));
    });

    it('when both Origin and Referer are missing', async () => {
      expectRejected(await attempt({ origin: '' }));
    });

    it('with the same body for every failure', async () => {
      const responses = await Promise.all([
        attempt({ token: '' }),
        attempt({ origin: 'https://evil.example' }),
        attempt({ origin: '' }),
      ]);
      for (const res of responses) expect(res.text).toBe(JSON.stringify(CSRF_ERROR));
    });
  });

  describe('passes', () => {
    it.each(['post', 'put', 'patch', 'delete'] as const)(
      '%s with an allowed Origin and a valid token',
      async (method) => {
        const res = await attempt({ method });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
      },
    );

    it('when the Origin is missing and the Referer is allowed', async () => {
      const res = await attempt({ origin: '', referer: `${ALLOWED_ORIGIN}/movies?page=2` });
      expect(res.status).toBe(200);
    });

    it.each(['get', 'head', 'options'] as const)('%s without Origin or token', async (method) => {
      const res = await request(app)[method]('/action');
      expect(res.status).toBe(200);
    });

    it('with a token and cookie obtained from issueCsrfToken', async () => {
      const issued = await request(app).get('/csrf');
      const cookie = setCookieHeaders(issued)[0]?.split(';')[0];
      expect(cookie).toBeDefined();

      const res = await request(app)
        .post('/action')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', cookie ?? '')
        .set(CSRF_HEADER, (issued.body as { csrfToken: string }).csrfToken);
      expect(res.status).toBe(200);
    });
  });
});

describe('issueCsrfToken', () => {
  it('sets a new random cookie when it is missing and returns its HMAC', async () => {
    const res = await request(app).get('/csrf');
    const headers = setCookieHeaders(res);
    expect(headers).toHaveLength(1);

    const match = new RegExp(`^${CSRF_COOKIE_NAME}=([A-Za-z0-9_-]{43}); `).exec(headers[0] ?? '');
    const cookieValue = match?.[1] ?? '';
    expect(cookieValue).not.toBe('');
    expect(res.body).toEqual({ csrfToken: hmac(cookieValue) });
    expect((res.body as { csrfToken: string }).csrfToken).not.toBe(cookieValue);
  });

  it('creates a different cookie each time', async () => {
    const [a, b] = await Promise.all([request(app).get('/csrf'), request(app).get('/csrf')]);
    expect(setCookieHeaders(a)[0]).not.toBe(setCookieHeaders(b)[0]);
  });

  it('reuses an existing cookie without setting a new one', async () => {
    const cookie = newCookieValue();
    const res = await request(app).get('/csrf').set('Cookie', `${CSRF_COOKIE_NAME}=${cookie}`);
    expect(setCookieHeaders(res)).toEqual([]);
    expect(res.body).toEqual({ csrfToken: hmac(cookie) });
  });

  it('replaces a malformed cookie', async () => {
    const res = await request(app).get('/csrf').set('Cookie', `${CSRF_COOKIE_NAME}=tampered`);
    const headers = setCookieHeaders(res);
    expect(headers).toHaveLength(1);
    expect(headers[0]).not.toContain('tampered');
    expect(res.body).not.toEqual({ csrfToken: hmac('tampered') });
  });
});

describe('CSRF failure logging', () => {
  it('logs the reason at debug level but never the token or cookie', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logged = csrfApp(pino({ level: 'debug' }, stream));
    const cookie = newCookieValue();
    const token = hmac(newCookieValue());

    const res = await request(logged)
      .post('/action')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', `${CSRF_COOKIE_NAME}=${cookie}`)
      .set(CSRF_HEADER, token);
    expectRejected(res);

    const output = lines.join('');
    expect(output).toContain('CSRF check failed');
    expect(output).toContain('token_mismatch');
    expect(output).not.toContain(cookie);
    expect(output).not.toContain(token);
  });
});
