import { randomUUID } from 'node:crypto';
import { ERROR_CODES } from '@sk-cinema/shared';
import { adminProfileSchema } from '@sk-cinema/shared';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Admin, RefreshToken } from '../generated/prisma/client.js';
import { AppError } from '../lib/errors.js';
import type * as PasswordModule from '../lib/password.js';
import { hashPassword, verifyDummyPassword, verifyPassword } from '../lib/password.js';
import { hashRefreshToken, verifyAccessToken } from '../lib/tokens.js';
import { inMemoryAuthDb, testAdmin, testConfig, type InMemoryAuthDb } from '../test/helpers.js';
import {
  INVALID_CREDENTIALS_MESSAGE,
  SESSION_EXPIRED_MESSAGE,
  findSessionAuthState,
  getMe,
  login,
  logout,
  refresh,
  type LoginInput,
  type RefreshInput,
} from './auth.service.js';

// Real argon2, wrapped in spies so tests can see which verify ran.
vi.mock('../lib/password.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PasswordModule>();
  return {
    ...actual,
    verifyPassword: vi.fn(actual.verifyPassword),
    verifyDummyPassword: vi.fn(actual.verifyDummyPassword),
  };
});

const PASSWORD = 'correct horse battery staple';
const WRONG_PASSWORD = 'Tr0ub4dor&3-wrong';
const EMAIL = 'editor@skcinema.lk';
const IP = '203.0.113.7';
const USER_AGENT = 'Mozilla/5.0 (test)';
const MINUTE_MS = 60_000;

const authConfig = testConfig().auth;
const MAX = authConfig.loginMaxFailedAttempts;

let passwordHash: string;
let db: InMemoryAuthDb;
let clock: Date;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(() => {
  vi.clearAllMocks();
  clock = new Date('2026-10-30T04:30:00.000Z');
  db = seedDb();
});

function seedDb(overrides: Partial<Admin> = {}): InMemoryAuthDb {
  return inMemoryAuthDb({ admins: [testAdmin({ email: EMAIL, passwordHash, ...overrides })] });
}

function storedAdmin(): Admin {
  const admin = db.admins[0];
  if (!admin) throw new Error('no admin seeded');
  return admin;
}

const deps = () => ({ db: db.prisma, config: authConfig, now: () => clock });

const attempt = (overrides: Partial<LoginInput> = {}) =>
  login(
    { email: EMAIL, password: PASSWORD, ipAddress: IP, userAgent: USER_AGENT, ...overrides },
    deps(),
  );

/** Awaits a call that must fail and returns the thrown AppError. */
async function rejected(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error('expected the call to be refused');
    },
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

/** Runs a login that must fail and returns the thrown AppError. */
const refused = (overrides: Partial<LoginInput> = {}) => rejected(attempt(overrides));

const errorShape = (error: AppError) =>
  JSON.stringify({
    status: error.status,
    code: error.code,
    message: error.message,
    details: error.details,
  });

const actions = () => db.auditLogs.map((row) => row.action);

describe('login: success', () => {
  it('returns the profile and tokens, and starts a hashed refresh-token family', async () => {
    const result = await attempt();
    const admin = storedAdmin();

    expect(result.admin).toEqual({
      id: admin.id,
      email: EMAIL,
      name: admin.name,
      role: 'EDITOR',
      mustChangePassword: false,
    });
    // Exactly the profile shape: no hash, lockout state or timestamps leak through.
    expect(adminProfileSchema.safeParse(result.admin).success).toBe(true);

    await expect(
      verifyAccessToken(result.accessToken, { secret: authConfig.jwtAccessSecret, now: clock }),
    ).resolves.toEqual({
      adminId: admin.id,
      role: 'EDITOR',
      sessionId: db.refreshTokens[0]?.familyId,
    });

    const expectedExpiry = new Date(clock.getTime() + authConfig.refreshTokenTtlHours * 3_600_000);
    expect(result.refreshExpiresAt).toEqual(expectedExpiry);

    expect(db.refreshTokens).toHaveLength(1);
    const stored = db.refreshTokens[0];
    expect(stored).toMatchObject({
      adminId: admin.id,
      tokenHash: hashRefreshToken(result.refreshToken),
      expiresAt: expectedExpiry,
      ipAddress: IP,
      userAgent: USER_AGENT,
    });
    expect(stored?.tokenHash).not.toBe(result.refreshToken);
    expect(stored?.familyId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('resets the failure counter and lock, sets lastLoginAt and audits LOGIN in one transaction', async () => {
    db = seedDb({ failedLoginCount: 3, lockedUntil: new Date(clock.getTime() - MINUTE_MS) });

    await attempt();

    expect(storedAdmin()).toMatchObject({
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: clock,
    });
    expect(db.spies.$transaction).toHaveBeenCalledTimes(1);
    expect(db.auditLogs).toEqual([
      expect.objectContaining({
        action: 'LOGIN',
        adminId: storedAdmin().id,
        entity: 'Admin',
        entityId: storedAdmin().id,
        ipAddress: IP,
        userAgent: USER_AGENT,
      }),
    ]);
  });

  it('gives each login its own refresh-token family', async () => {
    await attempt();
    await attempt();
    const [first, second] = db.refreshTokens;
    expect(first?.familyId).not.toBe(second?.familyId);
    expect(first?.tokenHash).not.toBe(second?.tokenHash);
  });

  it('truncates an over-long user agent to the column length', async () => {
    await attempt({ userAgent: 'x'.repeat(2000) });
    expect(db.refreshTokens[0]?.userAgent).toHaveLength(500);
    expect(db.auditLogs[0]?.userAgent).toHaveLength(500);
  });

  it('stores null client info when the request has none', async () => {
    await attempt({ ipAddress: undefined, userAgent: undefined });
    expect(db.refreshTokens[0]).toMatchObject({ ipAddress: null, userAgent: null });
    expect(db.auditLogs[0]).toMatchObject({ ipAddress: null, userAgent: null });
  });
});

describe('login: wrong password', () => {
  it('increments the counter atomically, audits LOGIN_FAILED and refuses with 401', async () => {
    const error = await refused({ password: WRONG_PASSWORD });

    expect(error.status).toBe(401);
    expect(error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS);
    expect(storedAdmin().failedLoginCount).toBe(1);
    expect(storedAdmin().lockedUntil).toBeNull();
    // Reserved in SQL before the verify, only while unlocked and under the limit.
    expect(db.spies.admin.updateManyAndReturn).toHaveBeenCalledWith({
      where: { id: storedAdmin().id, lockedUntil: null, failedLoginCount: { lt: MAX } },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    expect(db.spies.admin.updateManyAndReturn.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(verifyPassword).mock.invocationCallOrder[0] ?? 0,
    );
    expect(db.spies.admin.update).not.toHaveBeenCalled();
    expect(db.auditLogs).toEqual([
      expect.objectContaining({
        action: 'LOGIN_FAILED',
        adminId: storedAdmin().id,
        details: { reason: 'bad_password' },
        ipAddress: IP,
      }),
    ]);
    expect(db.refreshTokens).toHaveLength(0);
  });

  it(`locks the account at exactly ${MAX} consecutive failures`, async () => {
    for (let i = 1; i < MAX; i++) {
      await refused({ password: WRONG_PASSWORD });
      expect(storedAdmin().lockedUntil).toBeNull();
    }
    expect(actions()).not.toContain('ACCOUNT_LOCKED');

    await refused({ password: WRONG_PASSWORD });

    expect(storedAdmin().failedLoginCount).toBe(MAX);
    expect(storedAdmin().lockedUntil).toEqual(
      new Date(clock.getTime() + authConfig.loginLockoutMinutes * MINUTE_MS),
    );
    expect(actions().slice(-2)).toEqual(['ACCOUNT_LOCKED', 'LOGIN_FAILED']);
    expect(db.auditLogs.at(-2)).toMatchObject({
      adminId: storedAdmin().id,
      details: { failedLoginCount: MAX, lockoutMinutes: authConfig.loginLockoutMinutes },
    });
    expect(db.auditLogs.at(-1)?.details).toEqual({ reason: 'bad_password' });
    expect(actions().filter((a) => a === 'LOGIN_FAILED')).toHaveLength(MAX);
  });
});

describe('login: unknown email', () => {
  it('runs the dummy verify, audits without the email and refuses with 401', async () => {
    const unknownEmail = 'nobody@example.com';
    const error = await refused({ email: unknownEmail });

    expect(error.status).toBe(401);
    expect(error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS);
    expect(verifyDummyPassword).toHaveBeenCalledWith(PASSWORD);
    expect(verifyPassword).not.toHaveBeenCalled();

    expect(db.auditLogs).toEqual([
      expect.objectContaining({
        action: 'LOGIN_FAILED',
        adminId: null,
        entity: 'Admin',
        entityId: null,
        details: { reason: 'unknown_email' },
      }),
    ]);
    const serialised = JSON.stringify(db.auditLogs);
    expect(serialised).not.toContain(unknownEmail);
    expect(serialised).not.toContain('nobody');
    expect(storedAdmin().failedLoginCount).toBe(0);
  });
});

describe('login: locked account', () => {
  beforeEach(() => {
    db = seedDb({ failedLoginCount: MAX, lockedUntil: new Date(clock.getTime() + MINUTE_MS) });
  });

  it('refuses the correct password without verifying it against the real hash', async () => {
    const error = await refused();

    expect(error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS);
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(verifyDummyPassword).toHaveBeenCalledWith(PASSWORD);
    expect(db.auditLogs).toEqual([
      expect.objectContaining({ action: 'LOGIN_FAILED', details: { reason: 'locked' } }),
    ]);
    expect(db.refreshTokens).toHaveLength(0);
    expect(storedAdmin().failedLoginCount).toBe(MAX);
  });

  it('does not extend the lock or count attempts while locked', async () => {
    const lockedUntil = storedAdmin().lockedUntil;
    await refused({ password: WRONG_PASSWORD });
    expect(storedAdmin()).toMatchObject({ failedLoginCount: MAX, lockedUntil });
    expect(db.spies.admin.update).not.toHaveBeenCalled();
  });

  it('allows login once the lock expires and resets the counter', async () => {
    clock = new Date(clock.getTime() + MINUTE_MS); // lockedUntil === now: expired

    const result = await attempt();

    expect(result.admin.id).toBe(storedAdmin().id);
    expect(storedAdmin()).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    expect(actions()).toEqual(['LOGIN']);
  });

  it('starts counting from zero after the lock expires', async () => {
    clock = new Date(clock.getTime() + 2 * MINUTE_MS);

    await refused({ password: WRONG_PASSWORD });

    expect(storedAdmin()).toMatchObject({ failedLoginCount: 1, lockedUntil: null });
    expect(actions()).toEqual(['LOGIN_FAILED']);
  });
});

/** A promise the test settles by hand, to pin down an interleaving. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Holds the next verifyPassword calls (in call order) until the test releases each with
 * its result, so a race between logins can be replayed step by step.
 */
function gateVerifies(count: number) {
  const gates = Array.from({ length: count }, () => deferred<boolean>());
  for (const gate of gates) vi.mocked(verifyPassword).mockImplementationOnce(() => gate.promise);
  return gates;
}

const waitForVerifies = (times: number) =>
  vi.waitFor(() => {
    expect(verifyPassword).toHaveBeenCalledTimes(times);
  });

const reasons = () =>
  db.auditLogs
    .filter((row) => row.action === 'LOGIN_FAILED')
    .map((row) => (row.details as { reason: string }).reason);

describe('login: concurrent attempts', () => {
  it(`lets only ${MAX} of 20 concurrent wrong passwords reach the real hash, then locks once`, async () => {
    const N = 20;
    const errors = await Promise.all(
      Array.from({ length: N }, (_, i) => refused({ password: `${WRONG_PASSWORD}-${i}` })),
    );

    expect(verifyPassword).toHaveBeenCalledTimes(MAX);
    expect(verifyDummyPassword).toHaveBeenCalledTimes(N - MAX);
    expect(storedAdmin()).toMatchObject({
      failedLoginCount: MAX,
      lockedUntil: new Date(clock.getTime() + authConfig.loginLockoutMinutes * MINUTE_MS),
    });

    // lockedUntil was written by exactly one statement, and audited exactly once.
    const calls = db.spies.admin.updateManyAndReturn.mock.calls;
    const results = await Promise.all(
      db.spies.admin.updateManyAndReturn.mock.results.map((r) => r.value as Promise<unknown[]>),
    );
    const lockWrites = results.filter((_, i) => 'lockedUntil' in (calls[i]?.[0].data ?? {}));
    expect(lockWrites.filter((rows) => rows.length > 0)).toHaveLength(1);
    expect(db.spies.admin.update).not.toHaveBeenCalled();
    expect(db.spies.admin.updateMany).not.toHaveBeenCalled();
    expect(actions().filter((a) => a === 'ACCOUNT_LOCKED')).toHaveLength(1);
    expect(db.auditLogs.find((row) => row.action === 'ACCOUNT_LOCKED')?.details).toMatchObject({
      failedLoginCount: MAX,
    });

    // The rest were refused as locked, with the same 401 as every other refusal.
    expect(reasons().filter((r) => r === 'bad_password')).toHaveLength(MAX);
    expect(reasons().filter((r) => r === 'locked')).toHaveLength(N - MAX);
    const expected = JSON.stringify({
      status: 401,
      code: ERROR_CODES.INVALID_CREDENTIALS,
      message: INVALID_CREDENTIALS_MESSAGE,
    });
    for (const error of errors) expect(errorShape(error)).toBe(expected);
    expect(db.refreshTokens).toHaveLength(0);
  });

  // The failure took the last attempt (count reaches MAX), the correct login commits its reset
  // between that failure's increment and its lock write. The lock must then not be applied.
  it('does not lock when a correct login commits between the last failure and its lock write', async () => {
    db = seedDb({ failedLoginCount: MAX - 2 });
    const [correctGate, wrongGate] = gateVerifies(2);

    const correct = attempt();
    await waitForVerifies(1);
    const wrong = refused({ password: WRONG_PASSWORD });
    await waitForVerifies(2);
    expect(storedAdmin().failedLoginCount).toBe(MAX); // both reserved; the failure took the last

    correctGate?.resolve(true);
    await correct;
    expect(storedAdmin()).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    wrongGate?.resolve(false);
    await wrong;

    expect(storedAdmin()).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    expect(actions()).toEqual(['LOGIN', 'LOGIN_FAILED']);
    expect(reasons()).toEqual(['bad_password']);
  });

  it('a lock set while a correct login is in flight is cleared by that login, never left at count 0', async () => {
    db = seedDb({ failedLoginCount: MAX - 2 });
    const [correctGate, wrongGate] = gateVerifies(2);

    const correct = attempt();
    await waitForVerifies(1);
    const wrong = refused({ password: WRONG_PASSWORD });
    await waitForVerifies(2);

    wrongGate?.resolve(false);
    await wrong;
    expect(storedAdmin()).toMatchObject({
      failedLoginCount: MAX,
      lockedUntil: new Date(clock.getTime() + authConfig.loginLockoutMinutes * MINUTE_MS),
    });
    // While locked, a third attempt is refused without the real hash.
    await refused();
    expect(verifyPassword).toHaveBeenCalledTimes(2);

    correctGate?.resolve(true);
    await correct;

    expect(storedAdmin()).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    expect(actions()).toEqual(['ACCOUNT_LOCKED', 'LOGIN_FAILED', 'LOGIN_FAILED', 'LOGIN']);
    expect(reasons()).toEqual(['bad_password', 'locked']);
  });

  it('refuses as locked, without the real hash, while a correct login holds the last attempt', async () => {
    db = seedDb({ failedLoginCount: MAX - 1 });
    const [correctGate] = gateVerifies(1);

    const correct = attempt();
    await waitForVerifies(1);
    await refused({ password: WRONG_PASSWORD });

    expect(verifyPassword).toHaveBeenCalledTimes(1);
    expect(verifyDummyPassword).toHaveBeenCalledWith(WRONG_PASSWORD);
    expect(reasons()).toEqual(['locked']);

    correctGate?.resolve(true);
    await correct;
    expect(storedAdmin()).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    expect(actions().at(-1)).toBe('LOGIN');
  });

  it('locks an account whose attempts are used up but whose lock write was lost, so it expires', async () => {
    db = seedDb({ failedLoginCount: MAX, lockedUntil: null });
    const lockedUntil = new Date(clock.getTime() + authConfig.loginLockoutMinutes * MINUTE_MS);

    await refused();
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(storedAdmin()).toMatchObject({ failedLoginCount: MAX, lockedUntil });
    expect(actions()).toEqual(['ACCOUNT_LOCKED', 'LOGIN_FAILED']);
    expect(reasons()).toEqual(['locked']);

    await refused();
    expect(actions().filter((a) => a === 'ACCOUNT_LOCKED')).toHaveLength(1);

    clock = lockedUntil;
    await attempt();
    expect(storedAdmin()).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
  });
});

describe('login: inactive admin', () => {
  it('refuses even the correct password', async () => {
    db = seedDb({ isActive: false });

    const error = await refused();

    expect(error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS);
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(verifyDummyPassword).toHaveBeenCalledWith(PASSWORD);
    expect(db.auditLogs).toEqual([
      expect.objectContaining({ action: 'LOGIN_FAILED', details: { reason: 'inactive' } }),
    ]);
    expect(db.refreshTokens).toHaveLength(0);
  });
});

describe('login: no enumeration or secret leakage', () => {
  it('gives every failure mode a byte-identical error', async () => {
    const wrongPassword = await refused({ password: WRONG_PASSWORD });
    const unknownEmail = await refused({ email: 'nobody@example.com' });

    db = seedDb({ lockedUntil: new Date(clock.getTime() + MINUTE_MS) });
    const locked = await refused();

    db = seedDb({ isActive: false });
    const inactive = await refused();

    const expected = JSON.stringify({
      status: 401,
      code: ERROR_CODES.INVALID_CREDENTIALS,
      message: INVALID_CREDENTIALS_MESSAGE,
    });
    for (const error of [wrongPassword, unknownEmail, locked, inactive]) {
      expect(errorShape(error)).toBe(expected);
    }
  });

  it('never puts the password or tokens in audit rows or errors', async () => {
    const audits: unknown[] = [];
    const errors: string[] = [];
    const collect = () => audits.push(...db.auditLogs);

    for (let i = 0; i < MAX; i++) {
      errors.push(errorShape(await refused({ password: WRONG_PASSWORD })));
    }
    errors.push(errorShape(await refused())); // locked
    errors.push(errorShape(await refused({ email: 'nobody@example.com' })));
    collect();

    db = seedDb();
    const result = await attempt();
    collect();

    const serialised = JSON.stringify({ audits, errors });
    for (const secret of [
      PASSWORD,
      WRONG_PASSWORD,
      passwordHash,
      result.accessToken,
      result.refreshToken,
      hashRefreshToken(result.refreshToken),
    ]) {
      expect(serialised).not.toContain(secret);
    }
    // And the refresh-token row holds only the hash.
    expect(JSON.stringify(db.refreshTokens)).not.toContain(result.refreshToken);
  });
});

const REFRESH_IP = '198.51.100.23';
const REFRESH_USER_AGENT = 'Mozilla/5.0 (refresh)';

const rotate = (refreshToken: string, overrides: Partial<RefreshInput> = {}) =>
  refresh(
    { refreshToken, ipAddress: REFRESH_IP, userAgent: REFRESH_USER_AGENT, ...overrides },
    deps(),
  );

const refreshRefused = (refreshToken: string) => rejected(rotate(refreshToken));

const signOut = (refreshToken?: string) =>
  logout({ refreshToken, ipAddress: IP, userAgent: USER_AGENT }, deps());

function rowFor(rawToken: string): RefreshToken {
  const row = db.refreshTokens.find((t) => t.tokenHash === hashRefreshToken(rawToken));
  if (!row) throw new Error('no refresh-token row for that token');
  return row;
}

const familyRows = (familyId: string) => db.refreshTokens.filter((t) => t.familyId === familyId);

const SESSION_EXPIRED = JSON.stringify({
  status: 401,
  code: ERROR_CODES.UNAUTHORIZED,
  message: SESSION_EXPIRED_MESSAGE,
});

describe('refresh: rotation', () => {
  it('revokes the old token, links it to a child in the same family and keeps the expiry', async () => {
    const session = await attempt();
    const parent = { ...rowFor(session.refreshToken) };
    clock = new Date(clock.getTime() + 10 * MINUTE_MS);

    const result = await rotate(session.refreshToken);

    expect(result.refreshToken).not.toBe(session.refreshToken);
    expect(result.refreshExpiresAt).toEqual(session.refreshExpiresAt);
    expect(result.admin).toEqual(session.admin);
    expect(adminProfileSchema.safeParse(result.admin).success).toBe(true);

    const child = rowFor(result.refreshToken);
    expect(rowFor(session.refreshToken)).toMatchObject({
      revokedAt: clock,
      replacedById: child.id,
    });
    expect(child).toMatchObject({
      adminId: parent.adminId,
      familyId: parent.familyId,
      revokedAt: null,
      replacedById: null,
      ipAddress: REFRESH_IP,
      userAgent: REFRESH_USER_AGENT,
    });
    expect(child.expiresAt.getTime()).toBe(parent.expiresAt.getTime());
    expect(child.tokenHash).not.toBe(result.refreshToken);

    await expect(
      verifyAccessToken(result.accessToken, { secret: authConfig.jwtAccessSecret, now: clock }),
    ).resolves.toEqual({ adminId: storedAdmin().id, role: 'EDITOR', sessionId: parent.familyId });
    // Successful refreshes are not audited.
    expect(actions()).toEqual(['LOGIN']);
  });

  it('can rotate a child again, still within the original absolute expiry', async () => {
    const session = await attempt();
    const first = await rotate(session.refreshToken);
    const second = await rotate(first.refreshToken);

    expect(second.refreshExpiresAt).toEqual(session.refreshExpiresAt);
    expect(familyRows(rowFor(session.refreshToken).familyId)).toHaveLength(3);
    expect(rowFor(first.refreshToken).replacedById).toBe(rowFor(second.refreshToken).id);
  });

  it('signs the new access token with the current role from the database', async () => {
    const session = await attempt();
    storedAdmin().role = 'SUPER_ADMIN';

    const result = await rotate(session.refreshToken);

    expect(result.admin.role).toBe('SUPER_ADMIN');
    await expect(
      verifyAccessToken(result.accessToken, { secret: authConfig.jwtAccessSecret, now: clock }),
    ).resolves.toEqual({
      adminId: storedAdmin().id,
      role: 'SUPER_ADMIN',
      sessionId: rowFor(session.refreshToken).familyId,
    });
  });

  it('still works 1 ms before the absolute expiry', async () => {
    const session = await attempt();
    clock = new Date(session.refreshExpiresAt.getTime() - 1);
    await expect(rotate(session.refreshToken)).resolves.toMatchObject({
      refreshExpiresAt: session.refreshExpiresAt,
    });
  });

  it('lets a temporarily locked admin refresh without revoking the session', async () => {
    const session = await attempt();
    const lockedUntil = new Date(clock.getTime() + 15 * MINUTE_MS);
    Object.assign(storedAdmin(), { failedLoginCount: MAX, lockedUntil });

    const result = await rotate(session.refreshToken);

    expect(rowFor(result.refreshToken).revokedAt).toBeNull();
    expect(storedAdmin()).toMatchObject({ failedLoginCount: MAX, lockedUntil });
    expect(actions()).toEqual(['LOGIN']);
  });
});

describe('refresh: reuse detection', () => {
  it('revokes the whole family and audits when a rotated token is replayed', async () => {
    const session = await attempt();
    const first = await rotate(session.refreshToken);
    const latest = await rotate(first.refreshToken);
    const { familyId } = rowFor(session.refreshToken);
    clock = new Date(clock.getTime() + MINUTE_MS);

    const error = await refreshRefused(session.refreshToken);

    expect(errorShape(error)).toBe(SESSION_EXPIRED);
    expect(familyRows(familyId).every((t) => t.revokedAt !== null)).toBe(true);
    expect(rowFor(latest.refreshToken).revokedAt).toEqual(clock);
    expect(db.auditLogs.filter((a) => a.action === 'TOKEN_REUSE_DETECTED')).toEqual([
      expect.objectContaining({
        adminId: storedAdmin().id,
        entity: 'Admin',
        entityId: storedAdmin().id,
        // Only `latest` was still live when the replay came in.
        details: { familyId, revokedCount: 1 },
        ipAddress: REFRESH_IP,
        userAgent: REFRESH_USER_AGENT,
      }),
    ]);

    // The newest child is dead too, and refusing it is not a second reuse alarm.
    expect(errorShape(await refreshRefused(latest.refreshToken))).toBe(SESSION_EXPIRED);
    expect(actions().filter((a) => a === 'TOKEN_REUSE_DETECTED')).toHaveLength(1);
  });

  it('leaves other families of the same admin untouched', async () => {
    const stolen = await attempt();
    const other = await attempt();
    await rotate(stolen.refreshToken);

    await refreshRefused(stolen.refreshToken);

    expect(rowFor(other.refreshToken).revokedAt).toBeNull();
    await expect(rotate(other.refreshToken)).resolves.toBeDefined();
  });

  it('still audits a replay after logout, with revokedCount 0', async () => {
    const session = await attempt();
    const latest = await rotate(session.refreshToken);
    await signOut(latest.refreshToken);
    const { familyId } = rowFor(session.refreshToken);

    const error = await refreshRefused(session.refreshToken);

    expect(errorShape(error)).toBe(SESSION_EXPIRED);
    expect(actions()).toEqual(['LOGIN', 'LOGOUT', 'TOKEN_REUSE_DETECTED']);
    expect(db.auditLogs.at(-1)).toMatchObject({
      adminId: storedAdmin().id,
      details: { familyId, revokedCount: 0 },
    });
  });
});

describe('refresh: concurrent use of one token', () => {
  it('lets exactly one of two simultaneous refreshes win, then revokes the family', async () => {
    const session = await attempt();
    const parent = rowFor(session.refreshToken);

    // Real interleaving: both calls read the live token before either transaction runs, and
    // the fake serialises transactions like row locks, so the second claim matches 0 rows.
    const outcomes = await Promise.allSettled([
      rotate(session.refreshToken),
      rotate(session.refreshToken),
    ]);

    const wins = outcomes.filter((o) => o.status === 'fulfilled');
    const losses = outcomes.filter((o) => o.status === 'rejected');
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    const reason: unknown = losses[0]?.reason;
    expect(reason).toBeInstanceOf(AppError);
    expect(errorShape(reason as AppError)).toBe(SESSION_EXPIRED);

    // Both requests reached the claim step, proving this was the race path.
    const { calls, results } = db.spies.refreshToken.updateMany.mock;
    const claimIndexes = calls.flatMap(([args], i) =>
      (args.where as { id?: string }).id === parent.id ? [i] : [],
    );
    expect(claimIndexes).toHaveLength(2);
    const claimCounts: unknown[] = await Promise.all(
      claimIndexes.map((i): unknown => results[i]?.value),
    );
    expect(claimCounts).toEqual([{ count: 1 }, { count: 0 }]);

    expect(familyRows(parent.familyId)).toHaveLength(2);
    expect(familyRows(parent.familyId).every((t) => t.revokedAt !== null)).toBe(true);
    expect(actions().filter((a) => a === 'TOKEN_REUSE_DETECTED')).toHaveLength(1);
    // The winner's child was the one live token left in the family.
    expect(db.auditLogs.at(-1)?.details).toEqual({
      familyId: parent.familyId,
      revokedCount: 1,
    });

    const winner = wins[0];
    if (!winner) throw new Error('no winner');
    expect(errorShape(await refreshRefused(winner.value.refreshToken))).toBe(SESSION_EXPIRED);
  });

  it('keeps the family revocation when the losing transaction rolls back', async () => {
    const session = await attempt();
    const { familyId } = rowFor(session.refreshToken);
    // Deterministic variant: the claim reports that another request got there first.
    db.spies.refreshToken.updateMany.mockResolvedValueOnce({ count: 0 });

    const error = await refreshRefused(session.refreshToken);

    expect(errorShape(error)).toBe(SESSION_EXPIRED);
    expect(db.spies.refreshToken.create).toHaveBeenCalledTimes(1); // login only, no child
    expect(familyRows(familyId)).toHaveLength(1);
    expect(rowFor(session.refreshToken)).toMatchObject({ revokedAt: clock, replacedById: null });
    expect(actions()).toEqual(['LOGIN', 'TOKEN_REUSE_DETECTED']);
    // The claim lost, so the token was still live and the family revocation took it.
    expect(db.auditLogs.at(-1)?.details).toEqual({ familyId, revokedCount: 1 });
  });
});

describe('refresh: refusals', () => {
  it('refuses an expired token without rotating or revoking', async () => {
    const session = await attempt();
    clock = session.refreshExpiresAt; // expiresAt === now: expired

    const error = await refreshRefused(session.refreshToken);

    expect(errorShape(error)).toBe(SESSION_EXPIRED);
    expect(db.refreshTokens).toHaveLength(1);
    expect(rowFor(session.refreshToken)).toMatchObject({ revokedAt: null, replacedById: null });
    expect(db.spies.$transaction).toHaveBeenCalledTimes(1); // login only
    expect(actions()).toEqual(['LOGIN']);
  });

  it('refuses an unknown token without writing anything', async () => {
    await attempt();

    const error = await refreshRefused('not-a-real-token');

    expect(errorShape(error)).toBe(SESSION_EXPIRED);
    expect(db.spies.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(actions()).toEqual(['LOGIN']);
  });

  it('refuses a deactivated admin and revokes the family', async () => {
    const session = await attempt();
    const first = await rotate(session.refreshToken);
    storedAdmin().isActive = false;

    const error = await refreshRefused(first.refreshToken);

    expect(errorShape(error)).toBe(SESSION_EXPIRED);
    const { familyId } = rowFor(session.refreshToken);
    expect(familyRows(familyId)).toHaveLength(2);
    expect(familyRows(familyId).every((t) => t.revokedAt !== null)).toBe(true);
    expect(actions()).toEqual(['LOGIN']);
  });

  it('refuses a token revoked by logout without a reuse alarm', async () => {
    const session = await attempt();
    await signOut(session.refreshToken);

    const error = await refreshRefused(session.refreshToken);

    expect(errorShape(error)).toBe(SESSION_EXPIRED);
    expect(actions()).toEqual(['LOGIN', 'LOGOUT']);
  });
});

describe('logout', () => {
  it('revokes the whole family and audits LOGOUT once', async () => {
    const session = await attempt();
    const other = await attempt();
    const latest = await rotate(session.refreshToken);
    const { familyId } = rowFor(session.refreshToken);
    clock = new Date(clock.getTime() + MINUTE_MS);

    await expect(signOut(latest.refreshToken)).resolves.toBeUndefined();

    expect(familyRows(familyId).every((t) => t.revokedAt !== null)).toBe(true);
    expect(rowFor(latest.refreshToken).revokedAt).toEqual(clock);
    expect(rowFor(other.refreshToken).revokedAt).toBeNull();
    expect(db.auditLogs.filter((a) => a.action === 'LOGOUT')).toEqual([
      expect.objectContaining({
        adminId: storedAdmin().id,
        entity: 'Admin',
        entityId: storedAdmin().id,
        ipAddress: IP,
        userAgent: USER_AGENT,
      }),
    ]);

    expect(errorShape(await refreshRefused(latest.refreshToken))).toBe(SESSION_EXPIRED);
  });

  it('is a silent no-op for a missing or unknown token', async () => {
    await attempt();

    await expect(signOut()).resolves.toBeUndefined();
    await expect(signOut('')).resolves.toBeUndefined();
    await expect(signOut('not-a-real-token')).resolves.toBeUndefined();

    expect(db.spies.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(db.refreshTokens[0]?.revokedAt).toBeNull();
    expect(actions()).toEqual(['LOGIN']);
  });

  it('does not throw or audit again for an already-revoked token', async () => {
    const session = await attempt();
    await signOut(session.refreshToken);

    await expect(signOut(session.refreshToken)).resolves.toBeUndefined();

    expect(actions()).toEqual(['LOGIN', 'LOGOUT']);
  });
});

describe('getMe', () => {
  it('returns exactly the five profile fields', async () => {
    const admin = storedAdmin();

    const profile = await getMe(admin.id, deps());

    expect(Object.keys(profile).sort()).toEqual([
      'email',
      'id',
      'mustChangePassword',
      'name',
      'role',
    ]);
    expect(profile).toEqual({
      id: admin.id,
      email: EMAIL,
      name: admin.name,
      role: 'EDITOR',
      mustChangePassword: false,
    });
    expect(adminProfileSchema.safeParse(profile).success).toBe(true);
  });

  it('refuses a deactivated or missing admin with the session error', async () => {
    storedAdmin().isActive = false;
    const inactive = await rejected(getMe(storedAdmin().id, deps()));
    const missing = await rejected(getMe(randomUUID(), deps()));

    expect(errorShape(inactive)).toBe(SESSION_EXPIRED);
    expect(errorShape(missing)).toBe(SESSION_EXPIRED);
  });
});

describe('findSessionAuthState', () => {
  /** The session the access token of `result` is bound to. */
  const sessionOf = async (result: { accessToken: string }) => {
    const subject = await verifyAccessToken(result.accessToken, {
      secret: authConfig.jwtAccessSecret,
      now: clock,
    });
    if (!subject) throw new Error('access token did not verify');
    return subject;
  };
  const stateOf = async (result: { accessToken: string }) => {
    const { adminId, sessionId } = await sessionOf(result);
    return findSessionAuthState(adminId, sessionId, deps());
  };

  it('reports a live session after login, with the DB id, role and active flag', async () => {
    const session = await attempt();
    const admin = storedAdmin();

    await expect(stateOf(session)).resolves.toEqual({
      id: admin.id,
      role: 'EDITOR',
      isActive: true,
      sessionLive: true,
    });
  });

  it('uses one admin lookup and no refresh-token query', async () => {
    const session = await attempt();
    vi.clearAllMocks();

    await stateOf(session);

    expect(db.spies.admin.findUnique).toHaveBeenCalledTimes(1);
    expect(db.spies.refreshToken.findUnique).not.toHaveBeenCalled();
    expect(db.spies.$transaction).not.toHaveBeenCalled();
  });

  it('stays live across a normal rotation, for the old and the new access token', async () => {
    const session = await attempt();
    const rotated = await rotate(session.refreshToken);

    expect((await sessionOf(rotated)).sessionId).toBe((await sessionOf(session)).sessionId);
    expect((await stateOf(session))?.sessionLive).toBe(true);
    expect((await stateOf(rotated))?.sessionLive).toBe(true);
  });

  it('ends at once on logout, for that family only', async () => {
    const session = await attempt();
    const other = await attempt();

    await signOut(session.refreshToken);

    expect((await stateOf(session))?.sessionLive).toBe(false);
    expect((await stateOf(other))?.sessionLive).toBe(true);
  });

  it('ends at once on reuse detection, for every access token of the family', async () => {
    const session = await attempt();
    const rotated = await rotate(session.refreshToken);

    await refreshRefused(session.refreshToken);

    expect((await stateOf(session))?.sessionLive).toBe(false);
    expect((await stateOf(rotated))?.sessionLive).toBe(false);
  });

  it('ends at the absolute expiry of the family, not a millisecond earlier', async () => {
    const session = await attempt();
    // Read now: the access token itself expires long before the family does.
    const { adminId, sessionId } = await sessionOf(session);
    const stateAt = (at: Date) =>
      findSessionAuthState(adminId, sessionId, { ...deps(), now: () => at });

    expect((await stateAt(new Date(session.refreshExpiresAt.getTime() - 1)))?.sessionLive).toBe(
      true,
    );
    expect((await stateAt(session.refreshExpiresAt))?.sessionLive).toBe(false);
  });

  it("is not live for another admin's family", async () => {
    const other = testAdmin({ email: 'other@skcinema.lk', passwordHash });
    db = inMemoryAuthDb({ admins: [testAdmin({ email: EMAIL, passwordHash }), other] });
    const mine = await attempt();
    const theirs = await attempt({ email: other.email });
    const { sessionId: theirSessionId } = await sessionOf(theirs);

    const state = await findSessionAuthState(storedAdmin().id, theirSessionId, deps());

    expect(state).toMatchObject({ id: storedAdmin().id, sessionLive: false });
    expect((await stateOf(mine))?.sessionLive).toBe(true);
  });

  it('reports a deactivated admin and returns null for an unknown one', async () => {
    const session = await attempt();
    storedAdmin().isActive = false;

    await expect(stateOf(session)).resolves.toMatchObject({ isActive: false, sessionLive: true });
    await expect(findSessionAuthState(randomUUID(), randomUUID(), deps())).resolves.toBeNull();
  });
});

describe('refresh: no oracle or secret leakage', () => {
  it('gives every refusal a byte-identical error', async () => {
    const errors: AppError[] = [];

    errors.push(await refreshRefused('not-a-real-token'));

    const reused = await attempt();
    await rotate(reused.refreshToken);
    errors.push(await refreshRefused(reused.refreshToken));

    const loggedOut = await attempt();
    await signOut(loggedOut.refreshToken);
    errors.push(await refreshRefused(loggedOut.refreshToken));

    const raced = await attempt();
    db.spies.refreshToken.updateMany.mockResolvedValueOnce({ count: 0 });
    errors.push(await refreshRefused(raced.refreshToken));

    const expiring = await attempt();
    clock = expiring.refreshExpiresAt;
    errors.push(await refreshRefused(expiring.refreshToken));

    clock = new Date('2026-10-30T04:30:00.000Z');
    const inactive = await attempt();
    storedAdmin().isActive = false;
    errors.push(await refreshRefused(inactive.refreshToken));

    expect(errors).toHaveLength(6);
    for (const error of errors) {
      expect(errorShape(error)).toBe(SESSION_EXPIRED);
    }
  });

  it('never puts raw or hashed tokens in audit rows, errors or other results', async () => {
    const session = await attempt();
    const first = await rotate(session.refreshToken);
    const second = await rotate(first.refreshToken);
    const errors = [errorShape(await refreshRefused(session.refreshToken))];

    const other = await attempt();
    await signOut(other.refreshToken);
    errors.push(errorShape(await refreshRefused(other.refreshToken)));

    const results = [session, first, second, other];
    const rawTokens = results.map((r) => r.refreshToken);
    const secrets = [...rawTokens, ...rawTokens.map(hashRefreshToken)];

    const serialised = JSON.stringify({ audits: db.auditLogs, errors });
    for (const secret of [...secrets, ...results.map((r) => r.accessToken)]) {
      expect(serialised).not.toContain(secret);
    }

    // Each rotation result carries only its own new raw token.
    for (const result of [first, second]) {
      const rest = JSON.stringify({ ...result, refreshToken: undefined });
      for (const secret of secrets) {
        expect(rest).not.toContain(secret);
      }
    }
    expect(JSON.stringify(db.refreshTokens)).not.toContain(first.refreshToken);
  });
});
