import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { createAuthController } from '../controllers/auth.controller.js';
import { createHealthController } from '../controllers/health.controller.js';
import type { AuthServiceDeps } from '../services/auth.service.js';
import { createHealthService } from '../services/health.service.js';
import { adminRoutes } from './admin.routes.js';
import { healthRoutes } from './health.routes.js';

/** Everything under /api. Admin routes mount at /api/admin behind CSRF protection and auth. */
export function apiRouter({ config, prisma, cache, logger }: AppDeps): Router {
  const router = Router();

  const healthService = createHealthService(prisma, cache, logger);
  router.use(healthRoutes(createHealthController(healthService)));

  const authService: AuthServiceDeps = { db: prisma, config: config.auth };
  router.use(
    '/admin',
    adminRoutes({
      config,
      db: prisma,
      authController: createAuthController({ service: authService, config }),
    }),
  );

  return router;
}
