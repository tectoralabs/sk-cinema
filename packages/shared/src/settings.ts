import { z } from 'zod';
import { bmsBaseUrlSchema, DEFAULT_BMS_BASE_URL, isBmsBookingUrl } from './bms.js';

/*
 * Site settings (Settings table, SUPER_ADMIN only). Values are stored as strings, so reading
 * them back goes through the `parseStored*` helpers below, which fall back to the default when
 * a stored value is missing or invalid instead of failing the request.
 */

/* -------------------------------------------------------------------------- */
/* Building blocks                                                            */
/* -------------------------------------------------------------------------- */

/** Default minimum gap, in minutes, between the end of one show and the next on a screen. */
export const DEFAULT_SHOW_GAP_MINUTES = 15;
export const SHOW_GAP_MINUTES_MIN = 0;
export const SHOW_GAP_MINUTES_MAX = 120;

/** Show gap in minutes: a whole number from 0 to 120. Must be a JSON number, not a string. */
export const showGapMinutesSchema = z
  .number()
  .int()
  .min(SHOW_GAP_MINUTES_MIN)
  .max(SHOW_GAP_MINUTES_MAX);

/* -------------------------------------------------------------------------- */
/* Request bodies                                                             */
/* -------------------------------------------------------------------------- */

/** Body of PATCH /api/admin/settings (SUPER_ADMIN). Any subset of the settings, at least one. */
export const settingsUpdateBodySchema = z
  .strictObject({
    bmsBaseUrl: bmsBaseUrlSchema.optional(),
    showGapMinutes: showGapMinutesSchema.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one setting to update',
  });

export type SettingsUpdateBody = z.infer<typeof settingsUpdateBodySchema>;
export type SettingsUpdateBodyInput = z.input<typeof settingsUpdateBodySchema>;

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Settings as returned by GET/PATCH /api/admin/settings. No secrets live in Settings.
 * `updatedAt` / `updatedBy` describe the most recent change to any setting, or are `null`
 * while every setting still has its default.
 */
export const adminSettingsSchema = z.strictObject({
  bmsBaseUrl: z.string().refine(isBmsBookingUrl, { message: 'Must be a BookMyShow booking link' }),
  showGapMinutes: showGapMinutesSchema,
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z
    .strictObject({
      id: z.uuid(),
      name: z.string(),
    })
    .nullable(),
});

export type AdminSettings = z.infer<typeof adminSettingsSchema>;

/** Response of GET and PATCH /api/admin/settings. */
export const adminSettingsResponseSchema = z.strictObject({
  settings: adminSettingsSchema,
});

export type AdminSettingsResponse = z.infer<typeof adminSettingsResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Stored values                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The stored `showGapMinutes` value: a string of 1–3 digits for a whole number 0–120
 * (e.g. "15"). No signs, decimals, spaces or exponents. Fails on anything else; use
 * parseStoredShowGapMinutes to fall back to the default instead.
 */
export const storedShowGapMinutesSchema = z
  .string()
  // abort: the pattern below never runs on over-long input.
  .max(3, { abort: true })
  .regex(/^\d{1,3}$/, 'Must be a whole number')
  .transform(Number)
  .pipe(showGapMinutesSchema);

/** The stored show gap as a number, or DEFAULT_SHOW_GAP_MINUTES if missing or invalid. */
export function parseStoredShowGapMinutes(value: string | null | undefined): number {
  const result = storedShowGapMinutesSchema.safeParse(value);
  return result.success ? result.data : DEFAULT_SHOW_GAP_MINUTES;
}

/**
 * The stored `bmsBaseUrl` value, or DEFAULT_BMS_BASE_URL if missing or invalid. The stored
 * value must pass bmsBaseUrlSchema exactly as stored (it was trimmed when saved), so a value
 * that would only pass after trimming also falls back to the default.
 */
export function parseStoredBmsBaseUrl(value: string | null | undefined): string {
  const result = bmsBaseUrlSchema.safeParse(value);
  return result.success && result.data === value ? value : DEFAULT_BMS_BASE_URL;
}
