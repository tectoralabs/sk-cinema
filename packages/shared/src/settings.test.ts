import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { DEFAULT_BMS_BASE_URL } from './bms.js';
import {
  DEFAULT_SHOW_GAP_MINUTES,
  SHOW_GAP_MINUTES_MAX,
  SHOW_GAP_MINUTES_MIN,
  adminSettingsResponseSchema,
  adminSettingsSchema,
  parseStoredBmsBaseUrl,
  parseStoredShowGapMinutes,
  settingsUpdateBodySchema,
  showGapMinutesSchema,
  storedShowGapMinutesSchema,
} from './settings.js';

const ADMIN_ID = '01928f6e-7c3a-7b2e-9f4d-3a1b2c3d4e5f';
const OTHER_BASE = 'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/cinema-snlk-SKCM-NEW';

/** One safeParse and how long it took, after a warm-up parse so JIT compilation is not timed. */
function timeSafeParse<S extends z.ZodType>(schema: S, input: unknown) {
  schema.safeParse('warm-up');
  const start = performance.now();
  const result = schema.safeParse(input);
  return { result, ms: performance.now() - start };
}

const validSettings = {
  bmsBaseUrl: DEFAULT_BMS_BASE_URL,
  showGapMinutes: 15,
  updatedAt: '2026-10-01T04:30:00.000Z',
  updatedBy: { id: ADMIN_ID, name: 'Owner' },
};

describe('constants', () => {
  it('use the approved default and bounds', () => {
    expect(DEFAULT_SHOW_GAP_MINUTES).toBe(15);
    expect(SHOW_GAP_MINUTES_MIN).toBe(0);
    expect(SHOW_GAP_MINUTES_MAX).toBe(120);
  });
});

describe('showGapMinutesSchema', () => {
  it.each([0, 15, 120])('accepts %d', (value) => {
    expect(showGapMinutesSchema.parse(value)).toBe(value);
  });

  it.each([-1, 121, 1.5, '15', Number.NaN, Number.POSITIVE_INFINITY, null])(
    'rejects %j',
    (value) => {
      expect(showGapMinutesSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('settingsUpdateBodySchema', () => {
  it('accepts either setting or both', () => {
    expect(settingsUpdateBodySchema.parse({ bmsBaseUrl: OTHER_BASE })).toEqual({
      bmsBaseUrl: OTHER_BASE,
    });
    expect(settingsUpdateBodySchema.parse({ showGapMinutes: 0 })).toEqual({ showGapMinutes: 0 });
    expect(settingsUpdateBodySchema.parse({ bmsBaseUrl: OTHER_BASE, showGapMinutes: 120 })).toEqual(
      { bmsBaseUrl: OTHER_BASE, showGapMinutes: 120 },
    );
  });

  it('trims the base URL', () => {
    expect(settingsUpdateBodySchema.parse({ bmsBaseUrl: `  ${OTHER_BASE} ` }).bmsBaseUrl).toBe(
      OTHER_BASE,
    );
  });

  it('rejects an empty body', () => {
    const result = settingsUpdateBodySchema.safeParse({});
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'Provide at least one setting to update',
    ]);
  });

  it.each([-1, 121, 1.5, '15', null])('rejects showGapMinutes %j', (showGapMinutes) => {
    expect(settingsUpdateBodySchema.safeParse({ showGapMinutes }).success).toBe(false);
  });

  it.each([
    'https://example.com/buytickets/sk-cinema-matara',
    'https://lk.bookmyshow.com/movies/x',
    `${DEFAULT_BMS_BASE_URL}/`,
    `${DEFAULT_BMS_BASE_URL}?x=1`,
    '',
    null,
  ])('rejects bmsBaseUrl %j', (bmsBaseUrl) => {
    expect(settingsUpdateBodySchema.safeParse({ bmsBaseUrl }).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(settingsUpdateBodySchema.safeParse({ showGapMinutes: 10, theme: 'dark' }).success).toBe(
      false,
    );
    expect(settingsUpdateBodySchema.safeParse({ updatedAt: '2026-10-01' }).success).toBe(false);
  });

  it('rejects a ~100 KB base URL quickly', () => {
    const { result, ms } = timeSafeParse(settingsUpdateBodySchema, {
      bmsBaseUrl: `${DEFAULT_BMS_BASE_URL}/${'a/'.repeat(50_000)}`,
    });
    expect(ms).toBeLessThan(50);
    expect(result.success).toBe(false);
  });
});

describe('adminSettingsSchema', () => {
  it('accepts settings, and null audit fields while every value is the default', () => {
    const defaults = { ...validSettings, updatedAt: null, updatedBy: null };
    expect(adminSettingsSchema.safeParse(defaults).success).toBe(true);
  });

  it('accepts a row no admin has saved: updatedAt without updatedBy', () => {
    const seeded = { ...validSettings, updatedBy: null };
    expect(adminSettingsSchema.safeParse(seeded).success).toBe(true);
  });

  it('rejects a non-BMS base URL and an out-of-range gap', () => {
    expect(
      adminSettingsSchema.safeParse({ ...validSettings, bmsBaseUrl: 'https://example.com/x' })
        .success,
    ).toBe(false);
    expect(adminSettingsSchema.safeParse({ ...validSettings, showGapMinutes: 121 }).success).toBe(
      false,
    );
  });

  it('rejects unknown keys, including on updatedBy', () => {
    expect(adminSettingsSchema.safeParse({ ...validSettings, secret: 'x' }).success).toBe(false);
    const updatedBy = { ...validSettings.updatedBy, email: 'owner@example.com' };
    expect(adminSettingsSchema.safeParse({ ...validSettings, updatedBy }).success).toBe(false);
  });
});

describe('adminSettingsResponseSchema', () => {
  it.each([0, 1, 250])('accepts futureShowtimesBelowGap %d beside settings', (count) => {
    const body = { settings: validSettings, futureShowtimesBelowGap: count };
    expect(adminSettingsResponseSchema.parse(body)).toEqual(body);
  });

  it('requires futureShowtimesBelowGap', () => {
    expect(adminSettingsResponseSchema.safeParse({ settings: validSettings }).success).toBe(false);
  });

  it.each([-1, 1.5, '1', null, Number.NaN])('rejects futureShowtimesBelowGap %j', (count) => {
    const body = { settings: validSettings, futureShowtimesBelowGap: count };
    expect(adminSettingsResponseSchema.safeParse(body).success).toBe(false);
  });

  it('rejects unknown keys, and the count nested inside settings', () => {
    const base = { settings: validSettings, futureShowtimesBelowGap: 0 };
    expect(adminSettingsResponseSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(
      adminSettingsResponseSchema.safeParse({
        settings: { ...validSettings, futureShowtimesBelowGap: 0 },
        futureShowtimesBelowGap: 0,
      }).success,
    ).toBe(false);
  });
});

describe('storedShowGapMinutesSchema / parseStoredShowGapMinutes', () => {
  it.each([
    ['0', 0],
    ['15', 15],
    ['120', 120],
    ['015', 15],
  ])('parses %j', (stored, expected) => {
    expect(storedShowGapMinutesSchema.parse(stored)).toBe(expected);
    expect(parseStoredShowGapMinutes(stored)).toBe(expected);
  });

  it.each(['121', '-1', '1.5', '', ' 15', '15 ', '1e1', 'abc', '0x10', '1000'])(
    'rejects %j and falls back to the default',
    (stored) => {
      expect(storedShowGapMinutesSchema.safeParse(stored).success).toBe(false);
      expect(parseStoredShowGapMinutes(stored)).toBe(DEFAULT_SHOW_GAP_MINUTES);
    },
  );

  it('falls back to the default when missing', () => {
    expect(parseStoredShowGapMinutes(null)).toBe(DEFAULT_SHOW_GAP_MINUTES);
    expect(parseStoredShowGapMinutes(undefined)).toBe(DEFAULT_SHOW_GAP_MINUTES);
  });

  it('rejects numbers (stored values are strings)', () => {
    expect(storedShowGapMinutesSchema.safeParse(15).success).toBe(false);
  });

  it('rejects a ~100 KB stored value quickly with only a length issue', () => {
    const { result, ms } = timeSafeParse(storedShowGapMinutesSchema, '1'.repeat(100_000));
    expect(ms).toBeLessThan(50);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.code)).toEqual(['too_big']);
  });
});

describe('parseStoredBmsBaseUrl', () => {
  it('returns a valid stored base URL as is', () => {
    expect(parseStoredBmsBaseUrl(OTHER_BASE)).toBe(OTHER_BASE);
    expect(parseStoredBmsBaseUrl(DEFAULT_BMS_BASE_URL)).toBe(DEFAULT_BMS_BASE_URL);
  });

  it.each([
    null,
    undefined,
    '',
    'https://example.com/buytickets/x',
    `${OTHER_BASE}/`,
    ` ${OTHER_BASE}`,
    `${OTHER_BASE}#x`,
    `https://lk.bookmyshow.com/buytickets/${'a'.repeat(500)}`,
  ])('falls back to the default for %j', (stored) => {
    expect(parseStoredBmsBaseUrl(stored)).toBe(DEFAULT_BMS_BASE_URL);
  });
});

describe('use with the api validate middleware', () => {
  it('keeps the at-least-one refinement after .strict()', () => {
    expect(settingsUpdateBodySchema.strict().safeParse({}).success).toBe(false);
    expect(settingsUpdateBodySchema.strict().safeParse({ showGapMinutes: 5 }).success).toBe(true);
  });
});
