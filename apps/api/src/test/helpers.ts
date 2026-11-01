import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { hash as argon2Hash } from '@node-rs/argon2';
import { csrfTokenResponseSchema } from '@sk-cinema/shared';
import type { Express } from 'express';
import { pino, type Logger } from 'pino';
import request from 'supertest';
import { vi } from 'vitest';
import { createApp } from '../app.js';
import type { Config } from '../config/env.js';
import {
  Prisma,
  type Admin,
  type AuditLog,
  type Movie,
  type PrismaClient,
  type RefreshToken,
} from '../generated/prisma/client.js';
import { AdminRole, AuditAction, MovieStatus } from '../generated/prisma/enums.js';
import { ADMIN_API_PATH } from '../lib/apiPaths.js';
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

/**
 * argon2id at the lowest cost argon2 accepts (8 KiB, 1 pass, 1 lane). TEST FIXTURES ONLY.
 * argon2 reads the cost from the stored hash, so the app's real verifyPassword checks these
 * hashes, and a login against one costs ~0.1 ms instead of ~20 ms at the production cost.
 * Production hashing (lib/password.ts, 19 MiB / 2 passes) is unchanged and is covered by
 * password.test.ts and by one login against a hashPassword() hash in auth.routes.test.ts.
 */
export const TEST_ARGON2_OPTIONS = { memoryCost: 8, timeCost: 1, parallelism: 1 } as const;

/** A cheap argon2id hash of `password` for a test admin's `passwordHash` (see TEST_ARGON2_OPTIONS). */
export function testPasswordHash(password: string): Promise<string> {
  return argon2Hash(password, TEST_ARGON2_OPTIONS);
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
// inMemoryAuthDb: an in-memory Prisma stand-in for the Admin, RefreshToken, AuditLog and Movie
// tables.
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
/** The Prisma delegates the fake models. */
export type FakeModel = 'admin' | 'refreshToken' | 'auditLog' | 'movie';
type ModelName = FakeModel;

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

const MOVIE_COLUMNS = {
  id: true,
  slug: true,
  title: true,
  synopsis: true,
  durationMinutes: true,
  language: true,
  genres: true,
  rating: true,
  director: true,
  cast: true,
  releaseDate: true,
  trailerUrl: true,
  posterUrl: true,
  posterPublicId: true,
  bannerUrl: true,
  bannerPublicId: true,
  status: true,
  isActive: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Record<keyof Movie, true>;

/** The keys of T whose type includes null. */
type NullableKey<T> = { [K in keyof T]-?: null extends T[K] ? K : never }[keyof T];

/**
 * Nullable movie columns (`Type?` in schema.prisma). Checked against the generated type both
 * ways: a column missing here or listed but not nullable fails typecheck.
 */
const MOVIE_NULLABLE = {
  synopsis: true,
  language: true,
  rating: true,
  director: true,
  releaseDate: true,
  trailerUrl: true,
  posterUrl: true,
  posterPublicId: true,
  bannerUrl: true,
  bannerPublicId: true,
  deletedAt: true,
} as const satisfies Record<NullableKey<Movie>, true>;

interface ModelSpec {
  /** The Prisma model (and table) name, as in error `meta.modelName` and constraint names. */
  name: string;
  columns: ReadonlySet<string>;
  /** Columns that identify one row (findUnique / update / delete `where`). */
  unique: readonly string[];
  /** Columns `create` must be given (no default in schema.prisma). */
  required: readonly string[];
  /** Nullable columns: default to null on create; the only ones that may be set to null. */
  nullable: ReadonlySet<string>;
  /** Json columns: hold any JSON value in `data`, cannot be filtered on here. */
  json: ReadonlySet<string>;
  /** Scalar lists (`String[]`): written whole, never filtered on or sorted by. */
  lists: ReadonlySet<string>;
  /** Enum columns and their values in declaration order (how Postgres sorts enums). */
  enums: Readonly<Partial<Record<string, readonly string[]>>>;
  /** To-one relations a `select` may follow. */
  relations: Readonly<Partial<Record<string, ModelName>>>;
  /**
   * Where operators accepted besides equality, null and lt/lte/gt/gte, per column; the `*`
   * entry applies to every column without its own entry.
   */
  operators: Readonly<Partial<Record<string, ReadonlySet<string>>>>;
  /** Whether a where may contain `OR: [...]`. */
  or: boolean;
}

const NO_OPERATORS: ReadonlySet<string> = new Set();
const MOVIE_ANY_COLUMN_OPERATORS = ['not', 'in'];

const MODELS: Record<ModelName, ModelSpec> = {
  admin: {
    name: 'Admin',
    columns: new Set(Object.keys(ADMIN_COLUMNS)),
    unique: ['id', 'email'],
    required: ['email', 'name', 'passwordHash'],
    nullable: new Set(['lockedUntil', 'lastLoginAt']),
    json: new Set(),
    lists: new Set(),
    enums: { role: Object.values(AdminRole) },
    relations: {},
    operators: {},
    or: false,
  },
  refreshToken: {
    name: 'RefreshToken',
    columns: new Set(Object.keys(REFRESH_TOKEN_COLUMNS)),
    unique: ['id', 'tokenHash'],
    required: ['adminId', 'tokenHash', 'familyId', 'expiresAt'],
    nullable: new Set(['revokedAt', 'replacedById', 'ipAddress', 'userAgent']),
    json: new Set(),
    lists: new Set(),
    enums: {},
    relations: { admin: 'admin' },
    operators: {},
    or: false,
  },
  auditLog: {
    name: 'AuditLog',
    columns: new Set(Object.keys(AUDIT_LOG_COLUMNS)),
    unique: ['id'],
    required: ['action', 'entity'],
    nullable: new Set(['adminId', 'entityId', 'details', 'ipAddress', 'userAgent']),
    json: new Set(['details']),
    lists: new Set(),
    enums: { action: Object.values(AuditAction) },
    relations: {},
    operators: {},
    or: false,
  },
  movie: {
    name: 'Movie',
    columns: new Set(Object.keys(MOVIE_COLUMNS)),
    unique: ['id', 'slug'],
    required: ['slug', 'title', 'durationMinutes'],
    nullable: new Set(Object.keys(MOVIE_NULLABLE)),
    json: new Set(),
    lists: new Set(['genres', 'cast']),
    enums: { status: Object.values(MovieStatus) },
    relations: {},
    operators: {
      '*': new Set(MOVIE_ANY_COLUMN_OPERATORS),
      title: new Set([...MOVIE_ANY_COLUMN_OPERATORS, 'contains', 'mode']),
      slug: new Set([...MOVIE_ANY_COLUMN_OPERATORS, 'contains', 'startsWith', 'mode']),
    },
    or: true,
  },
};

const RANGE_OPERATORS: ReadonlySet<string> = new Set(['lt', 'lte', 'gt', 'gte']);

const isPlainObject = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

/** Equality the way SQL `=` compares the values the fake stores (Dates by instant). */
const sameValue = (a: unknown, b: unknown): boolean =>
  b instanceof Date ? a instanceof Date && a.getTime() === b.getTime() : a === b;

/** A value for an error message. */
const show = (value: unknown): string =>
  value === undefined ? 'undefined' : JSON.stringify(value);

/**
 * A copy of a stored or incoming column value, so callers and the store never share a Date or
 * list. (Json values are kept as they are.)
 */
const copyValue = (value: unknown): unknown =>
  value instanceof Date
    ? new Date(value.getTime())
    : Array.isArray(value)
      ? [...(value as unknown[])]
      : value;

/** Throws for any option the fake would otherwise silently ignore (orderBy, skip, include...). */
function checkOptions(at: string, args: object, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw unsupported(`${at}: option "${key}"`);
  }
}

/** The arguments object of a delegate call; Prisma allows omitting it on findMany and count. */
function argsObject(args: unknown, at: string, optional: boolean): Row {
  if (args === undefined && optional) return {};
  if (!isPlainObject(args)) throw unsupported(`${at}: arguments that are not an object`);
  return args;
}

const operatorsFor = (model: ModelName, column: string): ReadonlySet<string> => {
  const { operators } = MODELS[model];
  return operators[column] ?? operators['*'] ?? NO_OPERATORS;
};

/** One column's filter object, e.g. `{ gte: date }` or `{ contains: 'x', mode: 'insensitive' }`. */
function checkFilter(model: ModelName, key: string, filter: Row, at: string): void {
  const entries = Object.entries(filter);
  if (entries.length === 0) throw unsupported(`${at}: an empty filter on ${key}`);
  const extra = operatorsFor(model, key);
  for (const [operator, operand] of entries) {
    if (RANGE_OPERATORS.has(operator)) {
      if (!(operand instanceof Date) && typeof operand !== 'number') {
        throw unsupported(`${at}: a ${key}.${operator} bound that is not a Date or number`);
      }
      continue;
    }
    if (!extra.has(operator)) {
      const allowed = ['equality', 'lt/lte/gt/gte', ...extra].join(', ');
      throw unsupported(`${at}: operator "${operator}" on ${key} (only ${allowed})`);
    }
    switch (operator) {
      case 'not':
        if (operand !== null) throw unsupported(`${at}: ${key}.not other than null`);
        break;
      case 'in':
        if (
          !Array.isArray(operand) ||
          !operand.every(
            (v) =>
              typeof v === 'string' ||
              typeof v === 'number' ||
              typeof v === 'boolean' ||
              v instanceof Date,
          )
        ) {
          throw unsupported(`${at}: ${key}.in that is not an array of non-null values`);
        }
        break;
      case 'contains':
      case 'startsWith':
        if (typeof operand !== 'string') {
          throw unsupported(`${at}: ${key}.${operator} that is not a string`);
        }
        break;
      case 'mode':
        if (operand !== 'insensitive' && operand !== 'default') {
          throw unsupported(`${at}: ${key}.mode = ${String(operand)}`);
        }
        if (!('contains' in filter || 'startsWith' in filter) || 'in' in filter) {
          throw unsupported(`${at}: ${key}.mode other than with contains/startsWith (and no in)`);
        }
        break;
      default:
        throw unsupported(`${at}: operator "${operator}" on ${key}`);
    }
  }
}

/**
 * Accepts only what the services use. Every model: per-column equality (Dates by time), `null`
 * (IS NULL) and `{ lt, lte, gt, gte }` with Date or number bounds. Movie also: `{ not: null }`,
 * `{ in: [...] }` on any column, `contains` (+ `mode`) on title and slug, `startsWith` (+ `mode`)
 * on slug, and `OR: [...]`. Everything else throws: other operators (`equals`, `endsWith`,
 * `has`, `not: value`...), `AND` / `NOT`, relation filters, unknown columns, Json and list
 * filters and `undefined` values.
 */
function checkWhere(model: ModelName, where: unknown, at: string): asserts where is Where {
  if (!isPlainObject(where)) throw unsupported(`${at}: a where that is not an object`);
  const spec = MODELS[model];
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR' && spec.or) {
      if (!Array.isArray(condition)) throw unsupported(`${at}: an OR that is not an array`);
      condition.forEach((branch, i) => {
        checkWhere(model, branch, `${at}: OR[${i}]`);
      });
      continue;
    }
    if (!spec.columns.has(key)) {
      const logic = spec.or ? 'no AND/NOT' : 'no OR/AND/NOT';
      throw unsupported(
        `${at}: where key "${key}" (only ${model} columns; ${logic} or relation filters)`,
      );
    }
    if (spec.json.has(key)) throw unsupported(`${at}: filtering on the Json column "${key}"`);
    if (spec.lists.has(key)) throw unsupported(`${at}: filtering on the list column "${key}"`);
    if (condition === undefined) throw unsupported(`${at}: where.${key} = undefined`);
    if (Array.isArray(condition)) throw unsupported(`${at}: an array as where.${key}`);
    if (!isPlainObject(condition)) continue; // equality or IS NULL
    checkFilter(model, key, condition, at);
  }
}

/** A `where` that must pick one row by a unique column, as findUnique, update and delete require. */
function checkUniqueWhere(model: ModelName, where: unknown, at: string): asserts where is Where {
  checkWhere(model, where, at);
  const { unique } = MODELS[model];
  const byUnique = unique.some((key) => {
    const value = where[key];
    return value !== null && value !== undefined && !isPlainObject(value);
  });
  if (!byUnique) throw unsupported(`${at}: a where without a unique column (${unique.join(', ')})`);
}

/**
 * Plain column values, whole string arrays for list columns, plus `{ increment: n }` on number
 * columns when `increment` is allowed. Like Prisma's validation, rejects null for a required
 * column and a value outside an enum.
 */
function checkData(model: ModelName, data: unknown, at: string, increment: boolean): Row {
  if (!isPlainObject(data)) throw unsupported(`${at}: data that is not an object`);
  const spec = MODELS[model];
  for (const [key, value] of Object.entries(data)) {
    if (!spec.columns.has(key)) {
      throw unsupported(`${at}: data key "${key}" (only ${model} columns; no nested writes)`);
    }
    if (value === undefined) throw unsupported(`${at}: data.${key} = undefined`);
    if (spec.json.has(key)) continue;
    if (value === null) {
      if (!spec.nullable.has(key)) throw new Error(`${at}: null for the required column ${key}`);
      continue;
    }
    if (spec.lists.has(key)) {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        throw unsupported(`${at}: data.${key} other than an array of strings (no set/push)`);
      }
      continue;
    }
    if (Array.isArray(value)) throw unsupported(`${at}: an array as data.${key}`);
    const values = spec.enums[key];
    if (values && !values.includes(value as string)) {
      throw new Error(`${at}: ${show(value)} is not a valid ${model}.${key}`);
    }
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

interface SortKey {
  column: string;
  descending: boolean;
  nullsFirst: boolean;
}

/**
 * `orderBy`: one object or an array of them, each with exactly one column, as
 * `'asc' | 'desc'` or `{ sort, nulls? }` (`nulls` only on nullable columns, as Prisma requires).
 * Without `nulls`, NULLs sort the Postgres way: last for asc, first for desc.
 */
function checkOrderBy(model: ModelName, orderBy: unknown, at: string): SortKey[] {
  if (orderBy === undefined) return [];
  const spec = MODELS[model];
  const items: unknown[] = Array.isArray(orderBy) ? orderBy : [orderBy];
  return items.map((item) => {
    if (!isPlainObject(item)) throw unsupported(`${at}: an orderBy entry that is not an object`);
    const entries = Object.entries(item);
    const [entry] = entries;
    if (!entry || entries.length !== 1) {
      throw unsupported(
        `${at}: an orderBy object with ${entries.length} keys (use one per object)`,
      );
    }
    const [column, how] = entry;
    if (!spec.columns.has(column)) {
      throw unsupported(`${at}: orderBy "${column}" (only ${model} columns; no relation ordering)`);
    }
    if (spec.json.has(column) || spec.lists.has(column)) {
      throw unsupported(`${at}: orderBy the Json or list column "${column}"`);
    }
    if (how === 'asc' || how === 'desc') {
      return { column, descending: how === 'desc', nullsFirst: how === 'desc' };
    }
    if (!isPlainObject(how)) throw unsupported(`${at}: orderBy.${column} = ${String(how)}`);
    checkOptions(`${at}: orderBy.${column}`, how, ['sort', 'nulls']);
    const { sort, nulls } = how;
    if (sort !== 'asc' && sort !== 'desc') {
      throw unsupported(`${at}: orderBy.${column}.sort = ${show(sort)}`);
    }
    if (nulls !== undefined && nulls !== 'first' && nulls !== 'last') {
      throw unsupported(`${at}: orderBy.${column}.nulls = ${show(nulls)}`);
    }
    if (nulls !== undefined && !spec.nullable.has(column)) {
      throw unsupported(`${at}: orderBy.${column}.nulls on a required column`);
    }
    return {
      column,
      descending: sort === 'desc',
      nullsFirst: nulls === undefined ? sort === 'desc' : nulls === 'first',
    };
  });
}

/** `skip` / `take`: a non-negative integer (a negative `take`, Prisma's reverse paging, is not modelled). */
function checkCount(at: string, name: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw unsupported(`${at}: ${name} = ${show(value)} (only non-negative integers)`);
  }
  return value;
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

const REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|/]/g;

/**
 * Postgres `LIKE` / `ILIKE` with the default escape character: `%` is any run of characters,
 * `_` exactly one character, and a backslash makes the next character literal. Prisma 7 sends
 * `contains` as `LIKE '%' || $1 || '%'` and `startsWith` as `LIKE $1 || '%'` WITHOUT escaping
 * the value, so `%`, `_` and `\` in a search term keep these meanings in Postgres; the fake
 * reproduces that so a service that forgets to escape them fails its tests here too.
 * ILIKE is modelled with JavaScript's Unicode case-insensitive matching.
 */
function like(value: string, pattern: string, insensitive: boolean): boolean {
  let source = '';
  const chars = Array.from(pattern);
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? '';
    if (ch === '\\') {
      i += 1;
      const next = chars[i];
      if (next === undefined) {
        throw new UnsupportedByFakeError('inMemoryAuthDb: a LIKE pattern ending in a backslash');
      }
      source += next.replace(REGEXP_SYNTAX, '\\$&');
    } else if (ch === '%') {
      source += '.*';
    } else if (ch === '_') {
      source += '.';
    } else {
      source += ch.replace(REGEXP_SYNTAX, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, insensitive ? 'isu' : 'su').test(value);
}

/** One column's filter object, already accepted by checkFilter. All operators must hold. */
function matchesFilter(value: unknown, filter: Row): boolean {
  const insensitive = filter['mode'] === 'insensitive';
  if (Object.keys(filter).some((op) => RANGE_OPERATORS.has(op)) && !inRange(value, filter)) {
    return false;
  }
  for (const [operator, operand] of Object.entries(filter)) {
    switch (operator) {
      case 'not': // only `not: null`
        if (value === null) return false;
        break;
      case 'in': // SQL: NULL IN (...) is never true; an empty list matches nothing
        if (!(operand as unknown[]).some((candidate) => sameValue(value, candidate))) return false;
        break;
      case 'contains':
        if (typeof value !== 'string' || !like(value, `%${operand as string}%`, insensitive)) {
          return false;
        }
        break;
      case 'startsWith':
        if (typeof value !== 'string' || !like(value, `${operand as string}%`, insensitive)) {
          return false;
        }
        break;
      default: // range operators (checked above) and mode
        break;
    }
  }
  return true;
}

/** Evaluates a `where` that checkWhere already accepted. An empty `OR: []` matches nothing. */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return (condition as Where[]).some((branch) => matches(row, branch));
    const value = row[key];
    if (isPlainObject(condition)) return matchesFilter(value, condition);
    return sameValue(value, condition); // includes null: IS NULL
  });
}

/**
 * Orders two non-null values of one column: Dates by instant, numbers numerically, false
 * before true, enums by declaration order, and other strings by UTF-16 code unit, which is the
 * Postgres "C" collation's order for everything but characters above U+FFFF. A database with a
 * linguistic collation (e.g. en_US.UTF-8) orders text differently, e.g. "b" before "C".
 */
function compareValues(model: ModelName, column: string, a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (typeof a === 'string' && typeof b === 'string') {
    const order = MODELS[model].enums[column];
    if (order) return order.indexOf(a) - order.indexOf(b);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  throw new UnsupportedByFakeError(`inMemoryAuthDb: cannot order by ${model}.${column}`);
}

/** A stable sort: rows equal on every key keep table (insertion) order. */
function sortRows(model: ModelName, rows: Row[], keys: readonly SortKey[]): Row[] {
  if (keys.length === 0) return rows;
  return [...rows].sort((x, y) => {
    for (const { column, descending, nullsFirst } of keys) {
      const a = x[column];
      const b = y[column];
      if (a === null || b === null) {
        if (a === b) continue;
        return (a === null) === nullsFirst ? -1 : 1;
      }
      const order = compareValues(model, column, a, b);
      if (order !== 0) return descending ? -order : order;
    }
    return 0;
  });
}

/**
 * Real Prisma 7 errors, shaped as `@prisma/adapter-pg` + the Prisma 7.10 client produce them.
 * Note: with a driver adapter, P2002 has NO `meta.target`; the clashing index is in
 * `meta.driverAdapterError.cause.constraint.index`.
 */
function knownRequestError(code: string, message: string, meta: Row) {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: Prisma.prismaVersion.client,
    meta,
  });
}

/** What `@prisma/adapter-pg` throws for a Postgres error: a DriverAdapterError with a `cause`. */
function driverAdapterError(cause: Row): Error {
  const error = new Error(String(cause['kind']));
  error.name = 'DriverAdapterError';
  error.cause = cause;
  return error;
}

/**
 * The P2002 Prisma 7.10.1 (adapter-pg) throws when an insert or update hits a unique index:
 * `meta` is `{ modelName, driverAdapterError }` and the index name is
 * `meta.driverAdapterError.cause.constraint.index`, e.g. `Movie_slug_key`. There is no
 * `meta.target`. Use it with `injectFault` or `mockRejectedValueOnce`.
 */
export function uniqueConstraintError(model: FakeModel, column: string) {
  const { name } = MODELS[model];
  const index = column === 'id' ? `${name}_pkey` : `${name}_${column}_key`;
  return knownRequestError('P2002', `Unique constraint failed on the constraint: \`${index}\``, {
    driverAdapterError: driverAdapterError({
      originalCode: '23505',
      originalMessage: `duplicate key value violates unique constraint "${index}"`,
      kind: 'UniqueConstraintViolation',
      constraint: { index },
      table: name,
    }),
    modelName: name,
  });
}

/** The P2025 Prisma 7.10.1 throws when update or delete finds no row (meta as captured). */
export function recordNotFoundError(model: FakeModel, operation: 'an update' | 'a delete') {
  return knownRequestError(
    'P2025',
    'An operation failed because it depends on one or more records that were required but ' +
      `not found. No record was found for ${operation}.`,
    { modelName: MODELS[model].name, operation },
  );
}

/** A P2003 for a foreign key column, shaped like the P2002 above. */
function foreignKeyError(model: ModelName, column: string) {
  const { name } = MODELS[model];
  const index = `${name}_${column}_fkey`;
  return knownRequestError(
    'P2003',
    `Foreign key constraint violated on the constraint: \`${index}\``,
    {
      driverAdapterError: driverAdapterError({
        originalCode: '23503',
        originalMessage: `insert or update on table "${name}" violates foreign key constraint "${index}"`,
        kind: 'ForeignKeyConstraintViolation',
        constraint: { index },
      }),
      modelName: name,
    },
  );
}

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

let uuidV7Sequence = 0;

/**
 * A UUIDv7-shaped id like Prisma's `uuid(7)`: the clock's milliseconds, then a sequence number
 * where real v7 ids have random bits, so ids made in one millisecond still sort in creation
 * order and a sort by id is deterministic.
 */
export function testUuidV7(): string {
  uuidV7Sequence += 1;
  const time = Date.now().toString(16).padStart(12, '0');
  const seq = uuidV7Sequence.toString(16).padStart(18, '0');
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${seq.slice(0, 3)}-8${seq.slice(3, 6)}-${seq.slice(6, 18)}`;
}

/**
 * A full Movie row with safe defaults (an UPCOMING, active, undeleted "Test Movie"), for
 * `inMemoryAuthDb({ movies: [...] })`. Timestamps are fixed, like testAdmin's; pass
 * `createdAt` / `updatedAt` when a test orders by them.
 */
export function testMovie(overrides: Partial<Movie> = {}): Movie {
  const at = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: testUuidV7(),
    slug: 'test-movie',
    title: 'Test Movie',
    synopsis: null,
    durationMinutes: 120,
    language: null,
    genres: [],
    rating: null,
    director: null,
    cast: [],
    releaseDate: null,
    trailerUrl: null,
    posterUrl: null,
    posterPublicId: null,
    bannerUrl: null,
    bannerPublicId: null,
    status: 'UPCOMING',
    isActive: true,
    deletedAt: null,
    createdAt: at,
    updatedAt: new Date(at.getTime()),
    ...overrides,
  };
}

/** A movie as `create` takes it (or a seed): the required columns, the rest defaulted. */
export type MovieSeed = Partial<Movie> & Pick<Movie, 'slug' | 'title' | 'durationMinutes'>;

interface FindUniqueArgs {
  where: Where;
  select?: Row;
}
interface FindManyArgs {
  where?: Where;
  orderBy?: Row | Row[];
  skip?: number;
  take?: number;
  select?: Row;
}
interface FindFirstArgs {
  where?: Where;
  orderBy?: Row | Row[];
  select?: Row;
}
interface CountArgs {
  where?: Where;
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
interface DeleteArgs {
  where: Where;
  select?: Row;
}

/** See `injectFault`. */
export interface FaultOptions {
  /** Which call to fail, counting from the injection: 1 (default) is the next call. */
  onCall?: number;
  /** Rejected with instead of running the call (nothing is read or written). */
  error?: Error;
  /**
   * Runs just before the call does its work, outside any transaction, e.g. to insert a row
   * with `addMovie` the way a concurrent request would. Without `error`, the call then runs
   * normally against the changed table.
   */
  before?: () => void;
}

type Undo = () => void;

/**
 * An in-memory stand-in for the admin, refreshToken, auditLog and movie delegates plus
 * interactive $transaction. Every delegate method is a vi.fn, so tests can assert on the exact
 * Prisma calls or make one fail (`mockRejectedValueOnce`, or `injectFault` to fail call N or to
 * simulate a concurrent insert); a call made through a transaction client goes through the same
 * vi.fn.
 *
 * Queries. Only the options the services use are implemented (see checkWhere, checkOrderBy,
 * checkData, checkSelect); anything else rejects with UnsupportedByFakeError instead of being
 * ignored. Each call matches and writes synchronously, without yielding, like one SQL
 * statement, so updateMany / updateManyAndReturn are atomic conditional UPDATEs. Rows are
 * returned as projected copies (Dates and lists copied too). create and update enforce the
 * unique columns (P2002), create the adminId foreign key (P2003); update and delete of a
 * missing row reject with P2025. These are real `Prisma.PrismaClientKnownRequestError`s shaped
 * like Prisma 7.10.1 with adapter-pg makes them (see uniqueConstraintError).
 *
 * Movies: findUnique, findFirst, findMany (where, orderBy, skip, take, select), count (where),
 * create, update, delete. Text search follows Postgres LIKE/ILIKE (see `like`); text ordering
 * is the "C" collation's (see compareValues); ties keep insertion order, which Postgres does
 * not promise, so services must add a unique tie-breaker (e.g. id) for stable paging. Not
 * modelled: VarChar length limits, the Showtime ON DELETE CASCADE of a movie delete.
 *
 * Transactions model exactly this:
 * - Atomicity. The callback gets its own transaction client. Every write made through it is
 *   recorded in that transaction's undo log (a created row, a deleted row and its position, or
 *   the previous values of the columns an update changed). If the callback throws, the log is
 *   undone in reverse order and the error is rethrown; if it returns, the log is dropped
 *   (commit). Writes made through the root client, inside or outside the callback, are never
 *   undone by a rollback.
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
export function inMemoryAuthDb(
  seed: { admins?: Admin[]; refreshTokens?: RefreshToken[]; movies?: MovieSeed[] } = {},
) {
  const store = {
    admins: (seed.admins ?? []).map((a) => ({ ...a })),
    refreshTokens: (seed.refreshTokens ?? []).map((t) => ({ ...t })),
    auditLogs: [] as AuditLog[],
    movies: [] as Movie[],
  };
  const tables: Record<ModelName, Row[]> = {
    admin: store.admins,
    refreshToken: store.refreshTokens,
    auditLog: store.auditLogs,
    movie: store.movies,
  };
  const findRow = (model: ModelName, where: Where) => tables[model].find((r) => matches(r, where));
  const findAll = (model: ModelName, where: Where | undefined) =>
    where === undefined ? [...tables[model]] : tables[model].filter((r) => matches(r, where));

  /** The undo log of the transaction whose client call is running right now, if any. */
  let activeLog: Undo[] | null = null;
  const recordUndo = (undo: Undo) => {
    activeLog?.push(undo);
  };

  const faults: (FaultOptions & { model: ModelName; operation: string; callsLeft: number })[] = [];
  /**
   * Counts this call against every fault injected for it, then fires the ones that are due:
   * each due `before` runs, and the earliest-injected due `error` is thrown. Counting finishes
   * before anything fires, so a throwing fault never stops a later fault from counting the call.
   */
  const trip = (model: ModelName, name: string) => {
    const due: typeof faults = [];
    for (const fault of [...faults]) {
      if (fault.model !== model || fault.operation !== name) continue;
      fault.callsLeft -= 1;
      if (fault.callsLeft > 0) continue;
      faults.splice(faults.indexOf(fault), 1);
      due.push(fault);
    }
    for (const fault of due) {
      if (fault.before) {
        const outer = activeLog;
        activeLog = null;
        try {
          fault.before();
        } finally {
          activeLog = outer;
        }
      }
    }
    const failing = due.find((fault) => fault.error);
    if (failing?.error) throw failing.error;
  };

  const insert = (model: ModelName, row: Row) => {
    tables[model].push(row);
    recordUndo(() => {
      const index = tables[model].indexOf(row);
      if (index === -1) throw new UnsupportedByFakeError(`inMemoryAuthDb: ${model} row vanished`);
      tables[model].splice(index, 1);
    });
  };

  const remove = (model: ModelName, row: Row) => {
    const table = tables[model];
    const index = table.indexOf(row);
    table.splice(index, 1);
    recordUndo(() => {
      if (table.includes(row)) {
        throw new UnsupportedByFakeError(`inMemoryAuthDb: deleted ${model} row reappeared`);
      }
      table.splice(Math.min(index, table.length), 0, row);
    });
  };

  /** Throws P2002 if `values` would give a unique column a value another row already has. */
  const checkUnique = (model: ModelName, values: Row, self?: Row) => {
    for (const key of MODELS[model].unique) {
      if (!(key in values)) continue;
      if (tables[model].some((r) => r !== self && sameValue(r[key], values[key]))) {
        throw uniqueConstraintError(model, key);
      }
    }
  };

  /** Applies update data, including `{ increment: n }`, the way SQL would. */
  const write = (model: ModelName, row: Row, data: Row) => {
    const changes: { key: string; before: unknown; after: unknown }[] = [];
    for (const [key, value] of Object.entries(data)) {
      const before = row[key];
      const after =
        isPlainObject(value) && !MODELS[model].json.has(key)
          ? (before as number) + (value['increment'] as number)
          : copyValue(value);
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

  /** A new row: an id, NULL for nullable columns, the model's defaults, then `data` (copied). */
  const newRow = (model: ModelName, defaults: Row, data: Row): Row => {
    const nulls = Object.fromEntries([...MODELS[model].nullable].map((key) => [key, null]));
    const given = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, copyValue(v)]));
    return { id: randomUUID(), ...nulls, ...defaults, ...given };
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
    if (!select) {
      return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, copyValue(value)]));
    }
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
      out[key] = copyValue(row[key]);
    }
    return out;
  };

  const findUnique = (model: ModelName) =>
    vi.fn(
      operation((args: FindUniqueArgs) => {
        const at = `${model}.findUnique`;
        checkOptions(at, argsObject(args, at, false), ['where', 'select']);
        checkUniqueWhere(model, args.where, at);
        checkSelect(model, args.select, at, true);
        trip(model, 'findUnique');
        const found = findRow(model, args.where);
        return found ? project(model, found, args.select) : null;
      }),
    );

  /** The rows a findMany / findFirst selects, in order, before paging and projection. */
  const query = (model: ModelName, at: string, args: { where?: unknown; orderBy?: unknown }) => {
    if (args.where !== undefined) checkWhere(model, args.where, at);
    const order = checkOrderBy(model, args.orderBy, at);
    return () => sortRows(model, findAll(model, args.where as Where | undefined), order);
  };

  const findMany = (model: ModelName) =>
    vi.fn(
      operation((args: FindManyArgs | undefined) => {
        const at = `${model}.findMany`;
        const options = argsObject(args, at, true) as FindManyArgs;
        checkOptions(at, options, ['where', 'orderBy', 'skip', 'take', 'select']);
        const rows = query(model, at, options);
        const skip = checkCount(at, 'skip', options.skip) ?? 0;
        const take = checkCount(at, 'take', options.take);
        checkSelect(model, options.select, at);
        trip(model, 'findMany');
        return rows()
          .slice(skip, take === undefined ? undefined : skip + take)
          .map((row) => project(model, row, options.select));
      }),
    );

  const findFirst = (model: ModelName) =>
    vi.fn(
      operation((args: FindFirstArgs | undefined) => {
        const at = `${model}.findFirst`;
        const options = argsObject(args, at, true) as FindFirstArgs;
        checkOptions(at, options, ['where', 'orderBy', 'select']);
        const rows = query(model, at, options);
        checkSelect(model, options.select, at);
        trip(model, 'findFirst');
        const [first] = rows();
        return first ? project(model, first, options.select) : null;
      }),
    );

  const count = (model: ModelName) =>
    vi.fn(
      operation((args: CountArgs | undefined) => {
        const at = `${model}.count`;
        const options = argsObject(args, at, true) as CountArgs;
        checkOptions(at, options, ['where']);
        if (options.where !== undefined) checkWhere(model, options.where, at);
        trip(model, 'count');
        return findAll(model, options.where).length;
      }),
    );

  const update = (model: ModelName, autoData: () => Row) =>
    vi.fn(
      operation((args: UpdateArgs) => {
        const at = `${model}.update`;
        checkOptions(at, argsObject(args, at, false), ['where', 'data', 'select']);
        checkUniqueWhere(model, args.where, at);
        checkData(model, args.data, at, true);
        checkSelect(model, args.select, at);
        trip(model, 'update');
        const found = findRow(model, args.where);
        if (!found) throw recordNotFoundError(model, 'an update');
        checkUnique(model, args.data, found);
        write(model, found, { ...autoData(), ...args.data });
        return project(model, found, args.select);
      }),
    );

  const updateMany = (model: ModelName, autoData: () => Row) =>
    vi.fn(
      operation((args: UpdateManyArgs) => {
        const at = `${model}.updateMany`;
        checkOptions(at, argsObject(args, at, false), ['where', 'data']);
        checkWhere(model, args.where, at);
        checkData(model, args.data, at, true);
        trip(model, 'updateMany');
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
        checkOptions(at, argsObject(args, at, false), ['where', 'data', 'select']);
        checkWhere(model, args.where, at);
        checkData(model, args.data, at, true);
        checkSelect(model, args.select, at);
        trip(model, 'updateManyAndReturn');
        const hits = findAll(model, args.where);
        for (const row of hits) write(model, row, { ...autoData(), ...args.data });
        return hits.map((row) => project(model, row, args.select));
      }),
    );

  /** Validates a new row's data and builds it (not yet inserted). */
  const buildRow = (model: ModelName, at: string, data: unknown, defaults: () => Row): Row => {
    const checked = checkData(model, data, at, false);
    const missing = MODELS[model].required.filter((key) => !(key in checked));
    if (missing.length > 0) throw new Error(`${at}: missing required ${missing.join(', ')}`);
    return newRow(model, defaults(), checked);
  };

  const create = (model: ModelName, defaults: () => Row) =>
    vi.fn(
      operation((args: CreateArgs) => {
        const at = `${model}.create`;
        checkOptions(at, argsObject(args, at, false), ['data', 'select']);
        const row = buildRow(model, at, args.data, defaults);
        checkSelect(model, args.select, at);
        trip(model, 'create');
        checkUnique(model, row);
        const adminId = row['adminId'];
        if (
          adminId !== null &&
          adminId !== undefined &&
          !store.admins.some((a) => a.id === adminId)
        ) {
          throw foreignKeyError(model, 'adminId');
        }
        insert(model, row);
        return project(model, row, args.select);
      }),
    );

  const deleteOne = (model: ModelName) =>
    vi.fn(
      operation((args: DeleteArgs) => {
        const at = `${model}.delete`;
        checkOptions(at, argsObject(args, at, false), ['where', 'select']);
        checkUniqueWhere(model, args.where, at);
        checkSelect(model, args.select, at);
        trip(model, 'delete');
        const found = findRow(model, args.where);
        if (!found) throw recordNotFoundError(model, 'a delete');
        const deleted = project(model, found, args.select);
        remove(model, found);
        return deleted;
      }),
    );

  const touch = () => ({ updatedAt: new Date() });
  const none = () => ({});
  /** Prisma's defaults for a new Movie (createdAt and @updatedAt share one instant). */
  const movieDefaults = (): Row => {
    const now = Date.now();
    return {
      id: testUuidV7(),
      genres: [],
      cast: [],
      status: MovieStatus.UPCOMING,
      isActive: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };
  };

  const admin = {
    findUnique: findUnique('admin'),
    update: update('admin', touch),
    updateMany: updateMany('admin', touch),
    updateManyAndReturn: updateManyAndReturn('admin', touch),
  };

  const refreshToken = {
    create: create('refreshToken', () => ({ createdAt: new Date() })),
    findUnique: findUnique('refreshToken'),
    update: update('refreshToken', none),
    updateMany: updateMany('refreshToken', none),
  };

  const auditLog = {
    create: create('auditLog', () => ({ createdAt: new Date() })),
  };

  const movie = {
    findUnique: findUnique('movie'),
    findFirst: findFirst('movie'),
    findMany: findMany('movie'),
    count: count('movie'),
    create: create('movie', movieDefaults),
    update: update('movie', touch),
    delete: deleteOne('movie'),
  };

  const delegates = { admin, refreshToken, auditLog, movie };

  /**
   * Inserts a movie straight into the table, outside any transaction and without touching the
   * spies, with the defaults `create` would apply. For seeding mid-test and for `injectFault`'s
   * `before` (a concurrent writer). Rejects a duplicate id or slug. Returns a copy of the row.
   */
  const addMovie = (data: MovieSeed): Movie => {
    const row = buildRow('movie', 'addMovie', data, movieDefaults);
    const outer = activeLog;
    activeLog = null;
    try {
      checkUnique('movie', row);
      insert('movie', row);
    } finally {
      activeLog = outer;
    }
    return project('movie', row, undefined) as Movie;
  };
  for (const movieSeed of seed.movies ?? []) addMovie(movieSeed);

  /**
   * Makes call number `onCall` (default 1: the next call) of `model.operation`, counted from
   * now, through the root client or any transaction client, fail with `error` and/or run
   * `before` first. The call's arguments are validated before it counts; a failing call reads
   * and writes nothing. Several faults on one operation each count every call, including a
   * call another fault fails, so `onCall: 1` and `onCall: 2` fail the next two calls.
   */
  const injectFault = <M extends keyof typeof delegates>(
    model: M,
    operationName: keyof (typeof delegates)[M] & string,
    options: FaultOptions,
  ): void => {
    const onCall = options.onCall ?? 1;
    if (!Number.isSafeInteger(onCall) || onCall < 1) {
      throw new Error(`injectFault: onCall must be a positive integer, got ${String(onCall)}`);
    }
    if (!options.error && !options.before) throw new Error('injectFault: give error and/or before');
    if (typeof (delegates[model] as Record<string, unknown>)[operationName] !== 'function') {
      throw new Error(`injectFault: ${model}.${operationName} is not modelled`);
    }
    faults.push({ ...options, model, operation: operationName, callsLeft: onCall });
  };

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
      movie: wrap(movie),
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

  /**
   * `spies` are the vi.fn delegates behind `prisma` (and every transaction client); the store
   * arrays (`admins`, `refreshTokens`, `auditLogs`, `movies`) are the live tables.
   */
  return { prisma, ...store, spies: { ...delegates, $transaction }, addMovie, injectFault };
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

/** The admin router's mount, from the same constants app.ts and the CORS policy use. */
export const ADMIN_BASE = ADMIN_API_PATH;
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
export async function fetchCsrf(app: Express | Server): Promise<Csrf> {
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
