import { z } from 'zod';

/**
 * Body of endpoints that take no input (e.g. POST /api/admin/auth/refresh and /logout).
 * Only an absent body or `{}` is accepted; any key is rejected.
 */
export const emptyBodySchema = z.strictObject({});

export type EmptyBody = z.infer<typeof emptyBodySchema>;

/**
 * Query of endpoints that take no query parameters (e.g. GET /api/movies/:slug).
 * Only an empty query string is accepted; any key is rejected.
 */
export const emptyQuerySchema = z.strictObject({});

export type EmptyQuery = z.infer<typeof emptyQuerySchema>;
