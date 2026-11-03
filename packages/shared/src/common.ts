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

/** A control character (Unicode category Cc: C0, DEL and C1), NUL included. Linear scan. */
const CONTROL_CHARACTER = /\p{Cc}/u;

/** The same, except tab, line feed and carriage return. */
const CONTROL_CHARACTER_EXCEPT_LINE_BREAKS = /(?![\t\n\r])\p{Cc}/u;

/** Never echoes the value. */
const SINGLE_LINE_TEXT_MESSAGE = 'Remove tabs, line breaks and other hidden control characters';
const MULTI_LINE_TEXT_MESSAGE = 'Remove hidden control characters (line breaks and tabs are fine)';

const hasNoControlCharacter = (value: string) => !CONTROL_CHARACTER.test(value);

/**
 * Free text that reaches the database as one line, e.g. a title or a name: trimmed, 1 to `max`
 * characters, no control characters. Postgres refuses NUL in text (a 500 otherwise), and the
 * others have no place in a label.
 *
 * Trimming comes first, so tab, line feed, vertical tab, form feed and carriage return at either
 * end are removed and the rest is accepted; inside the text they are refused. Every other control
 * character (NUL, U+0001, DEL, U+0085, ...) is not whitespace to `trim()`, so it is refused
 * wherever it is.
 *
 * abort on `max`: the scan never runs on over-long input (see the regex safety note in movies.ts).
 */
export function singleLineTextSchema(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max, { abort: true })
    .refine(hasNoControlCharacter, { message: SINGLE_LINE_TEXT_MESSAGE });
}

/**
 * Like singleLineTextSchema, for text that may span lines (a synopsis): tab, line feed and
 * carriage return are also allowed inside it. Every other control character is refused.
 */
export function multiLineTextSchema(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max, { abort: true })
    .refine((value) => !CONTROL_CHARACTER_EXCEPT_LINE_BREAKS.test(value), {
      message: MULTI_LINE_TEXT_MESSAGE,
    });
}

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

/**
 * Free-text search from a query string, trimmed. Whitespace-only is treated as no search. It ends
 * up in a query, so control characters are refused as in singleLineTextSchema.
 */
export const querySearchSchema = z
  .string()
  .trim()
  .max(100, { abort: true })
  .refine(hasNoControlCharacter, { message: SINGLE_LINE_TEXT_MESSAGE })
  .transform((value) => (value === '' ? undefined : value));

/** Soft-deleted rows in admin lists: hide them (default), include them, or show only them. */
export const deletedFilterSchema = z.enum(['exclude', 'include', 'only']);

export type DeletedFilter = z.infer<typeof deletedFilterSchema>;

/** Page number of admin list queries (from 1). */
export const pageQuerySchema = queryIntSchema(1, 999_999).default(1);

/** Page size of admin list queries: 1–100, default 20. */
export const pageSizeQuerySchema = queryIntSchema(1, 100).default(20);
