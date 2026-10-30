import { emptyBodySchema, loginBodySchema } from '@sk-cinema/shared';
import { Router } from 'express';
import type { Config } from '../config/env.js';
import type { AuthController } from '../controllers/auth.controller.js';
import { loginRateLimiter, refreshRateLimiter } from '../middleware/rateLimiter.js';
import { validate } from '../middleware/validate.js';

/**
 * /api/admin/auth. Mounted inside the admin router, so CSRF protection and no-store already
 * apply. None of these routes need a session; GET /csrf is safe, the rest are CSRF-checked.
 * The limiters are created per call, so each app instance has its own counters.
 */
export function authRoutes(controller: AuthController, config: Pick<Config, 'auth'>): Router {
  const router = Router();

  router.get('/csrf', controller.csrf);
  router.post(
    '/login',
    loginRateLimiter(config.auth.loginRateLimit),
    validate({ body: loginBodySchema }),
    controller.login,
  );
  router.post(
    '/refresh',
    refreshRateLimiter(),
    validate({ body: emptyBodySchema }),
    controller.refresh,
  );
  router.post('/logout', validate({ body: emptyBodySchema }), controller.logout);

  return router;
}
