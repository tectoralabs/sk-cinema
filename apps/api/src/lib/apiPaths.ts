/**
 * Where the routers mount. app.ts, routes/index.ts and the CORS policy (middleware/security.ts)
 * all build their paths from these, so the admin CORS can never drift from the admin mount.
 */

/** app.ts mounts apiRouter here. */
export const API_PREFIX = '/api';

/** apiRouter mounts the admin router here. */
export const ADMIN_PREFIX = '/admin';

/** The admin router's full path: `/api/admin`. */
export const ADMIN_API_PATH = `${API_PREFIX}${ADMIN_PREFIX}`;

/** The admin router mounts the public auth routes (csrf, login, refresh, logout) here. */
export const ADMIN_AUTH_PREFIX = '/auth';
