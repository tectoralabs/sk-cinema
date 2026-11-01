import { defineConfig } from 'vitest/config';

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
    include: ['src/**/*.test.ts'],
    // Route tests drive the real app over loopback HTTP (Supertest, ~1,700 exchanges per run),
    // some with ~180 sequential requests (the admin route walks). Measured on a Windows dev
    // machine whose antivirus inspects loopback HTTP: the slowest test takes 1.6 s idle and
    // 3.5-4.5 s while two full `pnpm test` runs overlap, so the 5 s default left no headroom.
    // 15 s still fails a real hang. Longer antivirus stalls (10 s+ per request) are an
    // environment problem, fixed by excluding loopback traffic from HTTP scanning, not here.
    testTimeout: 15_000,
  },
});
