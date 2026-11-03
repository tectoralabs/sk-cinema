import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { apiErrorSchema, ERROR_CODES } from '@sk-cinema/shared';
import { pino, type Logger } from 'pino';
import request from 'supertest';
import { expect, vi } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { AdminRole } from '../../generated/prisma/enums.js';
import { CSRF_HEADER } from '../../middleware/csrf.js';
import {
  ADMIN_BASE,
  ADMIN_ORIGIN,
  TEST_USER_AGENT,
  authClient,
  buildTestApp,
  sessionFrom,
  testPasswordHash,
} from '../helpers.js';
import { testPrisma } from './db.js';

/**
 * The real app on the real test database, through HTTP: for promises made by the response.
 *
 * The app's services read the time with `new Date()`, so these tests drive its clock by freezing
 * Date alone (freezeClock): real timers keep running, so database and network waits still end.
 */

/** Freezes Date at `now`; move it with vi.setSystemTime and undo with vi.useRealTimers. */
export function freezeClock(now: Date): void {
  vi.useFakeTimers({ now, toFake: ['Date'] });
}

const ADMIN_PASSWORD = 'correct horse battery staple';

export interface SignedInOptions {
  role?: AdminRole;
  logger?: Logger;
  /** The client the app uses, e.g. testPrisma() wrapped by interceptDb. Default: testPrisma(). */
  prisma?: PrismaClient;
}

/** An app on the test database and a signed-in admin: requests carry its session and CSRF token. */
export async function signedInAdmin({ role = 'EDITOR', logger, prisma }: SignedInOptions = {}) {
  const email = `pg-${randomUUID()}@skcinema.lk`;
  const admin = await testPrisma().admin.create({
    data: { email, name: 'PG', role, passwordHash: await testPasswordHash(ADMIN_PASSWORD) },
  });
  const { app, cache } = buildTestApp({
    prisma: prisma ?? testPrisma(),
    ...(logger !== undefined && { logger }),
  });
  const client = await authClient(app);
  const login = await client.post('/auth/login', { body: { email, password: ADMIN_PASSWORD } });
  expect(login.status).toBe(200);
  const session = sessionFrom(login);
  return {
    admin,
    app,
    /** The app's own cache, to see what a request kept or dropped. */
    cache,
    get: (path: string) => client.get(path, [session.access]),
    post: (path: string, body: object) => client.post(path, { cookies: [session.access], body }),
    patch: (path: string, body: object) =>
      request(app)
        .patch(`${ADMIN_BASE}${path}`)
        .set('User-Agent', TEST_USER_AGENT)
        .set('Origin', ADMIN_ORIGIN)
        .set('Cookie', [client.csrf.cookie, session.access].join('; '))
        .set(CSRF_HEADER, client.csrf.token)
        .send(body),
  };
}

export type LogLine = Record<string, unknown>;

export interface CapturingLogger {
  logger: Logger;
  /** Everything logged since the last clear, as written. */
  raw: () => string;
  /** The parsed lines with this `reason`. */
  withReason: (reason: string) => LogLine[];
  clear: () => void;
}

/** A real pino logger (warn and above) that keeps its output, to read what the app logged. */
export function capturingLogger(): CapturingLogger {
  let output: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      output.push(chunk.toString());
      done();
    },
  });
  const logger = pino({ level: 'warn' }, destination);
  return {
    logger,
    raw: () => output.join(''),
    withReason: (reason) =>
      output.map((line) => JSON.parse(line) as LogLine).filter((line) => line['reason'] === reason),
    clear: () => {
      output = [];
    },
  };
}

/** A 400 VALIDATION_ERROR blaming exactly these request paths (e.g. `['body', 'date']`). */
export function expectValidationError(
  res: request.Response,
  ...paths: readonly (readonly (string | number)[])[]
): void {
  expect(res.status).toBe(400);
  const { error } = apiErrorSchema.parse(res.body);
  expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
  const details = error.details as { path: (string | number)[]; message: string }[];
  expect(details.map((detail) => detail.path)).toEqual(paths);
}
