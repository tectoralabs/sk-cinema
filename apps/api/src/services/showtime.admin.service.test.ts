import { randomUUID } from 'node:crypto';
import {
  adminShowtimeListQuerySchema,
  adminShowtimeListResponseSchema,
  adminShowtimeSchema,
  DEFAULT_BMS_BASE_URL,
  MOVIE_DURATION_MAX_MINUTES,
  showtimeConflictDetailsSchema,
  showtimeConflictErrorSchema,
  showtimeCreateBodySchema,
  type AdminShowtimeListQueryInput,
  type ShowtimeCreateBodyInput,
} from '@sk-cinema/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Movie, Screen, Setting, Showtime } from '../generated/prisma/client.js';
import { MemoryCache } from '../lib/cache.js';
import { AppError } from '../lib/errors.js';
import {
  foreignKeyError,
  inMemoryAuthDb,
  testAdmin,
  testMovie,
  testScreen,
  testSetting,
  testShowtime,
} from '../test/helpers.js';
import { INVALID_BOOKING_URL_OVERRIDE } from './bmsLink.js';
import { PUBLIC_MOVIES_CACHE_PREFIX } from './movie.public.service.js';
import { createSettingsService } from './settings.service.js';
import {
  ADMIN_SHOWTIME_LIST_ORDER_BY,
  adminShowtimeListWhere,
  createShowtimeAdminService,
  SHOWTIME_IN_PAST_MESSAGE,
  SHOWTIME_MOVIE_DELETED_MESSAGE,
  SHOWTIME_MOVIE_ENDED_MESSAGE,
  SHOWTIME_MOVIE_NOT_FOUND_MESSAGE,
  SHOWTIME_NOT_FOUND_MESSAGE,
  SHOWTIME_OVERLAP_MESSAGE,
  SHOWTIME_SCREEN_DELETED_MESSAGE,
  SHOWTIME_SCREEN_INACTIVE_MESSAGE,
  SHOWTIME_SCREEN_NOT_FOUND_MESSAGE,
  SHOWTIME_TARGET_CHANGED_MESSAGE,
  toAdminShowtime,
  UNNORMALISABLE_FORMAT,
} from './showtime.admin.service.js';

/** The injected clock: 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');
const DELETED_AT = new Date('2026-10-01T00:00:00.000Z');
const CUSTOM_BASE = 'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/cinema-snlk-SKCM-MT2';
const OVERRIDE = 'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/special-premiere/20261102';
const IP = '203.0.113.7';
const UA = 'Mozilla/5.0 (showtime service test)';

/** A Colombo date + time as the UTC instant (UTC+05:30, no daylight saving). */
const colombo = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);

interface SetupOptions {
  movies?: Movie[];
  screens?: Screen[];
  /** Showtimes; `movieId` / `screenId` default to the main movie and screen. */
  showtimes?: (Partial<Showtime> & Pick<Showtime, 'startsAt'>)[];
  settings?: Setting[];
}

function setup(options: SetupOptions = {}) {
  const admin = testAdmin();
  const movie = testMovie({
    slug: 'main-feature',
    title: 'Main Feature',
    durationMinutes: 120,
    status: 'NOW_SHOWING',
  });
  const screen = testScreen({ name: 'Screen 1' });
  const db = inMemoryAuthDb({
    admins: [admin],
    movies: [movie, ...(options.movies ?? [])],
    screens: [screen, ...(options.screens ?? [])],
    showtimes: (options.showtimes ?? []).map((seed) =>
      testShowtime({ movieId: movie.id, screenId: screen.id, ...seed }),
    ),
    settings: options.settings ?? [],
  });
  const cache = new MemoryCache();
  const invalidate = vi.spyOn(cache, 'invalidatePrefix');
  const logger = { warn: vi.fn() };
  const service = createShowtimeAdminService({
    db: db.prisma,
    settings: createSettingsService({ db: db.prisma, logger }),
    cache,
    logger,
    now: () => NOW,
  });
  const actor = { adminId: admin.id, ipAddress: IP, userAgent: UA };
  return { db, cache, invalidate, logger, service, actor, movie, screen, admin };
}

type Setup = ReturnType<typeof setup>;

const body = (s: Setup, overrides: Partial<ShowtimeCreateBodyInput> = {}) =>
  showtimeCreateBodySchema.parse({
    movieId: s.movie.id,
    screenId: s.screen.id,
    date: '2026-11-02',
    time: '19:00',
    ...overrides,
  });

const create = (s: Setup, overrides: Partial<ShowtimeCreateBodyInput> = {}) =>
  s.service.create(body(s, overrides), s.actor);

const listQuery = (input: AdminShowtimeListQueryInput = {}) =>
  adminShowtimeListQuerySchema.parse(input);

const showtimeAudits = (s: Setup) => s.db.auditLogs.filter((row) => row.entity === 'Showtime');

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

/** Nothing was written: no showtime added, no audit row, the cache kept. */
function expectNothingWritten(s: Setup, showtimesBefore: number) {
  expect(s.db.showtimes).toHaveLength(showtimesBefore);
  expect(showtimeAudits(s)).toEqual([]);
  expect(s.invalidate).not.toHaveBeenCalled();
}

/** Every argument the logger got, serialised, to prove a value never appears. */
const loggedText = (s: Setup) => JSON.stringify(s.logger.warn.mock.calls);

// ---------------------------------------------------------------------------
// create: happy path
// ---------------------------------------------------------------------------

describe('showtime admin service: create', () => {
  it('stores the Colombo date + time as the UTC instant and returns the strict admin shape', async () => {
    const s = setup();

    const showtime = await create(s, { date: '2026-11-02', time: '00:30' });

    expect(adminShowtimeSchema.parse(showtime)).toEqual(showtime);
    expect(s.db.showtimes).toHaveLength(1);
    const row = s.db.showtimes[0];
    expect(row?.startsAt.toISOString()).toBe('2026-11-01T19:00:00.000Z');
    expect(row).toMatchObject({
      movieId: s.movie.id,
      screenId: s.screen.id,
      format: '2D',
      bookingUrlOverride: null,
      deletedAt: null,
    });
    expect(showtime).toEqual({
      id: row?.id,
      movie: { id: s.movie.id, title: 'Main Feature', durationMinutes: 120, status: 'NOW_SHOWING' },
      screen: { id: s.screen.id, name: 'Screen 1' },
      startsAt: '2026-11-01T19:00:00.000Z',
      endsAt: '2026-11-01T21:00:00.000Z',
      colomboDate: '2026-11-02',
      time: '00:30',
      format: '2D',
      bookingUrlOverride: null,
      bookingUrl: `${DEFAULT_BMS_BASE_URL}/20261102`,
      deletedAt: null,
      createdAt: row?.createdAt.toISOString(),
      updatedAt: row?.updatedAt.toISOString(),
    });
  });

  it('locks the movie, then the screen, before reading the settings and the showtimes', async () => {
    const s = setup();

    await create(s);

    expect(s.db.locks).toEqual([
      { table: 'Movie', id: s.movie.id },
      { table: 'Screen', id: s.screen.id },
    ]);
    const lastLock = s.db.spies.$queryRaw.mock.invocationCallOrder.at(-1) ?? Infinity;
    // One settings query (both booking settings), inside the transaction, after the locks.
    expect(s.db.spies.setting.findMany).toHaveBeenCalledTimes(1);
    expect(s.db.spies.setting.findUnique).not.toHaveBeenCalled();
    expect(s.db.spies.setting.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(lastLock);
    expect(s.db.spies.showtime.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(lastLock);
    expect(s.db.spies.$transaction).toHaveBeenCalledTimes(1);
  });

  it('writes one CREATE audit row, then drops the public cache after the commit', async () => {
    const s = setup();

    const showtime = await create(s, { bookingUrlOverride: OVERRIDE, format: ' 3d ' });

    expect(showtimeAudits(s)).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        adminId: s.admin.id,
        entity: 'Showtime',
        entityId: showtime.id,
        details: {
          movieId: s.movie.id,
          screenId: s.screen.id,
          startsAt: '2026-11-02T13:30:00.000Z',
          format: '3D',
          bookingUrlOverride: OVERRIDE,
        },
        ipAddress: IP,
        userAgent: UA,
      }),
    ]);
    expect(s.invalidate).toHaveBeenCalledExactlyOnceWith(PUBLIC_MOVIES_CACHE_PREFIX);
    const auditOrder = s.db.spies.auditLog.create.mock.invocationCallOrder.at(-1) ?? Infinity;
    expect(s.invalidate.mock.invocationCallOrder[0]).toBeGreaterThan(auditOrder);
  });

  it('stores "imax 3d" as "IMAX 3D"', async () => {
    const s = setup();

    const showtime = await create(s, { format: 'imax 3d' });

    expect(showtime.format).toBe('IMAX 3D');
    expect(s.db.showtimes[0]?.format).toBe('IMAX 3D');
  });

  it('stores the override and returns it as the booking link', async () => {
    const s = setup();

    const showtime = await create(s, { bookingUrlOverride: OVERRIDE });

    expect(s.db.showtimes[0]?.bookingUrlOverride).toBe(OVERRIDE);
    expect(showtime.bookingUrlOverride).toBe(OVERRIDE);
    expect(showtime.bookingUrl).toBe(OVERRIDE);
  });

  it('an override of null stores none', async () => {
    const s = setup();

    const showtime = await create(s, { bookingUrlOverride: null });

    expect(s.db.showtimes[0]?.bookingUrlOverride).toBeNull();
    expect(showtime.bookingUrl).toBe(`${DEFAULT_BMS_BASE_URL}/20261102`);
  });

  it('generates the link from the stored bmsBaseUrl setting', async () => {
    const s = setup({ settings: [testSetting('bmsBaseUrl', CUSTOM_BASE)] });

    const showtime = await create(s, { date: '2026-12-31', time: '23:59' });

    expect(showtime.bookingUrl).toBe(`${CUSTOM_BASE}/20261231`);
  });

  it.each([
    ['an UPCOMING movie', { status: 'UPCOMING' }],
    ['a hidden movie', { isActive: false }],
    ['a hidden UPCOMING movie', { status: 'UPCOMING', isActive: false }],
  ] as const)('allows %s (admins schedule ahead)', async (_name, overrides) => {
    const other = testMovie({ slug: 'other', title: 'Other', ...overrides });
    const s = setup({ movies: [other] });

    const showtime = await create(s, { movieId: other.id });

    expect(showtime.movie).toMatchObject({ id: other.id, status: other.status });
    expect(s.db.showtimes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// create: refused before any write
// ---------------------------------------------------------------------------

describe('showtime admin service: create refusals', () => {
  it('400 on body.time for a start at or before now', async () => {
    for (const [date, time] of [
      ['2026-11-01', '15:30'], // exactly now
      ['2026-11-01', '15:29'],
      ['2026-10-31', '23:00'],
    ] as const) {
      const s = setup();
      const error = await rejection(create(s, { date, time }));
      expect(error).toMatchObject({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: SHOWTIME_IN_PAST_MESSAGE,
        details: [{ path: ['body', 'time'], message: SHOWTIME_IN_PAST_MESSAGE }],
      });
      expectNothingWritten(s, 0);
    }
  });

  it('a start one minute after now is allowed', async () => {
    const s = setup();
    await expect(create(s, { date: '2026-11-01', time: '15:31' })).resolves.toMatchObject({
      startsAt: '2026-11-01T10:01:00.000Z',
    });
  });

  it('404 on body.movieId for an unknown movie; 404 on body.screenId for an unknown screen', async () => {
    const s = setup();
    expect(await rejection(create(s, { movieId: randomUUID() }))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: SHOWTIME_MOVIE_NOT_FOUND_MESSAGE,
      details: [{ path: ['body', 'movieId'], message: SHOWTIME_MOVIE_NOT_FOUND_MESSAGE }],
    });
    expect(await rejection(create(s, { screenId: randomUUID() }))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: SHOWTIME_SCREEN_NOT_FOUND_MESSAGE,
      details: [{ path: ['body', 'screenId'], message: SHOWTIME_SCREEN_NOT_FOUND_MESSAGE }],
    });
    expectNothingWritten(s, 0);
  });

  it.each([
    ['a soft-deleted movie', 'movieId', { deletedAt: DELETED_AT }, SHOWTIME_MOVIE_DELETED_MESSAGE],
    ['an ENDED movie', 'movieId', { status: 'ENDED' }, SHOWTIME_MOVIE_ENDED_MESSAGE],
    [
      'an ENDED, soft-deleted movie (deleted wins)',
      'movieId',
      { status: 'ENDED', deletedAt: DELETED_AT },
      SHOWTIME_MOVIE_DELETED_MESSAGE,
    ],
  ] as const)('409 on body.movieId for %s', async (_name, field, overrides, message) => {
    const other = testMovie({ slug: 'other', title: 'Other', ...overrides });
    const s = setup({ movies: [other] });

    const error = await rejection(create(s, { movieId: other.id }));

    expect(error).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message,
      details: [{ path: ['body', field], message }],
    });
    expectNothingWritten(s, 0);
  });

  it.each([
    ['a soft-deleted screen', { deletedAt: DELETED_AT }, SHOWTIME_SCREEN_DELETED_MESSAGE],
    ['a hidden screen', { isActive: false }, SHOWTIME_SCREEN_INACTIVE_MESSAGE],
    [
      'a hidden, soft-deleted screen (deleted wins)',
      { isActive: false, deletedAt: DELETED_AT },
      SHOWTIME_SCREEN_DELETED_MESSAGE,
    ],
  ] as const)('409 on body.screenId for %s', async (_name, overrides, message) => {
    const other = testScreen({ name: 'Screen 2', ...overrides });
    const s = setup({ screens: [other] });

    const error = await rejection(create(s, { screenId: other.id }));

    expect(error).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message,
      details: [{ path: ['body', 'screenId'], message }],
    });
    expectNothingWritten(s, 0);
  });

  it('checks the movie before the screen, and both before the clock', async () => {
    const s = setup();
    const past = { date: '2026-10-01', time: '10:00' };
    expect(
      await rejection(create(s, { movieId: randomUUID(), screenId: randomUUID(), ...past })),
    ).toMatchObject({ status: 404, message: SHOWTIME_MOVIE_NOT_FOUND_MESSAGE });
    expect(await rejection(create(s, { screenId: randomUUID(), ...past }))).toMatchObject({
      status: 404,
      message: SHOWTIME_SCREEN_NOT_FOUND_MESSAGE,
    });
  });
});

// ---------------------------------------------------------------------------
// create: overlaps on the same screen
// ---------------------------------------------------------------------------

describe('showtime admin service: create overlap check', () => {
  /** The existing show: 2026-11-02 19:00-21:00 Colombo (120 minutes) on Screen 1. */
  const EXISTING_START = colombo('2026-11-02', '19:00');

  async function expectConflict(s: Setup, time: string, existing: Showtime[]) {
    const before = s.db.showtimes.length;
    const error = await rejection(create(s, { date: '2026-11-02', time }));
    expect(error.status).toBe(409);
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toBe(SHOWTIME_OVERLAP_MESSAGE);
    const details = showtimeConflictDetailsSchema.parse(error.details);
    expect(
      showtimeConflictErrorSchema.parse({
        error: { code: error.code, message: error.message, details: error.details },
      }),
    ).toBeTruthy();
    expect(details.map((d) => d.conflict.showtimeId)).toEqual(existing.map((row) => row.id));
    for (const detail of details) {
      expect(detail.path).toEqual(['body', 'time']);
      expect(detail.requested).toEqual({ date: '2026-11-02', time });
    }
    expectNothingWritten(s, before);
    return details;
  }

  it('409 for exactly the same start, with the conflict details', async () => {
    const s = setup();
    const existing = s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: EXISTING_START,
    });

    const [detail] = await expectConflict(s, '19:00', [existing]);

    expect(detail).toEqual({
      path: ['body', 'time'],
      message: 'Overlaps "Main Feature" (19:00–21:00), counting the 15-minute gap between shows',
      requested: { date: '2026-11-02', time: '19:00' },
      conflict: {
        showtimeId: existing.id,
        movieTitle: 'Main Feature',
        startsAt: '2026-11-02T13:30:00.000Z',
        endsAt: '2026-11-02T15:30:00.000Z',
      },
    });
  });

  // Existing 19:00 + 120 minutes = 21:00, then the gap. The new show is 120 minutes too.
  it.each([
    // [gap, new start, conflicts?]
    [15, '21:14', true],
    [15, '21:15', false], // touching: end + gap == start
    [15, '16:46', true], // the new show + gap runs into 19:00
    [15, '16:45', false],
    [0, '20:59', true],
    [0, '21:00', false],
    [0, '17:00', false],
    [0, '17:01', true],
    [120, '22:59', true],
    [120, '23:00', false],
    [120, '15:01', true],
    [120, '15:00', false],
  ] as const)('gap %i: a show at %s conflicts: %s', async (gap, time, conflicts) => {
    const s = setup({ settings: [testSetting('showGapMinutes', String(gap))] });
    const existing = s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: EXISTING_START,
    });

    if (conflicts) {
      const [detail] = await expectConflict(s, time, [existing]);
      expect(detail?.message).toBe(
        gap > 0
          ? `Overlaps "Main Feature" (19:00–21:00), counting the ${String(gap)}-minute gap between shows`
          : 'Overlaps "Main Feature" (19:00–21:00)',
      );
    } else {
      await expect(create(s, { date: '2026-11-02', time })).resolves.toMatchObject({
        time,
      });
      expect(s.db.showtimes).toHaveLength(2);
    }
  });

  it('uses the default 15-minute gap when no setting row exists', async () => {
    const s = setup();
    const existing = s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: EXISTING_START,
    });
    await expectConflict(s, '21:14', [existing]);
    await expect(create(s, { time: '21:15' })).resolves.toBeTruthy();
  });

  it('a long existing movie that started earlier still blocks the screen', async () => {
    const epic = testMovie({ slug: 'epic', title: 'Epic', durationMinutes: 300 });
    const s = setup({ movies: [epic] });
    const existing = s.db.addShowtime({
      movieId: epic.id,
      screenId: s.screen.id,
      startsAt: colombo('2026-11-02', '14:00'),
    });

    const [detail] = await expectConflict(s, '18:00', [existing]);

    expect(detail?.conflict).toMatchObject({
      movieTitle: 'Epic',
      endsAt: '2026-11-02T13:30:00.000Z',
    });
    // 14:00 + 300 = 19:00, + 15 gap = 19:15.
    await expect(create(s, { time: '19:15' })).resolves.toBeTruthy();
  });

  it('reports every show the new one overlaps, in start order', async () => {
    const s = setup({ settings: [testSetting('showGapMinutes', '0')] });
    const later = s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: colombo('2026-11-02', '19:30'),
    });
    const earlier = s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: colombo('2026-11-02', '17:00'),
    });

    await expectConflict(s, '18:00', [earlier, later]);
  });

  it('a show on a different screen does not conflict', async () => {
    const screen2 = testScreen({ name: 'Screen 2' });
    const s = setup({ screens: [screen2] });
    s.db.addShowtime({ movieId: s.movie.id, screenId: screen2.id, startsAt: EXISTING_START });

    await expect(create(s, { time: '19:00' })).resolves.toBeTruthy();
    expect(s.db.showtimes).toHaveLength(2);
  });

  it('a soft-deleted show does not conflict', async () => {
    const s = setup();
    s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: EXISTING_START,
      deletedAt: DELETED_AT,
    });

    await expect(create(s, { time: '19:00' })).resolves.toBeTruthy();
  });

  it.each([
    ['soft-deleted', { deletedAt: DELETED_AT }],
    ['hidden', { isActive: false }],
    ['ENDED', { status: 'ENDED' }],
  ] as const)('a live show of a %s movie still occupies the screen', async (_name, overrides) => {
    const other = testMovie({ slug: 'other', title: 'Other', ...overrides });
    const s = setup({ movies: [other] });
    const existing = s.db.addShowtime({
      movieId: other.id,
      screenId: s.screen.id,
      startsAt: EXISTING_START,
    });

    const [detail] = await expectConflict(s, '20:00', [existing]);
    expect(detail?.conflict.movieTitle).toBe('Other');
  });

  it('two OTHER shows that clash with each other under the current gap do not block a valid show', async () => {
    // Saved under a 0-minute gap: 19:00-21:00 and 21:05-23:05. With today's 15-minute gap
    // they clash with each other, but a gap change only applies to shows created later.
    const s = setup({ settings: [testSetting('showGapMinutes', '15')] });
    s.db.addShowtime({ movieId: s.movie.id, screenId: s.screen.id, startsAt: EXISTING_START });
    s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: colombo('2026-11-02', '21:05'),
    });

    // 23:05 + 15 = 23:20: touching the second show is fine.
    const showtime = await create(s, { time: '23:20' });

    expect(showtime.time).toBe('23:20');
    expect(s.db.showtimes).toHaveLength(3);
    expect(showtimeAudits(s)).toHaveLength(1);
  });

  it('a past show still occupies the screen (a new show right after it)', async () => {
    const s = setup();
    // Started 14:30 Colombo today (before now, 15:30), ends 16:30, + 15 gap.
    const existing = s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: colombo('2026-11-01', '14:30'),
    });
    const error = await rejection(create(s, { date: '2026-11-01', time: '16:00' }));
    expect(error.status).toBe(409);
    expect(showtimeConflictDetailsSchema.parse(error.details)[0]?.conflict.showtimeId).toBe(
      existing.id,
    );
    await expect(create(s, { date: '2026-11-01', time: '16:45' })).resolves.toBeTruthy();
  });

  it('queries only live shows on the screen within the window that can clash', async () => {
    const s = setup();

    await create(s, { time: '19:00' });

    const [args] = s.db.spies.showtime.findMany.mock.calls[0] ?? [];
    expect(args).toMatchObject({
      where: {
        screenId: { in: [s.screen.id] },
        deletedAt: null,
        // 19:00 Colombo minus (the longest possible movie + gap); end + gap.
        startsAt: {
          gte: new Date(
            Date.parse('2026-11-02T13:30:00.000Z') - (MOVIE_DURATION_MAX_MINUTES + 15) * 60_000,
          ),
          lt: new Date('2026-11-02T15:45:00.000Z'),
        },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// create: database failures
// ---------------------------------------------------------------------------

describe('showtime admin service: create failures', () => {
  it('rolls back the insert when the audit write fails, and keeps the cache', async () => {
    const s = setup();
    const failure = new Error('audit insert failed');
    s.db.injectFault('auditLog', 'create', { error: failure });

    await expect(create(s)).rejects.toBe(failure);

    expectNothingWritten(s, 0);
  });

  it('propagates an insert failure unchanged (a generic 500 at the edge)', async () => {
    const s = setup();
    const failure = new Error('insert failed');
    s.db.injectFault('showtime', 'create', { error: failure });

    await expect(create(s)).rejects.toBe(failure);
    expectNothingWritten(s, 0);
  });

  it('propagates a lock failure unchanged', async () => {
    const s = setup();
    const failure = new Error('lock timeout');
    s.db.injectFault('$queryRaw', 'lock', { error: failure });

    await expect(create(s)).rejects.toBe(failure);
    expectNothingWritten(s, 0);
  });

  it('a foreign-key failure on the insert is a 409 "changed", never a 500', async () => {
    const s = setup();
    s.db.injectFault('showtime', 'create', { error: foreignKeyError('showtime', 'movieId') });

    const error = await rejection(create(s));

    expect(error).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: SHOWTIME_TARGET_CHANGED_MESSAGE,
    });
    expectNothingWritten(s, 0);
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('adminShowtimeListWhere', () => {
  it('defaults: live, future only', () => {
    expect(adminShowtimeListWhere(listQuery(), NOW)).toEqual({
      deletedAt: null,
      startsAt: { gt: NOW },
    });
  });

  it('from / to are Colombo days: [from 00:00, to + 1 day 00:00) in Colombo', () => {
    expect(
      adminShowtimeListWhere(
        listQuery({
          from: '2026-11-02',
          to: '2026-11-03',
          includePast: 'true',
          deleted: 'include',
        }),
        NOW,
      ),
    ).toEqual({
      startsAt: {
        gte: new Date('2026-11-01T18:30:00.000Z'),
        lt: new Date('2026-11-03T18:30:00.000Z'),
      },
    });
  });

  it('combines every filter', () => {
    const movieId = randomUUID();
    const screenId = randomUUID();
    expect(
      adminShowtimeListWhere(
        listQuery({ movieId, screenId, deleted: 'only', from: '2026-10-01' }),
        NOW,
      ),
    ).toEqual({
      movieId,
      screenId,
      deletedAt: { not: null },
      startsAt: { gt: NOW, gte: new Date('2026-09-30T18:30:00.000Z') },
    });
  });

  it('sorts by start, then id', () => {
    expect(ADMIN_SHOWTIME_LIST_ORDER_BY).toEqual([{ startsAt: 'asc' }, { id: 'asc' }]);
  });
});

describe('showtime admin service: list', () => {
  /** Past (14:30 today), future today (19:00), tomorrow 00:30, tomorrow 23:59, day after 00:00. */
  function seeded() {
    const screen2 = testScreen({ name: 'Screen 2' });
    const other = testMovie({ slug: 'other', title: 'Other', durationMinutes: 90 });
    const s = setup({ screens: [screen2], movies: [other] });
    const add = (startsAt: Date, extra: Partial<Showtime> = {}) =>
      s.db.addShowtime({ movieId: s.movie.id, screenId: s.screen.id, startsAt, ...extra });
    const rows = {
      past: add(colombo('2026-11-01', '14:30')),
      today: add(colombo('2026-11-01', '19:00')),
      tomorrowEarly: add(colombo('2026-11-02', '00:30')),
      tomorrowLate: add(colombo('2026-11-02', '23:59'), { screenId: screen2.id }),
      dayAfter: add(colombo('2026-11-03', '00:00'), { movieId: other.id }),
      deleted: add(colombo('2026-11-02', '12:00'), { deletedAt: DELETED_AT }),
    };
    return { ...s, rows, screen2, other };
  }

  const ids = (items: { id: string }[]) => items.map((item) => item.id);

  it('defaults to live, future showtimes in start order, in the strict response shape', async () => {
    const s = seeded();

    const page = await s.service.list(listQuery());

    expect(adminShowtimeListResponseSchema.parse(page)).toEqual(page);
    expect(ids(page.items)).toEqual([
      s.rows.today.id,
      s.rows.tomorrowEarly.id,
      s.rows.tomorrowLate.id,
      s.rows.dayAfter.id,
    ]);
    expect(page).toMatchObject({ page: 1, pageSize: 20, total: 4 });
  });

  it('includePast adds past showtimes', async () => {
    const s = seeded();
    const page = await s.service.list(listQuery({ includePast: 'true' }));
    expect(ids(page.items)[0]).toBe(s.rows.past.id);
    expect(page.total).toBe(5);
  });

  it('from / to select Colombo days: a 00:30 show is listed under its Colombo date', async () => {
    const s = seeded();

    const nov2 = await s.service.list(listQuery({ from: '2026-11-02', to: '2026-11-02' }));
    expect(ids(nov2.items)).toEqual([s.rows.tomorrowEarly.id, s.rows.tomorrowLate.id]);
    expect(nov2.items.map((item) => item.colomboDate)).toEqual(['2026-11-02', '2026-11-02']);

    const nov1 = await s.service.list(listQuery({ from: '2026-11-01', to: '2026-11-01' }));
    expect(ids(nov1.items)).toEqual([s.rows.today.id]);

    const nov3 = await s.service.list(listQuery({ from: '2026-11-03' }));
    expect(ids(nov3.items)).toEqual([s.rows.dayAfter.id]);

    const untilNov1 = await s.service.list(listQuery({ to: '2026-11-01', includePast: 'true' }));
    expect(ids(untilNov1.items)).toEqual([s.rows.past.id, s.rows.today.id]);
  });

  it('past showtimes stay hidden even when from is in the past, unless includePast', async () => {
    const s = seeded();
    const q = { from: '2026-11-01', to: '2026-11-01' };
    expect(ids((await s.service.list(listQuery(q))).items)).toEqual([s.rows.today.id]);
    expect(ids((await s.service.list(listQuery({ ...q, includePast: 'true' }))).items)).toEqual([
      s.rows.past.id,
      s.rows.today.id,
    ]);
  });

  it('filters by movie and by screen', async () => {
    const s = seeded();
    expect(ids((await s.service.list(listQuery({ movieId: s.other.id }))).items)).toEqual([
      s.rows.dayAfter.id,
    ]);
    expect(ids((await s.service.list(listQuery({ screenId: s.screen2.id }))).items)).toEqual([
      s.rows.tomorrowLate.id,
    ]);
    expect((await s.service.list(listQuery({ movieId: randomUUID() }))).items).toEqual([]);
  });

  it('deleted=only / include', async () => {
    const s = seeded();
    const only = await s.service.list(listQuery({ deleted: 'only' }));
    expect(ids(only.items)).toEqual([s.rows.deleted.id]);
    expect(only.items[0]?.deletedAt).toBe(DELETED_AT.toISOString());
    const all = await s.service.list(listQuery({ deleted: 'include', includePast: 'true' }));
    expect(all.total).toBe(6);
  });

  it('pages with a stable order (same start: by id)', async () => {
    const s = seeded();
    const sameStart = s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen2.id,
      startsAt: colombo('2026-11-01', '19:00'),
    });

    const first = await s.service.list(listQuery({ pageSize: '2' }));
    const second = await s.service.list(listQuery({ pageSize: '2', page: '2' }));
    const third = await s.service.list(listQuery({ pageSize: '2', page: '3' }));

    const expected = [s.rows.today.id, sameStart.id].sort();
    expect(ids(first.items)).toEqual(expected);
    expect(ids(second.items)).toEqual([s.rows.tomorrowEarly.id, s.rows.tomorrowLate.id]);
    expect(ids(third.items)).toEqual([s.rows.dayAfter.id]);
    expect([first.total, second.total, third.total]).toEqual([5, 5, 5]);
    expect(second).toMatchObject({ page: 2, pageSize: 2 });
  });

  it('reads the settings once per request, not per row', async () => {
    const s = seeded();
    vi.clearAllMocks();

    const page = await s.service.list(listQuery({ includePast: 'true' }));

    expect(page.items.length).toBeGreaterThan(1);
    expect(s.db.spies.setting.findMany).toHaveBeenCalledTimes(1);
    expect(s.db.spies.setting.findUnique).not.toHaveBeenCalled();
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
  });

  it('maps every row: endsAt from the movie duration, Colombo date and time, generated links', async () => {
    const s = seeded();
    const page = await s.service.list(listQuery());
    const dayAfter = page.items.find((item) => item.id === s.rows.dayAfter.id);
    expect(dayAfter).toMatchObject({
      movie: { id: s.other.id, title: 'Other', durationMinutes: 90 },
      startsAt: '2026-11-02T18:30:00.000Z',
      endsAt: '2026-11-02T20:00:00.000Z',
      colomboDate: '2026-11-03',
      time: '00:00',
      bookingUrl: `${DEFAULT_BMS_BASE_URL}/20261103`,
    });
  });

  it('never caches: a new showtime is listed straight away', async () => {
    const s = seeded();
    await s.service.list(listQuery());
    const added = await create(s, { time: '10:00', date: '2026-11-03' });
    expect(ids((await s.service.list(listQuery())).items)).toContain(added.id);
  });
});

// ---------------------------------------------------------------------------
// Stored values that need care in responses
// ---------------------------------------------------------------------------

describe('showtime admin service: stored formats and overrides', () => {
  it('normalises a stored "2d" to "2D" without a warning', async () => {
    const s = setup({ showtimes: [{ startsAt: colombo('2026-11-02', '19:00'), format: '2d' }] });

    const page = await s.service.list(listQuery());

    expect(page.items[0]?.format).toBe('2D');
    expect(s.logger.warn).not.toHaveBeenCalled();
  });

  it('a stored "2D/3D" becomes null with exactly one warning: the id and reason, never the value', async () => {
    const s = setup({ showtimes: [{ startsAt: colombo('2026-11-02', '19:00'), format: '2D/3D' }] });
    const id = s.db.showtimes[0]?.id ?? '';

    const page = await s.service.list(listQuery());

    expect(page.items[0]?.format).toBeNull();
    expect(adminShowtimeListResponseSchema.parse(page)).toEqual(page);
    expect(s.logger.warn).toHaveBeenCalledTimes(1);
    expect(s.logger.warn).toHaveBeenCalledWith(
      { showtimeId: id, reason: UNNORMALISABLE_FORMAT },
      expect.any(String),
    );
    expect(loggedText(s)).not.toContain('2D/3D');
    expect(loggedText(s)).not.toContain('3D');
  });

  it('an invalid stored override falls back to the generated link, warning without the URL', async () => {
    const evil = 'https://evil.example/buytickets/x';
    const s = setup({
      showtimes: [{ startsAt: colombo('2026-11-02', '19:00'), bookingUrlOverride: evil }],
    });
    const id = s.db.showtimes[0]?.id ?? '';

    const showtime = await s.service.getById(id);

    expect(showtime.bookingUrl).toBe(`${DEFAULT_BMS_BASE_URL}/20261102`);
    // The stored value is still shown to admins so they can fix it.
    expect(showtime.bookingUrlOverride).toBe(evil);
    expect(s.logger.warn).toHaveBeenCalledExactlyOnceWith(
      { showtimeId: id, reason: INVALID_BOOKING_URL_OVERRIDE },
      expect.any(String),
    );
    expect(loggedText(s)).not.toContain('evil');
  });

  it('toAdminShowtime: a deleted showtime keeps its fields; deletedAt as ISO', () => {
    const s = setup();
    const row = {
      ...testShowtime({
        movieId: s.movie.id,
        screenId: s.screen.id,
        deletedAt: DELETED_AT,
        format: 'IMAX 3D',
      }),
      movie: {
        id: s.movie.id,
        title: 'Main Feature',
        durationMinutes: 95,
        status: 'ENDED' as const,
      },
      screen: { id: s.screen.id, name: 'Screen 1' },
    };
    const showtime = toAdminShowtime(row, CUSTOM_BASE, s.logger);
    expect(adminShowtimeSchema.parse(showtime)).toEqual(showtime);
    expect(showtime).toMatchObject({
      startsAt: '2026-11-01T13:30:00.000Z',
      endsAt: '2026-11-01T15:05:00.000Z',
      colomboDate: '2026-11-01',
      time: '19:00',
      format: 'IMAX 3D',
      bookingUrl: `${CUSTOM_BASE}/20261101`,
      deletedAt: DELETED_AT.toISOString(),
    });
  });
});

// ---------------------------------------------------------------------------
// getById
// ---------------------------------------------------------------------------

describe('showtime admin service: getById', () => {
  it('returns any showtime: past and soft-deleted ones too', async () => {
    const s = setup({
      showtimes: [
        { startsAt: colombo('2026-10-01', '19:00') },
        { startsAt: colombo('2026-11-05', '19:00'), deletedAt: DELETED_AT },
      ],
    });
    for (const row of s.db.showtimes) {
      const showtime = await s.service.getById(row.id);
      expect(adminShowtimeSchema.parse(showtime)).toEqual(showtime);
      expect(showtime.id).toBe(row.id);
    }
    expect(s.db.spies.setting.findMany).toHaveBeenCalledTimes(2);
  });

  it('404 for an unknown id', async () => {
    const s = setup();
    expect(await rejection(s.service.getById(randomUUID()))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: SHOWTIME_NOT_FOUND_MESSAGE,
    });
  });
});
