import { configDefaults, defineConfig } from 'vitest/config';

/** Real-Postgres tests: opt-in, need TEST_DATABASE_URL (see src/test/pg/guard.ts). */
const PG_TESTS = 'src/**/*.pg.test.ts';

export default defineConfig({
  ssr: {
    resolve: {
      // Import workspace packages from source (see packages/shared/package.json exports).
      // The rest is Vite's default server list; Vite adds "import"/"require" per import kind,
      // so listing "import" here would hand ESM builds to CommonJS require() calls.
      conditions: ['@sk-cinema/source', 'module', 'node', 'development|production'],
    },
  },
  test: {
    environment: 'node',
    // Route tests drive the real app over loopback HTTP (Supertest, ~2,000 exchanges per run),
    // some with ~180 requests (the admin route walks, sent in batches of 10 to one shared
    // server since Phase 4 T10). Measured on a Windows dev
    // machine whose antivirus inspects loopback HTTP: the slowest test takes 1.6 s idle and
    // 3.5-4.5 s while two full `pnpm test` runs overlap, so the 5 s default left no headroom.
    // 15 s still fails a real hang. Longer antivirus stalls (10 s+ per request) are an
    // environment problem, fixed by excluding loopback traffic from HTTP scanning, not here.
    testTimeout: 15_000,
    // Both projects inherit the settings above (and the ssr config) via `extends: true`.
    projects: [
      {
        extends: true,
        test: {
          // `pnpm test`: the in-memory suite, no database needed.
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: [...configDefaults.exclude, PG_TESTS],
        },
      },
      {
        extends: true,
        test: {
          // `pnpm test:pg`: against a throwaway local Postgres 18 (TEST_DATABASE_URL). The files
          // share one database and TRUNCATE it between tests, so they must not run in parallel.
          name: 'pg',
          include: [PG_TESTS],
          fileParallelism: false,
          globalSetup: ['src/test/pg/globalSetup.ts'],
        },
      },
    ],
  },
});
