import type { AdminSettingsResponse, SettingsUpdateBody } from '@sk-cinema/shared';
import type { RequestHandler } from 'express';
import { clientInfo } from '../lib/clientInfo.js';
import { sessionExpired } from '../services/auth.service.js';
import type { SettingsAdminService } from '../services/settings.admin.service.js';

/** Admin settings endpoints. Run after requireAuth + requireRole; input is parsed by validate(). */
export function createSettingsAdminController(service: SettingsAdminService) {
  const get: RequestHandler = async (_req, res) => {
    res.json((await service.get()) satisfies AdminSettingsResponse);
  };

  const update: RequestHandler = async (req, res) => {
    // requireAuth always sets it; fail closed if a route is ever mounted without it.
    if (!req.admin) throw sessionExpired();
    const response = await service.update(req.body as SettingsUpdateBody, {
      adminId: req.admin.id,
      ...clientInfo(req),
    });
    res.json(response satisfies AdminSettingsResponse);
  };

  return { get, update };
}

export type SettingsAdminController = ReturnType<typeof createSettingsAdminController>;
