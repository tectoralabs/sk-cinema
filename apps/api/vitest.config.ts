import { defineConfig } from 'vitest/config';

export default defineConfig({
  ssr: {
    resolve: {
      // Import workspace packages from source (see packages/shared/package.json exports).
      conditions: ['@sk-cinema/source', 'node', 'import', 'module', 'default'],
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
