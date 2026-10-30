import { apiErrorSchema } from '@sk-cinema/shared';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { silentLogger } from '../test/helpers.js';
import { errorHandler } from './errorHandler.js';
import { requestLogger } from './requestLogger.js';
import { validate } from './validate.js';

function appWith(route: express.RequestHandler) {
  const app = express();
  app.use(requestLogger(silentLogger), express.json());
  app.post(
    '/items/:id',
    validate({
      params: z.object({ id: z.coerce.number().int().positive() }),
      query: z.object({ preview: z.enum(['true', 'false']).default('false') }),
      body: z.object({ name: z.string().min(1), tags: z.array(z.string()).default([]) }),
    }),
    route,
  );
  app.use(errorHandler);
  return app;
}

const echo: express.RequestHandler = (req, res) => {
  res.json({ params: req.params, query: req.query, body: req.body as unknown });
};

describe('validate', () => {
  it('passes parsed values (with coercion and defaults) to the handler', async () => {
    const res = await request(appWith(echo)).post('/items/7').send({ name: 'Poster' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      params: { id: 7 },
      query: { preview: 'false' },
      body: { name: 'Poster', tags: [] },
    });
  });

  it('rejects invalid input with VALIDATION_ERROR and field paths', async () => {
    const res = await request(appWith(echo)).post('/items/abc?preview=maybe').send({ name: '' });

    expect(res.status).toBe(400);
    const { error } = apiErrorSchema.parse(res.body);
    expect(error.code).toBe('VALIDATION_ERROR');
    const paths = (error.details as { path: string[] }[]).map((d) => d.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['params.id', 'query.preview', 'body.name']));
  });

  it('rejects unknown keys even when the schema is not strict', async () => {
    const res = await request(appWith(echo))
      .post('/items/1?debug=1')
      .send({ name: 'Poster', role: 'SUPER_ADMIN' });

    expect(res.status).toBe(400);
    const { error } = apiErrorSchema.parse(res.body);
    const paths = (error.details as { path: string[] }[]).map((d) => d.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['query', 'body']));
  });

  it('treats a missing body as an empty object', async () => {
    const res = await request(appWith(echo)).post('/items/1');
    expect(res.status).toBe(400);
    const { error } = apiErrorSchema.parse(res.body);
    expect(error.details).toEqual([expect.objectContaining({ path: ['body', 'name'] })]);
  });
});
