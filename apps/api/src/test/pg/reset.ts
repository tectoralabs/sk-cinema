import { UnsafeTestDatabaseError } from './guard.js';

/** Side-effect free (no env reads), so a unit test can import it. */

/** What resetDatabase needs from a client (a Prisma client, or a fake in the unit test). */
export interface ResetClient {
  $queryRaw: <T = unknown>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
  $executeRawUnsafe: (query: string) => Promise<number>;
}

/**
 * Refuses unless the server itself says it is the database the guard accepted: its name, from
 * `SELECT current_database()`, ends in `_test` and equals `acceptedName`. The URL is only text
 * the guard judged; this is what the connection actually opened.
 */
export async function assertServerDatabaseIsTest(
  prisma: Pick<ResetClient, '$queryRaw'>,
  acceptedName: string,
): Promise<void> {
  const rows = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  const actual = rows[0]?.name;
  if (typeof actual !== 'string' || !/^[A-Za-z0-9_]+_test$/.test(actual)) {
    throw new UnsafeTestDatabaseError('the connected database name does not end in "_test"');
  }
  if (actual !== acceptedName) {
    throw new UnsafeTestDatabaseError(
      `the connected database "${actual}" is not the one the URL named ("${acceptedName}")`,
    );
  }
}

/**
 * Empties every app table (all tables in the current schema except `_prisma_migrations`) with
 * one TRUNCATE ... RESTART IDENTITY CASCADE, after the server confirmed which database it is
 * (assertServerDatabaseIsTest). Takes the client and accepted name for the unit test.
 */
export async function resetDatabaseOn(prisma: ResetClient, acceptedName: string): Promise<void> {
  await assertServerDatabaseIsTest(prisma, acceptedName);
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map(({ tablename }) => `"${tablename.replaceAll('"', '""')}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
