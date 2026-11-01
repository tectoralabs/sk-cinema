import { MOVIE_DURATION_MAX_MINUTES, showtimeConflictSchema } from '@sk-cinema/shared';
import { describe, expect, it } from 'vitest';
import { addDays, fromColomboDateTime } from './colomboTime.js';
import {
  existingShowtimeWindow,
  findShowtimeConflicts,
  toShowtimeConflict,
  type ShowtimeOverlap,
  type ShowtimeSlot,
} from './showtimeOverlap.js';

const SCREEN_1 = '00000000-0000-7000-8000-00000000a001';
const SCREEN_2 = '00000000-0000-7000-8000-00000000a002';
const DAY = '2026-11-05';
const MINUTE = 60_000;

/** A Colombo wall-clock instant on DAY (or another date). */
const at = (time: string, date = DAY) => fromColomboDateTime(date, time);

let nextId = 0;
const showtimeId = () => `00000000-0000-7000-8000-${String(++nextId).padStart(12, '0')}`;

/** A saved show on SCREEN_1 unless overridden. */
function saved(
  time: string,
  durationMinutes: number,
  overrides: Partial<Omit<ShowtimeSlot, 'showtimeId'>> = {},
) {
  return {
    showtimeId: showtimeId(),
    screenId: SCREEN_1,
    movieTitle: 'Existing',
    startsAt: at(time),
    durationMinutes,
    ...overrides,
  } satisfies ShowtimeSlot;
}

/** A requested (unsaved) show on SCREEN_1, carrying the request fields a service would add. */
function requested(
  time: string,
  durationMinutes: number,
  { date = DAY, ...overrides }: Partial<ShowtimeSlot> & { date?: string } = {},
) {
  return {
    showtimeId: null,
    screenId: SCREEN_1,
    movieTitle: 'Requested',
    startsAt: at(time, date),
    durationMinutes,
    requested: { date, time },
    ...overrides,
  } satisfies ShowtimeSlot & { requested: { date: string; time: string } };
}

const conflictsOf = <C extends ShowtimeSlot>(
  candidates: readonly C[],
  existing: readonly ShowtimeSlot[],
  gapMinutes = 15,
) => findShowtimeConflicts({ candidates, existing, gapMinutes });

/** [candidateIndex, conflict showtimeId, conflict start ISO] per clash, for compact asserts. */
/** The only element, or a test failure. */
function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  const [item] = items;
  if (item === undefined) throw new Error('expected one item');
  return item;
}

const summary = (overlaps: readonly ShowtimeOverlap[]) =>
  overlaps.map((o) => [o.candidateIndex, o.conflict.showtimeId, o.conflict.startsAt.toISOString()]);

describe('findShowtimeConflicts: edges and the gap', () => {
  it('allows a show starting exactly at the previous end + gap, and rejects one minute earlier', () => {
    const existing = saved('10:00', 120); // occupies 10:00-12:15 with a 15 min gap
    expect(conflictsOf([requested('12:15', 90)], [existing])).toEqual([]);

    const clash = conflictsOf([requested('12:14', 90)], [existing]);
    expect(summary(clash)).toEqual([[0, existing.showtimeId, at('10:00').toISOString()]]);
  });

  it('needs the gap after the candidate too (symmetric)', () => {
    const later = saved('12:15', 90);
    expect(conflictsOf([requested('10:00', 120)], [later])).toEqual([]);
    expect(summary(conflictsOf([requested('10:01', 120)], [later]))).toEqual([
      [0, later.showtimeId, at('12:15').toISOString()],
    ]);
  });

  it.each([
    // [gap, next start that touches, one minute earlier]
    [0, '11:40', '11:39'],
    [15, '11:55', '11:54'],
    [120, '13:40', '13:39'],
  ])('gap %i: next show may start at %s, not %s', (gap, touching, oneEarly) => {
    const existing = saved('10:00', 100); // the movie ends at 11:40
    expect(conflictsOf([requested(touching, 60)], [existing], gap)).toEqual([]);
    expect(conflictsOf([requested(oneEarly, 60)], [existing], gap)).toHaveLength(1);
  });

  it('with gap 0, back-to-back shows are fine but any overlap is not', () => {
    const existing = saved('10:00', 100);
    expect(conflictsOf([requested('11:40', 60)], [existing], 0)).toEqual([]);
    expect(conflictsOf([requested('09:00', 60)], [existing], 0)).toEqual([]);
    expect(conflictsOf([requested('09:01', 60)], [existing], 0)).toHaveLength(1);
  });

  it('detects an overlap across Colombo midnight', () => {
    // 23:00 Colombo + 150 min ends 01:30 the next day; with the gap the screen is busy to 01:45.
    const late = saved('23:00', 150);
    const nextDay = addDays(DAY, 1);
    const clash = conflictsOf([requested('01:00', 90, { date: nextDay })], [late]);
    expect(only(clash).conflict).toEqual({
      showtimeId: late.showtimeId,
      movieTitle: 'Existing',
      startsAt: new Date('2026-11-05T17:30:00.000Z'),
      endsAt: new Date('2026-11-05T20:00:00.000Z'), // 01:30 Colombo, without the gap
    });
    expect(conflictsOf([requested('01:45', 90, { date: nextDay })], [late])).toEqual([]);
  });
});

describe('findShowtimeConflicts: shapes of overlap', () => {
  it('reports a duplicate time inside one batch once, on the later candidate, with showtimeId null', () => {
    const clash = conflictsOf([requested('10:00', 120), requested('10:00', 120)], []);
    expect(summary(clash)).toEqual([[1, null, at('10:00').toISOString()]]);
    expect(clash[0]?.conflict.movieTitle).toBe('Requested');
  });

  it('reports a clash between two batch times on the later one, whatever the input order', () => {
    // A 3 h movie at 10:00 and 12:00: the 12:00 show (input index 0) starts inside the first.
    const clash = conflictsOf([requested('12:00', 180), requested('10:00', 180)], []);
    expect(summary(clash)).toEqual([[0, null, at('10:00').toISOString()]]);
  });

  it('reports every show a long candidate overlaps', () => {
    const noon = saved('12:00', 90);
    const two = saved('14:00', 90);
    const evening = saved('15:15', 90); // touches: 10:00 + 300 + 15
    const clash = conflictsOf([requested('10:00', 300)], [evening, two, noon]);
    expect(summary(clash)).toEqual([
      [0, noon.showtimeId, at('12:00').toISOString()],
      [0, two.showtimeId, at('14:00').toISOString()],
    ]);
  });

  it('reports every candidate a long existing show overlaps', () => {
    const long = saved('10:00', 300);
    const clash = conflictsOf(
      [requested('12:00', 60), requested('15:15', 60), requested('14:00', 60)],
      [long],
    );
    expect(summary(clash)).toEqual([
      [0, long.showtimeId, at('10:00').toISOString()],
      [2, long.showtimeId, at('10:00').toISOString()],
    ]);
  });

  it('detects a candidate fully inside an existing show and an existing show fully inside a candidate', () => {
    const long = saved('10:00', 240);
    expect(conflictsOf([requested('11:00', 60)], [long])).toHaveLength(1);

    const short = saved('11:00', 60);
    expect(summary(conflictsOf([requested('10:00', 240)], [short]))).toEqual([
      [0, short.showtimeId, at('11:00').toISOString()],
    ]);
  });

  it('reports a candidate clashing with both an existing show and another candidate, sorted', () => {
    const existing = saved('09:00', 120);
    const clash = conflictsOf([requested('11:00', 120), requested('10:30', 120)], [existing]);
    expect(summary(clash)).toEqual([
      [0, existing.showtimeId, at('09:00').toISOString()],
      [0, null, at('10:30').toISOString()],
      [1, existing.showtimeId, at('09:00').toISOString()],
    ]);
  });

  it('returns the candidate as given (extra request fields included) and the index', () => {
    const candidate = requested('10:30', 90);
    const overlap = only(conflictsOf([candidate], [saved('10:00', 90)]));
    expect(overlap.candidateIndex).toBe(0);
    expect(overlap.candidate).toBe(candidate);
    expect(overlap.candidate).toHaveProperty('requested', { date: DAY, time: '10:30' });
  });

  it('only compares shows on the same screen (UUIDs case-insensitively)', () => {
    const other = saved('10:00', 120, { screenId: SCREEN_2 });
    expect(conflictsOf([requested('10:30', 90)], [other])).toEqual([]);
    expect(
      conflictsOf([requested('10:30', 90)], [{ ...other, screenId: SCREEN_1.toUpperCase() }]),
    ).toHaveLength(1);
  });

  it('ignores existing shows that clash only with each other', () => {
    const existing = [saved('10:00', 120), saved('10:30', 120)];
    expect(conflictsOf([requested('18:00', 90)], existing)).toEqual([]);
  });

  it('does not reorder or change its inputs', () => {
    const candidates = [requested('12:00', 90), requested('10:00', 90)];
    const existing = [saved('16:00', 90), saved('11:00', 90)];
    const before = structuredClone({ candidates, existing });
    conflictsOf(candidates, existing);
    expect({ candidates, existing }).toEqual(before);
  });
});

describe('findShowtimeConflicts: large batches', () => {
  /** 31 days x 12 shows of 105 min + 15 min gap: every 2 h, exactly touching, across midnight. */
  function fullMonth(): ReturnType<typeof requested>[] {
    const times = Array.from({ length: 12 }, (_, i) => `${String(i * 2).padStart(2, '0')}:00`);
    return Array.from({ length: 31 }, (_, d) => addDays(DAY, d)).flatMap((date) =>
      times.map((time) => requested(time, 105, { date })),
    );
  }

  it('finds no false positives in 372 back-to-back candidates', () => {
    const candidates = fullMonth();
    expect(candidates).toHaveLength(372);
    const sameTimesOtherScreen = candidates.map((c) => ({
      ...c,
      showtimeId: showtimeId(),
      screenId: SCREEN_2,
    }));
    expect(conflictsOf(candidates, sameTimesOtherScreen)).toEqual([]);
  });

  it('finds the single clash among 372 candidates', () => {
    const candidates = fullMonth();
    const intruder = saved('13:00', 60, { startsAt: at('13:00', addDays(DAY, 10)) });
    const clash = conflictsOf(candidates, [intruder]);
    // 12:00 show runs to 13:45 with the gap; 13:00 + 60 + 15 = 14:15 also overlaps the 14:00 show.
    const date = addDays(DAY, 10);
    expect(clash.map((o) => o.candidate.requested)).toEqual([
      { date, time: '12:00' },
      { date, time: '14:00' },
    ]);
    expect(clash.map((o) => o.conflict.showtimeId)).toEqual([
      intruder.showtimeId,
      intruder.showtimeId,
    ]);
  });

  it('reports every pair when a batch is too long for its spacing', () => {
    // 106 min + 15 gap = 121 > 120: each show clashes with the next one only.
    const candidates = fullMonth().map((c) => ({ ...c, durationMinutes: 106 }));
    const clash = conflictsOf(candidates, []);
    expect(clash).toHaveLength(371);
    expect(clash.every((o, i) => o.candidateIndex === i + 1)).toBe(true);
  });
});

describe('findShowtimeConflicts: moving a show and changing a duration', () => {
  it('a moved show replaces its own saved slot (matched by showtimeId, case-insensitively)', () => {
    const show = saved('10:00', 120);
    const moved = { ...show, startsAt: at('10:30') };
    expect(conflictsOf([moved], [show])).toEqual([]);
    expect(conflictsOf([{ ...moved, showtimeId: show.showtimeId.toUpperCase() }], [show])).toEqual(
      [],
    );
  });

  it('a moved show still clashes with the other shows', () => {
    const show = saved('10:00', 120);
    const next = saved('13:00', 120);
    const moved = { ...show, startsAt: at('11:00') };
    expect(summary(conflictsOf([moved], [show, next]))).toEqual([
      [0, next.showtimeId, at('13:00').toISOString()],
    ]);
  });

  it('a show moved to another screen is checked against that screen only', () => {
    const show = saved('10:00', 120);
    const onScreen2 = saved('10:30', 90, { screenId: SCREEN_2 });
    const moved = { ...show, screenId: SCREEN_2 };
    expect(summary(conflictsOf([moved], [show, onScreen2]))).toEqual([
      [0, onScreen2.showtimeId, at('10:30').toISOString()],
    ]);
  });

  it('a longer duration is checked by passing the movie’s shows as candidates with it', () => {
    // The movie's shows at 10:00 and 12:00 (100 min) and another movie's at 14:30.
    const first = saved('10:00', 100, { movieTitle: 'Dune' });
    const second = saved('12:00', 100, { movieTitle: 'Dune' });
    const other = saved('14:30', 90, { movieTitle: 'Zorro' });
    const existing = [first, second, other];
    const withDuration = (minutes: number) =>
      [first, second].map((show) => ({ ...show, durationMinutes: minutes }));

    // 105 min: 10:00 + 105 + 15 = 12:00 touches; 12:00 + 105 + 15 = 14:00 is fine.
    expect(conflictsOf(withDuration(105), existing)).toEqual([]);

    // 140 min: the two shows clash with each other (reported once, with the saved ID) and the
    // second runs into Zorro.
    const clash = conflictsOf(withDuration(140), existing);
    expect(summary(clash)).toEqual([
      [1, first.showtimeId, at('10:00').toISOString()],
      [1, other.showtimeId, at('14:30').toISOString()],
    ]);
    expect(clash[0]?.conflict.endsAt).toEqual(at('12:20'));
  });
});

describe('findShowtimeConflicts: programmer errors', () => {
  it.each([-1, 121, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws for gapMinutes %s',
    (gap) => {
      expect(() => conflictsOf([], [], gap)).toThrow(RangeError);
    },
  );

  it.each([0, -5, 1.5, Number.NaN])('throws for durationMinutes %s', (durationMinutes) => {
    expect(() => conflictsOf([requested('10:00', durationMinutes)], [])).toThrow(/candidates\[0\]/);
    expect(() => conflictsOf([], [saved('10:00', durationMinutes)])).toThrow(/existing\[0\]/);
  });

  it('throws for an invalid start', () => {
    expect(() =>
      conflictsOf([requested('10:00', 90, { startsAt: new Date(Number.NaN) })], []),
    ).toThrow(RangeError);
  });

  it('accepts the bounds: gap 0 and 120, duration 1', () => {
    expect(conflictsOf([requested('10:00', 1)], [], 0)).toEqual([]);
    expect(conflictsOf([requested('10:00', 1)], [], 120)).toEqual([]);
  });
});

describe('toShowtimeConflict', () => {
  it('maps a conflict to the shared response shape (ISO UTC, end without the gap)', () => {
    const existing = saved('10:00', 125, { movieTitle: 'Dune' });
    const overlap = only(conflictsOf([requested('11:00', 90)], [existing]));
    const conflict = toShowtimeConflict(overlap.conflict);
    expect(conflict).toEqual({
      showtimeId: existing.showtimeId,
      movieTitle: 'Dune',
      startsAt: '2026-11-05T04:30:00.000Z',
      endsAt: '2026-11-05T06:35:00.000Z',
    });
    expect(showtimeConflictSchema.parse(conflict)).toEqual(conflict);
  });

  it('keeps showtimeId null for a clash inside the request', () => {
    const overlap = only(conflictsOf([requested('10:00', 90), requested('10:30', 90)], []));
    const conflict = toShowtimeConflict(overlap.conflict);
    expect(conflict.showtimeId).toBeNull();
    expect(showtimeConflictSchema.safeParse(conflict).success).toBe(true);
  });
});

describe('existingShowtimeWindow', () => {
  const candidates = [requested('18:00', 120), requested('10:00', 90), requested('14:00', 150)];

  it('spans min start - (max duration + gap) to max end + gap', () => {
    const window = existingShowtimeWindow({ candidates, gapMinutes: 15 });
    expect(window).toEqual({
      from: new Date(at('10:00').getTime() - (MOVIE_DURATION_MAX_MINUTES + 15) * MINUTE),
      to: at('20:15'), // 18:00 + 120 + 15
    });
  });

  it('is tight: shows just outside cannot clash, shows just inside can', () => {
    const window = existingShowtimeWindow({ candidates, gapMinutes: 15 });
    if (!window) throw new Error('expected a window');
    const longest = MOVIE_DURATION_MAX_MINUTES;
    const startingAt = (instant: Date, durationMinutes: number) =>
      saved('00:00', durationMinutes, { startsAt: instant });

    // A longest-possible show starting at `from` ends (with the gap) exactly at 10:00: no clash.
    expect(conflictsOf(candidates, [startingAt(window.from, longest)])).toEqual([]);
    const oneLater = new Date(window.from.getTime() + MINUTE);
    expect(conflictsOf(candidates, [startingAt(oneLater, longest)])).toHaveLength(1);

    // A show starting at `to` touches the last candidate; one minute earlier clashes.
    expect(conflictsOf(candidates, [startingAt(window.to, 1)])).toEqual([]);
    const oneEarlier = new Date(window.to.getTime() - MINUTE);
    expect(conflictsOf(candidates, [startingAt(oneEarlier, 1)])).toHaveLength(1);
  });

  it('uses the gap and a custom longest existing duration', () => {
    expect(
      existingShowtimeWindow({
        candidates: [requested('10:00', 90)],
        gapMinutes: 0,
        maxExistingDurationMinutes: 240,
      }),
    ).toEqual({ from: at('06:00'), to: at('11:30') });
  });

  it('crosses Colombo midnight', () => {
    expect(
      existingShowtimeWindow({ candidates: [requested('23:00', 150)], gapMinutes: 15 }),
    ).toEqual({
      from: at('12:45'), // 23:00 - 615 min
      to: at('01:45', addDays(DAY, 1)),
    });
  });

  it('returns null for no candidates', () => {
    expect(existingShowtimeWindow({ candidates: [], gapMinutes: 15 })).toBeNull();
  });

  it('throws on an invalid gap, duration, start or longest duration', () => {
    expect(() => existingShowtimeWindow({ candidates, gapMinutes: 121 })).toThrow(RangeError);
    expect(() =>
      existingShowtimeWindow({ candidates: [requested('10:00', 0)], gapMinutes: 15 }),
    ).toThrow(RangeError);
    expect(() =>
      existingShowtimeWindow({
        candidates: [requested('10:00', 90, { startsAt: new Date(Number.NaN) })],
        gapMinutes: 15,
      }),
    ).toThrow(RangeError);
    for (const maxExistingDurationMinutes of [0, 1.5, Number.NaN]) {
      expect(() =>
        existingShowtimeWindow({ candidates, gapMinutes: 15, maxExistingDurationMinutes }),
      ).toThrow(RangeError);
    }
  });
});
