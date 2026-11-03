/**
 * Phase 5 T19b (S5-02): malformed requests are the client's mistake, also on the app that runs on
 * real Postgres (Supertest serves it over a real loopback HTTP server). The unit flow tests
 * (test/malformed.flow.test.ts) cover every variant on the fake database; these few prove the
 * same fixed 4xx answers, `no-store`, and that nothing reaches the database or breaks the pool.
 */
import { apiErrorSchema } from '@sk-cinema/shared';
import request from 'supertest';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { ADMIN_BASE, ADMIN_ORIGIN, TEST_USER_AGENT } from '../helpers.js';
import { CSRF_HEADER } from '../../middleware/csrf.js';
import { describePg, disconnectTestPrisma, resetDatabase, testPrisma } from './db.js';
import { signedInAdmin } from './http.js';

describePg('malformed requests on the app with the real database', () => {
  beforeEach(resetDatabase);
  afterAll(disconnectTestPrisma);

  it.each(['/dates', '/showtimes', ''])(
    'GET /api/movies/%E0%A4%A%s: 400 BAD_REQUEST with no-store',
    async (suffix) => {
      const { app } = await signedInAdmin();

      const res = await request(app).get(`/api/movies/%E0%A4%A${suffix}`);

      expect(res.status).toBe(400);
      expect(apiErrorSchema.parse(res.body)).toEqual({
        error: { code: 'BAD_REQUEST', message: 'Malformed request URL' },
      });
      expect(res.headers['cache-control']).toBe('no-store');
    },
  );

  it('POST with an unsupported Content-Encoding: 415 with no-store, nothing written, app still serving', async () => {
    const api = await signedInAdmin();
    const res = await request(api.app)
      .post(`${ADMIN_BASE}/screens`)
      .set('User-Agent', TEST_USER_AGENT)
      .set('Origin', ADMIN_ORIGIN)
      .set(CSRF_HEADER, 'x')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'foo')
      .send('{"name":"Never stored"}');

    expect(res.status).toBe(415);
    expect(apiErrorSchema.parse(res.body)).toEqual({
      error: {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Unsupported content encoding or charset',
      },
    });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await testPrisma().screen.count()).toBe(0);
    expect((await api.get('/screens')).status).toBe(200);
  });
});
