// Sri Lanka is UTC+05:30 all year (no daylight saving), so a fixed offset is exact.
export const COLOMBO_TIME_ZONE = 'Asia/Colombo';
const COLOMBO_OFFSET = '+05:30';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: COLOMBO_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// hourCycle h23: midnight is "00", never "24" (which `hour12: false` gives on some ICU builds).
const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: COLOMBO_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Calendar date (YYYY-MM-DD) of an instant in Colombo. */
export function toColomboDate(instant: Date): string {
  return dateFormatter.format(instant);
}

/** Wall-clock time (HH:mm, 24-hour, 00:00 to 23:59) of an instant in Colombo. Seconds dropped. */
export function toColomboTime(instant: Date): string {
  const parts = timeFormatter.formatToParts(instant);
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '';
  const time = `${hour}:${minute}`;
  if (!TIME_RE.test(time)) throw new RangeError('Invalid instant');
  return time;
}

/** UTC instant for a Colombo wall-clock date (YYYY-MM-DD) and time (HH:mm). */
export function fromColomboDateTime(date: string, time: string): Date {
  if (!DATE_RE.test(date)) throw new RangeError(`Invalid date: ${date}`);
  if (!TIME_RE.test(time)) throw new RangeError(`Invalid time: ${time}`);

  const instant = new Date(`${date}T${time}:00${COLOMBO_OFFSET}`);
  if (Number.isNaN(instant.getTime()) || toColomboDate(instant) !== date) {
    throw new RangeError(`Invalid date: ${date}`);
  }
  return instant;
}

/** Adds whole days to a calendar date (YYYY-MM-DD). */
export function addDays(date: string, days: number): string {
  if (!DATE_RE.test(date)) throw new RangeError(`Invalid date: ${date}`);
  const utc = new Date(`${date}T00:00:00Z`);
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}
