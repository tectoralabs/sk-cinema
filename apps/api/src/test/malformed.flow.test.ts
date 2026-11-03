/**
 * Phase 5 T19a (S5-02): malformed requests are the client's mistake. A bad percent escape in a
 * path and a body-parser failure that is neither bad JSON nor too large (unsupported
 * Content-Encoding or charset, corrupt gzip) answer a fixed 4xx with `no-store`, and never log at
 * error level or repeat the client's text. Through the real app (createApp + supertest).
 */
import { gzipSync } from 'node:zlib';
import { apiErrorSchema } from '@sk-cinema/shared';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers.js';

/** A logger whose every record is kept as parsed JSON, at every level. */
function recordingLogger() {
  const lines: string[] = [];
  const logger = pino({ level: 'trace' }, { write: (line: string) => void lines.push(line) });
  return {
    logger,
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    text: () => lines.join('\n'),
  };
}

/** A percent escape that decodeURIComponent refuses; the part after `%` is what we look for. */
/** superagent's serializer typing wants a string; the bytes (a Buffer) must go out untouched. */
const rawBody = ((body: unknown) => body) as unknown as (body: unknown) => string;

const BAD_ESCAPE = '%E0%A4%A';
const MARKER = 'zzmarker';

const BAD_PATHS = [
  `/api/movies/${BAD_ESCAPE}${MARKER}/dates`,
  `/api/movies/${BAD_ESCAPE}${MARKER}/showtimes`,
  `/api/movies/${BAD_ESCAPE}${MARKER}`,
];

function expectNoErrorLogs(log: ReturnType<typeof recordingLogger>) {
  // pino levels: 50 error, 60 fatal.
  expect(log.records().filter((record) => Number(record['level']) >= 50)).toEqual([]);
  // Our own record carries only the kind and the status, never the error's message.
  expect(log.text()).not.toContain('Failed to decode');
}

describe('a bad percent escape in the path', () => {
  it.each(BAD_PATHS)('%s: 400 BAD_REQUEST, no-store, no error log', async (path) => {
    const log = recordingLogger();

    const res = await request(buildTestApp({ logger: log.logger }).app).get(path);

    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(res.body)).toEqual({
      error: { code: 'BAD_REQUEST', message: 'Malformed request URL' },
    });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).not.toContain(MARKER);
    expectNoErrorLogs(log);
  });

  it('logs the kind and the status only, at info level', async () => {
    const log = recordingLogger();

    await request(buildTestApp({ logger: log.logger }).app).get(BAD_PATHS[0] ?? '/');

    const ours = log.records().filter((record) => record['msg'] === 'Malformed request');
    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({ level: 30, kind: 'URIError', status: 400 });
    expect(ours[0]).not.toHaveProperty('err');
  });

  it('a good escape still works (no false positive)', async () => {
    const res = await request(buildTestApp().app).get('/api/does%20not%20exist');

    expect(res.status).toBe(404);
  });
});

describe('a POST body the parser cannot read', () => {
  const post = (log: ReturnType<typeof recordingLogger>) =>
    request(buildTestApp({ logger: log.logger }).app)
      .post('/api/anything')
      .set('Content-Type', 'application/json');

  it.each(['foo', 'compress', 'x-gzip-not'])(
    'Content-Encoding: %s: 415 UNSUPPORTED_MEDIA_TYPE, no-store',
    async (encoding) => {
      const log = recordingLogger();

      const res = await post(log).set('Content-Encoding', encoding).send('{"a":1}');

      expect(res.status).toBe(415);
      expect(apiErrorSchema.parse(res.body)).toEqual({
        error: {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'Unsupported content encoding or charset',
        },
      });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.text).not.toContain(encoding);
      expectNoErrorLogs(log);
    },
  );

  it('an unsupported charset: 415, no-store, the charset never echoed', async () => {
    const log = recordingLogger();

    const res = await request(buildTestApp({ logger: log.logger }).app)
      .post('/api/anything')
      .set('Content-Type', 'application/json; charset=klingon')
      .send('{"a":1}');

    expect(res.status).toBe(415);
    expect(apiErrorSchema.parse(res.body).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text.toLowerCase()).not.toContain('klingon');
    expectNoErrorLogs(log);
    expect(log.text().toLowerCase()).not.toContain('klingon');
  });

  it('a corrupt brotli body (br is supported, so this is unreadable, not unsupported): 400', async () => {
    const log = recordingLogger();

    const res = await post(log)
      .set('Content-Encoding', 'br')
      .serialize(rawBody)
      .send(Buffer.from('definitely not brotli'));

    expect(res.status).toBe(400);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(apiErrorSchema.parse(res.body).error.code).toBe('BAD_REQUEST');
    expectNoErrorLogs(log);
  });

  it('a body that is not valid gzip: 400 BAD_REQUEST, no-store', async () => {
    const log = recordingLogger();

    const res = await post(log)
      .set('Content-Encoding', 'gzip')
      .serialize(rawBody)
      .send(Buffer.from('definitely not gzip'));

    expect(res.status).toBe(400);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(apiErrorSchema.parse(res.body).error.code).toMatch(/^(BAD_REQUEST|INVALID_JSON)$/);
    expectNoErrorLogs(log);
  });

  it('a valid gzip JSON body is still read (the route then answers 404, not a parse error)', async () => {
    const log = recordingLogger();

    const res = await post(log)
      .set('Content-Encoding', 'gzip')
      .serialize(rawBody)
      .send(gzipSync(Buffer.from('{"a":1}')));

    expect(res.status).toBe(404);
  });
});

describe('what stays as it was', () => {
  it('bad JSON is still 400 INVALID_JSON and an oversized body 413 PAYLOAD_TOO_LARGE', async () => {
    const { app } = buildTestApp();
    const bad = await request(app)
      .post('/api/anything')
      .set('Content-Type', 'application/json')
      .send('{"a": ');
    expect(bad.status).toBe(400);
    expect(apiErrorSchema.parse(bad.body).error.code).toBe('INVALID_JSON');

    const large = await request(app)
      .post('/api/anything')
      .send({ synopsis: 'x'.repeat(110 * 1024) });
    expect(large.status).toBe(413);
    expect(apiErrorSchema.parse(large.body).error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
