import { ERROR_CODES, type AdminRole } from '@sk-cinema/shared';
import type { RequestHandler } from 'express';
import type { Config } from '../config/env.js';
import { readAccessToken } from '../lib/authCookies.js';
import { AppError } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { type AuthDb, findAdminAuthState, sessionExpired } from '../services/auth.service.js';

export const FORBIDDEN_MESSAGE = 'You do not have permission to do this';

type AuthFailure = 'no_cookie' | 'invalid_token' | 'unknown_admin' | 'inactive' | 'no_admin';

export interface RequireAuthDeps {
  db: Pick<AuthDb, 'admin'>;
  config: Pick<Config, 'auth'>;
}

/**
 * Authenticates the access-token cookie and sets `req.admin`. The admin is loaded on every
 * request, so deactivation and role changes apply at once; `req.admin.role` is the DB role,
 * never the token claim. Every failure is the same 401 (SESSION_EXPIRED_MESSAGE), so clients
 * can always "try refresh, else log in" and can't tell which check failed.
 * DB errors are not auth failures: they reject and reach the error handler as a 500.
 */
export function requireAuth({ db, config }: RequireAuthDeps): RequestHandler {
  const { jwtAccessSecret } = config.auth;

  return async (req, _res, next) => {
    const refuse = (reason: AuthFailure) => {
      // Only the reason: never the token or cookie.
      req.log.debug({ reason }, 'Authentication failed');
      next(sessionExpired());
    };

    const token = readAccessToken(req);
    if (token === undefined) {
      refuse('no_cookie');
      return;
    }

    const subject = await verifyAccessToken(token, { secret: jwtAccessSecret });
    if (!subject) {
      refuse('invalid_token');
      return;
    }

    const admin = await findAdminAuthState(subject.adminId, { db });
    if (!admin) {
      refuse('unknown_admin');
      return;
    }
    if (!admin.isActive) {
      refuse('inactive');
      return;
    }

    req.admin = { id: admin.id, role: admin.role };
    next();
  };
}

/**
 * Allows only admins whose (DB) role is listed. Must run after requireAuth; without
 * `req.admin` it fails closed with the same 401 as requireAuth.
 */
export function requireRole(...roles: AdminRole[]): RequestHandler {
  if (roles.length === 0) throw new Error('requireRole needs at least one role');
  const allowed = new Set<AdminRole>(roles);

  return (req, _res, next) => {
    if (!req.admin) {
      req.log.debug({ reason: 'no_admin' satisfies AuthFailure }, 'Authentication failed');
      next(sessionExpired());
      return;
    }
    if (!allowed.has(req.admin.role)) {
      req.log.debug({ role: req.admin.role }, 'Role not allowed');
      next(new AppError(403, ERROR_CODES.FORBIDDEN, FORBIDDEN_MESSAGE));
      return;
    }
    next();
  };
}
