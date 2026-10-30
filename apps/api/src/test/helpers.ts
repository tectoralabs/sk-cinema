import { randomUUID } from 'node:crypto';
import { csrfTokenResponseSchema } from '@sk-cinema/shared';
import type { Express } from 'express';
import { pino, type Logger } from 'pino';
import request from 'supertest';
import { vi } from 'vitest';
import { createApp } from '../app.js';
import type { Config } from '../config/env.js';
import type { Admin, AuditLog, PrismaClient, RefreshToken } from '../generated/prisma/client.js';
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, REFRESH_COOKIE_NAME } from '../lib/authCookies.js';
import { MemoryCache } from '../lib/cache.js';
import { CSRF_HEADER } from '../middleware/csrf.js';

export const silentLogger = pino({ level: 'silent' });

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'test',
    isProduction: false,
    port: 0,
    logLevel: 'silent',
    databaseUrl: 'postgresql://user:pass@localhost:5432/test',
    corsOrigins: ['http://localhost:5173', 'http://localhost:5174'],
    trustProxy: 0,
    rateLimit: { windowMs: 60_000, max: 1000 },
    auth: {
      // Test-only placeholders; distinct and at least 32 characters, like the env schema requires.
      jwtAccessSecret: 'test-jwt-access-secret-0123456789abcdef',
      csrfSecret: 'test-csrf-secret-0123456789abcdef-0123',
      accessTokenTtlSeconds: 900,
      refreshTokenTtlHours: 168,
      loginMaxFailedAttempts: 5,
      loginLockoutMinutes: 15,
      loginRateLimit: { windowMs: 900_000, max: 10 },
    },
    ...overrides,
  };
}

/** A PrismaClient stand-in exposing only what the code under test uses. */
export function fakePrisma(parts: Partial<Record<keyof PrismaClient, unknown>> = {}): PrismaClient {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]),
    ...parts,
  } as unknown as PrismaClient;
}

/** An Admin row with safe defaults. `passwordHash` is a placeholder unless overridden. */
export function testAdmin(overrides: Partial<Admin> = {}): Admin {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: randomUUID(),
    email: 'editor@skcinema.lk',
    name: 'Test Editor',
    passwordHash: '$argon2id$placeholder',
    role: 'EDITOR',
    isActive: true,
    mustChangePassword: false,
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

/** Supports equality and `{ lte }` / `{ gt }` on Dates, which is all the services use. */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (condition instanceof Date || condition === null || typeof condition !== 'object') {
      return condition instanceof Date && value instanceof Date
        ? value.getTime() === condition.getTime()
        : value === condition;
    }
    const { lte, gt } = condition as { lte?: Date; gt?: Date };
    if (!(value instanceof Date)) return false;
    if (lte && value.getTime() > lte.getTime()) return false;
    if (gt && value.getTime() <= gt.getTime()) return false;
    return true;
  });
}

/** Applies Prisma update data, including `{ increment: n }`, the way SQL would. */
function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && 'increment' in value) {
      row[key] = (row[key] as number) + (value as { increment: number }).increment;
    } else {
      row[key] = value;
    }
  }
}

interface Projection {
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
}

/**
 * Applies a Prisma `select` (scalars plus `{ relation: { select } }`) or `include`
 * (`{ relation: true }`) so services only see the fields they asked for.
 */
function project(row: Row, args: Projection, relation: (key: string) => Row | undefined): Row {
  const nested = (key: string, spec: unknown): Row | null => {
    const related = relation(key);
    if (!related) return null;
    return spec !== null && typeof spec === 'object'
      ? project(related, spec, () => undefined)
      : { ...related };
  };
  if (args.select) {
    const out: Row = {};
    for (const [key, spec] of Object.entries(args.select)) {
      if (spec === true) out[key] = row[key];
      else if (spec) out[key] = nested(key, spec);
    }
    return out;
  }
  const out: Row = { ...row };
  for (const [key, spec] of Object.entries(args.include ?? {})) {
    if (spec) out[key] = nested(key, spec);
  }
  return out;
}

function notFoundError(): Error {
  return Object.assign(new Error('Record to update not found'), { code: 'P2025' });
}

/**
 * An in-memory stand-in for the admin, refreshToken and auditLog delegates plus
 * interactive $transaction (rolled back if the callback throws). Transactions run one at a
 * time, the way Postgres row locks serialise conflicting writers, so a whole-store rollback
 * never undoes another transaction's writes. Every method is a vi.fn, so tests can assert
 * on the exact Prisma calls. Rows are returned as copies; findUnique honours select/include.
 */
export function inMemoryAuthDb(seed: { admins?: Admin[] } = {}) {
  const store = {
    admins: (seed.admins ?? []).map((a) => ({ ...a })),
    refreshTokens: [] as RefreshToken[],
    auditLogs: [] as AuditLog[],
  };
  const findAdmin = (where: Where) => store.admins.find((a) => matches(a, where));
  const findToken = (where: Where) => store.refreshTokens.find((t) => matches(t, where));

  const admin = {
    findUnique: vi.fn(({ where, ...args }: { where: Where } & Projection) => {
      const found = findAdmin(where);
      return Promise.resolve(found ? project(found, args, () => undefined) : null);
    }),
    update: vi.fn(({ where, data }: { where: Where; data: Row }) => {
      const found = findAdmin(where);
      if (!found) return Promise.reject(notFoundError());
      applyData(found, { ...data, updatedAt: new Date() });
      return Promise.resolve({ ...found });
    }),
    updateMany: vi.fn(({ where, data }: { where: Where; data: Row }) => {
      const hits = store.admins.filter((a) => matches(a, where));
      hits.forEach((a) => {
        applyData(a, { ...data, updatedAt: new Date() });
      });
      return Promise.resolve({ count: hits.length });
    }),
  };

  const refreshToken = {
    create: vi.fn(({ data }: { data: Row }) => {
      const row = {
        id: randomUUID(),
        revokedAt: null,
        replacedById: null,
        ipAddress: null,
        userAgent: null,
        createdAt: new Date(),
        ...data,
      } as RefreshToken;
      if (store.refreshTokens.some((t) => t.tokenHash === row.tokenHash)) {
        return Promise.reject(Object.assign(new Error('Unique constraint'), { code: 'P2002' }));
      }
      store.refreshTokens.push(row);
      return Promise.resolve({ ...row });
    }),
    findUnique: vi.fn(({ where, ...args }: { where: Where } & Projection) => {
      const found = findToken(where);
      if (!found) return Promise.resolve(null);
      const relation = (key: string) =>
        key === 'admin' ? findAdmin({ id: found.adminId }) : undefined;
      return Promise.resolve(project(found, args, relation));
    }),
    update: vi.fn(({ where, data }: { where: Where; data: Row }) => {
      const found = findToken(where);
      if (!found) return Promise.reject(notFoundError());
      applyData(found, data);
      return Promise.resolve({ ...found });
    }),
    updateMany: vi.fn(({ where, data }: { where: Where; data: Row }) => {
      const hits = store.refreshTokens.filter((t) => matches(t, where));
      hits.forEach((t) => {
        applyData(t, data);
      });
      return Promise.resolve({ count: hits.length });
    }),
  };

  const auditLog = {
    create: vi.fn(({ data }: { data: Row }) => {
      const row = {
        id: randomUUID(),
        adminId: null,
        entityId: null,
        details: null,
        ipAddress: null,
        userAgent: null,
        createdAt: new Date(),
        ...data,
      } as AuditLog;
      store.auditLogs.push(row);
      return Promise.resolve({ ...row });
    }),
  };

  const prisma = fakePrisma({ admin, refreshToken, auditLog });
  const snapshot = () => ({
    admins: store.admins.map((a) => ({ ...a })),
    refreshTokens: store.refreshTokens.map((t) => ({ ...t })),
    auditLogs: [...store.auditLogs],
  });
  let queue: Promise<unknown> = Promise.resolve();
  const $transaction = vi.fn((fn: (tx: PrismaClient) => Promise<unknown>) => {
    const run = queue.then(async () => {
      const before = snapshot();
      try {
        return await fn(prisma);
      } catch (error) {
        store.admins.splice(0, Infinity, ...before.admins);
        store.refreshTokens.splice(0, Infinity, ...before.refreshTokens);
        store.auditLogs.splice(0, Infinity, ...before.auditLogs);
        throw error;
      }
    });
    queue = run.catch(() => undefined);
    return run;
  });
  Object.assign(prisma, { $transaction });

  /** `spies` are the vi.fn delegates behind `prisma`, for call assertions. */
  return { prisma, ...store, spies: { admin, refreshToken, auditLog, $transaction } };
}

export type InMemoryAuthDb = ReturnType<typeof inMemoryAuthDb>;

export function buildTestApp(
  options: { config?: Partial<Config>; prisma?: PrismaClient; logger?: Logger } = {},
) {
  const prisma = options.prisma ?? fakePrisma();
  const cache = new MemoryCache();
  const app = createApp({
    config: testConfig(options.config),
    logger: options.logger ?? silentLogger,
    prisma,
    cache,
  });
  return { app, prisma, cache };
}

export interface ParsedCookie {
  value: string;
  attributes: Record<string, string | true>;
}

/** Parses Set-Cookie headers by cookie name; attribute names are lower-cased. */
export function parseSetCookies(res: request.Response): Record<string, ParsedCookie> {
  const header = res.headers['set-cookie'] as string[] | string | undefined;
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const parsed: Record<string, ParsedCookie> = {};
  for (const line of lines) {
    const [pair = '', ...attrs] = line.split('; ');
    const eq = pair.indexOf('=');
    const attributes: Record<string, string | true> = {};
    for (const attr of attrs) {
      const i = attr.indexOf('=');
      if (i === -1) attributes[attr.toLowerCase()] = true;
      else attributes[attr.slice(0, i).toLowerCase()] = attr.slice(i + 1);
    }
    parsed[pair.slice(0, eq)] = { value: pair.slice(eq + 1), attributes };
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// A browser-like client for the admin API (CSRF dance, cookies, Origin).
// ---------------------------------------------------------------------------

export const ADMIN_BASE = '/api/admin';
/** One of testConfig().corsOrigins: the admin app's origin. */
export const ALLOWED_ORIGIN = 'http://localhost:5174';
export const TEST_USER_AGENT = 'Mozilla/5.0 (SK Cinema API test)';

/** A "name=value" pair for a Cookie request header. */
export const cookiePair = (name: string, value: string) => `${name}=${value}`;

export interface Csrf {
  /** "name=value" for the Cookie header. */
  cookie: string;
  /** The raw CSRF cookie value, to look for leaks. */
  cookieValue: string;
  /** The X-CSRF-Token value from the response body. */
  token: string;
  /** The GET /csrf response itself. */
  response: request.Response;
}

/** GET /csrf, keeping the CSRF cookie and token, as the admin app does on load. */
export async function fetchCsrf(app: Express): Promise<Csrf> {
  const res = await request(app).get(`${ADMIN_BASE}/auth/csrf`);
  const cookie = parseSetCookies(res)[CSRF_COOKIE_NAME];
  if (!cookie) throw new Error('no CSRF cookie');
  return {
    cookie: cookiePair(CSRF_COOKIE_NAME, cookie.value),
    cookieValue: cookie.value,
    token: csrfTokenResponseSchema.parse(res.body).csrfToken,
    response: res,
  };
}

export interface SendOptions {
  body?: object | string;
  /** Extra cookie pairs ("name=value"). */
  cookies?: string[];
  /** null: omit the header. */
  origin?: string | null;
  /** null: omit the header. */
  token?: string | null;
  /** false: do not send the CSRF cookie. */
  csrfCookie?: boolean;
}

export interface AuthClientOptions {
  /** Sent as X-Forwarded-For; only honoured when the app's trustProxy is at least 1. */
  ip?: string;
}

/** A browser-like client that has done the CSRF dance. */
export async function authClient(app: Express, options: AuthClientOptions = {}) {
  const csrf = await fetchCsrf(app);
  const withIp = (req: request.Test) =>
    options.ip === undefined ? req : req.set('X-Forwarded-For', options.ip);

  const post = (path: string, send: SendOptions = {}) => {
    const { body, cookies = [], origin = ALLOWED_ORIGIN, token = csrf.token } = send;
    const all = [...(send.csrfCookie === false ? [] : [csrf.cookie]), ...cookies];
    let req = withIp(request(app).post(`${ADMIN_BASE}${path}`).set('User-Agent', TEST_USER_AGENT));
    if (all.length > 0) req = req.set('Cookie', all.join('; '));
    if (origin !== null) req = req.set('Origin', origin);
    if (token !== null) req = req.set(CSRF_HEADER, token);
    return body === undefined ? req : req.send(body);
  };

  /** No CSRF header or Origin: safe methods must not need them. */
  const get = (path: string, cookies: string[] = []) => {
    const req = withIp(request(app).get(`${ADMIN_BASE}${path}`));
    return cookies.length > 0 ? req.set('Cookie', cookies.join('; ')) : req;
  };

  return { csrf, post, get };
}

export type AuthClient = Awaited<ReturnType<typeof authClient>>;

export interface Session {
  /** "name=value" pairs for the Cookie header. */
  access: string;
  refresh: string;
  /** Raw values, to look for leaks. */
  accessValue: string;
  refreshValue: string;
}

/** The access and refresh cookies a login or refresh response set. Throws if either is missing. */
export function sessionFrom(res: request.Response): Session {
  const cookies = parseSetCookies(res);
  const access = cookies[ACCESS_COOKIE_NAME]?.value;
  const refresh = cookies[REFRESH_COOKIE_NAME]?.value;
  if (!access || !refresh) throw new Error(`no auth cookies (status ${res.status})`);
  return {
    access: cookiePair(ACCESS_COOKIE_NAME, access),
    refresh: cookiePair(REFRESH_COOKIE_NAME, refresh),
    accessValue: access,
    refreshValue: refresh,
  };
}
