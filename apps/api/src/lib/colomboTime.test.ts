import { describe, expect, it } from 'vitest';
import { addDays, fromColomboDateTime, toColomboDate, toColomboTime } from './colomboTime.js';

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

describe('toColomboTime', () => {
  it('uses the Colombo wall clock (UTC+05:30), 24-hour', () => {
    expect(toColomboTime(new Date('2026-11-01T13:30:00Z'))).toBe('19:00');
    expect(toColomboTime(new Date('2026-11-01T18:29:00Z'))).toBe('23:59');
  });

  it('shows Colombo midnight as 00:00, never 24:00', () => {
    // 2026-10-31T18:30Z is 2026-11-01 00:00 in Colombo.
    expect(toColomboTime(new Date('2026-10-31T18:30:00Z'))).toBe('00:00');
    expect(toColomboTime(new Date('2026-11-01T19:00:00Z'))).toBe('00:30');
  });

  it('drops seconds and milliseconds', () => {
    expect(toColomboTime(new Date('2026-11-01T13:30:59.999Z'))).toBe('19:00');
  });

  it('round-trips with fromColomboDateTime', () => {
    for (const time of ['00:00', '05:29', '05:30', '12:00', '23:59']) {
      expect(toColomboTime(fromColomboDateTime('2026-11-02', time))).toBe(time);
    }
  });

  it('throws for an invalid Date', () => {
    expect(() => toColomboTime(new Date(Number.NaN))).toThrow(RangeError);
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
