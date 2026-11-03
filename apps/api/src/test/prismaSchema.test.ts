import { describe, expect, it } from 'vitest';
import { readModelUniqueness, readSchemaPrisma } from './prismaSchema.js';

describe('readModelUniqueness (the schema reader of the unique-field guards)', () => {
  const read = (body: string) => readModelUniqueness(`model M {\n${body}\n}\n`, 'M');

  it('finds field-level @id and @unique, and block-level @@id / @@unique', () => {
    expect(
      read(
        [
          'a String @id @default(uuid(7)) @db.Uuid',
          'b String @unique(map: "b_key") @db.VarChar(10)',
          'c Int',
          '@@unique([a, c])',
          '@@id([a, b])',
          '@@index([c])',
        ].join('\n'),
      ),
    ).toEqual({
      fields: ['a', 'b', 'c'],
      idFields: ['a'],
      uniqueFields: ['b'],
      blockAttributes: ['@@unique([a, c])', '@@id([a, b])'],
    });
  });

  it('ignores comments and string contents', () => {
    expect(
      read(
        [
          '/// docs mentioning @unique',
          'a String // @unique in a comment',
          'b String @default("@unique // not a comment")',
          '// @@unique([a, b])',
        ].join('\n'),
      ),
    ).toEqual({ fields: ['a', 'b'], idFields: [], uniqueFields: [], blockAttributes: [] });
  });

  it('throws for a missing model', () => {
    expect(() => readModelUniqueness('model Other {\n}\n', 'Movie')).toThrow('not found');
  });

  it('reads the real schema.prisma', () => {
    expect(readSchemaPrisma()).toMatch(/^model Screen \{$/m);
  });
});
