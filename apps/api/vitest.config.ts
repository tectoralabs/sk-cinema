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
  },
});
