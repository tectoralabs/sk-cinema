import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  calendarDateSchema,
  deletedFilterSchema,
  emptyBodySchema,
  emptyQuerySchema,
  pageQuerySchema,
  pageSizeQuerySchema,
  queryBooleanSchema,
  queryIntSchema,
  querySearchSchema,
} from './common.js';

/** One safeParse and how long it took, after a warm-up parse so JIT compilation is not timed. */
function timeSafeParse<S extends z.ZodType>(schema: S, input: unknown) {
  schema.safeParse('warm-up');
  const start = performance.now();
  const result = schema.safeParse(input);
  return { result, ms: performance.now() - start };
}

describe.each([
  ['emptyBodySchema', emptyBodySchema],
  ['emptyQuerySchema', emptyQuerySchema],
])('%s', (_name, schema) => {
  it('accepts an empty object', () => {
    expect(schema.parse({})).toEqual({});
  });

  it('rejects any key', () => {
    expect(schema.safeParse({ refreshToken: 'x' }).success).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(schema.safeParse([]).success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
  });
});

describe('calendarDateSchema', () => {
  it.each(['2026-11-01', '2028-02-29', '2000-02-29', '2026-12-31'])('accepts %s', (date) => {
    expect(calendarDateSchema.parse(date)).toBe(date);
  });

  it.each([
    '2026-02-30',
    '2027-02-29',
    '1900-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-11-31',
    '26-11-01',
    '2026-1-01',
    '2026/11/01',
    ' 2026-11-01',
    '2026-11-01T00:00:00Z',
    '',
  ])('rejects %s', (date) => {
    expect(calendarDateSchema.safeParse(date).success).toBe(false);
  });

  it('rejects a ~100 KB string quickly', () => {
    const { result, ms } = timeSafeParse(calendarDateSchema, `2026-11-01${'1'.repeat(100_000)}`);
    expect(ms).toBeLessThan(50);
    expect(result.success).toBe(false);
  });
});

describe('queryIntSchema', () => {
  const schema = queryIntSchema(1, 50);

  it('converts digits to a number within the bounds', () => {
    expect(schema.parse('1')).toBe(1);
    expect(schema.parse('50')).toBe(50);
  });

  it.each(['0', '51', '-1', '1.5', '1e1', ' 2', '', 'x', '1234567'])('rejects %j', (value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it('rejects numbers (query values are strings)', () => {
    expect(schema.safeParse(5).success).toBe(false);
  });

  it('rejects a ~100 KB string quickly', () => {
    const { result, ms } = timeSafeParse(schema, '1'.repeat(100_000));
    expect(ms).toBeLessThan(50);
    expect(result.success).toBe(false);
  });
});

describe('queryBooleanSchema', () => {
  it("maps 'true' and 'false'", () => {
    expect(queryBooleanSchema.parse('true')).toBe(true);
    expect(queryBooleanSchema.parse('false')).toBe(false);
  });

  it.each(['1', '0', 'TRUE', 'yes', '', true])('rejects %j', (value) => {
    expect(queryBooleanSchema.safeParse(value).success).toBe(false);
  });
});

describe('querySearchSchema', () => {
  it('trims, and treats whitespace-only as no search', () => {
    expect(querySearchSchema.parse('  abc ')).toBe('abc');
    expect(querySearchSchema.parse('   ')).toBeUndefined();
  });

  it('rejects more than 100 characters', () => {
    expect(querySearchSchema.safeParse('s'.repeat(100)).success).toBe(true);
    expect(querySearchSchema.safeParse('s'.repeat(101)).success).toBe(false);
  });
});

describe('deletedFilterSchema / pageQuerySchema / pageSizeQuerySchema', () => {
  it('accepts the three deleted filters only', () => {
    for (const value of ['exclude', 'include', 'only']) {
      expect(deletedFilterSchema.safeParse(value).success).toBe(true);
    }
    expect(deletedFilterSchema.safeParse('all').success).toBe(false);
  });

  it('defaults page to 1 and pageSize to 20', () => {
    expect(pageQuerySchema.parse(undefined)).toBe(1);
    expect(pageSizeQuerySchema.parse(undefined)).toBe(20);
  });

  it('caps pageSize at 100', () => {
    expect(pageSizeQuerySchema.parse('100')).toBe(100);
    expect(pageSizeQuerySchema.safeParse('101').success).toBe(false);
  });
});
