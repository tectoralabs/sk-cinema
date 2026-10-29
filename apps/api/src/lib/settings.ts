export const SETTING_KEYS = {
  bmsBaseUrl: 'bmsBaseUrl',
} as const;

export const DEFAULT_SETTINGS = {
  [SETTING_KEYS.bmsBaseUrl]:
    'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/cinema-snlk-SKCM-MT',
} as const;
