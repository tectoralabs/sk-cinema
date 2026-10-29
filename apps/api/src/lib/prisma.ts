import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/** Neon scale-to-zero cold starts can take several seconds. */
const CONNECT_TIMEOUT_MS = 15_000;

export function createPrismaClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  return new PrismaClient({ adapter });
}
