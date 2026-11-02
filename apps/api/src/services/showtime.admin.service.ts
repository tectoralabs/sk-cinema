import { randomUUID } from 'node:crypto';
import {
  ERROR_CODES,
  normalizeShowtimeFormat,
  SHOWTIME_BULK_MAX_DAYS,
  SHOWTIME_BULK_MAX_DETAILS,
  type AdminShowtime,
  type AdminShowtimeListQuery,
  type AdminShowtimeListResponse,
  type ShowtimeBulkCreateBody,
  type ShowtimeBulkCreateResponse,
  type ShowtimeBulkDeleteBody,
  type ShowtimeBulkDeleteResponse,
  type ShowtimeConflictDetail,
  type ShowtimeCreateBody,
  type ShowtimePastSlotDetail,
  type ShowtimeUpdateBody,
} from '@sk-cinema/shared';
import type { Logger } from 'pino';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import type { MemoryCache } from '../lib/cache.js';
import { addDays, fromColomboDateTime, toColomboDate, toColomboTime } from '../lib/colomboTime.js';
import { AppError, notFound } from '../lib/errors.js';
import { lockMovieAndScreens, type MovieAndScreenLocks } from '../lib/locks.js';
import { formatForResponse } from '../lib/showtimeFormat.js';
import {
  existingShowtimeWindow,
  findShowtimeConflicts,
  toShowtimeConflict,
  type ShowtimeOverlap,
  type ShowtimeSlot,
} from '../lib/showtimeOverlap.js';
import { isRecordNotFound } from './adminGuards.js';
import { writeAudit, writeAuditMany, type AuditActor } from './audit.service.js';
import { resolveBookingUrl } from './bmsLink.js';
import { invalidatePublicMovies } from './movie.public.service.js';
import { createSettingsService, type SettingsService } from './settings.service.js';

/*
 * Admin showtimes: create one, bulk create, get one, list, update, soft delete, bulk soft
 * delete. Shared pieces: adminShowtimeSelect + toAdminShowtime for responses,
 * checkScheduleTargets / checkLockedScheduleTargets for the movie/screen rules,
 * findScreenConflicts for the overlap check and showtimeConflictError for the 409.
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
/** Bulk create: `details` message of one slot at or before now. */
export const SHOWTIME_SLOT_IN_PAST_MESSAGE = 'This date and time is in the past';

/** Bulk create 400 message: how many of the requested slots are at or before now (all of them). */
export function showtimeBulkPastMessage(pastCount: number): string {
  return pastCount === 1
    ? '1 of the requested showtimes is in the past. Choose dates and times in the future.'
    : `${String(pastCount)} of the requested showtimes are in the past. Choose dates and times in the future.`;
}

/**
 * Bulk create 409 message: how many requested slots clash (each counted once, whatever the
 * number of shows it overlaps), plus the number of clashes when `details` had to be cut.
 */
export function showtimeBulkOverlapMessage(slotCount: number, conflictCount: number): string {
  const slots =
    slotCount === 1
      ? '1 of the requested showtimes overlaps other showtimes on this screen'
      : `${String(slotCount)} of the requested showtimes overlap other showtimes on this screen`;
  return conflictCount > SHOWTIME_BULK_MAX_DETAILS
    ? `${slots}. Showing the first ${String(SHOWTIME_BULK_MAX_DETAILS)} of ${String(conflictCount)} conflicts.`
    : slots;
}
/**
 * The insert hit a foreign key (P2003): the movie or screen vanished after it was locked and
 * checked. Cannot happen on Postgres while the row locks are held; answered as a 409, not a 500.
 */
export const SHOWTIME_TARGET_CHANGED_MESSAGE =
  'The movie or screen was changed by someone else. Reload and try again.';

/** PATCH /:id on a soft-deleted showtime (D9: deleted showtimes are never restored or edited). */
export const SHOWTIME_DELETED_MESSAGE = "This showtime is deleted and can't be changed";
/** PATCH /:id on a showtime whose start is at or before now (D8). */
export const SHOWTIME_STARTED_MESSAGE = "This showtime has already started and can't be changed";
/** DELETE /:id on a showtime that is already soft-deleted. */
export const SHOWTIME_ALREADY_DELETED_MESSAGE = 'Showtime is already deleted';
/**
 * The showtime moved to another screen (or its write matched no row) between our first read
 * and our write. Never expected under the movie lock; answered as a 409, not a 500.
 */
export const SHOWTIME_CHANGED_MESSAGE =
  'The showtime was changed by someone else. Reload and try again.';
/** Update that moves a show: the movie / target screen rules (see MOVE_TARGET_MESSAGES). */
export const SHOWTIME_MOVE_MOVIE_DELETED_MESSAGE =
  'This movie is deleted. Restore it before moving its showtimes.';
export const SHOWTIME_MOVE_MOVIE_ENDED_MESSAGE =
  'This movie has ended. Change its status before moving its showtimes.';
export const SHOWTIME_MOVE_SCREEN_DELETED_MESSAGE =
  'This screen is deleted. Restore it before moving showtimes to it.';
export const SHOWTIME_MOVE_SCREEN_INACTIVE_MESSAGE =
  'This screen is hidden. Show it before moving showtimes to it.';
/** Bulk delete: `details` message of an ID with no showtime. */
export const SHOWTIME_BULK_DELETE_UNKNOWN_ID_MESSAGE = 'Showtime not found';
/** Bulk delete: `details` message of an ID whose showtime is already soft-deleted. */
export const SHOWTIME_BULK_DELETE_DELETED_ID_MESSAGE = 'This showtime is already deleted';
/** Bulk delete: the conditional update missed rows that were live when read (a race). */
export const SHOWTIME_BULK_DELETE_CHANGED_MESSAGE =
  'Some of the selected showtimes were changed by someone else. Reload and try again.';

/** Bulk delete 404 message: how many of the IDs have no showtime (all listed in `details`). */
export function showtimeBulkDeleteNotFoundMessage(count: number): string {
  return count === 1
    ? '1 of the selected showtimes was not found. Reload and try again.'
    : `${String(count)} of the selected showtimes were not found. Reload and try again.`;
}

/** Bulk delete 409 message: how many of the IDs are already soft-deleted (all listed). */
export function showtimeBulkDeleteAlreadyDeletedMessage(count: number): string {
  return count === 1
    ? '1 of the selected showtimes is already deleted. Reload and try again.'
    : `${String(count)} of the selected showtimes are already deleted. Reload and try again.`;
}

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
// Scheduling rules (create, bulk create and update)
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

/** The 409 messages of the movie / screen rules (see checkLockedScheduleTargets). */
export interface ScheduleTargetMessages {
  movieDeleted: string;
  movieEnded: string;
  screenDeleted: string;
  screenInactive: string;
}

/** Create and bulk create: "before adding showtimes". */
export const CREATE_TARGET_MESSAGES: ScheduleTargetMessages = {
  movieDeleted: SHOWTIME_MOVIE_DELETED_MESSAGE,
  movieEnded: SHOWTIME_MOVIE_ENDED_MESSAGE,
  screenDeleted: SHOWTIME_SCREEN_DELETED_MESSAGE,
  screenInactive: SHOWTIME_SCREEN_INACTIVE_MESSAGE,
};

/** Update that moves a show (new start or screen): "before moving ...". */
export const MOVE_TARGET_MESSAGES: ScheduleTargetMessages = {
  movieDeleted: SHOWTIME_MOVE_MOVIE_DELETED_MESSAGE,
  movieEnded: SHOWTIME_MOVE_MOVIE_ENDED_MESSAGE,
  screenDeleted: SHOWTIME_MOVE_SCREEN_DELETED_MESSAGE,
  screenInactive: SHOWTIME_MOVE_SCREEN_INACTIVE_MESSAGE,
};

export interface ScheduleTargetOptions {
  messages?: ScheduleTargetMessages;
  /**
   * The movie is a request body field (create, bulk create): its errors get
   * `details: [{ path: ['body', 'movieId'], message }]`. False for an update, whose body has no
   * movieId: the movie errors then have no `details`. Default true.
   */
  movieInBody?: boolean;
}

/**
 * Reads and checks the movie and the screen of a showtime write whose rows are ALREADY locked
 * (`locks` is what lockMovieAndScreens returned; the screen must be among the locked ones).
 * - Movie: 404 unknown; 409 soft-deleted; 409 ENDED. UPCOMING and NOW_SHOWING are allowed,
 *   hidden (isActive=false) ones too: admins schedule ahead.
 * - Screen: 404 unknown; 409 soft-deleted; 409 hidden.
 * Screen errors have `details: [{ path: ['body', 'screenId'], message }]`; movie errors the
 * same on 'movieId' unless `movieInBody` is false (no details).
 */
export async function checkLockedScheduleTargets(
  tx: Prisma.TransactionClient,
  movieId: string,
  screenId: string,
  locks: MovieAndScreenLocks,
  { messages = CREATE_TARGET_MESSAGES, movieInBody = true }: ScheduleTargetOptions = {},
): Promise<ScheduleTargets> {
  const movieError = (status: 404 | 409, message: string) =>
    movieInBody
      ? fieldError(status, 'movieId', message)
      : new AppError(
          status,
          status === 404 ? ERROR_CODES.NOT_FOUND : ERROR_CODES.CONFLICT,
          message,
        );

  const movie = locks.movieFound
    ? await tx.movie.findUnique({
        where: { id: movieId },
        select: { id: true, title: true, durationMinutes: true, status: true, deletedAt: true },
      })
    : null;
  if (movie === null) throw movieError(404, SHOWTIME_MOVIE_NOT_FOUND_MESSAGE);
  if (movie.deletedAt !== null) throw movieError(409, messages.movieDeleted);
  if (movie.status === 'ENDED') throw movieError(409, messages.movieEnded);

  const screen = locks.screensFound.has(screenId.toLowerCase())
    ? await tx.screen.findUnique({
        where: { id: screenId },
        select: { id: true, name: true, isActive: true, deletedAt: true },
      })
    : null;
  if (screen === null) throw fieldError(404, 'screenId', SHOWTIME_SCREEN_NOT_FOUND_MESSAGE);
  if (screen.deletedAt !== null) throw fieldError(409, 'screenId', messages.screenDeleted);
  if (!screen.isActive) throw fieldError(409, 'screenId', messages.screenInactive);

  return {
    movie: { id: movie.id, title: movie.title, durationMinutes: movie.durationMinutes },
    screen: { id: screen.id, name: screen.name },
  };
}

/**
 * Locks the movie, then the screen (lib/locks.ts order), then reads and checks both
 * (checkLockedScheduleTargets, create messages). Must run inside the write's transaction,
 * before any read the overlap check depends on.
 */
export async function checkScheduleTargets(
  tx: Prisma.TransactionClient,
  movieId: string,
  screenId: string,
): Promise<ScheduleTargets> {
  const locks = await lockMovieAndScreens(tx, movieId, [screenId]);
  return checkLockedScheduleTargets(tx, movieId, screenId, locks);
}

/** A show to check for overlaps, with what the 409 details need to point at it. */
export interface ShowtimeCandidate extends ShowtimeSlot {
  /** The request field to blame, e.g. ['body', 'time'] or ['body', 'times', 2]. */
  path: (string | number)[];
  /** The Colombo date and time as requested. */
  requested: { date: string; time: string };
}

/**
 * The saved, non-deleted showtimes on the screens of `candidates` that can clash with them.
 * Reads inside `tx`, after the locks. Every live showtime counts, whatever its movie's status,
 * visibility or deletion.
 */
export async function findExistingShowtimeSlots(
  tx: Prisma.TransactionClient,
  candidates: readonly ShowtimeSlot[],
  gapMinutes: number,
): Promise<ShowtimeSlot[]> {
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
  return rows.map((row) => ({
    showtimeId: row.id,
    screenId: row.screenId,
    movieTitle: row.movie.title,
    startsAt: row.startsAt,
    durationMinutes: row.movie.durationMinutes,
  }));
}

/**
 * Every clash of `candidates` with the saved showtimes on their screens (see
 * findExistingShowtimeSlots) and with each other. Existing shows that clash with each other
 * under the current gap are never reported: a gap change only applies to shows created or
 * moved later.
 */
export async function findScreenConflicts<C extends ShowtimeCandidate>(
  tx: Prisma.TransactionClient,
  candidates: readonly C[],
  gapMinutes: number,
): Promise<ShowtimeOverlap<C>[]> {
  const existing = await findExistingShowtimeSlots(tx, candidates, gapMinutes);
  return findShowtimeConflicts({ candidates, existing, gapMinutes });
}

export interface ShowtimeConflictErrorOptions {
  /** The error message. Defaults to SHOWTIME_OVERLAP_MESSAGE (one showtime). */
  message?: string;
  /** Keep only the first `maxDetails` clashes in `details` (the message should give the total). */
  maxDetails?: number;
}

/**
 * The 409 CONFLICT for overlaps (shared showtimeConflictErrorSchema): one detail per clash,
 * each with the candidate's `path` and `requested` date/time and the show it overlaps. The
 * span names the Colombo date too when it differs from the requested date (e.g. a show that
 * started the evening before). A clash with another slot of the same request (`showtimeId:
 * null`) says so.
 */
export function showtimeConflictError(
  overlaps: readonly ShowtimeOverlap<ShowtimeCandidate>[],
  gapMinutes: number,
  { message = SHOWTIME_OVERLAP_MESSAGE, maxDetails }: ShowtimeConflictErrorOptions = {},
): AppError {
  const shown = maxDetails === undefined ? overlaps : overlaps.slice(0, maxDetails);
  const details: ShowtimeConflictDetail[] = shown.map(({ candidate, conflict }) => {
    const conflictDate = toColomboDate(conflict.startsAt);
    const day = conflictDate === candidate.requested.date ? '' : `${conflictDate} `;
    const span = `${day}${toColomboTime(conflict.startsAt)}–${toColomboTime(conflict.endsAt)}`;
    const gap =
      gapMinutes > 0 ? `, counting the ${String(gapMinutes)}-minute gap between shows` : '';
    const what = conflict.showtimeId === null ? 'another showtime in this request: ' : '';
    return {
      path: [...candidate.path],
      message: `Overlaps ${what}"${conflict.movieTitle}" (${span})${gap}`,
      requested: { ...candidate.requested },
      conflict: toShowtimeConflict(conflict),
    };
  });
  return new AppError(409, ERROR_CODES.CONFLICT, message, details);
}

const isForeignKeyError = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';

/** Thrown inside a create / update transaction when the write hit a foreign key (see message). */
class TargetGone extends Error {
  constructor() {
    super('Movie or screen gone before the write');
    this.name = 'TargetGone';
  }
}

/**
 * Thrown inside an update / soft delete transaction when the conditional update matched no
 * row (P2025): the showtime was removed or soft-deleted after it was read. Turned into a 404
 * or 409 after the rollback, never a 500.
 */
class ShowtimeGone extends Error {
  constructor() {
    super('Showtime changed before the write');
    this.name = 'ShowtimeGone';
  }
}

const conflict = (message: string) => new AppError(409, ERROR_CODES.CONFLICT, message);

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/** A showtime column PATCH /:id may change (the body's date + time become `startsAt`). */
export type ShowtimeEditableField = 'startsAt' | 'screenId' | 'format' | 'bookingUrlOverride';

/** A Record, not an interface, so it is assignable to Prisma's JSON input types. */
export type ShowtimeFieldChange = Record<'from' | 'to', string | null>;

/** Only the fields that actually change; empty when the update is a no-op. */
export type ShowtimeChanges = Partial<Record<ShowtimeEditableField, ShowtimeFieldChange>>;

/** What an update body would do to a showtime (see planShowtimeUpdate). */
export interface ShowtimeUpdatePlan {
  /** As audited: `startsAt` as ISO UTC strings, `format` from the stored (raw) value. */
  changes: ShowtimeChanges;
  /** The start or the screen changes: the scheduling rules and the overlap check apply. */
  moves: boolean;
  /** The start after the update (the current one when date + time are not sent). */
  startsAt: Date;
  /** The screen after the update (the current one when screenId is not sent or equal). */
  screenId: string;
}

/**
 * Compares a validated update body with the stored showtime:
 * - `date` + `time`: the Colombo wall clock as a UTC instant, compared by instant;
 * - `screenId`: compared case-insensitively (UUIDs);
 * - `format`: the body's normalised value against the NORMALISED stored one, so a stored "2d"
 *   and a body "2D" are equal; a stored value that cannot be normalised differs from any;
 * - `bookingUrlOverride`: exactly (`null` equals a stored NULL).
 * Omitted fields are ignored.
 */
export function planShowtimeUpdate(
  current: AdminShowtimeRow,
  body: ShowtimeUpdateBody,
): ShowtimeUpdatePlan {
  const changes: ShowtimeChanges = {};

  let startsAt = current.startsAt;
  if (body.date !== undefined && body.time !== undefined) {
    const requested = fromColomboDateTime(body.date, body.time);
    if (requested.getTime() !== current.startsAt.getTime()) {
      startsAt = requested;
      changes.startsAt = { from: current.startsAt.toISOString(), to: requested.toISOString() };
    }
  }

  let screenId = current.screen.id;
  if (body.screenId !== undefined && body.screenId.toLowerCase() !== screenId.toLowerCase()) {
    screenId = body.screenId;
    changes.screenId = { from: current.screen.id, to: body.screenId };
  }

  if (body.format !== undefined && body.format !== normalizeShowtimeFormat(current.format)) {
    changes.format = { from: current.format, to: body.format };
  }

  if (
    body.bookingUrlOverride !== undefined &&
    body.bookingUrlOverride !== current.bookingUrlOverride
  ) {
    changes.bookingUrlOverride = { from: current.bookingUrlOverride, to: body.bookingUrlOverride };
  }

  const moves = changes.startsAt !== undefined || changes.screenId !== undefined;
  return { changes, moves, startsAt, screenId };
}

// ---------------------------------------------------------------------------
// Bulk delete
// ---------------------------------------------------------------------------

/** One `details` entry of a bulk delete refusal: the index of the ID in `ids`. */
export interface ShowtimeIdDetail {
  path: ['body', 'ids', number];
  message: string;
}

const idDetails = (indexes: readonly number[], message: string): ShowtimeIdDetail[] =>
  indexes.map((index) => ({ path: ['body', 'ids', index], message }));

// ---------------------------------------------------------------------------
// Bulk create
// ---------------------------------------------------------------------------

/** One requested slot of a bulk create: a Colombo date + time and its UTC instant. */
export interface BulkSlot {
  date: string;
  time: string;
  /** Index of `time` in the request's `times` (the `path` of its errors). */
  timeIndex: number;
  startsAt: Date;
}

/**
 * Every date from `dateFrom` to `dateTo` (inclusive) at every time in `times`, in Colombo wall
 * clock, ordered by date then by the order of `times`: at most 31 x 12 = 372 slots. Throws
 * RangeError on a range the body schema would have refused (a programmer error).
 */
export function expandBulkSlots({
  dateFrom,
  dateTo,
  times,
}: Pick<ShowtimeBulkCreateBody, 'dateFrom' | 'dateTo' | 'times'>): BulkSlot[] {
  const dates: string[] = [];
  for (let date = dateFrom; date <= dateTo; date = addDays(date, 1)) {
    if (dates.length === SHOWTIME_BULK_MAX_DAYS) {
      throw new RangeError(`More than ${String(SHOWTIME_BULK_MAX_DAYS)} days`);
    }
    dates.push(date);
  }
  if (dates.length === 0) throw new RangeError('dateTo is before dateFrom');
  return dates.flatMap((date) =>
    times.map((time, timeIndex) => ({
      date,
      time,
      timeIndex,
      startsAt: fromColomboDateTime(date, time),
    })),
  );
}

/** The bulk create 400 for slots at or before `now`: all counted, the first 50 listed. */
function refusePastSlots(slots: readonly BulkSlot[], now: Date): void {
  const past = slots.filter((slot) => slot.startsAt.getTime() <= now.getTime());
  if (past.length === 0) return;
  const details: ShowtimePastSlotDetail[] = past
    .slice(0, SHOWTIME_BULK_MAX_DETAILS)
    .map((slot) => ({
      path: ['body', 'times', slot.timeIndex],
      message: SHOWTIME_SLOT_IN_PAST_MESSAGE,
      requested: { date: slot.date, time: slot.time },
    }));
  throw new AppError(
    400,
    ERROR_CODES.VALIDATION_ERROR,
    showtimeBulkPastMessage(past.length),
    details,
  );
}

/** The bulk create 409: every clash counted, the first 50 listed (see showtimeConflictError). */
function bulkConflictError(
  overlaps: readonly ShowtimeOverlap<ShowtimeCandidate>[],
  gapMinutes: number,
): AppError {
  const slotCount = new Set(overlaps.map((overlap) => overlap.candidateIndex)).size;
  return showtimeConflictError(overlaps, gapMinutes, {
    message: showtimeBulkOverlapMessage(slotCount, overlaps.length),
    maxDetails: SHOWTIME_BULK_MAX_DETAILS,
  });
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

  /**
   * The answer to a conditional update that matched no row (ShowtimeGone), from the showtime
   * re-read after the rollback: 404 when it is gone, 409 `deletedMessage` when it is
   * soft-deleted, 409 SHOWTIME_CHANGED_MESSAGE otherwise. Never a 500 (unless the re-read
   * itself fails).
   */
  async function lostWriteError(id: string, deletedMessage: string): Promise<AppError> {
    const row = await db.showtime.findUnique({ where: { id }, select: { deletedAt: true } });
    if (row === null) return notFound(SHOWTIME_NOT_FOUND_MESSAGE);
    return conflict(row.deletedAt === null ? SHOWTIME_CHANGED_MESSAGE : deletedMessage);
  }

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
     * Creates one showtime per Colombo date in [dateFrom, dateTo] at each of `times`, all or
     * nothing:
     * 1. any slot at or before now: 400 listing the past slots (nothing read or written), so a
     *    past request gets this 400 even for an unknown movie or screen;
     * 2. in one transaction: lock and check the movie, then the screen (checkScheduleTargets);
     *    the same past check again with a fresh clock, as a slot can pass while the locks are
     *    awaited; read the booking settings; check every slot against the live showtimes on the screen
     *    and against the other slots (409 listing the clashes, nothing written);
     * 3. one multi-row insert, then the inserted rows read back (below), then one CREATE audit
     *    row per showtime sharing a `batchId`, in one multi-row insert;
     * then, only after the commit, the public movie cache is dropped.
     *
     * Reading back: by movie, screen and `startsAt IN (...)` among live rows. That is exactly
     * the inserted rows: the overlap check just proved no live showtime on the screen starts at
     * any of these instants (a show always clashes with one starting at the same time), the
     * slots are distinct instants, and the screen lock keeps every other writer out until the
     * commit. A count mismatch is a bug: it throws, so the transaction rolls back (a 500). IDs
     * stay database-generated (UUIDv7, like every other row).
     */
    async bulkCreate(
      input: ShowtimeBulkCreateBody,
      actor: AuditActor,
    ): Promise<ShowtimeBulkCreateResponse> {
      const slots = expandBulkSlots(input);
      refusePastSlots(slots, now());

      let outcome: { rows: AdminShowtimeRow[]; baseUrl: string };
      try {
        outcome = await db.$transaction(async (tx) => {
          const { movie, screen } = await checkScheduleTargets(tx, input.movieId, input.screenId);
          refusePastSlots(slots, now());
          const booking = await settingsIn(tx).getBookingSettings();

          const candidates: ShowtimeCandidate[] = slots.map((slot) => ({
            showtimeId: null,
            screenId: screen.id,
            movieTitle: movie.title,
            startsAt: slot.startsAt,
            durationMinutes: movie.durationMinutes,
            path: ['body', 'times', slot.timeIndex],
            requested: { date: slot.date, time: slot.time },
          }));
          const overlaps = await findScreenConflicts(tx, candidates, booking.showGapMinutes);
          if (overlaps.length > 0) throw bulkConflictError(overlaps, booking.showGapMinutes);

          try {
            await tx.showtime.createMany({
              data: slots.map((slot) => ({
                movieId: movie.id,
                screenId: screen.id,
                startsAt: slot.startsAt,
                // Omitted: the database default ("2D").
                ...(input.format !== undefined && { format: input.format }),
              })),
            });
          } catch (error) {
            if (isForeignKeyError(error)) throw new TargetGone();
            throw error;
          }

          const rows = await tx.showtime.findMany({
            where: {
              movieId: movie.id,
              screenId: screen.id,
              deletedAt: null,
              startsAt: { in: slots.map((slot) => slot.startsAt) },
            },
            orderBy: [...ADMIN_SHOWTIME_LIST_ORDER_BY],
            select: adminShowtimeSelect,
          });
          if (rows.length !== slots.length) {
            throw new Error(
              `Bulk showtime create read back ${String(rows.length)} rows, expected ${String(slots.length)}`,
            );
          }

          const batchId = randomUUID();
          await writeAuditMany(
            tx,
            rows.map((row) => ({
              action: 'CREATE' as const,
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
                batchId,
              },
              ipAddress: actor.ipAddress,
              userAgent: actor.userAgent,
            })),
          );
          return { rows, baseUrl: booking.bmsBaseUrl };
        });
      } catch (error) {
        if (error instanceof TargetGone) {
          throw new AppError(409, ERROR_CODES.CONFLICT, SHOWTIME_TARGET_CHANGED_MESSAGE);
        }
        throw error;
      }

      // Only after the commit, so no request can re-cache the public pages without them.
      invalidatePublicMovies(cache);
      const items = outcome.rows.map((row) => toAdminShowtime(row, outcome.baseUrl, logger));
      return { created: items.length, items };
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

    /**
     * Changes the start (Colombo date + time), the screen, the format and/or the booking link
     * override of a live showtime that has not started. The movie never changes.
     *
     * Flow:
     * 1. read the showtime outside any transaction to learn its movie and screen (404 unknown);
     * 2. in one transaction: lock the movie, then the current and the requested screens
     *    (lockMovieAndScreens: movie first, screens sorted), then RE-READ the showtime under
     *    the locks: 404 gone; 409 SHOWTIME_DELETED_MESSAGE soft-deleted (D9: no restore);
     *    409 SHOWTIME_CHANGED_MESSAGE when it moved to another screen since step 1 (our locks
     *    no longer cover it); 409 SHOWTIME_STARTED_MESSAGE when `startsAt <= now` (D8);
     * 3. read the booking settings (gap, bmsBaseUrl) through the transaction;
     * 4. planShowtimeUpdate: no change at all is a 200 with the showtime as it is, without a
     *    write, an audit row or a cache invalidation;
     * 5. only when the start or the screen changes ("moves"): the movie must not be deleted or
     *    ENDED (409, no details: the body has no movieId) and the target screen must exist, be
     *    live and active (404 / 409 on body.screenId), then a changed start must be after now
     *    (400 on body.time), then the overlap check of the moved show against its neighbours
     *    on the target screen. The show is a candidate WITH its showtimeId, so it replaces its
     *    own saved slot (moving it a few minutes within its old slot is fine), and saved shows
     *    clashing with EACH OTHER under today's gap never fail it (a gap change only applies
     *    to shows created or moved afterwards). 409 with conflict details: path ['body',
     *    'time'] when the start changes, ['body', 'screenId'] when only the screen does;
     *    `requested` is the new start's Colombo date and time;
     * 6. the conditional update `where: { id, deletedAt: null }` (a P2025 means a concurrent
     *    delete: 404 / 409 after the rollback; a P2003 a vanished screen: 409), then the UPDATE
     *    audit row `{ changes }` with only the changed fields;
     * then, only after the commit, the public movie cache is dropped.
     *
     * Format-only and override-only edits skip step 5: they are allowed whatever the movie
     * status or the screen state (admins may fix the data of a show on a screen that has been
     * hidden since, or of an ENDED movie), and the slot does not move, so there is no overlap
     * check. Concurrent updates of one showtime are serialised by the movie lock; a concurrent
     * (unlocked) soft delete is caught by the conditional update.
     */
    async update(id: string, body: ShowtimeUpdateBody, actor: AuditActor): Promise<AdminShowtime> {
      const first = await db.showtime.findUnique({
        where: { id },
        select: { movieId: true, screenId: true },
      });
      if (first === null) throw notFound(SHOWTIME_NOT_FOUND_MESSAGE);

      let outcome: { row: AdminShowtimeRow; baseUrl: string; changed: boolean };
      try {
        outcome = await db.$transaction(async (tx) => {
          const locks = await lockMovieAndScreens(tx, first.movieId, [
            first.screenId,
            body.screenId ?? first.screenId,
          ]);
          const current = await tx.showtime.findUnique({
            where: { id },
            select: adminShowtimeSelect,
          });
          if (current === null) throw notFound(SHOWTIME_NOT_FOUND_MESSAGE);
          if (current.deletedAt !== null) throw conflict(SHOWTIME_DELETED_MESSAGE);
          if (current.screen.id.toLowerCase() !== first.screenId.toLowerCase()) {
            throw conflict(SHOWTIME_CHANGED_MESSAGE);
          }
          if (current.startsAt.getTime() <= now().getTime()) {
            throw conflict(SHOWTIME_STARTED_MESSAGE);
          }

          const booking = await settingsIn(tx).getBookingSettings();
          const plan = planShowtimeUpdate(current, body);
          const { changes } = plan;
          if (Object.keys(changes).length === 0) {
            return { row: current, baseUrl: booking.bmsBaseUrl, changed: false };
          }

          const data: Prisma.ShowtimeUncheckedUpdateInput = {};
          if (plan.moves) {
            const { movie, screen } = await checkLockedScheduleTargets(
              tx,
              current.movie.id,
              plan.screenId,
              locks,
              { messages: MOVE_TARGET_MESSAGES, movieInBody: false },
            );
            if (changes.startsAt !== undefined && plan.startsAt.getTime() <= now().getTime()) {
              throw fieldError(400, 'time', SHOWTIME_IN_PAST_MESSAGE);
            }

            const candidate: ShowtimeCandidate = {
              showtimeId: current.id,
              screenId: screen.id,
              movieTitle: movie.title,
              startsAt: plan.startsAt,
              durationMinutes: movie.durationMinutes,
              path: ['body', changes.startsAt === undefined ? 'screenId' : 'time'],
              requested: { date: toColomboDate(plan.startsAt), time: toColomboTime(plan.startsAt) },
            };
            const overlaps = await findScreenConflicts(tx, [candidate], booking.showGapMinutes);
            if (overlaps.length > 0) {
              throw showtimeConflictError(overlaps, booking.showGapMinutes);
            }

            if (changes.startsAt !== undefined) data.startsAt = plan.startsAt;
            if (changes.screenId !== undefined) {
              // The id as stored, so the audit `to` matches the row.
              data.screenId = screen.id;
              changes.screenId = { from: current.screen.id, to: screen.id };
            }
          }
          if (changes.format !== undefined && body.format !== undefined) {
            data.format = body.format;
          }
          if (changes.bookingUrlOverride !== undefined && body.bookingUrlOverride !== undefined) {
            data.bookingUrlOverride = body.bookingUrlOverride;
          }

          let row: AdminShowtimeRow;
          try {
            row = await tx.showtime.update({
              where: { id, deletedAt: null },
              data,
              select: adminShowtimeSelect,
            });
          } catch (error) {
            if (isRecordNotFound(error)) throw new ShowtimeGone();
            if (isForeignKeyError(error)) throw new TargetGone();
            throw error;
          }

          await writeAudit(tx, {
            action: 'UPDATE',
            adminId: actor.adminId,
            entity: AUDIT_ENTITY,
            entityId: row.id,
            // Admin configuration, stored in the audit table (never logged).
            details: { changes },
            ipAddress: actor.ipAddress,
            userAgent: actor.userAgent,
          });
          return { row, baseUrl: booking.bmsBaseUrl, changed: true };
        });
      } catch (error) {
        if (error instanceof TargetGone) throw conflict(SHOWTIME_TARGET_CHANGED_MESSAGE);
        if (error instanceof ShowtimeGone) throw await lostWriteError(id, SHOWTIME_DELETED_MESSAGE);
        throw error;
      }

      // Only after the commit, so no request can re-cache the public pages as they were.
      if (outcome.changed) invalidatePublicMovies(cache);
      return toAdminShowtime(outcome.row, outcome.baseUrl, logger);
    },

    /**
     * Soft-deletes a live showtime: sets `deletedAt` (DELETE audit, `{ mode: 'soft' }`) and
     * returns it. 404 unknown; 409 SHOWTIME_ALREADY_DELETED_MESSAGE when already deleted (there
     * is no restore). Started and past showtimes can be deleted (D8).
     *
     * No row lock: removing a show never creates an overlap, and the guards that count
     * upcoming showtimes under a lock (screen hide / delete, movie delete) can only become
     * stricter than necessary while a delete is in flight, never too lenient. The conditional
     * update `where: { id, deletedAt: null }` makes two concurrent deletes safe: the second
     * gets a P2025, answered as 409 / 404 after the rollback.
     */
    async softDelete(id: string, actor: AuditActor): Promise<AdminShowtime> {
      let outcome: { row: AdminShowtimeRow; baseUrl: string };
      try {
        outcome = await db.$transaction(async (tx) => {
          const current = await tx.showtime.findUnique({
            where: { id },
            select: { deletedAt: true },
          });
          if (current === null) throw notFound(SHOWTIME_NOT_FOUND_MESSAGE);
          if (current.deletedAt !== null) throw conflict(SHOWTIME_ALREADY_DELETED_MESSAGE);

          const booking = await settingsIn(tx).getBookingSettings();
          let row: AdminShowtimeRow;
          try {
            row = await tx.showtime.update({
              where: { id, deletedAt: null },
              data: { deletedAt: now() },
              select: adminShowtimeSelect,
            });
          } catch (error) {
            if (isRecordNotFound(error)) throw new ShowtimeGone();
            throw error;
          }

          await writeAudit(tx, {
            action: 'DELETE',
            adminId: actor.adminId,
            entity: AUDIT_ENTITY,
            entityId: row.id,
            details: { mode: 'soft' },
            ipAddress: actor.ipAddress,
            userAgent: actor.userAgent,
          });
          return { row, baseUrl: booking.bmsBaseUrl };
        });
      } catch (error) {
        if (error instanceof ShowtimeGone) {
          throw await lostWriteError(id, SHOWTIME_ALREADY_DELETED_MESSAGE);
        }
        throw error;
      }

      // Only after the commit.
      invalidatePublicMovies(cache);
      return toAdminShowtime(outcome.row, outcome.baseUrl, logger);
    },

    /**
     * Soft-deletes up to 200 showtimes, all or nothing, in one transaction:
     * 1. read every requested showtime: any unknown ID is a 404 listing each one
     *    (`details: [{ path: ['body', 'ids', i], message }]`); otherwise any already deleted
     *    one is a 409 listing each one. Nothing is changed in either case;
     * 2. one conditional `updateMany` (`id IN ids AND deletedAt IS NULL`); a count other than
     *    the number of IDs means a concurrent delete got in between: rolled back with 409
     *    SHOWTIME_BULK_DELETE_CHANGED_MESSAGE;
     * 3. one DELETE audit row per showtime (`{ mode: 'soft', batchId }`), in one insert;
     * then, only after the commit, the public movie cache is dropped (once).
     *
     * Started and past showtimes can be deleted (D8). D7: this is how an admin clears a
     * movie's upcoming showtimes before soft-deleting the movie. No row lock, for the reasons
     * given on softDelete.
     */
    async bulkDelete(
      input: ShowtimeBulkDeleteBody,
      actor: AuditActor,
    ): Promise<ShowtimeBulkDeleteResponse> {
      const { ids } = input;
      const deleted = await db.$transaction(async (tx) => {
        const rows = await tx.showtime.findMany({
          where: { id: { in: ids } },
          select: { id: true, deletedAt: true },
        });
        // UUIDs compare case-insensitively (the body schema rejects case-only duplicates).
        const byId = new Map(rows.map((row) => [row.id.toLowerCase(), row]));
        const unknown: number[] = [];
        const alreadyDeleted: number[] = [];
        ids.forEach((id, index) => {
          const row = byId.get(id.toLowerCase());
          if (row === undefined) unknown.push(index);
          else if (row.deletedAt !== null) alreadyDeleted.push(index);
        });
        if (unknown.length > 0) {
          throw new AppError(
            404,
            ERROR_CODES.NOT_FOUND,
            showtimeBulkDeleteNotFoundMessage(unknown.length),
            idDetails(unknown, SHOWTIME_BULK_DELETE_UNKNOWN_ID_MESSAGE),
          );
        }
        if (alreadyDeleted.length > 0) {
          throw new AppError(
            409,
            ERROR_CODES.CONFLICT,
            showtimeBulkDeleteAlreadyDeletedMessage(alreadyDeleted.length),
            idDetails(alreadyDeleted, SHOWTIME_BULK_DELETE_DELETED_ID_MESSAGE),
          );
        }

        const { count } = await tx.showtime.updateMany({
          where: { id: { in: ids }, deletedAt: null },
          data: { deletedAt: now() },
        });
        if (count !== ids.length) throw conflict(SHOWTIME_BULK_DELETE_CHANGED_MESSAGE);

        const batchId = randomUUID();
        await writeAuditMany(
          tx,
          ids.map((id) => ({
            action: 'DELETE' as const,
            adminId: actor.adminId,
            entity: AUDIT_ENTITY,
            // The id as stored (every one was found above).
            entityId: byId.get(id.toLowerCase())?.id ?? id,
            details: { mode: 'soft', batchId },
            ipAddress: actor.ipAddress,
            userAgent: actor.userAgent,
          })),
        );
        return count;
      });

      // Only after the commit.
      invalidatePublicMovies(cache);
      return { deleted };
    },
  };
}

export type ShowtimeAdminService = ReturnType<typeof createShowtimeAdminService>;
