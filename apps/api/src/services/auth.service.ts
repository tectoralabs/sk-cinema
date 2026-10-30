import { randomUUID } from 'node:crypto';
import { ERROR_CODES, type AdminProfile } from '@sk-cinema/shared';
import type { Config } from '../config/env.js';
import type { Admin, Prisma, PrismaClient } from '../generated/prisma/client.js';
import { AppError } from '../lib/errors.js';
import { verifyDummyPassword, verifyPassword } from '../lib/password.js';
import { generateRefreshToken, hashRefreshToken, signAccessToken } from '../lib/tokens.js';
import {
  IP_ADDRESS_MAX_LENGTH,
  USER_AGENT_MAX_LENGTH,
  fitColumn,
  writeAudit,
} from './audit.service.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const AUDIT_ENTITY = 'Admin';

/**
 * Every refused login (unknown email, wrong password, locked, deactivated) gets exactly
 * this error, so responses never reveal whether an account exists or why it was refused.
 */
export const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';

const invalidCredentials = () =>
  new AppError(401, ERROR_CODES.INVALID_CREDENTIALS, INVALID_CREDENTIALS_MESSAGE);

export type AuthDb = Pick<PrismaClient, 'admin' | 'refreshToken' | 'auditLog' | '$transaction'>;

export interface AuthServiceDeps {
  db: AuthDb;
  config: Config['auth'];
  /** Injectable clock for tests. Defaults to the current time. */
  now?: () => Date;
}

export interface LoginInput {
  /** Already trimmed and lowercased by loginBodySchema. */
  email: string;
  password: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

export interface LoginResult {
  admin: AdminProfile;
  accessToken: string;
  /** Raw token for the cookie only. Only its SHA-256 is stored. */
  refreshToken: string;
  refreshExpiresAt: Date;
}

type FailureReason = 'unknown_email' | 'locked' | 'inactive' | 'bad_password';

const adminLoginSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  passwordHash: true,
  isActive: true,
  mustChangePassword: true,
  lockedUntil: true,
} as const satisfies Prisma.AdminSelect;

type LoginAdmin = Pick<Admin, keyof typeof adminLoginSelect>;

function toAdminProfile(admin: LoginAdmin): AdminProfile {
  return {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
    mustChangePassword: admin.mustChangePassword,
  };
}

/**
 * Checks credentials and, on success, starts a new refresh-token family.
 * Throws a 401 INVALID_CREDENTIALS AppError for every kind of refusal.
 * Never logs or audits the password or any token.
 */
export async function login(input: LoginInput, deps: AuthServiceDeps): Promise<LoginResult> {
  const { db, config } = deps;
  const now = deps.now?.() ?? new Date();
  const client = {
    ipAddress: fitColumn(input.ipAddress, IP_ADDRESS_MAX_LENGTH),
    userAgent: fitColumn(input.userAgent, USER_AGENT_MAX_LENGTH),
  };

  const refuse = async (reason: FailureReason, adminId: string | null): Promise<never> => {
    await writeAudit(db, {
      action: 'LOGIN_FAILED',
      adminId,
      entity: AUDIT_ENTITY,
      entityId: adminId,
      // The attempted email is deliberately not recorded (not even hashed).
      details: { reason },
      ...client,
    });
    throw invalidCredentials();
  };

  const admin = await db.admin.findUnique({
    where: { email: input.email },
    select: adminLoginSelect,
  });

  if (!admin) {
    await verifyDummyPassword(input.password);
    return refuse('unknown_email', null);
  }

  // Locked and inactive accounts never reach the real hash, but burn the same argon2 work.
  if (admin.lockedUntil && admin.lockedUntil.getTime() > now.getTime()) {
    await verifyDummyPassword(input.password);
    return refuse('locked', admin.id);
  }

  if (!admin.isActive) {
    await verifyDummyPassword(input.password);
    return refuse('inactive', admin.id);
  }

  const passwordOk = await verifyPassword(admin.passwordHash, input.password);

  if (!passwordOk) {
    await recordFailedAttempt(admin, now, deps, client);
    return refuse('bad_password', admin.id);
  }

  const refreshToken = generateRefreshToken();
  const refreshExpiresAt = new Date(now.getTime() + config.refreshTokenTtlHours * HOUR_MS);
  const accessToken = await signAccessToken(
    { adminId: admin.id, role: admin.role },
    { secret: config.jwtAccessSecret, ttlSeconds: config.accessTokenTtlSeconds, now },
  );

  await db.$transaction(async (tx) => {
    await tx.admin.update({
      where: { id: admin.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
      select: { id: true },
    });
    await tx.refreshToken.create({
      data: {
        adminId: admin.id,
        tokenHash: hashRefreshToken(refreshToken),
        // A new family per login; rotations keep this id and this absolute expiry.
        familyId: randomUUID(),
        expiresAt: refreshExpiresAt,
        ...client,
      },
      select: { id: true },
    });
    await writeAudit(tx, {
      action: 'LOGIN',
      adminId: admin.id,
      entity: AUDIT_ENTITY,
      entityId: admin.id,
      ...client,
    });
  });

  return { admin: toAdminProfile(admin), accessToken, refreshToken, refreshExpiresAt };
}

/**
 * Counts a wrong password without a JS read-modify-write:
 * 1. If an earlier lock has expired, a conditional update (matching only while
 *    lockedUntil <= now) zeroes the counter and clears the lock. Concurrent requests
 *    cannot double-reset: once one commits, lockedUntil is null and the filter no longer matches.
 * 2. The counter is incremented in SQL and the new value read back.
 * 3. Reaching the limit sets lockedUntil and audits ACCOUNT_LOCKED.
 */
async function recordFailedAttempt(
  admin: LoginAdmin,
  now: Date,
  { db, config }: AuthServiceDeps,
  client: { ipAddress: string | null; userAgent: string | null },
): Promise<void> {
  if (admin.lockedUntil) {
    await db.admin.updateMany({
      where: { id: admin.id, lockedUntil: { lte: now } },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
  }

  const { failedLoginCount } = await db.admin.update({
    where: { id: admin.id },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true },
  });

  if (failedLoginCount < config.loginMaxFailedAttempts) return;

  const lockedUntil = new Date(now.getTime() + config.loginLockoutMinutes * MINUTE_MS);
  await db.admin.update({
    where: { id: admin.id },
    data: { lockedUntil },
    select: { id: true },
  });
  await writeAudit(db, {
    action: 'ACCOUNT_LOCKED',
    adminId: admin.id,
    entity: AUDIT_ENTITY,
    entityId: admin.id,
    details: {
      failedLoginCount,
      lockedUntil: lockedUntil.toISOString(),
      lockoutMinutes: config.loginLockoutMinutes,
    },
    ...client,
  });
}
