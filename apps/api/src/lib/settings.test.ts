import {
  bmsBaseUrlSchema,
  DEFAULT_BMS_BASE_URL,
  DEFAULT_SHOW_GAP_MINUTES,
  isBmsBookingUrl,
  settingsUpdateBodySchema,
  storedShowGapMinutesSchema,
} from '@sk-cinema/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTING_KEYS } from './settings.js';

// settings.ts keeps its own copy of the defaults (prisma/seed.ts runs under plain tsx, which
// resolves @sk-cinema/shared to its built dist rather than source), so guard against drift.
describe('SETTING_KEYS', () => {
  it('names exactly the settings PATCH /api/admin/settings accepts', () => {
    const bodyKeys = Object.keys(settingsUpdateBodySchema.shape).sort();
    expect(Object.values(SETTING_KEYS).sort()).toEqual(bodyKeys);
    for (const [name, key] of Object.entries(SETTING_KEYS)) expect(key).toBe(name);
  });

  it('has a default for every key and nothing else', () => {
    expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual(Object.values(SETTING_KEYS).sort());
  });
});

describe('DEFAULT_SETTINGS', () => {
  it('uses the shared default BookMyShow base URL', () => {
    expect(DEFAULT_SETTINGS[SETTING_KEYS.bmsBaseUrl]).toBe(DEFAULT_BMS_BASE_URL);
  });

  it('has a default base URL that passes the strict booking URL checks', () => {
    const base = DEFAULT_SETTINGS[SETTING_KEYS.bmsBaseUrl];
    expect(bmsBaseUrlSchema.parse(base)).toBe(base);
    expect(isBmsBookingUrl(base)).toBe(true);
    expect(isBmsBookingUrl(`${base}/20261101`)).toBe(true);
  });

  it('uses the shared default show gap, stored as text', () => {
    expect(DEFAULT_SETTINGS[SETTING_KEYS.showGapMinutes]).toBe(String(DEFAULT_SHOW_GAP_MINUTES));
  });

  it('has a default show gap that parses as a stored value', () => {
    const stored = DEFAULT_SETTINGS[SETTING_KEYS.showGapMinutes];
    expect(storedShowGapMinutesSchema.parse(stored)).toBe(DEFAULT_SHOW_GAP_MINUTES);
  });
});
