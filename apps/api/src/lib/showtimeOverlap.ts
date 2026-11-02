import {
  MOVIE_DURATION_MAX_MINUTES,
  SHOW_GAP_MINUTES_MAX,
  SHOW_GAP_MINUTES_MIN,
  type ShowtimeConflict,
} from '@sk-cinema/shared';

/*
 * Showtime overlap detection on a screen. Pure: no database, no clock.
 *
 * A show occupies its screen for `[startsAt, startsAt + durationMinutes + gapMinutes)`: the
 * movie's running time, then the show gap (Setting `showGapMinutes`, read by the caller through
 * the settings service) for cleaning and seating. Two shows on the same screen conflict iff
 *
 *   A.start < B.start + B.duration + gap  &&  B.start < A.start + A.duration + gap
 *
 * which is symmetric: every show needs the gap after it. Touching is allowed: a show may start
 * exactly at `previous.start + previous.duration + gap`. Shows on different screens never
 * conflict.
 *
 * Callers (showtime create / bulk create / update, movie duration change):
 * - Lock the movie and the screens first (lib/locks.ts), then read the gap and the existing
 *   showtimes inside the same transaction, so a concurrent writer cannot slip in between.
 * - Fetch existing showtimes with existingShowtimeWindow (one query per screen, or one with
 *   `screenId: { in: [...] }`), not soft-deleted (`deletedAt: null`), with the movie's title
 *   and duration.
 * - Excluding a show / changing a duration: give the show as a candidate with its
 *   `showtimeId` and its new start, screen or duration. An existing slot with the same
 *   `showtimeId` is then ignored (the candidate replaces it), so a moved show never clashes
 *   with its own old position and there is no separate exclude option. For a movie duration
 *   change, give each of the movie's future showtimes as a candidate with the new duration.
 */

const MS_PER_MINUTE = 60_000;

/** A show occupying a screen, saved or requested. */
export interface ShowtimeSlot {
  /** The saved showtime's ID, or `null` for a slot that is not saved yet (a new show). */
  showtimeId: string | null;
  /** Shows only clash on the same screen (compared case-insensitively, as UUIDs). */
  screenId: string;
  movieTitle: string;
  startsAt: Date;
  /** The movie's running time: a positive whole number of minutes. */
  durationMinutes: number;
}

/** The show a candidate clashes with. `endsAt` is start + duration, without the gap. */
export interface ConflictingSlot {
  /** `null` when the clash is with another unsaved candidate of the same request. */
  showtimeId: string | null;
  movieTitle: string;
  startsAt: Date;
  endsAt: Date;
}

/** One clash: a candidate and the show it overlaps. */
export interface ShowtimeOverlap<C extends ShowtimeSlot = ShowtimeSlot> {
  /** Index of the candidate in the `candidates` input. */
  candidateIndex: number;
  /** The candidate exactly as given, so extra fields (requested date/time, path) come back. */
  candidate: C;
  conflict: ConflictingSlot;
}

export interface FindShowtimeConflictsInput<C extends ShowtimeSlot> {
  /**
   * The shows being created or changed. Add any fields you need back in the result (e.g. the
   * requested Colombo `date` / `time` and the request `path`).
   */
  candidates: readonly C[];
  /**
   * Saved showtimes that may clash (see existingShowtimeWindow), not soft-deleted. Clashes
   * between two existing shows are not reported: only candidates are checked.
   */
  existing: readonly ShowtimeSlot[];
  /** Setting `showGapMinutes`: a whole number from 0 to 120. */
  gapMinutes: number;
}

/** Throws (a programmer error, never a client error) unless `gapMinutes` is an int 0–120. */
function assertGap(gapMinutes: number): void {
  if (
    !Number.isInteger(gapMinutes) ||
    gapMinutes < SHOW_GAP_MINUTES_MIN ||
    gapMinutes > SHOW_GAP_MINUTES_MAX
  ) {
    throw new RangeError(
      `gapMinutes must be a whole number from ${String(SHOW_GAP_MINUTES_MIN)} to ` +
        `${String(SHOW_GAP_MINUTES_MAX)}, got ${String(gapMinutes)}`,
    );
  }
}

/**
 * True for a running time this module accepts: a positive whole number. The API never stores
 * anything else, but the database has no CHECK on it, so manual SQL could.
 */
export function isUsableDuration(durationMinutes: number): boolean {
  return Number.isSafeInteger(durationMinutes) && durationMinutes >= 1;
}

/** Throws unless the slot has a valid start and a positive whole-minute duration. */
function assertSlot(slot: Pick<ShowtimeSlot, 'startsAt' | 'durationMinutes'>, label: string): void {
  if (!isUsableDuration(slot.durationMinutes)) {
    throw new RangeError(
      `${label}: durationMinutes must be a positive whole number, got ${String(slot.durationMinutes)}`,
    );
  }
  if (!(slot.startsAt instanceof Date) || Number.isNaN(slot.startsAt.getTime())) {
    throw new RangeError(`${label}: startsAt must be a valid Date`);
  }
}

/** The slot as reported in a conflict: start and end (start + duration, no gap). */
function conflictingSlot(slot: ShowtimeSlot): ConflictingSlot {
  return {
    showtimeId: slot.showtimeId,
    movieTitle: slot.movieTitle,
    startsAt: new Date(slot.startsAt.getTime()),
    endsAt: new Date(slot.startsAt.getTime() + slot.durationMinutes * MS_PER_MINUTE),
  };
}

/** A slot on the sweep line: [start, end) in ms, the end including the gap. */
interface Interval<C extends ShowtimeSlot> {
  start: number;
  end: number;
  slot: ShowtimeSlot;
  /** The candidate, or `null` for an existing show. */
  candidate: C | null;
  /** Index in `candidates`, or -1 for an existing show. */
  candidateIndex: number;
}

const isCandidate = <C extends ShowtimeSlot>(
  interval: Interval<C>,
): interval is Interval<C> & { candidate: C } => interval.candidate !== null;

const byStart = <C extends ShowtimeSlot>(a: Interval<C>, b: Interval<C>): number =>
  a.start - b.start || a.candidateIndex - b.candidateIndex;

/**
 * Every clash of a candidate with an existing show or with another candidate on the same
 * screen (see the semantics at the top of this file).
 *
 * - Candidate vs existing: reported once, on the candidate, with the existing show (its ID).
 * - Candidate vs candidate: reported once per pair, on the later one (later start; for the
 *   same start, the higher index), with the earlier one as the conflict. Its `showtimeId` is
 *   the earlier candidate's (`null` for an unsaved show).
 * - A candidate never clashes with itself, nor with the existing slot it replaces (same
 *   `showtimeId`). Existing shows clashing with each other are not reported.
 *
 * Sorted by candidate index, then conflict start. Sort-and-sweep per screen: O(n log n) plus
 * the number of overlapping pairs.
 *
 * Throws RangeError for a gap outside 0–120, a duration that is not a positive whole number
 * or an invalid start (programmer errors: services pass validated values).
 */
export function findShowtimeConflicts<C extends ShowtimeSlot>({
  candidates,
  existing,
  gapMinutes,
}: FindShowtimeConflictsInput<C>): ShowtimeOverlap<C>[] {
  assertGap(gapMinutes);
  candidates.forEach((slot, i) => {
    assertSlot(slot, `candidates[${String(i)}]`);
  });
  existing.forEach((slot, i) => {
    assertSlot(slot, `existing[${String(i)}]`);
  });

  const gapMs = gapMinutes * MS_PER_MINUTE;
  const toInterval = (slot: ShowtimeSlot, candidate: C | null, candidateIndex: number) => {
    const start = slot.startsAt.getTime();
    const end = start + slot.durationMinutes * MS_PER_MINUTE + gapMs;
    return { start, end, slot, candidate, candidateIndex } satisfies Interval<C>;
  };

  // Saved shows that a candidate replaces (moved, or recomputed with a new duration).
  const replaced = new Set<string>();
  for (const slot of candidates) {
    if (slot.showtimeId !== null) replaced.add(slot.showtimeId.toLowerCase());
  }

  const screens = new Map<string, Interval<C>[]>();
  const add = (interval: Interval<C>) => {
    const key = interval.slot.screenId.toLowerCase();
    const list = screens.get(key);
    if (list) list.push(interval);
    else screens.set(key, [interval]);
  };
  candidates.forEach((slot, i) => {
    add(toInterval(slot, slot, i));
  });
  for (const slot of existing) {
    if (slot.showtimeId !== null && replaced.has(slot.showtimeId.toLowerCase())) continue;
    add(toInterval(slot, null, -1));
  }

  /** Each clash: the candidate's interval (`on`) and the interval it overlaps. */
  const found: { on: Interval<C> & { candidate: C }; other: Interval<C> }[] = [];
  for (const intervals of screens.values()) {
    // A screen without candidates cannot produce a conflict.
    if (!intervals.some(isCandidate)) continue;
    intervals.sort(byStart);

    // Intervals that started at or before the current one and have not ended yet.
    let active: Interval<C>[] = [];
    for (const current of intervals) {
      active = active.filter((earlier) => earlier.end > current.start);
      // Every `earlier` has start <= current.start < current.end and end > current.start.
      for (const earlier of active) {
        if (isCandidate(current)) found.push({ on: current, other: earlier });
        else if (isCandidate(earlier)) found.push({ on: earlier, other: current });
        // Both existing: not this request's clash.
      }
      active.push(current);
    }
  }

  found.sort(
    (a, b) =>
      a.on.candidateIndex - b.on.candidateIndex ||
      a.other.start - b.other.start ||
      a.other.candidateIndex - b.other.candidateIndex,
  );
  return found.map(({ on, other }) => ({
    candidateIndex: on.candidateIndex,
    candidate: on.candidate,
    conflict: conflictingSlot(other.slot),
  }));
}

/** The response shape of a conflict (shared showtimeConflictSchema): ISO UTC timestamps. */
export function toShowtimeConflict(conflict: ConflictingSlot): ShowtimeConflict {
  return {
    showtimeId: conflict.showtimeId,
    movieTitle: conflict.movieTitle,
    startsAt: conflict.startsAt.toISOString(),
    endsAt: conflict.endsAt.toISOString(),
  };
}

export interface ShowtimeQueryWindow {
  /** Inclusive lower bound for the existing showtimes' `startsAt`. */
  from: Date;
  /** Exclusive upper bound for the existing showtimes' `startsAt`. */
  to: Date;
}

export interface ExistingShowtimeWindowInput {
  candidates: readonly Pick<ShowtimeSlot, 'startsAt' | 'durationMinutes'>[];
  gapMinutes: number;
  /**
   * Longest running time an existing show can have. Defaults to MOVIE_DURATION_MAX_MINUTES
   * (shared movie schema), the most the API accepts. The database has no CHECK on it, so a row
   * made with manual SQL could be longer; pass a larger value if that ever matters.
   */
  maxExistingDurationMinutes?: number;
}

/**
 * The `startsAt` range of existing showtimes that can clash with any of the candidates, so the
 * service fetches only those (per screen):
 *
 *   from = min(candidate.startsAt) - (maxExistingDurationMinutes + gapMinutes)
 *   to   = max(candidate.startsAt + candidate.durationMinutes) + gapMinutes
 *
 * Query `startsAt: { gte: from, lt: to }`. Why: an existing show E clashes with candidate C
 * only if E.start < C.start + C.duration + gap (so E.start < to) and
 * C.start < E.start + E.duration + gap, i.e. E.start > C.start - E.duration - gap >= from.
 * `gte` keeps a harmless extra boundary row (it cannot clash), never misses one.
 *
 * Returns `null` for no candidates (nothing to query). Throws like findShowtimeConflicts on an
 * invalid gap or slot, or a maxExistingDurationMinutes that is not a positive whole number.
 */
export function existingShowtimeWindow({
  candidates,
  gapMinutes,
  maxExistingDurationMinutes = MOVIE_DURATION_MAX_MINUTES,
}: ExistingShowtimeWindowInput): ShowtimeQueryWindow | null {
  assertGap(gapMinutes);
  if (!Number.isSafeInteger(maxExistingDurationMinutes) || maxExistingDurationMinutes < 1) {
    throw new RangeError(
      `maxExistingDurationMinutes must be a positive whole number, got ${String(maxExistingDurationMinutes)}`,
    );
  }
  if (candidates.length === 0) return null;

  let minStart = Infinity;
  let maxEnd = -Infinity;
  candidates.forEach((slot, i) => {
    assertSlot(slot, `candidates[${String(i)}]`);
    const start = slot.startsAt.getTime();
    minStart = Math.min(minStart, start);
    maxEnd = Math.max(maxEnd, start + slot.durationMinutes * MS_PER_MINUTE);
  });

  return {
    from: new Date(minStart - (maxExistingDurationMinutes + gapMinutes) * MS_PER_MINUTE),
    to: new Date(maxEnd + gapMinutes * MS_PER_MINUTE),
  };
}
