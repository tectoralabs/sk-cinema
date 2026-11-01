/**
 * Tests for the in-memory Prisma fake's Screen, Showtime and Setting models, auditLog.createMany,
 * foreign keys (P2003), onDelete Cascade / Restrict and the row-lock `$queryRaw` contract. The
 * showtime services trust the fake to answer like Postgres (see the shapes captured from
 * Postgres 18 + Prisma 7.10.1 in helpers.ts) and to refuse anything else loudly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import {
  LOCK_SQL,
  UnsupportedByFakeError,
  foreignKeyError,
  inMemoryAuthDb,
  restrictError,
  testAdmin,
  testMovie,
  testScreen,
  testSetting,
  testShowtime,
  uniqueConstraintError,
  type InMemoryAuthDb,
} from './helpers.js';

/** The fake's clock. Only Date is faked, so promises run normally. */
const NOW = new Date('2026-11-01T06:30:00.000Z'); // 12:00 Colombo
const LATER = new Date(NOW.getTime() + 60_000);
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MISSING_ID = '00000000-0000-7000-8000-000000000999';

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const at = (iso: string) => new Date(iso);

/**
 * Two live movies, one hidden, one soft-deleted; two live screens and one soft-deleted; and
 * showtimes in this insertion order: past, now, +1 min, evening (with an override), a
 * soft-deleted one, one on screen 2, one for the hidden movie, one for the deleted movie.
 */
function cinema() {
  const dune = testMovie({
    slug: 'dune',
    title: 'Dune',
    durationMinutes: 155,
    status: 'NOW_SHOWING',
  });
  const zorro = testMovie({
    slug: 'zorro',
    title: 'Zorro',
    durationMinutes: 90,
    status: 'NOW_SHOWING',
  });
  const hidden = testMovie({
    slug: 'hidden',
    title: 'Hidden',
    isActive: false,
    status: 'NOW_SHOWING',
  });
  const gone = testMovie({
    slug: 'gone',
    title: 'Gone',
    deletedAt: at('2026-10-01T00:00:00.000Z'),
  });
  const screen1 = testScreen({ name: 'Screen 1', capacity: 300 });
  const screen2 = testScreen({ name: 'Screen 2' });
  const closed = testScreen({ name: 'Old Screen', deletedAt: at('2026-10-01T00:00:00.000Z') });
  const show = (name: string, overrides: Parameters<typeof testShowtime>[0]) => ({
    name,
    row: testShowtime(overrides),
  });
  const shows = [
    show('past', {
      movieId: dune.id,
      screenId: screen1.id,
      startsAt: at('2026-11-01T03:30:00.000Z'),
    }),
    show('now', { movieId: dune.id, screenId: screen1.id, startsAt: NOW }),
    show('soon', { movieId: zorro.id, screenId: screen2.id, startsAt: LATER }),
    show('evening', {
      movieId: dune.id,
      screenId: screen1.id,
      startsAt: at('2026-11-01T13:30:00.000Z'),
      bookingUrlOverride:
        'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/cinema-snlk-SKCM-MT/20261101',
    }),
    show('cancelled', {
      movieId: dune.id,
      screenId: screen1.id,
      startsAt: at('2026-11-02T13:30:00.000Z'),
      deletedAt: at('2026-10-30T00:00:00.000Z'),
    }),
    show('screen2', {
      movieId: dune.id,
      screenId: screen2.id,
      startsAt: at('2026-11-02T18:30:00.000Z'),
      format: '3D',
    }),
    show('hiddenShow', {
      movieId: hidden.id,
      screenId: screen1.id,
      startsAt: at('2026-11-03T13:30:00.000Z'),
    }),
    show('goneShow', {
      movieId: gone.id,
      screenId: closed.id,
      startsAt: at('2026-11-03T13:30:00.000Z'),
    }),
  ];
  const db = inMemoryAuthDb({
    movies: [dune, zorro, hidden, gone],
    screens: [screen1, screen2, closed],
    showtimes: shows.map((s) => s.row),
  });
  const ids = Object.fromEntries(shows.map((s) => [s.row.id, s.name]));
  return { db, dune, zorro, hidden, gone, screen1, screen2, closed, ids };
}

type Cinema = ReturnType<typeof cinema>;
type ShowtimeArgs = NonNullable<Parameters<InMemoryAuthDb['spies']['showtime']['findMany']>[0]>;

/** The names (from cinema()) of the showtimes a findMany returns, in order. */
async function names(c: Cinema, args: ShowtimeArgs = {}) {
  const rows = await c.db.spies.showtime.findMany({ ...args, select: { id: true } });
  return rows.map((row) => c.ids[row['id'] as string]);
}

const whereNames = (c: Cinema, where: NonNullable<ShowtimeArgs['where']>) => names(c, { where });

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

function expectKnownError(error: unknown, code: string) {
  expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  const known = error as Prisma.PrismaClientKnownRequestError;
  expect(known.code).toBe(code);
  return known;
}

/** Asserts the Prisma 7.10.1 + adapter-pg shape of a P2003 (FK or Restrict). */
function expectForeignKeyViolation(
  error: unknown,
  expected: {
    index: string;
    modelName: string;
    originalCode: string;
    kind: string;
    originalMessage: string;
  },
) {
  const known = expectKnownError(error, 'P2003');
  expect(known.message).toContain(
    `Foreign key constraint violated on the constraint: \`${expected.index}\``,
  );
  expect(Object.keys(known.meta ?? {}).sort()).toEqual(['driverAdapterError', 'modelName']);
  expect(known.meta).toHaveProperty('modelName', expected.modelName);
  const adapterError = known.meta?.['driverAdapterError'] as Error;
  expect(adapterError.name).toBe('DriverAdapterError');
  expect(adapterError.cause).toEqual({
    originalCode: expected.originalCode,
    originalMessage: expected.originalMessage,
    kind: expected.kind,
    constraint: { index: expected.index },
  });
}

const showtimeFk = (column: 'movieId' | 'screenId') => ({
  index: `Showtime_${column}_fkey`,
  modelName: 'Showtime',
  originalCode: '23503',
  kind: 'ForeignKeyConstraintViolation',
  originalMessage: `insert or update on table "Showtime" violates foreign key constraint "Showtime_${column}_fkey"`,
});

const SCREEN_RESTRICT = {
  index: 'Showtime_screenId_fkey',
  modelName: 'Screen',
  originalCode: '23001',
  kind: 'RestrictViolation',
  originalMessage:
    'update or delete on table "Screen" violates RESTRICT setting of foreign key constraint ' +
    '"Showtime_screenId_fkey" on table "Showtime"',
};

// ---------------------------------------------------------------------------
// Builders and seeding
// ---------------------------------------------------------------------------

describe('inMemoryAuthDb: screen, showtime and setting builders and seeds', () => {
  it('testScreen, testShowtime and testSetting give full rows with safe defaults', () => {
    const screen = testScreen();
    const movie = testMovie();
    expect(screen).toMatchObject({
      name: 'Screen 1',
      capacity: null,
      isActive: true,
      deletedAt: null,
    });
    expect(screen.id).toMatch(UUID_V7);
    expect(testShowtime({ movieId: movie.id, screenId: screen.id })).toMatchObject({
      movieId: movie.id,
      screenId: screen.id,
      startsAt: at('2026-11-01T13:30:00.000Z'),
      format: '2D',
      bookingUrlOverride: null,
      deletedAt: null,
    });
    expect(testSetting('showGapMinutes', '15')).toEqual({
      key: 'showGapMinutes',
      value: '15',
      updatedById: null,
      updatedAt: at('2026-01-01T00:00:00.000Z'),
    });
  });

  it('seeds screens, showtimes and settings with every column, the same set the builders have', () => {
    const c = cinema();
    const db = inMemoryAuthDb({
      settings: [testSetting('bmsBaseUrl', 'https://lk.bookmyshow.com/buytickets/x')],
    });
    expect(Object.keys(c.db.screens[0] ?? {}).sort()).toEqual(Object.keys(testScreen()).sort());
    expect(Object.keys(c.db.showtimes[0] ?? {}).sort()).toEqual(
      Object.keys(testShowtime({ movieId: c.dune.id, screenId: c.screen1.id })).sort(),
    );
    expect(c.db.showtimes).toHaveLength(8);
    expect(db.settings).toEqual([
      testSetting('bmsBaseUrl', 'https://lk.bookmyshow.com/buytickets/x'),
    ]);
  });

  it('rejects a seeded showtime whose movie or screen does not exist (P2003)', () => {
    const screen = testScreen();
    expect(() =>
      inMemoryAuthDb({
        screens: [screen],
        showtimes: [testShowtime({ movieId: MISSING_ID, screenId: screen.id })],
      }),
    ).toThrow(Prisma.PrismaClientKnownRequestError);
  });

  it('rejects seeded screens with the same name (P2002)', () => {
    expect(() =>
      inMemoryAuthDb({ screens: [testScreen({ name: 'A' }), testScreen({ name: 'A' })] }),
    ).toThrow(Prisma.PrismaClientKnownRequestError);
  });

  it('addScreen and addShowtime insert like create, outside the spies', () => {
    const db = inMemoryAuthDb({ movies: [testMovie()] });
    const movieId = db.movies[0]?.id ?? '';
    const screen = db.addScreen({ name: 'Screen 9' });
    const show = db.addShowtime({ movieId, screenId: screen.id, startsAt: LATER });
    expect(screen).toMatchObject({
      isActive: true,
      capacity: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(show).toMatchObject({
      format: '2D',
      bookingUrlOverride: null,
      deletedAt: null,
      createdAt: NOW,
    });
    expect(show.id).toMatch(UUID_V7);
    expect(db.spies.showtime.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

describe('inMemoryAuthDb: screens', () => {
  it('create applies Prisma defaults and returns the row (or the selected columns)', async () => {
    const db = inMemoryAuthDb();
    const created = await db.spies.screen.create({ data: { name: 'Screen 1' } });
    expect(created).toEqual({
      id: expect.stringMatching(UUID_V7) as unknown,
      name: 'Screen 1',
      capacity: null,
      isActive: true,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await expect(
      db.spies.screen.create({
        data: { name: 'Screen 2', capacity: 120 },
        select: { name: true, capacity: true },
      }),
    ).resolves.toEqual({ name: 'Screen 2', capacity: 120 });
  });

  it('create of a taken name rejects with P2002 for Screen_name_key (no meta.target) and writes nothing', async () => {
    const { db } = cinema();
    const error = await rejection(db.spies.screen.create({ data: { name: 'Screen 1' } }));
    const known = expectKnownError(error, 'P2002');
    expect(known.message).toContain(
      'Unique constraint failed on the constraint: `Screen_name_key`',
    );
    expect(known.meta).toHaveProperty('modelName', 'Screen');
    expect(known.meta).not.toHaveProperty('target');
    expect((known.meta?.['driverAdapterError'] as Error).cause).toEqual({
      originalCode: '23505',
      originalMessage: 'duplicate key value violates unique constraint "Screen_name_key"',
      kind: 'UniqueConstraintViolation',
      constraint: { index: 'Screen_name_key' },
      table: 'Screen',
    });
    expect(known.message).toBe(uniqueConstraintError('screen', 'name').message);
    expect(db.screens).toHaveLength(3);
  });

  it('counts soft-deleted screens for the unique name, and compares names case-sensitively', async () => {
    const { db } = cinema();
    await expect(db.spies.screen.create({ data: { name: 'Old Screen' } })).rejects.toMatchObject({
      code: 'P2002',
    });
    await expect(
      db.spies.screen.create({ data: { name: 'screen 1' }, select: { name: true } }),
    ).resolves.toEqual({ name: 'screen 1' });
  });

  it('update renames, bumps updatedAt, keeps its own name, and rejects a taken name with P2002', async () => {
    const { db, screen1 } = cinema();
    vi.setSystemTime(LATER);
    await expect(
      db.spies.screen.update({
        where: { id: screen1.id, deletedAt: null },
        data: { name: 'Screen 1', capacity: 250 },
        select: { name: true, capacity: true, updatedAt: true },
      }),
    ).resolves.toEqual({ name: 'Screen 1', capacity: 250, updatedAt: LATER });
    await expect(
      db.spies.screen.update({ where: { id: screen1.id }, data: { name: 'Screen 2' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      db.spies.screen.update({ where: { id: MISSING_ID }, data: { name: 'x' } }),
    ).rejects.toMatchObject({ code: 'P2025' });
  });

  it('updateMany writes the matching screens and reports the count', async () => {
    const { db } = cinema();
    await expect(
      db.spies.screen.updateMany({ where: { deletedAt: null }, data: { isActive: false } }),
    ).resolves.toEqual({ count: 2 });
    expect(db.screens.map((s) => s.isActive)).toEqual([false, false, true]);
  });

  it('updateMany giving two screens the same name rejects with P2002 and writes nothing', async () => {
    const { db } = cinema();
    await expect(
      db.spies.screen.updateMany({ where: { deletedAt: null }, data: { name: 'Same' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(db.screens.map((s) => s.name)).toEqual(['Screen 1', 'Screen 2', 'Old Screen']);
  });

  it('finds by id or name, filters, orders, pages, selects and counts', async () => {
    const { db, screen1, screen2 } = cinema();
    await expect(
      db.spies.screen.findUnique({ where: { name: 'Screen 2' }, select: { id: true } }),
    ).resolves.toEqual({ id: screen2.id });
    await expect(db.spies.screen.findUnique({ where: { id: screen1.id } })).resolves.toEqual(
      screen1,
    );
    await expect(db.spies.screen.findUnique({ where: { id: MISSING_ID } })).resolves.toBeNull();
    const list = await db.spies.screen.findMany({
      where: { deletedAt: null },
      orderBy: [{ name: 'desc' }, { id: 'asc' }],
      select: { name: true },
    });
    expect(list).toEqual([{ name: 'Screen 2' }, { name: 'Screen 1' }]);
    await expect(
      db.spies.screen.findMany({
        orderBy: { name: 'asc' },
        skip: 1,
        take: 1,
        select: { name: true },
      }),
    ).resolves.toEqual([{ name: 'Screen 1' }]);
    await expect(
      db.spies.screen.findFirst({
        where: { id: { not: screen1.id }, deletedAt: null },
        select: { name: true },
      }),
    ).resolves.toEqual({ name: 'Screen 2' });
    await expect(db.spies.screen.count({ where: { deletedAt: { not: null } } })).resolves.toBe(1);
    await expect(db.spies.screen.count(undefined)).resolves.toBe(3);
  });

  it('equals with mode insensitive is ILIKE: case-folded, and % / _ still act as wildcards', async () => {
    const { db } = cinema();
    const byName = (equals: string, mode?: 'insensitive') =>
      db.spies.screen.findMany({
        where: { name: mode ? { equals, mode } : { equals } },
        select: { name: true },
      });
    await expect(byName('SCREEN 1', 'insensitive')).resolves.toEqual([{ name: 'Screen 1' }]);
    await expect(byName('SCREEN 1')).resolves.toEqual([]);
    await expect(byName('Screen 1')).resolves.toEqual([{ name: 'Screen 1' }]);
    // Prisma sends `name ILIKE $1` unescaped (captured), so `_` matches any one character.
    await expect(byName('screen_1', 'insensitive')).resolves.toEqual([{ name: 'Screen 1' }]);
    await expect(byName('screen\\_1', 'insensitive')).resolves.toEqual([]);
    await expect(byName('screen %', 'insensitive')).resolves.toEqual([
      { name: 'Screen 1' },
      { name: 'Screen 2' },
    ]);
  });

  it('delete of a screen with showtimes rejects with Restrict P2003 and deletes nothing', async () => {
    const { db, screen2 } = cinema();
    const error = await rejection(db.spies.screen.delete({ where: { id: screen2.id } }));
    expectForeignKeyViolation(error, SCREEN_RESTRICT);
    expect(db.screens).toHaveLength(3);
    expect(db.showtimes).toHaveLength(8);
    expect(error).toEqual(restrictError('screen', 'showtime', 'screenId'));
  });

  it('restricts the delete even when the only showtime is soft-deleted', async () => {
    const db = inMemoryAuthDb({ movies: [testMovie()] });
    const screen = db.addScreen({ name: 'S' });
    db.addShowtime({
      movieId: db.movies[0]?.id ?? '',
      screenId: screen.id,
      startsAt: LATER,
      deletedAt: NOW,
    });
    await expect(db.spies.screen.delete({ where: { id: screen.id } })).rejects.toMatchObject({
      code: 'P2003',
    });
  });

  it('deletes a screen without showtimes', async () => {
    const db = inMemoryAuthDb();
    const screen = db.addScreen({ name: 'Empty' });
    await expect(
      db.spies.screen.delete({ where: { id: screen.id }, select: { name: true } }),
    ).resolves.toEqual({ name: 'Empty' });
    expect(db.screens).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Showtimes: writes
// ---------------------------------------------------------------------------

describe('inMemoryAuthDb: showtime create and createMany', () => {
  it('create applies Prisma defaults (2D, no override) and returns the row', async () => {
    const { db, dune, screen1 } = cinema();
    const created = await db.spies.showtime.create({
      data: { movieId: dune.id, screenId: screen1.id, startsAt: LATER },
    });
    expect(created).toEqual({
      id: expect.stringMatching(UUID_V7) as unknown,
      movieId: dune.id,
      screenId: screen1.id,
      startsAt: LATER,
      format: '2D',
      bookingUrlOverride: null,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it('create with a missing movie or screen rejects with P2003 for that foreign key', async () => {
    const { db, dune, screen1 } = cinema();
    const badMovie = await rejection(
      db.spies.showtime.create({
        data: { movieId: MISSING_ID, screenId: screen1.id, startsAt: LATER },
      }),
    );
    expectForeignKeyViolation(badMovie, showtimeFk('movieId'));
    const badScreen = await rejection(
      db.spies.showtime.create({
        data: { movieId: dune.id, screenId: MISSING_ID, startsAt: LATER },
      }),
    );
    expectForeignKeyViolation(badScreen, showtimeFk('screenId'));
    expect(badScreen).toEqual(foreignKeyError('showtime', 'screenId'));
    expect(db.showtimes).toHaveLength(8);
  });

  it('reports the movie foreign key first when both are missing, as Postgres does', async () => {
    const { db } = cinema();
    const error = await rejection(
      db.spies.showtime.create({
        data: { movieId: MISSING_ID, screenId: MISSING_ID, startsAt: LATER },
      }),
    );
    expectForeignKeyViolation(error, showtimeFk('movieId'));
  });

  it('accepts a soft-deleted movie or screen: the foreign key only needs the row', async () => {
    const { db, gone, closed } = cinema();
    await expect(
      db.spies.showtime.create({
        data: { movieId: gone.id, screenId: closed.id, startsAt: LATER },
        select: { startsAt: true },
      }),
    ).resolves.toEqual({ startsAt: LATER });
  });

  it('createMany inserts every row in order and returns { count }', async () => {
    const { db, zorro, screen2 } = cinema();
    const week = Array.from({ length: 7 }, (_, d) => ({
      movieId: zorro.id,
      screenId: screen2.id,
      startsAt: new Date(Date.UTC(2026, 10, 2 + d, 13, 30)),
    }));
    await expect(db.spies.showtime.createMany({ data: week })).resolves.toEqual({ count: 7 });
    expect(db.showtimes.slice(8).map((s) => s.startsAt)).toEqual(week.map((w) => w.startsAt));
    expect(db.showtimes.slice(8).every((s) => s.format === '2D' && UUID_V7.test(s.id))).toBe(true);
    await expect(db.spies.showtime.createMany({ data: [] })).resolves.toEqual({ count: 0 });
  });

  it('createMany is all-or-nothing: one missing screen inserts no row', async () => {
    const { db, zorro, screen2 } = cinema();
    const error = await rejection(
      db.spies.showtime.createMany({
        data: [
          { movieId: zorro.id, screenId: screen2.id, startsAt: LATER },
          { movieId: zorro.id, screenId: MISSING_ID, startsAt: LATER },
        ],
      }),
    );
    expectForeignKeyViolation(error, showtimeFk('screenId'));
    expect(db.showtimes).toHaveLength(8);
  });

  it('createMany is all-or-nothing on a duplicate id inside the batch', async () => {
    const { db, zorro, screen2 } = cinema();
    const row = { id: MISSING_ID, movieId: zorro.id, screenId: screen2.id, startsAt: LATER };
    await expect(db.spies.showtime.createMany({ data: [row, row] })).rejects.toMatchObject({
      code: 'P2002',
    });
    expect(db.showtimes).toHaveLength(8);
  });

  it.each([
    ['a single object as data', { data: { movieId: 'x', screenId: 'y', startsAt: NOW } }],
    ['skipDuplicates', { data: [], skipDuplicates: true }],
    ['a nested relation write', { data: [{ movie: { connect: { id: 'x' } }, startsAt: NOW }] }],
  ])('createMany rejects %s', async (_name, args) => {
    const { db } = cinema();
    await expect(db.spies.showtime.createMany(args as never)).rejects.toBeInstanceOf(
      UnsupportedByFakeError,
    );
    expect(db.showtimes).toHaveLength(8);
  });
});

describe('inMemoryAuthDb: showtime update, updateMany and deleteMany', () => {
  it('update moves a showtime, bumps updatedAt and returns the selected relations', async () => {
    const c = cinema();
    const soon = c.db.showtimes[2];
    if (!soon) throw new Error('no seed');
    vi.setSystemTime(LATER);
    await expect(
      c.db.spies.showtime.update({
        where: { id: soon.id, deletedAt: null },
        data: { screenId: c.screen1.id, format: '3D' },
        select: { format: true, updatedAt: true, screen: { select: { name: true } } },
      }),
    ).resolves.toEqual({ format: '3D', updatedAt: LATER, screen: { name: 'Screen 1' } });
  });

  it('update to a missing screen rejects with P2003 and writes nothing; a missing row with P2025', async () => {
    const c = cinema();
    const soon = c.db.showtimes[2];
    if (!soon) throw new Error('no seed');
    const error = await rejection(
      c.db.spies.showtime.update({ where: { id: soon.id }, data: { screenId: MISSING_ID } }),
    );
    expectForeignKeyViolation(error, showtimeFk('screenId'));
    expect(soon.screenId).toBe(c.screen2.id);
    await expect(
      c.db.spies.showtime.update({ where: { id: MISSING_ID }, data: { format: '3D' } }),
    ).rejects.toMatchObject({ code: 'P2025' });
  });

  it('updateMany soft-deletes a movie’s future live showtimes and reports the count', async () => {
    const c = cinema();
    await expect(
      c.db.spies.showtime.updateMany({
        where: { movieId: c.dune.id, deletedAt: null, startsAt: { gte: NOW } },
        data: { deletedAt: NOW },
      }),
    ).resolves.toEqual({ count: 3 });
    expect(await whereNames(c, { deletedAt: { not: null } })).toEqual([
      'now',
      'evening',
      'cancelled',
      'screen2',
    ]);
  });

  it('deleteMany removes the matching rows, or every row without a where', async () => {
    const c = cinema();
    await expect(
      c.db.spies.showtime.deleteMany({ where: { startsAt: { lt: NOW } } }),
    ).resolves.toEqual({ count: 1 });
    expect(await names(c)).not.toContain('past');
    await expect(c.db.spies.showtime.deleteMany(undefined)).resolves.toEqual({ count: 7 });
    expect(c.db.showtimes).toEqual([]);
  });

  it('rolls back a showtime createMany, update and deleteMany together', async () => {
    const c = cinema();
    const before = c.db.showtimes.map((s) => ({ ...s }));
    const outcome = c.db.prisma.$transaction(async (tx) => {
      await tx.showtime.createMany({
        data: [{ movieId: c.zorro.id, screenId: c.screen2.id, startsAt: LATER }],
      });
      await tx.showtime.updateMany({ where: { movieId: c.dune.id }, data: { format: 'IMAX' } });
      await tx.showtime.deleteMany({ where: { screenId: c.screen2.id } });
      throw new Error('rolled back');
    });
    await expect(outcome).rejects.toThrow('rolled back');
    expect(c.db.showtimes).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Showtimes: queries
// ---------------------------------------------------------------------------

describe('inMemoryAuthDb: showtime where', () => {
  it('filters startsAt with gt / gte / lt / lte, boundaries exact to the millisecond', async () => {
    const c = cinema();
    expect(
      await whereNames(c, { startsAt: { gte: NOW }, deletedAt: null, movieId: c.zorro.id }),
    ).toEqual(['soon']);
    expect(await whereNames(c, { startsAt: { gte: NOW, lt: LATER } })).toEqual(['now']);
    expect(await whereNames(c, { startsAt: { gt: NOW, lte: LATER } })).toEqual(['soon']);
    expect(await whereNames(c, { startsAt: { lt: NOW } })).toEqual(['past']);
    expect(
      await whereNames(c, {
        startsAt: { gte: at('2026-11-01T18:30:00.000Z'), lt: at('2026-11-02T18:30:00.000Z') },
      }),
    ).toEqual(['cancelled']); // 2 Nov Colombo day: [1 Nov 18:30Z, 2 Nov 18:30Z)
  });

  it('matches in, not: value, { not: null } and null', async () => {
    const c = cinema();
    const [past, now] = c.db.showtimes;
    expect(await whereNames(c, { screenId: { in: [c.screen2.id, c.closed.id] } })).toEqual([
      'soon',
      'screen2',
      'goneShow',
    ]);
    expect(
      await whereNames(c, {
        movieId: c.dune.id,
        id: { not: now?.id ?? '' },
        startsAt: { gte: NOW },
      }),
    ).toEqual(['evening', 'cancelled', 'screen2']);
    expect(await whereNames(c, { bookingUrlOverride: { not: null } })).toEqual(['evening']);
    expect(await whereNames(c, { format: { not: '2D' } })).toEqual(['screen2']);
    expect(await whereNames(c, { id: past?.id ?? '', deletedAt: null })).toEqual(['past']);
  });

  it('combines AND (array or object), OR and NOT (object or array, none may match)', async () => {
    const c = cinema();
    expect(
      await whereNames(c, { AND: [{ movieId: c.dune.id }, { screenId: c.screen2.id }] }),
    ).toEqual(['screen2']);
    expect(await whereNames(c, { AND: { format: '3D' } })).toEqual(['screen2']);
    expect(await whereNames(c, { OR: [{ format: '3D' }, { movieId: c.zorro.id }] })).toEqual([
      'soon',
      'screen2',
    ]);
    expect(await whereNames(c, { movieId: c.dune.id, NOT: { screenId: c.screen1.id } })).toEqual([
      'screen2',
    ]);
    expect(
      await whereNames(c, {
        movieId: c.dune.id,
        NOT: [{ screenId: c.screen2.id }, { deletedAt: { not: null } }],
      }),
    ).toEqual(['past', 'now', 'evening']);
    expect(await whereNames(c, { NOT: { deletedAt: null } })).toEqual(['cancelled']);
    expect(await whereNames(c, { OR: [] })).toEqual([]);
  });

  it('filters on the movie and screen with { is: {...} } or the shorthand, like Prisma’s join', async () => {
    const c = cinema();
    const publicShows = {
      deletedAt: null,
      startsAt: { gte: NOW },
      movie: { is: { isActive: true, deletedAt: null, status: { in: ['NOW_SHOWING' as const] } } },
      screen: { deletedAt: null },
    };
    expect(await whereNames(c, publicShows)).toEqual(['now', 'soon', 'evening', 'screen2']);
    expect(await whereNames(c, { movie: { slug: 'zorro' } })).toEqual(['soon']);
    expect(await whereNames(c, { screen: { is: { name: 'Old Screen' } } })).toEqual(['goneShow']);
    expect(
      await whereNames(c, { movie: { OR: [{ isActive: false }, { deletedAt: { not: null } }] } }),
    ).toEqual(['hiddenShow', 'goneShow']);
    expect(
      await whereNames(c, { NOT: { movie: { slug: 'dune' } }, startsAt: { gte: NOW } }),
    ).toEqual(['soon', 'hiddenShow', 'goneShow']);
    await expect(
      c.db.spies.showtime.count({ where: { screen: { is: { capacity: { gte: 300 } } } } }),
    ).resolves.toBe(5);
  });

  it.each([
    ['isNot', { movie: { isNot: { isActive: false } } }],
    ['is next to other keys', { movie: { is: { isActive: true }, slug: 'dune' } }],
    ['a relation filter that is not an object', { movie: true }],
    ['an unknown column of the related model', { movie: { is: { name: 'x' } } }],
    ['AND inside a movie filter (movie allows only OR)', { movie: { AND: [{ isActive: true }] } }],
    ['a to-many relation filter on the related model', { movie: { showtimes: { some: {} } } }],
    ['a value equality on a nullable column under NOT', { NOT: { bookingUrlOverride: 'x' } }],
    ['a range on a nullable column under NOT', { NOT: [{ deletedAt: { lt: NOW } }] }],
    ['a nullable related column under NOT', { NOT: { movie: { releaseDate: { lt: NOW } } } }],
    ['not: value on a nullable column', { bookingUrlOverride: { not: 'x' } }],
    ['not: a non-scalar', { format: { not: { equals: '2D' } } }],
    ['an empty AND array', { AND: [] }],
    ['an empty NOT array', { NOT: [] }],
    ['notIn', { format: { notIn: ['3D'] } }],
    ['contains (not modelled on showtimes)', { format: { contains: 'D' } }],
    ['equals', { format: { equals: '2D' } }],
  ])('rejects %s', async (_name, where) => {
    const c = cinema();
    await expect(c.db.spies.showtime.findMany({ where })).rejects.toBeInstanceOf(
      UnsupportedByFakeError,
    );
  });

  it('still rejects AND / NOT and relation filters on movies and screens', async () => {
    const c = cinema();
    await expect(
      c.db.spies.movie.findMany({ where: { NOT: { slug: 'dune' } } }),
    ).rejects.toBeInstanceOf(UnsupportedByFakeError);
    await expect(
      c.db.spies.screen.findMany({ where: { OR: [{ name: 'Screen 1' }] } }),
    ).rejects.toBeInstanceOf(UnsupportedByFakeError);
    await expect(
      c.db.spies.screen.findMany({ where: { showtimes: { some: {} } } }),
    ).rejects.toBeInstanceOf(UnsupportedByFakeError);
  });
});

describe('inMemoryAuthDb: showtime order, select and include', () => {
  it('orders by startsAt then id, asc or desc, and pages', async () => {
    const c = cinema();
    const live = { deletedAt: null, movieId: c.dune.id };
    expect(await names(c, { where: live, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }] })).toEqual([
      'past',
      'now',
      'evening',
      'screen2',
    ]);
    expect(await names(c, { where: live, orderBy: { startsAt: 'desc' }, take: 2 })).toEqual([
      'screen2',
      'evening',
    ]);
    expect(
      await names(c, {
        where: { startsAt: at('2026-11-03T13:30:00.000Z') },
        orderBy: [{ startsAt: 'asc' }, { id: 'desc' }],
      }),
    ).toEqual(['goneShow', 'hiddenShow']);
    expect(await names(c, { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: 6 })).toEqual([
      'hiddenShow',
      'goneShow',
    ]);
  });

  it('selects nested movie and screen columns', async () => {
    const c = cinema();
    const evening = c.db.showtimes[3];
    await expect(
      c.db.spies.showtime.findMany({
        where: { id: evening?.id ?? '' },
        select: {
          startsAt: true,
          bookingUrlOverride: true,
          movie: { select: { title: true, durationMinutes: true } },
          screen: { select: { name: true } },
        },
      }),
    ).resolves.toEqual([
      {
        startsAt: at('2026-11-01T13:30:00.000Z'),
        bookingUrlOverride: evening?.bookingUrlOverride,
        movie: { title: 'Dune', durationMinutes: 155 },
        screen: { name: 'Screen 1' },
      },
    ]);
  });

  it('includes whole related rows next to every showtime column', async () => {
    const c = cinema();
    const soon = c.db.showtimes[2];
    if (!soon) throw new Error('no seed');
    await expect(
      c.db.spies.showtime.findUnique({ where: { id: soon.id }, include: { screen: true } }),
    ).resolves.toEqual({ ...soon, screen: c.screen2 });
    await expect(
      c.db.spies.showtime.findFirst({
        where: { id: soon.id },
        include: { movie: { select: { slug: true } }, screen: false },
      }),
    ).resolves.toEqual({ ...soon, movie: { slug: 'zorro' } });
    const created = await c.db.spies.showtime.create({
      data: { movieId: c.dune.id, screenId: c.screen1.id, startsAt: LATER },
      include: { movie: { select: { title: true } } },
    });
    expect(created).toMatchObject({ startsAt: LATER, movie: { title: 'Dune' } });
  });

  it('returns copies: mutating a returned relation leaves the tables alone', async () => {
    const c = cinema();
    const [row] = await c.db.spies.showtime.findMany({ take: 1, include: { movie: true } });
    (row?.['movie'] as { title: string }).title = 'Changed';
    (row?.['startsAt'] as Date).setUTCFullYear(1999);
    expect(c.db.movies[0]?.title).toBe('Dune');
    expect(c.db.showtimes[0]?.startsAt).toEqual(at('2026-11-01T03:30:00.000Z'));
  });

  it.each([
    ['distinct (group in JS instead)', { distinct: ['movieId'] }],
    ['select and include together', { select: { id: true }, include: { movie: true } }],
    ['include of an unknown relation', { include: { admin: true } }],
    ['include with a where', { include: { movie: { where: { isActive: true } } } }],
    ['a nested select of an unknown column', { select: { movie: { select: { name: true } } } }],
    ['orderBy a relation', { orderBy: { movie: { title: 'asc' } } }],
    ['cursor', { cursor: { id: 'x' } }],
  ])('findMany rejects %s', async (_name, args) => {
    const c = cinema();
    await expect(c.db.spies.showtime.findMany(args as never)).rejects.toBeInstanceOf(
      UnsupportedByFakeError,
    );
  });

  it('rejects include on models without it (screen, movie)', async () => {
    const c = cinema();
    await expect(c.db.spies.screen.findMany({ include: { showtimes: true } })).rejects.toThrow(
      /option "include"/,
    );
  });
});

// ---------------------------------------------------------------------------
// Movie delete cascades to showtimes
// ---------------------------------------------------------------------------

describe('inMemoryAuthDb: movie delete cascades to its showtimes', () => {
  it('movie.delete removes that movie’s showtimes (soft-deleted ones too) and no others', async () => {
    const c = cinema();
    await c.db.spies.movie.delete({ where: { id: c.dune.id } });
    expect(await names(c)).toEqual(['soon', 'hiddenShow', 'goneShow']);
    expect(c.db.movies.map((m) => m.slug)).toEqual(['zorro', 'hidden', 'gone']);
  });

  it('movie.deleteMany cascades for every deleted movie and reports the movie count', async () => {
    const c = cinema();
    await expect(
      c.db.spies.movie.deleteMany({ where: { deletedAt: { not: null } } }),
    ).resolves.toEqual({ count: 1 });
    expect(await names(c)).not.toContain('goneShow');
    expect(c.db.showtimes).toHaveLength(7);
  });

  it('a rolled-back movie delete restores the movie and its showtimes in place', async () => {
    const c = cinema();
    const before = c.db.showtimes.map((s) => s.id);
    const outcome = c.db.prisma.$transaction(async (tx) => {
      await tx.movie.delete({ where: { id: c.dune.id } });
      await tx.auditLog.create({
        data: { action: 'DELETE', entity: 'Movie', entityId: c.dune.id },
      });
      throw new Error('rolled back');
    });
    await expect(outcome).rejects.toThrow('rolled back');
    expect(c.db.showtimes.map((s) => s.id)).toEqual(before);
    expect(c.db.movies[0]?.id).toBe(c.dune.id);
    expect(c.db.auditLogs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('inMemoryAuthDb: settings', () => {
  const BASE = 'https://lk.bookmyshow.com/buytickets/sk-cinema-matara/cinema-snlk-SKCM-MT';

  it('findUnique by key returns the row or null; findMany filters by key in and orders', async () => {
    const db = inMemoryAuthDb({
      settings: [testSetting('showGapMinutes', '15'), testSetting('bmsBaseUrl', BASE)],
    });
    await expect(
      db.spies.setting.findUnique({ where: { key: 'bmsBaseUrl' }, select: { value: true } }),
    ).resolves.toEqual({ value: BASE });
    await expect(db.spies.setting.findUnique({ where: { key: 'nope' } })).resolves.toBeNull();
    await expect(
      db.spies.setting.findMany({
        where: { key: { in: ['bmsBaseUrl', 'showGapMinutes', 'other'] } },
        orderBy: { key: 'asc' },
        select: { key: true },
      }),
    ).resolves.toEqual([{ key: 'bmsBaseUrl' }, { key: 'showGapMinutes' }]);
  });

  it('upsert creates a missing setting with updatedAt now and no id column', async () => {
    const editor = testAdmin({ role: 'SUPER_ADMIN' });
    const db = inMemoryAuthDb({ admins: [editor] });
    await expect(
      db.spies.setting.upsert({
        where: { key: 'showGapMinutes' },
        create: { key: 'showGapMinutes', value: '20', updatedById: editor.id },
        update: { value: '20', updatedById: editor.id },
      }),
    ).resolves.toEqual({
      key: 'showGapMinutes',
      value: '20',
      updatedById: editor.id,
      updatedAt: NOW,
    });
    expect(db.settings).toEqual([
      { key: 'showGapMinutes', value: '20', updatedById: editor.id, updatedAt: NOW },
    ]);
  });

  it('upsert updates an existing setting and bumps updatedAt', async () => {
    const editor = testAdmin();
    const db = inMemoryAuthDb({ admins: [editor], settings: [testSetting('bmsBaseUrl', 'old')] });
    vi.setSystemTime(LATER);
    await expect(
      db.spies.setting.upsert({
        where: { key: 'bmsBaseUrl' },
        create: { key: 'bmsBaseUrl', value: BASE },
        update: { value: BASE, updatedById: editor.id },
        select: { value: true, updatedAt: true, updatedById: true },
      }),
    ).resolves.toEqual({ value: BASE, updatedAt: LATER, updatedById: editor.id });
    expect(db.settings).toHaveLength(1);
  });

  it('upsert and update reject an unknown updatedById with P2003 and write nothing', async () => {
    const db = inMemoryAuthDb({ settings: [testSetting('bmsBaseUrl', 'old')] });
    const error = await rejection(
      db.spies.setting.upsert({
        where: { key: 'showGapMinutes' },
        create: { key: 'showGapMinutes', value: '15', updatedById: MISSING_ID },
        update: { value: '15' },
      }),
    );
    expect(expectKnownError(error, 'P2003').message).toContain('`Setting_updatedById_fkey`');
    await expect(
      db.spies.setting.update({
        where: { key: 'bmsBaseUrl' },
        data: { value: 'x', updatedById: MISSING_ID },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(db.settings).toEqual([testSetting('bmsBaseUrl', 'old')]);
  });

  it('update writes and bumps updatedAt; a missing key rejects with P2025', async () => {
    const db = inMemoryAuthDb({ settings: [testSetting('showGapMinutes', '15')] });
    vi.setSystemTime(LATER);
    await expect(
      db.spies.setting.update({ where: { key: 'showGapMinutes' }, data: { value: '0' } }),
    ).resolves.toEqual({ key: 'showGapMinutes', value: '0', updatedById: null, updatedAt: LATER });
    await expect(
      db.spies.setting.update({ where: { key: 'bmsBaseUrl' }, data: { value: 'x' } }),
    ).rejects.toMatchObject({ code: 'P2025' });
  });

  it('accepts only key as a unique where, and upsert validates create like create', async () => {
    const db = inMemoryAuthDb({ settings: [testSetting('showGapMinutes', '15')] });
    await expect(db.spies.setting.findUnique({ where: { value: '15' } })).rejects.toThrow(
      /without a unique column \(key\)/,
    );
    await expect(
      db.spies.setting.upsert({ where: { key: 'k' }, create: { key: 'k' }, update: {} }),
    ).rejects.toThrow(/missing required value/);
  });
});

// ---------------------------------------------------------------------------
// auditLog.createMany
// ---------------------------------------------------------------------------

describe('inMemoryAuthDb: auditLog.createMany', () => {
  it('writes one row per entry, sharing a batch id in details, and returns { count }', async () => {
    const editor = testAdmin();
    const db = inMemoryAuthDb({ admins: [editor] });
    const batchId = '0190b6c4-0000-7000-8000-000000000001';
    const entityIds = ['a', 'b', 'c'];
    await expect(
      db.spies.auditLog.createMany({
        data: entityIds.map((entityId) => ({
          adminId: editor.id,
          action: 'CREATE',
          entity: 'Showtime',
          entityId,
          details: { batchId },
        })),
      }),
    ).resolves.toEqual({ count: 3 });
    expect(db.auditLogs.map((a) => [a.entityId, a.details, a.createdAt])).toEqual(
      entityIds.map((id) => [id, { batchId }, NOW]),
    );
  });

  it('is all-or-nothing: an invalid action or unknown admin writes no row', async () => {
    const db = inMemoryAuthDb();
    await expect(
      db.spies.auditLog.createMany({
        data: [
          { action: 'CREATE', entity: 'Showtime' },
          { action: 'CREATED', entity: 'Showtime' },
        ],
      }),
    ).rejects.toThrow(/not a valid auditLog\.action/);
    await expect(
      db.spies.auditLog.createMany({
        data: [
          { action: 'CREATE', entity: 'Showtime' },
          { action: 'CREATE', entity: 'Showtime', adminId: MISSING_ID },
        ],
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(db.auditLogs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Row locks through tx.$queryRaw
// ---------------------------------------------------------------------------

describe('inMemoryAuthDb: row-lock $queryRaw', () => {
  it('exports the exact lock statements T8 must send', () => {
    expect(LOCK_SQL).toEqual({
      Movie: 'SELECT "id" FROM "Movie" WHERE "id" = $1::uuid FOR UPDATE',
      Screen: 'SELECT "id" FROM "Screen" WHERE "id" = $1::uuid FOR UPDATE',
    });
  });

  it('locks movie then screens in a transaction, returning [{ id }] or [] and recording the order', async () => {
    const c = cinema();
    const results: unknown[] = [];
    await c.db.prisma.$transaction(async (tx) => {
      results.push(
        await tx.$queryRaw`SELECT "id" FROM "Movie" WHERE "id" = ${c.dune.id}::uuid FOR UPDATE`,
      );
      for (const id of [c.screen1.id, c.screen2.id].sort()) {
        results.push(
          await tx.$queryRaw`
          SELECT "id"
          FROM "Screen"
          WHERE "id" = ${id}::uuid
          FOR UPDATE`,
        );
      }
      results.push(
        await tx.$queryRaw`SELECT "id" FROM "Screen" WHERE "id" = ${MISSING_ID}::uuid FOR UPDATE`,
      );
    });
    const [first, second] = [c.screen1.id, c.screen2.id].sort();
    expect(results).toEqual([[{ id: c.dune.id }], [{ id: first }], [{ id: second }], []]);
    expect(c.db.locks).toEqual([
      { table: 'Movie', id: c.dune.id },
      { table: 'Screen', id: first },
      { table: 'Screen', id: second },
      { table: 'Screen', id: MISSING_ID },
    ]);
    expect(c.db.spies.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it('finds soft-deleted rows too: the service decides what a deleted row means', async () => {
    const c = cinema();
    await c.db.prisma.$transaction(async (tx) => {
      await expect(
        tx.$queryRaw`SELECT "id" FROM "Movie" WHERE "id" = ${c.gone.id}::uuid FOR UPDATE`,
      ).resolves.toEqual([{ id: c.gone.id }]);
      await expect(
        tx.$queryRaw`SELECT "id" FROM "Screen" WHERE "id" = ${c.closed.id}::uuid FOR UPDATE`,
      ).resolves.toEqual([{ id: c.closed.id }]);
    });
  });

  it('rejects a lock outside a transaction (it would lock nothing) and keeps SELECT 1 for health', async () => {
    const c = cinema();
    await expect(
      c.db.prisma.$queryRaw`SELECT "id" FROM "Movie" WHERE "id" = ${c.dune.id}::uuid FOR UPDATE`,
    ).rejects.toThrow(/outside an interactive transaction/);
    await expect(c.db.prisma.$queryRaw`SELECT 1`).resolves.toEqual([{ ok: 1 }]);
    expect(c.db.locks).toEqual([]);
  });

  it.each([
    ['other SQL', (tx: Prisma.TransactionClient) => tx.$queryRaw`SELECT * FROM "Showtime"`],
    [
      'a lock without ::uuid',
      (tx: Prisma.TransactionClient) =>
        tx.$queryRaw`SELECT "id" FROM "Movie" WHERE "id" = ${MISSING_ID} FOR UPDATE`,
    ],
    [
      'a lock on another table',
      (tx: Prisma.TransactionClient) =>
        tx.$queryRaw`SELECT "id" FROM "Showtime" WHERE "id" = ${MISSING_ID}::uuid FOR UPDATE`,
    ],
    [
      'a lock with an id that is not a UUID',
      (tx: Prisma.TransactionClient) =>
        tx.$queryRaw`SELECT "id" FROM "Movie" WHERE "id" = ${'dune'}::uuid FOR UPDATE`,
    ],
    [
      'Prisma.sql instead of a tagged template',
      (tx: Prisma.TransactionClient) =>
        tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "Movie" WHERE "id" = ${MISSING_ID}::uuid FOR UPDATE`,
        ),
    ],
    ['SELECT 1 inside a transaction', (tx: Prisma.TransactionClient) => tx.$queryRaw`SELECT 1`],
    [
      '$queryRawUnsafe',
      (tx: Prisma.TransactionClient) => tx.$queryRawUnsafe('SELECT "id" FROM "Movie"'),
    ],
    [
      '$executeRaw',
      (tx: Prisma.TransactionClient) => tx.$executeRaw`UPDATE "Movie" SET "title" = 'x'`,
    ],
    [
      '$executeRawUnsafe',
      (tx: Prisma.TransactionClient) => tx.$executeRawUnsafe('DELETE FROM "Movie"'),
    ],
  ])('rejects %s inside a transaction, and rolls back', async (_name, call) => {
    const c = cinema();
    await expect(
      c.db.prisma.$transaction(async (tx) => {
        await tx.screen.update({ where: { id: c.screen1.id }, data: { capacity: 1 } });
        await call(tx);
      }),
    ).rejects.toBeInstanceOf(UnsupportedByFakeError);
    expect(c.db.screens[0]?.capacity).toBe(300);
    expect(c.db.locks).toEqual([]);
  });

  it('rejects raw SQL other than SELECT 1 on the root client', async () => {
    const c = cinema();
    await expect(c.db.prisma.$queryRaw`SELECT now()`).rejects.toBeInstanceOf(
      UnsupportedByFakeError,
    );
    await expect(c.db.prisma.$executeRawUnsafe('TRUNCATE "Movie"')).rejects.toBeInstanceOf(
      UnsupportedByFakeError,
    );
  });

  it('injectFault on $queryRaw lock fails that lock (not recorded) and the transaction rolls back', async () => {
    const c = cinema();
    const boom = new Error('lock timeout');
    c.db.injectFault('$queryRaw', 'lock', { onCall: 2, error: boom });
    const outcome = c.db.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Movie" WHERE "id" = ${c.dune.id}::uuid FOR UPDATE`;
      await tx.showtime.create({
        data: { movieId: c.dune.id, screenId: c.screen1.id, startsAt: LATER },
      });
      await tx.$queryRaw`SELECT "id" FROM "Screen" WHERE "id" = ${c.screen1.id}::uuid FOR UPDATE`;
    });
    await expect(outcome).rejects.toBe(boom);
    expect(c.db.locks).toEqual([{ table: 'Movie', id: c.dune.id }]);
    expect(c.db.showtimes).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// Fault injection on the new models
// ---------------------------------------------------------------------------

describe('inMemoryAuthDb: fault injection on screens, showtimes and settings', () => {
  it('simulates a concurrent screen insert: the name is free on read, taken on insert', async () => {
    const db = inMemoryAuthDb();
    db.injectFault('screen', 'create', {
      before: () => {
        db.addScreen({ name: 'Screen 1' });
      },
    });
    await expect(db.spies.screen.count({ where: { name: 'Screen 1' } })).resolves.toBe(0);
    const error = await rejection(db.spies.screen.create({ data: { name: 'Screen 1' } }));
    expect(expectKnownError(error, 'P2002').message).toContain('`Screen_name_key`');
    expect(db.screens).toHaveLength(1);
  });

  it('simulates a concurrent showtime insert before createMany (overlap race)', async () => {
    const c = cinema();
    c.db.injectFault('showtime', 'createMany', {
      before: () => {
        c.db.addShowtime({ movieId: c.zorro.id, screenId: c.screen2.id, startsAt: LATER });
      },
    });
    await c.db.spies.showtime.createMany({
      data: [{ movieId: c.dune.id, screenId: c.screen2.id, startsAt: LATER }],
    });
    expect(
      await c.db.spies.showtime.count({ where: { screenId: c.screen2.id, startsAt: LATER } }),
    ).toBe(3);
  });

  it.each([
    ['showtime', 'createMany'],
    ['showtime', 'update'],
    ['showtime', 'updateMany'],
    ['showtime', 'deleteMany'],
    ['showtime', 'findMany'],
    ['showtime', 'count'],
    ['screen', 'updateMany'],
    ['setting', 'upsert'],
    ['auditLog', 'createMany'],
  ] as const)(
    'fails the next %s.%s with the injected error, writing nothing',
    async (model, op) => {
      const c = cinema();
      c.db.addSetting({ key: 'showGapMinutes', value: '15' });
      const before = JSON.stringify([c.db.showtimes, c.db.screens, c.db.settings, c.db.auditLogs]);
      const boom = new Error('injected');
      c.db.injectFault(model, op, { error: boom });
      const soon = c.db.showtimes[2]?.id ?? '';
      const calls: Record<string, () => Promise<unknown>> = {
        'showtime.createMany': () =>
          c.db.spies.showtime.createMany({
            data: [{ movieId: c.dune.id, screenId: c.screen1.id, startsAt: LATER }],
          }),
        'showtime.update': () =>
          c.db.spies.showtime.update({ where: { id: soon }, data: { format: '3D' } }),
        'showtime.updateMany': () =>
          c.db.spies.showtime.updateMany({ where: {}, data: { format: '3D' } }),
        'showtime.deleteMany': () => c.db.spies.showtime.deleteMany({}),
        'showtime.findMany': () => c.db.spies.showtime.findMany(undefined),
        'showtime.count': () => c.db.spies.showtime.count(undefined),
        'screen.updateMany': () =>
          c.db.spies.screen.updateMany({ where: {}, data: { isActive: false } }),
        'setting.upsert': () =>
          c.db.spies.setting.upsert({
            where: { key: 'showGapMinutes' },
            create: { key: 'showGapMinutes', value: '30' },
            update: { value: '30' },
          }),
        'auditLog.createMany': () =>
          c.db.spies.auditLog.createMany({ data: [{ action: 'CREATE', entity: 'Showtime' }] }),
      };
      const call = calls[`${model}.${op}`];
      if (!call) throw new Error(`no call for ${model}.${op}`);
      await expect(call()).rejects.toBe(boom);
      expect(JSON.stringify([c.db.showtimes, c.db.screens, c.db.settings, c.db.auditLogs])).toBe(
        before,
      );
    },
  );

  it('rejects a fault on an operation a new model lacks, or a $queryRaw fault other than lock', () => {
    const db = inMemoryAuthDb();
    const error = new Error('x');
    expect(() => {
      db.injectFault('screen', 'deleteMany' as never, { error });
    }).toThrow(/not modelled/);
    expect(() => {
      db.injectFault('setting', 'delete' as never, { error });
    }).toThrow(/not modelled/);
    expect(() => {
      db.injectFault('$queryRaw', 'select' as never, { error });
    }).toThrow(/not modelled/);
  });
});
