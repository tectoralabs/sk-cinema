import { describe } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { createPrismaClient } from '../../lib/prisma.js';
import { assertSafeTestDatabaseUrl, resolveTestDatabaseUrl } from './guard.js';

/**
 * Helpers for real-Postgres tests (`*.pg.test.ts`, run by `pnpm --filter @sk-cinema/api test:pg`).
 *
 * Usage:
 *
 *   describePg('movie search', () => {
 *     beforeEach(resetDatabase);
 *     afterAll(disconnectTestPrisma);
 *     it('...', async () => { await testPrisma().movie.create(...) });
 *   });
 *
 * Call testPrisma() inside hooks and tests, not directly in the describe body: Vitest still runs
 * the body of a skipped suite to collect its tests, and testPrisma() throws without a URL.
 */

/** The guarded test URL, or undefined when the pg suites should skip. */
export const pgTestDatabaseUrl = resolveTestDatabaseUrl(process.env);

/** `describe` that skips when TEST_DATABASE_URL is not set. */
export const describePg = describe.skipIf(pgTestDatabaseUrl === undefined);

let client: PrismaClient | undefined;

/** The shared Prisma client for this test file, created on first use from TEST_DATABASE_URL. */
export function testPrisma(): PrismaClient {
  if (client) return client;
  if (pgTestDatabaseUrl === undefined) {
    throw new Error('testPrisma() needs TEST_DATABASE_URL; wrap the suite in describePg.');
  }
  // Re-checked here so the helper is safe even if used outside the pg project.
  assertSafeTestDatabaseUrl(pgTestDatabaseUrl, process.env);
  client = createPrismaClient(pgTestDatabaseUrl);
  return client;
}

/**
 * Empties every app table (all tables in the current schema except `_prisma_migrations`) with
 * one TRUNCATE ... RESTART IDENTITY CASCADE. Use in beforeEach.
 */
export async function resetDatabase(): Promise<void> {
  const prisma = testPrisma();
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map(({ tablename }) => `"${tablename.replaceAll('"', '""')}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/** Closes the shared client. Use in afterAll. */
export async function disconnectTestPrisma(): Promise<void> {
  const current = client;
  client = undefined;
  await current?.$disconnect();
}
