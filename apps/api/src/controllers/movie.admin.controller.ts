import type {
  AdminMovieListQuery,
  AdminMovieListResponse,
  AdminMovieResponse,
  MovieCreateBody,
  MovieIdParams,
} from '@sk-cinema/shared';
import type { RequestHandler } from 'express';
import { clientInfo } from '../lib/clientInfo.js';
import { sessionExpired } from '../services/auth.service.js';
import type { MovieAdminService } from '../services/movie.admin.service.js';

/** Admin movie endpoints. Run after requireAuth + requireRole; input is parsed by validate(). */
export function createMovieAdminController(service: MovieAdminService) {
  const create: RequestHandler = async (req, res) => {
    // requireAuth always sets it; fail closed if a route is ever mounted without it.
    if (!req.admin) throw sessionExpired();
    const movie = await service.create(req.body as MovieCreateBody, {
      adminId: req.admin.id,
      ...clientInfo(req),
    });
    res.status(201).json({ movie } satisfies AdminMovieResponse);
  };

  const list: RequestHandler = async (req, res) => {
    // validate() replaced req.query with the parsed query (numbers, booleans, defaults), which
    // Express's ParsedQs type cannot describe, hence the cast through unknown.
    const page = await service.list(req.query as unknown as AdminMovieListQuery);
    res.json(page satisfies AdminMovieListResponse);
  };

  const getById: RequestHandler = async (req, res) => {
    const { id } = req.params as MovieIdParams;
    const movie = await service.getById(id);
    res.json({ movie } satisfies AdminMovieResponse);
  };

  return { create, list, getById };
}

export type MovieAdminController = ReturnType<typeof createMovieAdminController>;
