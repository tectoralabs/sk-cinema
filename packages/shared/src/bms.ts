import { z } from 'zod';

/*
 * BookMyShow booking links.
 *
 * BookMyShow only supports deep links to "cinema + date": `{bmsBaseUrl}/{YYYYMMDD}`. The base
 * URL (Settings, SUPER_ADMIN) and the optional per-showtime `bookingUrlOverride` are typed in by
 * admins, and the site redirects visitors to them, so every one must be a link to
 * https://lk.bookmyshow.com under /buytickets/ and nothing else.
 *
 * The checks are plain string checks against an exact, case-sensitive prefix, followed by a
 * character allowlist and a segment check. Each is linear (no backtracking regex) and the
 * length is checked first, so request input cannot make them slow. `new URL()` is only used as
 * a final cross-check that the WHATWG parser sees the same string (`href` unchanged) and the
 * same origin; it never decides acceptance on its own because it normalises input (lowercases
 * the scheme and host, drops `:443`, resolves `/./` and `/../`, strips tabs and newlines).
 */

/** The only origin booking links may point to. */
export const BMS_ORIGIN = 'https://lk.bookmyshow.com';

/** Every booking link starts with exactly this (case-sensitive). */
export const BMS_BOOKING_URL_PREFIX = `${BMS_ORIGIN}/buytickets/`;

/** Default `bmsBaseUrl` setting: SK Cinema Matara's cinema page on BookMyShow LK. */
export const DEFAULT_BMS_BASE_URL = `${BMS_BOOKING_URL_PREFIX}sk-cinema-matara/cinema-snlk-SKCM-MT`;

/** Maximum length of an admin-entered base URL or override. */
export const BMS_URL_MAX_LENGTH = 500;

/**
 * Maximum length isBmsBookingUrl accepts: an admin-entered URL plus the `/YYYYMMDD` the link
 * builder appends to the base URL.
 */
export const BMS_LINK_MAX_LENGTH = BMS_URL_MAX_LENGTH + '/YYYYMMDD'.length;

/**
 * Characters allowed in the path after `/buytickets/`: RFC 3986 unreserved characters plus `/`.
 * No `%` (so no encoded slashes or dots), `\`, `@`, `:`, `?`, `#`, whitespace, control or
 * non-ASCII characters. A single character class with one quantifier: linear time.
 */
const PATH_CHARS = /^[A-Za-z0-9._~/-]+$/;

const MESSAGES = {
  empty: 'Enter a BookMyShow link',
  tooLong: `Must be at most ${BMS_URL_MAX_LENGTH} characters`,
  prefix: `Must start with ${BMS_BOOKING_URL_PREFIX}`,
  noPath: `Add the cinema path after ${BMS_BOOKING_URL_PREFIX}`,
  characters:
    'Use only letters, digits, "-", "_", ".", "~" and "/" after /buytickets/ (no spaces, "%", query string or "#")',
  trailingSlash: 'Remove the "/" at the end of the link',
  segments: 'The link must not contain "//", "/./" or "/../"',
  parse: 'Must be a plain BookMyShow booking link',
} as const;

/**
 * Why `value` is not an acceptable booking link, or `null` if it is. Never echoes the value.
 * `maxLength` lets built links (base + `/YYYYMMDD`) be slightly longer than admin input.
 */
function bmsUrlProblem(value: string, maxLength: number): string | null {
  if (value.length === 0) return MESSAGES.empty;
  if (value.length > maxLength) return MESSAGES.tooLong;
  if (!value.startsWith(BMS_BOOKING_URL_PREFIX)) return MESSAGES.prefix;

  const path = value.slice(BMS_BOOKING_URL_PREFIX.length);
  if (path.length === 0) return MESSAGES.noPath;
  if (!PATH_CHARS.test(path)) return MESSAGES.characters;
  if (path.endsWith('/')) return MESSAGES.trailingSlash;
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return MESSAGES.segments;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return MESSAGES.parse;
  }
  if (url.href !== value || url.origin !== BMS_ORIGIN) return MESSAGES.parse;

  return null;
}

/**
 * True if `value` is, exactly as given (no trimming), a BookMyShow LK booking link:
 * - starts with `https://lk.bookmyshow.com/buytickets/` (case-sensitive, so no other scheme,
 *   host, port or userinfo, and no uppercase variants);
 * - the rest is one or more non-empty path segments of `[A-Za-z0-9._~-]`, none `.` or `..`,
 *   with no trailing `/`, query string or fragment;
 * - at most BMS_LINK_MAX_LENGTH characters (admin input plus `/YYYYMMDD`).
 *
 * Use it on every link before redirecting to it, including links built from the base URL.
 */
export function isBmsBookingUrl(value: string): boolean {
  return typeof value === 'string' && bmsUrlProblem(value, BMS_LINK_MAX_LENGTH) === null;
}

/** Admin-entered booking URL: trimmed, length-checked first, then the isBmsBookingUrl rules. */
function bmsUrlSchema() {
  return (
    z
      .string()
      .trim()
      // abort: an empty value gets one clear message, not the prefix message as well.
      .min(1, { abort: true, message: MESSAGES.empty })
      // abort: the checks below never run on over-long input.
      .max(BMS_URL_MAX_LENGTH, { abort: true, message: MESSAGES.tooLong })
      .superRefine((value, ctx) => {
        const problem = bmsUrlProblem(value, BMS_URL_MAX_LENGTH);
        if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
      })
  );
}

/**
 * The `bmsBaseUrl` setting, e.g. DEFAULT_BMS_BASE_URL. The link builder appends `/YYYYMMDD`,
 * so a trailing `/` is rejected (it would produce `//`).
 */
export const bmsBaseUrlSchema = bmsUrlSchema();

/**
 * A showtime's `bookingUrlOverride`, used as-is instead of the generated link. Same rules as
 * the base URL: a trailing `/`, query string and fragment are rejected.
 */
export const bookingUrlOverrideSchema = bmsUrlSchema();
