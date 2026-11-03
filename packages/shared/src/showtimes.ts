import { z } from 'zod';
import { bookingUrlOverrideSchema, isBmsBookingUrl } from './bms.js';
import {
  calendarDateSchema,
  deletedFilterSchema,
  pageQuerySchema,
  pageSizeQuerySchema,
  queryBooleanSchema,
} from './common.js';
import { movieStatusSchema } from './movies.js';

/*
 * Showtimes are stored as UTC instants. Admins enter, and the public site shows, Colombo wall
 * clock values: a `date` (YYYY-MM-DD) and a `time` (HH:mm, 24-hour) in Asia/Colombo. The API
 * converts between the two; these schemas only check the shapes. Rules that depend on the
 * current time (no showtimes in the past) or on the database (movie and screen exist, no
 * overlap on the same screen) are enforced by the services.
 *
 * Every pattern below is either length-checked first with `abort: true` or is an anchored,
 * bounded match (see the regex safety note in movies.ts).
 */

/* -------------------------------------------------------------------------- */
/* Building blocks                                                            */
/* -------------------------------------------------------------------------- */

/** The first and last year a showtime can be scheduled in, or an admin list can ask for. */
export const SHOWTIME_DATE_MIN_YEAR = 2020;
export const SHOWTIME_DATE_MAX_YEAR = 2099;

const SHOWTIME_DATE_MESSAGE = `Use a date from ${String(SHOWTIME_DATE_MIN_YEAR)} to ${String(SHOWTIME_DATE_MAX_YEAR)}, as YYYY-MM-DD`;

/**
 * A Colombo date in an admin showtime request: a real `YYYY-MM-DD` from SHOWTIME_DATE_MIN_YEAR to
 * SHOWTIME_DATE_MAX_YEAR. The API turns these into instants at a fixed +05:30, exact from 2006
 * onward (lib/colomboTime.ts), and computes the day after `to`, so the years are bounded here.
 * Not for `releaseDate` or dates in responses (calendarDateSchema), nor the public `?date=`, which
 * is only compared with the dates of upcoming shows. The message never echoes the value.
 *
 * abort: the year is only read from a well-formed date, and the anchored pattern of z.iso.date()
 * fails within a few characters on over-long input.
 */
export const showtimeDateSchema = z.iso
  .date({ abort: true, message: SHOWTIME_DATE_MESSAGE })
  .refine(
    (date) => {
      const year = Number(date.slice(0, 4));
      return year >= SHOWTIME_DATE_MIN_YEAR && year <= SHOWTIME_DATE_MAX_YEAR;
    },
    { message: SHOWTIME_DATE_MESSAGE },
  );

/** Matches `Showtime.format VarChar(20)`. */
export const SHOWTIME_FORMAT_MAX_LENGTH = 20;

/** Bulk create: longest date range, counting both ends (dateFrom to dateTo inclusive). */
export const SHOWTIME_BULK_MAX_DAYS = 31;

/** Bulk create: most start times per day. */
export const SHOWTIME_BULK_MAX_TIMES = 12;

/**
 * Bulk create errors: most entries in `details` (past slots on a 400, clashes on a 409). The
 * error `message` always gives the full count, so a client can say "and N more".
 */
export const SHOWTIME_BULK_MAX_DETAILS = 50;

/** Bulk delete: most IDs per request. */
export const SHOWTIME_BULK_DELETE_MAX_IDS = 200;

const TIME_MESSAGE = 'Use a 24-hour time as HH:mm, from 00:00 to 23:59';

/** Exactly `HH:mm`, 00:00 to 23:59. */
const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/**
 * Colombo wall-clock time as exactly `HH:mm` (24-hour, 00:00 to 23:59). Rejects `24:00`,
 * `9:00`, `09:60` and seconds (`09:00:00`).
 */
export const clockTimeSchema = z
  .string()
  // abort: the pattern below never runs on over-long input.
  .max(5, { abort: true, message: TIME_MESSAGE })
  .regex(CLOCK_TIME, TIME_MESSAGE);

export type ClockTime = z.infer<typeof clockTimeSchema>;

const FORMAT_MESSAGE =
  'Use letters and digits, separated by single spaces or hyphens (e.g. 2D, 3D, IMAX 3D)';

/**
 * Words of letters and digits separated by single spaces or hyphens. The separator is never a
 * word character, so there is only one way to match: linear time.
 */
const FORMAT_PATTERN = /^[A-Za-z0-9]+(?:[ -][A-Za-z0-9]+)*$/;

/** The normalised form: FORMAT_PATTERN with uppercase letters only. */
const NORMALIZED_FORMAT_PATTERN = /^[A-Z0-9]+(?:[ -][A-Z0-9]+)*$/;

/**
 * Projection format, e.g. "2D", "3D", "IMAX 3D", "4DX". Trimmed, 1–20 characters, then
 * uppercased, so "2d", " 2D" and "2D " are all stored as "2D" and "imax 3d" as "IMAX 3D".
 * A free string rather than an enum so the cinema can add formats without a code change.
 * Never null or empty in requests: omit it on create to get the database default "2D".
 *
 * The ASCII-only charset is checked BEFORE uppercasing, so the plain `toUpperCase()` only
 * ever sees A–Z, a–z, 0–9, space and hyphen. Non-ASCII is rejected first, which means
 * Unicode case mappings cannot change the result or its length (e.g. "ß" → "SS" or the
 * Turkish dotless "ı" → "I" cannot sneak in as ASCII).
 */
export const showtimeFormatSchema = z
  .string()
  .trim()
  // abort: an empty value gets one clear message.
  .min(1, { abort: true, message: 'Enter a format (e.g. 2D)' })
  // abort: the pattern below never runs on over-long input.
  .max(SHOWTIME_FORMAT_MAX_LENGTH, { abort: true })
  .regex(FORMAT_PATTERN, FORMAT_MESSAGE)
  .toUpperCase();

/**
 * A format as it appears in responses: already normalised (trimmed, uppercase, same charset
 * and length). Rejects "2d" and " 2D", so a non-normalised value can never be emitted.
 * Response schemas wrap it in `.nullable()`: `null` means "stored value could not be
 * normalised" (see normalizeShowtimeFormat).
 */
export const normalizedShowtimeFormatSchema = z
  .string()
  // abort: the pattern below never runs on over-long input.
  .max(SHOWTIME_FORMAT_MAX_LENGTH, { abort: true })
  .regex(NORMALIZED_FORMAT_PATTERN, 'Must be a normalised format (e.g. 2D, IMAX 3D)');

/**
 * Normalises a stored format for responses: the same trim + uppercase as showtimeFormatSchema.
 * Returns `null` (no format shown) when the stored value cannot be normalised, e.g. a manually
 * inserted "2D/3D", "", "ßD" or an over-long value. A non-null result always passes
 * normalizedShowtimeFormatSchema.
 *
 * Apply it to `format` whenever a showtime row is mapped to an admin or public response.
 * When it returns `null`, the caller must log a warning with the showtime ID and the reason
 * only (e.g. "stored format could not be normalised"). Never log the raw stored value.
 */
export function normalizeShowtimeFormat(value: string): string | null {
  const result = showtimeFormatSchema.safeParse(value);
  return result.success ? result.data : null;
}

const MS_PER_DAY = 86_400_000;

/**
 * Number of days from `from` to `to`, counting both ends (same day = 1, `to` before `from`
 * gives 0 or less). `null` if either is not a valid `YYYY-MM-DD`. Parsed as ISO so years
 * below 100 are not mapped to 19xx.
 */
function inclusiveDayCount(from: unknown, to: unknown): number | null {
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  if (!calendarDateSchema.safeParse(from).success || !calendarDateSchema.safeParse(to).success) {
    return null;
  }
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / MS_PER_DAY) + 1;
}

/** Adds an issue at the index of every repeated value (compared by `key`). */
function rejectDuplicates(
  values: readonly unknown[],
  ctx: z.RefinementCtx,
  key: (value: string) => string,
  message: string,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (typeof value !== 'string') return;
    const k = key(value);
    if (seen.has(k)) ctx.addIssue({ code: 'custom', path: [index], message });
    seen.add(k);
  });
}

/** Bulk create start times: 1–12 distinct `HH:mm` values (any order). */
const bulkTimesSchema = z
  .array(clockTimeSchema)
  .min(1, 'Add at least one time')
  .max(SHOWTIME_BULK_MAX_TIMES, `Add at most ${SHOWTIME_BULK_MAX_TIMES} times`)
  .superRefine((times, ctx) => {
    rejectDuplicates(times, ctx, (time) => time, 'Each time can only appear once');
  });

/* -------------------------------------------------------------------------- */
/* Params                                                                     */
/* -------------------------------------------------------------------------- */

/** Params of admin routes addressing a showtime by ID, e.g. /api/admin/showtimes/:id. */
export const showtimeIdParamsSchema = z.strictObject({
  id: z.uuid(),
});

export type ShowtimeIdParams = z.infer<typeof showtimeIdParamsSchema>;

/** Params of the public showtime routes: /api/movies/:id/dates and /api/movies/:id/showtimes. */
export const publicMovieIdParamsSchema = z.strictObject({
  id: z.uuid(),
});

export type PublicMovieIdParams = z.infer<typeof publicMovieIdParamsSchema>;

/* -------------------------------------------------------------------------- */
/* Request bodies                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Body of POST /api/admin/showtimes: one showtime at a Colombo `date` + `time`.
 * `bookingUrlOverride` (optional, `null` = none) must be a BookMyShow booking link; without it
 * the link is generated from the `bmsBaseUrl` setting and the Colombo date.
 */
export const showtimeCreateBodySchema = z.strictObject({
  movieId: z.uuid(),
  screenId: z.uuid(),
  date: showtimeDateSchema,
  time: clockTimeSchema,
  format: showtimeFormatSchema.optional(),
  bookingUrlOverride: bookingUrlOverrideSchema.nullable().optional(),
});

export type ShowtimeCreateBody = z.infer<typeof showtimeCreateBodySchema>;
export type ShowtimeCreateBodyInput = z.input<typeof showtimeCreateBodySchema>;

/**
 * Body of POST /api/admin/showtimes/bulk: one showtime per day from `dateFrom` to `dateTo`
 * (Colombo dates, inclusive, at most SHOWTIME_BULK_MAX_DAYS days) at each of `times`.
 * No `bookingUrlOverride` here: overrides are per showtime, set by editing one.
 */
export const showtimeBulkCreateBodySchema = z
  .strictObject({
    movieId: z.uuid(),
    screenId: z.uuid(),
    dateFrom: showtimeDateSchema,
    dateTo: showtimeDateSchema,
    times: bulkTimesSchema,
    format: showtimeFormatSchema.optional(),
  })
  .superRefine((body, ctx) => {
    const days = inclusiveDayCount(body.dateFrom, body.dateTo);
    if (days === null) return;
    if (days < 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['dateTo'],
        message: 'End date must be on or after the start date',
      });
    } else if (days > SHOWTIME_BULK_MAX_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['dateTo'],
        message: `Choose at most ${SHOWTIME_BULK_MAX_DAYS} days`,
      });
    }
  });

export type ShowtimeBulkCreateBody = z.infer<typeof showtimeBulkCreateBodySchema>;
export type ShowtimeBulkCreateBodyInput = z.input<typeof showtimeBulkCreateBodySchema>;

/**
 * Body of PATCH /api/admin/showtimes/:id. Any subset of the fields, at least one.
 * `date` and `time` must be sent together (both or neither), so the new start is always a
 * complete Colombo date + time. `bookingUrlOverride: null` removes the override.
 * The movie cannot be changed: delete the showtime and create a new one.
 */
export const showtimeUpdateBodySchema = z
  .strictObject({
    screenId: z.uuid().optional(),
    date: showtimeDateSchema.optional(),
    time: clockTimeSchema.optional(),
    format: showtimeFormatSchema.optional(),
    bookingUrlOverride: bookingUrlOverrideSchema.nullable().optional(),
  })
  .superRefine((body, ctx) => {
    if (!Object.values(body).some((value) => value !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'Provide at least one field to update' });
      return;
    }
    if ((body.date === undefined) !== (body.time === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [body.date === undefined ? 'date' : 'time'],
        message: 'Send the date and the time together',
      });
    }
  });

export type ShowtimeUpdateBody = z.infer<typeof showtimeUpdateBodySchema>;
export type ShowtimeUpdateBodyInput = z.input<typeof showtimeUpdateBodySchema>;

/** Body of the admin bulk delete endpoint (soft delete): 1–200 distinct showtime IDs. */
export const showtimeBulkDeleteBodySchema = z.strictObject({
  ids: z
    .array(z.uuid())
    .min(1, 'Select at least one showtime')
    .max(SHOWTIME_BULK_DELETE_MAX_IDS, `Select at most ${SHOWTIME_BULK_DELETE_MAX_IDS} showtimes`)
    .superRefine((ids, ctx) => {
      // UUIDs are case-insensitive, so `A...` and `a...` are the same showtime.
      rejectDuplicates(ids, ctx, (id) => id.toLowerCase(), 'Each showtime can only appear once');
    }),
});

export type ShowtimeBulkDeleteBody = z.infer<typeof showtimeBulkDeleteBodySchema>;

/* -------------------------------------------------------------------------- */
/* Query strings                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Query of GET /api/admin/showtimes. All values arrive as strings and are converted here.
 * `from` / `to` are Colombo dates (inclusive). Past showtimes are left out unless
 * `includePast=true`, whatever `from` says. Results are sorted by `startsAt` ascending.
 */
export const adminShowtimeListQuerySchema = z
  .strictObject({
    movieId: z.uuid().optional(),
    screenId: z.uuid().optional(),
    from: showtimeDateSchema.optional(),
    to: showtimeDateSchema.optional(),
    /** Only the literal strings 'true' and 'false' are accepted. */
    includePast: queryBooleanSchema.default(false),
    /** Soft-deleted showtimes: hide them (default), include them, or show only them. */
    deleted: deletedFilterSchema.default('exclude'),
    page: pageQuerySchema,
    pageSize: pageSizeQuerySchema,
  })
  .superRefine((query, ctx) => {
    const days = inclusiveDayCount(query.from, query.to);
    if (days !== null && days < 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: '"to" must be on or after "from"',
      });
    }
  });

export type AdminShowtimeListQuery = z.infer<typeof adminShowtimeListQuerySchema>;
export type AdminShowtimeListQueryInput = z.input<typeof adminShowtimeListQuerySchema>;

/** Query of GET /api/movies/:id/showtimes: the Colombo date to list. Required. */
export const publicShowtimeListQuerySchema = z.strictObject({
  date: calendarDateSchema,
});

export type PublicShowtimeListQuery = z.infer<typeof publicShowtimeListQuerySchema>;

// GET /api/movies/:id/dates takes no query: validate it with emptyQuerySchema (common.ts).

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

/** A resolved booking link (override, else generated). Always passes isBmsBookingUrl. */
const bookingUrlSchema = z.string().refine(isBmsBookingUrl, {
  message: 'Must be a BookMyShow booking link',
});

/**
 * A showtime as returned by admin endpoints. Timestamps are ISO 8601 UTC strings.
 * - `endsAt` = `startsAt` + the movie's duration (informational; excludes the show gap).
 * - `colomboDate` / `time` are `startsAt` in Asia/Colombo (what the admin entered).
 * - `bookingUrlOverride` is the stored value (shown so admins can edit it); `bookingUrl` is
 *   the link visitors get: the override if valid, else the generated link.
 * - `format` is normalised, or `null` if the stored value could not be: map stored rows
 *   through normalizeShowtimeFormat.
 */
export const adminShowtimeSchema = z.strictObject({
  id: z.uuid(),
  movie: z.strictObject({
    id: z.uuid(),
    title: z.string(),
    durationMinutes: z.number().int(),
    status: movieStatusSchema,
  }),
  screen: z.strictObject({
    id: z.uuid(),
    name: z.string(),
  }),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  colomboDate: calendarDateSchema,
  time: clockTimeSchema,
  format: normalizedShowtimeFormatSchema.nullable(),
  bookingUrlOverride: z.string().nullable(),
  bookingUrl: bookingUrlSchema,
  deletedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type AdminShowtime = z.infer<typeof adminShowtimeSchema>;

/** Response of GET /api/admin/showtimes. */
export const adminShowtimeListResponseSchema = z.strictObject({
  items: z.array(adminShowtimeSchema),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
  total: z.number().int().min(0),
});

export type AdminShowtimeListResponse = z.infer<typeof adminShowtimeListResponseSchema>;

/** Response of admin endpoints that return a single showtime (e.g. get, create, update). */
export const adminShowtimeResponseSchema = z.strictObject({
  showtime: adminShowtimeSchema,
});

export type AdminShowtimeResponse = z.infer<typeof adminShowtimeResponseSchema>;

/** Response of the bulk create endpoint: how many were created, and the created showtimes. */
export const showtimeBulkCreateResponseSchema = z
  .strictObject({
    created: z.number().int().min(1),
    items: z.array(adminShowtimeSchema),
  })
  .refine((body) => body.created === body.items.length, {
    path: ['created'],
    message: '"created" must equal the number of items',
  });

export type ShowtimeBulkCreateResponse = z.infer<typeof showtimeBulkCreateResponseSchema>;

/** Response of the bulk delete endpoint: how many showtimes were soft-deleted. */
export const showtimeBulkDeleteResponseSchema = z.strictObject({
  deleted: z.number().int().min(0),
});

export type ShowtimeBulkDeleteResponse = z.infer<typeof showtimeBulkDeleteResponseSchema>;

/**
 * The showtime a requested slot clashes with. `showtimeId` is `null` when the clash is with
 * another slot in the same bulk request (not yet saved). `startsAt` / `endsAt` are ISO UTC;
 * `endsAt` is start + duration (the required gap comes on top of it).
 */
export const showtimeConflictSchema = z.strictObject({
  showtimeId: z.uuid().nullable(),
  movieTitle: z.string(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
});

export type ShowtimeConflict = z.infer<typeof showtimeConflictSchema>;

/**
 * One entry of `details` on a 409 CONFLICT for overlapping showtimes on the same screen.
 * `path` points at the field, like validation details (e.g. ["body", "time"] or
 * ["body", "times", 2]); `requested` is the Colombo date + time that clashes.
 */
export const showtimeConflictDetailSchema = z.strictObject({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string().min(1),
  requested: z.strictObject({
    date: calendarDateSchema,
    time: clockTimeSchema,
  }),
  conflict: showtimeConflictSchema,
});

export type ShowtimeConflictDetail = z.infer<typeof showtimeConflictDetailSchema>;

/** `details` of a showtime overlap 409: at least one clash. */
export const showtimeConflictDetailsSchema = z.array(showtimeConflictDetailSchema).min(1);

/** Full error body of a showtime overlap: `{ error: { code: 'CONFLICT', message, details } }`. */
export const showtimeConflictErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.literal('CONFLICT'),
    message: z.string().min(1),
    details: showtimeConflictDetailsSchema,
  }),
});

export type ShowtimeConflictError = z.infer<typeof showtimeConflictErrorSchema>;

/**
 * `details` of the 409 CONFLICT when upcoming showtimes (of a movie or a screen) block the
 * write: a movie soft or permanent delete, a screen hide or soft delete. Not an array, unlike
 * the overlap details: there is no field to point at, only how many showtimes to clear first.
 */
export const futureShowtimesConflictDetailsSchema = z.strictObject({
  futureShowtimeCount: z.number().int().min(1),
});

export type FutureShowtimesConflictDetails = z.infer<typeof futureShowtimesConflictDetailsSchema>;

/**
 * One entry of `details` on the bulk create 400 for slots at or before the current time:
 * `path` is ["body", "times", i] (the index in `times`), `requested` the Colombo date + time.
 */
export const showtimePastSlotDetailSchema = z.strictObject({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string().min(1),
  requested: z.strictObject({
    date: calendarDateSchema,
    time: clockTimeSchema,
  }),
});

export type ShowtimePastSlotDetail = z.infer<typeof showtimePastSlotDetailSchema>;

/**
 * Full error body of the bulk create 400 for past slots:
 * `{ error: { code: 'VALIDATION_ERROR', message, details } }`, 1 to SHOWTIME_BULK_MAX_DETAILS
 * entries; the message gives the total.
 */
export const showtimePastSlotErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.literal('VALIDATION_ERROR'),
    message: z.string().min(1),
    details: z.array(showtimePastSlotDetailSchema).min(1).max(SHOWTIME_BULK_MAX_DETAILS),
  }),
});

export type ShowtimePastSlotError = z.infer<typeof showtimePastSlotErrorSchema>;

/** Response of GET /api/movies/:id/dates: future Colombo dates with showtimes, ascending. */
export const publicShowtimeDatesResponseSchema = z.strictObject({
  dates: z
    .array(calendarDateSchema)
    .refine((dates) => dates.every((date, i) => i === 0 || (dates[i - 1] ?? '') < date), {
      message: 'Dates must be unique and in ascending order',
    }),
});

export type PublicShowtimeDatesResponse = z.infer<typeof publicShowtimeDatesResponseSchema>;

/**
 * A showtime as shown on the public site. An explicit whitelist, built on its own (not derived
 * from adminShowtimeSchema) so admin-only fields never leak by default. Never add
 * bookingUrlOverride, deletedAt, isActive, movie or screen IDs, timestamps or audit data here.
 * `startsAt` is ISO UTC; `time` is the Colombo `HH:mm`; `bookingUrl` is the resolved link;
 * `format` is normalised, or `null` if the stored value could not be (map stored rows
 * through normalizeShowtimeFormat).
 */
export const publicShowtimeSchema = z.strictObject({
  id: z.uuid(),
  startsAt: z.iso.datetime(),
  time: clockTimeSchema,
  format: normalizedShowtimeFormatSchema.nullable(),
  screen: z.strictObject({
    name: z.string(),
  }),
  bookingUrl: bookingUrlSchema,
});

export type PublicShowtime = z.infer<typeof publicShowtimeSchema>;

/** Response of GET /api/movies/:id/showtimes?date=YYYY-MM-DD (empty `items` if none). */
export const publicShowtimeListResponseSchema = z.strictObject({
  date: calendarDateSchema,
  items: z.array(publicShowtimeSchema),
});

export type PublicShowtimeListResponse = z.infer<typeof publicShowtimeListResponseSchema>;
