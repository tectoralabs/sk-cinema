import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/** Neon scale-to-zero cold starts can take several seconds. */
export const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Defaults for every `$transaction` (Prisma's own are maxWait 2 s, timeout 5 s).
 *
 * - `maxWait` bounds starting the transaction: getting a pool connection (which may have to
 *   open one while Neon wakes from scale-to-zero) and sending BEGIN. Prisma's 2 s default is
 *   shorter than a cold start, so it would fail with a 500 even though the pool would have
 *   connected within CONNECT_TIMEOUT_MS. It now waits as long as the pool does.
 * - `timeout` bounds the transaction's own work and only starts once BEGIN succeeded, so a cold
 *   start never counts against it. Our transactions are a few short queries (well under 1 s on
 *   a warm database), so they are unaffected; 10 s leaves headroom for a just-woken compute
 *   with a cold cache while still releasing the connection and row locks of a stuck
 *   transaction quickly.
 */
export const TRANSACTION_OPTIONS = { maxWait: CONNECT_TIMEOUT_MS, timeout: 10_000 } as const;

export function createPrismaClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  return new PrismaClient({ adapter, transactionOptions: TRANSACTION_OPTIONS });
}
