import { describe, expect, it } from 'vitest';
import { apiErrorSchema } from './errors.js';

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
