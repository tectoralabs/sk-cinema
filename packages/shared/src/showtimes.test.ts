import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { DEFAULT_BMS_BASE_URL } from './bms.js';
import { publicMovieSchema } from './movies.js';
import {
  SHOWTIME_BULK_DELETE_MAX_IDS,
  SHOWTIME_BULK_MAX_DAYS,
  SHOWTIME_BULK_MAX_TIMES,
  SHOWTIME_FORMAT_MAX_LENGTH,
  adminShowtimeListQuerySchema,
  adminShowtimeListResponseSchema,
  adminShowtimeResponseSchema,
  adminShowtimeSchema,
  clockTimeSchema,
  normalizeShowtimeFormat,
  normalizedShowtimeFormatSchema,
  publicMovieIdParamsSchema,
  publicShowtimeDatesResponseSchema,
  publicShowtimeListQuerySchema,
  publicShowtimeListResponseSchema,
  publicShowtimeSchema,
  showtimeBulkCreateBodySchema,
  showtimeBulkCreateResponseSchema,
  showtimeBulkDeleteBodySchema,
  showtimeBulkDeleteResponseSchema,
  showtimeConflictDetailSchema,
  showtimeConflictDetailsSchema,
  showtimeConflictErrorSchema,
  showtimeCreateBodySchema,
  showtimeFormatSchema,
  showtimeIdParamsSchema,
  showtimeUpdateBodySchema,
} from './showtimes.js';

const MOVIE_ID = '01928f6e-7c3a-7b2e-9f4d-3a1b2c3d4e5f';
const SCREEN_ID = '01928f6e-7c3a-7b2e-9f4d-3a1b2c3d4e60';
const SHOWTIME_ID = '01928f6e-7c3a-7b2e-9f4d-3a1b2c3d4e61';
const OTHER_ID = '01928f6e-7c3a-7b2e-9f4d-3a1b2c3d4e62';
const BOOKING_URL = `${DEFAULT_BMS_BASE_URL}/20261101`;
const OVERRIDE_URL = 'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/special-screening';

/** One safeParse and how long it took, after a warm-up parse so JIT compilation is not timed. */
function timeSafeParse<S extends z.ZodType>(schema: S, input: unknown) {
  schema.safeParse('warm-up');
  const start = performance.now();
  const result = schema.safeParse(input);
  return { result, ms: performance.now() - start };
}

const HUGE = 100_000;

const validCreate = {
  movieId: MOVIE_ID,
  screenId: SCREEN_ID,
  date: '2026-11-01',
  time: '18:30',
};

const validBulk = {
  movieId: MOVIE_ID,
  screenId: SCREEN_ID,
  dateFrom: '2026-11-01',
  dateTo: '2026-11-07',
  times: ['10:30', '14:00', '18:30'],
};

const validPublicShowtime = {
  id: SHOWTIME_ID,
  startsAt: '2026-11-01T13:00:00.000Z',
  time: '18:30',
  format: '2D',
  screen: { name: 'Screen 1' },
  bookingUrl: BOOKING_URL,
};

const validAdminShowtime = {
  id: SHOWTIME_ID,
  movie: { id: MOVIE_ID, title: 'The Matara Story', durationMinutes: 125, status: 'NOW_SHOWING' },
  screen: { id: SCREEN_ID, name: 'Screen 1' },
  startsAt: '2026-11-01T13:00:00.000Z',
  endsAt: '2026-11-01T15:05:00.000Z',
  colomboDate: '2026-11-01',
  time: '18:30',
  format: '2D',
  bookingUrlOverride: null,
  bookingUrl: BOOKING_URL,
  deletedAt: null,
  createdAt: '2026-10-01T04:30:00.000Z',
  updatedAt: '2026-10-02T04:30:00.000Z',
};

const validConflictDetail = {
  path: ['body', 'times', 1],
  message: 'Overlaps another showtime on this screen',
  requested: { date: '2026-11-02', time: '14:00' },
  conflict: {
    showtimeId: OTHER_ID,
    movieTitle: 'Another Movie',
    startsAt: '2026-11-02T08:00:00.000Z',
    endsAt: '2026-11-02T10:10:00.000Z',
  },
};

const INVALID_DATES = ['2026-02-30', '2026-13-01', '26-11-01', '2026-11-1', '2026/11/01', ''];
const INVALID_TIMES = ['24:00', '9:00', '09:60', '09:00:00', '9:5', '0900', ' 09:00', '', '25:00'];

describe('constants', () => {
  it('match the approved limits', () => {
    expect(SHOWTIME_FORMAT_MAX_LENGTH).toBe(20);
    expect(SHOWTIME_BULK_MAX_DAYS).toBe(31);
    expect(SHOWTIME_BULK_MAX_TIMES).toBe(12);
    expect(SHOWTIME_BULK_DELETE_MAX_IDS).toBe(200);
  });
});

describe('clockTimeSchema', () => {
  it.each(['00:00', '00:30', '09:05', '12:00', '19:59', '23:59'])('accepts %s', (time) => {
    expect(clockTimeSchema.parse(time)).toBe(time);
  });

  it.each(INVALID_TIMES)('rejects %j', (time) => {
    expect(clockTimeSchema.safeParse(time).success).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(clockTimeSchema.safeParse(930).success).toBe(false);
    expect(clockTimeSchema.safeParse(null).success).toBe(false);
  });

  it('rejects a ~100 KB string quickly with only a length issue', () => {
    const { result, ms } = timeSafeParse(clockTimeSchema, `09:00${'0'.repeat(HUGE)}`);
    expect(ms).toBeLessThan(50);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.code)).toEqual(['too_big']);
  });
});

describe('showtimeFormatSchema', () => {
  it.each(['2D', '3D', 'IMAX 3D', '4DX', 'DOLBY-ATMOS', 'F'.repeat(20)])(
    'accepts %s unchanged',
    (format) => {
      expect(showtimeFormatSchema.parse(format)).toBe(format);
    },
  );

  it.each([
    ['2d', '2D'],
    [' 2D', '2D'],
    ['2D ', '2D'],
    ['  2d  ', '2D'],
    ['imax 3d', 'IMAX 3D'],
    ['  imax 3D ', 'IMAX 3D'],
    ['Dolby-atmos', 'DOLBY-ATMOS'],
    ['4dx', '4DX'],
    ['f'.repeat(20), 'F'.repeat(20)],
  ])('normalises %j to %j', (input, expected) => {
    expect(showtimeFormatSchema.parse(input)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    'f'.repeat(21),
    '2D  3D',
    '2d  3d',
    '2D-',
    '-2d',
    '2D/3D',
    '2D_3D',
    '3D\tIMAX',
    '3d\timax',
    '3D\nIMAX',
    '<b>3D</b>',
    '<script>',
    'ＩＭＡＸ',
    '3ᴰ',
    'ßD',
    'ımax',
    'ﬀ',
  ])('rejects %j (charset is checked before uppercasing)', (format) => {
    expect(showtimeFormatSchema.safeParse(format).success).toBe(false);
  });

  it.each([
    ['separated words', `${'a '.repeat(HUGE / 2)}!`],
    ['one long word', `${'a'.repeat(HUGE)}-`],
  ])('rejects a ~100 KB value quickly with only a length issue (%s)', (_label, format) => {
    const { result, ms } = timeSafeParse(showtimeFormatSchema, format);
    expect(ms).toBeLessThan(50);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.code)).toEqual(['too_big']);
  });
});

describe('format in request bodies', () => {
  it.each([null, '', '   '])('create, bulk create and update all reject format %j', (format) => {
    expect(showtimeCreateBodySchema.safeParse({ ...validCreate, format }).success).toBe(false);
    expect(showtimeBulkCreateBodySchema.safeParse({ ...validBulk, format }).success).toBe(false);
    expect(showtimeUpdateBodySchema.safeParse({ format }).success).toBe(false);
  });
});

describe('normalizedShowtimeFormatSchema', () => {
  it.each(['2D', '3D', 'IMAX 3D', '4DX', 'DOLBY-ATMOS', 'F'.repeat(20)])('accepts %s', (format) => {
    expect(normalizedShowtimeFormatSchema.parse(format)).toBe(format);
  });

  it.each(['2d', ' 2D', '2D ', 'Imax 3D', '', 'F'.repeat(21), '2D  3D', '2D/3D', '3ᴰ', 'SS\t'])(
    'rejects %j',
    (format) => {
      expect(normalizedShowtimeFormatSchema.safeParse(format).success).toBe(false);
    },
  );

  it('rejects a ~100 KB value quickly with only a length issue', () => {
    const { result, ms } = timeSafeParse(
      normalizedShowtimeFormatSchema,
      `${'A '.repeat(HUGE / 2)}!`,
    );
    expect(ms).toBeLessThan(50);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.code)).toEqual(['too_big']);
  });
});

describe('normalizeShowtimeFormat', () => {
  it.each([
    ['2D', '2D'],
    ['2d', '2D'],
    [' 2D', '2D'],
    ['2D ', '2D'],
    ['imax 3d', 'IMAX 3D'],
    ['Dolby-atmos', 'DOLBY-ATMOS'],
    ['f'.repeat(20), 'F'.repeat(20)],
  ])('normalises %j to %j', (stored, expected) => {
    expect(normalizeShowtimeFormat(stored)).toBe(expected);
  });

  it.each(['2D/3D', '', '   ', 'ßD', 'f'.repeat(21), '2D  3D', '<b>3D</b>', '3ᴰ', 'ımax'])(
    'returns null for %j (no format shown)',
    (stored) => {
      expect(normalizeShowtimeFormat(stored)).toBeNull();
    },
  );

  it('returns null or a value the response format schema accepts', () => {
    for (const stored of ['2d', ' imax 3d ', '2D/3D', '', 'ßD', 'Dolby-atmos']) {
      const value = normalizeShowtimeFormat(stored);
      expect(normalizedShowtimeFormatSchema.nullable().safeParse(value).success).toBe(true);
    }
  });

  it('handles a ~100 KB stored value quickly', () => {
    const start = performance.now();
    const value = normalizeShowtimeFormat(`${'a '.repeat(HUGE / 2)}!`);
    expect(performance.now() - start).toBeLessThan(50);
    expect(value).toBeNull();
  });
});

describe('showtimeIdParamsSchema / publicMovieIdParamsSchema', () => {
  it.each([
    ['showtimeIdParamsSchema', showtimeIdParamsSchema],
    ['publicMovieIdParamsSchema', publicMovieIdParamsSchema],
  ])('%s accepts a UUID and rejects others and unknown keys', (_name, schema) => {
    expect(schema.parse({ id: SHOWTIME_ID })).toEqual({ id: SHOWTIME_ID });
    expect(schema.safeParse({ id: 'the-matara-story' }).success).toBe(false);
    expect(schema.safeParse({ id: SHOWTIME_ID, extra: 'x' }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });
});

describe('showtimeCreateBodySchema', () => {
  it('accepts a minimal body (no format default is added here)', () => {
    expect(showtimeCreateBodySchema.parse(validCreate)).toEqual(validCreate);
  });

  it('accepts format and a BookMyShow override', () => {
    const body = { ...validCreate, format: '3D', bookingUrlOverride: OVERRIDE_URL };
    expect(showtimeCreateBodySchema.parse(body)).toEqual(body);
  });

  it('normalises the format', () => {
    expect(showtimeCreateBodySchema.parse({ ...validCreate, format: ' imax 3d ' }).format).toBe(
      'IMAX 3D',
    );
  });

  it('accepts a null override', () => {
    const body = { ...validCreate, bookingUrlOverride: null };
    expect(showtimeCreateBodySchema.parse(body).bookingUrlOverride).toBeNull();
  });

  it.each([
    'https://example.com/buytickets/x',
    'https://lk.bookmyshow.com/movies/x',
    'http://lk.bookmyshow.com/buytickets/x',
    'https://lk.bookmyshow.com.evil.com/buytickets/x',
    'javascript:alert(1)',
    '',
  ])('rejects a non-BMS override %j', (bookingUrlOverride) => {
    expect(showtimeCreateBodySchema.safeParse({ ...validCreate, bookingUrlOverride }).success).toBe(
      false,
    );
  });

  it.each(INVALID_DATES)('rejects date %j', (date) => {
    expect(showtimeCreateBodySchema.safeParse({ ...validCreate, date }).success).toBe(false);
  });

  it.each(INVALID_TIMES)('rejects time %j', (time) => {
    expect(showtimeCreateBodySchema.safeParse({ ...validCreate, time }).success).toBe(false);
  });

  it.each(['movieId', 'screenId', 'date', 'time'] as const)('requires %s', (key) => {
    const body = Object.fromEntries(Object.entries(validCreate).filter(([k]) => k !== key));
    expect(showtimeCreateBodySchema.safeParse(body).success).toBe(false);
  });

  it('rejects non-UUID ids', () => {
    expect(showtimeCreateBodySchema.safeParse({ ...validCreate, movieId: '1' }).success).toBe(
      false,
    );
    expect(showtimeCreateBodySchema.safeParse({ ...validCreate, screenId: 'x' }).success).toBe(
      false,
    );
  });

  it.each([
    ['startsAt', '2026-11-01T13:00:00.000Z'],
    ['deletedAt', null],
    ['id', SHOWTIME_ID],
    ['times', ['18:30']],
  ])('rejects unknown key %s', (key, value) => {
    expect(showtimeCreateBodySchema.safeParse({ ...validCreate, [key]: value }).success).toBe(
      false,
    );
  });

  it('rejects ~100 KB strings in every patterned field quickly', () => {
    for (const patch of [
      { date: `2026-11-01${'1'.repeat(HUGE)}` },
      { time: `18:30${'0'.repeat(HUGE)}` },
      { format: `${'a-'.repeat(HUGE / 2)}!` },
      { bookingUrlOverride: `${OVERRIDE_URL}/${'a/'.repeat(HUGE / 2)}` },
      { movieId: `${MOVIE_ID}${'0'.repeat(HUGE)}` },
    ]) {
      const { result, ms } = timeSafeParse(showtimeCreateBodySchema, { ...validCreate, ...patch });
      expect(ms).toBeLessThan(50);
      expect(result.success).toBe(false);
    }
  });
});

describe('showtimeBulkCreateBodySchema', () => {
  it('accepts a valid body', () => {
    expect(showtimeBulkCreateBodySchema.parse(validBulk)).toEqual(validBulk);
  });

  it('accepts a single day and a format', () => {
    const body = { ...validBulk, dateTo: validBulk.dateFrom, format: 'IMAX 3D' };
    expect(showtimeBulkCreateBodySchema.parse(body)).toEqual(body);
  });

  it('normalises the format', () => {
    expect(showtimeBulkCreateBodySchema.parse({ ...validBulk, format: '2d ' }).format).toBe('2D');
  });

  it('accepts exactly 31 days inclusive, across a month end', () => {
    const body = { ...validBulk, dateFrom: '2026-11-01', dateTo: '2026-12-01' };
    expect(showtimeBulkCreateBodySchema.safeParse(body).success).toBe(true);
  });

  it('rejects 32 days inclusive, with the issue on dateTo', () => {
    const result = showtimeBulkCreateBodySchema.safeParse({
      ...validBulk,
      dateFrom: '2026-11-01',
      dateTo: '2026-12-02',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['dateTo']]);
  });

  it('counts a leap day', () => {
    const ok = { ...validBulk, dateFrom: '2028-02-01', dateTo: '2028-03-02' };
    const tooLong = { ...validBulk, dateFrom: '2028-02-01', dateTo: '2028-03-03' };
    expect(showtimeBulkCreateBodySchema.safeParse(ok).success).toBe(true);
    expect(showtimeBulkCreateBodySchema.safeParse(tooLong).success).toBe(false);
  });

  it('rejects dateTo before dateFrom, with the issue on dateTo', () => {
    const result = showtimeBulkCreateBodySchema.safeParse({
      ...validBulk,
      dateFrom: '2026-11-07',
      dateTo: '2026-11-06',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['dateTo']]);
  });

  it('rejects a range across years that is too long', () => {
    const body = { ...validBulk, dateFrom: '2026-12-15', dateTo: '2027-01-20' };
    expect(showtimeBulkCreateBodySchema.safeParse(body).success).toBe(false);
  });

  it.each(INVALID_DATES)('rejects dateFrom/dateTo %j', (date) => {
    expect(showtimeBulkCreateBodySchema.safeParse({ ...validBulk, dateFrom: date }).success).toBe(
      false,
    );
    expect(showtimeBulkCreateBodySchema.safeParse({ ...validBulk, dateTo: date }).success).toBe(
      false,
    );
  });

  it('rejects duplicate times, pointing at the repeat', () => {
    const result = showtimeBulkCreateBodySchema.safeParse({
      ...validBulk,
      times: ['10:30', '14:00', '10:30'],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['times', 2]]);
  });

  it('accepts 12 times and rejects 13', () => {
    const times = Array.from({ length: 13 }, (_, i) => `${String(i + 8).padStart(2, '0')}:00`);
    expect(
      showtimeBulkCreateBodySchema.safeParse({ ...validBulk, times: times.slice(0, 12) }).success,
    ).toBe(true);
    expect(showtimeBulkCreateBodySchema.safeParse({ ...validBulk, times }).success).toBe(false);
  });

  it('rejects empty or missing times', () => {
    expect(showtimeBulkCreateBodySchema.safeParse({ ...validBulk, times: [] }).success).toBe(false);
    const { times: _times, ...withoutTimes } = validBulk;
    expect(showtimeBulkCreateBodySchema.safeParse(withoutTimes).success).toBe(false);
  });

  it.each(INVALID_TIMES)('rejects time %j in the list', (time) => {
    expect(
      showtimeBulkCreateBodySchema.safeParse({ ...validBulk, times: ['10:30', time] }).success,
    ).toBe(false);
  });

  it('rejects a single time string instead of a list', () => {
    expect(showtimeBulkCreateBodySchema.safeParse({ ...validBulk, times: '10:30' }).success).toBe(
      false,
    );
  });

  it('rejects bookingUrlOverride (overrides are per showtime)', () => {
    for (const bookingUrlOverride of [OVERRIDE_URL, null]) {
      expect(
        showtimeBulkCreateBodySchema.safeParse({ ...validBulk, bookingUrlOverride }).success,
      ).toBe(false);
    }
  });

  it('rejects other unknown keys', () => {
    expect(
      showtimeBulkCreateBodySchema.safeParse({ ...validBulk, date: '2026-11-01' }).success,
    ).toBe(false);
  });

  it('rejects ~100 KB strings and a ~100 KB times list quickly', () => {
    for (const patch of [
      { dateFrom: `2026-11-01${'1'.repeat(HUGE)}` },
      { dateTo: `2026-11-07${'1'.repeat(HUGE)}` },
      { times: [`10:30${'0'.repeat(HUGE)}`] },
      { times: Array.from({ length: HUGE / 8 }, () => '10:30') },
      { format: `${'a'.repeat(HUGE)}-` },
    ]) {
      const { result, ms } = timeSafeParse(showtimeBulkCreateBodySchema, {
        ...validBulk,
        ...patch,
      });
      expect(ms).toBeLessThan(50);
      expect(result.success).toBe(false);
    }
  });
});

describe('showtimeUpdateBodySchema', () => {
  it.each([
    { screenId: SCREEN_ID },
    { format: '3D' },
    { bookingUrlOverride: OVERRIDE_URL },
    { bookingUrlOverride: null },
    { date: '2026-11-02', time: '20:00' },
    {
      screenId: SCREEN_ID,
      date: '2026-11-02',
      time: '00:30',
      format: 'IMAX 3D',
      bookingUrlOverride: null,
    },
  ])('accepts %j', (body) => {
    expect(showtimeUpdateBodySchema.parse(body)).toEqual(body);
  });

  it('normalises the format', () => {
    expect(showtimeUpdateBodySchema.parse({ format: 'Dolby-atmos' })).toEqual({
      format: 'DOLBY-ATMOS',
    });
  });

  it('rejects an empty body', () => {
    const result = showtimeUpdateBodySchema.safeParse({});
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'Provide at least one field to update',
    ]);
  });

  it('rejects a date without a time, and a time without a date', () => {
    const dateOnly = showtimeUpdateBodySchema.safeParse({ date: '2026-11-02' });
    expect(dateOnly.success).toBe(false);
    expect(dateOnly.error?.issues.map((issue) => issue.path)).toEqual([['time']]);

    const timeOnly = showtimeUpdateBodySchema.safeParse({ time: '20:00', format: '2D' });
    expect(timeOnly.success).toBe(false);
    expect(timeOnly.error?.issues.map((issue) => issue.path)).toEqual([['date']]);
  });

  it('rejects invalid dates and times', () => {
    for (const date of INVALID_DATES) {
      expect(showtimeUpdateBodySchema.safeParse({ date, time: '20:00' }).success).toBe(false);
    }
    for (const time of INVALID_TIMES) {
      expect(showtimeUpdateBodySchema.safeParse({ date: '2026-11-02', time }).success).toBe(false);
    }
  });

  it('rejects a non-BMS override and an empty override', () => {
    expect(
      showtimeUpdateBodySchema.safeParse({ bookingUrlOverride: 'https://example.com/buytickets/x' })
        .success,
    ).toBe(false);
    expect(showtimeUpdateBodySchema.safeParse({ bookingUrlOverride: '' }).success).toBe(false);
  });

  it('rejects movieId and other unknown keys', () => {
    expect(showtimeUpdateBodySchema.safeParse({ movieId: MOVIE_ID }).success).toBe(false);
    expect(showtimeUpdateBodySchema.safeParse({ format: '2D', startsAt: 'x' }).success).toBe(false);
  });

  it('rejects ~100 KB strings quickly', () => {
    for (const body of [
      { date: `2026-11-02${'1'.repeat(HUGE)}`, time: '20:00' },
      { date: '2026-11-02', time: `20:00${'0'.repeat(HUGE)}` },
      { format: `${'a '.repeat(HUGE / 2)}!` },
      { bookingUrlOverride: `${OVERRIDE_URL}${'a'.repeat(HUGE)}` },
    ]) {
      const { result, ms } = timeSafeParse(showtimeUpdateBodySchema, body);
      expect(ms).toBeLessThan(50);
      expect(result.success).toBe(false);
    }
  });
});

describe('showtimeBulkDeleteBodySchema', () => {
  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => `01928f6e-7c3a-7b2e-9f4d-${String(i).padStart(12, '0')}`);

  it('accepts 1 and 200 distinct ids', () => {
    expect(showtimeBulkDeleteBodySchema.parse({ ids: ids(1) })).toEqual({ ids: ids(1) });
    expect(showtimeBulkDeleteBodySchema.safeParse({ ids: ids(200) }).success).toBe(true);
  });

  it('rejects 0 and 201 ids', () => {
    expect(showtimeBulkDeleteBodySchema.safeParse({ ids: [] }).success).toBe(false);
    expect(showtimeBulkDeleteBodySchema.safeParse({ ids: ids(201) }).success).toBe(false);
  });

  it('rejects duplicates, ignoring case', () => {
    const exact = showtimeBulkDeleteBodySchema.safeParse({ ids: [SHOWTIME_ID, SHOWTIME_ID] });
    expect(exact.success).toBe(false);
    expect(exact.error?.issues.map((issue) => issue.path)).toEqual([['ids', 1]]);

    const mixedCase = '01928F6E-7C3A-7B2E-9F4D-3A1B2C3D4E61';
    expect(showtimeBulkDeleteBodySchema.safeParse({ ids: [SHOWTIME_ID, mixedCase] }).success).toBe(
      false,
    );
  });

  it('rejects non-UUIDs, a missing list and unknown keys', () => {
    expect(showtimeBulkDeleteBodySchema.safeParse({ ids: ['1'] }).success).toBe(false);
    expect(showtimeBulkDeleteBodySchema.safeParse({}).success).toBe(false);
    expect(showtimeBulkDeleteBodySchema.safeParse({ ids: ids(1), permanent: true }).success).toBe(
      false,
    );
  });

  it('rejects a ~100 KB id quickly', () => {
    const { result, ms } = timeSafeParse(showtimeBulkDeleteBodySchema, {
      ids: [`${SHOWTIME_ID}${'0'.repeat(HUGE)}`],
    });
    expect(ms).toBeLessThan(50);
    expect(result.success).toBe(false);
  });
});

describe('adminShowtimeListQuerySchema', () => {
  it('applies defaults', () => {
    expect(adminShowtimeListQuerySchema.parse({})).toEqual({
      includePast: false,
      deleted: 'exclude',
      page: 1,
      pageSize: 20,
    });
  });

  it('parses a full query', () => {
    expect(
      adminShowtimeListQuerySchema.parse({
        movieId: MOVIE_ID,
        screenId: SCREEN_ID,
        from: '2026-11-01',
        to: '2026-11-30',
        includePast: 'true',
        deleted: 'only',
        page: '2',
        pageSize: '100',
      }),
    ).toEqual({
      movieId: MOVIE_ID,
      screenId: SCREEN_ID,
      from: '2026-11-01',
      to: '2026-11-30',
      includePast: true,
      deleted: 'only',
      page: 2,
      pageSize: 100,
    });
  });

  it('accepts from equal to to, and either one alone', () => {
    expect(
      adminShowtimeListQuerySchema.safeParse({ from: '2026-11-01', to: '2026-11-01' }).success,
    ).toBe(true);
    expect(adminShowtimeListQuerySchema.safeParse({ from: '2026-11-01' }).success).toBe(true);
    expect(adminShowtimeListQuerySchema.safeParse({ to: '2026-11-01' }).success).toBe(true);
  });

  it('rejects to before from, with the issue on to', () => {
    const result = adminShowtimeListQuerySchema.safeParse({ from: '2026-11-02', to: '2026-11-01' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['to']]);
  });

  it.each([
    { from: '2026-02-30' },
    { to: '26-11-01' },
    { includePast: '1' },
    { includePast: 'yes' },
    { deleted: 'all' },
    { movieId: 'abc' },
    { screenId: '1' },
    { page: '0' },
    { pageSize: '101' },
    { pageSize: '0' },
    { movieId: [MOVIE_ID, MOVIE_ID] },
  ])('rejects %j', (query) => {
    expect(adminShowtimeListQuerySchema.safeParse(query).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(adminShowtimeListQuerySchema.safeParse({ sort: 'startsAt' }).success).toBe(false);
    expect(adminShowtimeListQuerySchema.safeParse({ date: '2026-11-01' }).success).toBe(false);
  });

  it('rejects ~100 KB values quickly', () => {
    for (const query of [
      { from: `2026-11-01${'1'.repeat(HUGE)}` },
      { movieId: `${MOVIE_ID}${'0'.repeat(HUGE)}` },
      { page: '1'.repeat(HUGE) },
    ]) {
      const { result, ms } = timeSafeParse(adminShowtimeListQuerySchema, query);
      expect(ms).toBeLessThan(50);
      expect(result.success).toBe(false);
    }
  });
});

describe('publicShowtimeListQuerySchema', () => {
  it('requires a valid date', () => {
    expect(publicShowtimeListQuerySchema.parse({ date: '2026-11-01' })).toEqual({
      date: '2026-11-01',
    });
    expect(publicShowtimeListQuerySchema.safeParse({}).success).toBe(false);
  });

  it.each(INVALID_DATES)('rejects date %j', (date) => {
    expect(publicShowtimeListQuerySchema.safeParse({ date }).success).toBe(false);
  });

  it('rejects repeated date keys and unknown keys', () => {
    expect(
      publicShowtimeListQuerySchema.safeParse({ date: ['2026-11-01', '2026-11-02'] }).success,
    ).toBe(false);
    expect(
      publicShowtimeListQuerySchema.safeParse({ date: '2026-11-01', includePast: 'true' }).success,
    ).toBe(false);
  });

  it('rejects a ~100 KB date quickly', () => {
    const { result, ms } = timeSafeParse(publicShowtimeListQuerySchema, {
      date: `2026-11-01${'1'.repeat(HUGE)}`,
    });
    expect(ms).toBeLessThan(50);
    expect(result.success).toBe(false);
  });
});

describe('publicShowtimeDatesResponseSchema', () => {
  it('accepts ascending dates and an empty list', () => {
    const body = { dates: ['2026-11-01', '2026-11-02', '2026-12-01'] };
    expect(publicShowtimeDatesResponseSchema.parse(body)).toEqual(body);
    expect(publicShowtimeDatesResponseSchema.parse({ dates: [] })).toEqual({ dates: [] });
  });

  it('rejects unsorted or repeated dates', () => {
    expect(
      publicShowtimeDatesResponseSchema.safeParse({ dates: ['2026-11-02', '2026-11-01'] }).success,
    ).toBe(false);
    expect(
      publicShowtimeDatesResponseSchema.safeParse({ dates: ['2026-11-01', '2026-11-01'] }).success,
    ).toBe(false);
  });

  it('rejects timestamps, invalid dates and unknown keys', () => {
    expect(
      publicShowtimeDatesResponseSchema.safeParse({ dates: ['2026-11-01T00:00:00.000Z'] }).success,
    ).toBe(false);
    expect(publicShowtimeDatesResponseSchema.safeParse({ dates: ['2026-02-30'] }).success).toBe(
      false,
    );
    expect(
      publicShowtimeDatesResponseSchema.safeParse({ dates: [], movieId: MOVIE_ID }).success,
    ).toBe(false);
  });
});

describe('publicShowtimeSchema / publicShowtimeListResponseSchema', () => {
  it('accepts a public showtime', () => {
    expect(publicShowtimeSchema.parse(validPublicShowtime)).toEqual(validPublicShowtime);
  });

  it('accepts a normalised format or null, and nothing else', () => {
    for (const format of ['2D', 'IMAX 3D', null]) {
      expect(publicShowtimeSchema.safeParse({ ...validPublicShowtime, format }).success).toBe(true);
    }
    for (const format of ['2d', ' 2D', '2D ', 'Imax 3D', '', '2D/3D', undefined]) {
      expect(publicShowtimeSchema.safeParse({ ...validPublicShowtime, format }).success).toBe(
        false,
      );
    }
  });

  it('requires the format key', () => {
    const { format: _format, ...withoutFormat } = validPublicShowtime;
    expect(publicShowtimeSchema.safeParse(withoutFormat).success).toBe(false);
  });

  it('accepts an override link as the resolved bookingUrl', () => {
    const showtime = { ...validPublicShowtime, bookingUrl: OVERRIDE_URL };
    expect(publicShowtimeSchema.safeParse(showtime).success).toBe(true);
  });

  it.each([
    ['bookingUrlOverride', OVERRIDE_URL],
    ['bookingUrlOverride', null],
    ['deletedAt', null],
    ['isActive', true],
    ['movieId', MOVIE_ID],
    ['screenId', SCREEN_ID],
    ['createdAt', '2026-10-01T04:30:00.000Z'],
    ['updatedAt', '2026-10-01T04:30:00.000Z'],
    ['endsAt', '2026-11-01T15:05:00.000Z'],
  ])('rejects an item carrying %s', (key, value) => {
    expect(publicShowtimeSchema.safeParse({ ...validPublicShowtime, [key]: value }).success).toBe(
      false,
    );
  });

  it('rejects screen internals', () => {
    const showtime = { ...validPublicShowtime, screen: { id: SCREEN_ID, name: 'Screen 1' } };
    expect(publicShowtimeSchema.safeParse(showtime).success).toBe(false);
  });

  it.each([
    'https://example.com/buytickets/sk-cinema-matara/20261101',
    'https://lk.bookmyshow.com/movies/x',
    'http://lk.bookmyshow.com/buytickets/sk-cinema-matara/20261101',
    `${DEFAULT_BMS_BASE_URL}/20261101?utm=1`,
    '',
  ])('rejects a non-BMS bookingUrl %j', (bookingUrl) => {
    expect(publicShowtimeSchema.safeParse({ ...validPublicShowtime, bookingUrl }).success).toBe(
      false,
    );
  });

  it('requires startsAt as an ISO UTC timestamp and time as HH:mm', () => {
    for (const startsAt of ['2026-11-01 13:00', '2026-11-01T18:30:00+05:30', '2026-11-01']) {
      expect(publicShowtimeSchema.safeParse({ ...validPublicShowtime, startsAt }).success).toBe(
        false,
      );
    }
    expect(publicShowtimeSchema.safeParse({ ...validPublicShowtime, time: '6:30' }).success).toBe(
      false,
    );
  });

  it('wraps in a list response, which may be empty', () => {
    expect(
      publicShowtimeListResponseSchema.safeParse({
        date: '2026-11-01',
        items: [validPublicShowtime],
      }).success,
    ).toBe(true);
    expect(
      publicShowtimeListResponseSchema.safeParse({ date: '2026-11-01', items: [] }).success,
    ).toBe(true);
  });

  it('rejects a list response containing an admin showtime or a bad date', () => {
    expect(
      publicShowtimeListResponseSchema.safeParse({
        date: '2026-11-01',
        items: [validAdminShowtime],
      }).success,
    ).toBe(false);
    expect(
      publicShowtimeListResponseSchema.safeParse({ date: '2026-02-30', items: [] }).success,
    ).toBe(false);
  });
});

describe('publicMovieSchema', () => {
  it('keeps the movie id, which the public showtime routes need', () => {
    expect(Object.keys(publicMovieSchema.shape)).toContain('id');
    expect(publicMovieSchema.shape.id.safeParse(MOVIE_ID).success).toBe(true);
  });
});

describe('adminShowtimeSchema and responses', () => {
  it('accepts an admin showtime', () => {
    expect(adminShowtimeSchema.parse(validAdminShowtime)).toEqual(validAdminShowtime);
  });

  it('accepts a normalised format or null, and nothing else', () => {
    for (const format of ['2D', 'IMAX 3D', null]) {
      expect(adminShowtimeSchema.safeParse({ ...validAdminShowtime, format }).success).toBe(true);
    }
    for (const format of ['2d', ' 2D', '2D ', 'Imax 3D', '', '2D/3D', undefined]) {
      expect(adminShowtimeSchema.safeParse({ ...validAdminShowtime, format }).success).toBe(false);
    }
  });

  it('requires the format key', () => {
    const { format: _format, ...withoutFormat } = validAdminShowtime;
    expect(adminShowtimeSchema.safeParse(withoutFormat).success).toBe(false);
  });

  it('accepts a soft-deleted showtime with an override', () => {
    const showtime = {
      ...validAdminShowtime,
      bookingUrlOverride: OVERRIDE_URL,
      bookingUrl: OVERRIDE_URL,
      deletedAt: '2026-10-03T00:00:00.000Z',
    };
    expect(adminShowtimeSchema.safeParse(showtime).success).toBe(true);
  });

  it('rejects a non-BMS resolved bookingUrl', () => {
    const showtime = { ...validAdminShowtime, bookingUrl: 'https://example.com/buytickets/x' };
    expect(adminShowtimeSchema.safeParse(showtime).success).toBe(false);
  });

  it('rejects unknown keys at every level', () => {
    expect(
      adminShowtimeSchema.safeParse({ ...validAdminShowtime, movieId: MOVIE_ID }).success,
    ).toBe(false);
    const movie = { ...validAdminShowtime.movie, slug: 'x' };
    expect(adminShowtimeSchema.safeParse({ ...validAdminShowtime, movie }).success).toBe(false);
    const screen = { ...validAdminShowtime.screen, capacity: 100 };
    expect(adminShowtimeSchema.safeParse({ ...validAdminShowtime, screen }).success).toBe(false);
  });

  it('requires ISO timestamps, a Colombo date and an HH:mm time', () => {
    for (const patch of [
      { startsAt: 'today' },
      { endsAt: '2026-11-01' },
      { colomboDate: '2026-11-01T00:00:00.000Z' },
      { time: '18:30:00' },
    ]) {
      expect(adminShowtimeSchema.safeParse({ ...validAdminShowtime, ...patch }).success).toBe(
        false,
      );
    }
  });

  it('wraps in list, single and bulk responses', () => {
    expect(
      adminShowtimeListResponseSchema.safeParse({
        items: [validAdminShowtime],
        page: 1,
        pageSize: 20,
        total: 1,
      }).success,
    ).toBe(true);
    expect(
      adminShowtimeListResponseSchema.safeParse({ items: [], page: 1, pageSize: 20 }).success,
    ).toBe(false);
    expect(adminShowtimeResponseSchema.safeParse({ showtime: validAdminShowtime }).success).toBe(
      true,
    );
    expect(
      showtimeBulkCreateResponseSchema.safeParse({ created: 1, items: [validAdminShowtime] })
        .success,
    ).toBe(true);
    expect(showtimeBulkDeleteResponseSchema.safeParse({ deleted: 3 }).success).toBe(true);
  });

  it('rejects a bulk create response whose count does not match its items', () => {
    expect(
      showtimeBulkCreateResponseSchema.safeParse({ created: 2, items: [validAdminShowtime] })
        .success,
    ).toBe(false);
    expect(showtimeBulkCreateResponseSchema.safeParse({ created: 0, items: [] }).success).toBe(
      false,
    );
  });

  it('rejects a negative bulk delete count and unknown keys', () => {
    expect(showtimeBulkDeleteResponseSchema.safeParse({ deleted: -1 }).success).toBe(false);
    expect(showtimeBulkDeleteResponseSchema.safeParse({ deleted: 1, ids: [] }).success).toBe(false);
  });
});

describe('showtime conflict details', () => {
  it('accepts a clash with a saved showtime', () => {
    expect(showtimeConflictDetailSchema.parse(validConflictDetail)).toEqual(validConflictDetail);
  });

  it('accepts a clash with another slot in the same request (showtimeId null)', () => {
    const detail = {
      ...validConflictDetail,
      conflict: { ...validConflictDetail.conflict, showtimeId: null },
    };
    expect(showtimeConflictDetailSchema.safeParse(detail).success).toBe(true);
  });

  it('rejects unknown keys and a bad requested time', () => {
    expect(
      showtimeConflictDetailSchema.safeParse({ ...validConflictDetail, screenId: SCREEN_ID })
        .success,
    ).toBe(false);
    const requested = { date: '2026-11-02', time: '24:00' };
    expect(
      showtimeConflictDetailSchema.safeParse({ ...validConflictDetail, requested }).success,
    ).toBe(false);
  });

  it('requires at least one detail', () => {
    expect(showtimeConflictDetailsSchema.safeParse([]).success).toBe(false);
    expect(showtimeConflictDetailsSchema.safeParse([validConflictDetail]).success).toBe(true);
  });

  it('describes the full 409 body with code CONFLICT', () => {
    const body = {
      error: {
        code: 'CONFLICT',
        message: 'This showtime overlaps another on the same screen',
        details: [validConflictDetail],
      },
    };
    expect(showtimeConflictErrorSchema.parse(body)).toEqual(body);
    expect(
      showtimeConflictErrorSchema.safeParse({ error: { ...body.error, code: 'VALIDATION_ERROR' } })
        .success,
    ).toBe(false);
  });
});

describe('use with the api validate middleware', () => {
  // validate() calls `.strict()` on every request schema, so each must stay a ZodObject and
  // keep its refinements when re-made strict.
  it('keeps object-level refinements after .strict()', () => {
    expect(showtimeUpdateBodySchema.strict().safeParse({}).success).toBe(false);
    expect(showtimeUpdateBodySchema.strict().safeParse({ date: '2026-11-02' }).success).toBe(false);
    expect(
      showtimeBulkCreateBodySchema
        .strict()
        .safeParse({ ...validBulk, dateFrom: '2026-11-01', dateTo: '2026-12-02' }).success,
    ).toBe(false);
    expect(
      adminShowtimeListQuerySchema.strict().safeParse({ from: '2026-11-02', to: '2026-11-01' })
        .success,
    ).toBe(false);
    expect(
      showtimeBulkDeleteBodySchema.strict().safeParse({ ids: [OTHER_ID, OTHER_ID] }).success,
    ).toBe(false);
  });
});
