import { emptyQuerySchema, settingsUpdateBodySchema } from '@sk-cinema/shared';
import { Router } from 'express';
import type { SettingsAdminController } from '../controllers/settings.admin.controller.js';
import { validate } from '../middleware/validate.js';

/**
 * /api/admin/settings. Mounted by admin.routes.ts below the session guard and
 * requireRole('SUPER_ADMIN'), so every route here already has a signed-in SUPER_ADMIN (and CSRF
 * on unsafe methods).
 */
export function settingsAdminRoutes(controller: SettingsAdminController): Router {
  const router = Router();

  router.get('/', validate({ query: emptyQuerySchema }), controller.get);
  router.patch(
    '/',
    validate({ body: settingsUpdateBodySchema, query: emptyQuerySchema }),
    controller.update,
  );

  return router;
}
