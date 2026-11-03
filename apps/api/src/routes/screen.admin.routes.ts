import {
  adminScreenListQuerySchema,
  emptyBodySchema,
  emptyQuerySchema,
  screenActiveBodySchema,
  screenCreateBodySchema,
  screenIdParamsSchema,
  screenUpdateBodySchema,
} from '@sk-cinema/shared';
import { Router } from 'express';
import type { ScreenAdminController } from '../controllers/screen.admin.controller.js';
import { validate } from '../middleware/validate.js';

/**
 * /api/admin/screens. Mounted by admin.routes.ts below the session guard and requireRole, so
 * every route here already has a signed-in SUPER_ADMIN or EDITOR (and CSRF on unsafe methods).
 * There is no hard delete: Showtime.screenId is ON DELETE RESTRICT.
 */
export function screenAdminRoutes(controller: ScreenAdminController): Router {
  const router = Router();

  router.post(
    '/',
    validate({ body: screenCreateBodySchema, query: emptyQuerySchema }),
    controller.create,
  );
  router.get('/', validate({ query: adminScreenListQuerySchema }), controller.list);
  router.get(
    '/:id',
    validate({ params: screenIdParamsSchema, query: emptyQuerySchema }),
    controller.getById,
  );
  router.patch(
    '/:id',
    validate({
      params: screenIdParamsSchema,
      body: screenUpdateBodySchema,
      query: emptyQuerySchema,
    }),
    controller.update,
  );
  router.patch(
    '/:id/active',
    validate({
      params: screenIdParamsSchema,
      body: screenActiveBodySchema,
      query: emptyQuerySchema,
    }),
    controller.setActive,
  );
  router.delete(
    '/:id',
    validate({ params: screenIdParamsSchema, body: emptyBodySchema, query: emptyQuerySchema }),
    controller.softDelete,
  );
  router.post(
    '/:id/restore',
    validate({ params: screenIdParamsSchema, body: emptyBodySchema, query: emptyQuerySchema }),
    controller.restore,
  );

  return router;
}
