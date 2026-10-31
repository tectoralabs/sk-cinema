import { apiErrorSchema } from '@sk-cinema/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ADMIN_ORIGIN, PUBLIC_ORIGIN, buildTestApp } from './test/helpers.js';

describe('app', () => {
  describe('error responses', () => {
    it('returns the standard 404 shape for unknown routes', async () => {
      const res = await request(buildTestApp().app).get('/api/does-not-exist');
      expect(res.status).toBe(404);
      expect(apiErrorSchema.parse(res.body).error.code).toBe('NOT_FOUND');
    });

    it('rejects malformed JSON with INVALID_JSON', async () => {
      const res = await request(buildTestApp().app)
        .post('/api/anything')
        .set('Content-Type', 'application/json')
        .send('{"title": ');
      expect(res.status).toBe(400);
      expect(apiErrorSchema.parse(res.body).error.code).toBe('INVALID_JSON');
    });

    it('rejects JSON bodies over the size limit with PAYLOAD_TOO_LARGE', async () => {
      const res = await request(buildTestApp().app)
        .post('/api/anything')
        .send({ synopsis: 'x'.repeat(110 * 1024) });
      expect(res.status).toBe(413);
      expect(apiErrorSchema.parse(res.body).error.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  describe('security headers', () => {
    it('sets a deny-everything CSP and other helmet headers', async () => {
      const res = await request(buildTestApp().app).get('/api/health');
      expect(res.headers['content-security-policy']).toBe(
        "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'",
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('CORS', () => {
    const app = buildTestApp().app;
    const EVIL_ORIGIN = 'https://evil.example';

    const get = (path: string, origin?: string) => {
      const req = request(app).get(path);
      return origin === undefined ? req : req.set('Origin', origin);
    };
    const preflight = (path: string, origin: string, headers = 'Content-Type, X-CSRF-Token') =>
      request(app)
        .options(path)
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', headers);

    const expectNoCors = (res: request.Response) => {
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      expect(res.headers['access-control-allow-headers']).toBeUndefined();
      expect(res.headers['access-control-allow-methods']).toBeUndefined();
    };

    describe('public routes', () => {
      it('allow the public origin without credentials', async () => {
        const res = await get('/api/health', PUBLIC_ORIGIN);
        expect(res.headers['access-control-allow-origin']).toBe(PUBLIC_ORIGIN);
        expect(res.headers['access-control-allow-credentials']).toBeUndefined();
        expect(res.headers['vary']).toContain('Origin');
      });

      it('answer a read-only preflight from the public origin, without credentials or X-CSRF-Token', async () => {
        const res = await request(app)
          .options('/api/health')
          .set('Origin', PUBLIC_ORIGIN)
          .set('Access-Control-Request-Method', 'GET')
          .set('Access-Control-Request-Headers', 'X-Request-Id');
        expect(res.status).toBe(204);
        expect(res.headers['access-control-allow-origin']).toBe(PUBLIC_ORIGIN);
        expect(res.headers['access-control-allow-credentials']).toBeUndefined();
        expect(res.headers['access-control-allow-methods']).toBe('GET,HEAD');
        expect(res.headers['access-control-allow-headers']).not.toContain('X-CSRF-Token');
      });

      it('allow the admin origin with credentials', async () => {
        const res = await get('/api/health', ADMIN_ORIGIN);
        expect(res.headers['access-control-allow-origin']).toBe(ADMIN_ORIGIN);
        expect(res.headers['access-control-allow-credentials']).toBe('true');
      });

      it('give no CORS headers to unlisted origins', async () => {
        expectNoCors(await get('/api/health', EVIL_ORIGIN));
        expectNoCors(await preflight('/api/health', EVIL_ORIGIN));
      });

      it('give no CORS headers to requests without an Origin', async () => {
        const res = await get('/api/health');
        expect(res.status).toBe(200);
        expectNoCors(res);
      });
    });

    describe('/api/admin', () => {
      it('allows the admin origin with credentials', async () => {
        const res = await get('/api/admin/auth/csrf', ADMIN_ORIGIN);
        expect(res.status).toBe(200);
        expect(res.headers['access-control-allow-origin']).toBe(ADMIN_ORIGIN);
        expect(res.headers['access-control-allow-credentials']).toBe('true');
        expect(res.headers['vary']).toContain('Origin');
      });

      it('answers a preflight from the admin origin that asks for X-CSRF-Token', async () => {
        const res = await preflight('/api/admin/auth/login', ADMIN_ORIGIN);
        expect(res.status).toBe(204);
        expect(res.headers['access-control-allow-origin']).toBe(ADMIN_ORIGIN);
        expect(res.headers['access-control-allow-credentials']).toBe('true');
        expect(res.headers['access-control-allow-headers']).toContain('X-CSRF-Token');
        expect(res.headers['access-control-allow-methods']).toContain('POST');
      });

      it('gives the public origin no CORS allowance, so the browser cannot read the CSRF token', async () => {
        const res = await get('/api/admin/auth/csrf', PUBLIC_ORIGIN);
        expectNoCors(res);
        expectNoCors(await get('/api/admin/me', PUBLIC_ORIGIN));
      });

      it('fails a preflight from the public origin', async () => {
        const res = await preflight('/api/admin/auth/login', PUBLIC_ORIGIN);
        expect(res.status).not.toBe(204);
        expectNoCors(res);
        expectNoCors(await preflight('/api/admin/movies', PUBLIC_ORIGIN));
      });

      it('gives no CORS headers to unlisted origins', async () => {
        expectNoCors(await get('/api/admin/auth/csrf', EVIL_ORIGIN));
        expectNoCors(await preflight('/api/admin/auth/login', EVIL_ORIGIN));
      });

      it('still serves requests without an Origin (curl), without Access-Control-Allow-Origin', async () => {
        const res = await get('/api/admin/auth/csrf');
        expect(res.status).toBe(200);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
      });

      // Express routes case-insensitively and ignores a trailing slash. Whatever reaches the
      // admin router (it sets no-store) must be treated as admin by CORS too; paths it does not
      // match fall through to the public 404 and may get public CORS.
      it.each<[string, boolean]>([
        ['/api/admin/auth/csrf', true],
        ['/API/ADMIN/auth/csrf', true],
        ['/Api/Admin/Auth/Csrf/', true],
        ['/api/admin/', true],
        ['/api/admin', true],
        ['/api/admin/does-not-exist', true],
        ['/api/admin//auth/csrf', true],
        ['/api//admin/auth/csrf', false],
        ['/api/admin%2Fauth/csrf', false],
        ['/api/%61dmin/auth/csrf', false],
      ])('treats %s like the admin router does (admin: %s)', async (path, isAdmin) => {
        const res = await get(path, PUBLIC_ORIGIN);
        expect(res.headers['cache-control'] === 'no-store').toBe(isAdmin);
        if (isAdmin) {
          expectNoCors(res);
        } else {
          expect(res.status).toBe(404);
          expect(res.headers['access-control-allow-credentials']).toBeUndefined();
        }
      });
    });
  });

  describe('request IDs', () => {
    it('generates an X-Request-Id for each request', async () => {
      const { app } = buildTestApp();
      const [a, b] = await Promise.all([
        request(app).get('/api/health'),
        request(app).get('/api/health'),
      ]);
      expect(a.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
    });

    it('keeps a safe incoming X-Request-Id', async () => {
      const res = await request(buildTestApp().app)
        .get('/api/health')
        .set('X-Request-Id', 'cf-ray-8a1b2c3d');
      expect(res.headers['x-request-id']).toBe('cf-ray-8a1b2c3d');
    });

    it('replaces an unsafe incoming X-Request-Id', async () => {
      const res = await request(buildTestApp().app)
        .get('/api/health')
        .set('X-Request-Id', '<script>alert(1)</script>');
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('rate limiting', () => {
    it('returns 429 RATE_LIMITED once the limit is used up, with CORS headers', async () => {
      const { app } = buildTestApp({ config: { rateLimit: { windowMs: 60_000, max: 2 } } });
      const get = () => request(app).get('/api/does-not-exist').set('Origin', PUBLIC_ORIGIN);

      expect((await get()).status).toBe(404);
      expect((await get()).status).toBe(404);
      const limited = await get();

      expect(limited.status).toBe(429);
      expect(apiErrorSchema.parse(limited.body).error.code).toBe('RATE_LIMITED');
      expect(limited.headers['ratelimit-policy']).toBeDefined();
      expect(limited.headers['access-control-allow-origin']).toBe(PUBLIC_ORIGIN);
    });
  });
});
