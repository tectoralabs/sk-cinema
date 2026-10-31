import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { REDACT_CENSOR, REDACT_DEPTH, REDACT_KEYS, createLogger } from './logger.js';

function captureLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger({ logLevel: 'info', nodeEnv: 'test' }, stream);
  return { logger, output: () => lines.join('') };
}

/** Logs `fields` once and returns the parsed JSON line plus the raw text. */
function logOnce(fields: object) {
  const { logger, output } = captureLogger();
  logger.info(fields, 'test');
  const raw = output();
  return { raw, line: JSON.parse(raw) as Record<string, unknown> };
}

const SECRET = 'raw-secret-value-7f3a9c';

/** The value at `path` in a parsed log line. */
function valueAt(line: unknown, path: string[]): unknown {
  return path.reduce<unknown>(
    (node, key) =>
      typeof node === 'object' && node !== null
        ? (node as Record<string, unknown>)[key]
        : undefined,
    line,
  );
}

describe('createLogger', () => {
  it('redacts secrets, tokens and cookies', () => {
    const { logger, output } = captureLogger();
    logger.info(
      {
        req: { headers: { cookie: 'session=abc', authorization: 'Bearer xyz' } },
        user: { email: 'a@b.c', password: 'hunter2hunter2', refreshToken: 'rt-secret' },
      },
      'test',
    );

    for (const secret of ['session=abc', 'Bearer xyz', 'hunter2hunter2', 'rt-secret']) {
      expect(output()).not.toContain(secret);
    }
    expect(output()).toContain('a@b.c');
    expect(output()).toContain('[REDACTED]');
  });

  // The shapes the Phase 3 security audit showed getting through depth-2-only paths.
  it.each<[string, object, string[]]>([
    ['top-level password', { password: SECRET }, ['password']],
    ['top-level token', { token: SECRET }, ['token']],
    ['top-level refreshToken', { refreshToken: SECRET }, ['refreshToken']],
    ['top-level csrfToken', { csrfToken: SECRET }, ['csrfToken']],
    ['top-level tokenHash', { tokenHash: SECRET }, ['tokenHash']],
    ['req.body.password', { req: { body: { password: SECRET } } }, ['req', 'body', 'password']],
    [
      'config.auth.jwtAccessSecret',
      { config: { auth: { jwtAccessSecret: SECRET } } },
      ['config', 'auth', 'jwtAccessSecret'],
    ],
    [
      'config.auth.csrfSecret',
      { config: { auth: { csrfSecret: SECRET } } },
      ['config', 'auth', 'csrfSecret'],
    ],
    [
      'headers x-csrf-token outside req',
      { headers: { 'x-csrf-token': SECRET } },
      ['headers', 'x-csrf-token'],
    ],
    [
      'res.headers set-cookie',
      { res: { headers: { 'set-cookie': [`sk_rt=${SECRET}`] } } },
      ['res', 'headers', 'set-cookie'],
    ],
    ['req.cookies (an object)', { req: { cookies: { sk_at: SECRET } } }, ['req', 'cookies']],
  ])('redacts %s', (_name, fields, path) => {
    const { raw, line } = logOnce(fields);

    expect(valueAt(line, path)).toBe(REDACT_CENSOR);
    expect(raw).not.toContain(SECRET);
  });

  it('redacts every listed key at every depth up to REDACT_DEPTH', () => {
    const nest = (depth: number, leaf: object): object =>
      depth === 1 ? leaf : { [`level${depth}`]: nest(depth - 1, leaf) };

    for (const key of REDACT_KEYS) {
      for (let depth = 1; depth <= REDACT_DEPTH; depth++) {
        const value = `${SECRET}-${key}-${depth}`;
        const { raw } = logOnce(nest(depth, { [key]: value }));
        expect(raw, `${key} at depth ${depth}`).not.toContain(value);
        expect(raw, `${key} at depth ${depth}`).toContain(REDACT_CENSOR);
      }
    }
  });

  it('keeps ids, roles, reasons and other harmless fields readable', () => {
    const fields = {
      reason: 'session_ended',
      role: 'EDITOR',
      adminId: '7c1e0d7e-0000-4000-8000-000000000001',
      familyId: '7c1e0d7e-0000-4000-8000-000000000002',
      revokedCount: 2,
      req: { id: 'req-1', method: 'POST', url: '/api/admin/auth/logout' },
      res: { statusCode: 204 },
    };

    const { raw, line } = logOnce(fields);

    expect(line).toMatchObject(fields);
    expect(raw).not.toContain(REDACT_CENSOR);
  });

  it('serialises errors normally', () => {
    const { logger, output } = captureLogger();
    logger.error({ err: new Error('audit insert failed'), adminId: 'a1' }, 'failed');

    const line = JSON.parse(output()) as { err: { message: string }; adminId: string };
    expect(line.err.message).toBe('audit insert failed');
    expect(line.adminId).toBe('a1');
  });
});
