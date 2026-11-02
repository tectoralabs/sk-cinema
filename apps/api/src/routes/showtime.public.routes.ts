import {
  emptyQuerySchema,
  publicMovieIdParamsSchema,
  publicShowtimeListQuerySchema,
} from '@sk-cinema/shared';
import { Router } from 'express';
import type { PublicShowtimeController } from '../controllers/showtime.public.controller.js';
import { noStore } from '../middleware/noStore.js';
import { validate } from '../middleware/validate.js';

/**
 * /api/movies/:id/dates and /api/movies/:id/showtimes. Public, read-only, no session. Two path
 * segments, so they never clash with /api/movies/:slug.
 *
 * The service caches in memory and filters out started shows on every request. no-store keeps
 * that true: a response kept by a browser or CDN could offer a show after it has started. The
 * memory cache is what spares the database, so nothing is lost by not caching downstream.
 */
export function publicShowtimeRoutes(controller: PublicShowtimeController): Router {
  const router = Router();

  router.get(
    '/:id/dates',
    noStore,
    validate({ params: publicMovieIdParamsSchema, query: emptyQuerySchema }),
    controller.listDates,
  );
  router.get(
    '/:id/showtimes',
    noStore,
    validate({ params: publicMovieIdParamsSchema, query: publicShowtimeListQuerySchema }),
    controller.listForDate,
  );

  return router;
}
