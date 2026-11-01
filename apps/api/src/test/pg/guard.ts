/**
 * Safety guard for the real-Postgres (`pg`) Vitest project.
 *
 * The pg suites TRUNCATE every table, so they must only ever reach a throwaway local
 * database. Every check here runs before any connection is opened (and before the
 * `prisma migrate deploy` child process is spawned). Pure functions, no I/O: unit-tested in
 * guard.test.ts.
 */

/** Env var holding the throwaway database URL, e.g. postgresql://sk_test:sk_test@localhost:55432/sk_cinema_test */
export const TEST_DATABASE_URL_ENV = 'TEST_DATABASE_URL';
/** Set to `true` in CI: a missing TEST_DATABASE_URL then fails instead of skipping the pg suites. */
export const REQUIRE_PG_TESTS_ENV = 'REQUIRE_PG_TESTS';

/** Hosts a test database may live on: this machine, or the `postgres` CI service container. */
export const ALLOWED_TEST_DB_HOSTS: readonly string[] = [
  'localhost',
  '127.0.0.1',
  '::1',
  'postgres',
];

/**
 * Query parameters a test URL may carry. Anything else is refused because libpq-style
 * parameters such as `host`, `hostaddr` or `dbname` can silently retarget the connection
 * away from the host and database checked here.
 */
export const ALLOWED_TEST_DB_PARAMS: readonly string[] = [
  'schema',
  'sslmode',
  'connect_timeout',
  'application_name',
  'connection_limit',
  'pool_timeout',
];

const DEFAULT_PG_PORT = '5432';

type Env = Readonly<Record<string, string | undefined>>;

export class UnsafeTestDatabaseError extends Error {
  constructor(reason: string) {
    super(
      `Refusing to run the pg tests: ${reason}. ${TEST_DATABASE_URL_ENV} must point at a ` +
        `throwaway local database whose name ends in "_test" ` +
        `(e.g. postgresql://sk_test:sk_test@localhost:55432/sk_cinema_test).`,
    );
    this.name = 'UnsafeTestDatabaseError';
  }
}

interface DbTarget {
  host: string;
  port: string;
  database: string;
}

function parsePostgresUrl(url: string): URL | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'postgresql:' || parsed.protocol === 'postgres:'
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function targetOf(parsed: URL): DbTarget {
  let database: string;
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    database = parsed.pathname.replace(/^\//, '');
  }
  return {
    // URL keeps IPv6 hosts bracketed ("[::1]").
    host: parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1'),
    port: parsed.port || DEFAULT_PG_PORT,
    database,
  };
}

function sameTarget(a: DbTarget, b: DbTarget): boolean {
  return a.host === b.host && a.port === b.port && a.database === b.database;
}

/** The URL with any password masked, safe for error messages and logs. */
export function redactDatabaseUrl(url: string): string {
  const parsed = parsePostgresUrl(url);
  if (!parsed) return '<unparseable URL>';
  if (parsed.password) parsed.password = '***';
  return parsed.toString();
}

/**
 * Throws UnsafeTestDatabaseError unless `url` is a local database whose name ends in `_test`
 * and which is not the app's own DATABASE_URL / DIRECT_URL. Returns the database name.
 */
export function assertSafeTestDatabaseUrl(url: string, env: Env = {}): string {
  if (url.toLowerCase().includes('neon.tech')) {
    throw new UnsafeTestDatabaseError('the URL contains "neon.tech" (a hosted Neon database)');
  }

  const parsed = parsePostgresUrl(url);
  if (!parsed) {
    throw new UnsafeTestDatabaseError(
      'the URL is not a valid postgresql:// or postgres:// connection URL',
    );
  }

  const target = targetOf(parsed);
  if (!ALLOWED_TEST_DB_HOSTS.includes(target.host)) {
    throw new UnsafeTestDatabaseError(
      `host "${target.host}" is not one of ${ALLOWED_TEST_DB_HOSTS.join(', ')}`,
    );
  }

  for (const key of parsed.searchParams.keys()) {
    if (!ALLOWED_TEST_DB_PARAMS.includes(key)) {
      throw new UnsafeTestDatabaseError(
        `query parameter "${key}" is not allowed (allowed: ${ALLOWED_TEST_DB_PARAMS.join(', ')})`,
      );
    }
  }

  if (!target.database.endsWith('_test') || target.database === '_test') {
    throw new UnsafeTestDatabaseError(`database name "${target.database}" does not end in "_test"`);
  }

  for (const name of ['DATABASE_URL', 'DIRECT_URL'] as const) {
    const appUrl = env[name]?.trim();
    if (!appUrl) continue;
    const appParsed = parsePostgresUrl(appUrl);
    if (appUrl === url.trim() || (appParsed && sameTarget(targetOf(appParsed), target))) {
      throw new UnsafeTestDatabaseError(`it points at the same database as ${name}`);
    }
  }

  return target.database;
}

function isPgTestRequired(env: Env): boolean {
  const raw = env[REQUIRE_PG_TESTS_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0') return false;
  if (raw === 'true' || raw === '1') return true;
  throw new Error(
    `${REQUIRE_PG_TESTS_ENV} must be "true" or "false" (got "${env[REQUIRE_PG_TESTS_ENV] ?? ''}")`,
  );
}

/**
 * Decides whether the pg suites run.
 *
 * - TEST_DATABASE_URL set: returns it after assertSafeTestDatabaseUrl (throws if unsafe).
 * - Unset (or blank): returns undefined so the suites skip, unless REQUIRE_PG_TESTS=true, in
 *   which case it throws so CI can never skip them silently.
 */
export function resolveTestDatabaseUrl(env: Env): string | undefined {
  const url = env[TEST_DATABASE_URL_ENV]?.trim();
  if (!url) {
    if (isPgTestRequired(env)) {
      throw new Error(
        `${REQUIRE_PG_TESTS_ENV}=true but ${TEST_DATABASE_URL_ENV} is not set. ` +
          `Point it at the throwaway Postgres 18 test database ` +
          `(e.g. postgresql://sk_test:sk_test@localhost:55432/sk_cinema_test).`,
      );
    }
    return undefined;
  }
  assertSafeTestDatabaseUrl(url, env);
  return url;
}
