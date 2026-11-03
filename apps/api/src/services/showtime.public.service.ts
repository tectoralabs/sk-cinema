import type { PublicShowtime } from '@sk-cinema/shared';
import type { Logger } from 'pino';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import type { MemoryCache } from '../lib/cache.js';
import { addDays, fromColomboDateTime, toColomboDate, toColomboTime } from '../lib/colomboTime.js';
import { notFound } from '../lib/errors.js';
import { formatForResponse } from '../lib/showtimeFormat.js';
import { resolveBookingUrl } from './bmsLink.js';
import {
  PUBLIC_MOVIE_NOT_FOUND_MESSAGE,
  PUBLIC_MOVIES_CACHE_PREFIX,
  PUBLIC_MOVIES_TTL_MS,
  VISIBLE_MOVIE_WHERE,
} from './movie.public.service.js';
import type { SettingsService } from './settings.service.js';

/*
 * Public showtimes of one movie: the Colombo dates that have shows, and the shows of one date.
 *
 * Both endpoints read one cache entry per movie, holding its upcoming shows with their booking
 * links already resolved. It lives under the public movies prefix, so every admin write that
 * calls invalidatePublicMovies clears it. The entry is filtered against the clock on EVERY
 * request, after it is read, so a show disappears the moment it starts, however old the entry.
 * That guarantee only holds if nothing downstream keeps the response: see noStore in
 * routes/showtime.public.routes.ts.
 */

/**
 * How far ahead the public site lists shows: today in Colombo plus this many days, whole days
 * only. A show further ahead is not public yet; it appears as its date comes into range.
 */
export const PUBLIC_SHOWTIME_HORIZON_DAYS = 60;

/**
 * Most shows one movie's cache entry holds, soonest first. Shows beyond this are not public yet
 * (a warning is logged when it is reached); they appear as earlier shows start and the entry is
 * refilled. The last date in the entry may then be listed only in part.
 */
export const PUBLIC_SHOWTIME_MAX_ROWS = 500;

/** `reason` logged when a movie has more upcoming shows than PUBLIC_SHOWTIME_MAX_ROWS. */
export const PUBLIC_SHOWTIME_LIMIT_REACHED = 'public_showtime_limit_reached';

/** The cache key of a movie's upcoming shows. `movieId` in lowercase. */
export const publicShowtimesCacheKey = (movieId: string) =>
  `${PUBLIC_MOVIES_CACHE_PREFIX}showtimes:${movieId}`;

/** Only these columns are loaded. bookingUrlOverride is resolved here and never sent. */
const publicShowtimeSelect = {
  id: true,
  startsAt: true,
  format: true,
  bookingUrlOverride: true,
  screen: { select: { name: true } },
} as const satisfies Prisma.ShowtimeSelect;

/** One show in a cache entry: the response item, plus what each request filters and groups by. */
interface CachedShowtime {
  startsAtMs: number;
  /** Calendar date in Colombo: a 00:30 show belongs to the date it starts on there. */
  date: string;
  item: PublicShowtime;
}

export type PublicShowtimeDb = Pick<PrismaClient, 'movie' | 'showtime'>;

export interface PublicShowtimeServiceDeps {
  db: PublicShowtimeDb;
  /** Read once per cache fill, for the `bmsBaseUrl` the generated links use. */
  settings: Pick<SettingsService, 'getBookingSettings'>;
  /** The app's one cache, the same instance the admin services invalidate. */
  cache: MemoryCache;
  /** Warnings only: an ID and a reason, never a URL or a stored value. */
  logger: Pick<Logger, 'warn'>;
  /** Injectable clock for tests. Defaults to the current time. */
  now?: () => Date;
}

/** Read-only showtime queries for the public site. */
export function createPublicShowtimeService({
  db,
  settings,
  cache,
  logger,
  now = () => new Date(),
}: PublicShowtimeServiceDeps) {
  /**
   * One cache fill. Throws a 404 for an unknown, inactive or deleted movie, which is not cached.
   * An ENDED movie caches an empty list without further queries. A show on a hidden or deleted
   * screen is never public.
   */
  async function loadUpcoming(movieId: string): Promise<CachedShowtime[]> {
    const movie = await db.movie.findUnique({
      where: { id: movieId, ...VISIBLE_MOVIE_WHERE },
      select: { status: true },
    });
    if (movie === null) throw notFound(PUBLIC_MOVIE_NOT_FOUND_MESSAGE);
    if (movie.status === 'ENDED') return [];

    const at = now();
    const lastDate = addDays(toColomboDate(at), PUBLIC_SHOWTIME_HORIZON_DAYS);
    const rows = await db.showtime.findMany({
      where: {
        movieId,
        deletedAt: null,
        startsAt: { gt: at, lt: fromColomboDateTime(addDays(lastDate, 1), '00:00') },
        movie: { is: VISIBLE_MOVIE_WHERE },
        screen: { is: { deletedAt: null, isActive: true } },
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: PUBLIC_SHOWTIME_MAX_ROWS,
      select: publicShowtimeSelect,
    });
    if (rows.length === PUBLIC_SHOWTIME_MAX_ROWS) {
      logger.warn(
        { movieId, reason: PUBLIC_SHOWTIME_LIMIT_REACHED },
        'Movie has more upcoming showtimes than the public limit; listing the soonest only',
      );
    }

    const { bmsBaseUrl } = await settings.getBookingSettings();
    return rows.map((row) => ({
      startsAtMs: row.startsAt.getTime(),
      date: toColomboDate(row.startsAt),
      item: {
        id: row.id,
        startsAt: row.startsAt.toISOString(),
        time: toColomboTime(row.startsAt),
        format: formatForResponse(row.id, row.format, logger),
        screen: { name: row.screen.name },
        bookingUrl: resolveBookingUrl(
          {
            showtimeId: row.id,
            bookingUrlOverride: row.bookingUrlOverride,
            baseUrl: bmsBaseUrl,
            startsAt: row.startsAt,
          },
          logger,
        ),
      },
    }));
  }

  /**
   * The movie's shows that have not started, by start time. The clock is read after the cache,
   * so a show that starts while its entry is cached, or during a slow fill, is left out.
   * UUIDs are case-insensitive: lowercased so that one movie has one cache entry.
   */
  async function upcoming(id: string): Promise<CachedShowtime[]> {
    const movieId = id.toLowerCase();
    const shows = await cache.getOrSet(publicShowtimesCacheKey(movieId), PUBLIC_MOVIES_TTL_MS, () =>
      loadUpcoming(movieId),
    );
    const nowMs = now().getTime();
    return shows.filter((show) => show.startsAtMs > nowMs);
  }

  return {
    /** The Colombo dates with at least one show that has not started, ascending. */
    async listDates(movieId: string): Promise<string[]> {
      const shows = await upcoming(movieId);
      return [...new Set(shows.map((show) => show.date))];
    },

    /** The shows of one Colombo date that have not started. Empty for any other date. */
    async listForDate(movieId: string, date: string): Promise<PublicShowtime[]> {
      const shows = await upcoming(movieId);
      return shows.filter((show) => show.date === date).map((show) => show.item);
    },
  };
}

export type PublicShowtimeService = ReturnType<typeof createPublicShowtimeService>;
