import type { RequestHandler } from 'express';

/**
 * `Cache-Control: no-store`: no browser or CDN may keep the response. Put it first in a route
 * chain, so that error responses get it too.
 */
export const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};
