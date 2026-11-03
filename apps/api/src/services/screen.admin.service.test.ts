import { randomUUID } from 'node:crypto';
import {
  adminScreenListQuerySchema,
  adminScreenSchema,
  screenCreateBodySchema,
  screenUpdateBodySchema,
  type ScreenCreateBodyInput,
  type ScreenUpdateBodyInput,
} from '@sk-cinema/shared';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { Prisma, type Screen, type Showtime } from '../generated/prisma/client.js';
import { MemoryCache } from '../lib/cache.js';
import { AppError } from '../lib/errors.js';
import {
  inMemoryAuthDb,
  recordNotFoundError,
  testAdmin,
  testMovie,
  testScreen,
  testShowtime,
  uniqueConstraintError,
} from '../test/helpers.js';
import { readModelUniqueness, readSchemaPrisma } from '../test/prismaSchema.js';
import { PUBLIC_MOVIES_CACHE_PREFIX } from './movie.public.service.js';
import {
  ADMIN_SCREEN_LIST_ORDER_BY,
  adminScreenListWhere,
  createScreenAdminService,
  isScreenNameClash,
  SCREEN_ALREADY_DELETED_MESSAGE,
  SCREEN_CHANGED_MESSAGE,
  SCREEN_DEACTIVATE_HAS_SHOWTIMES_MESSAGE,
  SCREEN_DELETE_HAS_SHOWTIMES_MESSAGE,
  SCREEN_NAME_DELETED_MESSAGE,
  SCREEN_NAME_IN_USE_MESSAGE,
  SCREEN_NOT_DELETED_MESSAGE,
  SCREEN_NOT_FOUND_MESSAGE,
  SCREEN_RESTORE_FIRST_MESSAGE,
  SCREEN_RESTORE_NAME_IN_USE_MESSAGE,
  screenDetailChanges,
  screenNameMatchWhere,
  toAdminScreen,
} from './screen.admin.service.js';

const DETECTION_FILE = 'apps/api/src/services/screen.admin.service.ts';
const UPDATE_DETECTION =
  `Screen's unique fields changed: the name-clash detection in ${DETECTION_FILE} ` +
  '(isScreenNameClash, which treats every P2002 on Screen as a name clash) must be updated';

/** The injected clock: 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');
const FUTURE = new Date('2026-11-01T13:30:00.000Z');
const PAST = new Date('2026-11-01T08:00:00.000Z');
const DELETED_AT = new Date('2026-10-01T00:00:00.000Z');

// ---------------------------------------------------------------------------
// Guard: isScreenNameClash assumes Screen's only unique columns are `id` and `name`.
// See test/prismaSchema.ts for why the schema file is read.
// ---------------------------------------------------------------------------

describe('guard: Screen unique fields (isScreenNameClash assumption)', () => {
  const screen = readModelUniqueness(readSchemaPrisma(), 'Screen');

  it('the schema reader sees every Screen scalar field the generated client has', () => {
    const scalarFields = Object.values(Prisma.ScreenScalarFieldEnum) as string[];
    expect(
      screen.fields.filter((field) => scalarFields.includes(field)),
      'schema.prisma and the generated client disagree: run `prisma generate`, or fix the reader',
    ).toEqual(scalarFields);
  });

  it('Screen is unique only on id (@id) and name (@unique)', () => {
    expect(
      {
        idFields: screen.idFields,
        uniqueFields: screen.uniqueFields,
        blockAttributes: screen.blockAttributes,
      },
      UPDATE_DETECTION,
    ).toEqual({ idFields: ['id'], uniqueFields: ['name'], blockAttributes: [] });
  });

  it('the generated client agrees (checked by typecheck)', () => {
    type UniqueColumn = {
      [K in keyof Screen]-?: Pick<Screen, K> extends Prisma.ScreenWhereUniqueInput ? K : never;
    }[keyof Screen];
    type CompoundUnique = Exclude<
      keyof Prisma.ScreenWhereUniqueInput,
      keyof Screen | keyof Prisma.ScreenInclude | 'AND' | 'OR' | 'NOT'
    >;
    // If either line fails typecheck: see UPDATE_DETECTION above.
    expectTypeOf<UniqueColumn>().toEqualTypeOf<'id' | 'name'>();
    expectTypeOf<CompoundUnique>().toEqualTypeOf<never>();
  });
});

describe('isScreenNameClash', () => {
  it('is true for a P2002 on Screen_name_key shaped like Prisma 7.10.1 + adapter-pg', () => {
    const error = uniqueConstraintError('screen', 'name');
    expect(error.meta?.['target']).toBeUndefined();
    expect(error.meta).toMatchObject({
      modelName: 'Screen',
      driverAdapterError: { cause: { constraint: { index: 'Screen_name_key' } } },
    });
    expect(isScreenNameClash(error)).toBe(true);
  });

  it('is false for other Prisma errors and anything else', () => {
    expect(isScreenNameClash(recordNotFoundError('screen', 'an update'))).toBe(false);
    expect(isScreenNameClash(new Error('P2002'))).toBe(false);
    expect(isScreenNameClash({ code: 'P2002' })).toBe(false);
    expect(isScreenNameClash(undefined)).toBe(false);
  });
});

describe('toAdminScreen', () => {
  it('maps every column, timestamps as ISO strings, in the strict shared shape', () => {
    const row = testScreen({ name: 'Screen 2', capacity: 250, deletedAt: DELETED_AT });
    const screen = toAdminScreen(row);
    expect(screen).toEqual({
      id: row.id,
      name: 'Screen 2',
      capacity: 250,
      isActive: true,
      deletedAt: '2026-10-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(adminScreenSchema.parse(screen)).toEqual(screen);
  });
});

describe('screenDetailChanges', () => {
  const current = toAdminScreen(testScreen({ name: 'Screen 1', capacity: 300 }));
  const changes = (body: ScreenUpdateBodyInput) =>
    screenDetailChanges(current, screenUpdateBodySchema.parse(body));

  it('lists only the fields whose value differs', () => {
    expect(changes({ name: 'Screen 1', capacity: 300 })).toEqual({});
    expect(changes({ name: '  Screen 1  ' })).toEqual({});
    expect(changes({ capacity: 120 })).toEqual({ capacity: { from: 300, to: 120 } });
    expect(changes({ capacity: null })).toEqual({ capacity: { from: 300, to: null } });
  });

  it('a change of case is a change', () => {
    expect(changes({ name: 'SCREEN 1' })).toEqual({ name: { from: 'Screen 1', to: 'SCREEN 1' } });
  });
});

describe('screenNameMatchWhere and adminScreenListWhere', () => {
  it('matches the name ignoring case, with LIKE wildcards escaped, excluding an id', () => {
    expect(screenNameMatchWhere('A_C 100% \\')).toEqual({
      name: { equals: 'A\\_C 100\\% \\\\', mode: 'insensitive' },
    });
    expect(screenNameMatchWhere('Screen 1', 'x')).toEqual({
      name: { equals: 'Screen 1', mode: 'insensitive' },
      id: { not: 'x' },
    });
  });

  it('excludes deleted screens by default; ANDs the filters; escapes the search', () => {
    expect(adminScreenListWhere(adminScreenListQuerySchema.parse({}))).toEqual({
      deletedAt: null,
    });
    expect(
      adminScreenListWhere(
        adminScreenListQuerySchema.parse({ search: ' 50%_ ', isActive: 'false', deleted: 'only' }),
      ),
    ).toEqual({
      isActive: false,
      deletedAt: { not: null },
      name: { contains: '50\\%\\_', mode: 'insensitive' },
    });
    expect(adminScreenListWhere(adminScreenListQuerySchema.parse({ deleted: 'include' }))).toEqual(
      {},
    );
  });

  it('sorts by name, then id', () => {
    expect(ADMIN_SCREEN_LIST_ORDER_BY).toEqual([{ name: 'asc' }, { id: 'asc' }]);
  });
});

// ---------------------------------------------------------------------------
// The service over the in-memory fake
// ---------------------------------------------------------------------------

/** A showtime on the first seeded screen, of the seeded movie. */
type ShowtimeOnScreen = Partial<Showtime> & Pick<Showtime, 'startsAt'>;

function setup(seed: { screens?: Screen[]; showtimes?: ShowtimeOnScreen[] } = {}) {
  const admin = testAdmin();
  const movie = testMovie();
  const screens = seed.screens ?? [];
  const screenId = screens[0]?.id ?? '';
  const db = inMemoryAuthDb({
    admins: [admin],
    movies: [movie],
    screens,
    showtimes: (seed.showtimes ?? []).map((x) =>
      testShowtime({ movieId: movie.id, screenId, ...x }),
    ),
  });
  const cache = new MemoryCache();
  const invalidate = vi.spyOn(cache, 'invalidatePrefix');
  const service = createScreenAdminService({ db: db.prisma, cache, now: () => NOW });
  const actor = { adminId: admin.id, ipAddress: '203.0.113.7', userAgent: 'test-agent' };
  return { db, service, actor, invalidate, movie };
}

const create = (s: ReturnType<typeof setup>, body: ScreenCreateBodyInput) =>
  s.service.create(screenCreateBodySchema.parse(body), s.actor);
const update = (s: ReturnType<typeof setup>, id: string, body: ScreenUpdateBodyInput) =>
  s.service.update(id, screenUpdateBodySchema.parse(body), s.actor);

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

/** The store row (a copy). */
const stored = (s: ReturnType<typeof setup>, id: string) =>
  structuredClone(s.db.screens.find((row) => row.id === id));

/** The live store row, to change it the way a concurrent request would. */
function liveRow(s: ReturnType<typeof setup>, id: string): Screen {
  const row = s.db.screens.find((r) => r.id === id);
  if (!row) throw new Error(`no screen ${id}`);
  return row;
}

describe('create', () => {
  it('creates an active screen with one CREATE audit row, then drops the public cache', async () => {
    const s = setup();

    const screen = await create(s, { name: '  Screen 1  ', capacity: 300 });

    expect(screen).toMatchObject({
      name: 'Screen 1',
      capacity: 300,
      isActive: true,
      deletedAt: null,
    });
    expect(s.db.screens).toHaveLength(1);
    expect(s.db.auditLogs).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        adminId: s.actor.adminId,
        entity: 'Screen',
        entityId: screen.id,
        details: { name: 'Screen 1', capacity: 300 },
        ipAddress: '203.0.113.7',
        userAgent: 'test-agent',
      }),
    ]);
    expect(s.invalidate).toHaveBeenCalledExactlyOnceWith(PUBLIC_MOVIES_CACHE_PREFIX);
    const auditOrder = s.db.spies.auditLog.create.mock.invocationCallOrder.at(-1) ?? Infinity;
    expect(s.invalidate.mock.invocationCallOrder[0]).toBeGreaterThan(auditOrder);
  });

  it('stores a missing capacity as NULL', async () => {
    const s = setup();
    expect((await create(s, { name: 'Screen 1' })).capacity).toBeNull();
    expect((await create(s, { name: 'Screen 2', capacity: null })).capacity).toBeNull();
    expect(s.db.auditLogs.map((row) => row.details)).toEqual([
      { name: 'Screen 1', capacity: null },
      { name: 'Screen 2', capacity: null },
    ]);
  });

  it.each([
    ['the exact name', 'Screen 1'],
    ['the name in another case', 'screen 1'],
    ['the name in upper case', 'SCREEN 1'],
    ['the name with spaces around it', '  Screen 1  '],
  ])('refuses %s of a live screen with 409 on body.name', async (_name, name) => {
    const s = setup({ screens: [testScreen({ name: 'Screen 1' })] });

    const error = await rejection(create(s, { name }));

    expect(error).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: SCREEN_NAME_IN_USE_MESSAGE,
      details: [{ path: ['body', 'name'], message: SCREEN_NAME_IN_USE_MESSAGE }],
    });
    expect(s.db.screens).toHaveLength(1);
    expect(s.db.auditLogs).toEqual([]);
    expect(s.db.spies.screen.create).not.toHaveBeenCalled();
    expect(s.invalidate).not.toHaveBeenCalled();
  });

  it('refuses a name only a soft-deleted screen has, suggesting a restore', async () => {
    const s = setup({ screens: [testScreen({ name: 'Screen 1', deletedAt: DELETED_AT })] });

    const error = await rejection(create(s, { name: 'screen 1' }));

    expect(error).toMatchObject({
      status: 409,
      message: SCREEN_NAME_DELETED_MESSAGE,
      details: [{ path: ['body', 'name'], message: SCREEN_NAME_DELETED_MESSAGE }],
    });
  });

  it('prefers the "in use" message when a live and a deleted screen both match', async () => {
    const s = setup({
      screens: [
        testScreen({ name: 'Screen 1', deletedAt: DELETED_AT }),
        testScreen({ name: 'SCREEN 1' }),
      ],
    });
    expect((await rejection(create(s, { name: 'screen 1' }))).message).toBe(
      SCREEN_NAME_IN_USE_MESSAGE,
    );
  });

  it.each([
    ['A_C', 'ABC'],
    ['A%', 'AB'],
    ['A%', 'A'],
    ['A\\B', 'AB'],
    ['100%', '1000'],
  ])('matches %j literally: an existing %j does not block it', async (name, existing) => {
    const s = setup({ screens: [testScreen({ name: existing })] });
    expect((await create(s, { name })).name).toBe(name);
  });

  it.each(['a_c', 'a%', 'a\\b'])(
    'but an existing %j in another case does block it',
    async (name) => {
      const s = setup({ screens: [testScreen({ name: name.toUpperCase() })] });
      expect((await rejection(create(s, { name }))).status).toBe(409);
    },
  );

  it('a P2002 from the insert (a concurrent create of the same name) is a 409, not a 500', async () => {
    const s = setup();
    s.db.injectFault('screen', 'create', { error: uniqueConstraintError('screen', 'name') });

    const error = await rejection(create(s, { name: 'Screen 1' }));

    expect(error).toMatchObject({ status: 409, message: SCREEN_NAME_IN_USE_MESSAGE });
    expect(s.db.screens).toEqual([]);
    expect(s.db.auditLogs).toEqual([]);
    expect(s.invalidate).not.toHaveBeenCalled();
  });

  it('a concurrent insert of the exact name after the check hits the unique index: 409', async () => {
    const s = setup();
    s.db.injectFault('screen', 'create', { before: () => s.db.addScreen({ name: 'Screen 1' }) });

    const error = await rejection(create(s, { name: 'Screen 1' }));

    expect(error).toMatchObject({ status: 409, message: SCREEN_NAME_IN_USE_MESSAGE });
    expect(s.db.screens).toHaveLength(1);
    expect(s.db.auditLogs).toEqual([]);
  });

  it('KNOWN RACE: a concurrent insert differing only in case after the check gets in', async () => {
    // Documented in createScreenAdminService; closed by a unique index on lower(name) later.
    const s = setup();
    s.db.injectFault('screen', 'create', { before: () => s.db.addScreen({ name: 'SCREEN 1' }) });

    await create(s, { name: 'Screen 1' });

    expect(s.db.screens.map((row) => row.name)).toEqual(['SCREEN 1', 'Screen 1']);
  });

  it('a P2002 from the audit write is a 500-type failure, not a name clash', async () => {
    const s = setup();
    const auditClash = uniqueConstraintError('auditLog', 'id');
    s.db.injectFault('auditLog', 'create', { error: auditClash });

    await expect(create(s, { name: 'Screen 1' })).rejects.toBe(auditClash);
    expect(s.db.screens).toEqual([]);
    expect(s.invalidate).not.toHaveBeenCalled();
  });
});

describe('list and getById', () => {
  it('sorts by name then id (C collation), filters and pages', async () => {
    const screens = [
      testScreen({ name: 'Screen 2' }),
      testScreen({ name: 'Screen 10' }),
      testScreen({ name: 'screen 3' }),
      testScreen({ name: 'Hidden', isActive: false }),
      testScreen({ name: 'Old', deletedAt: DELETED_AT }),
    ];
    const s = setup({ screens });
    const list = (query: Record<string, string>) =>
      s.service.list(adminScreenListQuerySchema.parse(query));

    const page = await list({});
    expect(page.items.map((x) => x.name)).toEqual(['Hidden', 'Screen 10', 'Screen 2', 'screen 3']);
    expect(page).toMatchObject({ page: 1, pageSize: 20, total: 4 });
    expect((await list({ isActive: 'false' })).items.map((x) => x.name)).toEqual(['Hidden']);
    expect((await list({ deleted: 'only' })).items.map((x) => x.name)).toEqual(['Old']);
    expect((await list({ deleted: 'include' })).total).toBe(5);
    expect((await list({ search: 'SCREEN' })).total).toBe(3);
    expect((await list({ pageSize: '2', page: '2' })).items.map((x) => x.name)).toEqual([
      'Screen 2',
      'screen 3',
    ]);
    expect(s.invalidate).not.toHaveBeenCalled();
    expect(s.db.auditLogs).toEqual([]);
  });

  it('searches with % and _ literally', async () => {
    const s = setup({ screens: [testScreen({ name: 'A_C' }), testScreen({ name: 'ABC' })] });
    const result = await s.service.list(adminScreenListQuerySchema.parse({ search: '_' }));
    expect(result.items.map((x) => x.name)).toEqual(['A_C']);
  });

  it('getById returns deleted screens and 404s an unknown id', async () => {
    const deleted = testScreen({ name: 'Old', deletedAt: DELETED_AT });
    const s = setup({ screens: [deleted] });
    expect((await s.service.getById(deleted.id)).deletedAt).toBe(DELETED_AT.toISOString());
    expect(await rejection(s.service.getById(randomUUID()))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: SCREEN_NOT_FOUND_MESSAGE,
    });
  });
});

describe('update', () => {
  it('changes name and capacity, auditing only the changed fields', async () => {
    const screen = testScreen({ name: 'Screen 1', capacity: 300 });
    const s = setup({ screens: [screen] });

    const updated = await update(s, screen.id, { name: 'Gold Class', capacity: 300 });

    expect(updated).toMatchObject({ name: 'Gold Class', capacity: 300 });
    expect(s.db.auditLogs).toEqual([
      expect.objectContaining({
        action: 'UPDATE',
        entity: 'Screen',
        entityId: screen.id,
        details: { changes: { name: { from: 'Screen 1', to: 'Gold Class' } } },
      }),
    ]);
    expect(s.invalidate).toHaveBeenCalledExactlyOnceWith(PUBLIC_MOVIES_CACHE_PREFIX);
    expect(s.db.locks).toEqual([{ table: 'Screen', id: screen.id }]);
  });

  it('capacity null clears it', async () => {
    const screen = testScreen({ capacity: 300 });
    const s = setup({ screens: [screen] });
    expect((await update(s, screen.id, { capacity: null })).capacity).toBeNull();
    expect(s.db.auditLogs[0]?.details).toEqual({ changes: { capacity: { from: 300, to: null } } });
  });

  it('renaming a screen to its own name in another case is allowed', async () => {
    const screen = testScreen({ name: 'Screen 1' });
    const s = setup({ screens: [screen] });
    expect((await update(s, screen.id, { name: 'SCREEN 1' })).name).toBe('SCREEN 1');
  });

  it('a no-op is not written, audited or invalidating, and checks no name', async () => {
    const screen = testScreen({ name: 'Screen 1', capacity: 300 });
    const s = setup({ screens: [screen] });

    expect(await update(s, screen.id, { name: ' Screen 1 ', capacity: 300 })).toEqual(
      toAdminScreen(screen),
    );

    expect(s.db.spies.screen.update).not.toHaveBeenCalled();
    expect(s.db.spies.screen.findMany).not.toHaveBeenCalled();
    expect(s.db.auditLogs).toEqual([]);
    expect(s.invalidate).not.toHaveBeenCalled();
  });

  it.each([
    ['a live screen', null, SCREEN_NAME_IN_USE_MESSAGE],
    ['a deleted screen', DELETED_AT, SCREEN_NAME_DELETED_MESSAGE],
  ])('refuses a name %s has (ignoring case) with 409 on body.name', async (_n, deletedAt, msg) => {
    const screen = testScreen({ name: 'Screen 1' });
    const s = setup({ screens: [screen, testScreen({ name: 'Screen 2', deletedAt })] });

    const error = await rejection(update(s, screen.id, { name: 'screen 2' }));

    expect(error).toMatchObject({
      status: 409,
      message: msg,
      details: [{ path: ['body', 'name'], message: msg }],
    });
    expect(stored(s, screen.id)).toEqual(screen);
    expect(s.db.auditLogs).toEqual([]);
    expect(s.invalidate).not.toHaveBeenCalled();
  });

  it('a P2002 from the update is a 409, changing nothing', async () => {
    const screen = testScreen({ name: 'Screen 1' });
    const s = setup({ screens: [screen] });
    s.db.injectFault('screen', 'update', { error: uniqueConstraintError('screen', 'name') });

    const error = await rejection(update(s, screen.id, { name: 'Screen 9' }));

    expect(error).toMatchObject({ status: 409, message: SCREEN_NAME_IN_USE_MESSAGE });
    expect(stored(s, screen.id)).toEqual(screen);
    expect(s.db.auditLogs).toEqual([]);
  });

  it('404 for an unknown id, 409 "restore first" for a deleted screen', async () => {
    const deleted = testScreen({ deletedAt: DELETED_AT });
    const s = setup({ screens: [deleted] });
    expect(await rejection(update(s, randomUUID(), { capacity: 1 }))).toMatchObject({
      status: 404,
      message: SCREEN_NOT_FOUND_MESSAGE,
    });
    expect(await rejection(update(s, deleted.id, { capacity: 1 }))).toMatchObject({
      status: 409,
      message: SCREEN_RESTORE_FIRST_MESSAGE,
    });
    expect(await rejection(s.service.setActive(deleted.id, false, s.actor))).toMatchObject({
      status: 409,
      message: SCREEN_RESTORE_FIRST_MESSAGE,
    });
    expect(s.db.spies.screen.update).not.toHaveBeenCalled();
    expect(s.db.auditLogs).toEqual([]);
  });
});

describe('the future-showtime guard (setActive false, softDelete)', () => {
  const OPERATIONS = [
    {
      name: 'setActive(false)',
      run: (s: ReturnType<typeof setup>, id: string) => s.service.setActive(id, false, s.actor),
      message: SCREEN_DEACTIVATE_HAS_SHOWTIMES_MESSAGE,
    },
    {
      name: 'softDelete',
      run: (s: ReturnType<typeof setup>, id: string) => s.service.softDelete(id, s.actor),
      message: SCREEN_DELETE_HAS_SHOWTIMES_MESSAGE,
    },
  ];

  /** One screen with the given showtimes on it. */
  function withShowtimes(showtimes: ShowtimeOnScreen[]) {
    const screen = testScreen();
    return { s: setup({ screens: [screen], showtimes }), screen };
  }

  describe.each(OPERATIONS)('$name', ({ run, message }) => {
    it('is refused with 409 and futureShowtimeCount while upcoming showtimes exist', async () => {
      const { s, screen } = withShowtimes([
        { startsAt: FUTURE },
        { startsAt: new Date('2026-12-01T13:30:00.000Z') },
        { startsAt: PAST },
        { startsAt: FUTURE, deletedAt: DELETED_AT },
      ]);

      const error = await rejection(run(s, screen.id));

      expect(error).toMatchObject({
        status: 409,
        code: 'CONFLICT',
        message,
        details: { futureShowtimeCount: 2 },
      });
      expect(stored(s, screen.id)).toEqual(screen);
      expect(s.db.spies.screen.update).not.toHaveBeenCalled();
      expect(s.db.auditLogs).toEqual([]);
      expect(s.invalidate).not.toHaveBeenCalled();
    });

    it('counts one upcoming showtime as 1', async () => {
      const { s, screen } = withShowtimes([{ startsAt: FUTURE }]);
      expect((await rejection(run(s, screen.id))).details).toEqual({ futureShowtimeCount: 1 });
    });

    it.each([
      ['only past showtimes', [{ startsAt: PAST }]],
      ['a showtime starting exactly now', [{ startsAt: NOW }]],
      ['only soft-deleted upcoming showtimes', [{ startsAt: FUTURE, deletedAt: DELETED_AT }]],
      ['no showtimes', []],
    ])('is allowed with %s', async (_name, starts) => {
      const { s, screen } = withShowtimes(starts);

      await run(s, screen.id);

      expect(s.db.spies.screen.update).toHaveBeenCalledTimes(1);
      expect(s.db.auditLogs).toHaveLength(1);
      expect(s.invalidate).toHaveBeenCalledTimes(1);
    });

    it('locks the screen row first, then counts with the injected clock', async () => {
      const { s, screen } = withShowtimes([{ startsAt: FUTURE }]);

      await rejection(run(s, screen.id));

      expect(s.db.locks).toEqual([{ table: 'Screen', id: screen.id }]);
      expect(s.db.spies.showtime.count).toHaveBeenCalledExactlyOnceWith({
        where: { screenId: screen.id, deletedAt: null, startsAt: { gt: NOW } },
      });
      const lockOrder = s.db.spies.$queryRaw.mock.invocationCallOrder[0] ?? Infinity;
      const readOrder = s.db.spies.screen.findUnique.mock.invocationCallOrder[0] ?? -Infinity;
      const countOrder = s.db.spies.showtime.count.mock.invocationCallOrder[0] ?? -Infinity;
      expect(lockOrder).toBeLessThan(readOrder);
      expect(readOrder).toBeLessThan(countOrder);
    });
  });

  it('activating has no showtime check; hiding a hidden screen is a no-op without one', async () => {
    const { s, screen } = withShowtimes([{ startsAt: FUTURE }]);
    liveRow(s, screen.id).isActive = false;

    expect((await s.service.setActive(screen.id, false, s.actor)).isActive).toBe(false);
    expect(s.db.auditLogs).toEqual([]);
    expect((await s.service.setActive(screen.id, true, s.actor)).isActive).toBe(true);

    expect(s.db.spies.showtime.count).not.toHaveBeenCalled();
    expect(s.db.auditLogs).toEqual([
      expect.objectContaining({
        action: 'STATUS_CHANGE',
        entity: 'Screen',
        entityId: screen.id,
        details: { field: 'isActive', from: false, to: true },
      }),
    ]);
    expect(s.invalidate).toHaveBeenCalledTimes(1);
  });

  it('softDelete stamps deletedAt with the injected clock and audits DELETE soft', async () => {
    const { s, screen } = withShowtimes([{ startsAt: PAST }]);

    const deleted = await s.service.softDelete(screen.id, s.actor);

    expect(deleted.deletedAt).toBe(NOW.toISOString());
    expect(deleted.isActive).toBe(true);
    expect(s.db.auditLogs).toEqual([
      expect.objectContaining({
        action: 'DELETE',
        entity: 'Screen',
        entityId: screen.id,
        details: { mode: 'soft', name: 'Screen 1' },
      }),
    ]);
  });
});

describe('softDelete and restore conflicts', () => {
  it('softDelete: 409 when already deleted, 404 when unknown', async () => {
    const deleted = testScreen({ deletedAt: DELETED_AT });
    const s = setup({ screens: [deleted] });
    expect(await rejection(s.service.softDelete(deleted.id, s.actor))).toMatchObject({
      status: 409,
      message: SCREEN_ALREADY_DELETED_MESSAGE,
    });
    expect(await rejection(s.service.softDelete(randomUUID(), s.actor))).toMatchObject({
      status: 404,
    });
    expect(s.db.spies.showtime.count).not.toHaveBeenCalled();
    expect(s.db.auditLogs).toEqual([]);
  });

  it('restore clears deletedAt, keeps isActive, audits UPDATE restored', async () => {
    const deleted = testScreen({ name: 'Screen 1', isActive: false, deletedAt: DELETED_AT });
    const s = setup({ screens: [deleted] });

    const restored = await s.service.restore(deleted.id, s.actor);

    expect(restored).toMatchObject({ deletedAt: null, isActive: false });
    expect(s.db.auditLogs).toEqual([
      expect.objectContaining({
        action: 'UPDATE',
        entity: 'Screen',
        entityId: deleted.id,
        details: { restored: true, name: 'Screen 1' },
      }),
    ]);
    expect(s.invalidate).toHaveBeenCalledExactlyOnceWith(PUBLIC_MOVIES_CACHE_PREFIX);
    expect(s.db.locks).toEqual([{ table: 'Screen', id: deleted.id }]);
  });

  it('restore: 409 when not deleted, 404 when unknown', async () => {
    const live = testScreen();
    const s = setup({ screens: [live] });
    expect(await rejection(s.service.restore(live.id, s.actor))).toMatchObject({
      status: 409,
      message: SCREEN_NOT_DELETED_MESSAGE,
    });
    expect(await rejection(s.service.restore(randomUUID(), s.actor))).toMatchObject({
      status: 404,
    });
  });

  it('restore is refused while a live screen has the name ignoring case', async () => {
    const deleted = testScreen({ name: 'Screen 1', deletedAt: DELETED_AT });
    const s = setup({ screens: [deleted, testScreen({ name: 'SCREEN 1' })] });

    const error = await rejection(s.service.restore(deleted.id, s.actor));

    expect(error).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: SCREEN_RESTORE_NAME_IN_USE_MESSAGE,
      details: undefined,
    });
    expect(stored(s, deleted.id)).toEqual(deleted);
    expect(s.db.auditLogs).toEqual([]);
    expect(s.invalidate).not.toHaveBeenCalled();
  });

  it('restore is not blocked by another deleted screen with the name, or by A_C for ABC', async () => {
    const first = testScreen({ name: 'Screen 1', deletedAt: DELETED_AT });
    const second = testScreen({ name: 'screen 1', deletedAt: DELETED_AT });
    const abc = testScreen({ name: 'ABC', deletedAt: DELETED_AT });
    const s = setup({ screens: [first, second, abc, testScreen({ name: 'A_C' })] });

    await s.service.restore(first.id, s.actor);
    await s.service.restore(abc.id, s.actor);
    // Now `first` is live, so `second` is blocked.
    expect((await rejection(s.service.restore(second.id, s.actor))).message).toBe(
      SCREEN_RESTORE_NAME_IN_USE_MESSAGE,
    );
  });
});

describe('lost writes (P2025) are 404 / 409, never 500', () => {
  it.each([
    ['update', (s: ReturnType<typeof setup>, id: string) => update(s, id, { capacity: 5 })],
    [
      'setActive',
      (s: ReturnType<typeof setup>, id: string) => s.service.setActive(id, false, s.actor),
    ],
    ['softDelete', (s: ReturnType<typeof setup>, id: string) => s.service.softDelete(id, s.actor)],
  ])('%s: 409 "changed" when the screen is still live afterwards', async (_name, run) => {
    const screen = testScreen();
    const s = setup({ screens: [screen] });
    s.db.injectFault('screen', 'update', { error: recordNotFoundError('screen', 'an update') });

    expect(await rejection(run(s, screen.id))).toMatchObject({
      status: 409,
      message: SCREEN_CHANGED_MESSAGE,
    });
    expect(stored(s, screen.id)).toEqual(screen);
    expect(s.db.auditLogs).toEqual([]);
    expect(s.invalidate).not.toHaveBeenCalled();
  });

  it('update: 409 "restore first" when soft-deleted before the write, 404 when removed', async () => {
    const screen = testScreen();
    const s = setup({ screens: [screen] });
    s.db.injectFault('screen', 'update', {
      before: () => {
        liveRow(s, screen.id).deletedAt = DELETED_AT;
      },
    });
    expect(await rejection(update(s, screen.id, { capacity: 5 }))).toMatchObject({
      status: 409,
      message: SCREEN_RESTORE_FIRST_MESSAGE,
    });

    liveRow(s, screen.id).deletedAt = null;
    s.db.injectFault('screen', 'update', {
      before: () => {
        s.db.screens.splice(0, 1);
      },
    });
    expect(await rejection(update(s, screen.id, { capacity: 5 }))).toMatchObject({
      status: 404,
      message: SCREEN_NOT_FOUND_MESSAGE,
    });
    expect(s.db.auditLogs).toEqual([]);
  });

  it('restore: 409 "not deleted" when restored by someone else before the write', async () => {
    const deleted = testScreen({ deletedAt: DELETED_AT });
    const s = setup({ screens: [deleted] });
    s.db.injectFault('screen', 'update', {
      before: () => {
        liveRow(s, deleted.id).deletedAt = null;
      },
    });
    expect(await rejection(s.service.restore(deleted.id, s.actor))).toMatchObject({
      status: 409,
      message: SCREEN_NOT_DELETED_MESSAGE,
    });
  });

  it('propagates a failure of the re-read unchanged, and other update errors as they are', async () => {
    const screen = testScreen();
    const s = setup({ screens: [screen] });
    const failure = new Error('connection reset');
    s.db.injectFault('screen', 'update', { error: recordNotFoundError('screen', 'an update') });
    s.db.injectFault('screen', 'findUnique', { onCall: 2, error: failure });
    await expect(update(s, screen.id, { capacity: 5 })).rejects.toBe(failure);

    s.db.injectFault('screen', 'update', { error: failure });
    await expect(update(s, screen.id, { capacity: 5 })).rejects.toBe(failure);
    expect(s.db.auditLogs).toEqual([]);
  });

  it('a failed audit write rolls the change back and does not invalidate', async () => {
    const screen = testScreen();
    const s = setup({ screens: [screen] });
    const failure = new Error('audit down');
    s.db.injectFault('auditLog', 'create', { error: failure });

    await expect(s.service.softDelete(screen.id, s.actor)).rejects.toBe(failure);

    expect(s.db.spies.screen.update).toHaveBeenCalledTimes(1);
    expect(stored(s, screen.id)).toEqual(screen);
    expect(s.invalidate).not.toHaveBeenCalled();
  });

  it('a screen missing at the lock is a 404 without a read', async () => {
    const s = setup();
    expect(await rejection(s.service.softDelete(randomUUID(), s.actor))).toMatchObject({
      status: 404,
      message: SCREEN_NOT_FOUND_MESSAGE,
    });
    expect(s.db.spies.screen.findUnique).not.toHaveBeenCalled();
  });
});
