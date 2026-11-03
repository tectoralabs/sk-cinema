import { DEFAULT_BMS_BASE_URL } from '@sk-cinema/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INVALID_BOOKING_URL_OVERRIDE,
  buildBmsLink,
  formatBmsDate,
  resolveBookingUrl,
} from './bmsLink.js';

const BASE = DEFAULT_BMS_BASE_URL;
const at = (iso: string) => new Date(iso);

describe('formatBmsDate', () => {
  it.each([
    // PLAN Done-when: 10:00 Colombo on 1 Nov.
    ['2026-11-01T04:30:00.000Z', '20261101'],
    // PLAN: 00:30 Colombo on 2 Nov is still 1 Nov in UTC.
    ['2026-11-01T19:00:00.000Z', '20261102'],
    // Colombo midnight is 18:30 UTC the day before.
    ['2026-10-31T18:29:59.999Z', '20261031'],
    ['2026-10-31T18:30:00.000Z', '20261101'],
    // 23:59 Colombo on 1 Nov.
    ['2026-11-01T18:29:00.000Z', '20261101'],
    // Year end: 00:00 Colombo on 1 Jan 2027.
    ['2026-12-31T18:30:00.000Z', '20270101'],
    ['2026-12-31T18:29:59.999Z', '20261231'],
    // Leap day.
    ['2028-02-28T18:30:00.000Z', '20280229'],
  ])('%s -> %s', (instant, expected) => {
    expect(formatBmsDate(at(instant))).toBe(expected);
  });

  it('rejects an invalid date', () => {
    expect(() => formatBmsDate(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe('server time zone', () => {
  const original = process.env['TZ'];
  afterEach(() => {
    if (original === undefined) delete process.env['TZ'];
    else process.env['TZ'] = original;
  });

  // UTC-08:00 and UTC+14:00: on either side of Colombo, so a local-time bug would shift dates.
  it.each(['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC'])(
    'gives the same Colombo dates when the server runs in %s',
    (zone) => {
      process.env['TZ'] = zone;
      // Proves the zone change took effect (January: no daylight saving in Los Angeles).
      const offsetMinutes = { 'America/Los_Angeles': 480, 'Pacific/Kiritimati': -840, UTC: 0 };
      expect(at('2026-01-15T00:00:00.000Z').getTimezoneOffset()).toBe(
        offsetMinutes[zone as keyof typeof offsetMinutes],
      );

      expect(formatBmsDate(at('2026-11-01T04:30:00.000Z'))).toBe('20261101');
      expect(formatBmsDate(at('2026-11-01T19:00:00.000Z'))).toBe('20261102');
      expect(formatBmsDate(at('2026-10-31T18:29:59.999Z'))).toBe('20261031');
      expect(formatBmsDate(at('2026-10-31T18:30:00.000Z'))).toBe('20261101');
      expect(formatBmsDate(at('2026-12-31T18:30:00.000Z'))).toBe('20270101');
    },
  );
});

describe('buildBmsLink', () => {
  it('builds the PLAN example link for a 10:00 Colombo show on 1 Nov 2026', () => {
    expect(buildBmsLink(BASE, at('2026-11-01T04:30:00.000Z'))).toBe(
      'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/cinema-snlk-SKCM-MT/20261101',
    );
  });

  it('uses the Colombo date for a 00:30 show on 2 Nov', () => {
    expect(buildBmsLink(BASE, at('2026-11-01T19:00:00.000Z'))).toBe(`${BASE}/20261102`);
  });

  it('works with any valid base URL, including the longest allowed (500 characters)', () => {
    const custom = 'https://lk.bookmyshow.com/buytickets/other-cinema/cinema-X';
    expect(buildBmsLink(custom, at('2026-11-01T04:30:00.000Z'))).toBe(`${custom}/20261101`);

    const longest = `${BASE}/${'a'.repeat(500 - BASE.length - 1)}`;
    expect(longest).toHaveLength(500);
    expect(buildBmsLink(longest, at('2026-11-01T04:30:00.000Z'))).toBe(`${longest}/20261101`);
  });

  it.each([
    ['another host', 'https://evil.example/buytickets/x'],
    ['http', 'http://lk.bookmyshow.com/buytickets/sk-cinema-matara/cinema-snlk-SKCM-MT'],
    ['a trailing slash', `${BASE}/`],
    ['a query string', `${BASE}?next=evil`],
    ['padding', ` ${BASE}`],
    ['an empty base', ''],
    ['an over-long base', `${BASE}/${'a'.repeat(501 - BASE.length - 1)}`],
  ])('throws for a base URL with %s, without the URL in the message', (_case, base) => {
    let thrown: unknown;
    try {
      buildBmsLink(base, at('2026-11-01T04:30:00.000Z'));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toBe('Generated BookMyShow link failed validation');
    expect(message).not.toContain('http');
    expect(message).not.toContain('evil');
    expect(message).not.toContain('bookmyshow.com');
  });
});

describe('resolveBookingUrl', () => {
  const startsAt = at('2026-11-01T19:00:00.000Z');
  const generated = `${BASE}/20261102`;
  const showtimeId = '01900000-0000-7000-8000-000000000001';
  const setup = () => ({ warn: vi.fn() });

  it.each([null, undefined])('uses the generated link when the override is %s, silently', (o) => {
    const logger = setup();
    const url = resolveBookingUrl(
      { showtimeId, bookingUrlOverride: o, baseUrl: BASE, startsAt },
      logger,
    );
    expect(url).toBe(generated);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns a valid override exactly as stored', () => {
    const logger = setup();
    const override = 'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/movie-ET00012345/2';
    const url = resolveBookingUrl(
      { showtimeId, bookingUrlOverride: override, baseUrl: BASE, startsAt },
      logger,
    );
    expect(url).toBe(override);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('prefers a valid override even when the base URL is invalid', () => {
    const logger = setup();
    const override = `${BASE}/20261225`;
    const url = resolveBookingUrl(
      { showtimeId, bookingUrlOverride: override, baseUrl: 'http://evil.example', startsAt },
      logger,
    );
    expect(url).toBe(override);
  });

  it.each([
    ['http', 'http://lk.bookmyshow.com/buytickets/sk-cinema-matara/evil'],
    ['another host', 'https://evil.example/buytickets/sk-cinema-matara'],
    ['a look-alike host', 'https://lk.bookmyshow.com.evil.example/buytickets/x'],
    ['userinfo', 'https://lk.bookmyshow.com@evil.example/buytickets/x'],
    ['a query string', `${BASE}/20261102?next=https://evil.example`],
    ['a fragment', `${BASE}/20261102#evil`],
    ['a trailing slash', `${BASE}/evil/`],
    ['leading whitespace', ` ${BASE}/evil`],
    ['trailing whitespace', `${BASE}/evil `],
    ['an empty string', ''],
    ['a javascript: URL', 'javascript:alert("evil")'],
    ['dot segments', `${BASE}/../../evil`],
  ])('falls back to the generated link for an override with %s and warns once', (_c, override) => {
    const logger = setup();
    const url = resolveBookingUrl(
      { showtimeId, bookingUrlOverride: override, baseUrl: BASE, startsAt },
      logger,
    );
    expect(url).toBe(generated);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const args = logger.warn.mock.calls[0] ?? [];
    expect(args[0]).toEqual({ showtimeId, reason: INVALID_BOOKING_URL_OVERRIDE });
    expect(Object.keys(args[0] as object).sort()).toEqual(['reason', 'showtimeId']);
    expect(typeof args[1]).toBe('string');
    expect(args).toHaveLength(2);

    const logged = JSON.stringify(args);
    if (override.length > 0) expect(logged).not.toContain(override);
    if (override.trim().length > 0) expect(logged).not.toContain(override.trim());
    expect(logged).not.toContain('evil');
    expect(logged).not.toContain('http');
    expect(logged).not.toContain('bookmyshow');
  });

  it('still throws (not returns) when both the override and the base URL are invalid', () => {
    const logger = setup();
    expect(() =>
      resolveBookingUrl(
        {
          showtimeId,
          bookingUrlOverride: 'https://evil.example/x',
          baseUrl: 'https://evil.example',
          startsAt,
        },
        logger,
      ),
    ).toThrow('Generated BookMyShow link failed validation');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
