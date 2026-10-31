import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadConfig } from './env.js';

const validEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:s3cret-pass@db.example.com/neondb?connect_timeout=15',
  CORS_ORIGINS: 'http://localhost:5173, http://localhost:3000/',
  ADMIN_ORIGINS: 'http://localhost:5174/',
  JWT_ACCESS_SECRET: 'jwt-access-secret-value-0123456789abcdef',
  CSRF_SECRET: 'csrf-secret-value-0123456789abcdef-012345',
};

function loadError(env: Record<string, string>): EnvValidationError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    expect(loadConfig(validEnv)).toMatchObject({
      nodeEnv: 'development',
      isProduction: false,
      port: 4000,
      logLevel: 'info',
      corsOrigins: ['http://localhost:5173', 'http://localhost:3000'],
      adminOrigins: ['http://localhost:5174'],
      trustProxy: 0,
      rateLimit: { windowMs: 60_000, max: 120 },
      auth: {
        jwtAccessSecret: validEnv.JWT_ACCESS_SECRET,
        csrfSecret: validEnv.CSRF_SECRET,
        accessTokenTtlSeconds: 900,
        refreshTokenTtlHours: 168,
        loginMaxFailedAttempts: 5,
        loginLockoutMinutes: 15,
        loginRateLimit: { windowMs: 900_000, max: 10 },
      },
    });
  });

  it('coerces numeric variables', () => {
    const config = loadConfig({
      ...validEnv,
      PORT: '8080',
      TRUST_PROXY: '2',
      RATE_LIMIT_MAX: '50',
    });
    expect(config.port).toBe(8080);
    expect(config.trustProxy).toBe(2);
    expect(config.rateLimit.max).toBe(50);
  });

  it('refuses to start when required variables are missing', () => {
    const { problems } = loadError({});
    expect(problems.some((p) => p.startsWith('DATABASE_URL'))).toBe(true);
    expect(problems.some((p) => p.startsWith('CORS_ORIGINS'))).toBe(true);
    expect(problems.some((p) => p.startsWith('ADMIN_ORIGINS'))).toBe(true);
    expect(problems.some((p) => p.startsWith('JWT_ACCESS_SECRET'))).toBe(true);
    expect(problems.some((p) => p.startsWith('CSRF_SECRET'))).toBe(true);
  });

  it('coerces auth variables at their bounds', () => {
    const { auth } = loadConfig({
      ...validEnv,
      ACCESS_TOKEN_TTL_SECONDS: '60',
      REFRESH_TOKEN_TTL_HOURS: '720',
      LOGIN_MAX_FAILED_ATTEMPTS: '3',
      LOGIN_LOCKOUT_MINUTES: '1440',
      LOGIN_RATE_LIMIT_WINDOW_MS: '60000',
      LOGIN_RATE_LIMIT_MAX: '100',
    });
    expect(auth).toMatchObject({
      accessTokenTtlSeconds: 60,
      refreshTokenTtlHours: 720,
      loginMaxFailedAttempts: 3,
      loginLockoutMinutes: 1440,
      loginRateLimit: { windowMs: 60_000, max: 100 },
    });
  });

  it.each(['JWT_ACCESS_SECRET', 'CSRF_SECRET'])('requires %s in every environment', (name) => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      const env = Object.fromEntries(
        Object.entries({
          ...validEnv,
          NODE_ENV,
          CORS_ORIGINS: 'https://skcinema.lk',
          ADMIN_ORIGINS: 'https://admin.skcinema.lk',
        }).filter(([key]) => key !== name),
      );
      const { problems } = loadError(env);
      expect(problems).toEqual([`${name}: is required`]);
    }
  });

  it.each(['JWT_ACCESS_SECRET', 'CSRF_SECRET'])(
    'rejects a %s shorter than 32 characters',
    (name) => {
      expect(() => loadConfig({ ...validEnv, [name]: 'a'.repeat(32) })).not.toThrow();
      const { problems } = loadError({ ...validEnv, [name]: 'a'.repeat(31) });
      expect(problems).toEqual([`${name}: must be at least 32 characters`]);
    },
  );

  it('rejects identical JWT and CSRF secrets', () => {
    const { problems } = loadError({ ...validEnv, CSRF_SECRET: validEnv.JWT_ACCESS_SECRET });
    expect(problems).toEqual(['CSRF_SECRET: must differ from JWT_ACCESS_SECRET']);
  });

  it.each([
    ['PORT', 'not-a-number'],
    ['PORT', '70000'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'verbose'],
    ['TRUST_PROXY', '-1'],
    ['DATABASE_URL', 'mysql://user@host/db'],
    ['CORS_ORIGINS', 'not a url'],
    ['CORS_ORIGINS', 'https://example.com/path'],
    ['CORS_ORIGINS', 'ftp://example.com'],
    ['CORS_ORIGINS', ' , '],
    ['ADMIN_ORIGINS', 'not a url'],
    ['ADMIN_ORIGINS', 'https://admin.example.com/path'],
    ['ADMIN_ORIGINS', 'ftp://admin.example.com'],
    ['ADMIN_ORIGINS', 'https://user:pw@admin.example.com'],
    ['ADMIN_ORIGINS', ' , '],
    ['ADMIN_ORIGINS', ''],
    ['ACCESS_TOKEN_TTL_SECONDS', '59'],
    ['ACCESS_TOKEN_TTL_SECONDS', '3601'],
    ['ACCESS_TOKEN_TTL_SECONDS', '900.5'],
    ['ACCESS_TOKEN_TTL_SECONDS', 'abc'],
    ['REFRESH_TOKEN_TTL_HOURS', '0'],
    ['REFRESH_TOKEN_TTL_HOURS', '721'],
    ['LOGIN_MAX_FAILED_ATTEMPTS', '2'],
    ['LOGIN_MAX_FAILED_ATTEMPTS', '21'],
    ['LOGIN_LOCKOUT_MINUTES', '0'],
    ['LOGIN_LOCKOUT_MINUTES', '1441'],
    ['LOGIN_RATE_LIMIT_WINDOW_MS', '59999'],
    ['LOGIN_RATE_LIMIT_WINDOW_MS', '86400001'],
    ['LOGIN_RATE_LIMIT_MAX', '0'],
    ['LOGIN_RATE_LIMIT_MAX', '101'],
  ])('rejects invalid %s=%j', (name, value) => {
    const { problems } = loadError({ ...validEnv, [name]: value });
    expect(problems.some((p) => p.startsWith(name))).toBe(true);
  });

  it('requires https origins in production', () => {
    const { problems } = loadError({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://skcinema.lk,http://www.skcinema.lk',
      ADMIN_ORIGINS: 'https://admin.skcinema.lk',
    });
    expect(problems).toEqual(['CORS_ORIGINS.1: must use https in production']);
  });

  it('requires https admin origins in production', () => {
    const { problems } = loadError({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://skcinema.lk',
      ADMIN_ORIGINS: 'https://admin.skcinema.lk,http://admin2.skcinema.lk',
    });
    expect(problems).toEqual(['ADMIN_ORIGINS.1: must use https in production']);
  });

  it('parses https admin origins in production', () => {
    const config = loadConfig({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://skcinema.lk',
      ADMIN_ORIGINS: ' https://admin.skcinema.lk/ , https://staff.skcinema.lk ',
    });
    expect(config.corsOrigins).toEqual(['https://skcinema.lk']);
    expect(config.adminOrigins).toEqual(['https://admin.skcinema.lk', 'https://staff.skcinema.lk']);
  });

  it('requires ADMIN_ORIGINS even when CORS_ORIGINS is set', () => {
    const env = Object.fromEntries(
      Object.entries(validEnv).filter(([key]) => key !== 'ADMIN_ORIGINS'),
    );
    expect(loadError(env).problems).toEqual(['ADMIN_ORIGINS: is required']);
  });

  it('rejects an origin listed as both public and admin', () => {
    const { problems } = loadError({
      ...validEnv,
      CORS_ORIGINS: 'http://localhost:5173',
      ADMIN_ORIGINS: 'http://localhost:5174,http://localhost:5173/',
    });
    expect(problems).toEqual(['ADMIN_ORIGINS.1: must not also be listed in CORS_ORIGINS']);
  });

  it('never includes origin values in the error', () => {
    const error = loadError({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://skcinema.lk',
      ADMIN_ORIGINS: 'http://secret-admin-host.example,https://skcinema.lk,not-a-url-xyz',
    });
    expect(error.message).toContain('ADMIN_ORIGINS');
    expect(error.message).not.toContain('secret-admin-host');
    expect(error.message).not.toContain('not-a-url-xyz');
    expect(error.message).not.toContain('skcinema.lk');
  });

  it('never includes variable values in the error', () => {
    const error = loadError({
      ...validEnv,
      DATABASE_URL: 'mysql://user:s3cret-pass@host/db',
      PORT: 'oops',
    });
    expect(error.message).not.toContain('s3cret-pass');
    expect(error.message).not.toContain('oops');
  });

  it('never includes secret values in the error', () => {
    const shortSecret = 'short-secret-value';
    const sharedSecret = 'shared-secret-value-0123456789abcdef-xyz';
    const shortError = loadError({ ...validEnv, JWT_ACCESS_SECRET: shortSecret });
    expect(shortError.message).toContain('JWT_ACCESS_SECRET');
    expect(shortError.message).not.toContain(shortSecret);

    const sameError = loadError({
      ...validEnv,
      JWT_ACCESS_SECRET: sharedSecret,
      CSRF_SECRET: sharedSecret,
    });
    expect(sameError.message).toContain('CSRF_SECRET');
    expect(sameError.message).not.toContain(sharedSecret);
  });
});
