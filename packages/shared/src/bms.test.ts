import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  BMS_BOOKING_URL_PREFIX,
  BMS_LINK_MAX_LENGTH,
  BMS_URL_MAX_LENGTH,
  DEFAULT_BMS_BASE_URL,
  bmsBaseUrlSchema,
  bookingUrlOverrideSchema,
  isBmsBookingUrl,
} from './bms.js';

const PREFIX = 'https://lk.bookmyshow.com/buytickets/';
const CINEMA_PATH = 'sk-cinema-matara/cinema-snlk-SKCM-MT';
const BASE = `${PREFIX}${CINEMA_PATH}`;

/** One safeParse and how long it took, after a warm-up parse so JIT compilation is not timed. */
function timeSafeParse<S extends z.ZodType>(schema: S, input: unknown) {
  schema.safeParse('warm-up');
  const start = performance.now();
  const result = schema.safeParse(input);
  return { result, ms: performance.now() - start };
}

const schemas = [
  ['bmsBaseUrlSchema', bmsBaseUrlSchema],
  ['bookingUrlOverrideSchema', bookingUrlOverrideSchema],
] as const;

describe('constants', () => {
  it('uses the documented default base URL and prefix', () => {
    expect(DEFAULT_BMS_BASE_URL).toBe(BASE);
    expect(BMS_BOOKING_URL_PREFIX).toBe(PREFIX);
    expect(BMS_URL_MAX_LENGTH).toBe(500);
    expect(BMS_LINK_MAX_LENGTH).toBe(509);
  });
});

/** Accepted by both schemas and by isBmsBookingUrl, unchanged. */
const accepted: [string, string][] = [
  ['the default base URL', BASE],
  ['the default base URL plus a date', `${BASE}/20261101`],
  ['an example override', `${PREFIX}sk-cinema-matara/cinema-snlk-SKCM-MT/20261225`],
  ['a single path segment', `${PREFIX}sk-cinema-matara`],
  ['dots, underscores and tildes inside segments', `${PREFIX}a.b_c~d/e..f/.g`],
  ['exactly 500 characters', `${PREFIX}${'a'.repeat(BMS_URL_MAX_LENGTH - PREFIX.length)}`],
];

/** Rejected by both schemas and by isBmsBookingUrl. */
const rejected: [string, string][] = [
  ['empty', ''],
  ['http scheme', `http://lk.bookmyshow.com/buytickets/${CINEMA_PATH}`],
  ['protocol-relative', `//lk.bookmyshow.com/buytickets/${CINEMA_PATH}`],
  ['no scheme', `lk.bookmyshow.com/buytickets/${CINEMA_PATH}`],
  ['another BookMyShow host', `https://in.bookmyshow.com/buytickets/${CINEMA_PATH}`],
  ['bare bookmyshow.com', `https://bookmyshow.com/buytickets/${CINEMA_PATH}`],
  ['another host', `https://evil.com/buytickets/${CINEMA_PATH}`],
  ['look-alike host suffix', `https://lk.bookmyshow.com.evil.com/buytickets/${CINEMA_PATH}`],
  ['BMS host inside another host path', `https://evil.com/lk.bookmyshow.com/buytickets/`],
  ['userinfo before the host', `https://x@lk.bookmyshow.com/buytickets/${CINEMA_PATH}`],
  ['BMS host as userinfo', `https://lk.bookmyshow.com@evil.com/buytickets/${CINEMA_PATH}`],
  ['default port :443', `https://lk.bookmyshow.com:443/buytickets/${CINEMA_PATH}`],
  ['port :8443', `https://lk.bookmyshow.com:8443/buytickets/${CINEMA_PATH}`],
  ['uppercase scheme and host', `HTTPS://LK.BOOKMYSHOW.COM/buytickets/${CINEMA_PATH}`],
  ['uppercase scheme', `HTTPS://lk.bookmyshow.com/buytickets/${CINEMA_PATH}`],
  ['uppercase host', `https://LK.BookMyShow.com/buytickets/${CINEMA_PATH}`],
  ['trailing dot on the host', `https://lk.bookmyshow.com./buytickets/${CINEMA_PATH}`],
  ['/buytickets without a slash', 'https://lk.bookmyshow.com/buytickets'],
  ['/buyticketsx/', `https://lk.bookmyshow.com/buyticketsx/${CINEMA_PATH}`],
  ['/BUYTICKETS/', `https://lk.bookmyshow.com/BUYTICKETS/${CINEMA_PATH}`],
  ['/buytickets/ not first', `https://lk.bookmyshow.com/other/buytickets/${CINEMA_PATH}`],
  ['host root', 'https://lk.bookmyshow.com/'],
  ['only the prefix', PREFIX],
  ['encoded slash %2f', `${PREFIX}sk-cinema-matara%2fcinema-snlk-SKCM-MT`],
  ['encoded slash %2F', `${PREFIX}sk-cinema-matara%2Fcinema-snlk-SKCM-MT`],
  ['encoded dot-dot %2e%2e', `${PREFIX}%2e%2e/%2e%2e/evil`],
  ['any percent-encoding', `${PREFIX}sk%2Dcinema`],
  ['a lone %', `${PREFIX}sk-cinema%`],
  ['backslash in the path', `${PREFIX}sk-cinema-matara\\cinema-snlk-SKCM-MT`],
  ['backslash after the host', `https://lk.bookmyshow.com\\buytickets\\${CINEMA_PATH}`],
  ['/./ segment', `${PREFIX}sk-cinema-matara/./cinema-snlk-SKCM-MT`],
  ['/../ segment', `${PREFIX}sk-cinema-matara/../../evil`],
  ['only ..', `${PREFIX}..`],
  ['only .', `${PREFIX}.`],
  ['// in the path', `${PREFIX}sk-cinema-matara//cinema-snlk-SKCM-MT`],
  ['// right after /buytickets', `${PREFIX}/${CINEMA_PATH}`],
  ['trailing slash', `${BASE}/`],
  ['query string', `${BASE}?q=1`],
  ['empty query string', `${BASE}?`],
  ['fragment', `${BASE}#frag`],
  ['empty fragment', `${BASE}#`],
  ['tab inside', `${PREFIX}sk-cinema-matara/\tcinema-snlk-SKCM-MT`],
  ['newline inside', `${PREFIX}sk-cinema-matara/\ncinema-snlk-SKCM-MT`],
  ['carriage return inside', `${PREFIX}sk-cinema-matara\r/cinema-snlk-SKCM-MT`],
  ['tab inside the scheme', `htt\tps://lk.bookmyshow.com/buytickets/${CINEMA_PATH}`],
  ['newline inside the host', `https://lk.book\nmyshow.com/buytickets/${CINEMA_PATH}`],
  ['space inside', `${PREFIX}sk cinema matara`],
  ['null character inside', `${PREFIX}sk-cinema\u0000/x`],
  ['userinfo-like @ in the path', `${PREFIX}x@evil.com`],
  ['colon in the path', `${PREFIX}javascript:alert(1)`],
  ['non-ASCII letter in the path', `${PREFIX}sk-cinéma-matara`],
  ['IDN look-alike host (Cyrillic o)', `https://lk.bookmyshоw.com/buytickets/${CINEMA_PATH}`],
  ['punycode look-alike host', `https://lk.xn--bookmyshw-xyz.com/buytickets/${CINEMA_PATH}`],
  ['fullwidth slash', `https://lk.bookmyshow.com／buytickets/${CINEMA_PATH}`],
  ['javascript: URL', 'javascript:alert(1)'],
  ['javascript: URL with the BMS host', 'javascript://lk.bookmyshow.com/buytickets/%0Aalert(1)'],
  ['data: URL', 'data:text/html,hi'],
  ['501 characters', `${PREFIX}${'a'.repeat(BMS_URL_MAX_LENGTH - PREFIX.length + 1)}`],
];

describe.each(schemas)('%s', (_name, schema) => {
  it.each(accepted)('accepts %s', (_case, url) => {
    expect(schema.parse(url)).toBe(url);
  });

  it('trims surrounding whitespace', () => {
    expect(schema.parse(`  \t${BASE}\n `)).toBe(BASE);
  });

  it.each(rejected)('rejects %s', (_case, url) => {
    expect(schema.safeParse(url).success).toBe(false);
  });

  it('rejects non-strings', () => {
    for (const value of [null, undefined, 42, {}, [BASE]]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it('gives one clear message for an empty or whitespace-only value', () => {
    for (const value of ['', '   ']) {
      const result = schema.safeParse(value);
      expect(result.error?.issues.map((issue) => issue.message)).toEqual([
        'Enter a BookMyShow link',
      ]);
    }
  });

  it('gives one admin-friendly message per problem, without echoing the input', () => {
    const cases: [string, string][] = [
      [`https://evil.example/buytickets/${CINEMA_PATH}`, `Must start with ${PREFIX}`],
      [PREFIX, `Add the cinema path after ${PREFIX}`],
      [
        `${BASE}?evil=example`,
        'Use only letters, digits, "-", "_", ".", "~" and "/" after /buytickets/ (no spaces, "%", query string or "#")',
      ],
      [`${BASE}/`, 'Remove the "/" at the end of the link'],
      [`${PREFIX}evil//example`, 'The link must not contain "//", "/./" or "/../"'],
    ];
    for (const [url, message] of cases) {
      const issues = schema.safeParse(url).error?.issues ?? [];
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).toEqual(message);
      expect(issues[0]?.message).not.toContain('evil');
      expect(issues[0]?.message).not.toContain('example');
    }
  });

  it('reports only too_big for over-long input', () => {
    const result = schema.safeParse(`${BASE}/${'x'.repeat(BMS_URL_MAX_LENGTH)}`);
    expect(result.error?.issues.map((issue) => issue.code)).toEqual(['too_big']);
  });

  it('rejects 100 KB of input quickly with only too_big', () => {
    for (const input of [
      'a'.repeat(100_000),
      `${PREFIX}${'a/'.repeat(50_000)}`,
      `${PREFIX}${'/.'.repeat(50_000)}`,
      `${BASE}/${'%'.repeat(100_000)}`,
    ]) {
      const { result, ms } = timeSafeParse(schema, input);
      expect(ms).toBeLessThan(50);
      expect(result.error?.issues.map((issue) => issue.code)).toEqual(['too_big']);
    }
  });
});

describe('isBmsBookingUrl', () => {
  it.each(accepted)('accepts %s', (_case, url) => {
    expect(isBmsBookingUrl(url)).toBe(true);
  });

  // Over-long input is covered below: built links may be up to BMS_LINK_MAX_LENGTH.
  it.each(rejected.filter(([, url]) => url.length <= BMS_URL_MAX_LENGTH))(
    'rejects %s',
    (_case, url) => {
      expect(isBmsBookingUrl(url)).toBe(false);
    },
  );

  it('does not trim: surrounding whitespace is rejected', () => {
    expect(isBmsBookingUrl(` ${BASE}`)).toBe(false);
    expect(isBmsBookingUrl(`${BASE}\n`)).toBe(false);
  });

  it('accepts a link built from a 500-character base URL', () => {
    const longestBase = `${PREFIX}${'a'.repeat(BMS_URL_MAX_LENGTH - PREFIX.length)}`;
    expect(bmsBaseUrlSchema.parse(longestBase)).toBe(longestBase);
    expect(isBmsBookingUrl(`${longestBase}/20261101`)).toBe(true);
  });

  it('rejects anything longer than a built link', () => {
    expect(isBmsBookingUrl(`${PREFIX}${'a'.repeat(BMS_LINK_MAX_LENGTH - PREFIX.length)}`)).toBe(
      true,
    );
    expect(isBmsBookingUrl(`${PREFIX}${'a'.repeat(BMS_LINK_MAX_LENGTH - PREFIX.length + 1)}`)).toBe(
      false,
    );
  });

  it('rejects 100 KB of input quickly', () => {
    isBmsBookingUrl('warm-up');
    for (const input of [
      'a'.repeat(100_000),
      `${PREFIX}${'a/'.repeat(50_000)}`,
      `${PREFIX}${'a'.repeat(100_000)}`,
    ]) {
      const start = performance.now();
      const ok = isBmsBookingUrl(input);
      expect(performance.now() - start).toBeLessThan(50);
      expect(ok).toBe(false);
    }
  });
});
