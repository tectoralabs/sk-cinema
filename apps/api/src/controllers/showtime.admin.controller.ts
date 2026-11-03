import type {
  AdminShowtimeListQuery,
  AdminShowtimeListResponse,
  AdminShowtimeResponse,
  ShowtimeBulkCreateBody,
  ShowtimeBulkCreateResponse,
  ShowtimeBulkDeleteBody,
  ShowtimeBulkDeleteResponse,
  ShowtimeCreateBody,
  ShowtimeIdParams,
  ShowtimeUpdateBody,
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

  const bulkCreate: RequestHandler = async (req, res) => {
    if (!req.admin) throw sessionExpired();
    const result = await service.bulkCreate(req.body as ShowtimeBulkCreateBody, {
      adminId: req.admin.id,
      ...clientInfo(req),
    });
    res.status(201).json(result satisfies ShowtimeBulkCreateResponse);
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

  const update: RequestHandler = async (req, res) => {
    if (!req.admin) throw sessionExpired();
    const { id } = req.params as ShowtimeIdParams;
    const showtime = await service.update(id, req.body as ShowtimeUpdateBody, {
      adminId: req.admin.id,
      ...clientInfo(req),
    });
    res.json({ showtime } satisfies AdminShowtimeResponse);
  };

  const softDelete: RequestHandler = async (req, res) => {
    if (!req.admin) throw sessionExpired();
    const { id } = req.params as ShowtimeIdParams;
    const showtime = await service.softDelete(id, { adminId: req.admin.id, ...clientInfo(req) });
    res.json({ showtime } satisfies AdminShowtimeResponse);
  };

  const bulkDelete: RequestHandler = async (req, res) => {
    if (!req.admin) throw sessionExpired();
    const result = await service.bulkDelete(req.body as ShowtimeBulkDeleteBody, {
      adminId: req.admin.id,
      ...clientInfo(req),
    });
    res.json(result satisfies ShowtimeBulkDeleteResponse);
  };

  return { create, bulkCreate, list, getById, update, softDelete, bulkDelete };
}

export type ShowtimeAdminController = ReturnType<typeof createShowtimeAdminController>;
