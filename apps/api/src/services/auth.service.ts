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

/**
 * Every refused refresh (unknown, revoked, reused, expired, inactive admin) and every
 * refused getMe gets exactly this error, so responses never reveal which case it was.
 */
export const SESSION_EXPIRED_MESSAGE = 'Session expired';

/** The one 401 for every refused session (refresh, getMe, requireAuth). */
export const sessionExpired = () =>
  new AppError(401, ERROR_CODES.UNAUTHORIZED, SESSION_EXPIRED_MESSAGE);

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

export interface RefreshInput {
  /** Raw token from the refresh cookie. */
  refreshToken: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

export type RefreshResult = LoginResult;

export interface LogoutInput {
  refreshToken?: string | undefined;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

interface ClientInfo {
  ipAddress: string | null;
  userAgent: string | null;
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

const adminSessionSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  mustChangePassword: true,
} as const satisfies Prisma.AdminSelect;

/** Just enough to authorise a request: who, which role, and whether still allowed in. */
const adminAuthSelect = {
  id: true,
  role: true,
  isActive: true,
} as const satisfies Prisma.AdminSelect;

export type AdminAuthState = Pick<Admin, keyof typeof adminAuthSelect>;

const refreshTokenSelect = {
  id: true,
  adminId: true,
  familyId: true,
  expiresAt: true,
  revokedAt: true,
  replacedById: true,
  admin: { select: adminSessionSelect },
} as const satisfies Prisma.RefreshTokenSelect;

const clientInfo = (input: {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}): ClientInfo => ({
  ipAddress: fitColumn(input.ipAddress, IP_ADDRESS_MAX_LENGTH),
  userAgent: fitColumn(input.userAgent, USER_AGENT_MAX_LENGTH),
});

function toAdminProfile(
  admin: Pick<Admin, 'id' | 'email' | 'name' | 'role' | 'mustChangePassword'>,
): AdminProfile {
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
  const client = clientInfo(input);

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
  client: ClientInfo,
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

/** Thrown inside the rotation transaction when another request already claimed the token. */
class RotationConflict extends Error {}

/**
 * Rotates a refresh token: the presented token is revoked and replaced by a child in the
 * same family with the same absolute expiry. Presenting a rotated token again, or losing a
 * concurrent race for it, is treated as theft: the whole family is revoked and
 * TOKEN_REUSE_DETECTED is audited. Throws a 401 UNAUTHORIZED AppError for every refusal.
 * Successful refreshes are not audited.
 *
 * A temporary login lock deliberately neither blocks refresh nor revokes sessions: anyone
 * who knows an admin's email can trigger a lock, so revoking would let attackers log out
 * real admins. Deactivation (isActive=false) does revoke.
 */
export async function refresh(input: RefreshInput, deps: AuthServiceDeps): Promise<RefreshResult> {
  const { db, config } = deps;
  const now = deps.now?.() ?? new Date();
  const client = clientInfo(input);

  const token = await db.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(input.refreshToken) },
    select: refreshTokenSelect,
  });

  if (!token) throw sessionExpired();

  const reuseDetected = async (): Promise<never> => {
    await revokeFamily(db, token.familyId, now);
    await writeAudit(db, {
      action: 'TOKEN_REUSE_DETECTED',
      adminId: token.adminId,
      entity: AUDIT_ENTITY,
      entityId: token.adminId,
      details: { familyId: token.familyId },
      ...client,
    });
    throw sessionExpired();
  };

  if (token.revokedAt) {
    // Revoked with a successor is a replay; without one it was a logout or family revocation.
    if (token.replacedById) return reuseDetected();
    throw sessionExpired();
  }

  if (token.expiresAt.getTime() <= now.getTime()) throw sessionExpired();

  const { admin } = token;
  if (!admin.isActive) {
    await revokeFamily(db, token.familyId, now);
    throw sessionExpired();
  }

  const refreshToken = generateRefreshToken();
  try {
    await db.$transaction(async (tx) => {
      // Claims the parent. A concurrent request for the same token matches 0 rows here.
      const claimed = await tx.refreshToken.updateMany({
        where: { id: token.id, revokedAt: null },
        data: { revokedAt: now },
      });
      if (claimed.count !== 1) throw new RotationConflict();

      const child = await tx.refreshToken.create({
        data: {
          adminId: token.adminId,
          tokenHash: hashRefreshToken(refreshToken),
          familyId: token.familyId,
          expiresAt: token.expiresAt,
          ...client,
        },
        select: { id: true },
      });
      await tx.refreshToken.update({
        where: { id: token.id },
        data: { replacedById: child.id },
        select: { id: true },
      });
    });
  } catch (error) {
    // Handled after the rollback, so the family revocation commits on its own.
    if (error instanceof RotationConflict) return reuseDetected();
    throw error;
  }

  const accessToken = await signAccessToken(
    { adminId: admin.id, role: admin.role },
    { secret: config.jwtAccessSecret, ttlSeconds: config.accessTokenTtlSeconds, now },
  );

  return {
    admin: toAdminProfile(admin),
    accessToken,
    refreshToken,
    refreshExpiresAt: token.expiresAt,
  };
}

/**
 * Revokes every live token in the presented token's family. Idempotent: a missing, unknown
 * or already-revoked token is a no-op. LOGOUT is audited only when something was revoked.
 */
export async function logout(input: LogoutInput, deps: AuthServiceDeps): Promise<void> {
  if (!input.refreshToken) return;
  const { db } = deps;
  const now = deps.now?.() ?? new Date();

  const token = await db.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(input.refreshToken) },
    select: { adminId: true, familyId: true },
  });
  if (!token) return;

  await db.$transaction(async (tx) => {
    const revoked = await revokeFamily(tx, token.familyId, now);
    if (revoked === 0) return;
    await writeAudit(tx, {
      action: 'LOGOUT',
      adminId: token.adminId,
      entity: AUDIT_ENTITY,
      entityId: token.adminId,
      ...clientInfo(input),
    });
  });
}

/** The signed-in admin's profile. Throws 401 UNAUTHORIZED if missing or deactivated. */
export async function getMe(
  adminId: string,
  { db }: Pick<AuthServiceDeps, 'db'>,
): Promise<AdminProfile> {
  const admin = await db.admin.findUnique({ where: { id: adminId }, select: adminSessionSelect });
  if (!admin?.isActive) throw sessionExpired();
  return toAdminProfile(admin);
}

/**
 * The current id, role and active flag of an admin, or null if there is no such admin.
 * Used by requireAuth on every request, so the DB (not the token) decides role and access.
 */
export function findAdminAuthState(
  adminId: string,
  { db }: { db: Pick<AuthDb, 'admin'> },
): Promise<AdminAuthState | null> {
  return db.admin.findUnique({ where: { id: adminId }, select: adminAuthSelect });
}

/** Revokes every live token in a family and returns how many were revoked. */
async function revokeFamily(
  db: Pick<Prisma.TransactionClient, 'refreshToken'>,
  familyId: string,
  now: Date,
): Promise<number> {
  const { count } = await db.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: now },
  });
  return count;
}
