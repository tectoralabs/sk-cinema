import type { AdminRole } from '@sk-cinema/shared';

declare global {
  namespace Express {
    interface Request {
      /** The signed-in admin, set by requireAuth. `role` comes from the DB, not the token. */
      admin?: { id: string; role: AdminRole };
    }
  }
}

export {};
