import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      // Import workspace packages from source (see packages/shared/package.json exports).
      conditions: ['@sk-cinema/source', ...defaultClientConditions],
    },
    server: {
      port: 5174,
      strictPort: true,
      proxy: {
        '/api': env['API_PROXY_TARGET'] ?? 'http://localhost:4000',
      },
    },
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['./src/test/setup.ts'],
    },
  };
});
