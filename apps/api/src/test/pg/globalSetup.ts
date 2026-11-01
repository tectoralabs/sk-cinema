import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createPrismaClient } from '../../lib/prisma.js';
import { redactDatabaseUrl, resolveTestDatabaseUrl } from './guard.js';

/** apps/api: where prisma.config.ts lives. */
const API_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Global setup for the `pg` Vitest project: applies the Prisma migrations to the throwaway
 * test database once per run.
 *
 * Without TEST_DATABASE_URL it does nothing and the suites skip (describePg in db.ts), unless
 * REQUIRE_PG_TESTS=true, where resolveTestDatabaseUrl throws and the run fails.
 */
export default async function setup(): Promise<void> {
  try {
    // Throws (before any spawn or connection) for a missing-but-required or unsafe URL.
    const url = resolveTestDatabaseUrl(process.env);
    if (url === undefined) {
      console.info('[pg] TEST_DATABASE_URL is not set: skipping the real-Postgres tests.');
      return;
    }

    console.info(`[pg] Applying migrations to ${redactDatabaseUrl(url)}`);
    migrateDeploy(url);
    await assertMigratedTestDatabase(url);
  } catch (error) {
    throw withPlainStack(error);
  }
}

/**
 * Vitest 5 / Vite 8 crash while source-mapping the stack of an error thrown from a global
 * setup module ("code.charCodeAt is not a function"), hiding our message. Replacing the
 * not-yet-formatted stack with the message alone keeps the reason visible.
 */
function withPlainStack(error: unknown): Error {
  const plain = error instanceof Error ? error : new Error(String(error));
  plain.stack = `${plain.name}: ${plain.message}`;
  return plain;
}

/**
 * Runs `prisma migrate deploy` with DIRECT_URL (what prisma.config.ts reads) forced to the test
 * URL. prisma.config.ts loads apps/api/.env with process.loadEnvFile, which never overrides
 * variables that are already set, so the .env DIRECT_URL cannot leak into this child.
 */
function migrateDeploy(url: string): void {
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DIRECT_URL: url, DATABASE_URL: url },
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`.replaceAll(url, redactDatabaseUrl(url));
    throw new Error(`[pg] prisma migrate deploy failed (exit ${result.status}):\n${output}`);
  }
}

/** Second line of defence: confirm the database just migrated really is a *_test database. */
async function assertMigratedTestDatabase(url: string): Promise<void> {
  const prisma = createPrismaClient(url);
  try {
    const [row] = await prisma.$queryRaw<{ db: string; migrations: bigint }[]>`
      SELECT current_database() AS db,
             (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL) AS migrations`;
    if (!row?.db.endsWith('_test')) {
      throw new Error(`[pg] Connected to "${row?.db ?? '?'}", which does not end in "_test".`);
    }
    if (row.migrations === 0n) {
      throw new Error(`[pg] No migrations were recorded in "${row.db}" after migrate deploy.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}
