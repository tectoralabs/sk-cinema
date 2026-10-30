import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import cookieParser from 'cookie-parser';
import express from 'express';
import { pino, type Logger } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Admin } from '../generated/prisma/client.js';
import { ACCESS_COOKIE_NAME } from '../lib/authCookies.js';
import { signAccessToken } from '../lib/tokens.js';
import { SESSION_EXPIRED_MESSAGE } from '../services/auth.service.js';
import { inMemoryAuthDb, silentLogger, testAdmin, testConfig } from '../test/helpers.js';
import { FORBIDDEN_MESSAGE, requireAuth, requireRole } from './auth.js';
import { errorHandler } from './errorHandler.js';
import { requestLogger } from './requestLogger.js';

const config = testConfig();
const UNAUTHORIZED_BODY = { error: { code: 'UNAUTHORIZED', message: SESSION_EXPIRED_MESSAGE } };
const FORBIDDEN_BODY = { error: { code: 'FORBIDDEN', message: FORBIDDEN_MESSAGE } };

const editor = testAdmin({ role: 'EDITOR', email: 'editor@skcinema.lk' });
const superAdmin = testAdmin({ role: 'SUPER_ADMIN', email: 'super@skcinema.lk' });
const inactive = testAdmin({ role: 'SUPER_ADMIN', email: 'gone@skcinema.lk', isActive: false });

function authApp(admins: Admin[] = [editor, superAdmin, inactive], logger: Logger = silentLogger) {
  const db = inMemoryAuthDb({ admins });
  const app = express();
  app.use(requestLogger(logger));
  app.use(cookieParser());

  const auth = requireAuth({ db: db.prisma, config });
  const sendAdmin: express.RequestHandler = (req, res) => {
    res.json({ admin: req.admin });
  };
  app.get('/me', auth, sendAdmin);
  app.get('/super', auth, requireRole('SUPER_ADMIN'), sendAdmin);
  app.get('/any', auth, requireRole('SUPER_ADMIN', 'EDITOR'), sendAdmin);
  // Misordered on purpose: no requireAuth in front.
  app.get('/role-only', requireRole('EDITOR', 'SUPER_ADMIN'), sendAdmin);
  app.use(errorHandler);
  return { app, db };
}

const sign = (
  admin: Pick<Admin, 'id' | 'role'>,
  options: { secret?: string; now?: Date; ttlSeconds?: number } = {},
) =>
  signAccessToken(
    { adminId: admin.id, role: admin.role },
    {
      secret: options.secret ?? config.auth.jwtAccessSecret,
      ttlSeconds: options.ttlSeconds ?? config.auth.accessTokenTtlSeconds,
      ...(options.now && { now: options.now }),
    },
  );

const get = (app: express.Express, path: string, token?: string) => {
  const req = request(app).get(path);
  return token === undefined ? req : req.set('Cookie', `${ACCESS_COOKIE_NAME}=${token}`);
};

/** Replaces one base64url character in the middle of a JWT segment. */
function flipChar(segment: string): string {
  const i = Math.floor(segment.length / 2);
  const replacement = segment[i] === 'A' ? 'B' : 'A';
  return segment.slice(0, i) + replacement + segment.slice(i + 1);
}

function expectUnauthorized(res: request.Response) {
  expect(res.status).toBe(401);
  expect(res.body).toEqual(UNAUTHORIZED_BODY);
}

describe('requireAuth', () => {
  it('passes a valid token and sets req.admin from the DB', async () => {
    const { app, db } = authApp();
    const res = await get(app, '/me', await sign(editor));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ admin: { id: editor.id, role: 'EDITOR' } });
    expect(db.spies.admin.findUnique).toHaveBeenCalledTimes(1);
    expect(db.spies.admin.findUnique).toHaveBeenCalledWith({
      where: { id: editor.id },
      select: { id: true, role: true, isActive: true },
    });
  });

  it('looks the admin up on every request', async () => {
    const { app, db } = authApp();
    const token = await sign(editor);
    await get(app, '/me', token);
    await get(app, '/me', token);
    expect(db.spies.admin.findUnique).toHaveBeenCalledTimes(2);
  });

  describe('rejects with 401 UNAUTHORIZED', () => {
    it('without the access cookie', async () => {
      const { app, db } = authApp();
      expectUnauthorized(await get(app, '/me'));
      expectUnauthorized(await get(app, '/me', ''));
      expect(db.spies.admin.findUnique).not.toHaveBeenCalled();
    });

    it('when cookie-parser turned the cookie into an object', async () => {
      const { app } = authApp();
      expectUnauthorized(await get(app, '/me', encodeURIComponent('j:{"a":1}')));
    });

    it('for a garbage token', async () => {
      const { app } = authApp();
      expectUnauthorized(await get(app, '/me', 'not-a-jwt'));
    });

    it('for an expired token', async () => {
      const { app, db } = authApp();
      const issuedAt = new Date(Date.now() - (config.auth.accessTokenTtlSeconds + 60) * 1000);
      expectUnauthorized(await get(app, '/me', await sign(editor, { now: issuedAt })));
      expect(db.spies.admin.findUnique).not.toHaveBeenCalled();
    });

    it('for a token with a tampered signature', async () => {
      const { app } = authApp();
      const [header, payload, signature] = (await sign(editor)).split('.');
      expectUnauthorized(
        await get(app, '/me', `${header}.${payload}.${flipChar(signature ?? '')}`),
      );
    });

    it('for a token with a tampered payload (role escalation)', async () => {
      const { app } = authApp();
      const [header, payload, signature] = (await sign(editor)).split('.');
      const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as Record<
        string,
        unknown
      >;
      const forged = Buffer.from(JSON.stringify({ ...claims, role: 'SUPER_ADMIN' })).toString(
        'base64url',
      );
      expectUnauthorized(await get(app, '/super', `${header}.${forged}.${signature}`));
    });

    it('for a token signed with another secret', async () => {
      const { app } = authApp();
      const token = await sign(editor, { secret: 'another-jwt-secret-0123456789abcdef-xyz' });
      expectUnauthorized(await get(app, '/me', token));
    });

    it('for a valid token of an unknown admin', async () => {
      const { app } = authApp();
      expectUnauthorized(await get(app, '/me', await sign({ id: randomUUID(), role: 'EDITOR' })));
    });

    it('for a valid token of an inactive admin', async () => {
      const { app } = authApp();
      expectUnauthorized(await get(app, '/me', await sign(inactive)));
    });

    it('for an admin deactivated after the token was issued', async () => {
      const { app, db } = authApp();
      const token = await sign(editor);
      expect((await get(app, '/me', token)).status).toBe(200);

      const row = db.admins.find((a) => a.id === editor.id);
      if (row) row.isActive = false;
      expectUnauthorized(await get(app, '/me', token));
    });

    it('with the exact same body for every failure', async () => {
      const { app } = authApp();
      const [, payload] = (await sign(editor)).split('.');
      const responses = await Promise.all([
        get(app, '/me'),
        get(app, '/me', 'not-a-jwt'),
        get(app, '/me', `x.${payload}.y`),
        get(app, '/me', await sign(editor, { now: new Date('2020-01-01T00:00:00Z') })),
        get(app, '/me', await sign(editor, { secret: 'another-jwt-secret-0123456789abcdef' })),
        get(app, '/me', await sign({ id: randomUUID(), role: 'EDITOR' })),
        get(app, '/me', await sign(inactive)),
        get(app, '/role-only', await sign(editor)),
      ]);
      for (const res of responses) {
        expect(res.status).toBe(401);
        expect(res.text).toBe(JSON.stringify(UNAUTHORIZED_BODY));
      }
    });
  });

  it('passes DB errors to the error handler as a 500, not a 401', async () => {
    const { app, db } = authApp();
    db.spies.admin.findUnique.mockRejectedValueOnce(new Error('connection refused'));
    const res = await get(app, '/me', await sign(editor));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
    });
  });
});

describe('requireRole', () => {
  it('lets a SUPER_ADMIN through a SUPER_ADMIN-only route', async () => {
    const { app } = authApp();
    const res = await get(app, '/super', await sign(superAdmin));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ admin: { id: superAdmin.id, role: 'SUPER_ADMIN' } });
  });

  it('rejects an EDITOR on a SUPER_ADMIN-only route with 403 FORBIDDEN', async () => {
    const { app } = authApp();
    const res = await get(app, '/super', await sign(editor));
    expect(res.status).toBe(403);
    expect(res.text).toBe(JSON.stringify(FORBIDDEN_BODY));
  });

  it.each([
    ['EDITOR', editor],
    ['SUPER_ADMIN', superAdmin],
  ] as const)('lets %s through a route allowing both roles', async (_role, admin) => {
    const { app } = authApp();
    const res = await get(app, '/any', await sign(admin));
    expect(res.status).toBe(200);
  });

  it('uses the DB role: an EDITOR token for a now-SUPER_ADMIN passes', async () => {
    const promoted = testAdmin({ role: 'SUPER_ADMIN', email: 'promoted@skcinema.lk' });
    const { app } = authApp([promoted]);
    const res = await get(app, '/super', await sign({ id: promoted.id, role: 'EDITOR' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ admin: { id: promoted.id, role: 'SUPER_ADMIN' } });
  });

  it('uses the DB role: a SUPER_ADMIN token for a now-EDITOR gets 403', async () => {
    const demoted = testAdmin({ role: 'EDITOR', email: 'demoted@skcinema.lk' });
    const { app } = authApp([demoted]);
    const token = await sign({ id: demoted.id, role: 'SUPER_ADMIN' });

    const res = await get(app, '/super', token);
    expect(res.status).toBe(403);
    expect(res.body).toEqual(FORBIDDEN_BODY);

    const me = await get(app, '/me', token);
    expect(me.body).toEqual({ admin: { id: demoted.id, role: 'EDITOR' } });
  });

  it('fails closed with 401 when requireAuth did not run', async () => {
    const { app } = authApp();
    expectUnauthorized(await get(app, '/role-only'));
    // Even a valid cookie is ignored: only requireAuth may set req.admin.
    expectUnauthorized(await get(app, '/role-only', await sign(superAdmin)));
  });

  it('refuses to build without any role', () => {
    expect(() => requireRole()).toThrow('requireRole needs at least one role');
  });

  it('error bodies have only code and message', async () => {
    const { app } = authApp();
    const unauthorized = await get(app, '/super');
    const forbidden = await get(app, '/super', await sign(editor));
    for (const res of [unauthorized, forbidden]) {
      expect(Object.keys(res.body as object)).toEqual(['error']);
      expect(Object.keys((res.body as { error: object }).error).sort()).toEqual([
        'code',
        'message',
      ]);
    }
  });
});

describe('auth logging', () => {
  function capture() {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    return { logger: pino({ level: 'debug' }, stream), output: () => lines.join('') };
  }

  it('logs failure reasons at debug level but never the token', async () => {
    const { logger, output } = capture();
    const { app } = authApp(undefined, logger);
    const inactiveToken = await sign(inactive);
    const badToken = await sign(editor, { secret: 'another-jwt-secret-0123456789abcdef' });
    const okToken = await sign(editor);
    const forbiddenToken = await sign(editor);

    await get(app, '/me');
    await get(app, '/me', badToken);
    await get(app, '/me', await sign({ id: randomUUID(), role: 'EDITOR' }));
    await get(app, '/me', inactiveToken);
    await get(app, '/me', okToken);
    await get(app, '/super', forbiddenToken);

    const log = output();
    for (const reason of ['no_cookie', 'invalid_token', 'unknown_admin', 'inactive']) {
      expect(log).toContain(`"reason":"${reason}"`);
    }
    expect(log).toContain('Role not allowed');
    for (const token of [inactiveToken, badToken, okToken, forbiddenToken]) {
      expect(log).not.toContain(token);
      // Not even the signature segment on its own.
      expect(log).not.toContain(token.split('.')[2]);
    }
    expect(log).not.toContain(ACCESS_COOKIE_NAME);
  });
});
