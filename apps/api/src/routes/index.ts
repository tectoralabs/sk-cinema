import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { createHealthController } from '../controllers/health.controller.js';
import { createHealthService } from '../services/health.service.js';
import { healthRoutes } from './health.routes.js';

/** Everything under /api. Admin routes will mount at /api/admin behind auth. */
export function apiRouter({ prisma, cache, logger }: AppDeps): Router {
  const router = Router();

  const healthService = createHealthService(prisma, cache, logger);
  router.use(healthRoutes(createHealthController(healthService)));

  return router;
}
