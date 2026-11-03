/**
 * Phase 5 T17: the row locks and the slug's unique index under real concurrency on Postgres 18,
 * which the in-memory fake cannot imitate. Every interleaving is forced (see interleave.ts), so
 * these prove the same thing on every run:
 *
 * - Lock races run in a fixed order: the first request stops just before its first write with its
 *   locks held, and is released once the second is SEEN waiting on the expected row. Where the
 *   outcome depends on who wins, both orders are tested. Without the locks the second request is
 *   never held back, both commit, and the invariant assertion fails.
 * - The deadlock test makes both moves stop after their first screen lock. Sorted locks queue on
 *   the same row; unsorted ones would each hold one row and deadlock.
 * - Slug races stop both requests after their pre-check, so both go on to insert or update and the
 *   unique index decides; the tests assert the real P2002 was thrown. They run through createApp
 *   and Supertest, because "never a 500" is a promise of the HTTP response.
 */
import {
  ERROR_CODES,
  adminMovieResponseSchema,
  apiErrorSchema,
  movieUpdateBodySchema,
  showtimeBulkCreateBodySchema,
  showtimeConflictDetailsSchema,
  showtimeCreateBodySchema,
  showtimeUpdateBodySchema,
} from '@sk-cinema/shared';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { MemoryCache } from '../../lib/cache.js';
import { AppError } from '../../lib/errors.js';
import { findShowtimeConflicts } from '../../lib/showtimeOverlap.js';
import { CSRF_HEADER } from '../../middleware/csrf.js';
import type { AuditActor } from '../../services/audit.service.js';
import {
  MOVIE_DELETE_HAS_SHOWTIMES_MESSAGE,
  SLUG_IN_USE_MESSAGE,
  createMovieAdminService,
  movieLengthOverlapMessage,
} from '../../services/movie.admin.service.js';
import {
  SCREEN_DEACTIVATE_HAS_SHOWTIMES_MESSAGE,
  createScreenAdminService,
} from '../../services/screen.admin.service.js';
import { createSettingsService } from '../../services/settings.service.js';
import {
  SHOWTIME_MOVIE_DELETED_MESSAGE,
  SHOWTIME_OVERLAP_MESSAGE,
  SHOWTIME_SCREEN_INACTIVE_MESSAGE,
  createShowtimeAdminService,
  showtimeBulkOverlapMessage,
} from '../../services/showtime.admin.service.js';
import {
  ADMIN_BASE,
  ADMIN_ORIGIN,
  TEST_USER_AGENT,
  authClient,
  buildTestApp,
  sessionFrom,
  silentLogger,
  testPasswordHash,
  type AuthClient,
  type Session,
} from '../helpers.js';
import { describePg, disconnectTestPrisma, resetDatabase, testPrisma } from './db.js';
import {
  inTransaction,
  interceptDb,
  lockWaiters,
  meetAfterFirstLock,
  refused,
  rendezvous,
  runInOrder,
  succeeded,
  type DbCall,
} from './interleave.js';

/** The injected clock: 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');
const SHOW_DATE = '2026-11-03';
const GAP_MINUTES = 15;

const colombo = (time: string, date = SHOW_DATE) => new Date(`${date}T${time}:00+05:30`);

/** The SQL lib/locks.ts sends for each row, as a request waiting on it is seen in pg_stat_activity. */
const WAITING_ON_MOVIE_LOCK = /FROM "Movie".*FOR UPDATE/s;
const WAITING_ON_SCREEN_LOCK = /FROM "Screen".*FOR UPDATE/s;

const showtimeService = (db: PrismaClient) =>
  createShowtimeAdminService({
    db,
    settings: createSettingsService({ db, logger: silentLogger }),
    cache: new MemoryCache(),
    logger: silentLogger,
    now: () => NOW,
  });

const movieService = (db: PrismaClient) =>
  createMovieAdminService({ db, cache: new MemoryCache(), logger: silentLogger, now: () => NOW });

const screenService = (db: PrismaClient) =>
  createScreenAdminService({ db, cache: new MemoryCache(), now: () => NOW });

/** Two 120-minute movies and two screens: a shared movie or screen is always on purpose. */
async function fixtures() {
  const prisma = testPrisma();
  const admin = await prisma.admin.create({
    data: { email: 'pg-admin@skcinema.lk', name: 'PG', passwordHash: '$argon2id$placeholder' },
  });
  const movie = (slug: string, title: string) =>
    prisma.movie.create({ data: { slug, title, durationMinutes: 120, status: 'NOW_SHOWING' } });
  const alpha = await movie('alpha', 'Alpha');
  const bravo = await movie('bravo', 'Bravo');
  const screen1 = await prisma.screen.create({ data: { name: 'Screen 1' } });
  const screen2 = await prisma.screen.create({ data: { name: 'Screen 2' } });
  await prisma.setting.create({ data: { key: 'showGapMinutes', value: String(GAP_MINUTES) } });
  const by: AuditActor = { adminId: admin.id, ipAddress: '203.0.113.7', userAgent: 'pg test' };
  return { alpha, bravo, screen1, screen2, by };
}

const createBody = (movieId: string, screenId: string, time: string) =>
  showtimeCreateBodySchema.parse({ movieId, screenId, date: SHOW_DATE, time });

/** The IDs of the live showtimes, sorted. */
async function liveShowtimeIds(): Promise<string[]> {
  const rows = await testPrisma().showtime.findMany({
    where: { deletedAt: null },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((row) => row.id);
}

/** `action entityId` of every audit row of `entity`, sorted. */
async function auditsOf(entity: string): Promise<string[]> {
  const rows = await testPrisma().auditLog.findMany({
    where: { entity },
    select: { action: true, entityId: true },
  });
  return rows.map((row) => `${row.action} ${String(row.entityId)}`).sort();
}

/** The clashes between the live shows on a screen under the gap, from the final data. */
async function clashesOn(screenId: string) {
  const rows = await testPrisma().showtime.findMany({
    where: { screenId, deletedAt: null },
    select: { id: true, startsAt: true, movie: { select: { title: true, durationMinutes: true } } },
  });
  return findShowtimeConflicts({
    candidates: rows.map((row) => ({
      showtimeId: row.id,
      screenId,
      movieTitle: row.movie.title,
      startsAt: row.startsAt,
      durationMinutes: row.movie.durationMinutes,
    })),
    existing: [],
    gapMinutes: GAP_MINUTES,
  });
}

function expectConflict(error: unknown, message: string) {
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ status: 409, code: ERROR_CODES.CONFLICT, message });
}

describePg('row locks under concurrency on real Postgres', () => {
  beforeEach(resetDatabase);
  afterEach(async () => {
    // Every request has finished, so nothing may be left waiting.
    expect(await lockWaiters()).toEqual([]);
  });
  afterAll(disconnectTestPrisma);

  it('two overlapping bulk creates on one screen: one saved in full, the other 409 and nothing written', async () => {
    const { alpha, bravo, screen1, by } = await fixtures();
    const bulk = (movieId: string, times: string[]) =>
      showtimeBulkCreateBodySchema.parse({
        movieId,
        screenId: screen1.id,
        dateFrom: SHOW_DATE,
        dateTo: '2026-11-05',
        times,
      });

    const race = await runInOrder({
      gate: inTransaction('showtime', 'createMany'),
      first: (db) => showtimeService(db).bulkCreate(bulk(alpha.id, ['10:00', '19:00']), by),
      // Clashes with one show per day; 15:00 is free, and must not be saved either.
      second: (db) => showtimeService(db).bulkCreate(bulk(bravo.id, ['11:00', '15:00']), by),
    });

    const winner = succeeded(race.first);
    const refusal = refused(race.second);
    expect(winner.created).toBe(6);
    expectConflict(refusal, showtimeBulkOverlapMessage(3, 3));
    const winnerIds = winner.items.map((item) => item.id).sort();
    const clashedWith = showtimeConflictDetailsSchema
      .parse((refusal as AppError).details)
      .map((detail) => detail.conflict.showtimeId);
    expect(clashedWith.every((id) => id !== null && winnerIds.includes(id))).toBe(true);
    expect(await liveShowtimeIds()).toEqual(winnerIds);
    expect(await auditsOf('Showtime')).toEqual(winnerIds.map((id) => `CREATE ${id}`).sort());
    expect(await clashesOn(screen1.id)).toEqual([]);
    expect(race.secondBlockedOn).toMatch(WAITING_ON_SCREEN_LOCK);
  });

  describePg('a longer running time versus a create by another movie on the same screen', () => {
    /** Alpha at 10:00. With the 15-minute gap it holds the screen until 12:15, at 150 until 12:45. */
    async function setUp() {
      const shared = await fixtures();
      const show = await testPrisma().showtime.create({
        data: { movieId: shared.alpha.id, screenId: shared.screen1.id, startsAt: colombo('10:00') },
      });
      const longer = movieUpdateBodySchema.parse({ durationMinutes: 150 });
      const create = createBody(shared.bravo.id, shared.screen1.id, '12:30');
      return { ...shared, show, longer, create };
    }

    it('the length change first: the create sees the longer movie and gets 409', async () => {
      const { alpha, screen1, by, show, longer, create } = await setUp();

      const race = await runInOrder({
        gate: inTransaction('movie', 'update'),
        first: (db) => movieService(db).update(alpha.id, longer, by),
        second: (db) => showtimeService(db).create(create, by),
      });

      expect(succeeded(race.first).durationMinutes).toBe(150);
      expectConflict(refused(race.second), SHOWTIME_OVERLAP_MESSAGE);
      expect(await liveShowtimeIds()).toEqual([show.id]);
      expect(await auditsOf('Showtime')).toEqual([]);
      expect(await auditsOf('Movie')).toEqual([`UPDATE ${alpha.id}`]);
      expect(await clashesOn(screen1.id)).toEqual([]);
      expect(race.secondBlockedOn).toMatch(WAITING_ON_SCREEN_LOCK);
    });

    it('the create first: the length change sees the new show and gets 409', async () => {
      const { alpha, screen1, by, show, longer, create } = await setUp();

      const race = await runInOrder({
        gate: inTransaction('showtime', 'create'),
        first: (db) => showtimeService(db).create(create, by),
        second: (db) => movieService(db).update(alpha.id, longer, by),
      });

      const created = succeeded(race.first);
      expectConflict(refused(race.second), movieLengthOverlapMessage(1, 1));
      expect(
        (await testPrisma().movie.findUniqueOrThrow({ where: { id: alpha.id } })).durationMinutes,
      ).toBe(120);
      expect(await liveShowtimeIds()).toEqual([show.id, created.id].sort());
      expect(await auditsOf('Showtime')).toEqual([`CREATE ${created.id}`]);
      expect(await auditsOf('Movie')).toEqual([]);
      expect(await clashesOn(screen1.id)).toEqual([]);
      expect(race.secondBlockedOn).toMatch(WAITING_ON_SCREEN_LOCK);
    });
  });

  describePg(
    'a longer running time versus a create of that same movie (only the movie lock is shared)',
    () => {
      /** Bravo at 12:30; Alpha has no shows yet, so its length change locks no screen. */
      async function setUp() {
        const shared = await fixtures();
        const neighbour = await testPrisma().showtime.create({
          data: {
            movieId: shared.bravo.id,
            screenId: shared.screen1.id,
            startsAt: colombo('12:30'),
          },
        });
        const longer = movieUpdateBodySchema.parse({ durationMinutes: 150 });
        const create = createBody(shared.alpha.id, shared.screen1.id, '10:00');
        return { ...shared, neighbour, longer, create };
      }

      it('the length change first: the create uses the new length and gets 409', async () => {
        const { alpha, screen1, by, neighbour, longer, create } = await setUp();

        const race = await runInOrder({
          gate: inTransaction('movie', 'update'),
          first: (db) => movieService(db).update(alpha.id, longer, by),
          second: (db) => showtimeService(db).create(create, by),
        });

        expect(succeeded(race.first).durationMinutes).toBe(150);
        expectConflict(refused(race.second), SHOWTIME_OVERLAP_MESSAGE);
        expect(await liveShowtimeIds()).toEqual([neighbour.id]);
        expect(await clashesOn(screen1.id)).toEqual([]);
        expect(race.secondBlockedOn).toMatch(WAITING_ON_MOVIE_LOCK);
      });

      it('the create first: the length change finds the new show and gets 409', async () => {
        const { alpha, screen1, by, longer, create } = await setUp();

        const race = await runInOrder({
          gate: inTransaction('showtime', 'create'),
          first: (db) => showtimeService(db).create(create, by),
          second: (db) => movieService(db).update(alpha.id, longer, by),
        });

        expect(succeeded(race.first).time).toBe('10:00');
        expectConflict(refused(race.second), movieLengthOverlapMessage(1, 1));
        expect(await auditsOf('Movie')).toEqual([]);
        expect(await clashesOn(screen1.id)).toEqual([]);
        expect(race.secondBlockedOn).toMatch(WAITING_ON_MOVIE_LOCK);
      });
    },
  );

  describePg('a movie soft delete versus a create for that movie', () => {
    it('the create first: the delete gets 409 with the count, and the movie stays live', async () => {
      const { alpha, screen1, by } = await fixtures();

      const race = await runInOrder({
        gate: inTransaction('showtime', 'create'),
        first: (db) => showtimeService(db).create(createBody(alpha.id, screen1.id, '10:00'), by),
        second: (db) => movieService(db).softDelete(alpha.id, by),
      });

      const created = succeeded(race.first);
      const refusal = refused(race.second);
      expectConflict(refusal, MOVIE_DELETE_HAS_SHOWTIMES_MESSAGE);
      expect(refusal).toMatchObject({ details: { futureShowtimeCount: 1 } });
      const stored = await testPrisma().movie.findUniqueOrThrow({ where: { id: alpha.id } });
      expect(stored.deletedAt).toBeNull();
      expect(await liveShowtimeIds()).toEqual([created.id]);
      expect(await auditsOf('Showtime')).toEqual([`CREATE ${created.id}`]);
      expect(await auditsOf('Movie')).toEqual([]);
      expect(race.secondBlockedOn).toMatch(WAITING_ON_MOVIE_LOCK);
    });

    it('the delete first: the create gets 409, and no show exists', async () => {
      const { alpha, screen1, by } = await fixtures();

      const race = await runInOrder({
        gate: inTransaction('movie', 'update'),
        first: (db) => movieService(db).softDelete(alpha.id, by),
        second: (db) => showtimeService(db).create(createBody(alpha.id, screen1.id, '10:00'), by),
      });

      expect(succeeded(race.first).deletedAt).toBe(NOW.toISOString());
      expectConflict(refused(race.second), SHOWTIME_MOVIE_DELETED_MESSAGE);
      expect(await liveShowtimeIds()).toEqual([]);
      expect(await auditsOf('Showtime')).toEqual([]);
      expect(await auditsOf('Movie')).toEqual([`DELETE ${alpha.id}`]);
      expect(race.secondBlockedOn).toMatch(WAITING_ON_MOVIE_LOCK);
    });
  });

  describePg('a screen deactivate versus a create on that screen', () => {
    it('the create first: the deactivate gets 409 with the count, and the screen stays active', async () => {
      const { alpha, screen1, by } = await fixtures();

      const race = await runInOrder({
        gate: inTransaction('showtime', 'create'),
        first: (db) => showtimeService(db).create(createBody(alpha.id, screen1.id, '10:00'), by),
        second: (db) => screenService(db).setActive(screen1.id, false, by),
      });

      const created = succeeded(race.first);
      const refusal = refused(race.second);
      expectConflict(refusal, SCREEN_DEACTIVATE_HAS_SHOWTIMES_MESSAGE);
      expect(refusal).toMatchObject({ details: { futureShowtimeCount: 1 } });
      const stored = await testPrisma().screen.findUniqueOrThrow({ where: { id: screen1.id } });
      expect(stored.isActive).toBe(true);
      expect(await liveShowtimeIds()).toEqual([created.id]);
      expect(await auditsOf('Showtime')).toEqual([`CREATE ${created.id}`]);
      expect(await auditsOf('Screen')).toEqual([]);
      expect(race.secondBlockedOn).toMatch(WAITING_ON_SCREEN_LOCK);
    });

    it('the deactivate first: the create gets 409, and no show exists', async () => {
      const { alpha, screen1, by } = await fixtures();

      const race = await runInOrder({
        gate: inTransaction('screen', 'update'),
        first: (db) => screenService(db).setActive(screen1.id, false, by),
        second: (db) => showtimeService(db).create(createBody(alpha.id, screen1.id, '10:00'), by),
      });

      expect(succeeded(race.first).isActive).toBe(false);
      expectConflict(refused(race.second), SHOWTIME_SCREEN_INACTIVE_MESSAGE);
      expect(await liveShowtimeIds()).toEqual([]);
      expect(await auditsOf('Showtime')).toEqual([]);
      expect(await auditsOf('Screen')).toEqual([`STATUS_CHANGE ${screen1.id}`]);
      expect(race.secondBlockedOn).toMatch(WAITING_ON_SCREEN_LOCK);
    });
  });

  describePg('a PATCH move versus a create into the same slot', () => {
    /** Alpha's show on screen 2 at 10:00 moves to screen 1, where Bravo wants 10:30. */
    async function setUp() {
      const shared = await fixtures();
      const moving = await testPrisma().showtime.create({
        data: { movieId: shared.alpha.id, screenId: shared.screen2.id, startsAt: colombo('10:00') },
      });
      const move = showtimeUpdateBodySchema.parse({ screenId: shared.screen1.id });
      const create = createBody(shared.bravo.id, shared.screen1.id, '10:30');
      return { ...shared, moving, move, create };
    }

    it('the move first: the create gets 409 for the moved show', async () => {
      const { screen1, by, moving, move, create } = await setUp();

      const race = await runInOrder({
        gate: inTransaction('showtime', 'update'),
        first: (db) => showtimeService(db).update(moving.id, move, by),
        second: (db) => showtimeService(db).create(create, by),
      });

      expect(succeeded(race.first).screen.id).toBe(screen1.id);
      const refusal = refused(race.second);
      expectConflict(refusal, SHOWTIME_OVERLAP_MESSAGE);
      expect(
        showtimeConflictDetailsSchema.parse((refusal as AppError).details)[0]?.conflict.showtimeId,
      ).toBe(moving.id);
      expect(await liveShowtimeIds()).toEqual([moving.id]);
      expect(await auditsOf('Showtime')).toEqual([`UPDATE ${moving.id}`]);
      expect(await clashesOn(screen1.id)).toEqual([]);
      expect(race.secondBlockedOn).toMatch(WAITING_ON_SCREEN_LOCK);
    });

    it('the create first: the move gets 409 and the show stays where it was', async () => {
      const { screen1, screen2, by, moving, move, create } = await setUp();

      const race = await runInOrder({
        gate: inTransaction('showtime', 'create'),
        first: (db) => showtimeService(db).create(create, by),
        second: (db) => showtimeService(db).update(moving.id, move, by),
      });

      const created = succeeded(race.first);
      const refusal = refused(race.second);
      expectConflict(refusal, SHOWTIME_OVERLAP_MESSAGE);
      expect(
        showtimeConflictDetailsSchema.parse((refusal as AppError).details)[0]?.conflict.showtimeId,
      ).toBe(created.id);
      const stored = await testPrisma().showtime.findUniqueOrThrow({ where: { id: moving.id } });
      expect(stored.screenId).toBe(screen2.id);
      expect(await auditsOf('Showtime')).toEqual([`CREATE ${created.id}`]);
      expect(await clashesOn(screen1.id)).toEqual([]);
      expect(race.secondBlockedOn).toMatch(WAITING_ON_SCREEN_LOCK);
    });
  });

  it('two PATCH moves in opposite directions both finish: the sorted screen locks cannot deadlock', async () => {
    const { alpha, bravo, screen1, screen2, by } = await fixtures();
    const onScreen1 = await testPrisma().showtime.create({
      data: { movieId: alpha.id, screenId: screen1.id, startsAt: colombo('10:00') },
    });
    const onScreen2 = await testPrisma().showtime.create({
      data: { movieId: bravo.id, screenId: screen2.id, startsAt: colombo('19:00') },
    });
    const isScreenLock = (call: DbCall) =>
      call.model === '$queryRaw' && String(call.args[0]).includes('FROM "Screen"');
    const meeting = meetAfterFirstLock(2, isScreenLock);

    const [toScreen2, toScreen1] = await Promise.allSettled([
      showtimeService(meeting.clientFor()).update(
        onScreen1.id,
        showtimeUpdateBodySchema.parse({ screenId: screen2.id }),
        by,
      ),
      showtimeService(meeting.clientFor()).update(
        onScreen2.id,
        showtimeUpdateBodySchema.parse({ screenId: screen1.id }),
        by,
      ),
    ]);

    // A deadlock would surface here as a raw P2010 (SQLSTATE 40P01), a 500 in the API.
    expect(succeeded(toScreen2).screen.id).toBe(screen2.id);
    expect(succeeded(toScreen1).screen.id).toBe(screen1.id);
    expect(await auditsOf('Showtime')).toEqual(
      [`UPDATE ${onScreen1.id}`, `UPDATE ${onScreen2.id}`].sort(),
    );
    // The two really did contend: one queued on the first screen in the shared order.
    expect(meeting.sawWaiter()).toBe(true);
    expect(meeting.waitedOn()).toMatch(WAITING_ON_SCREEN_LOCK);
  });
});

describePg('concurrent same slug on real Postgres, through the HTTP API', () => {
  beforeEach(resetDatabase);
  afterAll(disconnectTestPrisma);

  const ADMIN_EMAIL = 'pg-admin@skcinema.lk';
  const ADMIN_PASSWORD = 'correct horse battery staple';

  /** Signs in on an app that uses `db`, as the admin app would. */
  async function signedIn(db: PrismaClient) {
    await testPrisma().admin.create({
      data: {
        email: ADMIN_EMAIL,
        name: 'PG',
        role: 'EDITOR',
        passwordHash: await testPasswordHash(ADMIN_PASSWORD),
      },
    });
    const { app } = buildTestApp({ prisma: db });
    const client = await authClient(app);
    const login = await client.post('/auth/login', {
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.status).toBe(200);
    return { app, client, session: sessionFrom(login) };
  }

  function postMovie(client: AuthClient, session: Session, body: object) {
    return client.post('/movies', { cookies: [session.access], body });
  }

  function patchMovie(
    app: Express,
    client: AuthClient,
    session: Session,
    id: string,
    body: object,
  ) {
    return request(app)
      .patch(`${ADMIN_BASE}/movies/${id}`)
      .set('User-Agent', TEST_USER_AGENT)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', [client.csrf.cookie, session.access].join('; '))
      .set(CSRF_HEADER, client.csrf.token)
      .send(body);
  }

  /**
   * A client that holds the first `parties` calls matching `isPreCheck` until each has its answer,
   * so all of them go on to write, and records what the movie writes threw.
   */
  function slugRace(isPreCheck: (call: DbCall) => boolean, parties = 2) {
    const meet = rendezvous(parties);
    const preChecks: unknown[] = [];
    const writeErrors: unknown[] = [];
    const db = interceptDb(testPrisma(), async (call, proceed) => {
      if (isPreCheck(call)) {
        const answer = await proceed();
        preChecks.push(answer);
        if (preChecks.length <= parties) await meet();
        return answer;
      }
      if (call.model === 'movie' && (call.method === 'create' || call.method === 'update')) {
        try {
          return await proceed();
        } catch (error) {
          writeErrors.push((error as { code?: unknown }).code);
          throw error;
        }
      }
      return proceed();
    });
    return { db, preChecks, writeErrors };
  }

  const whereOf = (call: DbCall) => (call.args[0] as { where?: Record<string, unknown> }).where;

  const expectSlugConflict = (res: request.Response) => {
    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(res.body).error).toMatchObject({
      code: ERROR_CODES.CONFLICT,
      message: SLUG_IN_USE_MESSAGE,
      details: [{ path: ['body', 'slug'], message: SLUG_IN_USE_MESSAGE }],
    });
  };

  const movieCreateAudits = () =>
    testPrisma().auditLog.findMany({
      where: { entity: 'Movie', action: 'CREATE' },
      select: { entityId: true, details: true },
    });

  it('two creates with the same manual slug: one 201, the other 409, by the real P2002', async () => {
    const race = slugRace(
      (call) =>
        call.scope === 'root' &&
        call.model === 'movie' &&
        call.method === 'findUnique' &&
        whereOf(call)?.['slug'] !== undefined,
    );
    const { client, session } = await signedIn(race.db);

    const responses = await Promise.all(
      ['First', 'Second'].map(async (title) =>
        postMovie(client, session, { title, slug: 'same-slug', durationMinutes: 100 }),
      ),
    );

    expect(responses.map((res) => res.status).sort()).toEqual([201, 409]);
    // Neither saw the other in its pre-check: only the unique index told them apart.
    expect(race.preChecks).toEqual([null, null]);
    expect(race.writeErrors).toEqual(['P2002']);
    const [winner] = responses.filter((res) => res.status === 201);
    const [loser] = responses.filter((res) => res.status === 409);
    if (winner === undefined || loser === undefined) throw new Error('unreachable: checked above');
    expectSlugConflict(loser);
    const created = adminMovieResponseSchema.parse(winner.body).movie;
    expect(await testPrisma().movie.findMany({ select: { id: true } })).toEqual([
      { id: created.id },
    ]);
    expect(await movieCreateAudits()).toEqual([
      { entityId: created.id, details: { title: created.title, slug: 'same-slug' } },
    ]);
  });

  it('two creates with the same auto slug: both 201 with different slugs, by a real retry', async () => {
    const race = slugRace(
      (call) => call.scope === 'root' && call.model === 'movie' && call.method === 'findMany',
    );
    const { client, session } = await signedIn(race.db);

    const responses = await Promise.all(
      [1, 2].map(async () => postMovie(client, session, { title: 'Avatar', durationMinutes: 100 })),
    );

    expect(responses.map((res) => res.status)).toEqual([201, 201]);
    const movies = responses.map((res) => adminMovieResponseSchema.parse(res.body).movie);
    expect(movies.map((movie) => movie.slug).sort()).toEqual(['avatar', 'avatar-2']);
    // One unique violation, one more slug lookup: the loser really went round the retry loop.
    expect(race.writeErrors).toEqual(['P2002']);
    expect(race.preChecks).toEqual([[], [], [{ slug: 'avatar' }]]);
    const audits = await movieCreateAudits();
    expect(audits).toHaveLength(2);
    expect(audits).toEqual(
      expect.arrayContaining(
        movies.map((movie) => ({
          entityId: movie.id,
          details: { title: 'Avatar', slug: movie.slug },
        })),
      ),
    );
  });

  it('a PATCH race onto the same slug: one 200, the other 409, by the real P2002', async () => {
    const race = slugRace(
      (call) => inTransaction('movie', 'findUnique')(call) && whereOf(call)?.['slug'] !== undefined,
    );
    const { app, client, session } = await signedIn(race.db);
    const movie = (slug: string) =>
      testPrisma().movie.create({ data: { slug, title: slug, durationMinutes: 100 } });
    const one = await movie('one');
    const two = await movie('two');

    const responses = await Promise.all(
      [one, two].map(async ({ id }) => patchMovie(app, client, session, id, { slug: 'wanted' })),
    );

    expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(race.preChecks).toEqual([null, null]);
    expect(race.writeErrors).toEqual(['P2002']);
    const [winner] = responses.filter((res) => res.status === 200);
    const [loser] = responses.filter((res) => res.status === 409);
    if (winner === undefined || loser === undefined) throw new Error('unreachable: checked above');
    expectSlugConflict(loser);
    const updated = adminMovieResponseSchema.parse(winner.body).movie;
    expect(updated.slug).toBe('wanted');
    const stored = await testPrisma().movie.findMany({
      select: { slug: true },
      orderBy: { slug: 'asc' },
    });
    expect(stored.map((row) => row.slug)).toEqual(
      [updated.id === one.id ? 'two' : 'one', 'wanted'].sort(),
    );
    const audits = await testPrisma().auditLog.findMany({
      where: { entity: 'Movie', action: 'UPDATE' },
      select: { entityId: true },
    });
    expect(audits).toEqual([{ entityId: updated.id }]);
  });
});
