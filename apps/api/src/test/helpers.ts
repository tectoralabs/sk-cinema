import { Buffer } from 'node:buffer';
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
  type Screen,
  type Setting,
  type Showtime,
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
export type FakeModel =
  'admin' | 'refreshToken' | 'auditLog' | 'movie' | 'screen' | 'showtime' | 'setting';
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

const SCREEN_COLUMNS = {
  id: true,
  name: true,
  capacity: true,
  isActive: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Record<keyof Screen, true>;

const SCREEN_NULLABLE = {
  capacity: true,
  deletedAt: true,
} as const satisfies Record<NullableKey<Screen>, true>;

const SHOWTIME_COLUMNS = {
  id: true,
  movieId: true,
  screenId: true,
  startsAt: true,
  format: true,
  bookingUrlOverride: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Record<keyof Showtime, true>;

const SHOWTIME_NULLABLE = {
  bookingUrlOverride: true,
  deletedAt: true,
} as const satisfies Record<NullableKey<Showtime>, true>;

const SETTING_COLUMNS = {
  key: true,
  value: true,
  updatedById: true,
  updatedAt: true,
} as const satisfies Record<keyof Setting, true>;

const SETTING_NULLABLE = {
  updatedById: true,
} as const satisfies Record<NullableKey<Setting>, true>;

/** A to-one relation: the target model and the foreign key column on this model. */
interface RelationSpec {
  model: ModelName;
  column: string;
}

/** What a delete of the referenced row does to referencing rows (schema.prisma onDelete). */
type OnDelete = 'cascade' | 'restrict' | 'setNull';

/**
 * Where-filter logic keys. `AND` / `NOT` are only accepted where the code under test needs
 * them, so a model keeps refusing what no service sends.
 */
type LogicKey = 'AND' | 'OR' | 'NOT';

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
  /** To-one relations a `select` / `include` may follow. */
  relations: Readonly<Partial<Record<string, RelationSpec>>>;
  /** Whether a where may filter on `relations` (`movie: { is: {...} }` or `movie: {...}`). */
  relationFilters: boolean;
  /**
   * Foreign key columns and the model they reference, in the order Postgres checks them (the
   * constraints' creation order in the init migration), so the first bad one is reported.
   */
  foreignKeys: readonly RelationSpec[];
  /**
   * Where operators accepted besides equality, null and lt/lte/gt/gte, per column; the `*`
   * entry applies to every column without its own entry. `not` is `{ not: null }` only;
   * `not:value` also allows `{ not: value }` on a required column (SQL `<>`).
   */
  operators: Readonly<Partial<Record<string, ReadonlySet<string>>>>;
  /** The logic keys a where may contain. */
  logic: ReadonlySet<LogicKey>;
}

const NO_OPERATORS: ReadonlySet<string> = new Set();
const MOVIE_ANY_COLUMN_OPERATORS = ['not', 'in'];
const SHOWTIME_ANY_COLUMN_OPERATORS = ['not', 'not:value', 'in'];
const NO_LOGIC: ReadonlySet<LogicKey> = new Set();

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
    relationFilters: false,
    foreignKeys: [],
    operators: {},
    logic: NO_LOGIC,
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
    relations: { admin: { model: 'admin', column: 'adminId' } },
    relationFilters: false,
    foreignKeys: [{ model: 'admin', column: 'adminId' }],
    operators: {},
    logic: NO_LOGIC,
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
    relationFilters: false,
    foreignKeys: [{ model: 'admin', column: 'adminId' }],
    operators: {},
    logic: NO_LOGIC,
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
    relationFilters: false,
    foreignKeys: [],
    operators: {
      '*': new Set(MOVIE_ANY_COLUMN_OPERATORS),
      title: new Set([...MOVIE_ANY_COLUMN_OPERATORS, 'contains', 'mode']),
      slug: new Set([...MOVIE_ANY_COLUMN_OPERATORS, 'contains', 'startsWith', 'mode']),
    },
    logic: new Set(['OR']),
  },
  screen: {
    name: 'Screen',
    columns: new Set(Object.keys(SCREEN_COLUMNS)),
    unique: ['id', 'name'],
    required: ['name'],
    nullable: new Set(Object.keys(SCREEN_NULLABLE)),
    json: new Set(),
    lists: new Set(),
    enums: {},
    relations: {},
    relationFilters: false,
    foreignKeys: [],
    operators: {
      '*': new Set(SHOWTIME_ANY_COLUMN_OPERATORS),
      name: new Set([...SHOWTIME_ANY_COLUMN_OPERATORS, 'equals', 'contains', 'mode']),
    },
    logic: NO_LOGIC,
  },
  showtime: {
    name: 'Showtime',
    columns: new Set(Object.keys(SHOWTIME_COLUMNS)),
    unique: ['id'],
    required: ['movieId', 'screenId', 'startsAt'],
    nullable: new Set(Object.keys(SHOWTIME_NULLABLE)),
    json: new Set(),
    lists: new Set(),
    enums: {},
    relations: {
      movie: { model: 'movie', column: 'movieId' },
      screen: { model: 'screen', column: 'screenId' },
    },
    relationFilters: true,
    foreignKeys: [
      { model: 'movie', column: 'movieId' },
      { model: 'screen', column: 'screenId' },
    ],
    operators: { '*': new Set(SHOWTIME_ANY_COLUMN_OPERATORS) },
    logic: new Set(['AND', 'OR', 'NOT']),
  },
  setting: {
    name: 'Setting',
    columns: new Set(Object.keys(SETTING_COLUMNS)),
    unique: ['key'],
    required: ['key', 'value'],
    nullable: new Set(Object.keys(SETTING_NULLABLE)),
    json: new Set(),
    lists: new Set(),
    enums: {},
    relations: { updatedBy: { model: 'admin', column: 'updatedById' } },
    relationFilters: false,
    foreignKeys: [{ model: 'admin', column: 'updatedById' }],
    operators: { '*': new Set(['in']) },
    logic: NO_LOGIC,
  },
};

/**
 * The foreign keys pointing at each model and their onDelete action (schema.prisma), applied
 * when a row of that model is deleted: Cascade deletes the referencing rows, Restrict refuses
 * the delete (P2003), SetNull clears the column.
 */
const REFERENCES: Readonly<
  Partial<Record<ModelName, readonly { from: ModelName; column: string; onDelete: OnDelete }[]>>
> = {
  admin: [
    { from: 'refreshToken', column: 'adminId', onDelete: 'cascade' },
    { from: 'auditLog', column: 'adminId', onDelete: 'setNull' },
    { from: 'setting', column: 'updatedById', onDelete: 'setNull' },
  ],
  movie: [{ from: 'showtime', column: 'movieId', onDelete: 'cascade' }],
  screen: [{ from: 'showtime', column: 'screenId', onDelete: 'restrict' }],
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

const isScalar = (v: unknown): boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v instanceof Date;

/**
 * One column's filter object, e.g. `{ gte: date }` or `{ contains: 'x', mode: 'insensitive' }`.
 * `negated`: the filter sits under a `NOT`, where SQL's three-valued logic would make a
 * comparison with a NULL column exclude the row (Prisma sends `NOT "col" = $1`), so on a
 * nullable column only `{ not: null }` (IS NOT NULL) is accepted there.
 */
function checkFilter(
  model: ModelName,
  key: string,
  filter: Row,
  at: string,
  negated = false,
): void {
  const entries = Object.entries(filter);
  if (entries.length === 0) throw unsupported(`${at}: an empty filter on ${key}`);
  const spec = MODELS[model];
  const extra = operatorsFor(model, key);
  const nullable = spec.nullable.has(key);
  for (const [operator, operand] of entries) {
    if (negated && nullable && !(operator === 'not' && operand === null)) {
      throw unsupported(
        `${at}: ${key}.${operator} under NOT on a nullable column (SQL NULL logic; only null / { not: null })`,
      );
    }
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
        if (operand === null) break;
        // `not: value` is SQL `<>`, which never matches a NULL; only on required columns here.
        if (!extra.has('not:value')) throw unsupported(`${at}: ${key}.not other than null`);
        if (nullable) throw unsupported(`${at}: ${key}.not with a value on a nullable column`);
        if (!isScalar(operand)) throw unsupported(`${at}: ${key}.not that is not a plain value`);
        break;
      case 'in':
        if (!Array.isArray(operand) || !operand.every(isScalar)) {
          throw unsupported(`${at}: ${key}.in that is not an array of non-null values`);
        }
        break;
      case 'contains':
      case 'startsWith':
      case 'equals':
        if (typeof operand !== 'string') {
          throw unsupported(`${at}: ${key}.${operator} that is not a string`);
        }
        break;
      case 'mode':
        if (operand !== 'insensitive' && operand !== 'default') {
          throw unsupported(`${at}: ${key}.mode = ${String(operand)}`);
        }
        if (
          !('contains' in filter || 'startsWith' in filter || 'equals' in filter) ||
          'in' in filter
        ) {
          throw unsupported(
            `${at}: ${key}.mode other than with contains/startsWith/equals (and no in)`,
          );
        }
        break;
      default:
        throw unsupported(`${at}: operator "${operator}" on ${key}`);
    }
  }
}

/** The branches of an AND / OR / NOT: OR takes an array, AND / NOT an object or an array. */
function logicBranches(key: LogicKey, condition: unknown, at: string): unknown[] {
  if (key === 'OR') {
    if (!Array.isArray(condition)) throw unsupported(`${at}: an OR that is not an array`);
    return condition;
  }
  if (!Array.isArray(condition)) return [condition];
  if (condition.length === 0) throw unsupported(`${at}: an empty ${key} array`);
  return condition;
}

/** The inner where of a to-one relation filter: `{ is: {...} }` or the shorthand `{...}`. */
function relationWhere(condition: unknown, key: string, at: string): unknown {
  if (!isPlainObject(condition)) {
    throw unsupported(`${at}: relation filter ${key} that is not an object`);
  }
  if ('isNot' in condition) throw unsupported(`${at}: ${key}.isNot`);
  if (!('is' in condition)) return condition;
  if (Object.keys(condition).length !== 1) {
    throw unsupported(`${at}: ${key}.is next to other keys`);
  }
  return condition['is'];
}

/**
 * Accepts only what the services use. Every model: per-column equality (Dates by time), `null`
 * (IS NULL) and `{ lt, lte, gt, gte }` with Date or number bounds. Per model (see MODELS):
 * movie `{ not: null }`, `{ in }`, `contains` (+ `mode`) on title and slug, `startsWith`
 * (+ `mode`) on slug, and `OR`; screen `{ not: null | value }`, `{ in }`, and `equals` /
 * `contains` (+ `mode`) on name; showtime `{ not: null | value }`, `{ in }`, AND / OR / NOT, and the
 * relation filters `movie` / `screen` (`{ is: {...} }` or shorthand, judged by the related
 * model's own rules); setting `{ in }`. Everything else throws: other operators (`endsWith`,
 * `has`, `notIn`...), `isNot`, to-many relation filters, unknown columns, Json and list filters,
 * `undefined` values, and conditions under NOT that SQL NULL logic would decide (see
 * checkFilter).
 */
function checkWhere(
  model: ModelName,
  where: unknown,
  at: string,
  negated = false,
): asserts where is Where {
  if (!isPlainObject(where)) throw unsupported(`${at}: a where that is not an object`);
  const spec = MODELS[model];
  for (const [key, condition] of Object.entries(where)) {
    if ((key === 'AND' || key === 'OR' || key === 'NOT') && spec.logic.has(key)) {
      logicBranches(key, condition, at).forEach((branch, i) => {
        checkWhere(model, branch, `${at}: ${key}[${i}]`, negated || key === 'NOT');
      });
      continue;
    }
    const relation = spec.relations[key];
    if (relation && spec.relationFilters) {
      checkWhere(relation.model, relationWhere(condition, key, at), `${at}: ${key}`, negated);
      continue;
    }
    if (!spec.columns.has(key)) {
      const logic = (['OR', 'AND', 'NOT'] as const).filter((k) => !spec.logic.has(k));
      const noLogic = logic.length > 0 ? `no ${logic.join('/')}` : 'AND/OR/NOT';
      const relations = spec.relationFilters ? 'to-one relation filters' : 'no relation filters';
      throw unsupported(
        `${at}: where key "${key}" (only ${model} columns; ${noLogic}; ${relations})`,
      );
    }
    if (spec.json.has(key)) throw unsupported(`${at}: filtering on the Json column "${key}"`);
    if (spec.lists.has(key)) throw unsupported(`${at}: filtering on the list column "${key}"`);
    if (condition === undefined) throw unsupported(`${at}: where.${key} = undefined`);
    if (Array.isArray(condition)) throw unsupported(`${at}: an array as where.${key}`);
    if (!isPlainObject(condition)) {
      // Equality or IS NULL. Under NOT, `col = value` on a nullable column is SQL-NULL logic.
      if (negated && condition !== null && spec.nullable.has(key)) {
        throw unsupported(`${at}: ${key} = value under NOT on a nullable column (SQL NULL logic)`);
      }
      continue;
    }
    checkFilter(model, key, condition, at, negated);
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
      checkSelect(relation.model, value['select'], `${at}: select.${key}`);
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

/**
 * `include` of to-one relations (`true` or `{ select }`): every column of the row plus the
 * included relations. Prisma rejects `select` and `include` together; so does the fake.
 */
function checkInclude(model: ModelName, args: Row, at: string): void {
  const { include } = args;
  if (include === undefined) return;
  if (args['select'] !== undefined) throw unsupported(`${at}: select and include together`);
  if (!isPlainObject(include)) throw unsupported(`${at}: an include that is not an object`);
  for (const [key, value] of Object.entries(include)) {
    const relation = MODELS[model].relations[key];
    if (!relation) throw unsupported(`${at}: include key "${key}" on ${model}`);
    if (value === true || value === false) continue;
    if (!isPlainObject(value)) throw unsupported(`${at}: include.${key} = ${String(value)}`);
    checkOptions(`${at}: include.${key}`, value, ['select']);
    checkSelect(relation.model, value['select'], `${at}: include.${key}`);
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
 * One character lower-cased the way Postgres `lower()` / ILIKE does it: a single character
 * mapped on its own (Unicode simple lowercase), not JavaScript's case folding. So `ſ` stays
 * `ſ` (never matches `s`), `Σ` becomes `σ` (never `ς`, whatever follows it), and `İ` becomes
 * `i` (JavaScript's full mapping is `i` + U+0307; the first code point is the simple mapping).
 * Accents stay: `É` becomes `é`, never `e`. Checked against Postgres 18 with C.UTF-8.
 */
const lowerChar = (ch: string): string => {
  const first = ch.toLowerCase().codePointAt(0);
  return first === undefined ? ch : String.fromCodePoint(first);
};

/** A string lower-cased character by character, as Postgres ILIKE compares both sides. */
const pgLower = (text: string): string => Array.from(text, lowerChar).join('');

/**
 * Postgres `LIKE` / `ILIKE` with the default escape character: `%` is any run of characters,
 * `_` exactly one character, and a backslash makes the next character literal. Prisma 7 sends
 * `contains` as `LIKE '%' || $1 || '%'`, `startsWith` as `LIKE $1 || '%'` and an insensitive
 * `equals` as `ILIKE $1` (captured from the generated SQL), all WITHOUT escaping the value, so
 * `%`, `_` and `\` in a search term keep these meanings in Postgres; the fake reproduces that
 * so a service that forgets to escape them fails its tests here too. ILIKE lower-cases both
 * sides per character (see lowerChar) and then matches case-sensitively.
 */
function like(value: string, pattern: string, insensitive: boolean): boolean {
  const subject = insensitive ? pgLower(value) : value;
  const chars = Array.from(insensitive ? pgLower(pattern) : pattern);
  let source = '';
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
  return new RegExp(`^${source}$`, 'su').test(subject);
}

/** One column's filter object, already accepted by checkFilter. All operators must hold. */
function matchesFilter(value: unknown, filter: Row): boolean {
  const insensitive = filter['mode'] === 'insensitive';
  if (Object.keys(filter).some((op) => RANGE_OPERATORS.has(op)) && !inRange(value, filter)) {
    return false;
  }
  for (const [operator, operand] of Object.entries(filter)) {
    switch (operator) {
      case 'not': // `not: null` is IS NOT NULL; `not: value` is `<>` (required columns only)
        if (operand === null ? value === null : sameValue(value, operand)) return false;
        break;
      case 'in': // SQL: NULL IN (...) is never true; an empty list matches nothing
        if (!(operand as unknown[]).some((candidate) => sameValue(value, candidate))) return false;
        break;
      case 'equals': // `=`, or ILIKE $1 (wildcards and all) with mode: 'insensitive'
        if (insensitive) {
          if (typeof value !== 'string' || !like(value, operand as string, true)) return false;
        } else if (!sameValue(value, operand)) {
          return false;
        }
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

/** The live tables, by model, for following relations. */
type Tables = Readonly<Record<ModelName, Row[]>>;

/** The row a to-one relation points at, or undefined (a NULL or dangling foreign key). */
function relatedRow(tables: Tables, model: ModelName, key: string, row: Row): Row | undefined {
  const relation = MODELS[model].relations[key];
  if (!relation) throw unsupported(`the relation ${model}.${key}`);
  const id = row[relation.column];
  if (id === null || id === undefined) return undefined;
  return tables[relation.model].find((target) => target['id'] === id);
}

/** A logic key's branches as an array (AND / NOT also take a single object). */
const branchesOf = (condition: unknown): Where[] =>
  (Array.isArray(condition) ? condition : [condition]) as Where[];

/**
 * Evaluates a `where` that checkWhere already accepted. An empty `OR: []` matches nothing;
 * `NOT: [a, b]` matches rows where neither matches (Prisma: NOT a AND NOT b). A relation
 * filter matches when the related row exists and matches the inner where (Prisma joins it).
 */
function matches(tables: Tables, model: ModelName, row: Row, where: Where): boolean {
  const spec = MODELS[model];
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR' && spec.logic.has('OR')) {
      return (condition as Where[]).some((branch) => matches(tables, model, row, branch));
    }
    if (key === 'AND' && spec.logic.has('AND')) {
      return branchesOf(condition).every((branch) => matches(tables, model, row, branch));
    }
    if (key === 'NOT' && spec.logic.has('NOT')) {
      return branchesOf(condition).every((branch) => !matches(tables, model, row, branch));
    }
    const relation = spec.relations[key];
    if (relation && spec.relationFilters) {
      const target = relatedRow(tables, model, key, row);
      const inner = relationWhere(condition, key, 'matches') as Where;
      return target !== undefined && matches(tables, relation.model, target, inner);
    }
    const value = row[key];
    if (isPlainObject(condition)) return matchesFilter(value, condition);
    return sameValue(value, condition); // includes null: IS NULL
  });
}

/**
 * Text in the Postgres "C" / C.UTF-8 collation's order: by Unicode code point, which is the
 * byte order of UTF-8. (JavaScript's `<` compares UTF-16 code units, which puts characters
 * above U+FFFF, e.g. emoji, before U+E000 to U+FFFF.)
 */
const compareText = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/**
 * Orders two non-null values of one column: Dates by instant, numbers numerically, false
 * before true, enums by declaration order, and other strings by code point (compareText), the
 * Postgres "C" collation's order. A database with a linguistic collation (e.g. en_US.UTF-8)
 * orders text differently, e.g. "b" before "C".
 */
function compareValues(model: ModelName, column: string, a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (typeof a === 'string' && typeof b === 'string') {
    const order = MODELS[model].enums[column];
    if (order) return order.indexOf(a) - order.indexOf(b);
    return compareText(a, b);
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

/**
 * The P2003 an insert or update throws when a foreign key column names a missing row, e.g.
 * `foreignKeyError('showtime', 'movieId')`. Postgres reports SQLSTATE 23503 with the constraint
 * name (no column), so adapter-pg's cause is `{ kind: 'ForeignKeyConstraintViolation',
 * constraint: { index: 'Showtime_movieId_fkey' } }` with no `table`; `meta.modelName` is the
 * model being written. (Postgres 18 messages as captured; the Prisma message and meta follow the
 * Prisma 7.10.1 client's mapping of a DriverAdapterError.)
 */
export function foreignKeyError(model: FakeModel, column: string) {
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
 * The P2003 a delete throws when an `onDelete: Restrict` foreign key still points at the row,
 * e.g. `restrictError('screen', 'showtime', 'screenId')` for a screen that has showtimes.
 * Postgres reports SQLSTATE 23001 (restrict_violation), which adapter-pg maps to
 * `kind: 'RestrictViolation'` and Prisma to P2003; `meta.modelName` is the deleted model.
 */
export function restrictError(model: FakeModel, from: FakeModel, column: string) {
  const { name } = MODELS[model];
  const referencing = MODELS[from].name;
  const index = `${referencing}_${column}_fkey`;
  return knownRequestError(
    'P2003',
    `Foreign key constraint violated on the constraint: \`${index}\``,
    {
      driverAdapterError: driverAdapterError({
        originalCode: '23001',
        originalMessage:
          `update or delete on table "${name}" violates RESTRICT setting of foreign key ` +
          `constraint "${index}" on table "${referencing}"`,
        kind: 'RestrictViolation',
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

/**
 * A full Screen row with safe defaults (an active, undeleted "Screen 1" without a capacity).
 * Pass a different `name` for each screen in one database: names are unique.
 */
export function testScreen(overrides: Partial<Screen> = {}): Screen {
  const at = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: testUuidV7(),
    name: 'Screen 1',
    capacity: null,
    isActive: true,
    deletedAt: null,
    createdAt: at,
    updatedAt: new Date(at.getTime()),
    ...overrides,
  };
}

/** A screen as `create` takes it (or a seed): the name, the rest defaulted. */
export type ScreenSeed = Partial<Screen> & Pick<Screen, 'name'>;

/**
 * A full Showtime row for the given movie and screen: a 2D show without an override, starting
 * 2026-11-01 19:00 Colombo time (13:30 UTC), undeleted, with fixed timestamps.
 */
export function testShowtime(
  overrides: Partial<Showtime> & Pick<Showtime, 'movieId' | 'screenId'>,
): Showtime {
  const at = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: testUuidV7(),
    startsAt: new Date('2026-11-01T13:30:00.000Z'),
    format: '2D',
    bookingUrlOverride: null,
    deletedAt: null,
    createdAt: at,
    updatedAt: new Date(at.getTime()),
    ...overrides,
  };
}

/** A showtime as `create` takes it (or a seed): movie, screen and start, the rest defaulted. */
export type ShowtimeSeed = Partial<Showtime> & Pick<Showtime, 'movieId' | 'screenId' | 'startsAt'>;

/**
 * A Setting row (`value` is always text, e.g. `testSetting('showGapMinutes', '15')`), not
 * updated by any admin, with a fixed updatedAt.
 */
export function testSetting(key: string, value: string, overrides: Partial<Setting> = {}): Setting {
  return {
    key,
    value,
    updatedById: null,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * The only raw SQL the fake understands: a row lock inside an interactive transaction, sent
 * with the `$queryRaw` tagged template exactly like this (whitespace may differ; `$1` is the
 * one template value, the row id as a string):
 *
 *   tx.$queryRaw`SELECT "id" FROM "Movie" WHERE "id" = ${movieId}::uuid FOR UPDATE`
 *   tx.$queryRaw`SELECT "id" FROM "Screen" WHERE "id" = ${screenId}::uuid FOR UPDATE`
 *
 * Each returns `[{ id }]` when the row exists (soft-deleted or not) and `[]` otherwise, and is
 * recorded in order in `db.locks` as `{ table, id }`.
 */
export const LOCK_SQL = {
  Movie: 'SELECT "id" FROM "Movie" WHERE "id" = $1::uuid FOR UPDATE',
  Screen: 'SELECT "id" FROM "Screen" WHERE "id" = $1::uuid FOR UPDATE',
} as const;

/** A table the fake can row-lock with LOCK_SQL. */
export type LockTable = keyof typeof LOCK_SQL;

/** One row lock taken through `tx.$queryRaw` (see LOCK_SQL). */
export interface FakeLock {
  table: LockTable;
  id: string;
}

const LOCK_MODELS: Record<LockTable, ModelName> = { Movie: 'movie', Screen: 'screen' };

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A raw tagged-template query as one string: values as $1, $2..., whitespace collapsed. */
function rawSqlText(strings: readonly string[]): string {
  return strings
    .reduce((sql, part, i) => (i === 0 ? part : `${sql}$${String(i)}${part}`), '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface FindUniqueArgs {
  where: Where;
  select?: Row;
  include?: Row;
}
interface FindManyArgs {
  where?: Where;
  orderBy?: Row | Row[];
  skip?: number;
  take?: number;
  select?: Row;
  include?: Row;
}
interface FindFirstArgs {
  where?: Where;
  orderBy?: Row | Row[];
  select?: Row;
  include?: Row;
}
interface CountArgs {
  where?: Where;
}
interface UpdateArgs {
  where: Where;
  data: Row;
  select?: Row;
  include?: Row;
}
interface UpdateManyArgs {
  where: Where;
  data: Row;
}
interface CreateArgs {
  data: Row;
  select?: Row;
  include?: Row;
}
interface CreateManyArgs {
  data: Row[];
}
interface DeleteArgs {
  where: Where;
  select?: Row;
}
interface DeleteManyArgs {
  where?: Where;
}
interface UpsertArgs {
  where: Where;
  create: Row;
  update: Row;
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

/** The state of one interactive transaction. */
interface TransactionState {
  log: Undo[];
  open: boolean;
}

/** Models whose find / create / update calls accept `include` (of their to-one relations). */
const INCLUDE_MODELS: ReadonlySet<ModelName> = new Set(['showtime']);

const includeOption = (model: ModelName): string[] =>
  INCLUDE_MODELS.has(model) ? ['include'] : [];

/**
 * An in-memory stand-in for the admin, refreshToken, auditLog, movie, screen, showtime and
 * setting delegates plus interactive $transaction and row-lock `$queryRaw`. Every delegate
 * method is a vi.fn, so tests can assert on the exact Prisma calls or make one fail
 * (`mockRejectedValueOnce`, or `injectFault` to fail call N or to simulate a concurrent
 * insert); a call made through a transaction client goes through the same vi.fn.
 *
 * Queries. Only the options the services use are implemented (see checkWhere, checkOrderBy,
 * checkData, checkSelect, checkInclude); anything else rejects with UnsupportedByFakeError
 * instead of being ignored. Each call matches and writes synchronously, without yielding, like
 * one SQL statement, so updateMany / updateManyAndReturn are atomic conditional UPDATEs and
 * createMany / deleteMany are all-or-nothing. Rows are returned as projected copies (Dates and
 * lists copied too). These are enforced with real `Prisma.PrismaClientKnownRequestError`s
 * shaped like Prisma 7.10.1 with adapter-pg makes them:
 * - unique columns on create, createMany, update and upsert (P2002, see uniqueConstraintError;
 *   across all rows, soft-deleted ones included, as the unique index is);
 * - foreign keys on every write (P2003, see foreignKeyError): RefreshToken/AuditLog.adminId,
 *   Showtime.movieId and Showtime.screenId, Setting.updatedById;
 * - onDelete on delete / deleteMany: Showtime.movieId Cascade (a movie delete removes its
 *   showtimes), Showtime.screenId Restrict (P2003, see restrictError, while any showtime,
 *   soft-deleted or not, uses the screen), RefreshToken.adminId Cascade and SetNull for
 *   AuditLog.adminId and Setting.updatedById;
 * - update and delete of a missing row reject with P2025.
 *
 * Per model:
 * - movie: findUnique, findFirst, findMany (where, orderBy, skip, take, select), count,
 *   create, update, delete, deleteMany. Text search follows Postgres LIKE/ILIKE (see `like`).
 * - screen: findUnique, findFirst, findMany, count, create, update, updateMany, delete. Name
 *   search (`contains`) and the insensitive `equals` follow Postgres LIKE/ILIKE too.
 * - showtime: findUnique, findFirst, findMany, count, create, createMany, update, updateMany,
 *   deleteMany; `select` / `include` of `movie` and `screen` (nested select too); where with
 *   AND / OR / NOT and `movie` / `screen` relation filters.
 * - setting: findUnique, findMany, upsert, update (updatedAt bumps on every write); `select` of
 *   `updatedBy` (nested select too), null when the column is.
 * - auditLog: create, createMany. admin / refreshToken: what the auth services use.
 * Text ordering is the "C" collation's (see compareValues); ties keep insertion order, which
 * Postgres does not promise, so services must add a unique tie-breaker (e.g. id) for stable
 * paging. Not modelled: VarChar length limits, `distinct`, Postgres' own ordering of ties.
 *
 * Raw SQL. `tx.$queryRaw` inside a transaction understands exactly the LOCK_SQL row locks,
 * recorded in `locks`; the root `$queryRaw` answers only the health check's `SELECT 1`. Any
 * other raw SQL, `$queryRawUnsafe` and `$executeRaw*` reject with UnsupportedByFakeError.
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
 * wait; a LOCK_SQL lock only records the call), isolation levels and transaction options
 * (rejected), batch `$transaction([...])` (rejected), nested transactions, and writes a test's
 * own mockImplementation makes after an `await` (not recorded). If a rollback finds that a
 * column it must restore was changed by someone else meanwhile (which Postgres would have
 * prevented with the row lock), it throws UnsupportedByFakeError rather than silently losing
 * that write.
 */
export function inMemoryAuthDb(
  seed: {
    admins?: Admin[];
    refreshTokens?: RefreshToken[];
    movies?: MovieSeed[];
    screens?: ScreenSeed[];
    showtimes?: ShowtimeSeed[];
    settings?: Setting[];
  } = {},
) {
  const store = {
    admins: (seed.admins ?? []).map((a) => ({ ...a })),
    refreshTokens: (seed.refreshTokens ?? []).map((t) => ({ ...t })),
    auditLogs: [] as AuditLog[],
    movies: [] as Movie[],
    screens: [] as Screen[],
    showtimes: [] as Showtime[],
    settings: [] as Setting[],
  };
  const tables: Record<ModelName, Row[]> = {
    admin: store.admins,
    refreshToken: store.refreshTokens,
    auditLog: store.auditLogs,
    movie: store.movies,
    screen: store.screens,
    showtime: store.showtimes,
    setting: store.settings,
  };
  const findRow = (model: ModelName, where: Where) =>
    tables[model].find((r) => matches(tables, model, r, where));
  const findAll = (model: ModelName, where: Where | undefined) =>
    where === undefined
      ? [...tables[model]]
      : tables[model].filter((r) => matches(tables, model, r, where));

  /** Every LOCK_SQL row lock taken, in call order (never undone by a rollback). */
  const locks: FakeLock[] = [];

  /** The undo log of the transaction whose client call is running right now, if any. */
  let activeLog: Undo[] | null = null;
  /** The transaction whose client call is running right now, if any. */
  let activeTx: TransactionState | null = null;
  const recordUndo = (undo: Undo) => {
    activeLog?.push(undo);
  };

  type FaultTarget = ModelName | '$queryRaw';
  const faults: (FaultOptions & { model: FaultTarget; operation: string; callsLeft: number })[] =
    [];
  /**
   * Counts this call against every fault injected for it, then fires the ones that are due:
   * each due `before` runs, and the earliest-injected due `error` is thrown. Counting finishes
   * before anything fires, so a throwing fault never stops a later fault from counting the call.
   */
  const trip = (model: FaultTarget, name: string) => {
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

  /**
   * Throws P2002 if `values` would give a unique column a value another row already has
   * (`self` excepted), in the table or among `pending` rows of the same statement.
   */
  const checkUnique = (model: ModelName, values: Row, self?: Row, pending: Row[] = []) => {
    for (const key of MODELS[model].unique) {
      if (!(key in values)) continue;
      const clash = (r: Row) => r !== self && sameValue(r[key], values[key]);
      if (tables[model].some(clash) || pending.some(clash)) {
        throw uniqueConstraintError(model, key);
      }
    }
  };

  /** Throws P2003 for the first foreign key in `values` that names no row (NULL is fine). */
  const checkForeignKeys = (model: ModelName, values: Row) => {
    for (const { model: target, column } of MODELS[model].foreignKeys) {
      const id = values[column];
      if (id === null || id === undefined) continue;
      if (!tables[target].some((r) => r['id'] === id)) throw foreignKeyError(model, column);
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

  /** Throws P2003 if deleting `rows` (and what they cascade to) hits an onDelete Restrict. */
  const checkRestrict = (model: ModelName, rows: readonly Row[]) => {
    for (const { from, column, onDelete } of REFERENCES[model] ?? []) {
      const referencing = tables[from].filter((r) => rows.some((row) => r[column] === row['id']));
      if (referencing.length === 0) continue;
      if (onDelete === 'restrict') throw restrictError(model, from, column);
      if (onDelete === 'cascade') checkRestrict(from, referencing);
    }
  };

  /** Deletes rows and applies each referencing foreign key's onDelete (after checkRestrict). */
  const deleteRows = (model: ModelName, rows: readonly Row[]) => {
    for (const row of rows) {
      for (const { from, column, onDelete } of REFERENCES[model] ?? []) {
        const referencing = tables[from].filter((r) => r[column] === row['id']);
        if (onDelete === 'cascade') deleteRows(from, referencing);
        if (onDelete === 'setNull') for (const r of referencing) write(from, r, { [column]: null });
      }
      remove(model, row);
    }
  };

  /** A new row: an id, NULL for nullable columns, the model's defaults, then `data` (copied). */
  const newRow = (model: ModelName, defaults: Row, data: Row): Row => {
    const { columns, nullable } = MODELS[model];
    const id = columns.has('id') ? { id: randomUUID() } : {};
    const nulls = Object.fromEntries([...nullable].map((key) => [key, null]));
    const given = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, copyValue(v)]));
    return { ...id, ...nulls, ...defaults, ...given };
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

  /** A to-one relation's row, projected with an optional nested select, or null. */
  const projectRelation = (model: ModelName, key: string, row: Row, value: unknown) => {
    const relation = MODELS[model].relations[key];
    if (!relation) throw unsupported(`the relation ${model}.${key}`);
    const target = relatedRow(tables, model, key, row);
    const nested = isPlainObject(value) ? (value['select'] as Row | undefined) : undefined;
    return target ? project(relation.model, target, nested) : null;
  };

  /**
   * Applies a select or include that checkSelect / checkInclude already accepted; neither
   * returns all columns.
   */
  const project = (model: ModelName, row: Row, select: Row | undefined, include?: Row): Row => {
    if (!select) {
      const out = Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, copyValue(value)]),
      );
      for (const [key, value] of Object.entries(include ?? {})) {
        if (value !== false) out[key] = projectRelation(model, key, row, value);
      }
      return out;
    }
    const out: Row = {};
    for (const [key, value] of Object.entries(select)) {
      if (value === false) continue;
      if (key === '_count') {
        out[key] = countFor(row, value);
        continue;
      }
      if (MODELS[model].relations[key]) {
        out[key] = projectRelation(model, key, row, value);
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
        const options = argsObject(args, at, false);
        checkOptions(at, options, ['where', 'select', ...includeOption(model)]);
        checkUniqueWhere(model, args.where, at);
        checkSelect(model, args.select, at, true);
        checkInclude(model, options, at);
        trip(model, 'findUnique');
        const found = findRow(model, args.where);
        return found ? project(model, found, args.select, args.include) : null;
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
        checkOptions(at, options, [
          'where',
          'orderBy',
          'skip',
          'take',
          'select',
          ...includeOption(model),
        ]);
        const rows = query(model, at, options);
        const skip = checkCount(at, 'skip', options.skip) ?? 0;
        const take = checkCount(at, 'take', options.take);
        checkSelect(model, options.select, at);
        checkInclude(model, options as Row, at);
        trip(model, 'findMany');
        return rows()
          .slice(skip, take === undefined ? undefined : skip + take)
          .map((row) => project(model, row, options.select, options.include));
      }),
    );

  const findFirst = (model: ModelName) =>
    vi.fn(
      operation((args: FindFirstArgs | undefined) => {
        const at = `${model}.findFirst`;
        const options = argsObject(args, at, true) as FindFirstArgs;
        checkOptions(at, options, ['where', 'orderBy', 'select', ...includeOption(model)]);
        const rows = query(model, at, options);
        checkSelect(model, options.select, at);
        checkInclude(model, options as Row, at);
        trip(model, 'findFirst');
        const [first] = rows();
        return first ? project(model, first, options.select, options.include) : null;
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
        const options = argsObject(args, at, false);
        checkOptions(at, options, ['where', 'data', 'select', ...includeOption(model)]);
        checkUniqueWhere(model, args.where, at);
        checkData(model, args.data, at, true);
        checkSelect(model, args.select, at);
        checkInclude(model, options, at);
        trip(model, 'update');
        const found = findRow(model, args.where);
        if (!found) throw recordNotFoundError(model, 'an update');
        checkUnique(model, args.data, found);
        checkForeignKeys(model, args.data);
        write(model, found, { ...autoData(), ...args.data });
        return project(model, found, args.select, args.include);
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
        if (hits.length > 1) {
          for (const key of MODELS[model].unique) {
            if (key in args.data) throw uniqueConstraintError(model, key);
          }
        }
        for (const row of hits) checkUnique(model, args.data, row);
        if (hits.length > 0) checkForeignKeys(model, args.data);
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
        const options = argsObject(args, at, false);
        checkOptions(at, options, ['data', 'select', ...includeOption(model)]);
        const row = buildRow(model, at, args.data, defaults);
        checkSelect(model, args.select, at);
        checkInclude(model, options, at);
        trip(model, 'create');
        checkUnique(model, row);
        checkForeignKeys(model, row);
        insert(model, row);
        return project(model, row, args.select, args.include);
      }),
    );

  /**
   * One multi-row INSERT: every row is validated, then unique columns are checked (against the
   * table and the batch), then foreign keys; any failure inserts nothing. Returns `{ count }`.
   * Only an array of rows; `skipDuplicates` is not modelled.
   */
  const createMany = (model: ModelName, defaults: () => Row) =>
    vi.fn(
      operation((args: CreateManyArgs) => {
        const at = `${model}.createMany`;
        checkOptions(at, argsObject(args, at, false), ['data']);
        if (!Array.isArray(args.data)) throw unsupported(`${at}: data that is not an array`);
        const rows = args.data.map((data, i) =>
          buildRow(model, `${at}: data[${i}]`, data, defaults),
        );
        trip(model, 'createMany');
        rows.forEach((row, i) => {
          checkUnique(model, row, undefined, rows.slice(0, i));
        });
        for (const row of rows) checkForeignKeys(model, row);
        for (const row of rows) insert(model, row);
        return { count: rows.length };
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
        checkRestrict(model, [found]);
        const deleted = project(model, found, args.select);
        deleteRows(model, [found]);
        return deleted;
      }),
    );

  /** One `DELETE ... WHERE`: all matching rows or, on a Restrict violation, none. */
  const deleteMany = (model: ModelName) =>
    vi.fn(
      operation((args: DeleteManyArgs | undefined) => {
        const at = `${model}.deleteMany`;
        const options = argsObject(args, at, true) as DeleteManyArgs;
        checkOptions(at, options, ['where']);
        if (options.where !== undefined) checkWhere(model, options.where, at);
        trip(model, 'deleteMany');
        const hits = findAll(model, options.where);
        checkRestrict(model, hits);
        deleteRows(model, hits);
        return { count: hits.length };
      }),
    );

  /** Update the row the unique where finds, or insert `create` (P2002 if that clashes). */
  const upsert = (model: ModelName, defaults: () => Row, autoData: () => Row) =>
    vi.fn(
      operation((args: UpsertArgs) => {
        const at = `${model}.upsert`;
        checkOptions(at, argsObject(args, at, false), ['where', 'create', 'update', 'select']);
        checkUniqueWhere(model, args.where, at);
        const row = buildRow(model, `${at}: create`, args.create, defaults);
        checkData(model, args.update, `${at}: update`, true);
        checkSelect(model, args.select, at);
        trip(model, 'upsert');
        const found = findRow(model, args.where);
        if (found) {
          checkUnique(model, args.update, found);
          checkForeignKeys(model, args.update);
          write(model, found, { ...autoData(), ...args.update });
          return project(model, found, args.select);
        }
        checkUnique(model, row);
        checkForeignKeys(model, row);
        insert(model, row);
        return project(model, row, args.select);
      }),
    );

  const touch = () => ({ updatedAt: new Date() });
  const none = () => ({});
  /** createdAt and @updatedAt share one instant on insert, as Prisma's defaults do. */
  const stamps = (): Row => {
    const now = Date.now();
    return { createdAt: new Date(now), updatedAt: new Date(now) };
  };
  /** Prisma's defaults for a new Movie. */
  const movieDefaults = (): Row => ({
    id: testUuidV7(),
    genres: [],
    cast: [],
    status: MovieStatus.UPCOMING,
    isActive: true,
    ...stamps(),
  });
  const screenDefaults = (): Row => ({ id: testUuidV7(), isActive: true, ...stamps() });
  const showtimeDefaults = (): Row => ({ id: testUuidV7(), format: '2D', ...stamps() });
  const settingDefaults = touch;
  const auditDefaults = () => ({ createdAt: new Date() });

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
    create: create('auditLog', auditDefaults),
    createMany: createMany('auditLog', auditDefaults),
  };

  const movie = {
    findUnique: findUnique('movie'),
    findFirst: findFirst('movie'),
    findMany: findMany('movie'),
    count: count('movie'),
    create: create('movie', movieDefaults),
    update: update('movie', touch),
    delete: deleteOne('movie'),
    deleteMany: deleteMany('movie'),
  };

  const screen = {
    findUnique: findUnique('screen'),
    findFirst: findFirst('screen'),
    findMany: findMany('screen'),
    count: count('screen'),
    create: create('screen', screenDefaults),
    update: update('screen', touch),
    updateMany: updateMany('screen', touch),
    delete: deleteOne('screen'),
  };

  const showtime = {
    findUnique: findUnique('showtime'),
    findFirst: findFirst('showtime'),
    findMany: findMany('showtime'),
    count: count('showtime'),
    create: create('showtime', showtimeDefaults),
    createMany: createMany('showtime', showtimeDefaults),
    update: update('showtime', touch),
    updateMany: updateMany('showtime', touch),
    deleteMany: deleteMany('showtime'),
  };

  const setting = {
    findUnique: findUnique('setting'),
    findMany: findMany('setting'),
    upsert: upsert('setting', settingDefaults, touch),
    update: update('setting', touch),
  };

  const delegates = { admin, refreshToken, auditLog, movie, screen, showtime, setting };

  /**
   * Inserts a row straight into the table, outside any transaction and without touching the
   * spies, with the defaults `create` would apply. Rejects a duplicate unique column (P2002) and
   * a missing foreign key row (P2003). Returns a copy of the row.
   */
  const addRow = (model: ModelName, at: string, data: object, defaults: () => Row): Row => {
    const row = buildRow(model, at, data, defaults);
    const outer = activeLog;
    activeLog = null;
    try {
      checkUnique(model, row);
      checkForeignKeys(model, row);
      insert(model, row);
    } finally {
      activeLog = outer;
    }
    return project(model, row, undefined);
  };

  /**
   * Seeding mid-test, and `injectFault`'s `before` (a concurrent writer): each inserts one row
   * like `create` would, outside any transaction and without touching the spies.
   */
  const addMovie = (data: MovieSeed): Movie =>
    addRow('movie', 'addMovie', data, movieDefaults) as Movie;
  const addScreen = (data: ScreenSeed): Screen =>
    addRow('screen', 'addScreen', data, screenDefaults) as Screen;
  const addShowtime = (data: ShowtimeSeed): Showtime =>
    addRow('showtime', 'addShowtime', data, showtimeDefaults) as Showtime;
  const addSetting = (data: Pick<Setting, 'key' | 'value'> & Partial<Setting>): Setting =>
    addRow('setting', 'addSetting', data, settingDefaults) as Setting;
  for (const movieSeed of seed.movies ?? []) addMovie(movieSeed);
  for (const screenSeed of seed.screens ?? []) addScreen(screenSeed);
  for (const showtimeSeed of seed.showtimes ?? []) addShowtime(showtimeSeed);
  for (const settingSeed of seed.settings ?? []) addSetting(settingSeed);

  /** `$queryRaw`: LOCK_SQL inside a transaction, the health check's SELECT 1 outside. */
  const runRawQuery = (strings: unknown, values: unknown[]): unknown[] => {
    if (!Array.isArray(strings) || !('raw' in strings)) {
      throw unsupported('$queryRaw without a tagged template (e.g. Prisma.sql or a string)');
    }
    const sql = rawSqlText(strings as readonly string[]);
    const table = (Object.keys(LOCK_SQL) as LockTable[]).find((t) => LOCK_SQL[t] === sql);
    if (!table) {
      if (sql === 'SELECT 1' && values.length === 0 && activeTx === null) return [{ ok: 1 }];
      throw unsupported(`$queryRaw ${show(sql)} (only the LOCK_SQL row locks, in a transaction)`);
    }
    if (activeTx === null) {
      throw unsupported(`$queryRaw: a ${table} row lock outside an interactive transaction`);
    }
    const [id] = values;
    if (values.length !== 1 || typeof id !== 'string' || !UUID_TEXT.test(id)) {
      throw unsupported(`$queryRaw: a ${table} row lock with id ${show(id)} (one UUID string)`);
    }
    trip('$queryRaw', 'lock');
    locks.push({ table, id });
    const row = tables[LOCK_MODELS[table]].find(
      (r) => String(r['id']).toLowerCase() === id.toLowerCase(),
    );
    return row ? [{ id: row['id'] }] : [];
  };

  const $queryRaw = vi.fn((strings: unknown, ...values: unknown[]): Promise<unknown> => {
    try {
      return Promise.resolve(runRawQuery(strings, values));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const rejectRaw = (name: string) =>
    vi.fn((): Promise<never> =>
      Promise.reject(unsupported(`${name} (use LOCK_SQL via $queryRaw)`)),
    );
  const rawSpies = {
    $queryRaw,
    $queryRawUnsafe: rejectRaw('$queryRawUnsafe'),
    $executeRaw: rejectRaw('$executeRaw'),
    $executeRawUnsafe: rejectRaw('$executeRawUnsafe'),
  };

  type Delegates = typeof delegates;
  /**
   * Makes call number `onCall` (default 1: the next call) of `model.operation`, counted from
   * now, through the root client or any transaction client, fail with `error` and/or run
   * `before` first. The call's arguments are validated before it counts; a failing call reads
   * and writes nothing. Several faults on one operation each count every call, including a
   * call another fault fails, so `onCall: 1` and `onCall: 2` fail the next two calls.
   * `injectFault('$queryRaw', 'lock', ...)` targets LOCK_SQL row locks (any table); a failed
   * lock is not recorded in `locks`.
   */
  const injectFault = <M extends keyof Delegates | '$queryRaw'>(
    model: M,
    operationName: M extends keyof Delegates ? keyof Delegates[M] & string : 'lock',
    options: FaultOptions,
  ): void => {
    const onCall = options.onCall ?? 1;
    if (!Number.isSafeInteger(onCall) || onCall < 1) {
      throw new Error(`injectFault: onCall must be a positive integer, got ${String(onCall)}`);
    }
    if (!options.error && !options.before) throw new Error('injectFault: give error and/or before');
    const target: keyof Delegates | '$queryRaw' = model;
    const modelled =
      target === '$queryRaw'
        ? operationName === 'lock'
        : typeof (delegates[target] as Record<string, unknown>)[operationName] === 'function';
    if (!modelled) throw new Error(`injectFault: ${model}.${operationName} is not modelled`);
    faults.push({ ...options, model, operation: operationName, callsLeft: onCall });
  };

  /**
   * A transaction client: the same vi.fn delegates (and raw spies), but each call runs with
   * this transaction's undo log active, so the writes it makes (synchronously, see `operation`)
   * are recorded. Unusable once the transaction ended. Has no $transaction (no nesting).
   */
  const transactionClient = (state: TransactionState) => {
    const inTransaction =
      <A extends unknown[]>(method: (...args: A) => Promise<unknown>) =>
      (...args: A): Promise<unknown> => {
        if (!state.open) {
          return Promise.reject(
            new UnsupportedByFakeError('inMemoryAuthDb: transaction client used after the end'),
          );
        }
        const outerLog = activeLog;
        const outerTx = activeTx;
        activeLog = state.log;
        activeTx = state;
        try {
          return method(...args);
        } finally {
          activeLog = outerLog;
          activeTx = outerTx;
        }
      };
    const wrap = (delegate: Record<string, (args: never) => Promise<unknown>>) =>
      Object.fromEntries(
        Object.entries(delegate).map(([name, method]) => [name, inTransaction(method)]),
      );
    return {
      ...Object.fromEntries(
        Object.entries(delegates).map(([name, delegate]) => [name, wrap(delegate)]),
      ),
      ...Object.fromEntries(
        Object.entries(rawSpies).map(([name, method]) => [name, inTransaction(method)]),
      ),
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
      const state: TransactionState = { log: [], open: true };
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

  const prisma = fakePrisma({ ...delegates, ...rawSpies, $transaction });

  /**
   * `spies` are the vi.fn delegates and raw-query functions behind `prisma` (and every
   * transaction client); the store arrays (`admins`, `refreshTokens`, `auditLogs`, `movies`,
   * `screens`, `showtimes`, `settings`) are the live tables; `locks` lists the LOCK_SQL row
   * locks taken, in order.
   */
  return {
    prisma,
    ...store,
    locks,
    spies: { ...delegates, ...rawSpies, $transaction },
    addMovie,
    addScreen,
    addShowtime,
    addSetting,
    injectFault,
  };
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
