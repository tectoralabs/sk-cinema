import { randomUUID } from 'node:crypto';
import { SignJWT, UnsecuredJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from './tokens.js';

const SECRET = 'test-access-secret-at-least-32-characters-long';
const ADMIN_ID = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
const SESSION_ID = '0192f3a4-5b6c-7d8e-9f01-0000000000aa';
const subject = { adminId: ADMIN_ID, role: 'EDITOR', sessionId: SESSION_ID } as const;
const key = new TextEncoder().encode(SECRET);

function sign(opts: { ttlSeconds?: number; now?: Date } = {}) {
  return signAccessToken(subject, {
    secret: SECRET,
    ttlSeconds: opts.ttlSeconds ?? 900,
    ...(opts.now && { now: opts.now }),
  });
}

interface ForgeOverrides {
  alg?: string;
  sub?: string;
  iss?: string;
  aud?: string;
  claims?: Record<string, unknown>;
}

// A token with valid defaults that a single test can override.
function forge(overrides: ForgeOverrides = {}) {
  return new SignJWT({ role: 'EDITOR', typ: 'access', sid: SESSION_ID, ...overrides.claims })
    .setProtectedHeader({ alg: overrides.alg ?? 'HS256' })
    .setSubject(overrides.sub ?? ADMIN_ID)
    .setIssuer(overrides.iss ?? 'sk-cinema-api')
    .setAudience(overrides.aud ?? 'sk-cinema-admin')
    .setIssuedAt()
    .setExpirationTime('15m')
    .setJti('test-jti')
    .sign(key);
}

const encodePart = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const decodePart = (part: string | undefined) =>
  JSON.parse(Buffer.from(part ?? '', 'base64url').toString()) as Record<string, unknown>;

describe('signAccessToken / verifyAccessToken', () => {
  it('round-trips the admin id, role and session id', async () => {
    const token = await sign();
    await expect(verifyAccessToken(token, { secret: SECRET })).resolves.toEqual(subject);
  });

  it('carries the session id as the sid claim and round-trips any session id', async () => {
    const sessionId = randomUUID();
    const token = await signAccessToken(
      { ...subject, sessionId },
      { secret: SECRET, ttlSeconds: 900 },
    );
    expect(decodePart(token.split('.')[1])['sid']).toBe(sessionId);
    await expect(verifyAccessToken(token, { secret: SECRET })).resolves.toEqual({
      ...subject,
      sessionId,
    });
  });

  it('sets the expected header and claims', async () => {
    const now = new Date('2026-11-01T10:00:00Z');
    const [header, payload] = (await sign({ now })).split('.');
    expect(decodePart(header)).toEqual({ alg: 'HS256' });
    const claims = decodePart(payload);
    expect(claims).toMatchObject({
      sub: ADMIN_ID,
      role: 'EDITOR',
      typ: 'access',
      sid: SESSION_ID,
      iss: 'sk-cinema-api',
      aud: 'sk-cinema-admin',
      iat: now.getTime() / 1000,
      exp: now.getTime() / 1000 + 900,
    });
    expect(typeof claims['jti']).toBe('string');
  });

  it('uses a fresh jti for every token', async () => {
    const [a, b] = await Promise.all([sign(), sign()]);
    expect(decodePart(a.split('.')[1])['jti']).not.toBe(decodePart(b.split('.')[1])['jti']);
  });

  it('rejects an expired token', async () => {
    const now = new Date('2026-11-01T10:00:00Z');
    const token = await sign({ now, ttlSeconds: 900 });
    const justBefore = new Date(now.getTime() + 899_000);
    const atExpiry = new Date(now.getTime() + 900_000);
    await expect(verifyAccessToken(token, { secret: SECRET, now: justBefore })).resolves.toEqual(
      subject,
    );
    await expect(verifyAccessToken(token, { secret: SECRET, now: atExpiry })).resolves.toBeNull();
  });

  it('rejects a token signed with another secret', async () => {
    const token = await sign();
    await expect(verifyAccessToken(token, { secret: `${SECRET}-other` })).resolves.toBeNull();
  });

  it('rejects alg none', async () => {
    const token = new UnsecuredJWT({ role: 'EDITOR', typ: 'access', sid: SESSION_ID })
      .setSubject(ADMIN_ID)
      .setIssuer('sk-cinema-api')
      .setAudience('sk-cinema-admin')
      .setIssuedAt()
      .setExpirationTime('15m')
      .setJti('test-jti')
      .encode();
    await expect(verifyAccessToken(token, { secret: SECRET })).resolves.toBeNull();
  });

  it('rejects a token signed with HS512', async () => {
    const token = await forge({ alg: 'HS512' });
    await expect(verifyAccessToken(token, { secret: SECRET })).resolves.toBeNull();
  });

  it('rejects a forged RS256 header on an HS256 signature', async () => {
    const [, payload, signature] = (await sign()).split('.');
    const token = `${encodePart({ alg: 'RS256' })}.${payload}.${signature}`;
    await expect(verifyAccessToken(token, { secret: SECRET })).resolves.toBeNull();
  });

  it('accepts an unmodified forged token (control for the cases below)', async () => {
    await expect(verifyAccessToken(await forge(), { secret: SECRET })).resolves.toEqual(subject);
  });

  it.each<[string, ForgeOverrides]>([
    ['wrong typ', { claims: { typ: 'refresh' } }],
    ['missing typ', { claims: { typ: undefined } }],
    ['wrong aud', { aud: 'sk-cinema-web' }],
    ['wrong iss', { iss: 'someone-else' }],
    ['invalid role', { claims: { role: 'ADMIN' } }],
    ['lowercase role', { claims: { role: 'editor' } }],
    ['non-uuid sub', { sub: 'not-a-uuid' }],
    // Pre-T10a tokens had no sid: they must not authenticate.
    ['missing sid', { claims: { sid: undefined } }],
    ['non-uuid sid', { claims: { sid: 'not-a-uuid' } }],
    ['empty sid', { claims: { sid: '' } }],
    ['numeric sid', { claims: { sid: 42 } }],
  ])('rejects a token with %s', async (_name, overrides) => {
    const token = await forge(overrides);
    await expect(verifyAccessToken(token, { secret: SECRET })).resolves.toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const [header, payload, signature] = (await sign()).split('.');
    const claims = { ...decodePart(payload), role: 'SUPER_ADMIN' };
    const token = `${header}.${encodePart(claims)}.${signature}`;
    await expect(verifyAccessToken(token, { secret: SECRET })).resolves.toBeNull();
  });

  it.each(['', 'garbage', 'a.b.c'])('rejects a malformed token (%j)', async (token) => {
    await expect(verifyAccessToken(token, { secret: SECRET })).resolves.toBeNull();
  });
});

describe('generateRefreshToken', () => {
  it('returns 43-char base64url tokens that are unique', () => {
    const tokens = Array.from({ length: 50 }, () => generateRefreshToken());
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe('hashRefreshToken', () => {
  it('returns a deterministic 64-char hex digest', () => {
    const token = generateRefreshToken();
    const hash = hashRefreshToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRefreshToken(token)).toBe(hash);
    expect(hashRefreshToken(generateRefreshToken())).not.toBe(hash);
  });

  it('matches a known SHA-256 vector', () => {
    expect(hashRefreshToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
