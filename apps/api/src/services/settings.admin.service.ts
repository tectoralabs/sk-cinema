import type { AdminSettings, AdminSettingsResponse, SettingsUpdateBody } from '@sk-cinema/shared';
import type { Logger } from 'pino';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import type { MemoryCache } from '../lib/cache.js';
import type { SettingKey } from '../lib/settings.js';
import {
  existingShowtimeWindow,
  findShowtimeConflicts,
  isUsableDuration,
  type ShowtimeSlot,
} from '../lib/showtimeOverlap.js';
import { writeAuditMany, type AuditActor } from './audit.service.js';
import { invalidatePublicMovies } from './movie.public.service.js';
import {
  BOOKING_SETTING_KEYS,
  createSettingsService,
  type BookingSettings,
} from './settings.service.js';

/*
 * Admin read and update of the site settings (SUPER_ADMIN only, see routes/admin.routes.ts).
 *
 * A show gap change applies ONLY to showtimes created or moved afterwards. Saving a larger gap
 * is never refused because saved shows are closer than it, and changes or deletes no showtime;
 * futureShowtimesBelowGap only tells the admin how many shows are now too close.
 *
 * No lock against showtime writers: a create or move running at the same moment reads the gap
 * in its own transaction and uses the old or the new one, whichever committed first.
 */

const AUDIT_ENTITY = 'Setting';

/** `reason` logged when the gap count skips shows whose movie has an unusable running time. */
export const UNUSABLE_DURATION_REASON = 'unusable_stored_duration';

const gapSlotSelect = {
  id: true,
  screenId: true,
  startsAt: true,
  movie: { select: { title: true, durationMinutes: true } },
} as const satisfies Prisma.ShowtimeSelect;

type GapSlotRow = Prisma.ShowtimeGetPayload<{ select: typeof gapSlotSelect }>;

const toSlot = (row: GapSlotRow): ShowtimeSlot => ({
  showtimeId: row.id,
  screenId: row.screenId,
  movieTitle: row.movie.title,
  startsAt: row.startsAt,
  durationMinutes: row.movie.durationMinutes,
});

/**
 * How many distinct future non-deleted showtimes start too soon after an earlier non-deleted
 * show on the same screen under `gapMinutes` (see lib/showtimeOverlap.ts): the later show of
 * each clashing pair, the shows an admin would need to move. Three shows in a row, all too
 * close, count 2. A show running at `now` counts as an earlier neighbour. Every non-deleted
 * showtime occupies its screen, whatever its movie's or screen's state.
 *
 * The count is information for the admin, so it must never block the settings screen: a show
 * whose movie has an unusable running time (possible only through manual SQL) is left out, as a
 * candidate and as a neighbour, with one warning per call giving the number of such shows, one
 * showtime ID to start looking from, and the reason. Showtime writes still refuse such a movie.
 *
 * Cost: one query for the future shows and, only when there are any, one for the shows started
 * within the longest possible run plus the gap before the earliest of them (both can use the
 * Showtime `startsAt` index), then a sort-and-sweep per screen. Admin-only and read-only.
 */
export async function countFutureShowtimesBelowGap(
  db: Pick<Prisma.TransactionClient, 'showtime'>,
  gapMinutes: number,
  now: Date,
  logger: Pick<Logger, 'warn'>,
): Promise<number> {
  const skipped: string[] = [];
  const usableSlots = (rows: readonly GapSlotRow[]): ShowtimeSlot[] =>
    rows.flatMap((row) => {
      if (isUsableDuration(row.movie.durationMinutes)) return [toSlot(row)];
      skipped.push(row.id);
      return [];
    });

  const future = await db.showtime.findMany({
    where: { deletedAt: null, startsAt: { gt: now } },
    select: gapSlotSelect,
  });
  const candidates = usableSlots(future);

  let belowGap = 0;
  const window = existingShowtimeWindow({ candidates, gapMinutes });
  if (window !== null) {
    // Up to `now` only: everything after it is already a candidate.
    const started = await db.showtime.findMany({
      where: { deletedAt: null, startsAt: { gte: window.from, lte: now } },
      select: gapSlotSelect,
    });
    const overlaps = findShowtimeConflicts({
      candidates,
      existing: usableSlots(started),
      gapMinutes,
    });
    belowGap = new Set(overlaps.map((overlap) => overlap.candidateIndex)).size;
  }

  if (skipped.length > 0) {
    logger.warn(
      {
        showtimeId: skipped[0],
        skippedCount: skipped.length,
        reason: UNUSABLE_DURATION_REASON,
      },
      'Left showtimes out of the gap count: their movie has an unusable running time',
    );
  }
  return belowGap;
}

/** A setting whose effective value would change. */
interface SettingChange {
  key: SettingKey;
  from: BookingSettings[SettingKey];
  to: BookingSettings[SettingKey];
}

/**
 * Compares a validated body with the effective values (a missing or invalid row reads as its
 * default), so `from` is always a valid typed value, never a stored raw one. Empty: a no-op.
 *
 * A key in `invalidKeys` holds an invalid stored row, which is never a no-op: sending the value
 * it reads as (its default) replaces the row, so it stops warning on every read. `from` is then
 * equal to `to`.
 */
export function settingChanges(
  current: BookingSettings,
  body: SettingsUpdateBody,
  invalidKeys: ReadonlySet<SettingKey> = new Set(),
): SettingChange[] {
  const changes: SettingChange[] = [];
  for (const key of BOOKING_SETTING_KEYS) {
    const to = body[key];
    if (to !== undefined && (to !== current[key] || invalidKeys.has(key))) {
      changes.push({ key, from: current[key], to });
    }
  }
  return changes;
}

export type SettingsAdminDb = Pick<
  PrismaClient,
  'setting' | 'showtime' | 'auditLog' | '$transaction'
>;

export interface SettingsAdminServiceDeps {
  db: SettingsAdminDb;
  /**
   * The app's one cache. Public showtime responses hold booking links built from the base URL
   * and are cached under the public movies prefix, so a committed change drops them.
   */
  cache: Pick<MemoryCache, 'invalidatePrefix'>;
  /** Warnings only: a setting key and a reason, never a stored value (see settings.service). */
  logger: Pick<Logger, 'warn'>;
  /** Injectable clock for tests (the "future" boundary). Defaults to the current time. */
  now?: () => Date;
}

export function createSettingsAdminService({
  db,
  cache,
  logger,
  now = () => new Date(),
}: SettingsAdminServiceDeps) {
  return {
    /** The settings and the count under the stored gap. Three queries at most, never cached. */
    async get(): Promise<AdminSettingsResponse> {
      const settings = await createSettingsService({ db, logger }).getAdminSettings();
      const futureShowtimesBelowGap = await countFutureShowtimesBelowGap(
        db,
        settings.showGapMinutes,
        now(),
        logger,
      );
      return { settings, futureShowtimesBelowGap };
    },

    /**
     * In one transaction: read the effective values and compare; upsert only the changed keys
     * and write one UPDATE audit row per key (`{ from, to }`, effective typed values). Then,
     * only after the commit and only if something changed, the public cache is dropped, and
     * last the count under the gap now in force is read (outside the transaction). A no-op writes, audits and invalidates nothing and answers
     * the same shape; a key holding an invalid stored row is never a no-op (see settingChanges).
     * Base URL changes leave showtime overrides alone.
     */
    async update(body: SettingsUpdateBody, actor: AuditActor): Promise<AdminSettingsResponse> {
      const outcome = await db.$transaction(async (tx) => {
        const reader = createSettingsService({ db: tx, logger });
        const { settings: current, invalidKeys } = await reader.getSettingsForSave();
        const changes = settingChanges(current, body, invalidKeys);

        let settings: AdminSettings = current;
        if (changes.length > 0) {
          for (const { key, to } of changes) {
            const value = String(to);
            const written = { value, updatedById: actor.adminId };
            await tx.setting.upsert({
              where: { key },
              create: { key, ...written },
              update: written,
              // No nested read: with one Prisma sends two statements instead of its atomic
              // ON CONFLICT upsert, and two concurrent first saves would hit P2002.
              select: { key: true },
            });
          }
          await writeAuditMany(
            tx,
            changes.map(({ key, from, to }) => ({
              action: 'UPDATE' as const,
              adminId: actor.adminId,
              entity: AUDIT_ENTITY,
              entityId: key,
              details: { from, to },
              ipAddress: actor.ipAddress,
              userAgent: actor.userAgent,
            })),
          );
          settings = {
            bmsBaseUrl: body.bmsBaseUrl ?? current.bmsBaseUrl,
            showGapMinutes: body.showGapMinutes ?? current.showGapMinutes,
            ...(await reader.getLastChange()),
          };
        }

        return { settings, changed: changes.length > 0 };
      });

      // Only after the commit, so no request can re-cache links built from the old base URL.
      if (outcome.changed) invalidatePublicMovies(cache);

      // Counted after the commit, through the root client: the count loads every future show, so
      // inside the transaction a huge schedule could exhaust its 10 s timeout and fail a save
      // that is otherwise instant. If the count throws, the save is already committed, audited
      // and the cache dropped; the error propagates as a generic 500 (a fallback number would
      // mislead) and the admin reads the result with a GET.
      const futureShowtimesBelowGap = await countFutureShowtimesBelowGap(
        db,
        outcome.settings.showGapMinutes,
        now(),
        logger,
      );
      return { settings: outcome.settings, futureShowtimesBelowGap };
    },
  };
}

export type SettingsAdminService = ReturnType<typeof createSettingsAdminService>;
