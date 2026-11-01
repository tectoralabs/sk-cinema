import {
  bmsBaseUrlSchema,
  DEFAULT_BMS_BASE_URL,
  DEFAULT_SHOW_GAP_MINUTES,
  storedShowGapMinutesSchema,
} from '@sk-cinema/shared';
import type { Logger } from 'pino';
import type { PrismaClient } from '../generated/prisma/client.js';
import { SETTING_KEYS, type SettingKey } from '../lib/settings.js';

/*
 * Site settings (Settings table). Values are stored as text and parsed on every read; a missing
 * row means "use the default" (e.g. a database seeded before the setting existed), and a stored
 * value that fails its schema also falls back to the default, with a warning.
 *
 * Not cached: reads are one small query, the public endpoints that build booking links cache
 * their own responses, and admin conflict checks must see the current show gap. So a settings
 * write needs no settings-cache invalidation, only the public caches whose output it changes.
 */

/** `reason` logged when a stored setting value fails its schema and the default is used. */
export const INVALID_STORED_SETTING = 'invalid_stored_value';

export interface BookingSettings {
  /** Passes bmsBaseUrlSchema exactly as returned (so also isBmsBookingUrl). */
  bmsBaseUrl: string;
  /** Whole minutes, SHOW_GAP_MINUTES_MIN..SHOW_GAP_MINUTES_MAX. */
  showGapMinutes: number;
}

export type SettingsDb = Pick<PrismaClient, 'setting'>;

export interface SettingsServiceDeps {
  db: SettingsDb;
  /** The app logger. Only ever given a setting key and a reason, never a stored value. */
  logger: Pick<Logger, 'warn'>;
}

type ParseResult<T> = { ok: true; value: T } | { ok: false };

interface StoredSetting<T> {
  defaultValue: T;
  parse: (stored: string) => ParseResult<T>;
}

const STORED_SETTINGS: { [K in SettingKey]: StoredSetting<BookingSettings[K]> } = {
  bmsBaseUrl: {
    defaultValue: DEFAULT_BMS_BASE_URL,
    // Must pass exactly as stored: the schema trims, and a value that only passes after
    // trimming was not saved through the API.
    parse: (stored) => {
      const result = bmsBaseUrlSchema.safeParse(stored);
      return result.success && result.data === stored ? { ok: true, value: stored } : { ok: false };
    },
  },
  showGapMinutes: {
    defaultValue: DEFAULT_SHOW_GAP_MINUTES,
    parse: (stored) => {
      const result = storedShowGapMinutesSchema.safeParse(stored);
      return result.success ? { ok: true, value: result.data } : { ok: false };
    },
  },
};

const BOOKING_SETTING_KEYS = [
  SETTING_KEYS.bmsBaseUrl,
  SETTING_KEYS.showGapMinutes,
] as const satisfies readonly SettingKey[];

export function createSettingsService({ db, logger }: SettingsServiceDeps) {
  function readValue<K extends SettingKey>(key: K, stored: string | undefined): BookingSettings[K] {
    const setting = STORED_SETTINGS[key] as StoredSetting<BookingSettings[K]>;
    if (stored === undefined) return setting.defaultValue;

    const result = setting.parse(stored);
    if (result.ok) return result.value;

    logger.warn(
      { settingKey: key, reason: INVALID_STORED_SETTING },
      'Ignoring invalid stored setting; using the default',
    );
    return setting.defaultValue;
  }

  /** One query for every booking setting; each falls back to its default on its own. */
  async function getBookingSettings(): Promise<BookingSettings> {
    const rows = await db.setting.findMany({
      where: { key: { in: [...BOOKING_SETTING_KEYS] } },
      select: { key: true, value: true },
    });
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    return {
      bmsBaseUrl: readValue(SETTING_KEYS.bmsBaseUrl, stored.get(SETTING_KEYS.bmsBaseUrl)),
      showGapMinutes: readValue(
        SETTING_KEYS.showGapMinutes,
        stored.get(SETTING_KEYS.showGapMinutes),
      ),
    };
  }

  async function readOne<K extends SettingKey>(key: K): Promise<BookingSettings[K]> {
    const row = await db.setting.findUnique({ where: { key }, select: { value: true } });
    return readValue(key, row?.value);
  }

  return {
    getBookingSettings,
    /** The `bmsBaseUrl` setting, or the default if missing or invalid. One query. */
    getBmsBaseUrl: (): Promise<string> => readOne(SETTING_KEYS.bmsBaseUrl),
    /** The `showGapMinutes` setting, or the default if missing or invalid. One query. */
    getShowGapMinutes: (): Promise<number> => readOne(SETTING_KEYS.showGapMinutes),
    // T14 adds the admin read (with updatedAt / updatedBy) and updateSettings here.
  };
}

export type SettingsService = ReturnType<typeof createSettingsService>;
