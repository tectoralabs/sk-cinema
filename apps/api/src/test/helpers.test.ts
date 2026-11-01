/**
 * Tests for the in-memory Prisma fake itself (inMemoryAuthDb). The auth tests trust it to
 * answer like Postgres for the queries the services make, to refuse anything else loudly, and
 * to roll back exactly a transaction's own writes.
 */
import { randomUUID } from 'node:crypto';
import { movieIdParamsSchema } from '@sk-cinema/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import { verifyPassword } from '../lib/password.js';
import {
  UnsupportedByFakeError,
  inMemoryAuthDb,
  recordNotFoundError,
  testAdmin,
  testMovie,
  testPasswordHash,
  testRefreshToken,
  testUuidV7,
  uniqueConstraintError,
  type InMemoryAuthDb,
  type MovieSeed,
} from './helpers.js';

// Fixed instants: nothing here reads the clock to decide a match.
const T0 = new Date('2026-10-30T04:30:00.000Z');
const LATER = new Date('2026-11-06T04:30:00.000Z');
const FAMILY = randomUUID();

function seeded() {
  const admin = testAdmin({ email: 'editor@skcinema.lk', failedLoginCount: 2 });
  const other = testAdmin({ email: 'other@skcinema.lk', failedLoginCount: 4, lockedUntil: T0 });
  const live = testRefreshToken({ adminId: admin.id, familyId: FAMILY, expiresAt: LATER });
  const revoked = testRefreshToken({
    adminId: admin.id,
    familyId: FAMILY,
    expiresAt: LATER,
    revokedAt: T0,
  });
  const expired = testRefreshToken({ adminId: admin.id, familyId: FAMILY, expiresAt: T0 });
  const otherFamily = testRefreshToken({ adminId: admin.id, expiresAt: LATER });
  const othersToken = testRefreshToken({ adminId: other.id, familyId: FAMILY, expiresAt: LATER });
  const db = inMemoryAuthDb({
    admins: [admin, other],
    refreshTokens: [live, revoked, expired, otherFamily, othersToken],
  });
  return { db, admin, other, live, revoked, expired, otherFamily, othersToken };
}

function adminById(db: InMemoryAuthDb, id: string) {
  const row = db.admins.find((r) => r.id === id);
  if (!row) throw new Error(`no admin ${id}`);
  return row;
}

function tokenById(db: InMemoryAuthDb, id: string) {
  const row = db.refreshTokens.find((r) => r.id === id);
  if (!row) throw new Error(`no refresh token ${id}`);
  return row;
}

/** A promise the test settles by hand, to hold a transaction open. */
function gate() {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

class Boom extends Error {}

describe('inMemoryAuthDb: unsupported Prisma features fail loudly', () => {
  const OPERATORS = ['not', 'in', 'notIn', 'contains', 'startsWith', 'endsWith', 'mode', 'equals'];
  const COLUMNS = [
    ['a Date column', 'lockedUntil'],
    ['a string column', 'email'],
    ['a number column', 'failedLoginCount'],
  ] as const;

  it.each(OPERATORS.flatMap((op) => COLUMNS.map(([kind, column]) => [op, kind, column])))(
    'rejects the "%s" operator on %s, and writes nothing',
    async (operator, _kind, column) => {
      const { db, admin } = seeded();

      await expect(
        db.spies.admin.updateMany({
          where: { [column]: { [operator]: 'x' } },
          data: { failedLoginCount: 0 },
        }),
      ).rejects.toThrow(new RegExp(`operator "${operator}" on ${column}`));
      await expect(
        db.spies.admin.findUnique({ where: { id: admin.id, [column]: { [operator]: 'x' } } }),
      ).rejects.toBeInstanceOf(UnsupportedByFakeError);
      expect(adminById(db, admin.id).failedLoginCount).toBe(2);
    },
  );

  it.each([
    ['OR', { OR: [{ email: 'editor@skcinema.lk' }] }],
    ['AND', { AND: [{ email: 'editor@skcinema.lk' }] }],
    ['NOT', { NOT: { email: 'editor@skcinema.lk' } }],
    ['a to-many relation filter', { refreshTokens: { some: { revokedAt: null } } }],
    ['an unknown column', { emial: 'editor@skcinema.lk' }],
  ])('rejects %s as a where key', async (_name, where) => {
    const { db } = seeded();
    await expect(
      db.spies.admin.updateMany({ where, data: { failedLoginCount: 0 } }),
    ).rejects.toBeInstanceOf(UnsupportedByFakeError);
  });

  it('rejects a to-one relation filter on refresh tokens', async () => {
    const { db } = seeded();
    await expect(
      db.spies.refreshToken.updateMany({
        where: { admin: { is: { isActive: true } } },
        data: { revokedAt: T0 },
      }),
    ).rejects.toThrow(/where key "admin"/);
  });

  it.each([
    ['an undefined value', { email: undefined }],
    ['an array value', { email: ['editor@skcinema.lk'] }],
    ['an empty filter object', { lockedUntil: {} }],
    ['a string range bound', { lockedUntil: { lt: '2026-10-30' } }],
  ])('rejects %s in a where', async (_name, where) => {
    const { db } = seeded();
    await expect(
      db.spies.admin.updateMany({ where, data: { failedLoginCount: 0 } }),
    ).rejects.toBeInstanceOf(UnsupportedByFakeError);
  });

  it('rejects a range bound of a different type than the column', async () => {
    const { db } = seeded();
    await expect(
      db.spies.admin.updateMany({ where: { lockedUntil: { lt: 5 } }, data: { name: 'x' } }),
    ).rejects.toThrow(/different types/);
  });

  it.each([
    [
      'findUnique with include',
      (db: InMemoryAuthDb, id: string) =>
        db.spies.admin.findUnique({ where: { id }, include: { refreshTokens: true } } as never),
    ],
    [
      'findUnique with omit',
      (db: InMemoryAuthDb, id: string) =>
        db.spies.admin.findUnique({ where: { id }, omit: { passwordHash: true } } as never),
    ],
    [
      'updateMany with limit',
      (db: InMemoryAuthDb, id: string) =>
        db.spies.admin.updateMany({ where: { id }, data: { name: 'x' }, limit: 1 } as never),
    ],
    [
      'updateManyAndReturn with orderBy',
      (db: InMemoryAuthDb, id: string) =>
        db.spies.admin.updateManyAndReturn({
          where: { id },
          data: { name: 'x' },
          orderBy: { email: 'asc' },
        } as never),
    ],
    [
      'update with include',
      (db: InMemoryAuthDb, id: string) =>
        db.spies.admin.update({ where: { id }, data: { name: 'x' }, include: {} } as never),
    ],
    [
      'create with skip',
      (db: InMemoryAuthDb, id: string) =>
        db.spies.auditLog.create({
          data: { action: 'LOGIN', entity: 'Admin', adminId: id },
          skip: 1,
        } as never),
    ],
    [
      'create with distinct',
      (db: InMemoryAuthDb, id: string) =>
        db.spies.refreshToken.create({
          data: { adminId: id, tokenHash: 'h', familyId: FAMILY, expiresAt: LATER },
          distinct: ['id'],
        } as never),
    ],
  ])('rejects %s instead of ignoring it', async (_name, call) => {
    const { db, admin } = seeded();
    await expect(call(db, admin.id)).rejects.toThrow(/option "\w+"/);
    expect(db.auditLogs).toHaveLength(0);
    expect(db.refreshTokens).toHaveLength(5);
    expect(adminById(db, admin.id).name).toBe(admin.name);
  });

  it.each([
    ['an unknown select key', { nickname: true }],
    ['a non-boolean column select', { id: 'yes' }],
    ['a to-many relation', { refreshTokens: true }],
    ['_count of an unsupported relation', { _count: { select: { auditLogs: true } } }],
    ['_count with an unsupported option', { _count: { select: { refreshTokens: { take: 1 } } } }],
    [
      '_count with an unsupported operator',
      { _count: { select: { refreshTokens: { where: { familyId: { in: [FAMILY] } } } } } },
    ],
  ])('rejects %s in admin.findUnique select', async (_name, select) => {
    const { db, admin } = seeded();
    await expect(
      db.spies.admin.findUnique({ where: { id: admin.id }, select }),
    ).rejects.toBeInstanceOf(UnsupportedByFakeError);
  });

  it('rejects _count outside admin.findUnique, and a nested relation select with a where', async () => {
    const { db, admin, live } = seeded();
    await expect(
      db.spies.admin.update({
        where: { id: admin.id },
        data: { name: 'x' },
        select: { _count: { select: { refreshTokens: true } } },
      }),
    ).rejects.toBeInstanceOf(UnsupportedByFakeError);
    await expect(
      db.spies.refreshToken.findUnique({
        where: { id: live.id },
        select: { admin: { select: { id: true }, where: { isActive: true } } },
      }),
    ).rejects.toThrow(/option "where"/);
    expect(adminById(db, admin.id).name).toBe(admin.name);
  });

  it.each([
    ['decrement', { failedLoginCount: { decrement: 1 } }],
    ['set', { failedLoginCount: { set: 0 } }],
    ['multiply', { failedLoginCount: { multiply: 2 } }],
    ['an unknown column', { failedLogins: 0 }],
    ['a nested relation write', { refreshTokens: { create: [] } }],
    ['an undefined value', { lockedUntil: undefined }],
  ])('rejects %s in update data', async (_name, data) => {
    const { db, admin } = seeded();
    await expect(
      db.spies.admin.updateMany({ where: { id: admin.id }, data }),
    ).rejects.toBeInstanceOf(UnsupportedByFakeError);
    expect(adminById(db, admin.id).failedLoginCount).toBe(2);
  });

  it('rejects increment in create data', async () => {
    const { db, admin } = seeded();
    await expect(
      db.spies.refreshToken.create({
        data: {
          adminId: admin.id,
          tokenHash: 'h',
          familyId: FAMILY,
          expiresAt: { increment: 1 },
        },
      }),
    ).rejects.toBeInstanceOf(UnsupportedByFakeError);
  });

  it('rejects findUnique and update that do not name a unique column', async () => {
    const { db } = seeded();
    await expect(db.spies.refreshToken.findUnique({ where: { familyId: FAMILY } })).rejects.toThrow(
      /without a unique column/,
    );
    await expect(
      db.spies.admin.update({ where: { name: 'Test Editor' }, data: { name: 'x' } }),
    ).rejects.toThrow(/without a unique column/);
    await expect(db.spies.admin.findUnique({ where: { id: { gt: 0 } } })).rejects.toThrow(
      /without a unique column/,
    );
  });

  it('rejects batch transactions and transaction options', async () => {
    const { db } = seeded();
    await expect(db.spies.$transaction([])).rejects.toBeInstanceOf(UnsupportedByFakeError);
    await expect(
      db.spies.$transaction(() => Promise.resolve(), { isolationLevel: 'Serializable' }),
    ).rejects.toBeInstanceOf(UnsupportedByFakeError);
  });

  it('gives transaction clients no $transaction, so nesting cannot happen silently', async () => {
    const { db } = seeded();
    await db.prisma.$transaction((tx) => {
      expect('$transaction' in tx).toBe(false);
      return Promise.resolve();
    });
  });
});

describe('inMemoryAuthDb: queries', () => {
  it('matches Dates by time, null as IS NULL, and ranges like SQL (NULL never in range)', async () => {
    const { db, admin, other } = seeded();
    const ids = async (where: Record<string, unknown>) =>
      (
        await db.spies.admin.updateManyAndReturn({
          where,
          data: {},
          select: { id: true },
        })
      ).map((r) => r['id']);

    expect(await ids({ lockedUntil: new Date(T0.getTime()) })).toEqual([other.id]);
    expect(await ids({ lockedUntil: null })).toEqual([admin.id]);
    expect(await ids({ lockedUntil: { lte: T0 } })).toEqual([other.id]);
    expect(await ids({ lockedUntil: { lt: T0 } })).toEqual([]);
    expect(await ids({ lockedUntil: { gt: new Date(0) } })).toEqual([other.id]);
    expect(await ids({ failedLoginCount: { gte: 2, lt: 4 } })).toEqual([admin.id]);
    expect(await ids({ failedLoginCount: { gt: 2 }, email: 'other@skcinema.lk' })).toEqual([
      other.id,
    ]);
  });

  it('updateMany writes exactly the matching rows and reports their count', async () => {
    const { db, live, revoked, expired, otherFamily, othersToken } = seeded();

    const result = await db.spies.refreshToken.updateMany({
      where: { familyId: FAMILY, revokedAt: null, expiresAt: { gt: T0 } },
      data: { revokedAt: LATER },
    });

    expect(result).toEqual({ count: 2 });
    expect(tokenById(db, live.id)).toMatchObject({ revokedAt: LATER });
    expect(tokenById(db, othersToken.id)).toMatchObject({ revokedAt: LATER });
    expect(tokenById(db, revoked.id)).toMatchObject({ revokedAt: T0 });
    expect(tokenById(db, expired.id)).toMatchObject({ revokedAt: null });
    expect(tokenById(db, otherFamily.id)).toMatchObject({ revokedAt: null });

    await expect(
      db.spies.refreshToken.updateMany({ where: { id: randomUUID() }, data: { revokedAt: T0 } }),
    ).resolves.toEqual({ count: 0 });
  });

  it('updateManyAndReturn increments, returns only the matched rows after the write, projected', async () => {
    const { db, admin, other } = seeded();

    const rows = await db.spies.admin.updateManyAndReturn({
      where: { lockedUntil: null, failedLoginCount: { lt: 5 } },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });

    expect(rows).toEqual([{ failedLoginCount: 3 }]);
    expect(adminById(db, admin.id).failedLoginCount).toBe(3);
    expect(adminById(db, other.id).failedLoginCount).toBe(4);

    await expect(
      db.spies.admin.updateManyAndReturn({
        where: { id: admin.id, failedLoginCount: { gte: 5 } },
        data: { lockedUntil: LATER },
        select: { failedLoginCount: true },
      }),
    ).resolves.toEqual([]);
    expect(adminById(db, admin.id).lockedUntil).toBeNull();
  });

  it('counts _count with a where over the admin’s own refresh tokens only', async () => {
    const { db, admin, other } = seeded();
    const liveCount = (adminId: string, now: Date) =>
      db.spies.admin.findUnique({
        where: { id: adminId },
        select: {
          id: true,
          _count: {
            select: {
              refreshTokens: {
                where: { adminId, familyId: FAMILY, revokedAt: null, expiresAt: { gt: now } },
              },
            },
          },
        },
      });

    // Of the admin's 4 tokens, 3 are in FAMILY, and only `live` is unrevoked and unexpired.
    await expect(liveCount(admin.id, T0)).resolves.toEqual({
      id: admin.id,
      _count: { refreshTokens: 1 },
    });
    await expect(liveCount(admin.id, LATER)).resolves.toEqual({
      id: admin.id,
      _count: { refreshTokens: 0 },
    });
    // `othersToken` shares FAMILY but belongs to the other admin.
    await expect(liveCount(other.id, T0)).resolves.toEqual({
      id: other.id,
      _count: { refreshTokens: 1 },
    });
    await expect(
      db.spies.admin.findUnique({
        where: { id: admin.id },
        select: { _count: { select: { refreshTokens: true } } },
      }),
    ).resolves.toEqual({ _count: { refreshTokens: 4 } });
  });

  it('projects select, including a to-one relation select', async () => {
    const { db, admin, live } = seeded();
    await expect(
      db.spies.refreshToken.findUnique({
        where: { tokenHash: live.tokenHash },
        select: { id: true, revokedAt: true, tokenHash: false, admin: { select: { email: true } } },
      }),
    ).resolves.toEqual({ id: live.id, revokedAt: null, admin: { email: admin.email } });
    await expect(
      db.spies.refreshToken.findUnique({ where: { tokenHash: 'nope' } }),
    ).resolves.toBeNull();
  });

  it('create enforces unique tokenHash (P2002) and the adminId foreign key (P2003)', async () => {
    const { db, admin, live } = seeded();
    const data = {
      adminId: admin.id,
      tokenHash: live.tokenHash,
      familyId: FAMILY,
      expiresAt: LATER,
    };

    await expect(db.spies.refreshToken.create({ data })).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      db.spies.refreshToken.create({ data: { ...data, tokenHash: 'h', adminId: randomUUID() } }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(db.refreshTokens).toHaveLength(5);

    await expect(
      db.spies.refreshToken.create({ data: { ...data, tokenHash: 'h' }, select: { id: true } }),
    ).resolves.toEqual({ id: expect.any(String) as unknown });
    expect(db.refreshTokens).toHaveLength(6);
  });

  it('update of a missing row rejects with P2025 and writes nothing', async () => {
    const { db } = seeded();
    await expect(
      db.spies.refreshToken.update({ where: { id: randomUUID() }, data: { revokedAt: T0 } }),
    ).rejects.toMatchObject({ code: 'P2025' });
  });
});

describe('inMemoryAuthDb: transactions', () => {
  it('commits every write when the callback returns', async () => {
    const { db, admin, live } = seeded();

    await db.prisma.$transaction(async (tx) => {
      await tx.refreshToken.update({ where: { id: live.id }, data: { revokedAt: T0 } });
      await tx.auditLog.create({ data: { action: 'LOGOUT', entity: 'Admin', adminId: admin.id } });
    });

    expect(tokenById(db, live.id).revokedAt).toEqual(T0);
    expect(db.auditLogs.map((a) => a.action)).toEqual(['LOGOUT']);
  });

  it('rolls back only its own writes, in reverse order, keeps row identity and rethrows', async () => {
    const { db, admin, live } = seeded();
    const adminRow = adminById(db, admin.id);
    const boom = new Boom('fail after writes');
    let created = '';

    const outcome = db.prisma.$transaction(async (tx) => {
      const child = await tx.refreshToken.create({
        data: { adminId: admin.id, tokenHash: 'child', familyId: FAMILY, expiresAt: LATER },
        select: { id: true },
      });
      created = child.id;
      // Two writes to one column, so the undo order matters.
      await tx.admin.update({
        where: { id: admin.id },
        data: { failedLoginCount: { increment: 1 } },
      });
      await tx.admin.update({
        where: { id: admin.id },
        data: { failedLoginCount: 0, lockedUntil: T0 },
      });
      await tx.refreshToken.update({
        where: { id: live.id },
        data: { revokedAt: T0, replacedById: child.id },
      });
      await tx.auditLog.create({ data: { action: 'LOGIN', entity: 'Admin', adminId: admin.id } });
      throw boom;
    });

    await expect(outcome).rejects.toBe(boom);
    expect(created).not.toBe('');
    expect(db.refreshTokens.some((t) => t.id === created)).toBe(false);
    expect(db.refreshTokens).toHaveLength(5);
    expect(tokenById(db, live.id)).toMatchObject({ revokedAt: null, replacedById: null });
    expect(db.admins[0]).toBe(adminRow);
    expect(adminRow).toMatchObject({ failedLoginCount: 2, lockedUntil: null });
    expect(adminRow.updatedAt).toBe(admin.updatedAt);
    expect(db.auditLogs).toHaveLength(0);
  });

  it('keeps writes made outside the transaction while it was awaiting, then rolls back its own', async () => {
    const { db, admin, other, live } = seeded();
    const hold = gate();
    const inside = gate();

    const outcome = db.prisma.$transaction(async (tx) => {
      await tx.refreshToken.update({ where: { id: live.id }, data: { revokedAt: T0 } });
      await tx.auditLog.create({ data: { action: 'LOGOUT', entity: 'Admin', adminId: admin.id } });
      inside.open();
      await hold.promise;
      throw new Boom('late failure');
    });
    await inside.promise;

    // Outside the transaction, while it is open: another row, another column of the same
    // admin, a new token and an audit row.
    await db.prisma.admin.update({ where: { id: other.id }, data: { failedLoginCount: 0 } });
    await db.prisma.admin.update({ where: { id: admin.id }, data: { name: 'Renamed' } });
    await db.prisma.auditLog.create({
      data: { action: 'LOGIN_FAILED', entity: 'Admin', adminId: admin.id },
    });
    const outsideToken = await db.prisma.refreshToken.create({
      data: { adminId: admin.id, tokenHash: 'outside', familyId: FAMILY, expiresAt: LATER },
      select: { id: true },
    });
    hold.open();

    await expect(outcome).rejects.toBeInstanceOf(Boom);
    expect(tokenById(db, live.id).revokedAt).toBeNull();
    expect(db.auditLogs.map((a) => a.action)).toEqual(['LOGIN_FAILED']);
    expect(adminById(db, other.id).failedLoginCount).toBe(0);
    expect(adminById(db, admin.id).name).toBe('Renamed');
    expect(db.refreshTokens.map((t) => t.id)).toContain(outsideToken.id);
  });

  it('does not undo writes made through the root client inside the callback', async () => {
    const { db, live } = seeded();

    await expect(
      db.prisma.$transaction(async () => {
        await db.prisma.refreshToken.update({ where: { id: live.id }, data: { revokedAt: T0 } });
        throw new Boom('rolled back');
      }),
    ).rejects.toBeInstanceOf(Boom);

    // Only writes through `tx` are part of the transaction, as with Prisma.
    expect(tokenById(db, live.id).revokedAt).toEqual(T0);
  });

  it('refuses to roll back a column that a writer outside changed meanwhile', async () => {
    const { db, admin } = seeded();
    const hold = gate();
    const inside = gate();

    const outcome = db.prisma.$transaction(async (tx) => {
      await tx.admin.update({ where: { id: admin.id }, data: { failedLoginCount: 0 } });
      inside.open();
      await hold.promise;
      throw new Boom('late failure');
    });
    await inside.promise;
    await db.prisma.admin.update({ where: { id: admin.id }, data: { failedLoginCount: 9 } });
    hold.open();

    await expect(outcome).rejects.toThrow(/cannot roll back admin\.failedLoginCount/);
  });

  it('runs transactions one at a time, in call order', async () => {
    const { db } = seeded();
    const events: string[] = [];
    const hold = gate();
    const started = gate();

    const first = db.prisma.$transaction(async () => {
      events.push('first:start');
      started.open();
      await hold.promise;
      events.push('first:end');
    });
    const second = db.prisma.$transaction(() => {
      events.push('second:start');
      return Promise.resolve();
    });
    await started.promise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(['first:start']);

    hold.open();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('still runs the next transaction after one rolls back', async () => {
    const { db, live } = seeded();
    const failed = db.prisma.$transaction(() => Promise.reject(new Boom('first fails')));
    const next = db.prisma.$transaction(async (tx) => {
      await tx.refreshToken.update({ where: { id: live.id }, data: { revokedAt: T0 } });
    });

    await expect(failed).rejects.toBeInstanceOf(Boom);
    await next;
    expect(tokenById(db, live.id).revokedAt).toEqual(T0);
  });

  it('rejects a transaction client used after its transaction ended', async () => {
    const { db, live } = seeded();
    let leaked: Prisma.TransactionClient | undefined;
    await db.prisma.$transaction((tx) => {
      leaked = tx;
      return Promise.resolve();
    });
    if (!leaked) throw new Error('no client');

    await expect(
      leaked.refreshToken.update({ where: { id: live.id }, data: { revokedAt: T0 } }),
    ).rejects.toThrow(/after the end/);
    expect(tokenById(db, live.id).revokedAt).toBeNull();
  });

  it('records transaction calls on the same spies as root calls', async () => {
    const { db, live } = seeded();
    await db.prisma.$transaction(async (tx) => {
      await tx.refreshToken.updateMany({ where: { id: live.id }, data: { revokedAt: T0 } });
    });
    expect(db.spies.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { id: live.id },
      data: { revokedAt: T0 },
    });
  });
});

// ---------------------------------------------------------------------------
// Movies
// ---------------------------------------------------------------------------

/** The fake's clock for the movie tests. Only Date is faked, so promises run normally. */
const NOW = new Date('2026-10-31T06:30:00.000Z');
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type MovieDelegate = InMemoryAuthDb['spies']['movie'];
type FindManyArgs = NonNullable<Parameters<MovieDelegate['findMany']>[0]>;
type Where = NonNullable<FindManyArgs['where']>;

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/**
 * Five movies covering the filters: mixed case titles, `%` and `_` in titles, NULL and set
 * release dates, every status, one hidden and one soft-deleted. Inserted in this order.
 */
function catalogue() {
  const movies = [
    testMovie({
      slug: 'dune-part-two',
      title: 'Dune: Part Two',
      status: 'NOW_SHOWING',
      releaseDate: day('2026-03-01'),
      genres: ['Sci-Fi'],
    }),
    testMovie({ slug: 'avatar', title: 'avatar', isActive: false }),
    testMovie({
      slug: 'ape-100-percent',
      title: '100% Ape',
      status: 'ENDED',
      releaseDate: day('2025-12-01'),
      deletedAt: T0,
    }),
    testMovie({
      slug: 'bad-boys',
      title: 'Bad_Boys',
      status: 'NOW_SHOWING',
      releaseDate: day('2026-01-15'),
    }),
    testMovie({ slug: 'zorro', title: 'Zorro' }),
  ];
  return { db: inMemoryAuthDb({ movies }), movies };
}

/** Slugs of the rows a movie.findMany returns, in order. */
async function slugs(db: InMemoryAuthDb, args: FindManyArgs = {}) {
  const rows = await db.spies.movie.findMany({ ...args, select: { slug: true } });
  return rows.map((row) => row['slug']);
}

const where = (db: InMemoryAuthDb, w: Where) => slugs(db, { where: w });

function movieBySlug(db: InMemoryAuthDb, slug: string) {
  const row = db.movies.find((m) => m.slug === slug);
  if (!row) throw new Error(`no movie ${slug}`);
  return row;
}

/** The rejection reason of a promise that must reject. */
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

/** Asserts the Prisma 7.10.1 + adapter-pg P2002 shape for a unique index. */
function expectUniqueViolation(error: unknown, index: string, modelName: string) {
  const known = expectKnownError(error, 'P2002');
  expect(known.message).toContain(`Unique constraint failed on the constraint: \`${index}\``);
  expect(Object.keys(known.meta ?? {}).sort()).toEqual(['driverAdapterError', 'modelName']);
  expect(known.meta).toHaveProperty('modelName', modelName);
  // Real Prisma with a driver adapter reports no meta.target.
  expect(known.meta).not.toHaveProperty('target');
  const adapterError = known.meta?.['driverAdapterError'] as Error;
  expect(adapterError.name).toBe('DriverAdapterError');
  expect(adapterError.cause).toEqual({
    originalCode: '23505',
    originalMessage: `duplicate key value violates unique constraint "${index}"`,
    kind: 'UniqueConstraintViolation',
    constraint: { index },
    table: modelName,
  });
}

describe('inMemoryAuthDb: movie seeding and create defaults', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const PRISMA_DEFAULTS = {
    synopsis: null,
    language: null,
    genres: [],
    rating: null,
    director: null,
    cast: [],
    releaseDate: null,
    trailerUrl: null,
    posterUrl: null,
    posterPublicId: null,
    bannerUrl: null,
    bannerPublicId: null,
    status: 'UPCOMING',
    isActive: true,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('fills a seed with the defaults Prisma would apply', () => {
    const db = inMemoryAuthDb({ movies: [{ slug: 'dune', title: 'Dune', durationMinutes: 155 }] });

    expect(db.movies).toEqual([
      {
        id: expect.stringMatching(UUID_V7) as unknown,
        slug: 'dune',
        title: 'Dune',
        durationMinutes: 155,
        ...PRISMA_DEFAULTS,
      },
    ]);
  });

  it('gives a seed every Movie column, the same set testMovie has', () => {
    const db = inMemoryAuthDb({ movies: [{ slug: 'dune', title: 'Dune', durationMinutes: 155 }] });
    expect(Object.keys(db.movies[0] ?? {}).sort()).toEqual(Object.keys(testMovie()).sort());
  });

  it('create applies the same defaults, keeps given columns and returns the row', async () => {
    const db = inMemoryAuthDb();

    const created = await db.spies.movie.create({
      data: {
        slug: 'dune',
        title: 'Dune',
        durationMinutes: 155,
        genres: ['Sci-Fi'],
        cast: ['Zendaya'],
      },
    });

    expect(created).toEqual({
      id: expect.stringMatching(UUID_V7) as unknown,
      slug: 'dune',
      title: 'Dune',
      durationMinutes: 155,
      ...PRISMA_DEFAULTS,
      genres: ['Sci-Fi'],
      cast: ['Zendaya'],
    });
    expect(db.movies).toEqual([created]);
    expect(db.movies[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('create with select returns only the selected columns', async () => {
    const db = inMemoryAuthDb();
    await expect(
      db.spies.movie.create({
        data: { slug: 'dune', title: 'Dune', durationMinutes: 155 },
        select: { id: true, slug: true, title: false },
      }),
    ).resolves.toEqual({ id: expect.stringMatching(UUID_V7) as unknown, slug: 'dune' });
  });

  it('makes UUIDv7 ids that pass the movie id param schema and sort in creation order', () => {
    const ids = [testUuidV7(), testMovie().id, testUuidV7(), testMovie().id];
    for (const id of ids) {
      expect(id).toMatch(UUID_V7);
      expect(movieIdParamsSchema.parse({ id })).toEqual({ id });
    }
    expect([...ids].sort()).toEqual(ids);
  });

  it('rejects a seed with a duplicate slug, a missing required column or an unknown column', () => {
    expect(() =>
      inMemoryAuthDb({ movies: [testMovie({ slug: 'dune' }), testMovie({ slug: 'dune' })] }),
    ).toThrow(Prisma.PrismaClientKnownRequestError);
    expect(() =>
      inMemoryAuthDb({ movies: [{ slug: 'dune', title: 'Dune' } as MovieSeed] }),
    ).toThrow(/missing required durationMinutes/);
    expect(() =>
      inMemoryAuthDb({ movies: [{ ...testMovie(), tagline: 'x' } as MovieSeed] }),
    ).toThrow(UnsupportedByFakeError);
  });

  it.each([
    [
      'a missing required column',
      { slug: 'dune', title: 'Dune' },
      /missing required durationMinutes/,
    ],
    [
      'null for a required column',
      { slug: 'dune', title: null, durationMinutes: 1 },
      /null for the required column title/,
    ],
    [
      'a status outside the enum',
      { slug: 'dune', title: 'Dune', durationMinutes: 1, status: 'SHOWING' },
      /not a valid movie\.status/,
    ],
  ])(
    'create rejects %s like Prisma validation, and writes nothing',
    async (_name, data, message) => {
      const db = inMemoryAuthDb();
      await expect(db.spies.movie.create({ data })).rejects.toThrow(message);
      expect(db.movies).toHaveLength(0);
    },
  );
});

describe('inMemoryAuthDb: movie findUnique and findFirst', () => {
  it('finds by id or by slug, and returns null for no match', async () => {
    const { db, movies } = catalogue();
    const [dune] = movies;
    if (!dune) throw new Error('no seed');

    await expect(
      db.spies.movie.findUnique({ where: { id: dune.id }, select: { slug: true } }),
    ).resolves.toEqual({ slug: 'dune-part-two' });
    await expect(db.spies.movie.findUnique({ where: { slug: 'dune-part-two' } })).resolves.toEqual(
      dune,
    );
    await expect(db.spies.movie.findUnique({ where: { slug: 'nope' } })).resolves.toBeNull();
  });

  it('applies extra filters next to the unique column (public lookup by slug)', async () => {
    const { db } = catalogue();
    const publicBySlug = (slug: string) =>
      db.spies.movie.findUnique({
        where: { slug, isActive: true, deletedAt: null },
        select: { slug: true },
      });

    await expect(publicBySlug('dune-part-two')).resolves.toEqual({ slug: 'dune-part-two' });
    await expect(publicBySlug('avatar')).resolves.toBeNull(); // hidden
    await expect(publicBySlug('ape-100-percent')).resolves.toBeNull(); // soft-deleted
  });

  it('accepts { not: null } and OR as extra filters', async () => {
    const { db } = catalogue();
    const deleted = movieBySlug(db, 'ape-100-percent');
    const live = movieBySlug(db, 'zorro');
    const restorable = (id: string) =>
      db.spies.movie.findUnique({
        where: { id, deletedAt: { not: null } },
        select: { slug: true },
      });

    await expect(restorable(deleted.id)).resolves.toEqual({ slug: 'ape-100-percent' });
    await expect(restorable(live.id)).resolves.toBeNull();
    await expect(
      db.spies.movie.findUnique({
        where: { id: live.id, OR: [{ status: 'ENDED' }, { title: 'Zorro' }] },
        select: { slug: true },
      }),
    ).resolves.toEqual({ slug: 'zorro' });
  });

  it('rejects a findUnique where that names no unique column', async () => {
    const { db } = catalogue();
    await expect(db.spies.movie.findUnique({ where: { title: 'Zorro' } })).rejects.toThrow(
      /without a unique column \(id, slug\)/,
    );
    await expect(
      db.spies.movie.findUnique({ where: { slug: { startsWith: 'zo' } } }),
    ).rejects.toThrow(/without a unique column/);
  });

  it('findFirst returns the first row in orderBy order, or null', async () => {
    const { db } = catalogue();
    await expect(
      db.spies.movie.findFirst({
        where: { status: 'NOW_SHOWING' },
        orderBy: { releaseDate: 'desc' },
        select: { slug: true },
      }),
    ).resolves.toEqual({ slug: 'dune-part-two' });
    await expect(
      db.spies.movie.findFirst({ where: { slug: { startsWith: 'x' } } }),
    ).resolves.toBeNull();
  });
});

describe('inMemoryAuthDb: movie where operators', () => {
  it('matches equality, null (IS NULL) and { not: null } (IS NOT NULL)', async () => {
    const { db } = catalogue();
    expect(await where(db, { status: 'NOW_SHOWING' })).toEqual(['dune-part-two', 'bad-boys']);
    expect(await where(db, { deletedAt: null, isActive: true })).toEqual([
      'dune-part-two',
      'bad-boys',
      'zorro',
    ]);
    expect(await where(db, { deletedAt: { not: null } })).toEqual(['ape-100-percent']);
    expect(await where(db, { releaseDate: null })).toEqual(['avatar', 'zorro']);
    expect(await where(db, { releaseDate: { not: null } })).toEqual([
      'dune-part-two',
      'ape-100-percent',
      'bad-boys',
    ]);
  });

  it('matches in: [...] on enums and ids, and an empty list matches nothing', async () => {
    const { db, movies } = catalogue();
    expect(await where(db, { status: { in: ['UPCOMING', 'ENDED'] } })).toEqual([
      'avatar',
      'ape-100-percent',
      'zorro',
    ]);
    const ids = movies.slice(3).map((m) => m.id);
    expect(await where(db, { id: { in: ids } })).toEqual(['bad-boys', 'zorro']);
    expect(await where(db, { status: { in: [] } })).toEqual([]);
  });

  it('matches date ranges, never a NULL date', async () => {
    const { db } = catalogue();
    expect(await where(db, { releaseDate: { gte: day('2026-01-01') } })).toEqual([
      'dune-part-two',
      'bad-boys',
    ]);
    expect(await where(db, { releaseDate: { lt: day('2026-01-15') } })).toEqual([
      'ape-100-percent',
    ]);
  });

  it('startsWith on slug is case-sensitive unless mode is insensitive', async () => {
    const { db } = catalogue();
    expect(await where(db, { slug: { startsWith: 'a' } })).toEqual(['avatar', 'ape-100-percent']);
    expect(await where(db, { slug: { startsWith: 'dune' } })).toEqual(['dune-part-two']);
    expect(await where(db, { slug: { startsWith: 'DUNE' } })).toEqual([]);
    expect(await where(db, { slug: { startsWith: 'DUNE', mode: 'insensitive' } })).toEqual([
      'dune-part-two',
    ]);
  });

  it('contains is case-sensitive by default (and with mode: default)', async () => {
    const { db } = catalogue();
    expect(await where(db, { title: { contains: 'Ape' } })).toEqual(['ape-100-percent']);
    expect(await where(db, { title: { contains: 'ape' } })).toEqual([]);
    expect(await where(db, { title: { contains: 'ape', mode: 'default' } })).toEqual([]);
    expect(await where(db, { slug: { contains: 'part' } })).toEqual(['dune-part-two']);
  });

  it('contains with mode: insensitive ignores case on title and slug', async () => {
    const { db } = catalogue();
    expect(await where(db, { title: { contains: 'AVA', mode: 'insensitive' } })).toEqual([
      'avatar',
    ]);
    expect(await where(db, { title: { contains: 'zOR', mode: 'insensitive' } })).toEqual(['zorro']);
    expect(await where(db, { slug: { contains: 'BOYS', mode: 'insensitive' } })).toEqual([
      'bad-boys',
    ]);
  });

  // Prisma 7.10 sends `contains` as LIKE '%' || $1 || '%' without escaping $1 (captured from the
  // generated SQL), so Postgres treats % and _ in a search term as wildcards. The fake does the
  // same, so a service that passes raw user input fails here as it would in production.
  it('treats % and _ in contains/startsWith as LIKE wildcards, as Postgres does via Prisma', async () => {
    const { db } = catalogue();
    const all = ['dune-part-two', 'avatar', 'ape-100-percent', 'bad-boys', 'zorro'];
    expect(await where(db, { title: { contains: '%' } })).toEqual(all);
    expect(await where(db, { title: { contains: '_' } })).toEqual(all);
    expect(await where(db, { title: { contains: 'D_ne' } })).toEqual(['dune-part-two']);
    expect(await where(db, { slug: { startsWith: 'a_' } })).toEqual(['avatar', 'ape-100-percent']);
  });

  it('matches % and _ literally once escaped with a backslash (what a service must send)', async () => {
    const { db } = catalogue();
    expect(await where(db, { title: { contains: '\\%' } })).toEqual(['ape-100-percent']);
    expect(await where(db, { title: { contains: '100\\% a', mode: 'insensitive' } })).toEqual([
      'ape-100-percent',
    ]);
    expect(await where(db, { title: { contains: '\\_' } })).toEqual(['bad-boys']);
    expect(await where(db, { title: { contains: 'D\\_ne' } })).toEqual([]);
    expect(await where(db, { title: { contains: '\\Z' } })).toEqual(['zorro']);
  });

  it('ORs the branches of OR, ANDs top-level keys with it, and an empty OR matches nothing', async () => {
    const { db } = catalogue();
    const search = (term: string): Where => ({
      deletedAt: null,
      OR: [
        { title: { contains: term, mode: 'insensitive' } },
        { slug: { contains: term, mode: 'insensitive' } },
      ],
    });

    expect(await where(db, search('a'))).toEqual(['dune-part-two', 'avatar', 'bad-boys']);
    expect(await where(db, search('percent'))).toEqual([]); // only the deleted movie's slug
    expect(await where(db, { OR: [{ status: 'ENDED' }, { slug: 'zorro' }] })).toEqual([
      'ape-100-percent',
      'zorro',
    ]);
    expect(await where(db, { OR: [] })).toEqual([]);
  });
});

describe('inMemoryAuthDb: movie orderBy, skip, take, select and count', () => {
  it('orders text by code point (the "C" collation): uppercase and digits before lowercase', async () => {
    const { db } = catalogue();
    expect(await slugs(db, { orderBy: { title: 'asc' } })).toEqual([
      'ape-100-percent', // "100% Ape"
      'bad-boys', // "Bad_Boys"
      'dune-part-two',
      'zorro',
      'avatar', // lowercase "avatar" sorts last
    ]);
    expect(await slugs(db, { orderBy: [{ title: 'desc' }] })).toEqual([
      'avatar',
      'zorro',
      'dune-part-two',
      'bad-boys',
      'ape-100-percent',
    ]);
  });

  it('orders enums by declaration order and applies keys in array order', async () => {
    const { db } = catalogue();
    // UPCOMING < NOW_SHOWING < ENDED, as Postgres sorts the enum (not alphabetically).
    expect(await slugs(db, { orderBy: [{ status: 'asc' }, { title: 'asc' }] })).toEqual([
      'zorro',
      'avatar',
      'bad-boys',
      'dune-part-two',
      'ape-100-percent',
    ]);
    expect(await slugs(db, { orderBy: [{ status: 'desc' }, { title: 'desc' }] })).toEqual([
      'ape-100-percent',
      'dune-part-two',
      'bad-boys',
      'avatar',
      'zorro',
    ]);
  });

  it('puts NULLs last for asc and first for desc by default, like Postgres', async () => {
    const { db } = catalogue();
    expect(await slugs(db, { orderBy: { releaseDate: 'asc' } })).toEqual([
      'ape-100-percent',
      'bad-boys',
      'dune-part-two',
      'avatar',
      'zorro',
    ]);
    expect(await slugs(db, { orderBy: { releaseDate: 'desc' } })).toEqual([
      'avatar',
      'zorro',
      'dune-part-two',
      'bad-boys',
      'ape-100-percent',
    ]);
  });

  it('honours an explicit nulls: first / last', async () => {
    const { db } = catalogue();
    expect(await slugs(db, { orderBy: { releaseDate: { sort: 'asc', nulls: 'first' } } })).toEqual([
      'avatar',
      'zorro',
      'ape-100-percent',
      'bad-boys',
      'dune-part-two',
    ]);
    expect(
      await slugs(db, { orderBy: [{ releaseDate: { sort: 'desc', nulls: 'last' } }] }),
    ).toEqual(['dune-part-two', 'bad-boys', 'ape-100-percent', 'avatar', 'zorro']);
    expect(await slugs(db, { orderBy: { releaseDate: { sort: 'asc' } } })).toEqual([
      'ape-100-percent',
      'bad-boys',
      'dune-part-two',
      'avatar',
      'zorro',
    ]);
  });

  it('breaks ties with a later key, e.g. id, which follows creation order', async () => {
    const at = new Date('2026-05-01T00:00:00.000Z');
    const db = inMemoryAuthDb({
      movies: ['first', 'second', 'third'].map((slug) =>
        testMovie({ slug, title: slug, updatedAt: at }),
      ),
    });
    expect(await slugs(db, { orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }] })).toEqual([
      'third',
      'second',
      'first',
    ]);
    expect(await slugs(db, { orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] })).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('pages with skip and take after filtering and ordering', async () => {
    const { db } = catalogue();
    const page = (skip: number, take: number) =>
      slugs(db, { where: { deletedAt: null }, orderBy: { title: 'asc' }, skip, take });

    expect(await page(0, 2)).toEqual(['bad-boys', 'dune-part-two']);
    expect(await page(2, 2)).toEqual(['zorro', 'avatar']);
    expect(await page(4, 2)).toEqual([]);
    expect(await page(0, 0)).toEqual([]);
    expect(await slugs(db, { skip: 3 })).toEqual(['bad-boys', 'zorro']);
  });

  it('selects only the columns set to true, and returns whole rows without a select', async () => {
    const { db, movies } = catalogue();
    await expect(
      db.spies.movie.findMany({
        where: { slug: 'zorro' },
        select: { slug: true, title: true, status: false },
      }),
    ).resolves.toEqual([{ slug: 'zorro', title: 'Zorro' }]);
    await expect(db.spies.movie.findMany({ where: { slug: 'zorro' } })).resolves.toEqual([
      movies[4],
    ]);
  });

  it('counts rows matching the where, or all rows', async () => {
    const { db } = catalogue();
    await expect(db.spies.movie.count({})).resolves.toBe(5);
    await expect(db.spies.movie.count({ where: { deletedAt: null } })).resolves.toBe(4);
    await expect(
      db.spies.movie.count({
        where: { deletedAt: null, OR: [{ title: { contains: 'O', mode: 'insensitive' } }] },
      }),
    ).resolves.toBe(3);
  });

  it('returns copies: mutating a returned row, its Dates or lists leaves the table alone', async () => {
    const { db } = catalogue();
    const [row] = await db.spies.movie.findMany({ where: { slug: 'dune-part-two' } });
    if (!row) throw new Error('no row');

    (row['genres'] as string[]).push('Drama');
    (row['releaseDate'] as Date).setUTCFullYear(1999);
    row['title'] = 'Changed';

    expect(movieBySlug(db, 'dune-part-two')).toMatchObject({
      title: 'Dune: Part Two',
      genres: ['Sci-Fi'],
      releaseDate: day('2026-03-01'),
    });
  });
});

describe('inMemoryAuthDb: movie create, update and delete', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('create of a taken slug rejects with Prisma 7’s P2002 for Movie_slug_key and writes nothing', async () => {
    const { db } = catalogue();

    const error = await rejection(
      db.spies.movie.create({ data: { slug: 'zorro', title: 'Zorro 2', durationMinutes: 90 } }),
    );

    expectUniqueViolation(error, 'Movie_slug_key', 'Movie');
    expect(db.movies).toHaveLength(5);
  });

  it('create stores copies of the given lists and Dates', async () => {
    const db = inMemoryAuthDb();
    const genres = ['Action'];
    const releaseDate = day('2026-11-01');

    await db.spies.movie.create({
      data: { slug: 'dune', title: 'Dune', durationMinutes: 155, genres, releaseDate },
    });
    genres.push('Drama');
    releaseDate.setUTCFullYear(1999);

    expect(movieBySlug(db, 'dune')).toMatchObject({
      genres: ['Action'],
      releaseDate: day('2026-11-01'),
    });
  });

  it('update by { id, deletedAt: null } writes, replaces lists, bumps updatedAt and returns the row', async () => {
    const { db } = catalogue();
    const zorro = movieBySlug(db, 'zorro');
    const later = new Date(NOW.getTime() + 60_000);
    vi.setSystemTime(later);

    const updated = await db.spies.movie.update({
      where: { id: zorro.id, deletedAt: null },
      data: { title: 'The Mask of Zorro', genres: ['Adventure'], synopsis: null },
      select: { title: true, genres: true, updatedAt: true },
    });

    expect(updated).toEqual({
      title: 'The Mask of Zorro',
      genres: ['Adventure'],
      updatedAt: later,
    });
    expect(zorro).toMatchObject({ title: 'The Mask of Zorro', genres: ['Adventure'] });
    expect(zorro.updatedAt).toEqual(later);
    expect(zorro.createdAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
  });

  it('update rejects with P2025 when the extra filter excludes the row, and writes nothing', async () => {
    const { db } = catalogue();
    const deleted = movieBySlug(db, 'ape-100-percent');

    const error = await rejection(
      db.spies.movie.update({ where: { id: deleted.id, deletedAt: null }, data: { title: 'x' } }),
    );

    const known = expectKnownError(error, 'P2025');
    expect(known.meta).toEqual({ modelName: 'Movie', operation: 'an update' });
    expect(known.message).toContain('No record was found for an update.');
    expect(deleted.title).toBe('100% Ape');
    expect(deleted.updatedAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
  });

  it('update rejects with P2025 for an unknown id', async () => {
    const { db } = catalogue();
    await expect(
      db.spies.movie.update({ where: { id: testUuidV7() }, data: { title: 'x' } }),
    ).rejects.toMatchObject({ code: 'P2025' });
  });

  it('restores a soft-deleted movie with where { id, deletedAt: { not: null } }', async () => {
    const { db } = catalogue();
    const deleted = movieBySlug(db, 'ape-100-percent');
    const live = movieBySlug(db, 'zorro');
    const restore = (id: string) =>
      db.spies.movie.update({
        where: { id, deletedAt: { not: null } },
        data: { deletedAt: null },
        select: { deletedAt: true },
      });

    await expect(restore(deleted.id)).resolves.toEqual({ deletedAt: null });
    expect(deleted.deletedAt).toBeNull();
    await expect(restore(live.id)).rejects.toMatchObject({ code: 'P2025' });
  });

  it('update to a taken slug rejects with P2002; keeping its own slug is fine', async () => {
    const { db } = catalogue();
    const zorro = movieBySlug(db, 'zorro');

    const error = await rejection(
      db.spies.movie.update({ where: { id: zorro.id }, data: { slug: 'avatar', title: 'x' } }),
    );

    expectUniqueViolation(error, 'Movie_slug_key', 'Movie');
    expect(zorro).toMatchObject({ slug: 'zorro', title: 'Zorro' });
    await expect(
      db.spies.movie.update({
        where: { id: zorro.id },
        data: { slug: 'zorro', title: 'Zorro!' },
        select: { slug: true, title: true },
      }),
    ).resolves.toEqual({ slug: 'zorro', title: 'Zorro!' });
  });

  it('delete removes the row and returns it; the selected columns only with select', async () => {
    const { db } = catalogue();
    const avatar = movieBySlug(db, 'avatar');

    await expect(
      db.spies.movie.delete({ where: { id: avatar.id }, select: { id: true, slug: true } }),
    ).resolves.toEqual({ id: avatar.id, slug: 'avatar' });
    expect(db.movies.map((m) => m.slug)).toEqual([
      'dune-part-two',
      'ape-100-percent',
      'bad-boys',
      'zorro',
    ]);
    const bySlug = await db.spies.movie.delete({ where: { slug: 'zorro' } });
    expect(bySlug).toMatchObject({ slug: 'zorro', title: 'Zorro' });
  });

  it('delete rejects with P2025 for no match or when an extra filter excludes the row', async () => {
    const { db } = catalogue();
    const live = movieBySlug(db, 'zorro');

    const missing = await rejection(db.spies.movie.delete({ where: { id: testUuidV7() } }));
    const known = expectKnownError(missing, 'P2025');
    expect(known.meta).toEqual({ modelName: 'Movie', operation: 'a delete' });
    expect(known.message).toContain('No record was found for a delete.');

    await expect(
      db.spies.movie.delete({ where: { id: live.id, deletedAt: { not: null } } }),
    ).rejects.toMatchObject({ code: 'P2025' });
    expect(db.movies).toHaveLength(5);
  });

  it('exports error builders identical in shape to what the fake throws', async () => {
    const { db } = catalogue();
    const natural = await rejection(
      db.spies.movie.create({ data: { slug: 'zorro', title: 'Z', durationMinutes: 1 } }),
    );
    const built = uniqueConstraintError('movie', 'slug');

    expectUniqueViolation(built, 'Movie_slug_key', 'Movie');
    expect(built.message).toBe((natural as Error).message);
    expect(recordNotFoundError('movie', 'an update').meta).toEqual({
      modelName: 'Movie',
      operation: 'an update',
    });
  });
});

describe('inMemoryAuthDb: movie fault injection', () => {
  const data = { slug: 'dune', title: 'Dune', durationMinutes: 155 };

  it('fails the next create with an injected P2002 although the slug is free, writing nothing', async () => {
    const db = inMemoryAuthDb();
    db.injectFault('movie', 'create', { error: uniqueConstraintError('movie', 'slug') });

    const error = await rejection(db.spies.movie.create({ data }));

    expectUniqueViolation(error, 'Movie_slug_key', 'Movie');
    expect(db.movies).toHaveLength(0);
    await expect(db.spies.movie.create({ data, select: { slug: true } })).resolves.toEqual({
      slug: 'dune',
    });
    expect(db.spies.movie.create).toHaveBeenCalledTimes(2);
  });

  it('fails only call number onCall, counted from the injection', async () => {
    const db = inMemoryAuthDb();
    db.injectFault('movie', 'create', { onCall: 2, error: uniqueConstraintError('movie', 'slug') });

    await db.spies.movie.create({ data: { ...data, slug: 'dune' } });
    await expect(
      db.spies.movie.create({ data: { ...data, slug: 'dune-2' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await db.spies.movie.create({ data: { ...data, slug: 'dune-3' } });

    expect(db.movies.map((m) => m.slug)).toEqual(['dune', 'dune-3']);
  });

  it('fires two queued faults on calls 1 and 2, even though the first one throws', async () => {
    const db = inMemoryAuthDb();
    db.injectFault('movie', 'create', { onCall: 1, error: uniqueConstraintError('movie', 'slug') });
    db.injectFault('movie', 'create', { onCall: 2, error: uniqueConstraintError('movie', 'slug') });

    await expect(db.spies.movie.create({ data: { ...data, slug: 'dune' } })).rejects.toMatchObject({
      code: 'P2002',
    });
    await expect(
      db.spies.movie.create({ data: { ...data, slug: 'dune-2' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await db.spies.movie.create({ data: { ...data, slug: 'dune-3' } });

    expect(db.movies.map((m) => m.slug)).toEqual(['dune-3']);
  });

  it('runs every due before hook and throws the earliest-injected error when faults share a call', async () => {
    const db = inMemoryAuthDb();
    const first = uniqueConstraintError('movie', 'slug');
    const hook = vi.fn();
    db.injectFault('movie', 'create', { error: first });
    db.injectFault('movie', 'create', { before: hook, error: new Error('second') });

    await expect(db.spies.movie.create({ data })).rejects.toBe(first);

    expect(hook).toHaveBeenCalledTimes(1);
    await db.spies.movie.create({ data });
    expect(db.movies.map((m) => m.slug)).toEqual(['dune']);
  });

  it('simulates a concurrent insert: the slug is free on read, taken on insert', async () => {
    const db = inMemoryAuthDb();
    db.injectFault('movie', 'create', {
      before: () => {
        db.addMovie({ slug: 'dune', title: 'Dune (other admin)', durationMinutes: 150 });
      },
    });

    // What a slug-picking service does: read the taken slugs, then insert the free one.
    expect(await where(db, { slug: { startsWith: 'dune' } })).toEqual([]);
    const error = await rejection(db.spies.movie.create({ data }));

    expectUniqueViolation(error, 'Movie_slug_key', 'Movie');
    expect(await where(db, { slug: { startsWith: 'dune' } })).toEqual(['dune']);
    await expect(
      db.spies.movie.create({ data: { ...data, slug: 'dune-2' }, select: { slug: true } }),
    ).resolves.toEqual({ slug: 'dune-2' });
  });

  it('fires through a transaction client, and the transaction rolls back its earlier writes', async () => {
    const db = inMemoryAuthDb();
    db.injectFault('movie', 'create', {
      onCall: 2,
      error: uniqueConstraintError('movie', 'slug'),
    });

    const outcome = db.prisma.$transaction(async (tx) => {
      await tx.movie.create({ data: { ...data, slug: 'first' } });
      await tx.auditLog.create({ data: { action: 'CREATE', entity: 'Movie' } });
      await tx.movie.create({ data: { ...data, slug: 'second' } });
    });

    await expect(outcome).rejects.toMatchObject({ code: 'P2002' });
    expect(db.movies).toEqual([]);
    expect(db.auditLogs).toEqual([]);
  });

  it('keeps a concurrent insert made by before when the transaction rolls back', async () => {
    const db = inMemoryAuthDb();
    db.injectFault('movie', 'create', {
      before: () => {
        db.addMovie({ slug: 'dune', title: 'Other', durationMinutes: 1 });
      },
    });

    await expect(
      db.prisma.$transaction(async (tx) => {
        await tx.movie.create({ data });
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    expect(db.movies.map((m) => m.title)).toEqual(['Other']);
  });

  it('counts only calls that pass validation', async () => {
    const db = inMemoryAuthDb();
    db.injectFault('movie', 'create', { error: uniqueConstraintError('movie', 'slug') });

    await expect(
      db.spies.movie.create({ data, include: { showtimes: true } } as never),
    ).rejects.toBeInstanceOf(UnsupportedByFakeError);
    await expect(db.spies.movie.create({ data })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects a fault with no effect, a bad onCall or an operation the fake lacks', () => {
    const db = inMemoryAuthDb();
    const error = uniqueConstraintError('movie', 'slug');
    expect(() => {
      db.injectFault('movie', 'create', {});
    }).toThrow(/error and\/or before/);
    expect(() => {
      db.injectFault('movie', 'create', { error, onCall: 0 });
    }).toThrow(/onCall/);
    expect(() => {
      db.injectFault('movie', 'upsert' as never, { error });
    }).toThrow(/not modelled/);
  });
});

describe('inMemoryAuthDb: movie transactions', () => {
  it('rolls back a movie create, update and delete together with the audit row', async () => {
    const { db } = catalogue();
    const zorro = movieBySlug(db, 'zorro');
    const before = db.movies.map((m) => ({ ...m }));
    const order = db.movies.map((m) => m.slug);

    const outcome = db.prisma.$transaction(async (tx) => {
      await tx.movie.create({ data: { slug: 'new-movie', title: 'New', durationMinutes: 90 } });
      await tx.movie.update({ where: { id: zorro.id }, data: { title: 'Renamed', genres: ['X'] } });
      await tx.movie.update({ where: { id: zorro.id }, data: { deletedAt: T0 } });
      await tx.movie.delete({ where: { slug: 'avatar' } });
      await tx.movie.delete({ where: { slug: 'dune-part-two' } });
      await tx.auditLog.create({ data: { action: 'DELETE', entity: 'Movie', entityId: zorro.id } });
      throw new Boom('rolled back');
    });

    await expect(outcome).rejects.toBeInstanceOf(Boom);
    expect(db.movies.map((m) => m.slug)).toEqual(order);
    expect(db.movies).toEqual(before);
    expect(movieBySlug(db, 'zorro')).toBe(zorro);
    expect(db.auditLogs).toEqual([]);
  });

  it('commits movie writes and the audit row when the callback returns', async () => {
    const { db } = catalogue();

    await db.prisma.$transaction(async (tx) => {
      const created = await tx.movie.create({
        data: { slug: 'new-movie', title: 'New', durationMinutes: 90 },
        select: { id: true },
      });
      await tx.movie.delete({ where: { slug: 'avatar' } });
      await tx.auditLog.create({
        data: { action: 'CREATE', entity: 'Movie', entityId: created.id },
      });
    });

    expect(db.movies.map((m) => m.slug)).toEqual([
      'dune-part-two',
      'ape-100-percent',
      'bad-boys',
      'zorro',
      'new-movie',
    ]);
    expect(db.auditLogs.map((a) => a.action)).toEqual(['CREATE']);
  });
});

describe('inMemoryAuthDb: unsupported movie queries fail loudly', () => {
  it.each([
    ['include', { include: { showtimes: true } }],
    ['distinct', { distinct: ['slug'] }],
    ['cursor', { cursor: { id: 'x' } }],
    ['contains on a column other than title/slug', { where: { director: { contains: 'x' } } }],
    ['startsWith on title', { where: { title: { startsWith: 'Z' } } }],
    ['contains with a non-string', { where: { title: { contains: 5 } } }],
    ['endsWith', { where: { slug: { endsWith: 'o' } } }],
    ['equals', { where: { slug: { equals: 'zorro' } } }],
    ['notIn', { where: { status: { notIn: ['ENDED'] } } }],
    ['search', { where: { title: { search: 'zorro' } } }],
    ['not with a value', { where: { status: { not: 'ENDED' } } }],
    ['mode without contains/startsWith', { where: { title: { mode: 'insensitive' } } }],
    ['mode with in', { where: { title: { in: ['Zorro'], contains: 'Z', mode: 'insensitive' } } }],
    ['an unknown mode', { where: { title: { contains: 'Z', mode: 'fuzzy' } } }],
    ['in that is not an array', { where: { status: { in: 'ENDED' } } }],
    ['in with a null', { where: { releaseDate: { in: [null] } } }],
    ['a list filter (has)', { where: { genres: { has: 'Sci-Fi' } } }],
    ['list equality', { where: { genres: ['Sci-Fi'] } }],
    ['AND', { where: { AND: [{ status: 'ENDED' }] } }],
    ['NOT', { where: { NOT: { status: 'ENDED' } } }],
    ['OR that is not an array', { where: { OR: { status: 'ENDED' } } }],
    ['an unsupported operator inside OR', { where: { OR: [{ title: { endsWith: 'o' } }] } }],
    ['a relation filter', { where: { showtimes: { some: {} } } }],
    ['an undefined where value', { where: { status: undefined } }],
    ['two keys in one orderBy object', { orderBy: { title: 'asc', id: 'asc' } }],
    ['an empty orderBy object', { orderBy: {} }],
    ['orderBy a list column', { orderBy: { genres: 'asc' } }],
    ['orderBy a relation count', { orderBy: { showtimes: { _count: 'asc' } } }],
    ['orderBy an unknown direction', { orderBy: { title: 'up' } }],
    ['nulls on a required column', { orderBy: { title: { sort: 'asc', nulls: 'first' } } }],
    ['an unknown nulls value', { orderBy: { releaseDate: { sort: 'asc', nulls: 'middle' } } }],
    ['a negative take (reverse paging)', { take: -1 }],
    ['a negative skip', { skip: -1 }],
    ['a fractional take', { take: 1.5 }],
    ['a string take', { take: '10' }],
    ['a relation select', { select: { showtimes: true } }],
    ['_count in select', { select: { _count: { select: { showtimes: true } } } }],
    ['a non-boolean select', { select: { title: 'yes' } }],
  ])('findMany rejects %s', async (_name, args) => {
    const { db } = catalogue();
    await expect(db.spies.movie.findMany(args as never)).rejects.toBeInstanceOf(
      UnsupportedByFakeError,
    );
  });

  it.each([
    [
      'count with select',
      (db: InMemoryAuthDb) => db.spies.movie.count({ select: { _all: true } } as never),
    ],
    [
      'count with orderBy',
      (db: InMemoryAuthDb) => db.spies.movie.count({ orderBy: { title: 'asc' } } as never),
    ],
    ['findFirst with skip', (db: InMemoryAuthDb) => db.spies.movie.findFirst({ skip: 1 } as never)],
    [
      'findUnique with include',
      (db: InMemoryAuthDb) =>
        db.spies.movie.findUnique({
          where: { slug: 'zorro' },
          include: { showtimes: true },
        } as never),
    ],
    [
      'delete with include',
      (db: InMemoryAuthDb) =>
        db.spies.movie.delete({ where: { slug: 'zorro' }, include: {} } as never),
    ],
    [
      'a list push in update data',
      (db: InMemoryAuthDb) =>
        db.spies.movie.update({ where: { slug: 'zorro' }, data: { genres: { push: 'X' } } }),
    ],
    [
      'a list set in create data',
      (db: InMemoryAuthDb) =>
        db.spies.movie.create({
          data: { slug: 'x', title: 'X', durationMinutes: 1, genres: { set: [] } },
        }),
    ],
    [
      'a list of non-strings',
      (db: InMemoryAuthDb) =>
        db.spies.movie.create({ data: { slug: 'x', title: 'X', durationMinutes: 1, cast: [1] } }),
    ],
    [
      'a nested relation write',
      (db: InMemoryAuthDb) =>
        db.spies.movie.create({
          data: { slug: 'x', title: 'X', durationMinutes: 1, showtimes: { create: [] } },
        }),
    ],
    [
      'update without a unique column in where',
      (db: InMemoryAuthDb) =>
        db.spies.movie.update({ where: { status: 'ENDED' }, data: { isActive: false } }),
    ],
  ])('rejects %s, and writes nothing', async (_name, call) => {
    const { db } = catalogue();
    const before = db.movies.map((m) => ({ ...m }));
    await expect(call(db)).rejects.toBeInstanceOf(UnsupportedByFakeError);
    expect(db.movies).toEqual(before);
  });
});

describe('inMemoryAuthDb: auth models keep their behaviour, with real Prisma errors', () => {
  it('still rejects the movie-only operators and OR on admins', async () => {
    const { db } = seeded();
    await expect(
      db.spies.admin.updateMany({
        where: { email: { contains: 'editor', mode: 'insensitive' } },
        data: { name: 'x' },
      }),
    ).rejects.toThrow(/operator "contains" on email/);
    await expect(
      db.spies.admin.updateMany({ where: { OR: [{ name: 'x' }] }, data: { name: 'x' } }),
    ).rejects.toThrow(/where key "OR"/);
  });

  it('raises P2002, P2003 and P2025 as PrismaClientKnownRequestErrors with adapter-pg meta', async () => {
    const { db, admin, live } = seeded();
    const token = {
      adminId: admin.id,
      tokenHash: live.tokenHash,
      familyId: FAMILY,
      expiresAt: LATER,
    };

    const duplicate = await rejection(db.spies.refreshToken.create({ data: token }));
    expectUniqueViolation(duplicate, 'RefreshToken_tokenHash_key', 'RefreshToken');

    const orphan = await rejection(
      db.spies.refreshToken.create({ data: { ...token, tokenHash: 'h', adminId: randomUUID() } }),
    );
    expect(expectKnownError(orphan, 'P2003').meta).toHaveProperty('modelName', 'RefreshToken');

    const missing = await rejection(
      db.spies.admin.update({ where: { id: randomUUID() }, data: { name: 'x' } }),
    );
    expect(expectKnownError(missing, 'P2025').meta).toEqual({
      modelName: 'Admin',
      operation: 'an update',
    });
  });

  it('admin.update now enforces the unique email (P2002) and writes nothing', async () => {
    const { db, admin, other } = seeded();
    const error = await rejection(
      db.spies.admin.update({ where: { id: admin.id }, data: { email: other.email, name: 'x' } }),
    );
    expectUniqueViolation(error, 'Admin_email_key', 'Admin');
    expect(adminById(db, admin.id)).toMatchObject({ email: admin.email, name: admin.name });
  });

  it('rejects an audit action outside the AuditAction enum', async () => {
    const { db } = seeded();
    await expect(
      db.spies.auditLog.create({ data: { action: 'LOGGED_IN', entity: 'Admin' } }),
    ).rejects.toThrow(/not a valid auditLog\.action/);
    expect(db.auditLogs).toHaveLength(0);
  });
});

describe('testPasswordHash', () => {
  it('is a cheap argon2id hash that the app verifies like a production one', async () => {
    const hash = await testPasswordHash('correct horse battery staple');

    expect(hash.startsWith('$argon2id$v=19$m=8,t=1,p=1$')).toBe(true);
    await expect(verifyPassword(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'Correct horse battery staple')).resolves.toBe(false);
  });

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([testPasswordHash('same'), testPasswordHash('same')]);
    expect(a).not.toBe(b);
  });
});
