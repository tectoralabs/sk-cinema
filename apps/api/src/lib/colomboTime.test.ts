import { describe, expect, it } from 'vitest';
import { addDays, fromColomboDateTime, toColomboDate } from './colomboTime.js';

describe('toColomboDate', () => {
  it('uses the Colombo date, not the UTC date', () => {
    // 2026-10-31T19:00Z is 2026-11-01 00:30 in Colombo.
    expect(toColomboDate(new Date('2026-10-31T19:00:00Z'))).toBe('2026-11-01');
  });

  it('keeps the same date late in the Colombo evening', () => {
    // 2026-11-01T18:00Z is 2026-11-01 23:30 in Colombo.
    expect(toColomboDate(new Date('2026-11-01T18:00:00Z'))).toBe('2026-11-01');
  });
});

describe('fromColomboDateTime', () => {
  it('converts Colombo wall-clock time to UTC', () => {
    expect(fromColomboDateTime('2026-11-01', '18:30').toISOString()).toBe(
      '2026-11-01T13:00:00.000Z',
    );
  });

  it('handles a show after midnight', () => {
    const instant = fromColomboDateTime('2026-11-01', '00:30');
    expect(instant.toISOString()).toBe('2026-10-31T19:00:00.000Z');
    expect(toColomboDate(instant)).toBe('2026-11-01');
  });

  it.each([
    ['2026-02-30', '10:00'],
    ['2026-13-01', '10:00'],
    ['2026-11-01', '24:00'],
    ['2026-11-01', '9:30'],
    ['01-11-2026', '10:00'],
  ])('rejects %s %s', (date, time) => {
    expect(() => fromColomboDateTime(date, time)).toThrow(RangeError);
  });
});

describe('addDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
  });

  it('handles leap years', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});
