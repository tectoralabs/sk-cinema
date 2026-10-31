import { describe, expect, it } from 'vitest';
import { emptyBodySchema } from './common.js';

describe('emptyBodySchema', () => {
  it('accepts an empty object', () => {
    expect(emptyBodySchema.parse({})).toEqual({});
  });

  it('rejects any key', () => {
    expect(emptyBodySchema.safeParse({ refreshToken: 'x' }).success).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(emptyBodySchema.safeParse([]).success).toBe(false);
    expect(emptyBodySchema.safeParse(null).success).toBe(false);
  });
});
