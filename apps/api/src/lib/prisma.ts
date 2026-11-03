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
 *   connected within CONNECT_TIMEOUT_MS. It now allows the full connect timeout plus a 5 s
 *   margin for the BEGIN round trip, so a connection made just inside CONNECT_TIMEOUT_MS
 *   (or a pool queue wait of nearly that long) still starts its transaction.
 * - `timeout` bounds the transaction's own work and only starts once BEGIN succeeded, so a cold
 *   start never counts against it. Our transactions are a few short queries (well under 1 s on
 *   a warm database), so they are unaffected; 10 s leaves headroom for a just-woken compute
 *   with a cold cache. It does NOT bound a statement blocked on a row lock: the client gives
 *   up at the timeout, but the blocked statement keeps its pooled connection until Postgres
 *   finishes it. Lock waits are bounded in the database instead: lib/locks.ts runs
 *   `SET LOCAL lock_timeout` (5 s) before the first lock of each transaction, so a blocked
 *   `FOR UPDATE` fails (SQLSTATE 55P03, a 409 for the client) well inside this timeout.
 */
export const TRANSACTION_OPTIONS = {
  maxWait: CONNECT_TIMEOUT_MS + 5_000,
  timeout: 10_000,
} as const;

export function createPrismaClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  return new PrismaClient({ adapter, transactionOptions: TRANSACTION_OPTIONS });
}
