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

/*
 * Building blocks shared by the resource schemas (movies, screens, showtimes, settings).
 * Every pattern here is anchored and bounded, so it fails within a few characters on
 * over-long input (see the regex safety note in movies.ts).
 */

/**
 * Calendar date as `YYYY-MM-DD` (a date only, no time zone). Rejects impossible dates such
 * as 2026-02-30 and 2026-13-01, and two-digit years. For showtimes it is a date in Colombo.
 */
export const calendarDateSchema = z.iso.date();

/** Whole number from a query string. Digits only (no signs, decimals, exponents or spaces). */
export function queryIntSchema(min: number, max: number) {
  return z
    .string()
    .regex(/^\d{1,6}$/, 'Must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
}

/** Boolean from a query string. Only the literal strings 'true' and 'false' are accepted. */
export const queryBooleanSchema = z.enum(['true', 'false']).transform((value) => value === 'true');

/** Free-text search from a query string, trimmed. Whitespace-only is treated as no search. */
export const querySearchSchema = z
  .string()
  .trim()
  .max(100)
  .transform((value) => (value === '' ? undefined : value));

/** Soft-deleted rows in admin lists: hide them (default), include them, or show only them. */
export const deletedFilterSchema = z.enum(['exclude', 'include', 'only']);

export type DeletedFilter = z.infer<typeof deletedFilterSchema>;

/** Page number of admin list queries (from 1). */
export const pageQuerySchema = queryIntSchema(1, 999_999).default(1);

/** Page size of admin list queries: 1–100, default 20. */
export const pageSizeQuerySchema = queryIntSchema(1, 100).default(20);
