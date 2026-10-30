import { apiErrorSchema } from '@sk-cinema/shared';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AppError } from '../lib/errors.js';
import { silentLogger } from '../test/helpers.js';
import { errorHandler, notFoundHandler } from './errorHandler.js';
import { requestLogger } from './requestLogger.js';

function appThrowing(error: unknown) {
  const app = express();
  app.use(requestLogger(silentLogger));
  app.get('/sync', () => {
    throw error;
  });
  app.get('/async', async () => {
    await Promise.resolve();
    throw error;
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  it('sends AppError code, message and details', async () => {
    const res = await request(
      appThrowing(new AppError(409, 'VALIDATION_ERROR', 'Slug taken', { field: 'slug' })),
    ).get('/sync');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'Slug taken', details: { field: 'slug' } },
    });
  });

  it.each(['/sync', '/async'])(
    'hides unexpected errors behind a generic 500 (%s)',
    async (path) => {
      const error = new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2');
      const res = await request(appThrowing(error)).get(path);

      expect(res.status).toBe(500);
      expect(apiErrorSchema.parse(res.body)).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
      });
      expect(res.text).not.toContain('ECONNREFUSED');
      expect(res.text).not.toContain('hunter2');
      expect(res.text).not.toContain('at ');
    },
  );

  it('handles non-Error throws', async () => {
    const res = await request(appThrowing('just a string')).get('/sync');
    expect(res.status).toBe(500);
    expect(apiErrorSchema.parse(res.body).error.code).toBe('INTERNAL_ERROR');
  });
});

describe('notFoundHandler', () => {
  it('returns the standard error shape', async () => {
    const res = await request(appThrowing(null)).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });
});
