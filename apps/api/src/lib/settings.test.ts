import { bmsBaseUrlSchema, DEFAULT_BMS_BASE_URL, isBmsBookingUrl } from '@sk-cinema/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTING_KEYS } from './settings.js';

// settings.ts keeps its own copy of the default (prisma/seed.ts runs under plain tsx, which
// resolves @sk-cinema/shared to its built dist rather than source), so guard against drift.
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
});
