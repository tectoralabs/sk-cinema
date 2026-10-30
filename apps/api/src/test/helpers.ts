import { pino } from 'pino';
import { vi } from 'vitest';
import { createApp } from '../app.js';
import type { Config } from '../config/env.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { MemoryCache } from '../lib/cache.js';

export const silentLogger = pino({ level: 'silent' });

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'test',
    isProduction: false,
    port: 0,
    logLevel: 'silent',
    databaseUrl: 'postgresql://user:pass@localhost:5432/test',
    corsOrigins: ['http://localhost:5173', 'http://localhost:5174'],
    trustProxy: 0,
    rateLimit: { windowMs: 60_000, max: 1000 },
    ...overrides,
  };
}

/** A PrismaClient stand-in exposing only what the code under test uses. */
export function fakePrisma(parts: Partial<Record<keyof PrismaClient, unknown>> = {}): PrismaClient {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]),
    ...parts,
  } as unknown as PrismaClient;
}

export function buildTestApp(options: { config?: Partial<Config>; prisma?: PrismaClient } = {}) {
  const prisma = options.prisma ?? fakePrisma();
  const cache = new MemoryCache();
  const app = createApp({
    config: testConfig(options.config),
    logger: silentLogger,
    prisma,
    cache,
  });
  return { app, prisma, cache };
}
