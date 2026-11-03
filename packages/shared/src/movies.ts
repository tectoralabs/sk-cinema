import { z } from 'zod';
import {
  calendarDateSchema,
  deletedFilterSchema,
  multiLineTextSchema,
  pageQuerySchema,
  pageSizeQuerySchema,
  queryBooleanSchema,
  querySearchSchema,
  singleLineTextSchema,
} from './common.js';

/* -------------------------------------------------------------------------- */
/* Building blocks                                                            */
/* -------------------------------------------------------------------------- */

/** The first and last year of a `releaseDate` in a request (Postgres `date` refuses year 0). */
export const RELEASE_DATE_MIN_YEAR = 1900;
export const RELEASE_DATE_MAX_YEAR = 2099;

const RELEASE_DATE_MESSAGE = `Use a date from ${String(RELEASE_DATE_MIN_YEAR)} to ${String(RELEASE_DATE_MAX_YEAR)}, as YYYY-MM-DD`;

/**
 * A `releaseDate` in a create or update request: a real `YYYY-MM-DD` from RELEASE_DATE_MIN_YEAR to
 * RELEASE_DATE_MAX_YEAR. Requests only: responses and the public `?date=` keep
 * calendarDateSchema, so a stored row outside the range still reads back. The message never
 * echoes the value.
 *
 * abort: the year is only read from a well-formed date, and the anchored pattern of z.iso.date()
 * fails within a few characters on over-long input.
 */
export const releaseDateSchema = z.iso.date({ abort: true, message: RELEASE_DATE_MESSAGE }).refine(
  (date) => {
    const year = Number(date.slice(0, 4));
    return year >= RELEASE_DATE_MIN_YEAR && year <= RELEASE_DATE_MAX_YEAR;
  },
  { message: RELEASE_DATE_MESSAGE },
);

/** Movie lifecycle status. Mirrors the `MovieStatus` enum in the Prisma schema. */
export const movieStatusSchema = z.enum(['UPCOMING', 'NOW_SHOWING', 'ENDED']);

export type MovieStatus = z.infer<typeof movieStatusSchema>;

/*
 * Regex safety: Zod 4 keeps running a string's later checks after one fails, so without
 * `abort: true` a `.regex()` or `.refine()` placed after `.max(n)` still sees the whole input
 * (up to the 100 KB JSON body limit). Every pattern below that can see request input is
 * therefore either length-checked first (`.max(n, { abort: true })` or a length test inside the
 * refine) or anchored with a bounded match that fails within a few characters (e.g.
 * `^\d{1,6}$`, `z.iso.date()`, `z.uuid()`), and none has nested or overlapping quantifiers.
 * Keep it that way when adding patterns.
 */

const SLUG_MAX_LENGTH = 160;

/** URL slug: lowercase letters and digits in groups separated by single hyphens. */
export const slugSchema = z
  .string()
  .min(1)
  // abort: the pattern below never runs on over-long input.
  .max(SLUG_MAX_LENGTH, { abort: true })
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, digits and single hyphens');

const TRAILER_URL_MAX_LENGTH = 500;

/** Prefixes of accepted watch links; the query string follows. */
const YOUTUBE_WATCH_PREFIXES = [
  'https://youtube.com/watch?',
  'https://www.youtube.com/watch?',
  'https://m.youtube.com/watch?',
] as const;
const YOUTUBE_SHORT_PREFIX = 'https://youtu.be/';
/** A whole query string: URL-safe characters and `&` separators only (no `#`, `?`, `/`, `@`). */
const QUERY_STRING = /^[A-Za-z0-9_.~%=&-]*$/;
/** YouTube video IDs are 11 characters from this alphabet. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** A query string whose `&`-separated parameters include exactly `v=<video id>`. */
function hasVideoIdParam(query: string): boolean {
  return query.split('&').some((param) => param.startsWith('v=') && VIDEO_ID.test(param.slice(2)));
}

/**
 * Accepted trailer URLs (https only, no ports, credentials or fragments):
 * - https://youtube.com/watch?v=ID, https://www.youtube.com/watch?v=ID, https://m.youtube.com/watch?v=ID
 *   (other query parameters may appear before or after `v`)
 * - https://youtu.be/ID (optionally with a query, e.g. `?si=...` from the share button)
 *
 * Plain string checks against exact prefixes, so lookalike hosts such as youtube.com.evil.com
 * are rejected. Deliberately not `new URL()`: it normalises (lowercases the scheme and host,
 * drops the default port `:443`, resolves `/./`, strips tabs and newlines), which would accept
 * links these exact checks reject. Every step is linear, and the length is checked first.
 */
function isYouTubeTrailerUrl(url: string): boolean {
  if (url.length > TRAILER_URL_MAX_LENGTH) return false;

  const watchPrefix = YOUTUBE_WATCH_PREFIXES.find((prefix) => url.startsWith(prefix));
  if (watchPrefix !== undefined) {
    const query = url.slice(watchPrefix.length);
    return QUERY_STRING.test(query) && hasVideoIdParam(query);
  }

  if (url.startsWith(YOUTUBE_SHORT_PREFIX)) {
    const rest = url.slice(YOUTUBE_SHORT_PREFIX.length);
    const queryStart = rest.indexOf('?');
    const videoId = queryStart === -1 ? rest : rest.slice(0, queryStart);
    const query = queryStart === -1 ? '' : rest.slice(queryStart + 1);
    return VIDEO_ID.test(videoId) && QUERY_STRING.test(query);
  }

  return false;
}

/** HTTPS YouTube trailer link. See isYouTubeTrailerUrl for what is accepted. */
export const trailerUrlSchema = z
  .string()
  .trim()
  // abort: the refine below never runs on over-long input (it also checks the length itself).
  .max(TRAILER_URL_MAX_LENGTH, { abort: true })
  .refine(isYouTubeTrailerUrl, {
    message: 'Must be an https YouTube link (youtube.com/watch?v=... or youtu.be/...)',
  });

/** Shortest accepted movie running time, in minutes. */
export const MOVIE_DURATION_MIN_MINUTES = 1;

/**
 * Longest accepted movie running time, in minutes. The API also relies on it to bound the
 * showtime overlap query (a show can start at most this long, plus the show gap, before a
 * clashing one), so raising it widens that query window.
 */
export const MOVIE_DURATION_MAX_MINUTES = 600;

/** Removes case-insensitive duplicates, keeping the first spelling. */
function dedupeCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const genresSchema = z.array(singleLineTextSchema(30)).max(10).transform(dedupeCaseInsensitive);

const castSchema = z.array(singleLineTextSchema(100)).max(30);

/**
 * Editable movie fields shared by create and update. Optional text columns are
 * nullable: send `null` (not an empty string) to leave them blank or clear them.
 */
const movieFields = {
  title: singleLineTextSchema(150),
  slug: slugSchema,
  synopsis: multiLineTextSchema(5000).nullable(),
  durationMinutes: z.number().int().min(MOVIE_DURATION_MIN_MINUTES).max(MOVIE_DURATION_MAX_MINUTES),
  language: singleLineTextSchema(50).nullable(),
  genres: genresSchema,
  rating: singleLineTextSchema(20).nullable(),
  director: singleLineTextSchema(150).nullable(),
  cast: castSchema,
  releaseDate: releaseDateSchema.nullable(),
  trailerUrl: trailerUrlSchema.nullable(),
};

/* -------------------------------------------------------------------------- */
/* Params                                                                     */
/* -------------------------------------------------------------------------- */

/** Params of admin routes addressing a movie by ID, e.g. /api/admin/movies/:id. */
export const movieIdParamsSchema = z.strictObject({
  id: z.uuid(),
});

export type MovieIdParams = z.infer<typeof movieIdParamsSchema>;

/** Params of public routes addressing a movie by slug, e.g. /api/movies/:slug. */
export const movieSlugParamsSchema = z.strictObject({
  slug: slugSchema,
});

export type MovieSlugParams = z.infer<typeof movieSlugParamsSchema>;

/* -------------------------------------------------------------------------- */
/* Request bodies                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Body of POST /api/admin/movies. `title` and `durationMinutes` are required.
 * `slug` is generated from the title when omitted. `status` defaults to UPCOMING.
 * Visibility (`isActive`) and images are not set here: they have their own endpoints.
 */
export const movieCreateBodySchema = z.strictObject({
  title: movieFields.title,
  slug: movieFields.slug.optional(),
  synopsis: movieFields.synopsis.optional(),
  durationMinutes: movieFields.durationMinutes,
  language: movieFields.language.optional(),
  genres: movieFields.genres.default([]),
  rating: movieFields.rating.optional(),
  director: movieFields.director.optional(),
  cast: movieFields.cast.default([]),
  releaseDate: movieFields.releaseDate.optional(),
  trailerUrl: movieFields.trailerUrl.optional(),
  status: movieStatusSchema.default('UPCOMING'),
});

export type MovieCreateBody = z.infer<typeof movieCreateBodySchema>;
/** What a client may send (before defaults/transforms are applied). */
export type MovieCreateBodyInput = z.input<typeof movieCreateBodySchema>;

/**
 * Body of PATCH /api/admin/movies/:id. Any subset of the editable fields, at least one.
 * `null` clears an optional field. Status, visibility and images have their own endpoints.
 */
export const movieUpdateBodySchema = z
  .strictObject({
    title: movieFields.title.optional(),
    slug: movieFields.slug.optional(),
    synopsis: movieFields.synopsis.optional(),
    durationMinutes: movieFields.durationMinutes.optional(),
    language: movieFields.language.optional(),
    genres: movieFields.genres.optional(),
    rating: movieFields.rating.optional(),
    director: movieFields.director.optional(),
    cast: movieFields.cast.optional(),
    releaseDate: movieFields.releaseDate.optional(),
    trailerUrl: movieFields.trailerUrl.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one field to update',
  });

export type MovieUpdateBody = z.infer<typeof movieUpdateBodySchema>;
export type MovieUpdateBodyInput = z.input<typeof movieUpdateBodySchema>;

/** Body of the admin endpoint that changes a movie's status. */
export const movieStatusBodySchema = z.strictObject({
  status: movieStatusSchema,
});

export type MovieStatusBody = z.infer<typeof movieStatusBodySchema>;

/** Body of the admin endpoint that shows or hides a movie. */
export const movieActiveBodySchema = z.strictObject({
  isActive: z.boolean(),
});

export type MovieActiveBody = z.infer<typeof movieActiveBodySchema>;

/* -------------------------------------------------------------------------- */
/* Query strings                                                              */
/* -------------------------------------------------------------------------- */

export const ADMIN_MOVIE_SORT_FIELDS = ['updatedAt', 'createdAt', 'title', 'releaseDate'] as const;

/** Query of GET /api/admin/movies. All values arrive as strings and are converted here. */
export const adminMovieListQuerySchema = z.strictObject({
  /** Free-text search. Whitespace-only is treated as no search. */
  search: querySearchSchema.optional(),
  status: movieStatusSchema.optional(),
  /** Only the literal strings 'true' and 'false' are accepted. */
  isActive: queryBooleanSchema.optional(),
  /** Soft-deleted movies: hide them (default), include them, or show only them. */
  deleted: deletedFilterSchema.default('exclude'),
  page: pageQuerySchema,
  pageSize: pageSizeQuerySchema,
  sort: z.enum(ADMIN_MOVIE_SORT_FIELDS).default('updatedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type AdminMovieListQuery = z.infer<typeof adminMovieListQuerySchema>;
export type AdminMovieListQueryInput = z.input<typeof adminMovieListQuerySchema>;

/** Statuses the public site can list. ENDED movies are never listed publicly. */
export const publicMovieStatusSchema = movieStatusSchema.extract(['UPCOMING', 'NOW_SHOWING']);

export type PublicMovieStatus = z.infer<typeof publicMovieStatusSchema>;

/** Query of GET /api/movies. */
export const publicMovieListQuerySchema = z.strictObject({
  status: publicMovieStatusSchema.optional(),
});

export type PublicMovieListQuery = z.infer<typeof publicMovieListQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

const imageUrlSchema = z.url({ protocol: /^https$/ });

/**
 * A movie as shown on the public site. This is an explicit whitelist, built on its own
 * (not derived from adminMovieSchema) so new admin-only fields never leak by default.
 * Never add visibility, deletion, Cloudinary public IDs, timestamps or audit data here.
 */
export const publicMovieSchema = z.strictObject({
  id: z.uuid(),
  slug: slugSchema,
  title: z.string(),
  synopsis: z.string().nullable(),
  durationMinutes: z.number().int(),
  language: z.string().nullable(),
  genres: z.array(z.string()),
  rating: z.string().nullable(),
  director: z.string().nullable(),
  cast: z.array(z.string()),
  /** `YYYY-MM-DD` (a date only, no time zone). */
  releaseDate: calendarDateSchema.nullable(),
  trailerUrl: trailerUrlSchema.nullable(),
  status: movieStatusSchema,
  posterUrl: imageUrlSchema.nullable(),
  bannerUrl: imageUrlSchema.nullable(),
});

export type PublicMovie = z.infer<typeof publicMovieSchema>;

/** A movie as returned by admin endpoints: every column, timestamps as ISO 8601 strings. */
export const adminMovieSchema = z.strictObject({
  id: z.uuid(),
  slug: slugSchema,
  title: z.string(),
  synopsis: z.string().nullable(),
  durationMinutes: z.number().int(),
  language: z.string().nullable(),
  genres: z.array(z.string()),
  rating: z.string().nullable(),
  director: z.string().nullable(),
  cast: z.array(z.string()),
  /** `YYYY-MM-DD` (a date only, no time zone). */
  releaseDate: calendarDateSchema.nullable(),
  trailerUrl: trailerUrlSchema.nullable(),
  status: movieStatusSchema,
  posterUrl: imageUrlSchema.nullable(),
  posterPublicId: z.string().nullable(),
  bannerUrl: imageUrlSchema.nullable(),
  bannerPublicId: z.string().nullable(),
  isActive: z.boolean(),
  deletedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type AdminMovie = z.infer<typeof adminMovieSchema>;

/** Response of GET /api/movies. */
export const publicMovieListResponseSchema = z.strictObject({
  movies: z.array(publicMovieSchema),
});

export type PublicMovieListResponse = z.infer<typeof publicMovieListResponseSchema>;

/** Response of GET /api/movies/:slug. */
export const publicMovieResponseSchema = z.strictObject({
  movie: publicMovieSchema,
});

export type PublicMovieResponse = z.infer<typeof publicMovieResponseSchema>;

/** Response of GET /api/admin/movies. */
export const adminMovieListResponseSchema = z.strictObject({
  items: z.array(adminMovieSchema),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
  total: z.number().int().min(0),
});

export type AdminMovieListResponse = z.infer<typeof adminMovieListResponseSchema>;

/** Response of admin endpoints that return a single movie (get, create, update, status, active). */
export const adminMovieResponseSchema = z.strictObject({
  movie: adminMovieSchema,
});

export type AdminMovieResponse = z.infer<typeof adminMovieResponseSchema>;
