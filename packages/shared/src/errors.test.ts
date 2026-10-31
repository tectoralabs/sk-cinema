import { describe, expect, it } from 'vitest';
import { apiErrorSchema, ERROR_CODES } from './errors.js';

describe('ERROR_CODES', () => {
  it('maps each code to itself', () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) expect(value).toBe(key);
  });

  it('includes CONFLICT for uniqueness clashes such as a duplicate slug', () => {
    expect(ERROR_CODES.CONFLICT).toBe('CONFLICT');
  });
});

describe('apiErrorSchema', () => {
  it('accepts the standard error shape', () => {
    const body = { error: { code: 'NOT_FOUND', message: 'Not found' } };
    expect(apiErrorSchema.parse(body)).toEqual(body);
  });

  it('accepts optional details', () => {
    const body = {
      error: { code: 'VALIDATION_ERROR', message: 'Invalid', details: [{ path: 'x' }] },
    };
    expect(apiErrorSchema.safeParse(body).success).toBe(true);
  });

  it('rejects unknown keys', () => {
    const body = { error: { code: 'X', message: 'Y', stack: 'at foo' } };
    expect(apiErrorSchema.safeParse(body).success).toBe(false);
  });
});
