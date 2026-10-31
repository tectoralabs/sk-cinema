import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { adminRoleSchema, type AdminRole } from '@sk-cinema/shared';

const ALGORITHM = 'HS256';
const ISSUER = 'sk-cinema-api';
const AUDIENCE = 'sk-cinema-admin';
const ACCESS_TYP = 'access';

export interface AccessTokenSubject {
  adminId: string;
  role: AdminRole;
  /**
   * The refresh-token family (RefreshToken.familyId) the token was issued for, carried as the
   * `sid` claim. requireAuth refuses the token once that family has no live refresh token, so
   * logout and reuse detection end access at once instead of at `exp`.
   */
  sessionId: string;
}

export interface SignAccessTokenOptions {
  secret: string;
  ttlSeconds: number;
  now?: Date;
}

export interface VerifyAccessTokenOptions {
  secret: string;
  now?: Date;
}

const accessClaimsSchema = z.object({
  sub: z.uuid(),
  role: adminRoleSchema,
  typ: z.literal(ACCESS_TYP),
  sid: z.uuid(),
});

const encodeSecret = (secret: string) => new TextEncoder().encode(secret);

export function signAccessToken(
  { adminId, role, sessionId }: AccessTokenSubject,
  { secret, ttlSeconds, now = new Date() }: SignAccessTokenOptions,
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ role, typ: ACCESS_TYP, sid: sessionId })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(adminId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttlSeconds)
    .setJti(randomUUID())
    .sign(encodeSecret(secret));
}

/**
 * Resolves the subject of a valid access token, or null for any failure
 * (bad signature, wrong alg, expired, wrong iss/aud/typ, bad claims, missing or non-uuid sid).
 * Never throws. A valid token is not yet a valid session: requireAuth also checks the family.
 */
export async function verifyAccessToken(
  token: string,
  { secret, now }: VerifyAccessTokenOptions,
): Promise<AccessTokenSubject | null> {
  try {
    const { payload } = await jwtVerify(token, encodeSecret(secret), {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
      audience: AUDIENCE,
      requiredClaims: ['sub', 'iat', 'exp', 'jti', 'sid'],
      ...(now && { currentDate: now }),
    });
    const claims = accessClaimsSchema.safeParse(payload);
    if (!claims.success) return null;
    return { adminId: claims.data.sub, role: claims.data.role, sessionId: claims.data.sid };
  } catch {
    return null;
  }
}

/** 32 random bytes as base64url (43 chars). Only its hash is stored. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex (64 chars), matching RefreshToken.tokenHash. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
