import { normalizeShowtimeFormat } from '@sk-cinema/shared';
import type { Logger } from 'pino';

/** `reason` logged when a stored format cannot be normalised (the value is never logged). */
export const UNNORMALISABLE_FORMAT = 'unnormalisable_format';

/**
 * A stored format for an admin or public response: normalised (trimmed, uppercased) or `null`
 * when it cannot be (e.g. a manually inserted "2D/3D"). A `null` logs one warning with only the
 * showtime ID and the reason, never the stored value.
 */
export function formatForResponse(
  showtimeId: string,
  stored: string,
  logger: Pick<Logger, 'warn'>,
): string | null {
  const format = normalizeShowtimeFormat(stored);
  if (format === null) {
    logger.warn(
      { showtimeId, reason: UNNORMALISABLE_FORMAT },
      'Stored showtime format could not be normalised; returning no format',
    );
  }
  return format;
}
