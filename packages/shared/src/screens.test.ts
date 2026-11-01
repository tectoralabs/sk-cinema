import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  SCREEN_CAPACITY_MAX,
  SCREEN_NAME_MAX_LENGTH,
  adminScreenListQuerySchema,
  adminScreenListResponseSchema,
  adminScreenResponseSchema,
  adminScreenSchema,
  screenActiveBodySchema,
  screenCreateBodySchema,
  screenIdParamsSchema,
  screenUpdateBodySchema,
} from './screens.js';

const SCREEN_ID = '01928f6e-7c3a-7b2e-9f4d-3a1b2c3d4e5f';

/** One safeParse and how long it took, after a warm-up parse so JIT compilation is not timed. */
function timeSafeParse<S extends z.ZodType>(schema: S, input: unknown) {
  schema.safeParse('warm-up');
  const start = performance.now();
  const result = schema.safeParse(input);
  return { result, ms: performance.now() - start };
}

const validAdminScreen = {
  id: SCREEN_ID,
  name: 'Screen 1',
  capacity: 250,
  isActive: true,
  deletedAt: null,
  createdAt: '2026-10-01T04:30:00.000Z',
  updatedAt: '2026-10-02T04:30:00.000Z',
};

describe('constants', () => {
  it('match the database column and the approved capacity limit', () => {
    expect(SCREEN_NAME_MAX_LENGTH).toBe(50);
    expect(SCREEN_CAPACITY_MAX).toBe(2000);
  });
});

describe('screenIdParamsSchema', () => {
  it('accepts a UUID', () => {
    expect(screenIdParamsSchema.parse({ id: SCREEN_ID })).toEqual({ id: SCREEN_ID });
  });

  it('rejects a non-UUID id and unknown keys', () => {
    expect(screenIdParamsSchema.safeParse({ id: '1' }).success).toBe(false);
    expect(screenIdParamsSchema.safeParse({ id: SCREEN_ID, extra: 'x' }).success).toBe(false);
  });
});

describe('screenCreateBodySchema', () => {
  it('accepts a name only', () => {
    expect(screenCreateBodySchema.parse({ name: 'Screen 1' })).toEqual({ name: 'Screen 1' });
  });

  it('trims the name', () => {
    expect(screenCreateBodySchema.parse({ name: '  Screen 2  ' }).name).toBe('Screen 2');
  });

  it('accepts a capacity or null', () => {
    expect(screenCreateBodySchema.parse({ name: 'A', capacity: 120 }).capacity).toBe(120);
    expect(screenCreateBodySchema.parse({ name: 'A', capacity: null }).capacity).toBeNull();
  });

  it('accepts a 50-character name and rejects 51', () => {
    expect(screenCreateBodySchema.safeParse({ name: 'n'.repeat(50) }).success).toBe(true);
    expect(screenCreateBodySchema.safeParse({ name: 'n'.repeat(51) }).success).toBe(false);
  });

  it.each(['', '   '])('rejects an empty name %j', (name) => {
    expect(screenCreateBodySchema.safeParse({ name }).success).toBe(false);
  });

  it('requires a name', () => {
    expect(screenCreateBodySchema.safeParse({ capacity: 10 }).success).toBe(false);
  });

  it.each([0, -1, 1.5, 2001, '100', Number.NaN])('rejects capacity %j', (capacity) => {
    expect(screenCreateBodySchema.safeParse({ name: 'A', capacity }).success).toBe(false);
  });

  it('accepts capacity bounds 1 and 2000', () => {
    expect(screenCreateBodySchema.safeParse({ name: 'A', capacity: 1 }).success).toBe(true);
    expect(screenCreateBodySchema.safeParse({ name: 'A', capacity: 2000 }).success).toBe(true);
  });

  it('rejects unknown keys, including isActive and deletedAt', () => {
    expect(screenCreateBodySchema.safeParse({ name: 'A', isActive: false }).success).toBe(false);
    expect(screenCreateBodySchema.safeParse({ name: 'A', deletedAt: null }).success).toBe(false);
    expect(screenCreateBodySchema.safeParse({ name: 'A', id: SCREEN_ID }).success).toBe(false);
  });

  it('rejects a ~100 KB name quickly', () => {
    const { result, ms } = timeSafeParse(screenCreateBodySchema, { name: 'n'.repeat(100_000) });
    expect(ms).toBeLessThan(50);
    expect(result.success).toBe(false);
  });
});

describe('screenUpdateBodySchema', () => {
  it('accepts any one field', () => {
    expect(screenUpdateBodySchema.parse({ name: 'Screen 3' })).toEqual({ name: 'Screen 3' });
    expect(screenUpdateBodySchema.parse({ capacity: 10 })).toEqual({ capacity: 10 });
  });

  it('accepts capacity null to clear it', () => {
    expect(screenUpdateBodySchema.parse({ capacity: null })).toEqual({ capacity: null });
  });

  it('rejects an empty body', () => {
    expect(screenUpdateBodySchema.safeParse({}).success).toBe(false);
  });

  it('rejects an empty name and unknown keys', () => {
    expect(screenUpdateBodySchema.safeParse({ name: '' }).success).toBe(false);
    expect(screenUpdateBodySchema.safeParse({ isActive: true }).success).toBe(false);
  });
});

describe('screenActiveBodySchema', () => {
  it('accepts a boolean', () => {
    expect(screenActiveBodySchema.parse({ isActive: false })).toEqual({ isActive: false });
  });

  it.each(['false', 0, null])('rejects %j', (isActive) => {
    expect(screenActiveBodySchema.safeParse({ isActive }).success).toBe(false);
  });

  it('rejects a missing value and unknown keys', () => {
    expect(screenActiveBodySchema.safeParse({}).success).toBe(false);
    expect(screenActiveBodySchema.safeParse({ isActive: true, name: 'x' }).success).toBe(false);
  });
});

describe('adminScreenListQuerySchema', () => {
  it('applies defaults', () => {
    expect(adminScreenListQuerySchema.parse({})).toEqual({
      deleted: 'exclude',
      page: 1,
      pageSize: 20,
    });
  });

  it('parses a full query', () => {
    expect(
      adminScreenListQuerySchema.parse({
        search: ' screen ',
        isActive: 'true',
        deleted: 'include',
        page: '2',
        pageSize: '50',
      }),
    ).toEqual({ search: 'screen', isActive: true, deleted: 'include', page: 2, pageSize: 50 });
  });

  it.each([
    { isActive: '1' },
    { deleted: 'all' },
    { page: '0' },
    { pageSize: '101' },
    { search: 's'.repeat(101) },
    { page: ['1', '2'] },
  ])('rejects %j', (query) => {
    expect(adminScreenListQuerySchema.safeParse(query).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(adminScreenListQuerySchema.safeParse({ sort: 'name' }).success).toBe(false);
  });
});

describe('adminScreenSchema and responses', () => {
  it('accepts an admin screen, including a soft-deleted one without capacity', () => {
    expect(adminScreenSchema.parse(validAdminScreen)).toEqual(validAdminScreen);
    const deleted = { ...validAdminScreen, capacity: null, deletedAt: '2026-10-03T00:00:00.000Z' };
    expect(adminScreenSchema.safeParse(deleted).success).toBe(true);
  });

  it('rejects unknown keys and non-ISO timestamps', () => {
    expect(adminScreenSchema.safeParse({ ...validAdminScreen, showtimes: [] }).success).toBe(false);
    expect(adminScreenSchema.safeParse({ ...validAdminScreen, createdAt: 'today' }).success).toBe(
      false,
    );
  });

  it('wraps in list and single responses', () => {
    expect(
      adminScreenListResponseSchema.safeParse({
        items: [validAdminScreen],
        page: 1,
        pageSize: 20,
        total: 1,
      }).success,
    ).toBe(true);
    expect(adminScreenListResponseSchema.safeParse({ items: [], page: 1 }).success).toBe(false);
    expect(adminScreenResponseSchema.safeParse({ screen: validAdminScreen }).success).toBe(true);
  });
});

describe('use with the api validate middleware', () => {
  it('keeps the at-least-one refinement after .strict()', () => {
    expect(screenUpdateBodySchema.strict().safeParse({}).success).toBe(false);
    expect(screenUpdateBodySchema.strict().safeParse({ capacity: null }).success).toBe(true);
  });
});
