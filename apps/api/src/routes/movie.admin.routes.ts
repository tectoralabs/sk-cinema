import {
  adminMovieListQuerySchema,
  emptyQuerySchema,
  movieActiveBodySchema,
  movieCreateBodySchema,
  movieIdParamsSchema,
  movieStatusBodySchema,
  movieUpdateBodySchema,
} from '@sk-cinema/shared';
import { Router } from 'express';
import type { MovieAdminController } from '../controllers/movie.admin.controller.js';
import { validate } from '../middleware/validate.js';

/**
 * /api/admin/movies. Mounted by admin.routes.ts below the session guard and requireRole, so
 * every route here already has a signed-in SUPER_ADMIN or EDITOR (and CSRF on unsafe methods).
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

  return router;
}
