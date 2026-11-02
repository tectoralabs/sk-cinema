import { randomUUID } from 'node:crypto';
import {
  adminShowtimeListQuerySchema,
  adminShowtimeListResponseSchema,
  adminShowtimeSchema,
  DEFAULT_BMS_BASE_URL,
  MOVIE_DURATION_MAX_MINUTES,
  SHOWTIME_BULK_MAX_DETAILS,
  showtimeBulkCreateBodySchema,
  showtimeBulkCreateResponseSchema,
  showtimeConflictDetailsSchema,
  showtimeConflictErrorSchema,
  showtimeCreateBodySchema,
  showtimeBulkDeleteBodySchema,
  showtimeBulkDeleteResponseSchema,
  showtimePastSlotErrorSchema,
  showtimeUpdateBodySchema,
  type AdminShowtimeListQueryInput,
  type ShowtimeBulkCreateBodyInput,
  type ShowtimeCreateBodyInput,
  type ShowtimeUpdateBodyInput,
} from '@sk-cinema/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Movie, Screen, Setting, Showtime } from '../generated/prisma/client.js';
import { MemoryCache } from '../lib/cache.js';
import { AppError } from '../lib/errors.js';
import { UNNORMALISABLE_FORMAT } from '../lib/showtimeFormat.js';
import {
  foreignKeyError,
  inMemoryAuthDb,
  recordNotFoundError,
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
  expandBulkSlots,
  showtimeBulkDeleteAlreadyDeletedMessage,
  showtimeBulkDeleteNotFoundMessage,
  showtimeBulkOverlapMessage,
  showtimeBulkPastMessage,
  SHOWTIME_ALREADY_DELETED_MESSAGE,
  SHOWTIME_BULK_DELETE_CHANGED_MESSAGE,
  SHOWTIME_BULK_DELETE_DELETED_ID_MESSAGE,
  SHOWTIME_BULK_DELETE_UNKNOWN_ID_MESSAGE,
  SHOWTIME_CHANGED_MESSAGE,
  SHOWTIME_DELETED_MESSAGE,
  SHOWTIME_IN_PAST_MESSAGE,
  SHOWTIME_MOVIE_DELETED_MESSAGE,
  SHOWTIME_MOVIE_ENDED_MESSAGE,
  SHOWTIME_MOVIE_NOT_FOUND_MESSAGE,
  SHOWTIME_MOVE_MOVIE_DELETED_MESSAGE,
  SHOWTIME_MOVE_MOVIE_ENDED_MESSAGE,
  SHOWTIME_MOVE_SCREEN_DELETED_MESSAGE,
  SHOWTIME_MOVE_SCREEN_INACTIVE_MESSAGE,
  SHOWTIME_NOT_FOUND_MESSAGE,
  SHOWTIME_OVERLAP_MESSAGE,
  SHOWTIME_SCREEN_DELETED_MESSAGE,
  SHOWTIME_SCREEN_INACTIVE_MESSAGE,
  SHOWTIME_SCREEN_NOT_FOUND_MESSAGE,
  SHOWTIME_SLOT_IN_PAST_MESSAGE,
  SHOWTIME_STARTED_MESSAGE,
  SHOWTIME_TARGET_CHANGED_MESSAGE,
  toAdminShowtime,
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
  /** The service's clock. Default: always NOW. */
  now?: () => Date;
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
    now: options.now ?? (() => NOW),
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
  it('to=2099-12-31 ends at the Colombo midnight of 2100-01-01, no RangeError', () => {
    const where = adminShowtimeListWhere(listQuery({ to: '2099-12-31', includePast: 'true' }), NOW);
    expect(where.startsAt).toEqual({ lt: new Date('2099-12-31T18:30:00.000Z') });
  });

  it('from=2020-01-01 starts at the Colombo midnight of that date', () => {
    const where = adminShowtimeListWhere(
      listQuery({ from: '2020-01-01', includePast: 'true' }),
      NOW,
    );
    expect(where.startsAt).toEqual({ gte: new Date('2019-12-31T18:30:00.000Z') });
  });

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

// ---------------------------------------------------------------------------
// bulk create
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bulkBody = (s: Setup, overrides: Partial<ShowtimeBulkCreateBodyInput> = {}) =>
  showtimeBulkCreateBodySchema.parse({
    movieId: s.movie.id,
    screenId: s.screen.id,
    dateFrom: '2026-11-02',
    dateTo: '2026-11-08',
    times: ['18:00', '10:00', '14:00'],
    ...overrides,
  });

const bulkCreate = (s: Setup, overrides: Partial<ShowtimeBulkCreateBodyInput> = {}) =>
  s.service.bulkCreate(bulkBody(s, overrides), s.actor);

/** The audit `details` of a bulk-created row. */
const auditDetails = (row: { details: unknown }) => row.details as Record<string, unknown>;

describe('expandBulkSlots', () => {
  it('every date (inclusive) at every time, by date then by the order of times', () => {
    const slots = expandBulkSlots({
      dateFrom: '2026-11-30',
      dateTo: '2026-12-01',
      times: ['18:00', '00:30'],
    });
    expect(
      slots.map((slot) => [slot.date, slot.time, slot.timeIndex, slot.startsAt.toISOString()]),
    ).toEqual([
      ['2026-11-30', '18:00', 0, '2026-11-30T12:30:00.000Z'],
      ['2026-11-30', '00:30', 1, '2026-11-29T19:00:00.000Z'],
      ['2026-12-01', '18:00', 0, '2026-12-01T12:30:00.000Z'],
      ['2026-12-01', '00:30', 1, '2026-11-30T19:00:00.000Z'],
    ]);
  });

  it('a single day; 31 days x 12 times is 372 slots', () => {
    expect(
      expandBulkSlots({ dateFrom: '2026-11-02', dateTo: '2026-11-02', times: ['10:00'] }),
    ).toHaveLength(1);
    const times = Array.from({ length: 12 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
    expect(expandBulkSlots({ dateFrom: '2026-12-01', dateTo: '2026-12-31', times })).toHaveLength(
      372,
    );
  });

  it('a range ending on the last allowed date, no RangeError', () => {
    const slots = expandBulkSlots({
      dateFrom: '2099-12-30',
      dateTo: '2099-12-31',
      times: ['23:59'],
    });
    expect(slots.map((slot) => [slot.date, slot.startsAt.toISOString()])).toEqual([
      ['2099-12-30', '2099-12-30T18:29:00.000Z'],
      ['2099-12-31', '2099-12-31T18:29:00.000Z'],
    ]);
  });

  it('throws RangeError for a range the body schema refuses', () => {
    expect(() =>
      expandBulkSlots({ dateFrom: '2026-11-02', dateTo: '2026-11-01', times: ['10:00'] }),
    ).toThrow(RangeError);
    expect(() =>
      expandBulkSlots({ dateFrom: '2026-12-01', dateTo: '2027-01-01', times: ['10:00'] }),
    ).toThrow(RangeError);
  });
});

describe('showtime admin service: bulkCreate, a slot passing while it waits on the locks', () => {
  /** Every call before the lock sees NOW; the lock moves the clock on to `after`. */
  function setupWaiting(after: Date) {
    let clock = NOW;
    const s = setup({ now: () => clock });
    s.db.injectFault('$queryRaw', 'lock', {
      before: () => {
        clock = after;
      },
    });
    return s;
  }

  it('400 with the slots that passed, the same error as before the lock; nothing written', async () => {
    const s = setupWaiting(colombo('2026-11-02', '10:00'));

    const error = await rejection(
      bulkCreate(s, { dateTo: '2026-11-02', times: ['18:00', '10:00', '09:59'] }),
    );

    expect(error).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: showtimeBulkPastMessage(2),
    });
    expect(error.details).toEqual([
      {
        path: ['body', 'times', 1],
        message: SHOWTIME_SLOT_IN_PAST_MESSAGE,
        requested: { date: '2026-11-02', time: '10:00' },
      },
      {
        path: ['body', 'times', 2],
        message: SHOWTIME_SLOT_IN_PAST_MESSAGE,
        requested: { date: '2026-11-02', time: '09:59' },
      },
    ]);
    expect(s.db.spies.showtime.createMany).not.toHaveBeenCalled();
    expect(s.db.spies.setting.findMany).not.toHaveBeenCalled();
    expectNothingWritten(s, 0);
  });

  it('still goes through when every slot is after the moved clock', async () => {
    const s = setupWaiting(colombo('2026-11-02', '09:59'));

    const { created } = await bulkCreate(s, { dateTo: '2026-11-02', times: ['10:00'] });

    expect(created).toBe(1);
  });

  it('a past slot before the lock still wins over a 404: the first check keeps the order', async () => {
    const s = setup();

    const error = await rejection(
      s.service.bulkCreate(
        bulkBody(s, {
          movieId: randomUUID(),
          dateFrom: '2026-11-01',
          dateTo: '2026-11-01',
          times: ['10:00'],
        }),
        s.actor,
      ),
    );

    expect(error).toMatchObject({ status: 400, message: showtimeBulkPastMessage(1) });
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
  });
});

describe('showtime admin service: bulkCreate', () => {
  it('7 days x 3 times: 21 rows, sorted strict response, 21 CREATE audits sharing one batchId', async () => {
    const s = setup();

    const result = await bulkCreate(s);

    expect(showtimeBulkCreateResponseSchema.parse(result)).toEqual(result);
    expect(result.created).toBe(21);
    expect(s.db.showtimes).toHaveLength(21);
    const starts = result.items.map((item) => item.startsAt);
    expect(starts).toEqual([...starts].sort());
    expect(result.items[0]).toMatchObject({ colomboDate: '2026-11-02', time: '10:00' });
    expect(result.items.at(-1)).toMatchObject({ colomboDate: '2026-11-08', time: '18:00' });
    // Every item is a stored row, and every row is returned once.
    expect(new Set(result.items.map((item) => item.id))).toEqual(
      new Set(s.db.showtimes.map((row) => row.id)),
    );
    for (const item of result.items) {
      expect(item).toMatchObject({
        movie: { id: s.movie.id, title: 'Main Feature', durationMinutes: 120 },
        screen: { id: s.screen.id, name: 'Screen 1' },
        format: '2D',
        bookingUrlOverride: null,
        bookingUrl: `${DEFAULT_BMS_BASE_URL}/${item.colomboDate.replaceAll('-', '')}`,
        deletedAt: null,
      });
    }

    const audits = showtimeAudits(s);
    expect(audits).toHaveLength(21);
    const batchIds = new Set(audits.map((row) => auditDetails(row)['batchId']));
    expect(batchIds.size).toBe(1);
    const [batchId] = [...batchIds];
    expect(batchId).toMatch(UUID_RE);
    expect(new Set(audits.map((row) => row.entityId))).toEqual(
      new Set(result.items.map((item) => item.id)),
    );
    for (const row of audits) {
      const stored = s.db.showtimes.find((st) => st.id === row.entityId);
      expect(row).toMatchObject({
        action: 'CREATE',
        adminId: s.admin.id,
        entity: 'Showtime',
        ipAddress: IP,
        userAgent: UA,
        details: {
          movieId: s.movie.id,
          screenId: s.screen.id,
          startsAt: stored?.startsAt.toISOString(),
          format: '2D',
          bookingUrlOverride: null,
          batchId,
        },
      });
    }
  });

  it('one transaction: locks [Movie, Screen] once, one settings read, one insert, one audit insert, then the cache', async () => {
    const s = setup();

    await bulkCreate(s);

    expect(s.db.spies.$transaction).toHaveBeenCalledTimes(1);
    expect(s.db.locks).toEqual([
      { table: 'Movie', id: s.movie.id },
      { table: 'Screen', id: s.screen.id },
    ]);
    expect(s.db.spies.setting.findMany).toHaveBeenCalledTimes(1);
    expect(s.db.spies.showtime.createMany).toHaveBeenCalledTimes(1);
    expect(s.db.spies.showtime.create).not.toHaveBeenCalled();
    expect(s.db.spies.auditLog.createMany).toHaveBeenCalledTimes(1);
    expect(s.db.spies.auditLog.create).not.toHaveBeenCalled();
    expect(s.invalidate).toHaveBeenCalledExactlyOnceWith(PUBLIC_MOVIES_CACHE_PREFIX);
    const auditOrder = s.db.spies.auditLog.createMany.mock.invocationCallOrder[0] ?? Infinity;
    expect(s.invalidate.mock.invocationCallOrder[0]).toBeGreaterThan(auditOrder);
  });

  it('reads the inserted rows back by movie, screen and the exact instants, live only', async () => {
    const s = setup();

    await bulkCreate(s, { dateTo: '2026-11-02', times: ['10:00', '14:00'] });

    // The second findMany (the first is the overlap query).
    const [args] = s.db.spies.showtime.findMany.mock.calls[1] ?? [];
    expect(args).toMatchObject({
      where: {
        movieId: s.movie.id,
        screenId: s.screen.id,
        deletedAt: null,
        startsAt: { in: [colombo('2026-11-02', '10:00'), colombo('2026-11-02', '14:00')] },
      },
      orderBy: [...ADMIN_SHOWTIME_LIST_ORDER_BY],
    });
  });

  it('00:30 is stored as the UTC instant of the evening before, with the Colombo date link', async () => {
    const s = setup();

    const { items } = await bulkCreate(s, { dateTo: '2026-11-02', times: ['00:30'] });

    expect(items).toEqual([
      expect.objectContaining({
        startsAt: '2026-11-01T19:00:00.000Z',
        colomboDate: '2026-11-02',
        time: '00:30',
        bookingUrl: `${DEFAULT_BMS_BASE_URL}/20261102`,
      }),
    ]);
  });

  it('a range across a month end', async () => {
    const s = setup({ settings: [testSetting('bmsBaseUrl', CUSTOM_BASE)] });

    const { items } = await bulkCreate(s, {
      dateFrom: '2026-11-29',
      dateTo: '2026-12-02',
      times: ['00:30', '20:00'],
    });

    expect(items.map((item) => [item.colomboDate, item.time, item.bookingUrl])).toEqual([
      ['2026-11-29', '00:30', `${CUSTOM_BASE}/20261129`],
      ['2026-11-29', '20:00', `${CUSTOM_BASE}/20261129`],
      ['2026-11-30', '00:30', `${CUSTOM_BASE}/20261130`],
      ['2026-11-30', '20:00', `${CUSTOM_BASE}/20261130`],
      ['2026-12-01', '00:30', `${CUSTOM_BASE}/20261201`],
      ['2026-12-01', '20:00', `${CUSTOM_BASE}/20261201`],
      ['2026-12-02', '00:30', `${CUSTOM_BASE}/20261202`],
      ['2026-12-02', '20:00', `${CUSTOM_BASE}/20261202`],
    ]);
    expect(s.db.spies.setting.findMany).toHaveBeenCalledTimes(1);
  });

  it('stores "imax 3d" as "IMAX 3D" on every row; without a format, the default "2D"', async () => {
    const s = setup();

    const imax = await bulkCreate(s, { dateTo: '2026-11-03', format: 'imax 3d' });
    expect(imax.items.map((item) => item.format)).toEqual(Array(6).fill('IMAX 3D'));
    expect(s.db.showtimes.map((row) => row.format)).toEqual(Array(6).fill('IMAX 3D'));
    expect(showtimeAudits(s).map((row) => auditDetails(row)['format'])).toEqual(
      Array(6).fill('IMAX 3D'),
    );

    const plain = await bulkCreate(s, { dateFrom: '2026-11-04', dateTo: '2026-11-04' });
    expect(plain.items.map((item) => item.format)).toEqual(['2D', '2D', '2D']);
    // Two requests, two batches.
    expect(new Set(showtimeAudits(s).map((row) => auditDetails(row)['batchId'])).size).toBe(2);
  });

  it('allows an UPCOMING hidden movie (admins schedule ahead)', async () => {
    const other = testMovie({ slug: 'other', title: 'Other', status: 'UPCOMING', isActive: false });
    const s = setup({ movies: [other] });

    const { created } = await bulkCreate(s, { movieId: other.id, dateTo: '2026-11-02' });

    expect(created).toBe(3);
  });

  it('two OTHER saved shows that clash with each other under the current gap do not block the batch', async () => {
    // Saved under a 0-minute gap: 19:00-21:00 and 21:05-23:05; with 15 minutes they clash.
    const s = setup();
    s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: colombo('2026-11-02', '19:00'),
    });
    s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: colombo('2026-11-02', '21:05'),
    });

    // 10:00 and 14:00 are clear of both; 23:20 touches the second (23:05 + 15).
    const { created } = await bulkCreate(s, {
      dateTo: '2026-11-02',
      times: ['10:00', '14:00', '23:20'],
    });

    expect(created).toBe(3);
    expect(s.db.showtimes).toHaveLength(5);
  });

  it('soft-deleted shows and shows on other screens do not conflict', async () => {
    const screen2 = testScreen({ name: 'Screen 2' });
    const s = setup({ screens: [screen2] });
    s.db.addShowtime({
      movieId: s.movie.id,
      screenId: screen2.id,
      startsAt: colombo('2026-11-02', '10:00'),
    });
    s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: colombo('2026-11-02', '14:00'),
      deletedAt: DELETED_AT,
    });

    await expect(bulkCreate(s, { dateTo: '2026-11-02' })).resolves.toMatchObject({ created: 3 });
  });
});

describe('showtime admin service: bulkCreate refusals', () => {
  it('400 listing every past slot (today, earlier than now); nothing read or written', async () => {
    const s = setup();

    const error = await rejection(
      bulkCreate(s, {
        dateFrom: '2026-11-01',
        dateTo: '2026-11-02',
        times: ['20:00', '09:00', '15:30', '15:31'],
      }),
    );

    expect(error).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: showtimeBulkPastMessage(2),
    });
    expect(error.message).toBe(
      '2 of the requested showtimes are in the past. Choose dates and times in the future.',
    );
    expect(error.details).toEqual([
      {
        path: ['body', 'times', 1],
        message: SHOWTIME_SLOT_IN_PAST_MESSAGE,
        requested: { date: '2026-11-01', time: '09:00' },
      },
      {
        path: ['body', 'times', 2], // exactly now counts as past
        message: SHOWTIME_SLOT_IN_PAST_MESSAGE,
        requested: { date: '2026-11-01', time: '15:30' },
      },
    ]);
    expect(
      showtimePastSlotErrorSchema.parse({
        error: { code: error.code, message: error.message, details: error.details },
      }),
    ).toBeTruthy();
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
    expectNothingWritten(s, 0);
  });

  it('one past slot: the singular message', async () => {
    const s = setup();
    const error = await rejection(
      bulkCreate(s, { dateFrom: '2026-11-01', dateTo: '2026-11-03', times: ['15:00'] }),
    );
    expect(error.message).toBe(
      '1 of the requested showtimes is in the past. Choose dates and times in the future.',
    );
    expect(error.details).toHaveLength(1);
  });

  it(`lists at most ${String(SHOWTIME_BULK_MAX_DETAILS)} past slots; the message has the total`, async () => {
    const s = setup();
    const times = Array.from({ length: 12 }, (_, i) => `${String(i * 2).padStart(2, '0')}:00`);

    const error = await rejection(
      bulkCreate(s, { dateFrom: '2026-10-01', dateTo: '2026-10-31', times }),
    );

    expect(error.message).toBe(showtimeBulkPastMessage(372));
    expect(error.details).toHaveLength(SHOWTIME_BULK_MAX_DETAILS);
    expect((error.details as { requested: unknown }[])[0]?.requested).toEqual({
      date: '2026-10-01',
      time: '00:00',
    });
    expectNothingWritten(s, 0);
  });

  it('checks the clock before the movie and screen (no transaction for a past slot)', async () => {
    const s = setup();
    const error = await rejection(
      bulkCreate(s, { movieId: randomUUID(), dateFrom: '2026-11-01', dateTo: '2026-11-01' }),
    );
    expect(error.status).toBe(400);
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
  });

  it('404 on body.movieId / body.screenId for an unknown movie / screen', async () => {
    const s = setup();
    expect(await rejection(bulkCreate(s, { movieId: randomUUID() }))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: SHOWTIME_MOVIE_NOT_FOUND_MESSAGE,
      details: [{ path: ['body', 'movieId'], message: SHOWTIME_MOVIE_NOT_FOUND_MESSAGE }],
    });
    expect(await rejection(bulkCreate(s, { screenId: randomUUID() }))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: SHOWTIME_SCREEN_NOT_FOUND_MESSAGE,
      details: [{ path: ['body', 'screenId'], message: SHOWTIME_SCREEN_NOT_FOUND_MESSAGE }],
    });
    expectNothingWritten(s, 0);
  });

  it.each([
    ['a soft-deleted movie', { deletedAt: DELETED_AT }, SHOWTIME_MOVIE_DELETED_MESSAGE],
    ['an ENDED movie', { status: 'ENDED' }, SHOWTIME_MOVIE_ENDED_MESSAGE],
  ] as const)('409 on body.movieId for %s', async (_name, overrides, message) => {
    const other = testMovie({ slug: 'other', title: 'Other', ...overrides });
    const s = setup({ movies: [other] });

    expect(await rejection(bulkCreate(s, { movieId: other.id }))).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message,
      details: [{ path: ['body', 'movieId'], message }],
    });
    expectNothingWritten(s, 0);
  });

  it.each([
    ['a soft-deleted screen', { deletedAt: DELETED_AT }, SHOWTIME_SCREEN_DELETED_MESSAGE],
    ['a hidden screen', { isActive: false }, SHOWTIME_SCREEN_INACTIVE_MESSAGE],
  ] as const)('409 on body.screenId for %s', async (_name, overrides, message) => {
    const other = testScreen({ name: 'Screen 2', ...overrides });
    const s = setup({ screens: [other] });

    expect(await rejection(bulkCreate(s, { screenId: other.id }))).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message,
      details: [{ path: ['body', 'screenId'], message }],
    });
    expectNothingWritten(s, 0);
  });
});

describe('showtime admin service: bulkCreate overlap check', () => {
  async function expectBulkConflict(s: Setup, overrides: Partial<ShowtimeBulkCreateBodyInput>) {
    const before = s.db.showtimes.length;
    const error = await rejection(bulkCreate(s, overrides));
    expect(error.status).toBe(409);
    expect(error.code).toBe('CONFLICT');
    const parsed = showtimeConflictErrorSchema.parse({
      error: { code: error.code, message: error.message, details: error.details },
    });
    expect(s.db.spies.showtime.createMany).not.toHaveBeenCalled();
    expect(s.db.spies.auditLog.createMany).not.toHaveBeenCalled();
    expectNothingWritten(s, before);
    return { message: error.message, details: parsed.error.details };
  }

  it('one slot clashing with a saved show: 409, nothing inserted, no audit, no invalidation', async () => {
    const s = setup();
    const existing = s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: colombo('2026-11-05', '15:00'),
    });

    const { message, details } = await expectBulkConflict(s, {});

    expect(message).toBe('1 of the requested showtimes overlaps other showtimes on this screen');
    expect(message).toBe(showtimeBulkOverlapMessage(1, 1));
    // 14:00 + 120 + 15 runs into 15:00; 10:00 ends well before; 18:00 starts after 17:15.
    expect(details).toEqual([
      {
        path: ['body', 'times', 2],
        message: 'Overlaps "Main Feature" (15:00–17:00), counting the 15-minute gap between shows',
        requested: { date: '2026-11-05', time: '14:00' },
        conflict: {
          showtimeId: existing.id,
          movieTitle: 'Main Feature',
          startsAt: '2026-11-05T09:30:00.000Z',
          endsAt: '2026-11-05T11:30:00.000Z',
        },
      },
    ]);
  });

  it('in-batch clashes (closer than duration + gap): conflict showtimeId null, reported once on the later slot', async () => {
    const s = setup();

    const { message, details } = await expectBulkConflict(s, {
      dateTo: '2026-11-03',
      times: ['20:00', '19:00'],
    });

    expect(message).toBe('2 of the requested showtimes overlap other showtimes on this screen');
    expect(details).toEqual(
      ['2026-11-02', '2026-11-03'].map((date) => ({
        path: ['body', 'times', 0],
        message:
          'Overlaps another showtime in this request: "Main Feature" (19:00–21:00), counting the 15-minute gap between shows',
        requested: { date, time: '20:00' },
        conflict: {
          showtimeId: null,
          movieTitle: 'Main Feature',
          startsAt: colombo(date, '19:00').toISOString(),
          endsAt: colombo(date, '21:00').toISOString(),
        },
      })),
    );
  });

  it('a clash across midnight names the Colombo date of the other show', async () => {
    const s = setup();

    const { details } = await expectBulkConflict(s, {
      dateTo: '2026-11-03',
      times: ['23:00', '00:30'],
    });

    expect(details).toEqual([
      expect.objectContaining({
        path: ['body', 'times', 1],
        requested: { date: '2026-11-03', time: '00:30' },
        message:
          'Overlaps another showtime in this request: "Main Feature" (2026-11-02 23:00–01:00), counting the 15-minute gap between shows',
      }),
    ]);
  });

  it(`more than ${String(SHOWTIME_BULK_MAX_DETAILS)} clashes: the first ${String(SHOWTIME_BULK_MAX_DETAILS)} listed, the message has the totals`, async () => {
    const s = setup();

    // Per day: 19:30 clashes with 19:00; 20:00 with 19:00 and 19:30. 31 days: 62 slots, 93 clashes.
    const { message, details } = await expectBulkConflict(s, {
      dateFrom: '2026-11-02',
      dateTo: '2026-12-02',
      times: ['19:00', '19:30', '20:00'],
    });

    expect(message).toBe(
      '62 of the requested showtimes overlap other showtimes on this screen. Showing the first 50 of 93 conflicts.',
    );
    expect(details).toHaveLength(SHOWTIME_BULK_MAX_DETAILS);
  });

  it('exactly 50 clashes are all listed, without the "showing" note', () => {
    expect(showtimeBulkOverlapMessage(50, 50)).toBe(
      '50 of the requested showtimes overlap other showtimes on this screen',
    );
  });
});

describe('showtime admin service: bulkCreate failures', () => {
  it('a failed showtime insert rolls back; nothing written, cache kept', async () => {
    const s = setup();
    const failure = new Error('insert failed');
    s.db.injectFault('showtime', 'createMany', { error: failure });

    await expect(bulkCreate(s)).rejects.toBe(failure);
    expectNothingWritten(s, 0);
  });

  it('a failed audit insert rolls back the showtimes; nothing written, cache kept', async () => {
    const s = setup();
    const failure = new Error('audit insert failed');
    s.db.injectFault('auditLog', 'createMany', { error: failure });

    await expect(bulkCreate(s)).rejects.toBe(failure);
    expect(s.db.spies.showtime.createMany).toHaveBeenCalledTimes(1);
    expectNothingWritten(s, 0);
  });

  it('a failed read-back rolls back the showtimes', async () => {
    const s = setup();
    const failure = new Error('read failed');
    s.db.injectFault('showtime', 'findMany', { onCall: 2, error: failure });

    await expect(bulkCreate(s)).rejects.toBe(failure);
    expectNothingWritten(s, 0);
  });

  it('a read-back that does not match the insert (impossible under the screen lock) rolls back', async () => {
    const s = setup();
    // Just before the read-back, an unlocked writer adds a live show at one of the instants
    // (Postgres would have made it wait for the screen lock; the fake does not model that).
    s.db.injectFault('showtime', 'findMany', {
      onCall: 2,
      before: () => {
        s.db.addShowtime({
          movieId: s.movie.id,
          screenId: s.screen.id,
          startsAt: colombo('2026-11-02', '10:00'),
        });
      },
    });

    await expect(bulkCreate(s, { dateTo: '2026-11-02' })).rejects.toThrow(
      'Bulk showtime create read back 4 rows, expected 3',
    );
    // Only the outside writer's row is left.
    expectNothingWritten(s, 1);
  });

  it('a foreign-key failure on the insert is a 409 "changed", never a 500', async () => {
    const s = setup();
    s.db.injectFault('showtime', 'createMany', { error: foreignKeyError('showtime', 'screenId') });

    expect(await rejection(bulkCreate(s))).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: SHOWTIME_TARGET_CHANGED_MESSAGE,
    });
    expectNothingWritten(s, 0);
  });
});

describe('showtime admin service: bulkCreate at the maximum size', () => {
  it('31 days x 12 well-spaced times (372 showtimes) in one request', async () => {
    const short = testMovie({ slug: 'short', title: 'Short', durationMinutes: 60 });
    const s = setup({ movies: [short] });
    // Every 75 minutes from 00:00: 60 minutes + the 15-minute gap, touching each other.
    const times = Array.from({ length: 12 }, (_, i) => {
      const minutes = i * 75;
      return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    });

    const started = performance.now();
    const result = await bulkCreate(s, {
      movieId: short.id,
      dateFrom: '2026-11-02',
      dateTo: '2026-12-02',
      times,
    });
    const ms = performance.now() - started;

    expect(result.created).toBe(372);
    expect(showtimeBulkCreateResponseSchema.parse(result).items).toHaveLength(372);
    expect(s.db.showtimes).toHaveLength(372);
    expect(showtimeAudits(s)).toHaveLength(372);
    expect(s.db.spies.showtime.createMany).toHaveBeenCalledTimes(1);
    expect(s.db.spies.auditLog.createMany).toHaveBeenCalledTimes(1);
    expect(ms).toBeLessThan(10_000);
  });
});

// ---------------------------------------------------------------------------
// update (T12)
// ---------------------------------------------------------------------------

/** The show being edited: 2026-11-02 19:00-21:00 Colombo on Screen 1 (main movie, 120 min). */
const EDITED_START = colombo('2026-11-02', '19:00');

function setupEdit(options: SetupOptions = {}) {
  const s = setup(options);
  const show = s.db.addShowtime({
    movieId: s.movie.id,
    screenId: s.screen.id,
    startsAt: EDITED_START,
  });
  return { ...s, show };
}

type EditSetup = ReturnType<typeof setupEdit>;

const updateBody = (input: ShowtimeUpdateBodyInput) => showtimeUpdateBodySchema.parse(input);

const update = (s: EditSetup, input: ShowtimeUpdateBodyInput, id = s.show.id) =>
  s.service.update(id, updateBody(input), s.actor);

const storedShow = (s: Setup, id: string) =>
  structuredClone(s.db.showtimes.find((row) => row.id === id));

/** Nothing changed: the row as it was, no audit row, no invalidation. */
function expectUnchanged(s: EditSetup, before: ReturnType<typeof storedShow>) {
  expect(storedShow(s, s.show.id)).toEqual(before);
  expect(showtimeAudits(s)).toEqual([]);
  expect(s.invalidate).not.toHaveBeenCalled();
}

/** The public cache was dropped exactly once, after the last audit write. */
function expectInvalidatedAfterAudit(s: Setup, method: 'create' | 'createMany' = 'create') {
  expect(s.invalidate).toHaveBeenCalledExactlyOnceWith(PUBLIC_MOVIES_CACHE_PREFIX);
  const auditOrder = s.db.spies.auditLog[method].mock.invocationCallOrder.at(-1) ?? Infinity;
  expect(s.invalidate.mock.invocationCallOrder[0]).toBeGreaterThan(auditOrder);
}

describe('showtime admin service: update', () => {
  it('moves the start: 200 in the strict shape, UPDATE audit with changes.startsAt, then the cache', async () => {
    const s = setupEdit();

    const showtime = await update(s, { date: '2026-11-02', time: '21:30' });

    expect(adminShowtimeSchema.parse(showtime)).toEqual(showtime);
    expect(showtime).toMatchObject({
      id: s.show.id,
      startsAt: '2026-11-02T16:00:00.000Z',
      endsAt: '2026-11-02T18:00:00.000Z',
      colomboDate: '2026-11-02',
      time: '21:30',
      screen: { id: s.screen.id, name: 'Screen 1' },
      bookingUrl: `${DEFAULT_BMS_BASE_URL}/20261102`,
    });
    expect(storedShow(s, s.show.id)?.startsAt.toISOString()).toBe('2026-11-02T16:00:00.000Z');
    expect(showtimeAudits(s)).toEqual([
      expect.objectContaining({
        action: 'UPDATE',
        adminId: s.admin.id,
        entity: 'Showtime',
        entityId: s.show.id,
        ipAddress: IP,
        userAgent: UA,
        details: {
          changes: {
            startsAt: { from: '2026-11-02T13:30:00.000Z', to: '2026-11-02T16:00:00.000Z' },
          },
        },
      }),
    ]);
    expectInvalidatedAfterAudit(s);
  });

  it('reads first, then locks [Movie, Screen] and re-reads under the lock before the settings and the overlap query', async () => {
    const s = setupEdit();

    await update(s, { date: '2026-11-02', time: '21:30' });

    expect(s.db.locks).toEqual([
      { table: 'Movie', id: s.movie.id },
      { table: 'Screen', id: s.screen.id },
    ]);
    const findUnique = s.db.spies.showtime.findUnique.mock.invocationCallOrder;
    const locks = s.db.spies.$queryRaw.mock.invocationCallOrder;
    expect(findUnique).toHaveLength(2);
    expect(findUnique[0]).toBeLessThan(locks[0] ?? -Infinity);
    expect(findUnique[1]).toBeGreaterThan(locks.at(-1) ?? Infinity);
    expect(s.db.spies.setting.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(
      findUnique[1] ?? Infinity,
    );
    expect(s.db.spies.showtime.findMany).toHaveBeenCalledTimes(1);
    expect(s.db.spies.$transaction).toHaveBeenCalledTimes(1);
  });

  it('moves across Colombo midnight: 00:30 is the evening before in UTC, the link has the new Colombo date', async () => {
    const s = setupEdit();

    const showtime = await update(s, { date: '2026-11-03', time: '00:30' });

    expect(showtime).toMatchObject({
      startsAt: '2026-11-02T19:00:00.000Z',
      colomboDate: '2026-11-03',
      time: '00:30',
      bookingUrl: `${DEFAULT_BMS_BASE_URL}/20261103`,
    });
  });

  it('moves to another screen: locks the movie, then both screens sorted; audit changes.screenId', async () => {
    const screen2 = testScreen({ name: 'Screen 2' });
    const s = setupEdit({ screens: [screen2] });

    const showtime = await update(s, { screenId: screen2.id });

    expect(showtime.screen).toEqual({ id: screen2.id, name: 'Screen 2' });
    expect(showtime.startsAt).toBe('2026-11-02T13:30:00.000Z');
    expect(storedShow(s, s.show.id)?.screenId).toBe(screen2.id);
    expect(s.db.locks).toEqual([
      { table: 'Movie', id: s.movie.id },
      ...[s.screen.id, screen2.id].sort().map((id) => ({ table: 'Screen', id })),
    ]);
    expect(showtimeAudits(s)[0]?.details).toEqual({
      changes: { screenId: { from: s.screen.id, to: screen2.id } },
    });
    expectInvalidatedAfterAudit(s);
  });

  it('moves the start and the screen at once, auditing both', async () => {
    const screen2 = testScreen({ name: 'Screen 2' });
    const s = setupEdit({ screens: [screen2] });

    await update(s, { screenId: screen2.id, date: '2026-11-04', time: '10:00' });

    expect(showtimeAudits(s)[0]?.details).toEqual({
      changes: {
        startsAt: { from: '2026-11-02T13:30:00.000Z', to: '2026-11-04T04:30:00.000Z' },
        screenId: { from: s.screen.id, to: screen2.id },
      },
    });
  });

  it('409 when the new start runs into a neighbour: details on body.time, row unchanged', async () => {
    const s = setupEdit();
    const neighbour = s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: colombo('2026-11-02', '23:00'),
    });
    const before = storedShow(s, s.show.id);

    const error = await rejection(update(s, { date: '2026-11-02', time: '21:00' }));

    expect(error).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: SHOWTIME_OVERLAP_MESSAGE,
    });
    expect(showtimeConflictDetailsSchema.parse(error.details)).toEqual([
      {
        path: ['body', 'time'],
        message: 'Overlaps "Main Feature" (23:00–01:00), counting the 15-minute gap between shows',
        requested: { date: '2026-11-02', time: '21:00' },
        conflict: {
          showtimeId: neighbour.id,
          movieTitle: 'Main Feature',
          startsAt: '2026-11-02T17:30:00.000Z',
          endsAt: '2026-11-02T19:30:00.000Z',
        },
      },
    ]);
    expectUnchanged(s, before);
  });

  it('409 on body.screenId when only the screen changes and the target screen is taken', async () => {
    const screen2 = testScreen({ name: 'Screen 2' });
    const s = setupEdit({ screens: [screen2] });
    const other = s.db.addShowtime({
      movieId: s.movie.id,
      screenId: screen2.id,
      startsAt: colombo('2026-11-02', '20:00'),
    });
    const before = storedShow(s, s.show.id);

    const error = await rejection(update(s, { screenId: screen2.id }));

    expect(error.status).toBe(409);
    const [detail] = showtimeConflictDetailsSchema.parse(error.details);
    expect(detail).toMatchObject({
      path: ['body', 'screenId'],
      requested: { date: '2026-11-02', time: '19:00' },
      conflict: { showtimeId: other.id },
    });
    expectUnchanged(s, before);
  });

  it('a move of a few minutes inside its own old slot is allowed (its saved slot is replaced)', async () => {
    const s = setupEdit();
    // Touching the edited show's current end (21:00 + 15 gap).
    s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: colombo('2026-11-02', '21:15'),
    });

    const showtime = await update(s, { date: '2026-11-02', time: '18:50' });

    expect(showtime.time).toBe('18:50');
    const [args] = s.db.spies.showtime.findMany.mock.calls[0] ?? [];
    // The query returns the show's own saved row too; the candidate replaces it.
    expect(args).toMatchObject({ where: { screenId: { in: [s.screen.id] }, deletedAt: null } });
  });

  it('two OTHER saved shows that clash with each other under the current gap do not fail the move', async () => {
    const s = setupEdit({ settings: [testSetting('showGapMinutes', '15')] });
    // Saved under a 0-minute gap: 10:00-12:00 and 12:05-14:05 clash under today's 15 minutes.
    s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: colombo('2026-11-02', '10:00'),
    });
    s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: colombo('2026-11-02', '12:05'),
    });

    // 14:05 + 15 = 14:20: touching the second show is fine.
    await expect(update(s, { date: '2026-11-02', time: '14:20' })).resolves.toMatchObject({
      time: '14:20',
    });
    expect(showtimeAudits(s)).toHaveLength(1);
  });

  // The edited show (120 min) moves before a neighbour at 2026-11-03 19:00 (120 min).
  it.each([
    [0, '17:00', false],
    [0, '17:01', true],
    [15, '16:45', false],
    [15, '16:46', true],
    [120, '15:00', false],
    [120, '15:01', true],
  ] as const)('gap %i from the Setting: moving to %s conflicts: %s', async (gap, time, clashes) => {
    const s = setupEdit({ settings: [testSetting('showGapMinutes', String(gap))] });
    s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: colombo('2026-11-03', '19:00'),
    });

    const result = update(s, { date: '2026-11-03', time });

    if (clashes) {
      expect(await rejection(result)).toMatchObject({ status: 409 });
    } else {
      await expect(result).resolves.toMatchObject({ colomboDate: '2026-11-03', time });
    }
    // Read through the transaction, once.
    expect(s.db.spies.setting.findMany).toHaveBeenCalledTimes(1);
  });

  it('stores "imax 3d" as "IMAX 3D"; audit changes.format from the stored value', async () => {
    const s = setupEdit();

    const showtime = await update(s, { format: 'imax 3d' });

    expect(showtime.format).toBe('IMAX 3D');
    expect(storedShow(s, s.show.id)?.format).toBe('IMAX 3D');
    expect(showtimeAudits(s)[0]?.details).toEqual({
      changes: { format: { from: '2D', to: 'IMAX 3D' } },
    });
  });

  it('format-only edit on a hidden screen, of an ENDED movie, beside a clashing show: allowed, no rule or overlap query', async () => {
    const ended = testMovie({ slug: 'ended', title: 'Ended', status: 'ENDED', isActive: false });
    const hidden = testScreen({ name: 'Hidden', isActive: false });
    const s = setup({ movies: [ended], screens: [hidden] });
    const show = s.db.addShowtime({
      movieId: ended.id,
      screenId: hidden.id,
      startsAt: EDITED_START,
    });
    // Saved before a gap change; it clashes with the edited show today.
    s.db.addShowtime({
      movieId: ended.id,
      screenId: hidden.id,
      startsAt: colombo('2026-11-02', '21:05'),
    });

    const showtime = await s.service.update(show.id, updateBody({ format: '3D' }), s.actor);

    expect(showtime).toMatchObject({ format: '3D', movie: { status: 'ENDED' } });
    expect(s.db.spies.showtime.findMany).not.toHaveBeenCalled();
    expect(s.db.spies.movie.findUnique).not.toHaveBeenCalled();
    expect(s.db.spies.screen.findUnique).not.toHaveBeenCalled();
    expect(showtimeAudits(s)).toHaveLength(1);
  });

  it('sets an override (the booking link becomes it) and clears it with null (the generated link again)', async () => {
    const s = setupEdit();

    const set = await update(s, { bookingUrlOverride: OVERRIDE });
    expect(set).toMatchObject({ bookingUrlOverride: OVERRIDE, bookingUrl: OVERRIDE });
    expect(s.db.spies.showtime.findMany).not.toHaveBeenCalled();

    const cleared = await update(s, { bookingUrlOverride: null });
    expect(cleared).toMatchObject({
      bookingUrlOverride: null,
      bookingUrl: `${DEFAULT_BMS_BASE_URL}/20261102`,
    });

    expect(showtimeAudits(s).map((row) => row.details)).toEqual([
      { changes: { bookingUrlOverride: { from: null, to: OVERRIDE } } },
      { changes: { bookingUrlOverride: { from: OVERRIDE, to: null } } },
    ]);
    expect(s.invalidate).toHaveBeenCalledTimes(2);
  });

  it('the body schema refuses a non-BookMyShow override, a date without a time and a movieId', () => {
    expect(
      showtimeUpdateBodySchema.safeParse({
        bookingUrlOverride: 'https://evil.example/buytickets/x',
      }).success,
    ).toBe(false);
    expect(showtimeUpdateBodySchema.safeParse({ date: '2026-11-03' }).success).toBe(false);
    expect(showtimeUpdateBodySchema.safeParse({ movieId: randomUUID() }).success).toBe(false);
  });

  it.each([
    ['the same date + time', () => ({ date: '2026-11-02', time: '19:00' })],
    ['the same screen in upper case', (s: EditSetup) => ({ screenId: s.screen.id.toUpperCase() })],
    ['"2d" for a stored "2D"', () => ({ format: '2d' })],
    ['a null override for none', () => ({ bookingUrlOverride: null })],
    [
      'every field as it is',
      (s: EditSetup) => ({
        screenId: s.screen.id,
        date: '2026-11-02',
        time: '19:00',
        format: '2D',
        bookingUrlOverride: null,
      }),
    ],
  ] as const)('no-op (%s): 200 as it is, no write, audit or invalidation', async (_name, input) => {
    const s = setupEdit();
    const before = storedShow(s, s.show.id);

    const showtime = await update(s, input(s));

    expect(showtime).toMatchObject({ id: s.show.id, time: '19:00', format: '2D' });
    expect(s.db.spies.showtime.update).not.toHaveBeenCalled();
    expect(s.db.spies.showtime.findMany).not.toHaveBeenCalled();
    expectUnchanged(s, before);
  });

  it('a no-op with an unchanged stored override returns the override link', async () => {
    const s = setup();
    const show = s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: EDITED_START,
      bookingUrlOverride: OVERRIDE,
    });

    const showtime = await s.service.update(
      show.id,
      updateBody({ bookingUrlOverride: OVERRIDE }),
      s.actor,
    );

    expect(showtime.bookingUrl).toBe(OVERRIDE);
    expect(showtimeAudits(s)).toEqual([]);
  });
});

describe('showtime admin service: update refusals', () => {
  it('404 for an unknown id, before any transaction', async () => {
    const s = setupEdit();

    const error = await rejection(update(s, { format: '3D' }, randomUUID()));

    expect(error).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: SHOWTIME_NOT_FOUND_MESSAGE,
    });
    expect(s.db.spies.$transaction).not.toHaveBeenCalled();
  });

  it('409 for a soft-deleted showtime (no restore), even for a format-only edit', async () => {
    const s = setup();
    const show = s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: EDITED_START,
      deletedAt: DELETED_AT,
    });

    const error = await rejection(s.service.update(show.id, updateBody({ format: '3D' }), s.actor));

    expect(error).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: SHOWTIME_DELETED_MESSAGE,
    });
    expect(showtimeAudits(s)).toEqual([]);
    expect(s.invalidate).not.toHaveBeenCalled();
  });

  it.each([
    ['started an hour ago', colombo('2026-11-01', '14:30')],
    ['starting exactly now', NOW],
    ['long past', colombo('2026-10-01', '19:00')],
  ])('409 for a show %s, whatever the edit', async (_name, startsAt) => {
    const s = setup();
    const show = s.db.addShowtime({ movieId: s.movie.id, screenId: s.screen.id, startsAt });

    for (const input of [
      { format: '3D' },
      { date: '2026-11-05', time: '10:00' },
    ] satisfies ShowtimeUpdateBodyInput[]) {
      const error = await rejection(s.service.update(show.id, updateBody(input), s.actor));
      expect(error).toMatchObject({ status: 409, message: SHOWTIME_STARTED_MESSAGE });
    }
    expect(showtimeAudits(s)).toEqual([]);
  });

  it('400 on body.time for a new start at or before now', async () => {
    const s = setupEdit();
    const before = storedShow(s, s.show.id);

    for (const time of ['15:00', '15:30']) {
      const error = await rejection(update(s, { date: '2026-11-01', time }));
      expect(error).toMatchObject({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: SHOWTIME_IN_PAST_MESSAGE,
        details: [{ path: ['body', 'time'], message: SHOWTIME_IN_PAST_MESSAGE }],
      });
    }
    expectUnchanged(s, before);
    await expect(update(s, { date: '2026-11-01', time: '15:31' })).resolves.toBeTruthy();
  });

  it('404 / 409 on body.screenId for an unknown, deleted or hidden target screen', async () => {
    const deleted = testScreen({ name: 'Deleted', deletedAt: DELETED_AT });
    const hidden = testScreen({ name: 'Hidden', isActive: false });
    const s = setupEdit({ screens: [deleted, hidden] });
    const before = storedShow(s, s.show.id);

    const cases = [
      [randomUUID(), 404, 'NOT_FOUND', SHOWTIME_SCREEN_NOT_FOUND_MESSAGE],
      [deleted.id, 409, 'CONFLICT', SHOWTIME_MOVE_SCREEN_DELETED_MESSAGE],
      [hidden.id, 409, 'CONFLICT', SHOWTIME_MOVE_SCREEN_INACTIVE_MESSAGE],
    ] as const;
    for (const [screenId, status, code, message] of cases) {
      const error = await rejection(update(s, { screenId }));
      expect(error).toMatchObject({
        status,
        code,
        message,
        details: [{ path: ['body', 'screenId'], message }],
      });
    }
    expectUnchanged(s, before);
  });

  it('a time move on a screen that is hidden now is refused on body.screenId', async () => {
    const hidden = testScreen({ name: 'Hidden', isActive: false });
    const s = setup({ screens: [hidden] });
    const show = s.db.addShowtime({
      movieId: s.movie.id,
      screenId: hidden.id,
      startsAt: EDITED_START,
    });

    const error = await rejection(
      s.service.update(show.id, updateBody({ date: '2026-11-02', time: '20:00' }), s.actor),
    );

    expect(error).toMatchObject({ status: 409, message: SHOWTIME_MOVE_SCREEN_INACTIVE_MESSAGE });
  });

  it.each([
    ['ENDED', { status: 'ENDED' }, SHOWTIME_MOVE_MOVIE_ENDED_MESSAGE],
    ['soft-deleted', { deletedAt: DELETED_AT }, SHOWTIME_MOVE_MOVIE_DELETED_MESSAGE],
  ] as const)(
    '409 without details when moving a show of a %s movie',
    async (_name, overrides, message) => {
      const other = testMovie({ slug: 'other', title: 'Other', ...overrides });
      const screen2 = testScreen({ name: 'Screen 2' });
      const s = setup({ movies: [other], screens: [screen2] });
      const show = s.db.addShowtime({
        movieId: other.id,
        screenId: s.screen.id,
        startsAt: EDITED_START,
      });

      for (const input of [
        { date: '2026-11-02', time: '20:00' },
        { screenId: screen2.id },
      ] satisfies ShowtimeUpdateBodyInput[]) {
        const error = await rejection(s.service.update(show.id, updateBody(input), s.actor));
        expect(error).toMatchObject({ status: 409, code: 'CONFLICT', message });
        expect(error.details).toBeUndefined();
      }
      expect(showtimeAudits(s)).toEqual([]);
    },
  );

  it('an UPCOMING hidden movie can be moved (admins schedule ahead)', async () => {
    const upcoming = testMovie({
      slug: 'soon',
      title: 'Soon',
      status: 'UPCOMING',
      isActive: false,
    });
    const s = setup({ movies: [upcoming] });
    const show = s.db.addShowtime({
      movieId: upcoming.id,
      screenId: s.screen.id,
      startsAt: EDITED_START,
    });

    await expect(
      s.service.update(show.id, updateBody({ date: '2026-11-09', time: '10:00' }), s.actor),
    ).resolves.toMatchObject({ colomboDate: '2026-11-09' });
  });
});

describe('showtime admin service: update races and failures', () => {
  it('409 "changed" when the show moved to another screen between the first read and the lock', async () => {
    const screen2 = testScreen({ name: 'Screen 2' });
    const s = setupEdit({ screens: [screen2] });
    s.db.injectFault('$queryRaw', 'lock', {
      before: () => {
        const row = s.db.showtimes.find((r) => r.id === s.show.id);
        if (row) row.screenId = screen2.id;
      },
    });

    const error = await rejection(update(s, { date: '2026-11-02', time: '20:00' }));

    expect(error).toMatchObject({ status: 409, message: SHOWTIME_CHANGED_MESSAGE });
    expect(s.db.spies.showtime.update).not.toHaveBeenCalled();
    expect(showtimeAudits(s)).toEqual([]);
    expect(s.invalidate).not.toHaveBeenCalled();
  });

  it('409 deleted / 404 when the show was deleted or removed between the first read and the lock', async () => {
    const s = setupEdit();
    s.db.injectFault('$queryRaw', 'lock', {
      before: () => {
        const row = s.db.showtimes.find((r) => r.id === s.show.id);
        if (row) row.deletedAt = DELETED_AT;
      },
    });
    expect(await rejection(update(s, { format: '3D' }))).toMatchObject({
      status: 409,
      message: SHOWTIME_DELETED_MESSAGE,
    });

    const t = setupEdit();
    t.db.injectFault('$queryRaw', 'lock', {
      before: () => {
        t.db.showtimes.splice(0, t.db.showtimes.length);
      },
    });
    expect(await rejection(update(t, { format: '3D' }))).toMatchObject({
      status: 404,
      message: SHOWTIME_NOT_FOUND_MESSAGE,
    });
  });

  it.each([
    ['soft-deleted', 409, SHOWTIME_DELETED_MESSAGE],
    ['removed', 404, SHOWTIME_NOT_FOUND_MESSAGE],
    ['still live', 409, SHOWTIME_CHANGED_MESSAGE],
  ] as const)(
    'a P2025 on the update (the show %s meanwhile) is a %i, never a 500',
    async (state, status, message) => {
      const s = setupEdit();
      s.db.injectFault('showtime', 'update', {
        before: () => {
          const index = s.db.showtimes.findIndex((r) => r.id === s.show.id);
          const row = s.db.showtimes[index];
          if (state === 'soft-deleted' && row) row.deletedAt = DELETED_AT;
          if (state === 'removed') s.db.showtimes.splice(index, 1);
        },
        error: recordNotFoundError('showtime', 'an update'),
      });

      const error = await rejection(update(s, { date: '2026-11-02', time: '21:30' }));

      expect(error).toMatchObject({ status, message });
      expect(showtimeAudits(s)).toEqual([]);
      expect(s.invalidate).not.toHaveBeenCalled();
    },
  );

  it('a foreign-key failure on the update is a 409 "changed", never a 500', async () => {
    const screen2 = testScreen({ name: 'Screen 2' });
    const s = setupEdit({ screens: [screen2] });
    s.db.injectFault('showtime', 'update', { error: foreignKeyError('showtime', 'screenId') });

    expect(await rejection(update(s, { screenId: screen2.id }))).toMatchObject({
      status: 409,
      message: SHOWTIME_TARGET_CHANGED_MESSAGE,
    });
    expect(s.invalidate).not.toHaveBeenCalled();
  });

  it('rolls the update back when the audit write fails, and keeps the cache', async () => {
    const s = setupEdit();
    const before = storedShow(s, s.show.id);
    const failure = new Error('audit insert failed');
    s.db.injectFault('auditLog', 'create', { error: failure });

    await expect(update(s, { date: '2026-11-02', time: '21:30', format: '3D' })).rejects.toBe(
      failure,
    );

    expectUnchanged(s, before);
  });
});

// ---------------------------------------------------------------------------
// softDelete (T12)
// ---------------------------------------------------------------------------

describe('showtime admin service: softDelete', () => {
  it('sets deletedAt, returns the showtime, writes DELETE { mode: soft }, then drops the cache', async () => {
    const s = setupEdit();

    const showtime = await s.service.softDelete(s.show.id, s.actor);

    expect(adminShowtimeSchema.parse(showtime)).toEqual(showtime);
    expect(showtime).toMatchObject({
      id: s.show.id,
      deletedAt: NOW.toISOString(),
      time: '19:00',
    });
    expect(storedShow(s, s.show.id)?.deletedAt).toEqual(NOW);
    expect(showtimeAudits(s)).toEqual([
      expect.objectContaining({
        action: 'DELETE',
        adminId: s.admin.id,
        entity: 'Showtime',
        entityId: s.show.id,
        details: { mode: 'soft' },
        ipAddress: IP,
        userAgent: UA,
      }),
    ]);
    expectInvalidatedAfterAudit(s);
    // No row lock: a delete never creates an overlap.
    expect(s.db.locks).toEqual([]);
  });

  it('a started or past show can be deleted (D8), on a hidden screen of an ENDED movie too', async () => {
    const ended = testMovie({ slug: 'ended', title: 'Ended', status: 'ENDED' });
    const hidden = testScreen({ name: 'Hidden', isActive: false });
    const s = setup({ movies: [ended], screens: [hidden] });
    const past = s.db.addShowtime({
      movieId: ended.id,
      screenId: hidden.id,
      startsAt: colombo('2026-10-01', '19:00'),
    });

    await expect(s.service.softDelete(past.id, s.actor)).resolves.toMatchObject({
      deletedAt: NOW.toISOString(),
    });
  });

  it('409 when already deleted, 404 when unknown; nothing written', async () => {
    const s = setup();
    const gone = s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: EDITED_START,
      deletedAt: DELETED_AT,
    });

    expect(await rejection(s.service.softDelete(gone.id, s.actor))).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: SHOWTIME_ALREADY_DELETED_MESSAGE,
    });
    expect(await rejection(s.service.softDelete(randomUUID(), s.actor))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: SHOWTIME_NOT_FOUND_MESSAGE,
    });
    expect(storedShow(s, gone.id)?.deletedAt).toEqual(DELETED_AT);
    expect(showtimeAudits(s)).toEqual([]);
    expect(s.invalidate).not.toHaveBeenCalled();
  });

  it('a concurrent delete between the read and the update (P2025) is a 409, never a 500', async () => {
    const s = setupEdit();
    s.db.injectFault('showtime', 'update', {
      before: () => {
        const row = s.db.showtimes.find((r) => r.id === s.show.id);
        if (row) row.deletedAt = DELETED_AT;
      },
      error: recordNotFoundError('showtime', 'an update'),
    });

    expect(await rejection(s.service.softDelete(s.show.id, s.actor))).toMatchObject({
      status: 409,
      message: SHOWTIME_ALREADY_DELETED_MESSAGE,
    });
    expect(showtimeAudits(s)).toEqual([]);
    expect(s.invalidate).not.toHaveBeenCalled();
  });

  it('rolls back when the audit write fails, and keeps the cache', async () => {
    const s = setupEdit();
    const failure = new Error('audit insert failed');
    s.db.injectFault('auditLog', 'create', { error: failure });

    await expect(s.service.softDelete(s.show.id, s.actor)).rejects.toBe(failure);

    expect(storedShow(s, s.show.id)?.deletedAt).toBeNull();
    expect(s.invalidate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// bulkDelete (T12)
// ---------------------------------------------------------------------------

describe('showtime admin service: bulkDelete', () => {
  function setupMany(extra: SetupOptions = {}) {
    const s = setup(extra);
    const shows = [
      colombo('2026-10-20', '19:00'), // past: allowed (D8)
      colombo('2026-11-02', '19:00'),
      colombo('2026-11-03', '19:00'),
    ].map((startsAt) => s.db.addShowtime({ movieId: s.movie.id, screenId: s.screen.id, startsAt }));
    return { ...s, shows };
  }

  const bulkDelete = (s: Setup, ids: string[]) =>
    s.service.bulkDelete(showtimeBulkDeleteBodySchema.parse({ ids }), s.actor);

  const idAt = (rows: readonly Showtime[], index: number) => rows[index]?.id ?? '';

  it('soft-deletes every showtime in one updateMany: 3 DELETE audits sharing a batchId, the cache dropped once', async () => {
    const s = setupMany();
    const ids = s.shows.map((row) => row.id).reverse();

    const result = await bulkDelete(s, ids);

    expect(showtimeBulkDeleteResponseSchema.parse(result)).toEqual({ deleted: 3 });
    expect(s.db.showtimes.every((row) => row.deletedAt?.getTime() === NOW.getTime())).toBe(true);
    expect(s.db.spies.showtime.updateMany).toHaveBeenCalledTimes(1);
    expect(s.db.spies.showtime.update).not.toHaveBeenCalled();
    const audits = showtimeAudits(s);
    expect(audits.map((row) => row.entityId)).toEqual(ids);
    const batchId = (audits[0]?.details as { batchId?: unknown } | null)?.batchId;
    expect(batchId).toEqual(expect.any(String));
    for (const row of audits) {
      expect(row).toMatchObject({
        action: 'DELETE',
        adminId: s.admin.id,
        entity: 'Showtime',
        details: { mode: 'soft', batchId },
        ipAddress: IP,
        userAgent: UA,
      });
    }
    expect(s.db.spies.auditLog.createMany).toHaveBeenCalledTimes(1);
    expectInvalidatedAfterAudit(s, 'createMany');
    expect(s.db.locks).toEqual([]);
  });

  it('404 listing every unknown ID (path body.ids[i]); nothing changed', async () => {
    const s = setupMany();
    const ids = [idAt(s.shows, 0), randomUUID(), idAt(s.shows, 1), randomUUID()];

    const error = await rejection(bulkDelete(s, ids));

    expect(error).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: showtimeBulkDeleteNotFoundMessage(2),
      details: [
        { path: ['body', 'ids', 1], message: SHOWTIME_BULK_DELETE_UNKNOWN_ID_MESSAGE },
        { path: ['body', 'ids', 3], message: SHOWTIME_BULK_DELETE_UNKNOWN_ID_MESSAGE },
      ],
    });
    expect(s.db.showtimes.every((row) => row.deletedAt === null)).toBe(true);
    expect(s.db.spies.showtime.updateMany).not.toHaveBeenCalled();
    expect(showtimeAudits(s)).toEqual([]);
    expect(s.invalidate).not.toHaveBeenCalled();
  });

  it('409 listing every already-deleted ID; nothing changed', async () => {
    const s = setupMany();
    const gone = s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: colombo('2026-11-04', '19:00'),
      deletedAt: DELETED_AT,
    });

    const error = await rejection(bulkDelete(s, [idAt(s.shows, 1), gone.id]));

    expect(error).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: showtimeBulkDeleteAlreadyDeletedMessage(1),
      details: [{ path: ['body', 'ids', 1], message: SHOWTIME_BULK_DELETE_DELETED_ID_MESSAGE }],
    });
    expect(storedShow(s, idAt(s.shows, 1))?.deletedAt).toBeNull();
    expect(s.db.spies.showtime.updateMany).not.toHaveBeenCalled();
    expect(showtimeAudits(s)).toEqual([]);
    expect(s.invalidate).not.toHaveBeenCalled();
  });

  it('unknown IDs are reported before already-deleted ones', async () => {
    const s = setupMany();
    const gone = s.db.addShowtime({
      movieId: s.movie.id,
      screenId: s.screen.id,
      startsAt: colombo('2026-11-04', '19:00'),
      deletedAt: DELETED_AT,
    });

    const error = await rejection(bulkDelete(s, [gone.id, randomUUID()]));

    expect(error).toMatchObject({
      status: 404,
      details: [{ path: ['body', 'ids', 1], message: SHOWTIME_BULK_DELETE_UNKNOWN_ID_MESSAGE }],
    });
  });

  it('messages: singular and plural', () => {
    expect(showtimeBulkDeleteNotFoundMessage(1)).toBe(
      '1 of the selected showtimes was not found. Reload and try again.',
    );
    expect(showtimeBulkDeleteNotFoundMessage(3)).toBe(
      '3 of the selected showtimes were not found. Reload and try again.',
    );
    expect(showtimeBulkDeleteAlreadyDeletedMessage(1)).toBe(
      '1 of the selected showtimes is already deleted. Reload and try again.',
    );
    expect(showtimeBulkDeleteAlreadyDeletedMessage(2)).toBe(
      '2 of the selected showtimes are already deleted. Reload and try again.',
    );
  });

  it('a race (one deleted between the read and the updateMany): 409, rolled back, no audit', async () => {
    const s = setupMany();
    const second = idAt(s.shows, 1);
    s.db.injectFault('showtime', 'updateMany', {
      before: () => {
        const row = s.db.showtimes.find((r) => r.id === second);
        if (row) row.deletedAt = DELETED_AT;
      },
    });

    const error = await rejection(
      bulkDelete(
        s,
        s.shows.map((row) => row.id),
      ),
    );

    expect(error).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: SHOWTIME_BULK_DELETE_CHANGED_MESSAGE,
    });
    // Our two deletes rolled back; only the concurrent writer's stays.
    expect(storedShow(s, idAt(s.shows, 0))?.deletedAt).toBeNull();
    expect(storedShow(s, idAt(s.shows, 2))?.deletedAt).toBeNull();
    expect(storedShow(s, second)?.deletedAt).toEqual(DELETED_AT);
    expect(showtimeAudits(s)).toEqual([]);
    expect(s.invalidate).not.toHaveBeenCalled();
  });

  it('a failed audit insert rolls the deletes back, keeping the cache', async () => {
    const s = setupMany();
    const failure = new Error('audit insert failed');
    s.db.injectFault('auditLog', 'createMany', { error: failure });

    await expect(
      bulkDelete(
        s,
        s.shows.map((row) => row.id),
      ),
    ).rejects.toBe(failure);

    expect(s.db.showtimes.every((row) => row.deletedAt === null)).toBe(true);
    expect(s.invalidate).not.toHaveBeenCalled();
  });

  it('the body schema refuses duplicates (also case-only), no IDs and more than 200', () => {
    const id = randomUUID();
    expect(showtimeBulkDeleteBodySchema.safeParse({ ids: [id, id] }).success).toBe(false);
    expect(showtimeBulkDeleteBodySchema.safeParse({ ids: [id, id.toUpperCase()] }).success).toBe(
      false,
    );
    expect(showtimeBulkDeleteBodySchema.safeParse({ ids: [] }).success).toBe(false);
    const many = Array.from({ length: 201 }, () => randomUUID());
    expect(showtimeBulkDeleteBodySchema.safeParse({ ids: many }).success).toBe(false);
    expect(showtimeBulkDeleteBodySchema.safeParse({ ids: many.slice(0, 200) }).success).toBe(true);
  });

  it('200 IDs in one request', async () => {
    const s = setup();
    const ids = Array.from(
      { length: 200 },
      (_, i) =>
        s.db.addShowtime({
          movieId: s.movie.id,
          screenId: s.screen.id,
          startsAt: new Date(colombo('2026-11-02', '00:00').getTime() + i * 3 * 3_600_000),
        }).id,
    );

    await expect(bulkDelete(s, ids)).resolves.toEqual({ deleted: 200 });
    expect(showtimeAudits(s)).toHaveLength(200);
  });
});
