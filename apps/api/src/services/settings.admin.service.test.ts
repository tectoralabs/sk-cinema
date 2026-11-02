import { DEFAULT_BMS_BASE_URL } from '@sk-cinema/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Movie, Screen, Setting, Showtime } from '../generated/prisma/client.js';
import { MemoryCache } from '../lib/cache.js';
import {
  inMemoryAuthDb,
  testAdmin,
  testMovie,
  testScreen,
  testSetting,
  testShowtime,
} from '../test/helpers.js';
import { PUBLIC_MOVIES_CACHE_PREFIX } from './movie.public.service.js';
import {
  countFutureShowtimesBelowGap,
  createSettingsAdminService,
  settingChanges,
} from './settings.admin.service.js';
import { INVALID_STORED_SETTING } from './settings.service.js';

const NEW_BASE = 'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/cinema-snlk-SKCM-NEW';

/** The injected clock: 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');
const DELETED_AT = new Date('2026-10-01T00:00:00.000Z');

const colombo = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);
const DAY = '2026-11-02';

/** Every show runs 120 minutes, so with a 15 minute gap the next may start 135 minutes later. */
const movie: Movie = testMovie({ slug: 'main', title: 'Main', durationMinutes: 120 });
const screen: Screen = testScreen({ name: 'Screen 1' });

type Seed = Partial<Showtime> & Pick<Showtime, 'startsAt'>;

const showOf = (seed: Seed) => testShowtime({ movieId: movie.id, screenId: screen.id, ...seed });

function dbWith(seeds: Seed[], extra: { movies?: Movie[]; screens?: Screen[] } = {}) {
  return inMemoryAuthDb({
    movies: [movie, ...(extra.movies ?? [])],
    screens: [screen, ...(extra.screens ?? [])],
    showtimes: seeds.map(showOf),
  });
}

const count = (seeds: Seed[], gap = 15) =>
  countFutureShowtimesBelowGap(dbWith(seeds).prisma, gap, NOW);

describe('countFutureShowtimesBelowGap', () => {
  it('is 0 with no shows, with one query', async () => {
    const db = dbWith([]);
    await expect(countFutureShowtimesBelowGap(db.prisma, 15, NOW)).resolves.toBe(0);
    expect(db.spies.showtime.findMany).toHaveBeenCalledTimes(1);
  });

  it('is 0 when a show starts exactly at the end of the previous one plus the gap', async () => {
    await expect(
      count([{ startsAt: colombo(DAY, '10:00') }, { startsAt: colombo(DAY, '12:15') }]),
    ).resolves.toBe(0);
  });

  it('is 1 when it starts one minute too soon', async () => {
    await expect(
      count([{ startsAt: colombo(DAY, '10:00') }, { startsAt: colombo(DAY, '12:14') }]),
    ).resolves.toBe(1);
  });

  it('counts the later show of each pair once: three in a row too close is 2', async () => {
    await expect(
      count([
        { startsAt: colombo(DAY, '10:00') },
        { startsAt: colombo(DAY, '12:10') },
        { startsAt: colombo(DAY, '14:20') },
      ]),
    ).resolves.toBe(2);
  });

  it('counts a show once however many earlier shows it clashes with', async () => {
    // All three overlap: the second clashes with one, the third with two.
    await expect(
      count([
        { startsAt: colombo(DAY, '10:00') },
        { startsAt: colombo(DAY, '10:30') },
        { startsAt: colombo(DAY, '11:00') },
      ]),
    ).resolves.toBe(2);
  });

  it('two shows at the same instant count once', async () => {
    await expect(
      count([{ startsAt: colombo(DAY, '10:00') }, { startsAt: colombo(DAY, '10:00') }]),
    ).resolves.toBe(1);
  });

  it('ignores two finished shows that clash with each other', async () => {
    await expect(
      count([
        { startsAt: new Date('2026-10-30T10:00:00.000Z') },
        { startsAt: new Date('2026-10-30T10:30:00.000Z') },
      ]),
    ).resolves.toBe(0);
  });

  it('a running show counts as a neighbour; a running show itself is not counted', async () => {
    // Started an hour ago, ends in an hour, then the gap: free from 11:15 UTC.
    const running = { startsAt: new Date('2026-11-01T09:00:00.000Z') };
    await expect(
      count([running, { startsAt: new Date('2026-11-01T11:14:00.000Z') }]),
    ).resolves.toBe(1);
    await expect(
      count([running, { startsAt: new Date('2026-11-01T11:15:00.000Z') }]),
    ).resolves.toBe(0);
  });

  it('a show starting exactly now is a neighbour, not a future show', async () => {
    await expect(
      count([{ startsAt: NOW }, { startsAt: new Date(NOW.getTime() + 60_000) }]),
    ).resolves.toBe(1);
    await expect(count([{ startsAt: NOW }])).resolves.toBe(0);
  });

  it('a show that finished its run plus the gap before the next is no neighbour', async () => {
    await expect(
      count([
        { startsAt: new Date('2026-11-01T07:45:00.000Z') }, // free from exactly 10:00 UTC
        { startsAt: new Date('2026-11-01T10:00:00.001Z') },
      ]),
    ).resolves.toBe(0);
  });

  it('ignores soft-deleted shows, as candidates and as neighbours', async () => {
    await expect(
      count([
        { startsAt: colombo(DAY, '10:00') },
        { startsAt: colombo(DAY, '10:30'), deletedAt: DELETED_AT },
      ]),
    ).resolves.toBe(0);
    await expect(
      count([
        { startsAt: new Date('2026-11-01T09:00:00.000Z'), deletedAt: DELETED_AT },
        { startsAt: new Date('2026-11-01T10:30:00.000Z') },
      ]),
    ).resolves.toBe(0);
  });

  it('ignores shows on different screens', async () => {
    const other = testScreen({ name: 'Screen 2' });
    const db = dbWith(
      [
        { startsAt: colombo(DAY, '10:00') },
        { startsAt: colombo(DAY, '10:30'), screenId: other.id },
      ],
      { screens: [other] },
    );
    await expect(countFutureShowtimesBelowGap(db.prisma, 15, NOW)).resolves.toBe(0);
  });

  it('counts shows of hidden or deleted movies and screens: they still occupy the screen', async () => {
    const hiddenMovie = testMovie({ slug: 'hidden', isActive: false, durationMinutes: 120 });
    const deletedMovie = testMovie({ slug: 'gone', deletedAt: DELETED_AT, durationMinutes: 120 });
    const hiddenScreen = testScreen({ name: 'Hidden', isActive: false });
    const deletedScreen = testScreen({ name: 'Deleted', deletedAt: DELETED_AT });
    const db = dbWith(
      [
        { startsAt: colombo(DAY, '10:00') },
        { startsAt: colombo(DAY, '10:30'), movieId: hiddenMovie.id },
        { startsAt: colombo('2026-11-03', '10:00') },
        { startsAt: colombo('2026-11-03', '10:30'), movieId: deletedMovie.id },
        { startsAt: colombo(DAY, '10:00'), screenId: hiddenScreen.id },
        { startsAt: colombo(DAY, '10:30'), screenId: hiddenScreen.id },
        { startsAt: colombo(DAY, '10:00'), screenId: deletedScreen.id },
        { startsAt: colombo(DAY, '10:30'), screenId: deletedScreen.id },
      ],
      { movies: [hiddenMovie, deletedMovie], screens: [hiddenScreen, deletedScreen] },
    );
    await expect(countFutureShowtimesBelowGap(db.prisma, 15, NOW)).resolves.toBe(4);
  });

  it('uses each movie its own running time', async () => {
    const short = testMovie({ slug: 'short', durationMinutes: 30 });
    const db = dbWith(
      [{ startsAt: colombo(DAY, '10:00'), movieId: short.id }, { startsAt: colombo(DAY, '10:45') }],
      { movies: [short] },
    );
    await expect(countFutureShowtimesBelowGap(db.prisma, 15, NOW)).resolves.toBe(0);
    await expect(countFutureShowtimesBelowGap(db.prisma, 16, NOW)).resolves.toBe(1);
  });

  it('a gap of 0 still counts real overlaps, and allows touching', async () => {
    await expect(
      count([{ startsAt: colombo(DAY, '10:00') }, { startsAt: colombo(DAY, '12:00') }], 0),
    ).resolves.toBe(0);
    await expect(
      count([{ startsAt: colombo(DAY, '10:00') }, { startsAt: colombo(DAY, '11:59') }], 0),
    ).resolves.toBe(1);
  });

  it('with future shows it runs exactly two read-only queries, the second bounded by the window', async () => {
    const db = dbWith([{ startsAt: colombo(DAY, '10:00') }]);
    await countFutureShowtimesBelowGap(db.prisma, 15, NOW);

    expect(db.spies.showtime.findMany).toHaveBeenCalledTimes(2);
    const calls = db.spies.showtime.findMany.mock.calls as unknown as [{ where: object }][];
    expect(calls[0]?.[0].where).toEqual({ deletedAt: null, startsAt: { gt: NOW } });
    expect(calls[1]?.[0].where).toMatchObject({
      deletedAt: null,
      startsAt: { gte: expect.any(Date) as Date, lte: NOW },
    });
    expect(db.spies.showtime.update).not.toHaveBeenCalled();
    expect(db.spies.showtime.updateMany).not.toHaveBeenCalled();
  });
});

describe('settingChanges', () => {
  const current = { bmsBaseUrl: DEFAULT_BMS_BASE_URL, showGapMinutes: 15 };

  it('lists only the keys that differ, in a fixed order', () => {
    expect(settingChanges(current, { showGapMinutes: 20, bmsBaseUrl: NEW_BASE })).toEqual([
      { key: 'bmsBaseUrl', from: DEFAULT_BMS_BASE_URL, to: NEW_BASE },
      { key: 'showGapMinutes', from: 15, to: 20 },
    ]);
    expect(
      settingChanges(current, { bmsBaseUrl: DEFAULT_BMS_BASE_URL, showGapMinutes: 20 }),
    ).toEqual([{ key: 'showGapMinutes', from: 15, to: 20 }]);
  });

  it('is empty for a no-op, and treats a gap of 0 as a value', () => {
    expect(settingChanges(current, { showGapMinutes: 15 })).toEqual([]);
    expect(settingChanges({ ...current, showGapMinutes: 0 }, { showGapMinutes: 0 })).toEqual([]);
    expect(settingChanges(current, { showGapMinutes: 0 })).toEqual([
      { key: 'showGapMinutes', from: 15, to: 0 },
    ]);
  });
});

describe('settings admin service', () => {
  const owner = testAdmin({ name: 'Owner', role: 'SUPER_ADMIN' });
  const actor = { adminId: owner.id, ipAddress: '203.0.113.7', userAgent: 'service test' };

  function setup(settings: Setting[] = [], seeds: Seed[] = []) {
    const db = inMemoryAuthDb({
      admins: [owner],
      movies: [movie],
      screens: [screen],
      showtimes: seeds.map(showOf),
      settings,
    });
    const logger = { warn: vi.fn() };
    const cache = new MemoryCache();
    const invalidate = vi.spyOn(cache, 'invalidatePrefix');
    const service = createSettingsAdminService({
      db: db.prisma,
      cache,
      logger,
      now: () => NOW,
    });
    return { db, logger, invalidate, service };
  }

  it('get: uses the injected clock for the future boundary', async () => {
    // At NOW the first show is running and the second is too close to it; a clock set later
    // would see both as started.
    const { service } = setup(
      [],
      [
        { startsAt: new Date('2026-11-01T09:00:00.000Z') },
        { startsAt: new Date('2026-11-01T10:30:00.000Z') },
      ],
    );
    await expect(service.get()).resolves.toMatchObject({ futureShowtimesBelowGap: 1 });
  });

  it('get: counts under the stored gap, and the count follows it', async () => {
    const { service } = setup(
      [testSetting('showGapMinutes', '30')],
      [{ startsAt: colombo(DAY, '10:00') }, { startsAt: colombo(DAY, '12:20') }],
    );
    await expect(service.get()).resolves.toMatchObject({
      settings: { showGapMinutes: 30 },
      futureShowtimesBelowGap: 1,
    });
  });

  it('get: runs no write at all', async () => {
    const { db, invalidate, service } = setup();
    await service.get();
    expect(db.spies.$transaction).not.toHaveBeenCalled();
    expect(db.spies.setting.upsert).not.toHaveBeenCalled();
    expect(db.auditLogs).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('update: audits one row per changed key with the typed values and the request info', async () => {
    const { db, invalidate, service } = setup();

    await service.update({ bmsBaseUrl: NEW_BASE, showGapMinutes: 30 }, actor);

    expect(db.auditLogs.map(({ id: _id, createdAt: _at, ...row }) => row)).toEqual([
      {
        action: 'UPDATE',
        adminId: owner.id,
        entity: 'Setting',
        entityId: 'bmsBaseUrl',
        details: { from: DEFAULT_BMS_BASE_URL, to: NEW_BASE },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      },
      {
        action: 'UPDATE',
        adminId: owner.id,
        entity: 'Setting',
        entityId: 'showGapMinutes',
        details: { from: 15, to: 30 },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      },
    ]);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(PUBLIC_MOVIES_CACHE_PREFIX);
    const auditOrder = db.spies.auditLog.createMany.mock.invocationCallOrder.at(-1) ?? Infinity;
    expect(invalidate.mock.invocationCallOrder[0]).toBeGreaterThan(auditOrder);
  });

  it('update: invalid stored raw values never reach the audit row, the log or the response', async () => {
    const RAW_GAP = 'not-a-gap';
    const RAW_BASE = 'https://evil.example/stored';
    const { db, logger, service } = setup([
      testSetting('showGapMinutes', RAW_GAP),
      testSetting('bmsBaseUrl', RAW_BASE),
    ]);

    const response = await service.update({ showGapMinutes: 30, bmsBaseUrl: NEW_BASE }, actor);

    expect(db.auditLogs.map((row) => row.details)).toEqual([
      { from: DEFAULT_BMS_BASE_URL, to: NEW_BASE },
      { from: 15, to: 30 },
    ]);
    const everything = JSON.stringify([db.auditLogs, logger.warn.mock.calls, response]);
    expect(everything).not.toContain(RAW_GAP);
    expect(everything).not.toContain(RAW_BASE);
    expect(response.settings).toMatchObject({ bmsBaseUrl: NEW_BASE, showGapMinutes: 30 });
    expect(db.settings.map((row) => row.value).sort()).toEqual(['30', NEW_BASE].sort());
  });

  it('update: an untouched invalid setting reads as the default with one warning', async () => {
    const { logger, service } = setup([testSetting('bmsBaseUrl', 'http://evil.example/x')]);

    const { settings } = await service.update({ showGapMinutes: 30 }, actor);

    expect(settings.bmsBaseUrl).toBe(DEFAULT_BMS_BASE_URL);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      { settingKey: 'bmsBaseUrl', reason: INVALID_STORED_SETTING },
      expect.any(String),
    );
  });

  it.each([
    ['an invalid row whose default is sent', 'showGapMinutes', 'abc', { showGapMinutes: 15 }],
    ['a missing row whose default is sent', 'other', 'x', { showGapMinutes: 15 }],
    ['the same stored value', 'showGapMinutes', '20', { showGapMinutes: 20 }],
    ['a stored "007" and the number 7', 'showGapMinutes', '007', { showGapMinutes: 7 }],
  ])('update: no write and no audit for %s', async (_c, key, value, body) => {
    const row = testSetting(key, value);
    const { db, invalidate, service } = setup([row]);

    await service.update(body, actor);

    expect(db.settings).toEqual([row]);
    expect(db.spies.setting.upsert).not.toHaveBeenCalled();
    expect(db.auditLogs).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('update: a no-op still reports the count and the last change', async () => {
    const at = new Date('2026-10-01T00:00:00.000Z');
    const { service } = setup(
      [testSetting('showGapMinutes', '30', { updatedAt: at, updatedById: owner.id })],
      [{ startsAt: colombo(DAY, '10:00') }, { startsAt: colombo(DAY, '12:20') }],
    );

    await expect(service.update({ showGapMinutes: 30 }, actor)).resolves.toEqual({
      settings: {
        bmsBaseUrl: DEFAULT_BMS_BASE_URL,
        showGapMinutes: 30,
        updatedAt: at.toISOString(),
        updatedBy: { id: owner.id, name: 'Owner' },
      },
      futureShowtimesBelowGap: 1,
    });
  });

  it('update: lets a read failure through with nothing written or invalidated', async () => {
    const { db, invalidate, service } = setup();
    const failure = new Error('connection lost');
    db.injectFault('setting', 'findMany', { error: failure });

    await expect(service.update({ showGapMinutes: 30 }, actor)).rejects.toBe(failure);

    expect(db.settings).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
