import { describe, expect, it } from 'vitest';
import { emptyBodySchema, emptyQuerySchema } from './common.js';

describe.each([
  ['emptyBodySchema', emptyBodySchema],
  ['emptyQuerySchema', emptyQuerySchema],
])('%s', (_name, schema) => {
  it('accepts an empty object', () => {
    expect(schema.parse({})).toEqual({});
  });

  it('rejects any key', () => {
    expect(schema.safeParse({ refreshToken: 'x' }).success).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(schema.safeParse([]).success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
  });
});
