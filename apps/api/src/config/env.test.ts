import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadConfig } from './env.js';

const validEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:s3cret-pass@db.example.com/neondb?connect_timeout=15',
  CORS_ORIGINS: 'http://localhost:5173, http://localhost:5174/',
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
      corsOrigins: ['http://localhost:5173', 'http://localhost:5174'],
      trustProxy: 0,
      rateLimit: { windowMs: 60_000, max: 120 },
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
  ])('rejects invalid %s=%j', (name, value) => {
    const { problems } = loadError({ ...validEnv, [name]: value });
    expect(problems.some((p) => p.startsWith(name))).toBe(true);
  });

  it('requires https origins in production', () => {
    const { problems } = loadError({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://skcinema.lk,http://admin.skcinema.lk',
    });
    expect(problems).toEqual(['CORS_ORIGINS.1: must use https in production']);
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
});
