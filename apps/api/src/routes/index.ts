import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { createAuthController } from '../controllers/auth.controller.js';
import { createHealthController } from '../controllers/health.controller.js';
import { createPublicMovieController } from '../controllers/movie.public.controller.js';
import { ADMIN_PREFIX, PUBLIC_MOVIES_PREFIX } from '../lib/apiPaths.js';
import type { AuthServiceDeps } from '../services/auth.service.js';
import { createHealthService } from '../services/health.service.js';
import { createPublicMovieService } from '../services/movie.public.service.js';
import { adminRoutes } from './admin.routes.js';
import { healthRoutes } from './health.routes.js';
import { publicMovieRoutes } from './movie.public.routes.js';

/** Everything under /api. Admin routes mount at /api/admin behind CSRF protection and auth. */
export function apiRouter({ config, prisma, cache, logger }: AppDeps): Router {
  const router = Router();

  const healthService = createHealthService(prisma, cache, logger);
  router.use(healthRoutes(createHealthController(healthService)));

  // Public, read-only, cached in `cache`. Admin movie writes must call
  // invalidatePublicMovies(cache) on this same instance.
  const publicMovieService = createPublicMovieService({ db: prisma, cache });
  router.use(
    PUBLIC_MOVIES_PREFIX,
    publicMovieRoutes(createPublicMovieController(publicMovieService)),
  );

  const authService: AuthServiceDeps = { db: prisma, config: config.auth, logger };
  // ADMIN_PREFIX is also what the admin CORS policy (middleware/security.ts) matches on.
  router.use(
    ADMIN_PREFIX,
    adminRoutes({
      config,
      db: prisma,
      authController: createAuthController({ service: authService, config }),
    }),
  );

  return router;
}
