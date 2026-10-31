import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Building blocks                                                            */
/* -------------------------------------------------------------------------- */

/** Movie lifecycle status. Mirrors the `MovieStatus` enum in the Prisma schema. */
export const movieStatusSchema = z.enum(['UPCOMING', 'NOW_SHOWING', 'ENDED']);

export type MovieStatus = z.infer<typeof movieStatusSchema>;

/** URL slug: lowercase letters and digits in groups separated by single hyphens. */
export const slugSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, digits and single hyphens');

/** Calendar date as `YYYY-MM-DD`. Rejects impossible dates such as 2026-02-30. */
const calendarDateSchema = z.iso.date();

/** One query-string component, e.g. `t=30s`. Only URL-safe characters. */
const QUERY_PART = '[A-Za-z0-9_.~%=-]*';
/** YouTube video IDs are 11 characters from this alphabet. */
const VIDEO_ID = '[A-Za-z0-9_-]{11}';

/**
 * Accepted trailer URLs (https only, no ports, credentials or fragments):
 * - https://youtube.com/watch?v=ID, https://www.youtube.com/watch?v=ID, https://m.youtube.com/watch?v=ID
 *   (other query parameters may appear before or after `v`)
 * - https://youtu.be/ID (optionally with a query, e.g. `?si=...` from the share button)
 * The patterns are anchored, so lookalike hosts such as youtube.com.evil.com are rejected.
 */
const YOUTUBE_WATCH_URL = new RegExp(
  `^https://(?:(?:www|m)\\.)?youtube\\.com/watch\\?(?:${QUERY_PART}&)*v=${VIDEO_ID}(?:&${QUERY_PART})*$`,
);
const YOUTUBE_SHORT_URL = new RegExp(
  `^https://youtu\\.be/${VIDEO_ID}(?:\\?${QUERY_PART}(?:&${QUERY_PART})*)?$`,
);

/** HTTPS YouTube trailer link. See the patterns above for what is accepted. */
export const trailerUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((url) => YOUTUBE_WATCH_URL.test(url) || YOUTUBE_SHORT_URL.test(url), {
    message: 'Must be an https YouTube link (youtube.com/watch?v=... or youtu.be/...)',
  });

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

const genresSchema = z
  .array(z.string().trim().min(1).max(30))
  .max(10)
  .transform(dedupeCaseInsensitive);

const castSchema = z.array(z.string().trim().min(1).max(100)).max(30);

/**
 * Editable movie fields shared by create and update. Optional text columns are
 * nullable: send `null` (not an empty string) to leave them blank or clear them.
 */
const movieFields = {
  title: z.string().trim().min(1).max(150),
  slug: slugSchema,
  synopsis: z.string().trim().min(1).max(5000).nullable(),
  durationMinutes: z.number().int().min(1).max(600),
  language: z.string().trim().min(1).max(50).nullable(),
  genres: genresSchema,
  rating: z.string().trim().min(1).max(20).nullable(),
  director: z.string().trim().min(1).max(150).nullable(),
  cast: castSchema,
  releaseDate: calendarDateSchema.nullable(),
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

/** Positive integer from a query string. Digits only (no signs, decimals or exponents). */
function queryInt(min: number, max: number) {
  return z
    .string()
    .regex(/^\d{1,6}$/, 'Must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
}

export const ADMIN_MOVIE_SORT_FIELDS = ['updatedAt', 'createdAt', 'title', 'releaseDate'] as const;

/** Query of GET /api/admin/movies. All values arrive as strings and are converted here. */
export const adminMovieListQuerySchema = z.strictObject({
  /** Free-text search. Whitespace-only is treated as no search. */
  search: z
    .string()
    .trim()
    .max(100)
    .transform((value) => (value === '' ? undefined : value))
    .optional(),
  status: movieStatusSchema.optional(),
  /** Only the literal strings 'true' and 'false' are accepted. */
  isActive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  /** Soft-deleted movies: hide them (default), include them, or show only them. */
  deleted: z.enum(['exclude', 'include', 'only']).default('exclude'),
  page: queryInt(1, 999_999).default(1),
  pageSize: queryInt(1, 100).default(20),
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
