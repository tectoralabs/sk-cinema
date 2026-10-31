import {
  emptyQuerySchema,
  movieSlugParamsSchema,
  publicMovieListQuerySchema,
} from '@sk-cinema/shared';
import { Router } from 'express';
import type { PublicMovieController } from '../controllers/movie.public.controller.js';
import { validate } from '../middleware/validate.js';

/** /api/movies. Public, read-only, no session; responses are cached in memory by the service. */
export function publicMovieRoutes(controller: PublicMovieController): Router {
  const router = Router();

  router.get('/', validate({ query: publicMovieListQuerySchema }), controller.list);
  router.get(
    '/:slug',
    validate({ params: movieSlugParamsSchema, query: emptyQuerySchema }),
    controller.getBySlug,
  );

  return router;
}
