import type { Logger } from 'pino';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { MemoryCache } from '../lib/cache.js';

export interface HealthReport {
  status: 'ok' | 'degraded';
  checks: { database: 'up' | 'down' };
  timestamp: string;
}

/**
 * The DB result is cached briefly so frequent health checks (uptime monitors, curious
 * visitors) cannot hammer the database.
 */
const DB_CHECK_TTL_MS = 30_000;
const DB_CHECK_CACHE_KEY = 'health:db';

export function createHealthService(
  db: Pick<PrismaClient, '$queryRaw'>,
  cache: MemoryCache,
  logger: Logger,
) {
  async function pingDatabase(): Promise<boolean> {
    try {
      await db.$queryRaw`SELECT 1`;
      return true;
    } catch (err) {
      logger.warn({ err }, 'Database health check failed');
      return false;
    }
  }

  return {
    async check(): Promise<HealthReport> {
      const dbUp = await cache.getOrSet(DB_CHECK_CACHE_KEY, DB_CHECK_TTL_MS, pingDatabase);
      return {
        status: dbUp ? 'ok' : 'degraded',
        checks: { database: dbUp ? 'up' : 'down' },
        timestamp: new Date().toISOString(),
      };
    },
  };
}

export type HealthService = ReturnType<typeof createHealthService>;
