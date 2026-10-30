import { ERROR_CODES, type ApiError } from '@sk-cinema/shared';
import { rateLimit } from 'express-rate-limit';
import type { Config } from '../config/env.js';

/** Per-IP limit for every route. Login gets its own stricter limiter in Phase 3. */
export function globalRateLimiter({ windowMs, max }: Config['rateLimit']) {
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
