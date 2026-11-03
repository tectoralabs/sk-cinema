import {
  adminShowtimeListQuerySchema,
  emptyBodySchema,
  emptyQuerySchema,
  showtimeBulkCreateBodySchema,
  showtimeBulkDeleteBodySchema,
  showtimeCreateBodySchema,
  showtimeIdParamsSchema,
  showtimeUpdateBodySchema,
} from '@sk-cinema/shared';
import { Router } from 'express';
import type { ShowtimeAdminController } from '../controllers/showtime.admin.controller.js';
import { validate } from '../middleware/validate.js';

/**
 * /api/admin/showtimes. Mounted by admin.routes.ts below the session guard and requireRole, so
 * every route here already has a signed-in SUPER_ADMIN or EDITOR (and CSRF on unsafe methods).
 *
 * Static paths (`POST /bulk`, `POST /bulk-delete`) go next to `POST /`; `/:id` routes after
 * `GET /:id`. No route here may take a path segment that a static route needs. Deletes are
 * soft only: there is no hard delete and no restore.
 */
export function showtimeAdminRoutes(controller: ShowtimeAdminController): Router {
  const router = Router();

  router.post(
    '/',
    validate({ body: showtimeCreateBodySchema, query: emptyQuerySchema }),
    controller.create,
  );
  router.post(
    '/bulk',
    validate({ body: showtimeBulkCreateBodySchema, query: emptyQuerySchema }),
    controller.bulkCreate,
  );
  router.post(
    '/bulk-delete',
    validate({ body: showtimeBulkDeleteBodySchema, query: emptyQuerySchema }),
    controller.bulkDelete,
  );
  router.get('/', validate({ query: adminShowtimeListQuerySchema }), controller.list);
  router.get(
    '/:id',
    validate({ params: showtimeIdParamsSchema, query: emptyQuerySchema }),
    controller.getById,
  );
  router.patch(
    '/:id',
    validate({
      params: showtimeIdParamsSchema,
      body: showtimeUpdateBodySchema,
      query: emptyQuerySchema,
    }),
    controller.update,
  );
  router.delete(
    '/:id',
    validate({ params: showtimeIdParamsSchema, body: emptyBodySchema, query: emptyQuerySchema }),
    controller.softDelete,
  );

  return router;
}
