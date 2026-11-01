import type { PublicMovie, PublicMovieStatus } from '@sk-cinema/shared';
import type { Movie, Prisma, PrismaClient } from '../generated/prisma/client.js';
import type { MemoryCache } from '../lib/cache.js';
import { notFound } from '../lib/errors.js';

/**
 * Every public movie cache key starts with this. Admin writes that change anything a visitor
 * can see (create, update, status, visibility, delete, images) must call
 * `invalidatePublicMovies(cache)` after the write commits.
 */
export const PUBLIC_MOVIES_CACHE_PREFIX = 'movies:public:';
export const PUBLIC_MOVIES_TTL_MS = 5 * 60_000;
/** Most movies GET /api/movies returns. */
export const PUBLIC_MOVIE_LIST_LIMIT = 100;

const listCacheKey = (status: PublicMovieStatus | undefined) =>
  `${PUBLIC_MOVIES_CACHE_PREFIX}list:${status ?? 'all'}`;
const slugCacheKey = (slug: string) => `${PUBLIC_MOVIES_CACHE_PREFIX}slug:${slug}`;

/** Drops every cached public movie response (lists and details). */
export function invalidatePublicMovies(cache: Pick<MemoryCache, 'invalidatePrefix'>): void {
  cache.invalidatePrefix(PUBLIC_MOVIES_CACHE_PREFIX);
}

/** Only these columns are loaded: admin-only columns never leave the database. */
const publicMovieSelect = {
  id: true,
  slug: true,
  title: true,
  synopsis: true,
  durationMinutes: true,
  language: true,
  genres: true,
  rating: true,
  director: true,
  cast: true,
  releaseDate: true,
  trailerUrl: true,
  status: true,
  posterUrl: true,
  bannerUrl: true,
} as const satisfies Prisma.MovieSelect;

type PublicMovieRow = Pick<Movie, keyof typeof publicMovieSelect>;

/** What the public may ever see: active and not soft-deleted. Applied to every query here. */
const visible = { isActive: true, deletedAt: null } as const satisfies Prisma.MovieWhereInput;

/**
 * Per-status list order. NOW_SHOWING: newest release first. UPCOMING: soonest release first.
 * Undated movies go last in both. Then title, then id so the order is fully deterministic.
 */
const LIST_ORDER = {
  NOW_SHOWING: [{ releaseDate: { sort: 'desc', nulls: 'last' } }, { title: 'asc' }, { id: 'asc' }],
  UPCOMING: [{ releaseDate: { sort: 'asc', nulls: 'last' } }, { title: 'asc' }, { id: 'asc' }],
} as const satisfies Record<PublicMovieStatus, Prisma.MovieOrderByWithRelationInput[]>;

/** The default list: now showing first, then upcoming. ENDED is never listed. */
const DEFAULT_LIST_STATUSES = ['NOW_SHOWING', 'UPCOMING'] as const satisfies PublicMovieStatus[];

/** `@db.Date` arrives as a Date at UTC midnight; read it back with UTC getters (no zone shift). */
export function formatDateOnly(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Field by field, so a column added to the select can never reach the public by accident. */
function toPublicMovie(row: PublicMovieRow): PublicMovie {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    synopsis: row.synopsis,
    durationMinutes: row.durationMinutes,
    language: row.language,
    genres: [...row.genres],
    rating: row.rating,
    director: row.director,
    cast: [...row.cast],
    releaseDate: row.releaseDate === null ? null : formatDateOnly(row.releaseDate),
    trailerUrl: row.trailerUrl,
    status: row.status,
    posterUrl: row.posterUrl,
    bannerUrl: row.bannerUrl,
  };
}

export type PublicMovieDb = Pick<PrismaClient, 'movie'>;

export interface PublicMovieServiceDeps {
  db: PublicMovieDb;
  cache: MemoryCache;
}

/** Read-only movie queries for the public site. Results are cached for PUBLIC_MOVIES_TTL_MS. */
export function createPublicMovieService({ db, cache }: PublicMovieServiceDeps) {
  async function findByStatus(status: PublicMovieStatus): Promise<PublicMovie[]> {
    const rows = await db.movie.findMany({
      where: { ...visible, status },
      orderBy: [...LIST_ORDER[status]],
      take: PUBLIC_MOVIE_LIST_LIMIT,
      select: publicMovieSelect,
    });
    return rows.map(toPublicMovie);
  }

  /**
   * One status: one query. No status: one query per status (Postgres orders the enum
   * UPCOMING < NOW_SHOWING, and the two groups sort their release dates in opposite
   * directions, which a single ORDER BY can't express), concatenated in group order and capped.
   */
  async function loadList(status: PublicMovieStatus | undefined): Promise<PublicMovie[]> {
    if (status !== undefined) return findByStatus(status);
    const groups = await Promise.all(DEFAULT_LIST_STATUSES.map(findByStatus));
    return groups.flat().slice(0, PUBLIC_MOVIE_LIST_LIMIT);
  }

  return {
    /** Visible movies, optionally of one status. Without a status: NOW_SHOWING then UPCOMING. */
    list(status: PublicMovieStatus | undefined): Promise<PublicMovie[]> {
      return cache.getOrSet(listCacheKey(status), PUBLIC_MOVIES_TTL_MS, () => loadList(status));
    },

    /**
     * A visible movie of any status (ENDED included, so old links keep working).
     * Throws a 404 for unknown, inactive and deleted movies alike; misses are not cached
     * (a failed load never is).
     */
    getBySlug(slug: string): Promise<PublicMovie> {
      return cache.getOrSet(slugCacheKey(slug), PUBLIC_MOVIES_TTL_MS, async () => {
        const row = await db.movie.findUnique({
          where: { slug, ...visible },
          select: publicMovieSelect,
        });
        if (!row) throw notFound('Movie not found');
        return toPublicMovie(row);
      });
    },
  };
}

export type PublicMovieService = ReturnType<typeof createPublicMovieService>;
