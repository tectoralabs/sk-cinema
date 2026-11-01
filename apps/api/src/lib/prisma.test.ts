import { afterEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { CONNECT_TIMEOUT_MS, createPrismaClient, TRANSACTION_OPTIONS } from './prisma.js';

// Nothing here touches a database: the client and the pg pool connect lazily, on the first query.
const UNUSED_URL = 'postgresql://user:pass@127.0.0.1:1/unused';

/**
 * The transaction defaults the Prisma runtime resolved from the constructor options. Prisma
 * exposes no public getter, so this reads its internal engine config (Prisma 7.10.1); if an
 * upgrade moves it, this test fails loudly rather than passing silently.
 */
function resolvedTransactionOptions(client: PrismaClient): unknown {
  const internal = client as unknown as { _engineConfig?: { transactionOptions?: unknown } };
  return internal._engineConfig?.transactionOptions;
}

describe('createPrismaClient', () => {
  let client: PrismaClient | undefined;

  afterEach(async () => {
    await client?.$disconnect();
    client = undefined;
  });

  it('waits longer than the pool connect timeout to start a transaction (Neon cold start)', () => {
    expect(TRANSACTION_OPTIONS).toEqual({ maxWait: 20_000, timeout: 10_000 });
    expect(CONNECT_TIMEOUT_MS).toBe(15_000);
    // maxWait covers the pool connect and the BEGIN round trip, so it must exceed the connect timeout.
    expect(TRANSACTION_OPTIONS.maxWait).toBe(CONNECT_TIMEOUT_MS + 5_000);
    // Longer than Prisma's defaults (maxWait 2 s, timeout 5 s), never shorter.
    expect(TRANSACTION_OPTIONS.maxWait).toBeGreaterThan(2_000);
    expect(TRANSACTION_OPTIONS.timeout).toBeGreaterThan(5_000);
  });

  it('passes the transaction defaults to the Prisma runtime', () => {
    client = createPrismaClient(UNUSED_URL);

    expect(resolvedTransactionOptions(client)).toMatchObject({
      maxWait: CONNECT_TIMEOUT_MS + 5_000,
      timeout: 10_000,
    });
  });
});
