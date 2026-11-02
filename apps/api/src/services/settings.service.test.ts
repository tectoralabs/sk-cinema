import { DEFAULT_BMS_BASE_URL } from '@sk-cinema/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Setting } from '../generated/prisma/client.js';
import { inMemoryAuthDb, testAdmin, testSetting } from '../test/helpers.js';
import { INVALID_STORED_SETTING, createSettingsService } from './settings.service.js';

const CUSTOM_BASE = 'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/cinema-snlk-SKCM-MT2';

const setup = (settings: Setting[] = []) => {
  const db = inMemoryAuthDb({ settings });
  const logger = { warn: vi.fn() };
  return { db, logger, service: createSettingsService({ db: db.prisma, logger }) };
};

/** Every logged argument, serialised, so a test can prove a stored value never appears. */
const loggedText = (logger: { warn: ReturnType<typeof vi.fn> }) =>
  JSON.stringify(logger.warn.mock.calls);

const expectOneWarning = (logger: { warn: ReturnType<typeof vi.fn> }, settingKey: string) => {
  expect(logger.warn).toHaveBeenCalledTimes(1);
  const args = logger.warn.mock.calls[0] ?? [];
  expect(args).toHaveLength(2);
  expect(args[0]).toEqual({ settingKey, reason: INVALID_STORED_SETTING });
  expect(Object.keys(args[0] as object).sort()).toEqual(['reason', 'settingKey']);
  expect(typeof args[1]).toBe('string');
};

describe('settings service: getBookingSettings', () => {
  it('returns the defaults, without a warning, when no rows exist', async () => {
    const { service, logger } = setup();
    await expect(service.getBookingSettings()).resolves.toEqual({
      bmsBaseUrl: DEFAULT_BMS_BASE_URL,
      showGapMinutes: 15,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns the stored values', async () => {
    const { service, logger } = setup([
      testSetting('bmsBaseUrl', CUSTOM_BASE),
      testSetting('showGapMinutes', '30'),
    ]);
    await expect(service.getBookingSettings()).resolves.toEqual({
      bmsBaseUrl: CUSTOM_BASE,
      showGapMinutes: 30,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('defaults a missing row on its own (a database seeded before showGapMinutes existed)', async () => {
    const { service, logger } = setup([testSetting('bmsBaseUrl', CUSTOM_BASE)]);
    await expect(service.getBookingSettings()).resolves.toEqual({
      bmsBaseUrl: CUSTOM_BASE,
      showGapMinutes: 15,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reads both settings with exactly one query per call, never cached', async () => {
    const { db, service } = setup([testSetting('showGapMinutes', '20')]);
    await service.getBookingSettings();
    expect(db.spies.setting.findMany).toHaveBeenCalledTimes(1);
    expect(db.spies.setting.findMany).toHaveBeenCalledWith({
      where: { key: { in: ['bmsBaseUrl', 'showGapMinutes'] } },
      select: { key: true, value: true },
    });
    expect(db.spies.setting.findUnique).not.toHaveBeenCalled();

    // A change made after the first read is seen by the next one.
    await db.prisma.setting.update({ where: { key: 'showGapMinutes' }, data: { value: '25' } });
    await expect(service.getBookingSettings()).resolves.toMatchObject({ showGapMinutes: 25 });
    expect(db.spies.setting.findMany).toHaveBeenCalledTimes(2);
  });

  it('ignores unrelated rows', async () => {
    const { service, logger } = setup([testSetting('somethingElse', 'http://evil.example')]);
    await expect(service.getBookingSettings()).resolves.toEqual({
      bmsBaseUrl: DEFAULT_BMS_BASE_URL,
      showGapMinutes: 15,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['another host', 'http://evil.example/x'],
    ['https on another host', 'https://evil.example/buytickets/x'],
    ['a trailing slash', `${DEFAULT_BMS_BASE_URL}/`],
    ['a query string', `${DEFAULT_BMS_BASE_URL}?evil=1`],
    ['padding (only valid after trimming)', ` ${CUSTOM_BASE} `],
    ['an empty value', ''],
    ['an over-long value', `${DEFAULT_BMS_BASE_URL}/${'e'.repeat(500)}`],
  ])('defaults and warns for a stored bmsBaseUrl with %s, never logging it', async (_c, stored) => {
    const { service, logger } = setup([
      testSetting('bmsBaseUrl', stored),
      testSetting('showGapMinutes', '30'),
    ]);
    await expect(service.getBookingSettings()).resolves.toEqual({
      bmsBaseUrl: DEFAULT_BMS_BASE_URL,
      showGapMinutes: 30,
    });
    expectOneWarning(logger, 'bmsBaseUrl');
    const logged = loggedText(logger);
    if (stored.trim().length > 0) expect(logged).not.toContain(stored.trim());
    expect(logged).not.toContain('evil');
    expect(logged).not.toContain('http');
    expect(logged).not.toContain('bookmyshow');
  });

  it.each(['abc', '121', '-1', '1.5', '', ' 15', '15 ', '+5', '1e1', '0015', '999'])(
    'defaults and warns for a stored showGapMinutes of %j, never logging it',
    async (stored) => {
      const { service, logger } = setup([
        testSetting('bmsBaseUrl', CUSTOM_BASE),
        testSetting('showGapMinutes', stored),
      ]);
      await expect(service.getBookingSettings()).resolves.toEqual({
        bmsBaseUrl: CUSTOM_BASE,
        showGapMinutes: 15,
      });
      expectOneWarning(logger, 'showGapMinutes');
      const args = logger.warn.mock.calls[0] ?? [];
      expect(Object.values(args[0] as object)).not.toContain(stored);
    },
  );

  it.each([
    ['0', 0],
    ['120', 120],
    ['15', 15],
    ['007', 7],
  ])('accepts a stored showGapMinutes of %j', async (stored, expected) => {
    const { service, logger } = setup([testSetting('showGapMinutes', stored)]);
    await expect(service.getBookingSettings()).resolves.toMatchObject({
      showGapMinutes: expected,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns once per invalid setting when both are invalid', async () => {
    const { service, logger } = setup([
      testSetting('bmsBaseUrl', 'javascript:alert(1)'),
      testSetting('showGapMinutes', 'abc'),
    ]);
    await expect(service.getBookingSettings()).resolves.toEqual({
      bmsBaseUrl: DEFAULT_BMS_BASE_URL,
      showGapMinutes: 15,
    });
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect((logger.warn.mock.calls as unknown[][]).map((call) => call[0])).toEqual([
      { settingKey: 'bmsBaseUrl', reason: INVALID_STORED_SETTING },
      { settingKey: 'showGapMinutes', reason: INVALID_STORED_SETTING },
    ]);
    expect(loggedText(logger)).not.toContain('javascript');
    expect(loggedText(logger)).not.toContain('abc');
  });

  it('lets a database error through without logging it as a fallback', async () => {
    const { db, service, logger } = setup();
    const failure = new Error('connection lost');
    db.spies.setting.findMany.mockRejectedValueOnce(failure);
    await expect(service.getBookingSettings()).rejects.toBe(failure);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('settings service: getAdminSettings and getLastChange', () => {
  const OLDER = new Date('2026-10-01T00:00:00.000Z');
  const NEWER = new Date('2026-10-02T00:00:00.000Z');
  const owner = testAdmin({ name: 'Owner' });
  const editor = testAdmin({ email: 'editor@skcinema.lk', name: 'Editor' });

  const setupRows = (settings: Setting[]) => {
    const db = inMemoryAuthDb({ admins: [owner, editor], settings });
    const logger = { warn: vi.fn() };
    return { db, logger, service: createSettingsService({ db: db.prisma, logger }) };
  };

  it('reports defaults and nulls when no rows exist', async () => {
    const { service, logger } = setupRows([]);
    await expect(service.getAdminSettings()).resolves.toEqual({
      bmsBaseUrl: DEFAULT_BMS_BASE_URL,
      showGapMinutes: 15,
      updatedAt: null,
      updatedBy: null,
    });
    await expect(service.getLastChange()).resolves.toEqual({ updatedAt: null, updatedBy: null });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reports a seeded row with updatedAt but updatedBy null', async () => {
    const { service } = setupRows([testSetting('bmsBaseUrl', CUSTOM_BASE, { updatedAt: OLDER })]);
    await expect(service.getAdminSettings()).resolves.toEqual({
      bmsBaseUrl: CUSTOM_BASE,
      showGapMinutes: 15,
      updatedAt: OLDER.toISOString(),
      updatedBy: null,
    });
  });

  it.each([
    ['bmsBaseUrl is newer', NEWER, OLDER, 'Owner'],
    ['showGapMinutes is newer', OLDER, NEWER, 'Editor'],
  ])('takes both fields from the newer row when %s', async (_c, baseAt, gapAt, name) => {
    const { service } = setupRows([
      testSetting('bmsBaseUrl', CUSTOM_BASE, { updatedAt: baseAt, updatedById: owner.id }),
      testSetting('showGapMinutes', '30', { updatedAt: gapAt, updatedById: editor.id }),
    ]);
    const lastChange = await service.getLastChange();
    expect(lastChange.updatedAt).toBe(NEWER.toISOString());
    expect(lastChange.updatedBy?.name).toBe(name);
    await expect(service.getAdminSettings()).resolves.toEqual({
      bmsBaseUrl: CUSTOM_BASE,
      showGapMinutes: 30,
      ...lastChange,
    });
  });

  it('a newer seeded row beats an older saved one: updatedBy is null, not the older admin', async () => {
    const { service } = setupRows([
      testSetting('bmsBaseUrl', CUSTOM_BASE, { updatedAt: OLDER, updatedById: owner.id }),
      testSetting('showGapMinutes', '30', { updatedAt: NEWER }),
    ]);
    await expect(service.getLastChange()).resolves.toEqual({
      updatedAt: NEWER.toISOString(),
      updatedBy: null,
    });
  });

  it('a tie goes to the first key, whatever order the rows were inserted in', async () => {
    const { service } = setupRows([
      testSetting('showGapMinutes', '30', { updatedAt: OLDER, updatedById: editor.id }),
      testSetting('bmsBaseUrl', CUSTOM_BASE, { updatedAt: OLDER, updatedById: owner.id }),
    ]);
    await expect(service.getLastChange()).resolves.toMatchObject({
      updatedBy: { id: owner.id, name: 'Owner' },
    });
  });

  it('exposes only the admin id and name, with exactly one query each', async () => {
    const { db, service } = setupRows([
      testSetting('showGapMinutes', '30', { updatedAt: OLDER, updatedById: owner.id }),
    ]);
    const settings = await service.getAdminSettings();
    expect(settings.updatedBy).toEqual({ id: owner.id, name: 'Owner' });
    expect(db.spies.setting.findMany).toHaveBeenCalledTimes(1);

    await service.getLastChange();
    expect(db.spies.setting.findMany).toHaveBeenCalledTimes(2);
  });

  it('an invalid stored value reads as the default with one warning; getLastChange never warns', async () => {
    const { service, logger } = setupRows([
      testSetting('showGapMinutes', 'abc', { updatedAt: OLDER, updatedById: owner.id }),
    ]);
    await expect(service.getLastChange()).resolves.toMatchObject({
      updatedAt: OLDER.toISOString(),
    });
    expect(logger.warn).not.toHaveBeenCalled();

    await expect(service.getAdminSettings()).resolves.toMatchObject({
      showGapMinutes: 15,
      updatedAt: OLDER.toISOString(),
      updatedBy: { id: owner.id, name: 'Owner' },
    });
    expectOneWarning(logger, 'showGapMinutes');
    expect(loggedText(logger)).not.toContain('abc');
  });
});

describe('settings service: single settings', () => {
  it('getBmsBaseUrl reads one row with one query', async () => {
    const { db, service, logger } = setup([testSetting('bmsBaseUrl', CUSTOM_BASE)]);
    await expect(service.getBmsBaseUrl()).resolves.toBe(CUSTOM_BASE);
    expect(db.spies.setting.findUnique).toHaveBeenCalledTimes(1);
    expect(db.spies.setting.findUnique).toHaveBeenCalledWith({
      where: { key: 'bmsBaseUrl' },
      select: { value: true },
    });
    expect(db.spies.setting.findMany).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('getShowGapMinutes reads one row with one query', async () => {
    const { db, service } = setup([testSetting('showGapMinutes', '45')]);
    await expect(service.getShowGapMinutes()).resolves.toBe(45);
    expect(db.spies.setting.findUnique).toHaveBeenCalledTimes(1);
    expect(db.spies.setting.findUnique).toHaveBeenCalledWith({
      where: { key: 'showGapMinutes' },
      select: { value: true },
    });
  });

  it('both default silently when their rows are missing', async () => {
    const { service, logger } = setup();
    await expect(service.getBmsBaseUrl()).resolves.toBe(DEFAULT_BMS_BASE_URL);
    await expect(service.getShowGapMinutes()).resolves.toBe(15);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('both default and warn with only the key and reason when their rows are invalid', async () => {
    const { service, logger } = setup([
      testSetting('bmsBaseUrl', 'http://evil.example/x'),
      testSetting('showGapMinutes', '121'),
    ]);
    await expect(service.getBmsBaseUrl()).resolves.toBe(DEFAULT_BMS_BASE_URL);
    expectOneWarning(logger, 'bmsBaseUrl');
    logger.warn.mockClear();

    await expect(service.getShowGapMinutes()).resolves.toBe(15);
    expectOneWarning(logger, 'showGapMinutes');
    expect(loggedText(logger)).not.toContain('121');
  });
});
