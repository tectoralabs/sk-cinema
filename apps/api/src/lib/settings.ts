/*
 * Setting keys and the defaults prisma/seed.ts creates (it never overwrites an existing row).
 * Plain literals, no runtime import of @sk-cinema/shared: the seed runs under plain tsx, which
 * resolves the shared package to its built dist rather than source. settings.test.ts guards
 * these copies against drift from the shared defaults and schemas.
 */
export const SETTING_KEYS = {
  bmsBaseUrl: 'bmsBaseUrl',
  showGapMinutes: 'showGapMinutes',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

export const DEFAULT_SETTINGS = {
  [SETTING_KEYS.bmsBaseUrl]:
    'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/cinema-snlk-SKCM-MT',
  [SETTING_KEYS.showGapMinutes]: '15',
} as const satisfies Record<SettingKey, string>;
