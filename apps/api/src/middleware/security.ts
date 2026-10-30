import cors from 'cors';
import helmet from 'helmet';
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

/** Only allowlisted origins get CORS headers; others are refused by the browser. */
export function corsPolicy(allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins);
  return cors({
    origin: (origin, callback) => {
      // Requests without an Origin header (curl, same-origin GET, health checks) are not CORS.
      callback(null, origin === undefined || allowed.has(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', REQUEST_ID_HEADER],
    exposedHeaders: [REQUEST_ID_HEADER],
    maxAge: 600,
  });
}
