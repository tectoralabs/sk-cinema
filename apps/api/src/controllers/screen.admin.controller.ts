import type {
  AdminScreenListQuery,
  AdminScreenListResponse,
  AdminScreenResponse,
  ScreenActiveBody,
  ScreenCreateBody,
  ScreenIdParams,
  ScreenUpdateBody,
} from '@sk-cinema/shared';
import type { RequestHandler } from 'express';
import { clientInfo } from '../lib/clientInfo.js';
import { sessionExpired } from '../services/auth.service.js';
import type { ScreenAdminService } from '../services/screen.admin.service.js';

/** Admin screen endpoints. Run after requireAuth + requireRole; input is parsed by validate(). */
export function createScreenAdminController(service: ScreenAdminService) {
  const create: RequestHandler = async (req, res) => {
    // requireAuth always sets it; fail closed if a route is ever mounted without it.
    if (!req.admin) throw sessionExpired();
    const screen = await service.create(req.body as ScreenCreateBody, {
      adminId: req.admin.id,
      ...clientInfo(req),
    });
    res.status(201).json({ screen } satisfies AdminScreenResponse);
  };

  const list: RequestHandler = async (req, res) => {
    // validate() replaced req.query with the parsed query, which ParsedQs cannot describe.
    const page = await service.list(req.query as unknown as AdminScreenListQuery);
    res.json(page satisfies AdminScreenListResponse);
  };

  const getById: RequestHandler = async (req, res) => {
    const { id } = req.params as ScreenIdParams;
    const screen = await service.getById(id);
    res.json({ screen } satisfies AdminScreenResponse);
  };

  const update: RequestHandler = async (req, res) => {
    if (!req.admin) throw sessionExpired();
    const { id } = req.params as ScreenIdParams;
    const screen = await service.update(id, req.body as ScreenUpdateBody, {
      adminId: req.admin.id,
      ...clientInfo(req),
    });
    res.json({ screen } satisfies AdminScreenResponse);
  };

  const setActive: RequestHandler = async (req, res) => {
    if (!req.admin) throw sessionExpired();
    const { id } = req.params as ScreenIdParams;
    const { isActive } = req.body as ScreenActiveBody;
    const screen = await service.setActive(id, isActive, {
      adminId: req.admin.id,
      ...clientInfo(req),
    });
    res.json({ screen } satisfies AdminScreenResponse);
  };

  const softDelete: RequestHandler = async (req, res) => {
    if (!req.admin) throw sessionExpired();
    const { id } = req.params as ScreenIdParams;
    const screen = await service.softDelete(id, { adminId: req.admin.id, ...clientInfo(req) });
    res.json({ screen } satisfies AdminScreenResponse);
  };

  const restore: RequestHandler = async (req, res) => {
    if (!req.admin) throw sessionExpired();
    const { id } = req.params as ScreenIdParams;
    const screen = await service.restore(id, { adminId: req.admin.id, ...clientInfo(req) });
    res.json({ screen } satisfies AdminScreenResponse);
  };

  return { create, list, getById, update, setActive, softDelete, restore };
}

export type ScreenAdminController = ReturnType<typeof createScreenAdminController>;
