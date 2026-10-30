import { ERROR_CODES, type ApiError } from '@sk-cinema/shared';
import { rateLimit } from 'express-rate-limit';
import type { Config } from '../config/env.js';

interface LimitOptions {
  windowMs: number;
  max: number;
}

/**
 * A per-IP (req.ip, so `trust proxy` must be right) in-memory limiter answering 429
 * `{ error: { code: 'RATE_LIMITED', message } }`. Every call creates a new store, so each
 * app instance (and each test app) counts on its own. Every request counts, including
 * successful ones.
 */
function perIpLimiter({ windowMs, max }: LimitOptions) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res, _next, options) => {
      res.status(options.statusCode).json({
        error: { code: ERROR_CODES.RATE_LIMITED, message: 'Too many requests, try again later' },
      } satisfies ApiError);
    },
  });
}

/**
 * Per-IP limit for every route. Login and refresh add their own stricter limiters on top
 * (loginRateLimiter, refreshRateLimiter); a request must pass both.
 */
export function globalRateLimiter(options: Config['rateLimit']) {
  return perIpLimiter(options);
}

/**
 * Per-IP limit on POST /api/admin/auth/login (config.auth.loginRateLimit, default 10 per
 * 15 minutes). Every attempt counts, successful or not, so it also slows password guessing
 * spread across many accounts; per-account lockout is handled by the auth service.
 */
export function loginRateLimiter(options: Config['auth']['loginRateLimit']) {
  return perIpLimiter(options);
}

/**
 * Refresh limit: 60 per 15 minutes per IP. Higher than login because the admin app refreshes
 * silently, several tabs may each refresh, and an office may share one public IP. Refresh
 * tokens are 256-bit random values, so this limit is about load, not guessing.
 */
export const REFRESH_RATE_LIMIT = { windowMs: 15 * 60_000, max: 60 } as const;

export function refreshRateLimiter() {
  return perIpLimiter(REFRESH_RATE_LIMIT);
}
