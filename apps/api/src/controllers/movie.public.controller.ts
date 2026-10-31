import type {
  MovieSlugParams,
  PublicMovieListQuery,
  PublicMovieListResponse,
  PublicMovieResponse,
} from '@sk-cinema/shared';
import type { RequestHandler } from 'express';
import type { PublicMovieService } from '../services/movie.public.service.js';

/** Public movie endpoints. Input is already parsed by validate() in the routes. */
export function createPublicMovieController(service: PublicMovieService) {
  const list: RequestHandler = async (req, res) => {
    const { status } = req.query as PublicMovieListQuery;
    const movies = await service.list(status);
    res.json({ movies } satisfies PublicMovieListResponse);
  };

  const getBySlug: RequestHandler = async (req, res) => {
    const { slug } = req.params as MovieSlugParams;
    const movie = await service.getBySlug(slug);
    res.json({ movie } satisfies PublicMovieResponse);
  };

  return { list, getBySlug };
}

export type PublicMovieController = ReturnType<typeof createPublicMovieController>;
