import { ERROR_CODES } from '@sk-cinema/shared';
import { adminProfileSchema } from '@sk-cinema/shared';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Admin } from '../generated/prisma/client.js';
import { AppError } from '../lib/errors.js';
import type * as PasswordModule from '../lib/password.js';
import { hashPassword, verifyDummyPassword, verifyPassword } from '../lib/password.js';
import { hashRefreshToken, verifyAccessToken } from '../lib/tokens.js';
import { inMemoryAuthDb, testAdmin, testConfig, type InMemoryAuthDb } from '../test/helpers.js';
import { INVALID_CREDENTIALS_MESSAGE, login, type LoginInput } from './auth.service.js';

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

/** Runs a login that must fail and returns the thrown AppError. */
async function refused(overrides: Partial<LoginInput> = {}): Promise<AppError> {
  const error: unknown = await attempt(overrides).then(
    () => {
      throw new Error('expected login to be refused');
    },
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

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
    ).resolves.toEqual({ adminId: admin.id, role: 'EDITOR' });

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
    // Incremented in SQL, not read-modify-written in JS.
    expect(db.spies.admin.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { failedLoginCount: { increment: 1 } } }),
    );
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
