import type {
  AdminShowtimeListQuery,
  AdminShowtimeListResponse,
  AdminShowtimeResponse,
  ShowtimeCreateBody,
  ShowtimeIdParams,
} from '@sk-cinema/shared';
import type { RequestHandler } from 'express';
import { clientInfo } from '../lib/clientInfo.js';
import { sessionExpired } from '../services/auth.service.js';
import type { ShowtimeAdminService } from '../services/showtime.admin.service.js';

/** Admin showtime endpoints. Run after requireAuth + requireRole; input is parsed by validate(). */
export function createShowtimeAdminController(service: ShowtimeAdminService) {
  const create: RequestHandler = async (req, res) => {
    // requireAuth always sets it; fail closed if a route is ever mounted without it.
    if (!req.admin) throw sessionExpired();
    const showtime = await service.create(req.body as ShowtimeCreateBody, {
      adminId: req.admin.id,
      ...clientInfo(req),
    });
    res.status(201).json({ showtime } satisfies AdminShowtimeResponse);
  };

  const list: RequestHandler = async (req, res) => {
    // validate() replaced req.query with the parsed query, which ParsedQs cannot describe.
    const page = await service.list(req.query as unknown as AdminShowtimeListQuery);
    res.json(page satisfies AdminShowtimeListResponse);
  };

  const getById: RequestHandler = async (req, res) => {
    const { id } = req.params as ShowtimeIdParams;
    const showtime = await service.getById(id);
    res.json({ showtime } satisfies AdminShowtimeResponse);
  };

  return { create, list, getById };
}

export type ShowtimeAdminController = ReturnType<typeof createShowtimeAdminController>;
