import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { createAuthController } from '../controllers/auth.controller.js';
import { createHealthController } from '../controllers/health.controller.js';
import { createMovieAdminController } from '../controllers/movie.admin.controller.js';
import { createPublicMovieController } from '../controllers/movie.public.controller.js';
import { createScreenAdminController } from '../controllers/screen.admin.controller.js';
import { createShowtimeAdminController } from '../controllers/showtime.admin.controller.js';
import { ADMIN_PREFIX, PUBLIC_MOVIES_PREFIX } from '../lib/apiPaths.js';
import type { AuthServiceDeps } from '../services/auth.service.js';
import { createHealthService } from '../services/health.service.js';
import { createMovieAdminService } from '../services/movie.admin.service.js';
import { createPublicMovieService } from '../services/movie.public.service.js';
import { createScreenAdminService } from '../services/screen.admin.service.js';
import { createSettingsService } from '../services/settings.service.js';
import { createShowtimeAdminService } from '../services/showtime.admin.service.js';
import { adminRoutes } from './admin.routes.js';
import { healthRoutes } from './health.routes.js';
import { publicMovieRoutes } from './movie.public.routes.js';

/** Everything under /api. Admin routes mount at /api/admin behind CSRF protection and auth. */
export function apiRouter({ config, prisma, cache, logger }: AppDeps): Router {
  const router = Router();

  const healthService = createHealthService(prisma, cache, logger);
  router.use(healthRoutes(createHealthController(healthService)));

  // Public, read-only, cached in `cache`. Admin movie, screen and showtime writes call
  // invalidatePublicMovies(cache) on this same instance (the admin services below get it).
  const publicMovieService = createPublicMovieService({ db: prisma, cache });
  router.use(
    PUBLIC_MOVIES_PREFIX,
    publicMovieRoutes(createPublicMovieController(publicMovieService)),
  );

  // Not cached (see settings.service.ts). Showtime writes read settings through their own
  // transaction client; this instance serves the reads outside transactions.
  const settingsService = createSettingsService({ db: prisma, logger });

  const authService: AuthServiceDeps = { db: prisma, config: config.auth, logger };
  // ADMIN_PREFIX is also what the admin CORS policy (middleware/security.ts) matches on.
  router.use(
    ADMIN_PREFIX,
    adminRoutes({
      config,
      db: prisma,
      authController: createAuthController({ service: authService, config }),
      movieAdminController: createMovieAdminController(
        createMovieAdminService({ db: prisma, cache }),
      ),
      screenAdminController: createScreenAdminController(
        createScreenAdminService({ db: prisma, cache }),
      ),
      showtimeAdminController: createShowtimeAdminController(
        createShowtimeAdminService({ db: prisma, settings: settingsService, cache, logger }),
      ),
    }),
  );

  return router;
}
