/**
 * Tests for the in-memory Prisma fake itself (inMemoryAuthDb). The auth tests trust it to
 * answer like Postgres for the queries the services make, to refuse anything else loudly, and
 * to roll back exactly a transaction's own writes.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Prisma } from '../generated/prisma/client.js';
import {
  UnsupportedByFakeError,
  inMemoryAuthDb,
  testAdmin,
  testRefreshToken,
  type InMemoryAuthDb,
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
