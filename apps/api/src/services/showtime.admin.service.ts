import {
  ERROR_CODES,
  normalizeShowtimeFormat,
  type AdminShowtime,
  type AdminShowtimeListQuery,
  type AdminShowtimeListResponse,
  type ShowtimeConflictDetail,
  type ShowtimeCreateBody,
} from '@sk-cinema/shared';
import type { Logger } from 'pino';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import type { MemoryCache } from '../lib/cache.js';
import { addDays, fromColomboDateTime, toColomboDate, toColomboTime } from '../lib/colomboTime.js';
import { AppError, notFound } from '../lib/errors.js';
import { lockMovieAndScreens } from '../lib/locks.js';
import {
  existingShowtimeWindow,
  findShowtimeConflicts,
  toShowtimeConflict,
  type ShowtimeOverlap,
  type ShowtimeSlot,
} from '../lib/showtimeOverlap.js';
import { writeAudit, type AuditActor } from './audit.service.js';
import { resolveBookingUrl } from './bmsLink.js';
import { invalidatePublicMovies } from './movie.public.service.js';
import { createSettingsService, type SettingsService } from './settings.service.js';

/*
 * Admin showtimes: create one, get one, list. T11 (bulk create) and T12 (update, delete, bulk
 * delete) build on the exports here: adminShowtimeSelect + toAdminShowtime for responses,
 * checkScheduleTargets for the movie/screen rules, findScreenConflicts for the overlap check
 * and showtimeConflictError for the 409.
 *
 * Times: stored as UTC instants; requests and responses carry the Colombo `date` + `time`
 * (lib/colomboTime.ts). Nothing here uses the server's time zone.
 */

const AUDIT_ENTITY = 'Showtime';

export const SHOWTIME_NOT_FOUND_MESSAGE = 'Showtime not found';
export const SHOWTIME_MOVIE_NOT_FOUND_MESSAGE = 'Movie not found';
export const SHOWTIME_MOVIE_DELETED_MESSAGE =
  'This movie is deleted. Restore it before adding showtimes.';
export const SHOWTIME_MOVIE_ENDED_MESSAGE =
  'This movie has ended. Change its status before adding showtimes.';
export const SHOWTIME_SCREEN_NOT_FOUND_MESSAGE = 'Screen not found';
export const SHOWTIME_SCREEN_DELETED_MESSAGE =
  'This screen is deleted. Restore it before adding showtimes.';
export const SHOWTIME_SCREEN_INACTIVE_MESSAGE =
  'This screen is hidden. Show it before adding showtimes.';
export const SHOWTIME_IN_PAST_MESSAGE = 'Choose a date and time in the future';
export const SHOWTIME_OVERLAP_MESSAGE = 'This showtime overlaps another showtime on this screen';
/**
 * The insert hit a foreign key (P2003): the movie or screen vanished after it was locked and
 * checked. Cannot happen on Postgres while the row locks are held; answered as a 409, not a 500.
 */
export const SHOWTIME_TARGET_CHANGED_MESSAGE =
  'The movie or screen was changed by someone else. Reload and try again.';

/** `reason` logged when a stored format cannot be normalised (the value is never logged). */
export const UNNORMALISABLE_FORMAT = 'unnormalisable_format';

const MS_PER_MINUTE = 60_000;

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

/** Everything toAdminShowtime needs: the showtime, its movie and its screen. */
export const adminShowtimeSelect = {
  id: true,
  startsAt: true,
  format: true,
  bookingUrlOverride: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
  movie: { select: { id: true, title: true, durationMinutes: true, status: true } },
  screen: { select: { id: true, name: true } },
} as const satisfies Prisma.ShowtimeSelect;

export type AdminShowtimeRow = Prisma.ShowtimeGetPayload<{ select: typeof adminShowtimeSelect }>;

/**
 * A stored format for a response: normalised (trimmed, uppercased) or `null` when it cannot be
 * (e.g. a manually inserted "2D/3D"). A `null` logs one warning with only the showtime ID and
 * the reason, never the stored value.
 */
export function formatForResponse(
  showtimeId: string,
  stored: string,
  logger: Pick<Logger, 'warn'>,
): string | null {
  const format = normalizeShowtimeFormat(stored);
  if (format === null) {
    logger.warn(
      { showtimeId, reason: UNNORMALISABLE_FORMAT },
      'Stored showtime format could not be normalised; returning no format',
    );
  }
  return format;
}

/**
 * A row (adminShowtimeSelect) as the admin response. `baseUrl` is the `bmsBaseUrl` setting,
 * read once per request (getBookingSettings), never per row. `bookingUrl` is the valid override
 * or the generated link (resolveBookingUrl logs, without the URL, when the override is invalid).
 */
export function toAdminShowtime(
  row: AdminShowtimeRow,
  baseUrl: string,
  logger: Pick<Logger, 'warn'>,
): AdminShowtime {
  return {
    id: row.id,
    movie: {
      id: row.movie.id,
      title: row.movie.title,
      durationMinutes: row.movie.durationMinutes,
      status: row.movie.status,
    },
    screen: { id: row.screen.id, name: row.screen.name },
    startsAt: row.startsAt.toISOString(),
    endsAt: new Date(
      row.startsAt.getTime() + row.movie.durationMinutes * MS_PER_MINUTE,
    ).toISOString(),
    colomboDate: toColomboDate(row.startsAt),
    time: toColomboTime(row.startsAt),
    format: formatForResponse(row.id, row.format, logger),
    bookingUrlOverride: row.bookingUrlOverride,
    bookingUrl: resolveBookingUrl(
      {
        showtimeId: row.id,
        bookingUrlOverride: row.bookingUrlOverride,
        baseUrl,
        startsAt: row.startsAt,
      },
      logger,
    ),
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// List query
// ---------------------------------------------------------------------------

/**
 * The `where` of the admin list, every filter combined with AND:
 * - `movieId` / `screenId`: equality;
 * - `deleted`: 'exclude' (default) live only, 'only' soft-deleted only, 'include' both;
 * - `from` / `to`: Colombo dates, inclusive: `[from 00:00, to + 1 day 00:00)` in Colombo;
 * - past showtimes (`startsAt <= now`) are left out unless `includePast`, whatever `from` says.
 */
export function adminShowtimeListWhere(
  query: AdminShowtimeListQuery,
  now: Date,
): Prisma.ShowtimeWhereInput {
  const where: Prisma.ShowtimeWhereInput = {};
  if (query.movieId !== undefined) where.movieId = query.movieId;
  if (query.screenId !== undefined) where.screenId = query.screenId;
  if (query.deleted === 'exclude') where.deletedAt = null;
  else if (query.deleted === 'only') where.deletedAt = { not: null };

  const startsAt: Prisma.DateTimeFilter = {};
  if (!query.includePast) startsAt.gt = now;
  if (query.from !== undefined) startsAt.gte = fromColomboDateTime(query.from, '00:00');
  if (query.to !== undefined) startsAt.lt = fromColomboDateTime(addDays(query.to, 1), '00:00');
  if (Object.keys(startsAt).length > 0) where.startsAt = startsAt;
  return where;
}

/** By start, then `id` as a unique tie-breaker so pages never overlap or skip rows. */
export const ADMIN_SHOWTIME_LIST_ORDER_BY = [
  { startsAt: 'asc' },
  { id: 'asc' },
] as const satisfies Prisma.ShowtimeOrderByWithRelationInput[];

// ---------------------------------------------------------------------------
// Scheduling rules (create now; bulk create and update in T11 / T12)
// ---------------------------------------------------------------------------

/** A 404 / 409 / 400 about one body field, shaped like validation details. */
function fieldError(status: 400 | 404 | 409, field: string, message: string): AppError {
  const code =
    status === 400
      ? ERROR_CODES.VALIDATION_ERROR
      : status === 404
        ? ERROR_CODES.NOT_FOUND
        : ERROR_CODES.CONFLICT;
  return new AppError(status, code, message, [{ path: ['body', field], message }]);
}

/** The movie fields a showtime write depends on. */
export interface ScheduledMovie {
  id: string;
  title: string;
  durationMinutes: number;
}

/** The movie and screen of a showtime write, checked (see checkScheduleTargets). */
export interface ScheduleTargets {
  movie: ScheduledMovie;
  screen: { id: string; name: string };
}

/**
 * Locks the movie, then the screen (lib/locks.ts order), then reads and checks both. Must run
 * inside the write's transaction, before any read the overlap check depends on.
 * - Movie: 404 unknown; 409 soft-deleted; 409 ENDED. UPCOMING and NOW_SHOWING are allowed,
 *   hidden (isActive=false) ones too: admins schedule ahead.
 * - Screen: 404 unknown; 409 soft-deleted; 409 hidden.
 * Every error has `details: [{ path: ['body', 'movieId' | 'screenId'], message }]`.
 */
export async function checkScheduleTargets(
  tx: Prisma.TransactionClient,
  movieId: string,
  screenId: string,
): Promise<ScheduleTargets> {
  const locks = await lockMovieAndScreens(tx, movieId, [screenId]);
  const movie = locks.movieFound
    ? await tx.movie.findUnique({
        where: { id: movieId },
        select: { id: true, title: true, durationMinutes: true, status: true, deletedAt: true },
      })
    : null;
  if (movie === null) throw fieldError(404, 'movieId', SHOWTIME_MOVIE_NOT_FOUND_MESSAGE);
  if (movie.deletedAt !== null) throw fieldError(409, 'movieId', SHOWTIME_MOVIE_DELETED_MESSAGE);
  if (movie.status === 'ENDED') throw fieldError(409, 'movieId', SHOWTIME_MOVIE_ENDED_MESSAGE);

  const screen = locks.screensFound.has(screenId.toLowerCase())
    ? await tx.screen.findUnique({
        where: { id: screenId },
        select: { id: true, name: true, isActive: true, deletedAt: true },
      })
    : null;
  if (screen === null) throw fieldError(404, 'screenId', SHOWTIME_SCREEN_NOT_FOUND_MESSAGE);
  if (screen.deletedAt !== null) {
    throw fieldError(409, 'screenId', SHOWTIME_SCREEN_DELETED_MESSAGE);
  }
  if (!screen.isActive) throw fieldError(409, 'screenId', SHOWTIME_SCREEN_INACTIVE_MESSAGE);

  return {
    movie: { id: movie.id, title: movie.title, durationMinutes: movie.durationMinutes },
    screen: { id: screen.id, name: screen.name },
  };
}

/** A show to check for overlaps, with what the 409 details need to point at it. */
export interface ShowtimeCandidate extends ShowtimeSlot {
  /** The request field to blame, e.g. ['body', 'time'] or ['body', 'times', 2]. */
  path: (string | number)[];
  /** The Colombo date and time as requested. */
  requested: { date: string; time: string };
}

/**
 * Every clash of `candidates` with the saved, non-deleted showtimes on their screens (and with
 * each other). Reads inside `tx`, after the locks. Every live showtime counts, whatever its
 * movie's status, visibility or deletion. Existing shows that clash with each other under the
 * current gap are never reported: a gap change only applies to shows created or moved later.
 */
export async function findScreenConflicts<C extends ShowtimeCandidate>(
  tx: Prisma.TransactionClient,
  candidates: readonly C[],
  gapMinutes: number,
): Promise<ShowtimeOverlap<C>[]> {
  const window = existingShowtimeWindow({ candidates, gapMinutes });
  if (window === null) return [];
  const screenIds = [...new Set(candidates.map((c) => c.screenId))];
  const rows = await tx.showtime.findMany({
    where: {
      screenId: { in: screenIds },
      deletedAt: null,
      startsAt: { gte: window.from, lt: window.to },
    },
    select: {
      id: true,
      screenId: true,
      startsAt: true,
      movie: { select: { title: true, durationMinutes: true } },
    },
  });
  const existing: ShowtimeSlot[] = rows.map((row) => ({
    showtimeId: row.id,
    screenId: row.screenId,
    movieTitle: row.movie.title,
    startsAt: row.startsAt,
    durationMinutes: row.movie.durationMinutes,
  }));
  return findShowtimeConflicts({ candidates, existing, gapMinutes });
}

/**
 * The 409 CONFLICT for overlaps (shared showtimeConflictErrorSchema): one detail per clash,
 * each with the candidate's `path` and `requested` date/time and the show it overlaps.
 */
export function showtimeConflictError(
  overlaps: readonly ShowtimeOverlap<ShowtimeCandidate>[],
  gapMinutes: number,
): AppError {
  const details: ShowtimeConflictDetail[] = overlaps.map(({ candidate, conflict }) => {
    const span = `${toColomboTime(conflict.startsAt)}–${toColomboTime(conflict.endsAt)}`;
    const gap =
      gapMinutes > 0 ? `, counting the ${String(gapMinutes)}-minute gap between shows` : '';
    return {
      path: [...candidate.path],
      message: `Overlaps "${conflict.movieTitle}" (${span})${gap}`,
      requested: { ...candidate.requested },
      conflict: toShowtimeConflict(conflict),
    };
  });
  return new AppError(409, ERROR_CODES.CONFLICT, SHOWTIME_OVERLAP_MESSAGE, details);
}

const isForeignKeyError = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';

/** Thrown inside the create transaction when the insert hit a foreign key (see message). */
class TargetGone extends Error {
  constructor() {
    super('Movie or screen gone before the insert');
    this.name = 'TargetGone';
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type ShowtimeAdminDb = Pick<
  PrismaClient,
  'showtime' | 'movie' | 'screen' | 'setting' | 'auditLog' | '$transaction'
>;

export interface ShowtimeAdminServiceDeps {
  db: ShowtimeAdminDb;
  /** Settings outside transactions (reads). Writes read the settings through their `tx`. */
  settings: Pick<SettingsService, 'getBookingSettings'>;
  /**
   * The app's one cache. Public showtime responses are cached under the public movies prefix,
   * so they are dropped after each committed showtime write.
   */
  cache: Pick<MemoryCache, 'invalidatePrefix'>;
  /** Warnings only: a showtime ID and a reason, never a URL or a stored value. */
  logger: Pick<Logger, 'warn'>;
  /** Injectable clock for tests ("in the future", list default). Defaults to the current time. */
  now?: () => Date;
}

export function createShowtimeAdminService({
  db,
  settings,
  cache,
  logger,
  now = () => new Date(),
}: ShowtimeAdminServiceDeps) {
  /** Settings read through a transaction client, so the write sees them under its locks. */
  const settingsIn = (tx: Prisma.TransactionClient) => createSettingsService({ db: tx, logger });

  return {
    /**
     * Creates one showtime at a Colombo date + time, in one transaction:
     * 1. lock the movie, then the screen, and check both (checkScheduleTargets);
     * 2. the start must be after now (400 on body.time);
     * 3. read the booking settings, then the overlap check against the live showtimes on the
     *    screen (409 with conflict details);
     * 4. insert, then the CREATE audit row;
     * then, only after the commit, the public movie cache is dropped.
     */
    async create(input: ShowtimeCreateBody, actor: AuditActor): Promise<AdminShowtime> {
      let outcome: { row: AdminShowtimeRow; baseUrl: string };
      try {
        outcome = await db.$transaction(async (tx) => {
          const { movie, screen } = await checkScheduleTargets(tx, input.movieId, input.screenId);

          const startsAt = fromColomboDateTime(input.date, input.time);
          if (startsAt.getTime() <= now().getTime()) {
            throw fieldError(400, 'time', SHOWTIME_IN_PAST_MESSAGE);
          }

          const booking = await settingsIn(tx).getBookingSettings();
          const candidate: ShowtimeCandidate = {
            showtimeId: null,
            screenId: screen.id,
            movieTitle: movie.title,
            startsAt,
            durationMinutes: movie.durationMinutes,
            path: ['body', 'time'],
            requested: { date: input.date, time: input.time },
          };
          const overlaps = await findScreenConflicts(tx, [candidate], booking.showGapMinutes);
          if (overlaps.length > 0) {
            throw showtimeConflictError(overlaps, booking.showGapMinutes);
          }

          let row: AdminShowtimeRow;
          try {
            row = await tx.showtime.create({
              data: {
                movieId: movie.id,
                screenId: screen.id,
                startsAt,
                // Omitted: the database default ("2D").
                ...(input.format !== undefined && { format: input.format }),
                bookingUrlOverride: input.bookingUrlOverride ?? null,
              },
              select: adminShowtimeSelect,
            });
          } catch (error) {
            if (isForeignKeyError(error)) throw new TargetGone();
            throw error;
          }

          await writeAudit(tx, {
            action: 'CREATE',
            adminId: actor.adminId,
            entity: AUDIT_ENTITY,
            entityId: row.id,
            // Admin configuration, stored in the audit table (never logged).
            details: {
              movieId: movie.id,
              screenId: screen.id,
              startsAt: row.startsAt.toISOString(),
              format: row.format,
              bookingUrlOverride: row.bookingUrlOverride,
            },
            ipAddress: actor.ipAddress,
            userAgent: actor.userAgent,
          });
          return { row, baseUrl: booking.bmsBaseUrl };
        });
      } catch (error) {
        if (error instanceof TargetGone) {
          throw new AppError(409, ERROR_CODES.CONFLICT, SHOWTIME_TARGET_CHANGED_MESSAGE);
        }
        throw error;
      }

      // Only after the commit, so no request can re-cache the public pages without it.
      invalidatePublicMovies(cache);
      return toAdminShowtime(outcome.row, outcome.baseUrl, logger);
    },

    /**
     * One page of showtimes for the admin table (see adminShowtimeListWhere and
     * ADMIN_SHOWTIME_LIST_ORDER_BY). Never cached. Page, count and the booking settings run in
     * parallel, not in a transaction, like the movie and screen lists.
     */
    async list(query: AdminShowtimeListQuery): Promise<AdminShowtimeListResponse> {
      const where = adminShowtimeListWhere(query, now());
      const [rows, total, booking] = await Promise.all([
        db.showtime.findMany({
          where,
          orderBy: [...ADMIN_SHOWTIME_LIST_ORDER_BY],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          select: adminShowtimeSelect,
        }),
        db.showtime.count({ where }),
        settings.getBookingSettings(),
      ]);
      return {
        items: rows.map((row) => toAdminShowtime(row, booking.bmsBaseUrl, logger)),
        page: query.page,
        pageSize: query.pageSize,
        total,
      };
    },

    /** Any showtime by id, past and soft-deleted ones included. 404 when there is none. */
    async getById(id: string): Promise<AdminShowtime> {
      const [row, booking] = await Promise.all([
        db.showtime.findUnique({ where: { id }, select: adminShowtimeSelect }),
        settings.getBookingSettings(),
      ]);
      if (row === null) throw notFound(SHOWTIME_NOT_FOUND_MESSAGE);
      return toAdminShowtime(row, booking.bmsBaseUrl, logger);
    },
  };
}

export type ShowtimeAdminService = ReturnType<typeof createShowtimeAdminService>;
