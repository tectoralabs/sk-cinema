import type { AdminProfileResponse, CsrfTokenResponse, LoginBody } from '@sk-cinema/shared';
import type { Request, RequestHandler } from 'express';
import type { Config } from '../config/env.js';
import { clearAuthCookies, readRefreshToken, setAuthCookies } from '../lib/authCookies.js';
import { AppError } from '../lib/errors.js';
import { issueCsrfToken } from '../middleware/csrf.js';
import {
  type AuthServiceDeps,
  getMe,
  login,
  logout,
  refresh,
  sessionExpired,
} from '../services/auth.service.js';

export interface AuthControllerDeps {
  /** Passed straight to the auth service; the controller never touches the DB itself. */
  service: AuthServiceDeps;
  config: Pick<Config, 'auth'>;
}

/** Client details recorded with sessions and audit rows (the service trims them). */
const clientInfo = (req: Request) => ({ ipAddress: req.ip, userAgent: req.get('user-agent') });

/**
 * Auth endpoints. Tokens only ever travel in cookies: response bodies carry the admin
 * profile and nothing else.
 */
export function createAuthController({ service, config }: AuthControllerDeps) {
  const csrf: RequestHandler = (req, res) => {
    res.json({ csrfToken: issueCsrfToken(req, res, config) } satisfies CsrfTokenResponse);
  };

  const loginHandler: RequestHandler = async (req, res) => {
    // Already parsed by validate({ body: loginBodySchema }).
    const { email, password } = req.body as LoginBody;
    const result = await login({ email, password, ...clientInfo(req) }, service);
    setAuthCookies(res, result, config);
    res.json({ admin: result.admin } satisfies AdminProfileResponse);
  };

  const refreshHandler: RequestHandler = async (req, res) => {
    try {
      const refreshToken = readRefreshToken(req);
      if (refreshToken === undefined) throw sessionExpired();
      const result = await refresh({ refreshToken, ...clientInfo(req) }, service);
      setAuthCookies(res, result, config);
      res.json({ admin: result.admin } satisfies AdminProfileResponse);
    } catch (error) {
      // A refused session is over: drop the stale cookies so the client goes to login.
      if (error instanceof AppError && error.status === 401) clearAuthCookies(res);
      throw error;
    }
  };

  /** Works without a valid session, so an expired admin can still sign out. */
  const logoutHandler: RequestHandler = async (req, res) => {
    try {
      await logout({ refreshToken: readRefreshToken(req), ...clientInfo(req) }, service);
    } finally {
      // Even if revoking fails (DB down), the browser forgets the session.
      clearAuthCookies(res);
    }
    res.status(204).end();
  };

  /** Runs after requireAuth. */
  const me: RequestHandler = async (req, res) => {
    if (!req.admin) throw sessionExpired();
    const admin = await getMe(req.admin.id, service);
    res.json({ admin } satisfies AdminProfileResponse);
  };

  return {
    csrf,
    login: loginHandler,
    refresh: refreshHandler,
    logout: logoutHandler,
    me,
  };
}

export type AuthController = ReturnType<typeof createAuthController>;
