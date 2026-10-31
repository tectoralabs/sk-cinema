import cors, { type CorsOptions } from 'cors';
import { Router, type RequestHandler } from 'express';
import helmet from 'helmet';
import type { Config } from '../config/env.js';
import { ADMIN_API_PATH } from '../lib/apiPaths.js';
import { CSRF_HEADER } from './csrf.js';
import { REQUEST_ID_HEADER } from './requestLogger.js';

/**
 * The API only serves JSON, so the CSP forbids everything: nothing it returns
 * should ever be rendered, framed or allowed to load resources.
 */
export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    // web/admin/api share one site (example.com, admin.example.com, api.example.com).
    crossOriginResourcePolicy: { policy: 'same-site' },
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
  });
}

const SHARED_CORS_OPTIONS = {
  exposedHeaders: [REQUEST_ID_HEADER],
  maxAge: 600,
} satisfies CorsOptions;

/** Allows requests without an Origin (curl, health checks: not CORS) and listed origins. */
const allowlist =
  (origins: ReadonlySet<string>): CorsOptions['origin'] =>
  (origin, callback) => {
    callback(null, origin === undefined || origins.has(origin));
  };

/** Leaves the CORS router so the request continues with the next app middleware. */
const exitRouter: RequestHandler = (_req, _res, next) => {
  next('router');
};

/**
 * Two CORS policies, chosen per request:
 * - ADMIN_ORIGINS (the admin app) get credentialed CORS, with X-CSRF-Token, everywhere.
 * - CORS_ORIGINS (the public site) get CORS without credentials, and only outside
 *   /api/admin. There they get no CORS headers at all, so the browser blocks the response
 *   and fails the preflight: an XSS on the public site can't read a CSRF token or admin data.
 * Unlisted origins get no CORS headers anywhere. A refused preflight is not answered here; it
 * falls through to the routes and gets no CORS headers either.
 *
 * The /api/admin branch is a mounted path, so Express matches it exactly as it matches the
 * admin router (case-insensitive, trailing slash), rather than a hand-written path test.
 */
export function corsPolicy(config: Pick<Config, 'corsOrigins' | 'adminOrigins'>): Router {
  const adminOrigins = new Set(config.adminOrigins);
  const publicOrigins = new Set(config.corsOrigins);

  const adminCors = cors({
    ...SHARED_CORS_OPTIONS,
    origin: allowlist(adminOrigins),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', CSRF_HEADER, REQUEST_ID_HEADER],
  });
  // Public routes are read-only and cookie-free.
  const publicCors = cors({
    ...SHARED_CORS_OPTIONS,
    origin: allowlist(publicOrigins),
    credentials: false,
    methods: ['GET', 'HEAD'],
    allowedHeaders: ['Content-Type', REQUEST_ID_HEADER],
  });

  const router = Router();
  router.use(ADMIN_API_PATH, adminCors, exitRouter);
  router.use((req, res, next) => {
    const { origin } = req.headers;
    const policy = origin !== undefined && adminOrigins.has(origin) ? adminCors : publicCors;
    policy(req, res, next);
  });
  return router;
}
