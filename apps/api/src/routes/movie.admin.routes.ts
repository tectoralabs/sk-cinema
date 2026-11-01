import {
  adminMovieListQuerySchema,
  emptyBodySchema,
  emptyQuerySchema,
  movieActiveBodySchema,
  movieCreateBodySchema,
  movieIdParamsSchema,
  movieStatusBodySchema,
  movieUpdateBodySchema,
} from '@sk-cinema/shared';
import { Router } from 'express';
import type { MovieAdminController } from '../controllers/movie.admin.controller.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

/**
 * /api/admin/movies. Mounted by admin.routes.ts below the session guard and requireRole, so
 * every route here already has a signed-in SUPER_ADMIN or EDITOR (and CSRF on unsafe methods).
 * A route open to fewer roles adds its own requireRole before validation.
 */
export function movieAdminRoutes(controller: MovieAdminController): Router {
  const router = Router();

  router.post(
    '/',
    validate({ body: movieCreateBodySchema, query: emptyQuerySchema }),
    controller.create,
  );
  router.get('/', validate({ query: adminMovieListQuerySchema }), controller.list);
  router.get(
    '/:id',
    validate({ params: movieIdParamsSchema, query: emptyQuerySchema }),
    controller.getById,
  );
  router.patch(
    '/:id',
    validate({ params: movieIdParamsSchema, body: movieUpdateBodySchema, query: emptyQuerySchema }),
    controller.update,
  );
  router.patch(
    '/:id/status',
    validate({ params: movieIdParamsSchema, body: movieStatusBodySchema, query: emptyQuerySchema }),
    controller.setStatus,
  );
  router.patch(
    '/:id/active',
    validate({ params: movieIdParamsSchema, body: movieActiveBodySchema, query: emptyQuerySchema }),
    controller.setActive,
  );
  router.delete(
    '/:id',
    validate({ params: movieIdParamsSchema, body: emptyBodySchema, query: emptyQuerySchema }),
    controller.softDelete,
  );
  router.post(
    '/:id/restore',
    validate({ params: movieIdParamsSchema, body: emptyBodySchema, query: emptyQuerySchema }),
    controller.restore,
  );
  // Hard delete is SUPER_ADMIN only, on top of the mount's SUPER_ADMIN/EDITOR check. The role
  // is checked first, so an EDITOR gets 403 whatever the input, before any database access.
  router.delete(
    '/:id/permanent',
    requireRole('SUPER_ADMIN'),
    validate({ params: movieIdParamsSchema, body: emptyBodySchema, query: emptyQuerySchema }),
    controller.hardDelete,
  );

  return router;
}
