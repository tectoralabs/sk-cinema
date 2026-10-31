import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import type { Logger } from 'pino';
import type { Config } from './config/env.js';
import type { PrismaClient } from './generated/prisma/client.js';
import { API_PREFIX } from './lib/apiPaths.js';
import type { MemoryCache } from './lib/cache.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { globalRateLimiter } from './middleware/rateLimiter.js';
import { requestLogger } from './middleware/requestLogger.js';
import { corsPolicy, securityHeaders } from './middleware/security.js';
import { apiRouter } from './routes/index.js';

export const JSON_BODY_LIMIT = '100kb';

export interface AppDeps {
  config: Config;
  logger: Logger;
  prisma: PrismaClient;
  cache: MemoryCache;
}

export function createApp(deps: AppDeps): Express {
  const { config, logger } = deps;
  const app = express();

  app.disable('x-powered-by');
  // Needed for the correct client IP (rate limiting, logs) behind Cloudflare / a reverse proxy.
  app.set('trust proxy', config.trustProxy);

  app.use(requestLogger(logger));
  app.use(securityHeaders());
  // Before the rate limiter, so 429s are readable by allowed origins.
  app.use(corsPolicy(config));
  app.use(globalRateLimiter(config.rateLimit));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(cookieParser());

  app.use(API_PREFIX, apiRouter(deps));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
