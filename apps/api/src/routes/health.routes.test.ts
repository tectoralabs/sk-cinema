import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { buildTestApp, fakePrisma } from '../test/helpers.js';

describe('GET /api/health', () => {
  it('returns 200 when the database answers', async () => {
    const res = await request(buildTestApp().app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      status: 'ok',
      checks: { database: 'up' },
      timestamp: expect.any(String) as unknown,
    });
  });

  it('returns 503 and reports the database down when the query fails', async () => {
    const $queryRaw = vi.fn().mockRejectedValue(new Error('Connection terminated'));
    const res = await request(buildTestApp({ prisma: fakePrisma({ $queryRaw }) }).app).get(
      '/api/health',
    );

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'degraded', checks: { database: 'down' } });
    expect(res.text).not.toContain('Connection terminated');
  });

  it('caches the database check briefly so repeated calls do not hit the DB', async () => {
    const $queryRaw = vi.fn().mockResolvedValue([{ ok: 1 }]);
    const { app } = buildTestApp({ prisma: fakePrisma({ $queryRaw }) });

    await request(app).get('/api/health');
    await request(app).get('/api/health');

    expect($queryRaw).toHaveBeenCalledTimes(1);
  });
});
