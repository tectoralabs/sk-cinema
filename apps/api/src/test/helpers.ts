import { randomUUID } from 'node:crypto';
import { csrfTokenResponseSchema } from '@sk-cinema/shared';
import type { Express } from 'express';
import { pino, type Logger } from 'pino';
import request from 'supertest';
import { vi } from 'vitest';
import { createApp } from '../app.js';
import type { Config } from '../config/env.js';
import type {
  Admin,
  AuditLog,
  Prisma,
  PrismaClient,
  RefreshToken,
} from '../generated/prisma/client.js';
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, REFRESH_COOKIE_NAME } from '../lib/authCookies.js';
import { MemoryCache } from '../lib/cache.js';
import { generateRefreshToken, hashRefreshToken } from '../lib/tokens.js';
import { CSRF_HEADER } from '../middleware/csrf.js';

export const silentLogger = pino({ level: 'silent' });

/** testConfig().corsOrigins: the public site. Never trusted by /api/admin. */
export const PUBLIC_ORIGIN = 'http://localhost:5173';
/** testConfig().adminOrigins: the admin app, the only origin /api/admin trusts. */
export const ADMIN_ORIGIN = 'http://localhost:5174';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'test',
    isProduction: false,
    port: 0,
    logLevel: 'silent',
    databaseUrl: 'postgresql://user:pass@localhost:5432/test',
    // The public site (CORS without credentials) and the admin app (credentialed CORS, CSRF).
    corsOrigins: [PUBLIC_ORIGIN],
    adminOrigins: [ADMIN_ORIGIN],
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

/**
 * A live RefreshToken row (unrevoked, expiring in a week) with safe defaults. Pass `adminId`
 * and, to bind an access token to it, use its `familyId` as the token's `sessionId`.
 */
export function testRefreshToken(
  overrides: Partial<RefreshToken> & Pick<RefreshToken, 'adminId'>,
): RefreshToken {
  return {
    id: randomUUID(),
    tokenHash: hashRefreshToken(generateRefreshToken()),
    familyId: randomUUID(),
    expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
    revokedAt: null,
    replacedById: null,
    ipAddress: null,
    userAgent: null,
    createdAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// inMemoryAuthDb: an in-memory Prisma stand-in for the Admin, RefreshToken and AuditLog tables.
// ---------------------------------------------------------------------------

/**
 * Thrown (as a rejected promise, like Prisma's own validation errors) when the code under test
 * uses a Prisma feature the fake does not implement, so the fake fails loudly instead of
 * silently answering differently from Postgres.
 */
export class UnsupportedByFakeError extends Error {
  override name = 'UnsupportedByFakeError';
}

const unsupported = (what: string) =>
  new UnsupportedByFakeError(`inMemoryAuthDb: ${what} is not supported by the fake`);

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
type ModelName = 'admin' | 'refreshToken' | 'auditLog';

// The column lists are checked against the generated types: a schema change that adds or
// drops a column fails typecheck here until the fake knows about it.
const ADMIN_COLUMNS = {
  id: true,
  email: true,
  name: true,
  passwordHash: true,
  role: true,
  isActive: true,
  mustChangePassword: true,
  failedLoginCount: true,
  lockedUntil: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Record<keyof Admin, true>;

const REFRESH_TOKEN_COLUMNS = {
  id: true,
  adminId: true,
  tokenHash: true,
  familyId: true,
  expiresAt: true,
  revokedAt: true,
  replacedById: true,
  ipAddress: true,
  userAgent: true,
  createdAt: true,
} as const satisfies Record<keyof RefreshToken, true>;

const AUDIT_LOG_COLUMNS = {
  id: true,
  adminId: true,
  action: true,
  entity: true,
  entityId: true,
  details: true,
  ipAddress: true,
  userAgent: true,
  createdAt: true,
} as const satisfies Record<keyof AuditLog, true>;

interface ModelSpec {
  columns: ReadonlySet<string>;
  /** Columns that identify one row (findUnique / update `where`). */
  unique: readonly string[];
  /** Columns `create` must be given (no default in schema.prisma). */
  required: readonly string[];
  /** Json columns: hold any JSON value in `data`, cannot be filtered on here. */
  json: ReadonlySet<string>;
  /** To-one relations a `select` may follow. */
  relations: Readonly<Partial<Record<string, ModelName>>>;
}

const MODELS: Record<ModelName, ModelSpec> = {
  admin: {
    columns: new Set(Object.keys(ADMIN_COLUMNS)),
    unique: ['id', 'email'],
    required: ['email', 'name', 'passwordHash'],
    json: new Set(),
    relations: {},
  },
  refreshToken: {
    columns: new Set(Object.keys(REFRESH_TOKEN_COLUMNS)),
    unique: ['id', 'tokenHash'],
    required: ['adminId', 'tokenHash', 'familyId', 'expiresAt'],
    json: new Set(),
    relations: { admin: 'admin' },
  },
  auditLog: {
    columns: new Set(Object.keys(AUDIT_LOG_COLUMNS)),
    unique: ['id'],
    required: ['action', 'entity'],
    json: new Set(['details']),
    relations: {},
  },
};

const RANGE_OPERATORS: ReadonlySet<string> = new Set(['lt', 'lte', 'gt', 'gte']);

const isPlainObject = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

/** Throws for any option the fake would otherwise silently ignore (orderBy, skip, include...). */
function checkOptions(at: string, args: object, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw unsupported(`${at}: option "${key}"`);
  }
}

/**
 * Accepts only what the services use: per-column equality (Dates by time), `null` (IS NULL)
 * and `{ lt, lte, gt, gte }` with Date or number bounds. Everything else throws: other
 * operators (`not`, `in`, `contains`, `mode`, `equals`...), `OR` / `AND` / `NOT`, relation
 * filters, unknown columns, Json filters and `undefined` values.
 */
function checkWhere(model: ModelName, where: unknown, at: string): asserts where is Where {
  if (!isPlainObject(where)) throw unsupported(`${at}: a where that is not an object`);
  const spec = MODELS[model];
  for (const [key, condition] of Object.entries(where)) {
    if (!spec.columns.has(key)) {
      throw unsupported(
        `${at}: where key "${key}" (only ${model} columns; no OR/AND/NOT or relation filters)`,
      );
    }
    if (spec.json.has(key)) throw unsupported(`${at}: filtering on the Json column "${key}"`);
    if (condition === undefined) throw unsupported(`${at}: where.${key} = undefined`);
    if (Array.isArray(condition)) throw unsupported(`${at}: an array as where.${key}`);
    if (!isPlainObject(condition)) continue; // equality or IS NULL
    const operators = Object.entries(condition);
    if (operators.length === 0) throw unsupported(`${at}: an empty filter on ${key}`);
    for (const [operator, bound] of operators) {
      if (!RANGE_OPERATORS.has(operator)) {
        throw unsupported(
          `${at}: operator "${operator}" on ${key} (only equality and lt/lte/gt/gte)`,
        );
      }
      if (!(bound instanceof Date) && typeof bound !== 'number') {
        throw unsupported(`${at}: a ${key}.${operator} bound that is not a Date or number`);
      }
    }
  }
}

/** A `where` that must pick one row by a unique column, as findUnique and update require. */
function checkUniqueWhere(model: ModelName, where: unknown, at: string): asserts where is Where {
  checkWhere(model, where, at);
  const { unique } = MODELS[model];
  const byUnique = unique.some((key) => {
    const value = where[key];
    return value !== null && value !== undefined && !isPlainObject(value);
  });
  if (!byUnique) throw unsupported(`${at}: a where without a unique column (${unique.join(', ')})`);
}

/** Plain column values, plus `{ increment: n }` on number columns when `increment` is allowed. */
function checkData(model: ModelName, data: unknown, at: string, increment: boolean): Row {
  if (!isPlainObject(data)) throw unsupported(`${at}: data that is not an object`);
  const spec = MODELS[model];
  for (const [key, value] of Object.entries(data)) {
    if (!spec.columns.has(key)) {
      throw unsupported(`${at}: data key "${key}" (only ${model} columns; no nested writes)`);
    }
    if (value === undefined) throw unsupported(`${at}: data.${key} = undefined`);
    if (spec.json.has(key)) continue;
    if (Array.isArray(value)) throw unsupported(`${at}: an array as data.${key}`);
    if (!isPlainObject(value)) continue;
    const ops = Object.keys(value);
    if (!(increment && ops.length === 1 && typeof value['increment'] === 'number')) {
      throw unsupported(`${at}: the update operation ${JSON.stringify(ops)} on ${key}`);
    }
  }
  return data;
}

/**
 * `select` of columns (true/false), of a to-one relation (`true` or `{ select }`), and on
 * admin.findUnique of `_count: { select: { refreshTokens: true | { where } } }`.
 */
function checkSelect(model: ModelName, select: unknown, at: string, allowCount = false): void {
  if (select === undefined) return;
  if (!isPlainObject(select)) throw unsupported(`${at}: a select that is not an object`);
  const spec = MODELS[model];
  for (const [key, value] of Object.entries(select)) {
    if (spec.columns.has(key)) {
      if (value !== true && value !== false)
        throw unsupported(`${at}: select.${key} = ${String(value)}`);
      continue;
    }
    const relation = spec.relations[key];
    if (relation) {
      if (value === true) continue;
      if (!isPlainObject(value)) throw unsupported(`${at}: select.${key} = ${String(value)}`);
      checkOptions(`${at}: select.${key}`, value, ['select']);
      checkSelect(relation, value['select'], `${at}: select.${key}`);
      continue;
    }
    if (key === '_count' && allowCount && model === 'admin') {
      if (!isPlainObject(value)) throw unsupported(`${at}: select._count = ${String(value)}`);
      checkOptions(`${at}: select._count`, value, ['select']);
      const counted = value['select'];
      if (!isPlainObject(counted)) throw unsupported(`${at}: select._count without a select`);
      for (const [relationKey, relationSpec] of Object.entries(counted)) {
        if (relationKey !== 'refreshTokens') throw unsupported(`${at}: _count of ${relationKey}`);
        if (relationSpec === true) continue;
        if (!isPlainObject(relationSpec)) throw unsupported(`${at}: _count.refreshTokens spec`);
        checkOptions(`${at}: _count.refreshTokens`, relationSpec, ['where']);
        checkWhere('refreshToken', relationSpec['where'], `${at}: _count.refreshTokens`);
      }
      continue;
    }
    throw unsupported(`${at}: select key "${key}" on ${model}`);
  }
}

interface RangeFilter {
  lt?: Date | number;
  lte?: Date | number;
  gt?: Date | number;
  gte?: Date | number;
}

/** A Date or number as a number, or null for anything else (including SQL NULL). */
const numeric = (value: unknown): number | null =>
  value instanceof Date ? value.getTime() : typeof value === 'number' ? value : null;

/**
 * `lt` / `lte` / `gt` / `gte` the way SQL compares: a NULL (or non-comparable) column never
 * matches, and a bound must be the same kind (Date or number) as the column value.
 */
function inRange(value: unknown, filter: RangeFilter): boolean {
  const actual = numeric(value);
  if (actual === null) return false;
  const bound = (b: Date | number): number => {
    if (b instanceof Date !== value instanceof Date) {
      throw new UnsupportedByFakeError(
        'inMemoryAuthDb: range bound and column are different types',
      );
    }
    return b instanceof Date ? b.getTime() : b;
  };
  if (filter.lt !== undefined && !(actual < bound(filter.lt))) return false;
  if (filter.lte !== undefined && !(actual <= bound(filter.lte))) return false;
  if (filter.gt !== undefined && !(actual > bound(filter.gt))) return false;
  if (filter.gte !== undefined && !(actual >= bound(filter.gte))) return false;
  return true;
}

/** Evaluates a `where` that checkWhere already accepted. */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (isPlainObject(condition)) return inRange(value, condition);
    if (condition instanceof Date) {
      return value instanceof Date && value.getTime() === condition.getTime();
    }
    return value === condition; // includes null: IS NULL
  });
}

const prismaError = (code: string, message: string) => Object.assign(new Error(message), { code });

/**
 * Wraps a delegate method so that every error (fake misuse, P2002, P2025...) is a rejected
 * promise, as with Prisma, while the matching and writing still run synchronously in the call.
 */
function operation<A, R>(fn: (args: A) => R): (args: A) => Promise<R> {
  return (args) => {
    try {
      return Promise.resolve(fn(args));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
}

interface FindUniqueArgs {
  where: Where;
  select?: Row;
}
interface UpdateArgs {
  where: Where;
  data: Row;
  select?: Row;
}
interface UpdateManyArgs {
  where: Where;
  data: Row;
}
interface CreateArgs {
  data: Row;
  select?: Row;
}

type Undo = () => void;

/**
 * An in-memory stand-in for the admin, refreshToken and auditLog delegates plus interactive
 * $transaction. Every delegate method is a vi.fn, so tests can assert on the exact Prisma
 * calls or make one fail (`mockRejectedValueOnce`); a call made through a transaction client
 * goes through the same vi.fn.
 *
 * Queries. Only the options the services use are implemented (see checkWhere, checkData,
 * checkSelect); anything else rejects with UnsupportedByFakeError instead of being ignored.
 * Each call matches and writes synchronously, without yielding, like one SQL statement, so
 * updateMany / updateManyAndReturn are atomic conditional UPDATEs. Rows are returned as
 * projected copies. create enforces the unique columns (P2002) and the adminId foreign key
 * (P2003); update of a missing row rejects with P2025.
 *
 * Transactions model exactly this:
 * - Atomicity. The callback gets its own transaction client. Every write made through it is
 *   recorded in that transaction's undo log (a created row, or the previous values of the
 *   columns an update changed). If the callback throws, the log is undone in reverse order and
 *   the error is rethrown; if it returns, the log is dropped (commit). Writes made through the
 *   root client, inside or outside the callback, are never undone by a rollback.
 * - Serialisation. Transactions run one at a time, in call order (a promise queue), the way
 *   Postgres row locks serialise writers that touch the same rows. Calls outside any
 *   transaction are not queued and interleave freely with an open transaction.
 * - A transaction client used after its transaction ended rejects.
 *
 * Not modelled: isolation (every read sees every write at once, including another open
 * transaction's uncommitted writes), row locks for writers outside a transaction (they never
 * wait), isolation levels and transaction options (rejected), batch `$transaction([...])`
 * (rejected), nested transactions, and writes a test's own mockImplementation makes after an
 * `await` (not recorded). If a rollback finds that a column it must restore was changed by
 * someone else meanwhile (which Postgres would have prevented with the row lock), it throws
 * UnsupportedByFakeError rather than silently losing that write.
 */
export function inMemoryAuthDb(seed: { admins?: Admin[]; refreshTokens?: RefreshToken[] } = {}) {
  const store = {
    admins: (seed.admins ?? []).map((a) => ({ ...a })),
    refreshTokens: (seed.refreshTokens ?? []).map((t) => ({ ...t })),
    auditLogs: [] as AuditLog[],
  };
  const tables: Record<ModelName, Row[]> = {
    admin: store.admins,
    refreshToken: store.refreshTokens,
    auditLog: store.auditLogs,
  };
  const findRow = (model: ModelName, where: Where) => tables[model].find((r) => matches(r, where));
  const findAll = (model: ModelName, where: Where) =>
    tables[model].filter((r) => matches(r, where));

  /** The undo log of the transaction whose client call is running right now, if any. */
  let activeLog: Undo[] | null = null;
  const recordUndo = (undo: Undo) => {
    activeLog?.push(undo);
  };

  const insert = (model: ModelName, row: Row) => {
    tables[model].push(row);
    recordUndo(() => {
      const index = tables[model].indexOf(row);
      if (index === -1) throw new UnsupportedByFakeError(`inMemoryAuthDb: ${model} row vanished`);
      tables[model].splice(index, 1);
    });
  };

  /** Applies update data, including `{ increment: n }`, the way SQL would. */
  const write = (model: ModelName, row: Row, data: Row) => {
    const changes: { key: string; before: unknown; after: unknown }[] = [];
    for (const [key, value] of Object.entries(data)) {
      const before = row[key];
      const after =
        isPlainObject(value) && !MODELS[model].json.has(key)
          ? (before as number) + (value['increment'] as number)
          : value;
      row[key] = after;
      changes.push({ key, before, after });
    }
    recordUndo(() => {
      for (const { key, before, after } of changes.reverse()) {
        if (!Object.is(row[key], after)) {
          throw new UnsupportedByFakeError(
            `inMemoryAuthDb: cannot roll back ${model}.${key}: it was written outside the ` +
              'transaction while the transaction was open (Postgres would have made that ' +
              'writer wait for the row lock; the fake does not model row locks)',
          );
        }
        row[key] = before;
      }
    });
  };

  const related = (model: ModelName, key: string, row: Row): Row | undefined => {
    if (model === 'refreshToken' && key === 'admin') {
      return store.admins.find((a) => a.id === row['adminId']);
    }
    throw unsupported(`the relation ${model}.${key}`);
  };

  /** Prisma's relation `_count`: the admin's refresh tokens matching an optional `where`. */
  const countFor = (adminRow: Row, spec: unknown): Row => {
    const counted = (spec as { select: Row }).select;
    const out: Row = {};
    for (const [key, relationSpec] of Object.entries(counted)) {
      const where = relationSpec === true ? {} : ((relationSpec as { where?: Where }).where ?? {});
      out[key] = findAll('refreshToken', where).filter(
        (t) => t['adminId'] === adminRow['id'],
      ).length;
    }
    return out;
  };

  /** Applies a select checkSelect already accepted; no select returns all columns. */
  const project = (model: ModelName, row: Row, select: Row | undefined): Row => {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [key, value] of Object.entries(select)) {
      if (value === false) continue;
      if (key === '_count') {
        out[key] = countFor(row, value);
        continue;
      }
      const relation = MODELS[model].relations[key];
      if (relation) {
        const target = related(model, key, row);
        const nested = isPlainObject(value) ? (value['select'] as Row | undefined) : undefined;
        out[key] = target ? project(relation, target, nested) : null;
        continue;
      }
      out[key] = row[key];
    }
    return out;
  };

  const findUnique = (model: ModelName) =>
    vi.fn(
      operation((args: FindUniqueArgs) => {
        const at = `${model}.findUnique`;
        checkOptions(at, args, ['where', 'select']);
        checkUniqueWhere(model, args.where, at);
        checkSelect(model, args.select, at, true);
        const found = findRow(model, args.where);
        return found ? project(model, found, args.select) : null;
      }),
    );

  const update = (model: ModelName, autoData: () => Row) =>
    vi.fn(
      operation((args: UpdateArgs) => {
        const at = `${model}.update`;
        checkOptions(at, args, ['where', 'data', 'select']);
        checkUniqueWhere(model, args.where, at);
        checkData(model, args.data, at, true);
        checkSelect(model, args.select, at);
        const found = findRow(model, args.where);
        if (!found) throw prismaError('P2025', 'Record to update not found');
        write(model, found, { ...autoData(), ...args.data });
        return project(model, found, args.select);
      }),
    );

  const updateMany = (model: ModelName, autoData: () => Row) =>
    vi.fn(
      operation((args: UpdateManyArgs) => {
        const at = `${model}.updateMany`;
        checkOptions(at, args, ['where', 'data']);
        checkWhere(model, args.where, at);
        checkData(model, args.data, at, true);
        const hits = findAll(model, args.where);
        for (const row of hits) write(model, row, { ...autoData(), ...args.data });
        return { count: hits.length };
      }),
    );

  /** One `UPDATE ... WHERE ... RETURNING`: filters and writes in the same synchronous step. */
  const updateManyAndReturn = (model: ModelName, autoData: () => Row) =>
    vi.fn(
      operation((args: UpdateArgs) => {
        const at = `${model}.updateManyAndReturn`;
        checkOptions(at, args, ['where', 'data', 'select']);
        checkWhere(model, args.where, at);
        checkData(model, args.data, at, true);
        checkSelect(model, args.select, at);
        const hits = findAll(model, args.where);
        for (const row of hits) write(model, row, { ...autoData(), ...args.data });
        return hits.map((row) => project(model, row, args.select));
      }),
    );

  const create = (model: ModelName, defaults: () => Row) =>
    vi.fn(
      operation((args: CreateArgs) => {
        const at = `${model}.create`;
        checkOptions(at, args, ['data', 'select']);
        checkData(model, args.data, at, false);
        checkSelect(model, args.select, at);
        const missing = MODELS[model].required.filter((key) => !(key in args.data));
        if (missing.length > 0) throw new Error(`${at}: missing required ${missing.join(', ')}`);
        const row: Row = { id: randomUUID(), ...defaults(), ...args.data };
        for (const key of MODELS[model].unique) {
          if (tables[model].some((r) => r[key] === row[key])) {
            throw prismaError('P2002', `Unique constraint failed on the fields: (\`${key}\`)`);
          }
        }
        const adminId = row['adminId'];
        if (
          adminId !== null &&
          adminId !== undefined &&
          !store.admins.some((a) => a.id === adminId)
        ) {
          throw prismaError('P2003', 'Foreign key constraint violated on the constraint: adminId');
        }
        insert(model, row);
        return project(model, row, args.select);
      }),
    );

  const touch = () => ({ updatedAt: new Date() });
  const none = () => ({});

  const admin = {
    findUnique: findUnique('admin'),
    update: update('admin', touch),
    updateMany: updateMany('admin', touch),
    updateManyAndReturn: updateManyAndReturn('admin', touch),
  };

  const refreshToken = {
    create: create('refreshToken', () => ({
      revokedAt: null,
      replacedById: null,
      ipAddress: null,
      userAgent: null,
      createdAt: new Date(),
    })),
    findUnique: findUnique('refreshToken'),
    update: update('refreshToken', none),
    updateMany: updateMany('refreshToken', none),
  };

  const auditLog = {
    create: create('auditLog', () => ({
      adminId: null,
      entityId: null,
      details: null,
      ipAddress: null,
      userAgent: null,
      createdAt: new Date(),
    })),
  };

  const delegates = { admin, refreshToken, auditLog };

  /**
   * A transaction client: the same vi.fn delegates, but each call runs with this
   * transaction's undo log active, so the writes it makes (synchronously, see `operation`)
   * are recorded. Unusable once the transaction ended. Has no $transaction (no nesting).
   */
  const transactionClient = (state: { log: Undo[]; open: boolean }) => {
    const wrap = (delegate: Record<string, (args: never) => Promise<unknown>>) =>
      Object.fromEntries(
        Object.entries(delegate).map(([name, method]) => [
          name,
          (args: never) => {
            if (!state.open) {
              return Promise.reject(
                new UnsupportedByFakeError('inMemoryAuthDb: transaction client used after the end'),
              );
            }
            const outer = activeLog;
            activeLog = state.log;
            try {
              return method(args);
            } finally {
              activeLog = outer;
            }
          },
        ]),
      );
    return {
      admin: wrap(admin),
      refreshToken: wrap(refreshToken),
      auditLog: wrap(auditLog),
    } as unknown as Prisma.TransactionClient;
  };

  let queue: Promise<unknown> = Promise.resolve();
  const $transaction = vi.fn((fn: unknown, options?: unknown): Promise<unknown> => {
    if (typeof fn !== 'function') {
      return Promise.reject(unsupported('$transaction without an interactive callback'));
    }
    if (options !== undefined) {
      return Promise.reject(unsupported('$transaction options (isolationLevel, timeout...)'));
    }
    const callback = fn as (tx: Prisma.TransactionClient) => Promise<unknown>;
    const run = queue.then(async () => {
      const state = { log: [] as Undo[], open: true };
      try {
        return await callback(transactionClient(state));
      } catch (error) {
        for (const undo of state.log.reverse()) undo();
        throw error;
      } finally {
        state.open = false;
      }
    });
    queue = run.catch(() => undefined);
    return run;
  });

  const prisma = fakePrisma({ ...delegates, $transaction });

  /** `spies` are the vi.fn delegates behind `prisma` (and every transaction client). */
  return { prisma, ...store, spies: { ...delegates, $transaction } };
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
    const { body, cookies = [], origin = ADMIN_ORIGIN, token = csrf.token } = send;
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
