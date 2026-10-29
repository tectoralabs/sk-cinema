import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer loads .env itself. Variables already set in the environment win.
if (existsSync('.env')) process.loadEnvFile('.env');

const directUrl = process.env['DIRECT_URL'];

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  // Migrations use the direct (non-pooled) connection. Read without env(), which throws when
  // unset, so that `prisma generate` still works where no database is configured (e.g. CI).
  datasource: directUrl ? { url: directUrl } : {},
});
