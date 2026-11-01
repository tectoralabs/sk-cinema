import { Router, type RequestHandler } from 'express';
import type { Config } from '../config/env.js';
import type { AuthController } from '../controllers/auth.controller.js';
import type { MovieAdminController } from '../controllers/movie.admin.controller.js';
import type { ScreenAdminController } from '../controllers/screen.admin.controller.js';
import type { ShowtimeAdminController } from '../controllers/showtime.admin.controller.js';
import { ADMIN_AUTH_PREFIX } from '../lib/apiPaths.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { csrfProtection } from '../middleware/csrf.js';
import type { AuthDb } from '../services/auth.service.js';
import { authRoutes } from './auth.routes.js';
import { movieAdminRoutes } from './movie.admin.routes.js';
import { screenAdminRoutes } from './screen.admin.routes.js';
import { showtimeAdminRoutes } from './showtime.admin.routes.js';

export interface AdminRoutesDeps {
  config: Pick<Config, 'auth' | 'adminOrigins'>;
  /** Only handed to requireAuth, which loads the admin through the auth service. */
  db: Pick<AuthDb, 'admin'>;
  authController: AuthController;
  /** Built in routes/index.ts with the app's shared cache, so writes can invalidate it. */
  movieAdminController: MovieAdminController;
  /** Built in routes/index.ts with the same shared cache. */
  screenAdminController: ScreenAdminController;
  /** Built in routes/index.ts with the same shared cache and the settings service. */
  showtimeAdminController: ShowtimeAdminController;
}

/** Admin responses are per-user and may be sensitive: never cache them anywhere. */
const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/**
 * Everything under /api/admin. Order matters:
 * 1. no-store first, so errors get it too;
 * 2. CSRF for every unsafe method, including unknown routes;
 * 3. /auth/* (csrf, login, refresh, logout): the only routes that work without a session;
 * 4. `authenticated` for everything after it. Auth is the default, not opt-in: any route or
 *    router added below is protected, and any unknown path answers 401 without a session
 *    (404 with one), so the route map is not revealed.
 *
 * Adding an admin router (Phase 4+): mount it BELOW `router.use(authenticated)` and give it an
 * explicit `requireRole(...)`, even when every role is allowed, e.g.
 *   router.use('/movies', requireRole('SUPER_ADMIN', 'EDITOR'), movieRoutes(...));
 * Never mount anything except the auth routes above `authenticated`.
 * admin.routes.test.ts walks this router and fails if a non-/auth route answers without a session.
 */
export function adminRoutes({
  config,
  db,
  authController,
  movieAdminController,
  screenAdminController,
  showtimeAdminController,
}: AdminRoutesDeps): Router {
  const router = Router();
  const authenticated = requireAuth({ db, config });

  router.use(noStore);
  router.use(csrfProtection(config));

  router.use(ADMIN_AUTH_PREFIX, authRoutes(authController, config));

  // ---- Everything below requires a valid session. ----
  router.use(authenticated);

  // Any signed-in admin may read their own profile (no requireRole by design).
  router.get('/me', authController.me);

  router.use(
    '/movies',
    requireRole('SUPER_ADMIN', 'EDITOR'),
    movieAdminRoutes(movieAdminController),
  );
  router.use(
    '/screens',
    requireRole('SUPER_ADMIN', 'EDITOR'),
    screenAdminRoutes(screenAdminController),
  );
  router.use(
    '/showtimes',
    requireRole('SUPER_ADMIN', 'EDITOR'),
    showtimeAdminRoutes(showtimeAdminController),
  );

  return router;
}
