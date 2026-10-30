import { createApp } from './app.js';
import { EnvValidationError, loadConfig, type Config } from './config/env.js';
import { MemoryCache } from './lib/cache.js';
import { createLogger } from './lib/logger.js';
import { warmUpDummyPassword } from './lib/password.js';
import { createPrismaClient } from './lib/prisma.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function readConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (error) {
    // The logger is not configured yet; the message names variables, never their values.
    console.error(error instanceof EnvValidationError ? error.message : 'Failed to load config');
    process.exit(1);
  }
}

const config = readConfigOrExit();
const logger = createLogger(config);
const prisma = createPrismaClient(config.databaseUrl);
const cache = new MemoryCache();

// Awaited before listen, so even the first unknown-email login costs the same as a real one.
// A failure is not fatal: the dummy hash is then built lazily on first use.
try {
  await warmUpDummyPassword();
} catch (err) {
  logger.error({ err }, 'Dummy password hash warm-up failed; it will be built on first use');
}

const server = createApp({ config, logger, prisma, cache }).listen(config.port, () => {
  logger.info({ port: config.port, env: config.nodeEnv }, 'API listening');
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down');
  setTimeout(() => {
    logger.error('Shutdown timed out; forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});
