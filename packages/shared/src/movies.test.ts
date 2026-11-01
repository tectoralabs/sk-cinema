import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  MOVIE_DURATION_MAX_MINUTES,
  MOVIE_DURATION_MIN_MINUTES,
  adminMovieListQuerySchema,
  adminMovieListResponseSchema,
  adminMovieResponseSchema,
  adminMovieSchema,
  movieActiveBodySchema,
  movieCreateBodySchema,
  movieIdParamsSchema,
  movieSlugParamsSchema,
  movieStatusBodySchema,
  movieStatusSchema,
  movieUpdateBodySchema,
  publicMovieListQuerySchema,
  publicMovieListResponseSchema,
  publicMovieResponseSchema,
  publicMovieSchema,
  slugSchema,
  trailerUrlSchema,
} from './movies.js';

const MOVIE_ID = '01928f6e-7c3a-7b2e-9f4d-3a1b2c3d4e5f';

/** One safeParse and how long it took, after a warm-up parse so JIT compilation is not timed. */
function timeSafeParse<S extends z.ZodType>(schema: S, input: unknown) {
  schema.safeParse('warm-up');
  const start = performance.now();
  const result = schema.safeParse(input);
  return { result, ms: performance.now() - start };
}

const validPublicMovie = {
  id: MOVIE_ID,
  slug: 'the-matara-story',
  title: 'The Matara Story',
  synopsis: 'A story.',
  durationMinutes: 125,
  language: 'Sinhala',
  genres: ['Drama'],
  rating: 'PG',
  director: 'A Director',
  cast: ['Actor One', 'Actor Two'],
  releaseDate: '2026-11-01',
  trailerUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  status: 'NOW_SHOWING',
  posterUrl: 'https://res.cloudinary.com/demo/image/upload/poster.jpg',
  bannerUrl: null,
};

const validAdminMovie = {
  ...validPublicMovie,
  posterPublicId: 'sk-cinema/posters/abc',
  bannerPublicId: null,
  isActive: true,
  deletedAt: null,
  createdAt: '2026-10-01T04:30:00.000Z',
  updatedAt: '2026-10-02T04:30:00.000Z',
};

const minimalCreate = { title: 'Movie', durationMinutes: 120 };

describe('movieStatusSchema', () => {
  it('accepts the three statuses', () => {
    for (const status of ['UPCOMING', 'NOW_SHOWING', 'ENDED']) {
      expect(movieStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it('rejects other values', () => {
    expect(movieStatusSchema.safeParse('now_showing').success).toBe(false);
    expect(movieStatusSchema.safeParse('ARCHIVED').success).toBe(false);
  });
});

describe('slugSchema', () => {
  it.each(['a', 'movie', 'movie-2026', 'a-b-c', '2026', 'x'.repeat(160)])('accepts %s', (slug) => {
    expect(slugSchema.safeParse(slug).success).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['uppercase', 'Movie'],
    ['leading hyphen', '-movie'],
    ['trailing hyphen', 'movie-'],
    ['double hyphen', 'movie--2026'],
    ['space', 'my movie'],
    ['underscore', 'my_movie'],
    ['non-ASCII', 'චිත්‍රපටය'],
    ['longer than 160', 'x'.repeat(161)],
  ])('rejects %s', (_label, slug) => {
    expect(slugSchema.safeParse(slug).success).toBe(false);
  });

  it('checks the length before the pattern, so the pattern never sees over-long input', () => {
    const result = slugSchema.safeParse(`${'x'.repeat(160)}!`);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.code)).toEqual(['too_big']);
  });

  it.each([
    ['hyphenated groups', `${'a-'.repeat(50_000)}!`],
    ['one long group', `${'a'.repeat(100_000)}-`],
  ])('rejects a ~100 KB malformed slug quickly with only a length issue (%s)', (_label, slug) => {
    const { result, ms } = timeSafeParse(slugSchema, slug);
    expect(ms).toBeLessThan(50);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.code)).toEqual(['too_big']);
  });
});

describe('trailerUrlSchema', () => {
  it.each([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s',
    'https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?si=AbC123_-x',
    '  https://youtu.be/dQw4w9WgXcQ  ',
  ])('accepts %s', (url) => {
    expect(trailerUrlSchema.safeParse(url).success).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    expect(trailerUrlSchema.parse('  https://youtu.be/dQw4w9WgXcQ ')).toBe(
      'https://youtu.be/dQw4w9WgXcQ',
    );
  });

  it.each([
    ['http scheme', 'http://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['javascript disguised', 'javascript://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['data scheme', 'data:text/html,<script>alert(1)</script>'],
    ['other host', 'https://vimeo.com/123456'],
    ['lookalike suffix', 'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ'],
    ['lookalike prefix', 'https://evilyoutube.com/watch?v=dQw4w9WgXcQ'],
    ['lookalike subdomain', 'https://www.youtube.com.evil.com/watch?v=dQw4w9WgXcQ'],
    ['youtu.be lookalike', 'https://youtu.be.evil.com/dQw4w9WgXcQ'],
    ['credentials', 'https://evil.com@www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['port', 'https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ'],
    ['other subdomain', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['missing video id', 'https://www.youtube.com/watch?list=PL123'],
    ['short video id', 'https://www.youtube.com/watch?v=abc'],
    ['other path', 'https://www.youtube.com/embed/dQw4w9WgXcQ'],
    ['fragment', 'https://youtu.be/dQw4w9WgXcQ#x'],
    ['protocol-relative', '//www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['empty', ''],
    ['uppercase scheme and host', 'HTTPS://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ'],
    ['default port', 'https://www.youtube.com:443/watch?v=dQw4w9WgXcQ'],
    ['dot segment', 'https://www.youtube.com/./watch?v=dQw4w9WgXcQ'],
    ['watch fragment', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=30'],
    ['watch without query', 'https://www.youtube.com/watch'],
    ['v only as a suffix of another name', 'https://www.youtube.com/watch?vv=dQw4w9WgXcQ'],
    ['12-character video id', 'https://www.youtube.com/watch?v=dQw4w9WgXcQX'],
    ['second question mark', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ?x=1'],
    ['space in the query', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3 0'],
    ['youtu.be extra path', 'https://youtu.be/dQw4w9WgXcQ/extra'],
    ['youtu.be short id', 'https://youtu.be/dQw4w9WgXc?si=x'],
    ['youtu.be second question mark', 'https://youtu.be/dQw4w9WgXcQ?si=a?b'],
    ['youtu.be credentials', 'https://user@youtu.be/dQw4w9WgXcQ'],
  ])('rejects %s', (_label, url) => {
    expect(trailerUrlSchema.safeParse(url).success).toBe(false);
  });

  it.each([
    'https://www.youtube.com/watch?&&v=dQw4w9WgXcQ&',
    'https://www.youtube.com/watch?a=1&v=dQw4w9WgXcQ&b=2&c',
    'https://youtu.be/dQw4w9WgXcQ?',
    'https://youtu.be/dQw4w9WgXcQ?a&&b=%20',
  ])('accepts edge-case query strings: %s', (url) => {
    expect(trailerUrlSchema.safeParse(url).success).toBe(true);
  });

  it('accepts exactly 500 characters and rejects 501 with only a length issue', () => {
    const prefix = 'https://youtu.be/dQw4w9WgXcQ?si=';
    const atMax = prefix + 'a'.repeat(500 - prefix.length);
    expect(trailerUrlSchema.safeParse(atMax).success).toBe(true);

    const result = trailerUrlSchema.safeParse(`${atMax}a`);
    expect(result.success).toBe(false);
    // The pattern check did not run on the over-long input (no second issue).
    expect(result.error?.issues.map((issue) => issue.code)).toEqual(['too_big']);
  });

  // Regression: the old watch-URL regex backtracked quadratically on this shape and took ~1.4 s
  // here, blocking the event loop. The input is the size the 100 KB JSON body limit allows.
  it.each([
    ['repeated v= parameters', `https://youtube.com/watch?${'v=aaaaaaaaaaa&'.repeat(7000)}!`],
    ['repeated empty parameters', `https://youtube.com/watch?${'&'.repeat(98_000)}!`],
    ['long youtu.be query', `https://youtu.be/dQw4w9WgXcQ?${'a&'.repeat(49_000)}!`],
  ])('rejects a ~100 KB adversarial URL quickly (%s)', (_label, url) => {
    expect(url.length).toBeGreaterThan(95_000);
    const { result, ms } = timeSafeParse(trailerUrlSchema, url);
    expect(ms).toBeLessThan(50);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.code)).toEqual(['too_big']);
  });
});

describe('movieIdParamsSchema / movieSlugParamsSchema', () => {
  it('accepts a UUID id', () => {
    expect(movieIdParamsSchema.parse({ id: MOVIE_ID })).toEqual({ id: MOVIE_ID });
  });

  it('rejects a non-UUID id', () => {
    expect(movieIdParamsSchema.safeParse({ id: '123' }).success).toBe(false);
  });

  it('accepts a valid slug and rejects an invalid one', () => {
    expect(movieSlugParamsSchema.safeParse({ slug: 'movie-1' }).success).toBe(true);
    expect(movieSlugParamsSchema.safeParse({ slug: 'Movie_1' }).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(movieIdParamsSchema.safeParse({ id: MOVIE_ID, extra: 'x' }).success).toBe(false);
    expect(movieSlugParamsSchema.safeParse({ slug: 'a', extra: 'x' }).success).toBe(false);
  });
});

describe('movieCreateBodySchema', () => {
  it('accepts a minimal body and applies defaults', () => {
    expect(movieCreateBodySchema.parse(minimalCreate)).toEqual({
      title: 'Movie',
      durationMinutes: 120,
      genres: [],
      cast: [],
      status: 'UPCOMING',
    });
  });

  it('accepts a full body', () => {
    const body = {
      title: '  The Matara Story  ',
      slug: 'the-matara-story',
      synopsis: 'A story.',
      durationMinutes: 125,
      language: 'Sinhala',
      genres: ['Drama', 'Family'],
      rating: 'PG',
      director: 'A Director',
      cast: ['Actor One'],
      releaseDate: '2026-11-01',
      trailerUrl: 'https://youtu.be/dQw4w9WgXcQ',
      status: 'NOW_SHOWING',
    };
    expect(movieCreateBodySchema.parse(body)).toEqual({ ...body, title: 'The Matara Story' });
  });

  it('accepts null for optional nullable fields', () => {
    const body = {
      ...minimalCreate,
      synopsis: null,
      language: null,
      rating: null,
      director: null,
      releaseDate: null,
      trailerUrl: null,
    };
    expect(movieCreateBodySchema.safeParse(body).success).toBe(true);
  });

  it('requires title and durationMinutes', () => {
    expect(movieCreateBodySchema.safeParse({ title: 'Movie' }).success).toBe(false);
    expect(movieCreateBodySchema.safeParse({ durationMinutes: 120 }).success).toBe(false);
  });

  it('rejects a blank or too-long title', () => {
    expect(movieCreateBodySchema.safeParse({ ...minimalCreate, title: '   ' }).success).toBe(false);
    const title = 't'.repeat(151);
    expect(movieCreateBodySchema.safeParse({ ...minimalCreate, title }).success).toBe(false);
    const max = 't'.repeat(150);
    expect(movieCreateBodySchema.safeParse({ ...minimalCreate, title: max }).success).toBe(true);
  });

  it('enforces durationMinutes bounds and integers', () => {
    for (const durationMinutes of [0, 601, 90.5, '120']) {
      expect(movieCreateBodySchema.safeParse({ ...minimalCreate, durationMinutes }).success).toBe(
        false,
      );
    }
    for (const durationMinutes of [1, 600]) {
      expect(movieCreateBodySchema.safeParse({ ...minimalCreate, durationMinutes }).success).toBe(
        true,
      );
    }
  });

  it('exports the durationMinutes bounds the API uses for its overlap query window', () => {
    expect(MOVIE_DURATION_MIN_MINUTES).toBe(1);
    expect(MOVIE_DURATION_MAX_MINUTES).toBe(600);
  });

  it('enforces text length limits', () => {
    const cases: [string, number][] = [
      ['synopsis', 5000],
      ['language', 50],
      ['rating', 20],
      ['director', 150],
    ];
    for (const [field, max] of cases) {
      const ok = { ...minimalCreate, [field]: 'x'.repeat(max) };
      const tooLong = { ...minimalCreate, [field]: 'x'.repeat(max + 1) };
      expect(movieCreateBodySchema.safeParse(ok).success).toBe(true);
      expect(movieCreateBodySchema.safeParse(tooLong).success).toBe(false);
    }
  });

  it('rejects empty strings for optional text fields (send null instead)', () => {
    for (const field of ['synopsis', 'language', 'rating', 'director']) {
      const body = { ...minimalCreate, [field]: '  ' };
      expect(movieCreateBodySchema.safeParse(body).success).toBe(false);
    }
  });

  it('trims genres and removes case-insensitive duplicates, keeping the first', () => {
    const parsed = movieCreateBodySchema.parse({
      ...minimalCreate,
      genres: [' Action ', 'Drama', 'action', 'ACTION', 'Drama'],
    });
    expect(parsed.genres).toEqual(['Action', 'Drama']);
  });

  it('enforces genre limits', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `G${i}`);
    expect(movieCreateBodySchema.safeParse({ ...minimalCreate, genres: eleven }).success).toBe(
      false,
    );
    const long = ['g'.repeat(31)];
    expect(movieCreateBodySchema.safeParse({ ...minimalCreate, genres: long }).success).toBe(false);
    expect(movieCreateBodySchema.safeParse({ ...minimalCreate, genres: [' '] }).success).toBe(
      false,
    );
  });

  it('enforces cast limits', () => {
    const thirtyOne = Array.from({ length: 31 }, (_, i) => `Actor ${i}`);
    expect(movieCreateBodySchema.safeParse({ ...minimalCreate, cast: thirtyOne }).success).toBe(
      false,
    );
    const long = ['c'.repeat(101)];
    expect(movieCreateBodySchema.safeParse({ ...minimalCreate, cast: long }).success).toBe(false);
    expect(movieCreateBodySchema.safeParse({ ...minimalCreate, cast: [''] }).success).toBe(false);
  });

  it.each(['2026-11-01', '2028-02-29', '2000-02-29'])('accepts release date %s', (releaseDate) => {
    expect(movieCreateBodySchema.safeParse({ ...minimalCreate, releaseDate }).success).toBe(true);
  });

  it.each([
    '2026-02-30',
    '2026-02-29',
    '2100-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-1-1',
    '01-11-2026',
    '2026-11-01T00:00:00Z',
    '2026/11/01',
    '',
  ])('rejects release date %s', (releaseDate) => {
    expect(movieCreateBodySchema.safeParse({ ...minimalCreate, releaseDate }).success).toBe(false);
  });

  it('rejects a non-YouTube trailer URL', () => {
    const body = {
      ...minimalCreate,
      trailerUrl: 'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
    };
    expect(movieCreateBodySchema.safeParse(body).success).toBe(false);
  });

  it('rejects an invalid slug or status', () => {
    expect(movieCreateBodySchema.safeParse({ ...minimalCreate, slug: 'Bad Slug' }).success).toBe(
      false,
    );
    expect(movieCreateBodySchema.safeParse({ ...minimalCreate, status: 'DRAFT' }).success).toBe(
      false,
    );
  });

  it.each([
    'isActive',
    'posterUrl',
    'posterPublicId',
    'bannerUrl',
    'bannerPublicId',
    'deletedAt',
    'id',
    'createdAt',
    'unknown',
  ])('rejects the %s key', (key) => {
    const body = { ...minimalCreate, [key]: key === 'isActive' ? true : 'x' };
    expect(movieCreateBodySchema.safeParse(body).success).toBe(false);
  });
});

describe('movieUpdateBodySchema', () => {
  it('accepts a single field', () => {
    expect(movieUpdateBodySchema.parse({ title: ' New ' })).toEqual({ title: 'New' });
  });

  it('accepts a slug change', () => {
    expect(movieUpdateBodySchema.parse({ slug: 'new-slug' })).toEqual({ slug: 'new-slug' });
  });

  it('accepts null to clear optional fields', () => {
    const body = {
      synopsis: null,
      language: null,
      rating: null,
      director: null,
      releaseDate: null,
      trailerUrl: null,
    };
    expect(movieUpdateBodySchema.parse(body)).toEqual(body);
  });

  it('rejects null for required fields', () => {
    for (const field of ['title', 'slug', 'durationMinutes', 'genres', 'cast']) {
      expect(movieUpdateBodySchema.safeParse({ [field]: null }).success).toBe(false);
    }
  });

  it('de-duplicates genres', () => {
    expect(movieUpdateBodySchema.parse({ genres: ['Drama', 'drama'] })).toEqual({
      genres: ['Drama'],
    });
  });

  it('does not add defaults for omitted fields', () => {
    expect(movieUpdateBodySchema.parse({ cast: ['A'] })).toEqual({ cast: ['A'] });
  });

  it('rejects an empty body', () => {
    expect(movieUpdateBodySchema.safeParse({}).success).toBe(false);
  });

  it('still rejects an empty body after .strict() (as the validate middleware applies)', () => {
    expect(movieUpdateBodySchema.strict().safeParse({}).success).toBe(false);
  });

  it('validates field values', () => {
    expect(movieUpdateBodySchema.safeParse({ releaseDate: '2026-02-30' }).success).toBe(false);
    expect(movieUpdateBodySchema.safeParse({ durationMinutes: 0 }).success).toBe(false);
    expect(
      movieUpdateBodySchema.safeParse({ trailerUrl: 'http://youtu.be/dQw4w9WgXcQ' }).success,
    ).toBe(false);
  });

  it.each([
    'status',
    'isActive',
    'posterUrl',
    'posterPublicId',
    'bannerUrl',
    'bannerPublicId',
    'deletedAt',
    'unknown',
  ])('rejects the %s key', (key) => {
    const value = key === 'isActive' ? false : key === 'status' ? 'ENDED' : 'x';
    expect(movieUpdateBodySchema.safeParse({ title: 'Movie', [key]: value }).success).toBe(false);
  });
});

describe('movieStatusBodySchema', () => {
  it('accepts a status', () => {
    expect(movieStatusBodySchema.parse({ status: 'ENDED' })).toEqual({ status: 'ENDED' });
  });

  it('rejects a missing or invalid status', () => {
    expect(movieStatusBodySchema.safeParse({}).success).toBe(false);
    expect(movieStatusBodySchema.safeParse({ status: 'DRAFT' }).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(movieStatusBodySchema.safeParse({ status: 'ENDED', isActive: true }).success).toBe(
      false,
    );
  });
});

describe('movieActiveBodySchema', () => {
  it('accepts a boolean', () => {
    expect(movieActiveBodySchema.parse({ isActive: false })).toEqual({ isActive: false });
  });

  it('rejects non-boolean values', () => {
    for (const isActive of ['false', 0, 1, null]) {
      expect(movieActiveBodySchema.safeParse({ isActive }).success).toBe(false);
    }
    expect(movieActiveBodySchema.safeParse({}).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(movieActiveBodySchema.safeParse({ isActive: true, status: 'ENDED' }).success).toBe(
      false,
    );
  });
});

describe('adminMovieListQuerySchema', () => {
  it('applies defaults', () => {
    expect(adminMovieListQuerySchema.parse({})).toEqual({
      deleted: 'exclude',
      page: 1,
      pageSize: 20,
      sort: 'updatedAt',
      order: 'desc',
    });
  });

  it('parses a full query', () => {
    expect(
      adminMovieListQuerySchema.parse({
        search: '  matara ',
        status: 'ENDED',
        isActive: 'false',
        deleted: 'only',
        page: '3',
        pageSize: '100',
        sort: 'title',
        order: 'asc',
      }),
    ).toEqual({
      search: 'matara',
      status: 'ENDED',
      isActive: false,
      deleted: 'only',
      page: 3,
      pageSize: 100,
      sort: 'title',
      order: 'asc',
    });
  });

  it("maps isActive 'true' to true and 'false' to false", () => {
    expect(adminMovieListQuerySchema.parse({ isActive: 'true' }).isActive).toBe(true);
    expect(adminMovieListQuerySchema.parse({ isActive: 'false' }).isActive).toBe(false);
  });

  it.each(['1', '0', 'yes', 'TRUE', 'False', ''])('rejects isActive=%s', (isActive) => {
    expect(adminMovieListQuerySchema.safeParse({ isActive }).success).toBe(false);
  });

  it('treats a whitespace-only search as no search', () => {
    expect(adminMovieListQuerySchema.parse({ search: '   ' }).search).toBeUndefined();
  });

  it('rejects a search longer than 100 characters', () => {
    expect(adminMovieListQuerySchema.safeParse({ search: 's'.repeat(101) }).success).toBe(false);
    expect(adminMovieListQuerySchema.safeParse({ search: 's'.repeat(100) }).success).toBe(true);
  });

  it.each(['0', '-1', '1.5', 'abc', '', '1e2', ' 2'])('rejects page=%s', (page) => {
    expect(adminMovieListQuerySchema.safeParse({ page }).success).toBe(false);
  });

  it.each(['0', '101', '-5', 'ten'])('rejects pageSize=%s', (pageSize) => {
    expect(adminMovieListQuerySchema.safeParse({ pageSize }).success).toBe(false);
  });

  it('accepts pageSize bounds', () => {
    expect(adminMovieListQuerySchema.parse({ pageSize: '1' }).pageSize).toBe(1);
    expect(adminMovieListQuerySchema.parse({ pageSize: '100' }).pageSize).toBe(100);
  });

  it('rejects repeated query keys (arrays)', () => {
    expect(adminMovieListQuerySchema.safeParse({ page: ['1', '2'] }).success).toBe(false);
    expect(adminMovieListQuerySchema.safeParse({ status: ['ENDED'] }).success).toBe(false);
  });

  it('rejects invalid enum values', () => {
    expect(adminMovieListQuerySchema.safeParse({ deleted: 'all' }).success).toBe(false);
    expect(adminMovieListQuerySchema.safeParse({ sort: 'slug' }).success).toBe(false);
    expect(adminMovieListQuerySchema.safeParse({ order: 'up' }).success).toBe(false);
    expect(adminMovieListQuerySchema.safeParse({ status: 'DRAFT' }).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(adminMovieListQuerySchema.safeParse({ limit: '10' }).success).toBe(false);
  });
});

describe('publicMovieListQuerySchema', () => {
  it('accepts no status or a public status', () => {
    expect(publicMovieListQuerySchema.parse({})).toEqual({});
    expect(publicMovieListQuerySchema.parse({ status: 'UPCOMING' })).toEqual({
      status: 'UPCOMING',
    });
    expect(publicMovieListQuerySchema.parse({ status: 'NOW_SHOWING' })).toEqual({
      status: 'NOW_SHOWING',
    });
  });

  it('rejects ENDED', () => {
    expect(publicMovieListQuerySchema.safeParse({ status: 'ENDED' }).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(publicMovieListQuerySchema.safeParse({ includeEnded: 'true' }).success).toBe(false);
  });
});

describe('publicMovieSchema', () => {
  it('accepts a public movie', () => {
    expect(publicMovieSchema.parse(validPublicMovie)).toEqual(validPublicMovie);
  });

  it.each([
    ['deletedAt', null],
    ['isActive', true],
    ['posterPublicId', 'sk-cinema/posters/abc'],
    ['bannerPublicId', 'sk-cinema/banners/abc'],
    ['createdAt', '2026-10-01T04:30:00.000Z'],
    ['updatedAt', '2026-10-01T04:30:00.000Z'],
  ])('rejects an object containing %s', (key, value) => {
    expect(publicMovieSchema.safeParse({ ...validPublicMovie, [key]: value }).success).toBe(false);
  });

  it('rejects a full admin movie', () => {
    expect(publicMovieSchema.safeParse(validAdminMovie).success).toBe(false);
  });

  it('rejects non-https image URLs', () => {
    const movie = { ...validPublicMovie, posterUrl: 'http://res.cloudinary.com/x.jpg' };
    expect(publicMovieSchema.safeParse(movie).success).toBe(false);
  });

  it('wraps in list and single responses', () => {
    expect(publicMovieListResponseSchema.safeParse({ movies: [validPublicMovie] }).success).toBe(
      true,
    );
    expect(publicMovieResponseSchema.safeParse({ movie: validPublicMovie }).success).toBe(true);
    expect(publicMovieResponseSchema.safeParse({ movie: validAdminMovie }).success).toBe(false);
  });
});

describe('adminMovieSchema', () => {
  it('accepts an admin movie', () => {
    expect(adminMovieSchema.parse(validAdminMovie)).toEqual(validAdminMovie);
  });

  it('accepts a soft-deleted movie', () => {
    const movie = { ...validAdminMovie, deletedAt: '2026-10-03T00:00:00.000Z' };
    expect(adminMovieSchema.safeParse(movie).success).toBe(true);
  });

  it('rejects unknown keys', () => {
    expect(adminMovieSchema.safeParse({ ...validAdminMovie, showtimes: [] }).success).toBe(false);
  });

  it('requires timestamps as ISO strings', () => {
    expect(adminMovieSchema.safeParse({ ...validAdminMovie, createdAt: 'yesterday' }).success).toBe(
      false,
    );
  });

  it('wraps in list and single responses', () => {
    expect(
      adminMovieListResponseSchema.safeParse({
        items: [validAdminMovie],
        page: 1,
        pageSize: 20,
        total: 1,
      }).success,
    ).toBe(true);
    expect(
      adminMovieListResponseSchema.safeParse({ items: [], page: 1, pageSize: 20 }).success,
    ).toBe(false);
    expect(adminMovieResponseSchema.safeParse({ movie: validAdminMovie }).success).toBe(true);
  });
});
