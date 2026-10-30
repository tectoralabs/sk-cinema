import { apiErrorSchema } from '@sk-cinema/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './test/helpers.js';

const ALLOWED_ORIGIN = 'http://localhost:5173';

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
    it('allows listed origins with credentials', async () => {
      const res = await request(buildTestApp().app)
        .get('/api/health')
        .set('Origin', ALLOWED_ORIGIN);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('answers preflight requests from listed origins', async () => {
      const res = await request(buildTestApp().app)
        .options('/api/admin/movies')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'Content-Type, X-CSRF-Token');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(res.headers['access-control-allow-headers']).toContain('X-CSRF-Token');
    });

    it('gives no CORS headers to other origins', async () => {
      const res = await request(buildTestApp().app)
        .get('/api/health')
        .set('Origin', 'https://evil.example');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('gives no CORS headers to requests without an Origin', async () => {
      const res = await request(buildTestApp().app).get('/api/health');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
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
      const get = () => request(app).get('/api/does-not-exist').set('Origin', ALLOWED_ORIGIN);

      expect((await get()).status).toBe(404);
      expect((await get()).status).toBe(404);
      const limited = await get();

      expect(limited.status).toBe(429);
      expect(apiErrorSchema.parse(limited.body).error.code).toBe('RATE_LIMITED');
      expect(limited.headers['ratelimit-policy']).toBeDefined();
      expect(limited.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    });
  });
});
