import { Router } from 'express';
import type { HealthController } from '../controllers/health.controller.js';

export function healthRoutes(controller: HealthController): Router {
  const router = Router();
  router.get('/health', controller.get);
  return router;
}
