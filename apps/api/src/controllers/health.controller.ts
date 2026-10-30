import type { RequestHandler } from 'express';
import type { HealthService } from '../services/health.service.js';

export function createHealthController(service: HealthService) {
  const get: RequestHandler = async (_req, res) => {
    const report = await service.check();
    res
      .status(report.status === 'ok' ? 200 : 503)
      .set('Cache-Control', 'no-store')
      .json(report);
  };

  return { get };
}

export type HealthController = ReturnType<typeof createHealthController>;
