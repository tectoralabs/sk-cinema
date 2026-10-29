import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('createApp', () => {
  it('responds 404 for unknown routes', async () => {
    const res = await request(createApp()).get('/api/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('does not expose the x-powered-by header', async () => {
    const res = await request(createApp()).get('/');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
