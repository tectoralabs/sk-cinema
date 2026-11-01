import type { Request } from 'express';

/**
 * Client details recorded with sessions and audit rows. Raw values: the services cut them to
 * the column limits (see `fitColumn` in services/audit.service.ts). `req.ip` honours the app's
 * `trust proxy` setting.
 */
export const clientInfo = (req: Request) => ({
  ipAddress: req.ip,
  userAgent: req.get('user-agent'),
});
