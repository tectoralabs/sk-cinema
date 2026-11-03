import { readdirSync } from 'node:fs';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { describePg, disconnectTestPrisma, resetDatabase, testPrisma } from './db.js';

/** Migration folders in apps/api/prisma/migrations (each one must be applied). */
const migrationNames = readdirSync(new URL('../../../prisma/migrations/', import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describePg('real Postgres test database', () => {
  beforeEach(resetDatabase);
  afterAll(disconnectTestPrisma);

  it('answers a query', async () => {
    const rows = await testPrisma().$queryRaw<{ one: number }[]>`SELECT 1::int AS one`;
    expect(rows).toEqual([{ one: 1 }]);
  });

  it('is a database whose name ends in _test', async () => {
    const [row] = await testPrisma().$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
    expect(row?.db).toMatch(/_test$/);
  });

  it('runs Postgres 18, like Neon', async () => {
    const [row] = await testPrisma().$queryRaw<{ server_version: string }[]>`SHOW server_version`;
    expect(row?.server_version).toMatch(/^18(\.|$)/);
  });

  it('uses the C.UTF-8 collation, like Neon', async () => {
    const [row] = await testPrisma().$queryRaw<{ datcollate: string }[]>`
      SELECT datcollate FROM pg_database WHERE datname = current_database()`;
    expect(row?.datcollate).toBe('C.UTF-8');
  });

  it('has every Prisma migration applied', async () => {
    const rows = await testPrisma().$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY migration_name`;
    expect(migrationNames.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.migration_name)).toEqual(migrationNames);
  });

  it('has the app tables', async () => {
    const [row] = await testPrisma().$queryRaw<{ movie: string | null; showtime: string | null }[]>`
      SELECT to_regclass('"Movie"')::text AS movie, to_regclass('"Showtime"')::text AS showtime`;
    expect(row).toEqual({ movie: '"Movie"', showtime: '"Showtime"' });
  });

  it('resetDatabase empties the app tables but keeps the migration history', async () => {
    const prisma = testPrisma();
    await prisma.screen.create({ data: { name: 'Screen 1' } });
    expect(await prisma.screen.count()).toBe(1);

    await resetDatabase();

    expect(await prisma.screen.count()).toBe(0);
    const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM "_prisma_migrations"`;
    expect(row?.count).toBe(BigInt(migrationNames.length));
  });
});
