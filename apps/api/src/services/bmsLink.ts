import { isBmsBookingUrl } from '@sk-cinema/shared';
import type { Logger } from 'pino';
import { toColomboDate } from '../lib/colomboTime.js';

/*
 * BookMyShow booking links. BookMyShow only deep-links to "cinema + date", so a showtime's link
 * is `{bmsBaseUrl}/{YYYYMMDD}` with the show's calendar date in Asia/Colombo, unless the
 * showtime has its own `bookingUrlOverride`. Every URL returned from here has passed
 * isBmsBookingUrl, so it can only point at https://lk.bookmyshow.com/buytickets/...
 *
 * Pure: no database, no clock, no server time zone. Nothing here ever logs or throws a URL.
 */

/** `reason` logged when a showtime's stored bookingUrlOverride fails validation. */
export const INVALID_BOOKING_URL_OVERRIDE = 'invalid_booking_url_override';

/** The show's calendar date in Asia/Colombo as `YYYYMMDD` (e.g. 2026-11-01T19:00Z -> 20261102). */
export function formatBmsDate(startsAt: Date): string {
  if (Number.isNaN(startsAt.getTime())) throw new RangeError('Invalid showtime start');
  return toColomboDate(startsAt).replaceAll('-', '');
}

/**
 * `{baseUrl}/{YYYYMMDD}`, re-validated with isBmsBookingUrl. Throws (a plain Error, so the
 * client sees a generic 500) rather than return a link that fails validation. The message never
 * contains the URL. Callers pass a base URL read through the settings service, which already
 * falls back to the default when the stored one is invalid, so a throw here is a bug.
 */
export function buildBmsLink(baseUrl: string, startsAt: Date): string {
  const link = `${baseUrl}/${formatBmsDate(startsAt)}`;
  if (!isBmsBookingUrl(link)) {
    throw new Error('Generated BookMyShow link failed validation');
  }
  return link;
}

export interface BookingUrlInput {
  /** Only for the warning when the override is invalid. */
  showtimeId: string;
  bookingUrlOverride: string | null | undefined;
  /** The `bmsBaseUrl` setting, from the settings service. */
  baseUrl: string;
  startsAt: Date;
}

/**
 * The booking link for a showtime: its bookingUrlOverride when that passes isBmsBookingUrl
 * exactly as stored (returned unchanged), otherwise the generated link. An override that is
 * set but invalid (e.g. edited directly in the database) falls back to the generated link and
 * logs one warning with only `{ showtimeId, reason }`: never the override or any part of it.
 */
export function resolveBookingUrl(
  { showtimeId, bookingUrlOverride, baseUrl, startsAt }: BookingUrlInput,
  logger: Pick<Logger, 'warn'>,
): string {
  if (bookingUrlOverride === null || bookingUrlOverride === undefined) {
    return buildBmsLink(baseUrl, startsAt);
  }
  if (isBmsBookingUrl(bookingUrlOverride)) return bookingUrlOverride;

  logger.warn(
    { showtimeId, reason: INVALID_BOOKING_URL_OVERRIDE },
    'Ignoring invalid booking URL override; using the generated BookMyShow link',
  );
  return buildBmsLink(baseUrl, startsAt);
}
