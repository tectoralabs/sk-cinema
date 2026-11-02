import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { loginBodySchema } from './auth.js';
import { DEFAULT_BMS_BASE_URL, bmsBaseUrlSchema, bookingUrlOverrideSchema } from './bms.js';
import { multiLineTextSchema, querySearchSchema, singleLineTextSchema } from './common.js';
import {
  adminMovieListQuerySchema,
  movieCreateBodySchema,
  movieUpdateBodySchema,
  slugSchema,
  trailerUrlSchema,
} from './movies.js';
import {
  adminScreenListQuerySchema,
  screenCreateBodySchema,
  screenNameSchema,
  screenUpdateBodySchema,
} from './screens.js';
import {
  clockTimeSchema,
  publicShowtimeListQuerySchema,
  showtimeDateSchema,
  showtimeFormatSchema,
} from './showtimes.js';

/*
 * Control characters in every shared text field that reaches the database or a query. Postgres
 * refuses NUL in text, which would otherwise be a 500.
 */

const HUGE = 100_000;

type Path = (string | number)[];

/** A schema, how to place a value in its input, and where the issue must point. */
type Field = [name: string, schema: z.ZodType, wrap: (value: string) => unknown, path: Path];

const asIs = (value: string) => value;
const createMovie = (extra: (value: string) => object) => (value: string) => ({
  title: 'Title',
  durationMinutes: 100,
  ...extra(value),
});

const SINGLE_LINE_FIELDS: Field[] = [
  ['screenNameSchema', screenNameSchema, asIs, []],
  ['screen create: name', screenCreateBodySchema, (name) => ({ name }), ['name']],
  ['screen update: name', screenUpdateBodySchema, (name) => ({ name }), ['name']],
  ['querySearchSchema', querySearchSchema, asIs, []],
  ['screen list: search', adminScreenListQuerySchema, (search) => ({ search }), ['search']],
  ['movie list: search', adminMovieListQuerySchema, (search) => ({ search }), ['search']],
  ['movie create: title', movieCreateBodySchema, createMovie((title) => ({ title })), ['title']],
  ['movie update: title', movieUpdateBodySchema, (title) => ({ title }), ['title']],
  [
    'movie create: director',
    movieCreateBodySchema,
    createMovie((director) => ({ director })),
    ['director'],
  ],
  ['movie update: director', movieUpdateBodySchema, (director) => ({ director }), ['director']],
  [
    'movie create: language',
    movieCreateBodySchema,
    createMovie((language) => ({ language })),
    ['language'],
  ],
  ['movie update: language', movieUpdateBodySchema, (language) => ({ language }), ['language']],
  [
    'movie create: rating',
    movieCreateBodySchema,
    createMovie((rating) => ({ rating })),
    ['rating'],
  ],
  ['movie update: rating', movieUpdateBodySchema, (rating) => ({ rating }), ['rating']],
  [
    'movie create: genres entry',
    movieCreateBodySchema,
    createMovie((genre) => ({ genres: ['Drama', genre] })),
    ['genres', 1],
  ],
  [
    'movie update: genres entry',
    movieUpdateBodySchema,
    (genre) => ({ genres: ['Drama', genre] }),
    ['genres', 1],
  ],
  [
    'movie create: cast entry',
    movieCreateBodySchema,
    createMovie((name) => ({ cast: ['Someone', name] })),
    ['cast', 1],
  ],
  [
    'movie update: cast entry',
    movieUpdateBodySchema,
    (name) => ({ cast: ['Someone', name] }),
    ['cast', 1],
  ],
];

const SYNOPSIS_FIELDS: Field[] = [
  [
    'movie create: synopsis',
    movieCreateBodySchema,
    createMovie((synopsis) => ({ synopsis })),
    ['synopsis'],
  ],
  ['movie update: synopsis', movieUpdateBodySchema, (synopsis) => ({ synopsis }), ['synopsis']],
];

/** A secret-looking marker, to prove a message never echoes the value. */
const MARK = 'MARKER';

describe.each(SINGLE_LINE_FIELDS)('%s', (_name, schema, wrap, path) => {
  it.each([
    ['NUL inside', `a\u0000b${MARK}`],
    ['NUL at the start', `\u0000a${MARK}`],
    ['NUL at the end', `a${MARK}\u0000`],
    ['U+0001', `a\u0001b${MARK}`],
    ['U+001F', `a\u001fb${MARK}`],
    ['DEL', `a\u007fb${MARK}`],
    ['U+0085 (C1)', `a\u0085b${MARK}`],
    ['a tab inside', `a\tb${MARK}`],
    ['a line feed inside', `a\nb${MARK}`],
    ['a carriage return inside', `a\rb${MARK}`],
    ['a vertical tab inside', `a\u000bb${MARK}`],
    ['a form feed inside', `a\u000cb${MARK}`],
  ])('rejects %s, without echoing the value', (_label, value) => {
    const result = schema.safeParse(wrap(value));

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path,
        message: 'Remove tabs, line breaks and other hidden control characters',
      }),
    ]);
    expect(JSON.stringify(result.error?.issues)).not.toContain(MARK);
  });

  it('accepts ordinary text in any script, with its spaces', () => {
    expect(schema.safeParse(wrap('සිංහල தமிழ் Café 3D')).success).toBe(true);
  });

  it('rejects a ~100 KB value of NULs quickly, with only a length issue', () => {
    schema.safeParse(wrap('warm-up')); // JIT warm-up, not timed
    const start = performance.now();
    const result = schema.safeParse(wrap('\u0000'.repeat(HUGE)));
    const ms = performance.now() - start;

    expect(ms).toBeLessThan(50);
    expect(result.error?.issues.map((issue) => issue.code)).toEqual(['too_big']);
  });
});

describe.each(SYNOPSIS_FIELDS)('%s', (_name, schema, wrap, path) => {
  it.each([
    ['NUL', `a\u0000b${MARK}`],
    ['NUL at the end', `a${MARK}\u0000`],
    ['U+0001', `a\u0001b${MARK}`],
    ['DEL', `a\u007fb${MARK}`],
    ['U+0085 (C1)', `a\u0085b${MARK}`],
    ['a vertical tab inside', `a\u000bb${MARK}`],
    ['a form feed inside', `a\u000cb${MARK}`],
  ])('rejects %s, without echoing the value', (_label, value) => {
    const result = schema.safeParse(wrap(value));

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path,
        message: 'Remove hidden control characters (line breaks and tabs are fine)',
      }),
    ]);
    expect(JSON.stringify(result.error?.issues)).not.toContain(MARK);
  });

  it('keeps line feeds, carriage returns and tabs inside the text', () => {
    const synopsis = 'Line one\nLine two\r\nA\ttabbed line';
    expect(schema.parse(wrap(synopsis))).toMatchObject({ synopsis });
  });

  it('trims line breaks at the ends', () => {
    expect(schema.parse(wrap('\n\tText\r\n'))).toMatchObject({ synopsis: 'Text' });
  });

  it('rejects a ~100 KB value quickly, with only a length issue', () => {
    schema.safeParse(wrap('warm-up')); // JIT warm-up, not timed
    const start = performance.now();
    const result = schema.safeParse(wrap('\u0000'.repeat(HUGE)));
    const ms = performance.now() - start;

    expect(ms).toBeLessThan(50);
    expect(result.error?.issues.map((issue) => issue.code)).toEqual(['too_big']);
  });

  it('scans the longest allowed value quickly, a NUL at its very end', () => {
    schema.safeParse(wrap('warm-up')); // JIT warm-up, not timed
    const start = performance.now();
    const result = schema.safeParse(wrap(`${'a'.repeat(4999)}\u0000`));
    const ms = performance.now() - start;

    expect(ms).toBeLessThan(50);
    expect(result.error?.issues.map((issue) => issue.code)).toEqual(['custom']);
  });
});

describe('singleLineTextSchema / multiLineTextSchema', () => {
  it.each([
    ['a tab', '\tName'],
    ['a line feed', 'Name\n'],
    ['a carriage return and a line feed', 'Name\r\n'],
    ['a vertical tab', '\u000bName'],
    ['a form feed', 'Name\u000c'],
  ])('removes %s at the ends: trimming runs first', (_label, value) => {
    expect(singleLineTextSchema(10).parse(value)).toBe('Name');
    expect(multiLineTextSchema(10).parse(value)).toBe('Name');
  });

  it('only whitespace control characters is empty, not a control character error', () => {
    const result = singleLineTextSchema(10).safeParse('\t\r\n');
    expect(result.error?.issues.map((issue) => issue.code)).toEqual(['too_small']);
  });

  it('the length is the trimmed one', () => {
    expect(singleLineTextSchema(4).parse(' \tName\n ')).toBe('Name');
    expect(singleLineTextSchema(4).safeParse('Names').success).toBe(false);
  });

  it('querySearchSchema: whitespace and trimmed control characters are no search', () => {
    expect(querySearchSchema.parse('\t\r\n ')).toBeUndefined();
    expect(querySearchSchema.parse('abc\n')).toBe('abc');
  });
});

describe('fields already safe: their format has no room for a control character', () => {
  const YOUTUBE = 'https://youtu.be/dQw4w9WgXcQ';

  it.each<[string, z.ZodType, string]>([
    ['slug', slugSchema, 'a-b'],
    ['trailer URL', trailerUrlSchema, YOUTUBE],
    ['showtime format', showtimeFormatSchema, '2D'],
    ['booking URL override', bookingUrlOverrideSchema, DEFAULT_BMS_BASE_URL],
    ['BMS base URL', bmsBaseUrlSchema, DEFAULT_BMS_BASE_URL],
    ['showtime date', showtimeDateSchema, '2026-11-02'],
    ['clock time', clockTimeSchema, '10:00'],
  ])('%s', (_name, schema, valid) => {
    expect(schema.safeParse(valid).success).toBe(true);
    for (const control of ['\u0000', '\u0001']) {
      expect(schema.safeParse(`${valid}${control}`).success).toBe(false);
      expect(schema.safeParse(`${valid.slice(0, 1)}${control}${valid.slice(1)}`).success).toBe(
        false,
      );
    }
  });

  it('the public ?date= refuses them too', () => {
    expect(publicShowtimeListQuerySchema.safeParse({ date: '2026-11-02\u0000' }).success).toBe(
      false,
    );
  });

  it.each(['a\u0000b@skcinema.lk', 'admin@skcinema.lk\u0000', 'a\u0001b@skcinema.lk'])(
    'login email: %j is refused by the email pattern',
    (email) => {
      expect(loginBodySchema.safeParse({ email, password: 'x' }).success).toBe(false);
    },
  );

  it('login password: kept as typed, as it only ever goes to argon2, never to the database', () => {
    const password = 'pass\u0000word\u0001';
    expect(loginBodySchema.parse({ email: 'a@b.lk', password }).password).toBe(password);
  });
});
