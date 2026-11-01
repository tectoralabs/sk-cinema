import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ADMIN_MOVIE_SORT_FIELDS,
  adminMovieListQuerySchema,
  adminMovieSchema,
  movieCreateBodySchema,
  movieUpdateBodySchema,
} from '@sk-cinema/shared';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { Prisma, type Movie } from '../generated/prisma/client.js';
import { MemoryCache } from '../lib/cache.js';
import { AppError } from '../lib/errors.js';
import {
  inMemoryAuthDb,
  recordNotFoundError,
  testAdmin,
  testMovie,
  uniqueConstraintError,
} from '../test/helpers.js';
import {
  AUTO_SLUG_MAX_ATTEMPTS,
  adminMovieListOrderBy,
  adminMovieListWhere,
  createMovieAdminService,
  isMovieSlugClash,
  MOVIE_CHANGED_MESSAGE,
  movieDetailChanges,
  parseDateOnly,
  toAdminMovie,
} from './movie.admin.service.js';

const DETECTION_FILE = 'apps/api/src/services/movie.admin.service.ts';
const UPDATE_DETECTION =
  `Movie's unique fields changed: the slug-clash detection in ${DETECTION_FILE} ` +
  '(isMovieSlugClash, which treats every P2002 on Movie as a slug clash) must be updated';

// ---------------------------------------------------------------------------
// Guard: isMovieSlugClash assumes Movie's only unique columns are `id` and `slug`.
//
// Prisma 7's `prisma-client` generator exposes no runtime schema metadata with uniqueness:
// there is no `Prisma.dmmf`, and the generated `runtimeDataModel` (internal/class.ts) lists
// only field names, kinds and types. So the guard reads the source of truth, schema.prisma,
// with the minimal reader below, and cross-checks the reader against the generated client
// (field list at runtime, unique inputs at compile time) so that a reader bug or a stale
// client cannot make the guard pass silently.
// ---------------------------------------------------------------------------

const SCHEMA_PATH = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url));

/** Removes a `//` (or `///`) comment, ignoring `//` inside a double-quoted string. */
function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && inString) i += 1;
    else if (ch === '"') inString = !inString;
    else if (!inString && ch === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/** Replaces double-quoted strings with "", so text inside them is never read as an attribute. */
const blankStrings = (line: string) => line.replace(/"(?:[^"\\]|\\.)*"/g, '""');

interface ModelUniqueness {
  /** Every field name, in declaration order (scalar and relation fields). */
  fields: string[];
  /** Fields with a field-level `@id`. */
  idFields: string[];
  /** Fields with a field-level `@unique`. */
  uniqueFields: string[];
  /** Block-level `@@id(...)` and `@@unique(...)` attributes, as written. */
  blockAttributes: string[];
}

/**
 * Reads one `model X { ... }` block of schema.prisma. Deliberately minimal: one field or block
 * attribute per line (what `prisma format` produces), comments and string contents ignored.
 * Throws if the block is missing or unterminated rather than guessing.
 */
function readModelUniqueness(schema: string, model: string): ModelUniqueness {
  const lines = schema.split(/\r?\n/).map((line) => blankStrings(stripComment(line)).trim());
  const start = lines.findIndex((line) => new RegExp(`^model\\s+${model}\\s*\\{$`).test(line));
  if (start === -1) throw new Error(`schema.prisma: model ${model} not found`);
  const length = lines.slice(start + 1).findIndex((line) => line === '}');
  if (length === -1) throw new Error(`schema.prisma: model ${model} is not closed`);

  const result: ModelUniqueness = {
    fields: [],
    idFields: [],
    uniqueFields: [],
    blockAttributes: [],
  };
  for (const line of lines.slice(start + 1, start + 1 + length)) {
    if (line === '') continue;
    if (line.startsWith('@@')) {
      if (/^@@(id|unique)\b/.test(line)) result.blockAttributes.push(line);
      continue;
    }
    const [name = '', , ...attributes] = line.split(/\s+/);
    result.fields.push(name);
    const attrs = attributes.join(' ');
    if (/(^|\s)@id\b/.test(attrs)) result.idFields.push(name);
    if (/(^|\s)@unique\b/.test(attrs)) result.uniqueFields.push(name);
  }
  return result;
}

describe('guard: Movie unique fields (isMovieSlugClash assumption)', () => {
  const movie = readModelUniqueness(readFileSync(SCHEMA_PATH, 'utf8'), 'Movie');

  it('the schema reader sees every Movie scalar field the generated client has', () => {
    const scalarFields = Object.values(Prisma.MovieScalarFieldEnum) as string[];
    expect(
      movie.fields.filter((field) => scalarFields.includes(field)),
      'schema.prisma and the generated client disagree: run `prisma generate`, or fix the reader',
    ).toEqual(scalarFields);
  });

  it('Movie is unique only on id (@id) and slug (@unique)', () => {
    expect(
      {
        idFields: movie.idFields,
        uniqueFields: movie.uniqueFields,
        blockAttributes: movie.blockAttributes,
      },
      UPDATE_DETECTION,
    ).toEqual({ idFields: ['id'], uniqueFields: ['slug'], blockAttributes: [] });
  });

  it('the generated client agrees (checked by typecheck)', () => {
    // A scalar column is unique when `{ column: value }` alone is a valid findUnique `where`.
    type UniqueColumn = {
      [K in keyof Movie]-?: Pick<Movie, K> extends Prisma.MovieWhereUniqueInput ? K : never;
    }[keyof Movie];
    // A compound @@id / @@unique adds a `a_b` key that is neither a column nor a relation.
    type CompoundUnique = Exclude<
      keyof Prisma.MovieWhereUniqueInput,
      keyof Movie | keyof Prisma.MovieInclude | 'AND' | 'OR' | 'NOT'
    >;
    // If either line fails typecheck: see UPDATE_DETECTION above.
    expectTypeOf<UniqueColumn>().toEqualTypeOf<'id' | 'slug'>();
    expectTypeOf<CompoundUnique>().toEqualTypeOf<never>();
  });

  describe('the schema reader itself', () => {
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
  });
});

describe('isMovieSlugClash', () => {
  it('is true for a P2002 shaped like Prisma 7.10.1 + adapter-pg (no meta.target)', () => {
    const error = uniqueConstraintError('movie', 'slug');
    expect(error.meta?.['target']).toBeUndefined();
    expect(isMovieSlugClash(error)).toBe(true);
  });

  it('is false for other Prisma errors and anything else', () => {
    expect(isMovieSlugClash(recordNotFoundError('movie', 'an update'))).toBe(false);
    expect(isMovieSlugClash(new Error('P2002'))).toBe(false);
    expect(isMovieSlugClash({ code: 'P2002' })).toBe(false);
    expect(isMovieSlugClash(undefined)).toBe(false);
  });
});

describe('toAdminMovie', () => {
  it('maps every column, timestamps as ISO strings and releaseDate as YYYY-MM-DD', () => {
    const row = testMovie({
      releaseDate: parseDateOnly('2026-11-01'),
      deletedAt: new Date('2026-10-30T18:45:00.000Z'),
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: new Date('2026-10-02T00:00:00.000Z'),
      genres: ['Drama'],
    });
    const movie = toAdminMovie(row);

    expect(adminMovieSchema.parse(movie)).toEqual(movie);
    expect(movie).toMatchObject({
      releaseDate: '2026-11-01',
      deletedAt: '2026-10-30T18:45:00.000Z',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
    });
    expect(Object.keys(movie).sort()).toEqual(Object.keys(adminMovieSchema.shape).sort());
    // Lists are copies, never the row's arrays.
    expect(movie.genres).not.toBe(row.genres);
  });
});

describe('createMovieAdminService.create', () => {
  const setup = (movies: Movie[] = []) => {
    const admin = testAdmin();
    const db = inMemoryAuthDb({ admins: [admin], movies });
    const cache = new MemoryCache();
    const service = createMovieAdminService({ db: db.prisma, cache });
    const actor = { adminId: admin.id, ipAddress: '203.0.113.7', userAgent: 'test-agent' };
    return { db, cache, service, actor };
  };
  const body = (input: Record<string, unknown>) => movieCreateBodySchema.parse(input);

  it('stores optional fields the body omits as NULL and passes the defaults through', async () => {
    const { db, service, actor } = setup();

    await service.create(body({ title: 'Avatar', durationMinutes: 162 }), actor);

    expect(db.spies.movie.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          slug: 'avatar',
          title: 'Avatar',
          synopsis: null,
          durationMinutes: 162,
          language: null,
          genres: [],
          rating: null,
          director: null,
          cast: [],
          releaseDate: null,
          trailerUrl: null,
          status: 'UPCOMING',
        },
      }),
    );
  });

  it('skips every slug that clashed earlier, even when the clashing row is not visible', async () => {
    const { db, service, actor } = setup();
    // Clashes that leave no row behind: only the remembered slugs move the suffix on.
    for (let call = 1; call < AUTO_SLUG_MAX_ATTEMPTS; call += 1) {
      db.injectFault('movie', 'create', {
        onCall: call,
        error: uniqueConstraintError('movie', 'slug'),
      });
    }

    const movie = await service.create(body({ title: 'Avatar', durationMinutes: 162 }), actor);

    expect(movie.slug).toBe(`avatar-${String(AUTO_SLUG_MAX_ATTEMPTS)}`);
    expect(db.spies.$transaction).toHaveBeenCalledTimes(AUTO_SLUG_MAX_ATTEMPTS);
  });

  it('does not retry or convert errors that are not slug clashes', async () => {
    const { db, service, actor } = setup();
    const failure = new Error('connection reset');
    db.injectFault('movie', 'create', { error: failure });

    await expect(
      service.create(body({ title: 'Avatar', durationMinutes: 162 }), actor),
    ).rejects.toBe(failure);
    expect(db.spies.$transaction).toHaveBeenCalledTimes(1);
  });

  it('treats a P2002 from the audit write as an ordinary failure, not a slug clash', async () => {
    const { db, service, actor } = setup();
    const auditClash = uniqueConstraintError('auditLog', 'id');
    db.injectFault('auditLog', 'create', { error: auditClash });

    await expect(
      service.create(body({ title: 'Avatar', durationMinutes: 162 }), actor),
    ).rejects.toBe(auditClash);
    expect(db.spies.$transaction).toHaveBeenCalledTimes(1);
    expect(db.movies).toEqual([]);
  });

  it('refuses a title with nothing to slugify before touching the database', async () => {
    const { db, service, actor } = setup();

    const error = await service
      .create(body({ title: 'ගැහැණු ළමයා', durationMinutes: 120 }), actor)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(db.spies.movie.findMany).not.toHaveBeenCalled();
    expect(db.spies.$transaction).not.toHaveBeenCalled();
  });
});

describe('adminMovieListWhere', () => {
  const where = (input: Record<string, string>) =>
    adminMovieListWhere(adminMovieListQuerySchema.parse(input));

  it('excludes soft-deleted movies by default and adds nothing else', () => {
    expect(where({})).toEqual({ deletedAt: null });
  });

  it.each([
    ['exclude', { deletedAt: null }],
    ['include', {}],
    ['only', { deletedAt: { not: null } }],
  ])('deleted=%s', (deleted, expected) => {
    expect(where({ deleted })).toEqual(expected);
  });

  it('ANDs every filter and searches title OR slug with the escaped term', () => {
    expect(
      // The search is trimmed by the schema: the term is `50%_off\`.
      where({ search: ' 50%_off\\ ', status: 'ENDED', isActive: 'false', deleted: 'only' }),
    ).toEqual({
      status: 'ENDED',
      isActive: false,
      deletedAt: { not: null },
      OR: [
        { title: { contains: '50\\%\\_off\\\\', mode: 'insensitive' } },
        { slug: { contains: '50\\%\\_off\\\\', mode: 'insensitive' } },
      ],
    });
  });

  it('keeps isActive=false (a falsy value) as a filter', () => {
    expect(where({ isActive: 'false' })).toEqual({ isActive: false, deletedAt: null });
  });
});

describe('adminMovieListOrderBy', () => {
  it.each(ADMIN_MOVIE_SORT_FIELDS.filter((field) => field !== 'releaseDate'))(
    'sorts by %s, then id in the same direction',
    (sort) => {
      expect(adminMovieListOrderBy({ sort, order: 'asc' })).toEqual([
        { [sort]: 'asc' },
        { id: 'asc' },
      ]);
      expect(adminMovieListOrderBy({ sort, order: 'desc' })).toEqual([
        { [sort]: 'desc' },
        { id: 'desc' },
      ]);
    },
  );

  it.each(['asc', 'desc'] as const)('puts undated movies last for releaseDate %s', (order) => {
    expect(adminMovieListOrderBy({ sort: 'releaseDate', order })).toEqual([
      { releaseDate: { sort: order, nulls: 'last' } },
      { id: order },
    ]);
  });
});

describe('movieDetailChanges', () => {
  const current = toAdminMovie(
    testMovie({
      title: 'Avatar',
      synopsis: null,
      genres: ['Sci-Fi', 'Adventure'],
      cast: [],
      releaseDate: parseDateOnly('2026-11-01'),
    }),
  );
  const changes = (input: Record<string, unknown>) =>
    movieDetailChanges(current, movieUpdateBodySchema.parse(input));

  it('ignores omitted fields and lists only the ones whose value differs', () => {
    expect(changes({ title: 'Avatar', durationMinutes: 150 })).toEqual({
      durationMinutes: { from: 120, to: 150 },
    });
  });

  it('treats null as equal to a stored NULL, and a cleared value as a change', () => {
    expect(changes({ synopsis: null })).toEqual({});
    expect(changes({ releaseDate: null })).toEqual({
      releaseDate: { from: '2026-11-01', to: null },
    });
  });

  it('compares dates as YYYY-MM-DD', () => {
    expect(changes({ releaseDate: '2026-11-01' })).toEqual({});
    expect(changes({ releaseDate: '2026-11-02' })).toEqual({
      releaseDate: { from: '2026-11-01', to: '2026-11-02' },
    });
  });

  it('compares lists element by element: order and case matter', () => {
    expect(changes({ genres: ['Sci-Fi', 'Adventure'], cast: [] })).toEqual({});
    expect(changes({ genres: ['Adventure', 'Sci-Fi'] })).toEqual({
      genres: { from: ['Sci-Fi', 'Adventure'], to: ['Adventure', 'Sci-Fi'] },
    });
    expect(changes({ genres: ['sci-fi', 'Adventure'] })).toHaveProperty('genres');
    expect(changes({ genres: ['Sci-Fi'] })).toHaveProperty('genres');
  });
});

describe('createMovieAdminService updates', () => {
  const setup = (movies: Movie[]) => {
    const admin = testAdmin();
    const db = inMemoryAuthDb({ admins: [admin], movies });
    const service = createMovieAdminService({ db: db.prisma, cache: new MemoryCache() });
    const actor = { adminId: admin.id, ipAddress: '203.0.113.7', userAgent: 'test-agent' };
    return { db, service, actor };
  };

  it('stores the audit actor and the change in one row', async () => {
    const movie = testMovie({ status: 'UPCOMING' });
    const { db, service, actor } = setup([movie]);

    await service.setStatus(movie.id, 'NOW_SHOWING', actor);

    expect(db.auditLogs).toEqual([
      expect.objectContaining({
        action: 'STATUS_CHANGE',
        adminId: actor.adminId,
        entity: 'Movie',
        entityId: movie.id,
        details: { field: 'status', from: 'UPCOMING', to: 'NOW_SHOWING' },
        ipAddress: '203.0.113.7',
        userAgent: 'test-agent',
      }),
    ]);
  });

  it('turns a P2025 into a 409 "changed" when the movie is still live afterwards', async () => {
    const movie = testMovie();
    const { db, service, actor } = setup([movie]);
    db.injectFault('movie', 'update', { error: recordNotFoundError('movie', 'an update') });

    const error = await service.setActive(movie.id, false, actor).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: MOVIE_CHANGED_MESSAGE,
      details: undefined,
    });
    expect(db.auditLogs).toEqual([]);
    expect(db.movies).toEqual([movie]);
  });

  it.each([
    ['softDelete', testMovie()],
    ['restore', testMovie({ deletedAt: new Date('2026-10-01T00:00:00.000Z') })],
    ['hardDelete', testMovie({ deletedAt: new Date('2026-10-01T00:00:00.000Z') })],
  ] as const)(
    '%s turns a P2025 into a 409 "changed" when the movie is still in place afterwards',
    async (operation, movie) => {
      const { db, service, actor } = setup([movie]);
      const write = operation === 'hardDelete' ? 'delete' : 'update';
      db.injectFault('movie', write, {
        error: recordNotFoundError('movie', write === 'delete' ? 'a delete' : 'an update'),
      });

      const error = await service[operation](movie.id, actor).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        status: 409,
        code: 'CONFLICT',
        message: MOVIE_CHANGED_MESSAGE,
      });
      expect(db.auditLogs).toEqual([]);
      expect(db.movies).toEqual([movie]);
    },
  );

  it('propagates a failure of the re-read after a P2025 unchanged', async () => {
    const movie = testMovie();
    const { db, service, actor } = setup([movie]);
    const failure = new Error('connection reset');
    db.injectFault('movie', 'update', { error: recordNotFoundError('movie', 'an update') });
    db.injectFault('movie', 'findUnique', { onCall: 2, error: failure });

    await expect(service.setStatus(movie.id, 'NOW_SHOWING', actor)).rejects.toBe(failure);
    expect(db.auditLogs).toEqual([]);
  });

  it('does not treat errors other than P2002 / P2025 from the update as conflicts', async () => {
    const movie = testMovie();
    const { db, service, actor } = setup([movie]);
    const failure = new Error('connection reset');
    db.injectFault('movie', 'update', { error: failure });

    await expect(
      service.update(movie.id, movieUpdateBodySchema.parse({ title: 'New' }), actor),
    ).rejects.toBe(failure);
  });
});
