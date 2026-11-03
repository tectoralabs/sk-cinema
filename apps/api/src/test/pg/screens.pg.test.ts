/**
 * Phase 5 T9 screen behaviour proven on real Postgres 18 (C.UTF-8, like Neon), where the
 * in-memory fake can only imitate it:
 *   1. the name check (`equals` + `mode: 'insensitive'`, which Prisma sends as an unescaped
 *      ILIKE) ignores case but matches `%`, `_` and `\` literally once escapeLikePattern runs;
 *   2. the P2002 a duplicate name really throws has the shape isScreenNameClash relies on;
 *   3. the future-showtime guard counts with the row lock held (real `$queryRaw` lock SQL).
 */
import { screenCreateBodySchema, type ScreenCreateBodyInput } from '@sk-cinema/shared';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { MemoryCache } from '../../lib/cache.js';
import { AppError } from '../../lib/errors.js';
import type { AuditActor } from '../../services/audit.service.js';
import {
  SCREEN_DEACTIVATE_HAS_SHOWTIMES_MESSAGE,
  SCREEN_NAME_IN_USE_MESSAGE,
  createScreenAdminService,
  isScreenNameClash,
} from '../../services/screen.admin.service.js';
import { describePg, disconnectTestPrisma, resetDatabase, testPrisma } from './db.js';

async function actor(): Promise<AuditActor> {
  const admin = await testPrisma().admin.create({
    data: { email: 'pg-admin@skcinema.lk', name: 'PG', passwordHash: '$argon2id$placeholder' },
  });
  return { adminId: admin.id, ipAddress: '203.0.113.7', userAgent: 'pg test' };
}

const service = () => createScreenAdminService({ db: testPrisma(), cache: new MemoryCache() });

const create = (by: AuditActor, body: ScreenCreateBodyInput) =>
  service().create(screenCreateBodySchema.parse(body), by);

describePg('screens on real Postgres', () => {
  beforeEach(resetDatabase);
  afterAll(disconnectTestPrisma);

  it('the name check ignores case but treats %, _ and \\ literally', async () => {
    const by = await actor();
    for (const name of ['ABC', '1000', 'AC', 'Écran']) await create(by, { name });

    // Each would match an existing name if the ILIKE pattern were not escaped.
    for (const name of ['A_C', '100%', 'A\\C', '%']) {
      expect((await create(by, { name })).name).toBe(name);
    }
    // Case is ignored, wildcard characters included; accents still count.
    for (const name of ['abc', 'a_c', 'a\\c', 'écran']) {
      const error = await create(by, { name }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ status: 409, message: SCREEN_NAME_IN_USE_MESSAGE });
    }
    expect((await create(by, { name: 'ecran' })).name).toBe('ecran');
    expect(await testPrisma().screen.count()).toBe(9);
  });

  it('a duplicate name throws the P2002 isScreenNameClash expects (no meta.target)', async () => {
    await testPrisma().screen.create({ data: { name: 'Screen 1' } });

    const error = await testPrisma()
      .screen.create({ data: { name: 'Screen 1' } })
      .catch((e: unknown) => e);

    expect(isScreenNameClash(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'P2002',
      meta: {
        modelName: 'Screen',
        driverAdapterError: { cause: { constraint: { index: 'Screen_name_key' } } },
      },
    });
    expect((error as { meta?: Record<string, unknown> }).meta?.['target']).toBeUndefined();
  });

  it('hiding a screen with an upcoming showtime is refused with the count', async () => {
    const by = await actor();
    const screen = await create(by, { name: 'Screen 1' });
    const movie = await testPrisma().movie.create({
      data: { slug: 'm', title: 'M', durationMinutes: 100 },
    });
    await testPrisma().showtime.createMany({
      data: [
        { movieId: movie.id, screenId: screen.id, startsAt: new Date('2099-01-01T13:30:00Z') },
        { movieId: movie.id, screenId: screen.id, startsAt: new Date('2000-01-01T13:30:00Z') },
      ],
    });

    const error = await service()
      .setActive(screen.id, false, by)
      .catch((e: unknown) => e);

    expect(error).toMatchObject({
      status: 409,
      message: SCREEN_DEACTIVATE_HAS_SHOWTIMES_MESSAGE,
      details: { futureShowtimeCount: 1 },
    });
    expect(
      (await testPrisma().screen.findUniqueOrThrow({ where: { id: screen.id } })).isActive,
    ).toBe(true);
  });
});
