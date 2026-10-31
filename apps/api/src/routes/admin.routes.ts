import { Router, type RequestHandler } from 'express';
import type { Config } from '../config/env.js';
import type { AuthController } from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { csrfProtection } from '../middleware/csrf.js';
import type { AuthDb } from '../services/auth.service.js';
import { authRoutes } from './auth.routes.js';

export interface AdminRoutesDeps {
  config: Pick<Config, 'auth' | 'adminOrigins'>;
  /** Only handed to requireAuth, which loads the admin through the auth service. */
  db: Pick<AuthDb, 'admin'>;
  authController: AuthController;
}

/** Admin responses are per-user and may be sensitive: never cache them anywhere. */
const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/**
 * Everything under /api/admin. Order matters: no-store first (so errors get it too), then
 * CSRF for every unsafe method (including unknown routes), then the routes. Everything
 * except /auth/* must sit behind `authenticated`.
 */
export function adminRoutes({ config, db, authController }: AdminRoutesDeps): Router {
  const router = Router();
  const authenticated = requireAuth({ db, config });

  router.use(noStore);
  router.use(csrfProtection(config));

  router.use('/auth', authRoutes(authController, config));
  router.get('/me', authenticated, authController.me);

  return router;
}
