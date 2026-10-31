import type { AdminMovieResponse, MovieCreateBody, MovieIdParams } from '@sk-cinema/shared';
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

  const getById: RequestHandler = async (req, res) => {
    const { id } = req.params as MovieIdParams;
    const movie = await service.getById(id);
    res.json({ movie } satisfies AdminMovieResponse);
  };

  return { create, getById };
}

export type MovieAdminController = ReturnType<typeof createMovieAdminController>;
