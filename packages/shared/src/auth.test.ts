import { describe, expect, it } from 'vitest';
import {
  adminProfileResponseSchema,
  adminProfileSchema,
  adminRoleSchema,
  csrfTokenResponseSchema,
  loginBodySchema,
} from './auth.js';

const validProfile = {
  id: '01928f6e-7c3a-7b2e-9f4d-3a1b2c3d4e5f',
  email: 'admin@skcinema.lk',
  name: 'Admin',
  role: 'SUPER_ADMIN',
  mustChangePassword: false,
};

describe('loginBodySchema', () => {
  it('accepts a valid body', () => {
    const body = { email: 'admin@skcinema.lk', password: 'correct horse' };
    expect(loginBodySchema.parse(body)).toEqual(body);
  });

  it('normalises email case and whitespace', () => {
    const parsed = loginBodySchema.parse({ email: '  Admin@SKCinema.LK ', password: 'x' });
    expect(parsed.email).toBe('admin@skcinema.lk');
  });

  it('rejects an invalid email', () => {
    expect(loginBodySchema.safeParse({ email: 'not-an-email', password: 'x' }).success).toBe(false);
  });

  it('rejects an email longer than 254 characters', () => {
    const email = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.lk`;
    expect(email.length).toBeGreaterThan(254);
    expect(loginBodySchema.safeParse({ email, password: 'x' }).success).toBe(false);
  });

  it('rejects an empty password', () => {
    expect(loginBodySchema.safeParse({ email: 'a@b.lk', password: '' }).success).toBe(false);
  });

  it('rejects a password longer than 128 characters', () => {
    const password = 'p'.repeat(129);
    expect(loginBodySchema.safeParse({ email: 'a@b.lk', password }).success).toBe(false);
    expect(loginBodySchema.safeParse({ email: 'a@b.lk', password: 'p'.repeat(128) }).success).toBe(
      true,
    );
  });

  it('does not trim the password', () => {
    const parsed = loginBodySchema.parse({ email: 'a@b.lk', password: '  secret  ' });
    expect(parsed.password).toBe('  secret  ');
  });

  it('rejects unknown keys', () => {
    const body = { email: 'a@b.lk', password: 'x', role: 'SUPER_ADMIN' };
    expect(loginBodySchema.safeParse(body).success).toBe(false);
  });
});

describe('adminRoleSchema', () => {
  it('accepts the known roles', () => {
    expect(adminRoleSchema.parse('SUPER_ADMIN')).toBe('SUPER_ADMIN');
    expect(adminRoleSchema.parse('EDITOR')).toBe('EDITOR');
  });

  it('rejects other values', () => {
    expect(adminRoleSchema.safeParse('ADMIN').success).toBe(false);
    expect(adminRoleSchema.safeParse('editor').success).toBe(false);
  });
});

describe('adminProfileSchema', () => {
  it('accepts a valid profile', () => {
    expect(adminProfileSchema.parse(validProfile)).toEqual(validProfile);
  });

  it('rejects unknown keys', () => {
    const profile = { ...validProfile, passwordHash: '$argon2id$...' };
    expect(adminProfileSchema.safeParse(profile).success).toBe(false);
  });

  it('rejects an unknown role', () => {
    expect(adminProfileSchema.safeParse({ ...validProfile, role: 'OWNER' }).success).toBe(false);
  });
});

describe('adminProfileResponseSchema', () => {
  it('accepts { admin }', () => {
    const body = { admin: validProfile };
    expect(adminProfileResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects unknown keys', () => {
    const body = { admin: validProfile, token: 'abc' };
    expect(adminProfileResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe('csrfTokenResponseSchema', () => {
  it('accepts { csrfToken }', () => {
    expect(csrfTokenResponseSchema.parse({ csrfToken: 'abc' })).toEqual({ csrfToken: 'abc' });
  });

  it('rejects an empty token and unknown keys', () => {
    expect(csrfTokenResponseSchema.safeParse({ csrfToken: '' }).success).toBe(false);
    expect(csrfTokenResponseSchema.safeParse({ csrfToken: 'a', extra: 1 }).success).toBe(false);
  });
});
