import { z } from 'zod';

/**
 * Body of endpoints that take no input (e.g. POST /api/admin/auth/refresh and /logout).
 * Only an absent body or `{}` is accepted; any key is rejected.
 */
export const emptyBodySchema = z.strictObject({});

export type EmptyBody = z.infer<typeof emptyBodySchema>;
