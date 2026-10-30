import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { vi } from 'vitest';
import { createApp } from '../app.js';
import type { Config } from '../config/env.js';
import type { Admin, AuditLog, PrismaClient, RefreshToken } from '../generated/prisma/client.js';
import { MemoryCache } from '../lib/cache.js';

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

export function buildTestApp(options: { config?: Partial<Config>; prisma?: PrismaClient } = {}) {
  const prisma = options.prisma ?? fakePrisma();
  const cache = new MemoryCache();
  const app = createApp({
    config: testConfig(options.config),
    logger: silentLogger,
    prisma,
    cache,
  });
  return { app, prisma, cache };
}
