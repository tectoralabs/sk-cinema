import type {
  AdminMovieListQuery,
  AdminMovieListResponse,
  AdminMovieResponse,
  MovieActiveBody,
  MovieCreateBody,
  MovieIdParams,
  MovieStatusBody,
  MovieUpdateBody,
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

  const update: RequestHandler = async (req, res) => {
    if (!req.admin) throw sessionExpired();
    const { id } = req.params as MovieIdParams;
    const movie = await service.update(id, req.body as MovieUpdateBody, {
      adminId: req.admin.id,
      ...clientInfo(req),
    });
    res.json({ movie } satisfies AdminMovieResponse);
  };

  const setStatus: RequestHandler = async (req, res) => {
    if (!req.admin) throw sessionExpired();
    const { id } = req.params as MovieIdParams;
    const { status } = req.body as MovieStatusBody;
    const movie = await service.setStatus(id, status, {
      adminId: req.admin.id,
      ...clientInfo(req),
    });
    res.json({ movie } satisfies AdminMovieResponse);
  };

  const setActive: RequestHandler = async (req, res) => {
    if (!req.admin) throw sessionExpired();
    const { id } = req.params as MovieIdParams;
    const { isActive } = req.body as MovieActiveBody;
    const movie = await service.setActive(id, isActive, {
      adminId: req.admin.id,
      ...clientInfo(req),
    });
    res.json({ movie } satisfies AdminMovieResponse);
  };

  const softDelete: RequestHandler = async (req, res) => {
    if (!req.admin) throw sessionExpired();
    const { id } = req.params as MovieIdParams;
    const movie = await service.softDelete(id, { adminId: req.admin.id, ...clientInfo(req) });
    res.json({ movie } satisfies AdminMovieResponse);
  };

  const restore: RequestHandler = async (req, res) => {
    if (!req.admin) throw sessionExpired();
    const { id } = req.params as MovieIdParams;
    const movie = await service.restore(id, { adminId: req.admin.id, ...clientInfo(req) });
    res.json({ movie } satisfies AdminMovieResponse);
  };

  /** SUPER_ADMIN only (route-level requireRole). 204: the movie is gone, nothing to send. */
  const hardDelete: RequestHandler = async (req, res) => {
    if (!req.admin) throw sessionExpired();
    const { id } = req.params as MovieIdParams;
    await service.hardDelete(id, { adminId: req.admin.id, ...clientInfo(req) });
    res.status(204).end();
  };

  return { create, list, getById, update, setStatus, setActive, softDelete, restore, hardDelete };
}

export type MovieAdminController = ReturnType<typeof createMovieAdminController>;
