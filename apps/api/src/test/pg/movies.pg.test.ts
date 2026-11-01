/**
 * Phase 4 movie behaviour proven on real Postgres 18 (C.UTF-8, like Neon): what the in-memory
 * fake (helpers.ts inMemoryAuthDb) can only imitate. Mirrors the PLAN.md Phase 4 "Manual check
 * on Neon dev" items 1-8:
 *   1. slug clashes: the real P2002 shape isMovieSlugClash relies on, 409s, generated suffixes;
 *   2. admin search treats `%`, `_` and `\` literally (Prisma does not escape LIKE);
 *   3. case-insensitive search with accents;
 *   4. C.UTF-8 collation and the admin title sort;
 *   5. genres / cast lists round-trip exactly;
 *   6. `releaseDate` (a Postgres `date`) never shifts, whatever the process time zone;
 *   7. undated movies are last in the public lists and in the admin releaseDate sort.
 *
 * Most tests drive the real services with the real Prisma client; one block goes through
 * createApp + Supertest to prove the wiring. Nothing reads the clock: no assertion depends on
 * a timestamp, and every public service gets a fresh cache.
 */
import {
  ERROR_CODES,
  adminMovieListQuerySchema,
  adminMovieListResponseSchema,
  adminMovieResponseSchema,
  movieCreateBodySchema,
  movieUpdateBodySchema,
  publicMovieListResponseSchema,
  publicMovieResponseSchema,
  type AdminMovieListQueryInput,
  type MovieCreateBodyInput,
  type MovieStatus,
} from '@sk-cinema/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { Prisma, type AdminRole } from '../../generated/prisma/client.js';
import { MemoryCache } from '../../lib/cache.js';
import { AppError } from '../../lib/errors.js';
import {
  SLUG_IN_USE_MESSAGE,
  createMovieAdminService,
  isMovieSlugClash,
  type AuditActor,
} from '../../services/movie.admin.service.js';
import { createPublicMovieService } from '../../services/movie.public.service.js';
import { authClient, buildTestApp, sessionFrom, testPasswordHash } from '../helpers.js';
import { describePg, disconnectTestPrisma, resetDatabase, testPrisma } from './db.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ADMIN_EMAIL = 'pg-admin@skcinema.lk';
const ADMIN_PASSWORD = 'correct horse battery staple';

/** A real Admin row (AuditLog.adminId is a foreign key, so service writes need one). */
async function seedAdmin(role: AdminRole = 'EDITOR', passwordHash = '$argon2id$placeholder') {
  return testPrisma().admin.create({
    data: { email: ADMIN_EMAIL, name: 'PG Test Admin', passwordHash, role },
  });
}

/** The real services over the real client; a fresh cache each time, so nothing is stale. */
function services() {
  const db = testPrisma();
  return {
    admin: createMovieAdminService({ db, cache: new MemoryCache() }),
    pub: createPublicMovieService({ db, cache: new MemoryCache() }),
  };
}

async function actor(): Promise<AuditActor> {
  const admin = await seedAdmin();
  return { adminId: admin.id, ipAddress: '203.0.113.7', userAgent: 'pg test' };
}

/** Create through the shared schema (defaults, trimming, genre de-dup) and the admin service. */
function createMovie(by: AuditActor, input: MovieCreateBodyInput) {
  return services().admin.create(movieCreateBodySchema.parse(input), by);
}

/** The admin list, with the query parsed by the shared schema as the route does. */
function adminList(query: AdminMovieListQueryInput) {
  return services().admin.list(adminMovieListQuerySchema.parse({ pageSize: '100', ...query }));
}

async function adminTitles(query: AdminMovieListQueryInput): Promise<string[]> {
  return (await adminList(query)).items.map((movie) => movie.title);
}

interface RawMovie {
  title: string;
  slug?: string;
  status?: MovieStatus;
  releaseDate?: string | null;
}

let rawSlugCounter = 0;

/**
 * Inserts movies straight through Prisma (no service, no audit). Slugs default to `movie-N`,
 * which contain none of the search terms, so a search can only match through the title.
 */
async function insertMovies(movies: RawMovie[]): Promise<void> {
  for (const movie of movies) {
    rawSlugCounter += 1;
    await testPrisma().movie.create({
      data: {
        title: movie.title,
        slug: movie.slug ?? `movie-${rawSlugCounter}`,
        durationMinutes: 120,
        status: movie.status ?? 'NOW_SHOWING',
        releaseDate:
          movie.releaseDate === undefined || movie.releaseDate === null
            ? null
            : new Date(`${movie.releaseDate}T00:00:00.000Z`),
      },
    });
  }
}

/** Resolves to what `promise` rejected with; fails the test if it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

function expectSlugConflict(error: unknown): void {
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({
    status: 409,
    code: ERROR_CODES.CONFLICT,
    message: SLUG_IN_USE_MESSAGE,
    details: [{ path: ['body', 'slug'], message: SLUG_IN_USE_MESSAGE }],
  });
}

describePg('movies on real Postgres', () => {
  beforeEach(resetDatabase);
  afterAll(disconnectTestPrisma);

  // -------------------------------------------------------------------------
  // 1. Slug clashes
  // -------------------------------------------------------------------------

  describePg('slug clashes (Neon check 1 and 8)', () => {
    it('a raw duplicate insert fails with the P2002 shape isMovieSlugClash relies on', async () => {
      const prisma = testPrisma();
      await insertMovies([{ title: 'Avatar', slug: 'avatar' }]);

      const error = await rejectionOf(
        prisma.movie.create({ data: { slug: 'avatar', title: 'Avatar 2', durationMinutes: 90 } }),
      );

      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      const known = error as Prisma.PrismaClientKnownRequestError;
      expect(known.code).toBe('P2002');
      expect(known.meta?.['modelName']).toBe('Movie');
      // No meta.target with adapter-pg: the index name is only in driverAdapterError.
      expect(known.meta).not.toHaveProperty('target');
      expect(Object.keys(known.meta ?? {}).sort()).toEqual(['driverAdapterError', 'modelName']);
      const adapterError = known.meta?.['driverAdapterError'] as Error;
      expect(adapterError.name).toBe('DriverAdapterError');
      expect(adapterError.cause).toMatchObject({
        kind: 'UniqueConstraintViolation',
        originalCode: '23505',
        constraint: { index: 'Movie_slug_key' },
      });
      expect(isMovieSlugClash(error)).toBe(true);
      expect(await prisma.movie.count()).toBe(1);
    });

    it('a raw update onto a taken slug fails with the same P2002 shape', async () => {
      const prisma = testPrisma();
      await insertMovies([
        { title: 'Avatar', slug: 'avatar' },
        { title: 'Titanic', slug: 'titanic' },
      ]);

      const error = await rejectionOf(
        prisma.movie.update({ where: { slug: 'titanic' }, data: { slug: 'avatar' } }),
      );

      expect(isMovieSlugClash(error)).toBe(true);
      const known = error as Prisma.PrismaClientKnownRequestError;
      expect(known.meta?.['modelName']).toBe('Movie');
      expect(known.meta).not.toHaveProperty('target');
      expect((known.meta?.['driverAdapterError'] as Error).cause).toMatchObject({
        constraint: { index: 'Movie_slug_key' },
      });
    });

    it('creating with a slug another movie has is a 409 and inserts nothing', async () => {
      const by = await actor();
      await createMovie(by, { title: 'Avatar', slug: 'avatar', durationMinutes: 162 });

      const error = await rejectionOf(
        createMovie(by, { title: 'Avatar remake', slug: 'avatar', durationMinutes: 150 }),
      );

      expectSlugConflict(error);
      expect(await testPrisma().movie.count()).toBe(1);
      expect(await testPrisma().auditLog.count({ where: { entity: 'Movie' } })).toBe(1);
    });

    it('creating with the slug of a soft-deleted movie is a 409 (slugs are never reused)', async () => {
      const by = await actor();
      const old = await createMovie(by, { title: 'Avatar', slug: 'avatar', durationMinutes: 162 });
      await services().admin.softDelete(old.id, by);

      const error = await rejectionOf(
        createMovie(by, { title: 'Avatar', slug: 'avatar', durationMinutes: 162 }),
      );

      expectSlugConflict(error);
    });

    it('changing a slug to a taken one is a 409 and leaves the movie unchanged', async () => {
      const by = await actor();
      await createMovie(by, { title: 'Avatar', slug: 'avatar', durationMinutes: 162 });
      const titanic = await createMovie(by, { title: 'Titanic', durationMinutes: 195 });

      const error = await rejectionOf(
        services().admin.update(titanic.id, movieUpdateBodySchema.parse({ slug: 'avatar' }), by),
      );

      expectSlugConflict(error);
      expect((await services().admin.getById(titanic.id)).slug).toBe('titanic');
    });

    it('a generated slug that is taken gets the next free suffix: avatar-2, then avatar-3', async () => {
      const by = await actor();
      await insertMovies([
        { title: 'Avatar', slug: 'avatar' },
        { title: 'Avatar: The Way of Water', slug: 'avatar-the-way-of-water' },
      ]);

      const second = await createMovie(by, { title: 'Avatar', durationMinutes: 162 });
      const third = await createMovie(by, { title: 'Avatar', durationMinutes: 162 });

      expect(second.slug).toBe('avatar-2');
      expect(third.slug).toBe('avatar-3');
    });
  });

  // -------------------------------------------------------------------------
  // 2. LIKE wildcards in the admin search
  // -------------------------------------------------------------------------

  describePg('admin search treats LIKE wildcards literally (Neon check 2)', () => {
    const titles = ['50% Off', '500 Days', 'Sale 100%', 'Snake_Case', 'Snake Case', 'Back\\slash'];

    beforeEach(async () => {
      await insertMovies(titles.map((title) => ({ title })));
    });

    it('premise: Prisma `contains` does not escape wildcards, so the service must', async () => {
      const unescaped = await testPrisma().movie.findMany({
        where: { title: { contains: '50%', mode: 'insensitive' } },
        orderBy: { title: 'asc' },
        select: { title: true },
      });
      // If Prisma ever starts escaping, this fails: then escapeLikePattern would double-escape.
      expect(unescaped.map((movie) => movie.title)).toEqual(['50% Off', '500 Days']);
    });

    it.each([
      ['50%', ['50% Off']],
      ['%', ['50% Off', 'Sale 100%']],
      ['_', ['Snake_Case']],
      ['e_C', ['Snake_Case']],
      ['\\', ['Back\\slash']],
      ['k\\s', ['Back\\slash']],
    ])('search %j matches only %j', async (search, expected) => {
      expect(await adminTitles({ search, sort: 'title', order: 'asc' })).toEqual(expected);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Case-insensitive search with accents
  // -------------------------------------------------------------------------

  describePg('case-insensitive search with accents (Neon check 3)', () => {
    beforeEach(async () => {
      await insertMovies(['Élan', 'élan vital', 'Elan Drive', 'Other'].map((title) => ({ title })));
    });

    it.each(['élan', 'ÉLAN', 'Élan', 'éLaN'])(
      'search %j matches "Élan" and "élan vital"',
      async (search) => {
        expect(await adminTitles({ search, sort: 'title', order: 'asc' })).toEqual([
          'Élan',
          'élan vital',
        ]);
      },
    );

    it('search "elan" does not match accented titles (ILIKE folds case, not accents)', async () => {
      // Real Postgres behaviour, as on Neon dev 2026-11-01: ILIKE lower-cases both sides with
      // the database ctype (C.UTF-8), which maps É to é but never é to e.
      expect(await adminTitles({ search: 'elan', sort: 'title', order: 'asc' })).toEqual([
        'Elan Drive',
      ]);
    });
  });

  describePg('Unicode case-folding edges', () => {
    // Postgres ILIKE compares lower(text) with lower(pattern), character by character. The fake
    // (helpers.ts `like`) now lowers each character the same way, so it matches on these too.
    beforeEach(async () => {
      await insertMovies(['Caſe Study', 'İzmir Nights', 'οδυσσευς'].map((title) => ({ title })));
    });

    it('long s (ſ) does not match "s": lower(ſ) is ſ (the fake matches this)', async () => {
      expect(await adminTitles({ search: 'case' })).toEqual([]);
    });

    it('dotted capital I (İ) matches "i": lower(İ) is i (the fake matches this)', async () => {
      expect(await adminTitles({ search: 'izmir' })).toEqual(['İzmir Nights']);
    });

    it('final sigma (ς) does not match capital sigma: lower(Σ) is σ (the fake matches this)', async () => {
      expect(await adminTitles({ search: 'ΕΥΣ' })).toEqual([]);
      expect(await adminTitles({ search: 'ΕΥ' })).toEqual(['οδυσσευς']);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Collation
  // -------------------------------------------------------------------------

  describePg('collation and the admin title sort (Neon check 4)', () => {
    it('the database collation is C.UTF-8, as on Neon', async () => {
      const [row] = await testPrisma().$queryRaw<{ datcollate: string; datctype: string }[]>`
        SELECT datcollate, datctype FROM pg_database WHERE datname = current_database()`;
      expect(row).toEqual({ datcollate: 'C.UTF-8', datctype: 'C.UTF-8' });
    });

    it('sort=title asc is C ordering: Banana, apple, cherry', async () => {
      await insertMovies(['cherry', 'apple', 'Banana'].map((title) => ({ title })));

      expect(await adminTitles({ sort: 'title', order: 'asc' })).toEqual([
        'Banana',
        'apple',
        'cherry',
      ]);
    });

    it('sort=title desc is exactly the reverse', async () => {
      await insertMovies(['cherry', 'apple', 'Banana'].map((title) => ({ title })));

      expect(await adminTitles({ sort: 'title', order: 'desc' })).toEqual([
        'cherry',
        'apple',
        'Banana',
      ]);
    });

    it('orders by code point, so an emoji title sorts after U+FB00 (the fake sorts by code point too)', async () => {
      await insertMovies(
        ['\u{1F600} Smile', '\uFB00 Ligature', 'Élan', 'Zed'].map((title) => ({ title })),
      );

      expect(await adminTitles({ sort: 'title', order: 'asc' })).toEqual([
        'Zed',
        'Élan',
        '\uFB00 Ligature',
        '\u{1F600} Smile',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Genres and cast round-trip
  // -------------------------------------------------------------------------

  describePg('genres and cast round-trip (Neon check 5)', () => {
    const genresInput = [
      ' Action ',
      'action',
      'Sci-Fi, Drama',
      'say "hi"',
      "it's",
      'back\\slash',
      'Niño',
      'NIÑO',
      'NULL',
      '{braces}',
    ];
    /** After the shared schema: trimmed, case-insensitive duplicates removed (first kept). */
    const genres = [
      'Action',
      'Sci-Fi, Drama',
      'say "hi"',
      "it's",
      'back\\slash',
      'Niño',
      'NULL',
      '{braces}',
    ];
    const castInput = [
      'Doe, John',
      'Dwayne "The Rock" Johnson',
      "Lupita Nyong'o",
      'C:\\path\\name',
      'Peña Nieto',
      '  Spaced  ',
      'NULL',
      'Same',
      'same',
    ];
    /** Cast is trimmed but never de-duplicated. */
    const cast = [
      'Doe, John',
      'Dwayne "The Rock" Johnson',
      "Lupita Nyong'o",
      'C:\\path\\name',
      'Peña Nieto',
      'Spaced',
      'NULL',
      'Same',
      'same',
    ];

    it('come back exactly from create, admin get and public get', async () => {
      const by = await actor();
      const created = await createMovie(by, {
        title: 'Lists',
        durationMinutes: 100,
        status: 'NOW_SHOWING',
        genres: genresInput,
        cast: castInput,
      });

      expect(created.genres).toEqual(genres);
      expect(created.cast).toEqual(cast);
      const fromAdmin = await services().admin.getById(created.id);
      expect([fromAdmin.genres, fromAdmin.cast]).toEqual([genres, cast]);
      const fromPublic = await services().pub.getBySlug(created.slug);
      expect([fromPublic.genres, fromPublic.cast]).toEqual([genres, cast]);
    });

    it('are stored as one array element per entry (checked in SQL)', async () => {
      const by = await actor();
      await createMovie(by, {
        title: 'Lists',
        durationMinutes: 100,
        genres: genresInput,
        cast: castInput,
      });

      const [row] = await testPrisma().$queryRaw<
        {
          genreCount: number;
          castCount: number;
          genres: string;
          cast: string;
          nullGenre: boolean;
        }[]
      >`
        SELECT cardinality(genres)::int AS "genreCount", cardinality("cast")::int AS "castCount",
               array_to_json(genres)::text AS genres, array_to_json("cast")::text AS cast,
               genres[7] IS NULL AS "nullGenre"
        FROM "Movie"`;
      expect(row?.genreCount).toBe(genres.length);
      expect(row?.castCount).toBe(cast.length);
      expect(JSON.parse(row?.genres ?? 'null')).toEqual(genres);
      expect(JSON.parse(row?.cast ?? 'null')).toEqual(cast);
      // The text "NULL" stays text, never an SQL NULL element.
      expect(row?.nullGenre).toBe(false);
    });

    it('an update replaces them exactly, with genres de-duplicated by the shared schema', async () => {
      const by = await actor();
      const created = await createMovie(by, {
        title: 'Lists',
        durationMinutes: 100,
        genres: ['Drama'],
      });

      const updated = await services().admin.update(
        created.id,
        movieUpdateBodySchema.parse({
          genres: ['Ñandú', 'ñandú', 'a,b', 'q"q'],
          cast: ['O\'Neil, \\ "x"'],
        }),
        by,
      );

      expect(updated.genres).toEqual(['Ñandú', 'a,b', 'q"q']);
      expect(updated.cast).toEqual(['O\'Neil, \\ "x"']);
      const reread = await services().admin.getById(created.id);
      expect([reread.genres, reread.cast]).toEqual([updated.genres, updated.cast]);
    });

    it('empty lists stay empty arrays, not NULL', async () => {
      const by = await actor();
      const created = await createMovie(by, { title: 'No lists', durationMinutes: 100 });

      expect([created.genres, created.cast]).toEqual([[], []]);
      const [row] = await testPrisma().$queryRaw<{ nulls: boolean }[]>`
        SELECT genres IS NULL OR "cast" IS NULL AS nulls FROM "Movie"`;
      expect(row?.nulls).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 6. releaseDate never shifts
  // -------------------------------------------------------------------------

  describePg('releaseDate is a plain date in every process time zone (Neon check 6)', () => {
    const originalTz = process.env['TZ'];

    afterEach(() => {
      if (originalTz === undefined) delete process.env['TZ'];
      else process.env['TZ'] = originalTz;
    });

    /** Zones on both sides of UTC, including +14 and a half-hour offset (Colombo). */
    it.each([
      ['UTC', 0],
      ['Asia/Colombo', -330],
      ['Pacific/Kiritimati', -840],
      ['America/Los_Angeles', 420],
    ])('TZ=%s: 2026-11-01 and 2026-12-31 come back unchanged', async (tz, offset) => {
      process.env['TZ'] = tz;
      // Precondition: the zone really applies to this process (2026-11-01T00:00Z).
      expect(new Date(Date.UTC(2026, 10, 1)).getTimezoneOffset()).toBe(offset);

      const by = await actor();
      const nov = await createMovie(by, {
        title: 'November',
        durationMinutes: 100,
        status: 'NOW_SHOWING',
        releaseDate: '2026-11-01',
      });
      const dec = await createMovie(by, {
        title: 'December',
        durationMinutes: 100,
        status: 'UPCOMING',
        releaseDate: '2026-12-31',
      });

      expect([nov.releaseDate, dec.releaseDate]).toEqual(['2026-11-01', '2026-12-31']);
      const { admin, pub } = services();
      expect((await admin.getById(nov.id)).releaseDate).toBe('2026-11-01');
      expect((await admin.getById(dec.id)).releaseDate).toBe('2026-12-31');
      expect((await pub.getBySlug(nov.slug)).releaseDate).toBe('2026-11-01');
      expect((await pub.getBySlug(dec.slug)).releaseDate).toBe('2026-12-31');
      expect((await pub.list(undefined)).map((m) => [m.title, m.releaseDate])).toEqual([
        ['November', '2026-11-01'],
        ['December', '2026-12-31'],
      ]);
      const rows = await testPrisma().$queryRaw<{ title: string; releaseDate: string }[]>`
        SELECT title, "releaseDate"::text AS "releaseDate" FROM "Movie" ORDER BY "releaseDate"`;
      expect(rows).toEqual([
        { title: 'November', releaseDate: '2026-11-01' },
        { title: 'December', releaseDate: '2026-12-31' },
      ]);
    });

    it('an update to 2026-12-31 under TZ=America/Los_Angeles stores 2026-12-31', async () => {
      process.env['TZ'] = 'America/Los_Angeles';
      const by = await actor();
      const movie = await createMovie(by, {
        title: 'Moved',
        durationMinutes: 100,
        releaseDate: '2026-11-01',
      });

      const updated = await services().admin.update(
        movie.id,
        movieUpdateBodySchema.parse({ releaseDate: '2026-12-31' }),
        by,
      );

      expect(updated.releaseDate).toBe('2026-12-31');
      const [row] = await testPrisma().$queryRaw<{ releaseDate: string }[]>`
        SELECT "releaseDate"::text AS "releaseDate" FROM "Movie"`;
      expect(row?.releaseDate).toBe('2026-12-31');
    });
  });

  // -------------------------------------------------------------------------
  // 7. Undated movies last
  // -------------------------------------------------------------------------

  describePg('movies without a release date are last (Neon check 7)', () => {
    beforeEach(async () => {
      await insertMovies([
        { title: 'NS undated', status: 'NOW_SHOWING', releaseDate: null },
        { title: 'NS old', status: 'NOW_SHOWING', releaseDate: '2026-01-10' },
        { title: 'NS new', status: 'NOW_SHOWING', releaseDate: '2026-10-20' },
        { title: 'UP undated', status: 'UPCOMING', releaseDate: null },
        { title: 'UP later', status: 'UPCOMING', releaseDate: '2026-12-31' },
        { title: 'UP soon', status: 'UPCOMING', releaseDate: '2026-11-01' },
        { title: 'ENDED undated', status: 'ENDED', releaseDate: null },
        { title: 'ENDED dated', status: 'ENDED', releaseDate: '2025-06-01' },
      ]);
    });

    it('public NOW_SHOWING: newest first, undated last', async () => {
      const movies = await services().pub.list('NOW_SHOWING');
      expect(movies.map((m) => m.title)).toEqual(['NS new', 'NS old', 'NS undated']);
    });

    it('public UPCOMING: soonest first, undated last', async () => {
      const movies = await services().pub.list('UPCOMING');
      expect(movies.map((m) => m.title)).toEqual(['UP soon', 'UP later', 'UP undated']);
    });

    it('public default list: NOW_SHOWING then UPCOMING, undated last in each, no ENDED', async () => {
      const movies = await services().pub.list(undefined);
      expect(movies.map((m) => m.title)).toEqual([
        'NS new',
        'NS old',
        'NS undated',
        'UP soon',
        'UP later',
        'UP undated',
      ]);
    });

    it('admin sort=releaseDate asc: oldest first, undated last', async () => {
      const titles = await adminTitles({ sort: 'releaseDate', order: 'asc' });
      expect(titles.slice(0, 5)).toEqual([
        'ENDED dated',
        'NS old',
        'NS new',
        'UP soon',
        'UP later',
      ]);
      expect(titles.slice(5).sort()).toEqual(['ENDED undated', 'NS undated', 'UP undated']);
    });

    it('admin sort=releaseDate desc: newest first, undated still last', async () => {
      const titles = await adminTitles({ sort: 'releaseDate', order: 'desc' });
      expect(titles.slice(0, 5)).toEqual([
        'UP later',
        'UP soon',
        'NS new',
        'NS old',
        'ENDED dated',
      ]);
      expect(titles.slice(5).sort()).toEqual(['ENDED undated', 'NS undated', 'UP undated']);
    });

    it('admin undated ties are ordered by id, and desc is exactly asc reversed', async () => {
      const asc = await adminTitles({ sort: 'releaseDate', order: 'asc' });
      const desc = await adminTitles({ sort: 'releaseDate', order: 'desc' });
      const ids = await testPrisma().movie.findMany({
        where: { releaseDate: null },
        orderBy: { id: 'asc' },
        select: { title: true },
      });
      expect(asc.slice(5)).toEqual(ids.map((row) => row.title));
      expect(desc.slice(5)).toEqual(ids.map((row) => row.title).reverse());
    });
  });

  // -------------------------------------------------------------------------
  // Route level: createApp + Supertest + real Prisma
  // -------------------------------------------------------------------------

  describePg('through the HTTP API (wiring with real Prisma)', () => {
    async function signedIn() {
      await seedAdmin('EDITOR', await testPasswordHash(ADMIN_PASSWORD));
      const { app } = buildTestApp({ prisma: testPrisma() });
      const client = await authClient(app);
      const login = await client.post('/auth/login', {
        body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      });
      expect(login.status).toBe(200);
      return { app, client, access: sessionFrom(login).access };
    }

    it('login, create, admin search, public list and detail all agree on real Postgres', async () => {
      const { app, client, access } = await signedIn();

      const created = await client.post('/movies', {
        cookies: [access],
        body: {
          title: '50% Off',
          durationMinutes: 101,
          status: 'NOW_SHOWING',
          genres: ['Comedy', 'comedy', 'Sci-Fi, Drama', 'say "hi"', 'Niño'],
          cast: ["Lupita Nyong'o", 'C:\\path', 'Peña'],
          releaseDate: '2026-11-01',
        },
      });
      expect(created.status).toBe(201);
      const movie = adminMovieResponseSchema.parse(created.body).movie;
      expect(movie).toMatchObject({
        slug: '50-off',
        genres: ['Comedy', 'Sci-Fi, Drama', 'say "hi"', 'Niño'],
        cast: ["Lupita Nyong'o", 'C:\\path', 'Peña'],
        releaseDate: '2026-11-01',
      });
      const second = await client.post('/movies', {
        cookies: [access],
        body: { title: '500 Days', durationMinutes: 95, status: 'NOW_SHOWING' },
      });
      expect(second.status).toBe(201);

      const duplicate = await client.post('/movies', {
        cookies: [access],
        body: { title: 'Again', slug: '50-off', durationMinutes: 90 },
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body).toMatchObject({
        error: { code: 'CONFLICT', message: SLUG_IN_USE_MESSAGE },
      });

      const search = await client.get(`/movies?search=${encodeURIComponent('50%')}`, [access]);
      expect(search.status).toBe(200);
      const found = adminMovieListResponseSchema.parse(search.body);
      expect(found.items.map((m) => m.title)).toEqual(['50% Off']);
      expect(found.total).toBe(1);

      const list = publicMovieListResponseSchema.parse(
        (await request(app).get('/api/movies')).body,
      );
      expect(list.movies.map((m) => m.title)).toEqual(['50% Off', '500 Days']);

      const detail = await request(app).get('/api/movies/50-off');
      expect(detail.status).toBe(200);
      expect(publicMovieResponseSchema.parse(detail.body).movie).toMatchObject({
        genres: movie.genres,
        cast: movie.cast,
        releaseDate: '2026-11-01',
      });

      // Each create wrote its audit row in the same transaction (the 409 wrote none).
      expect(
        await testPrisma().auditLog.count({ where: { entity: 'Movie', action: 'CREATE' } }),
      ).toBe(2);
    });
  });
});
