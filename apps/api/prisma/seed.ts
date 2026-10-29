/**
 * Seeds the database. Safe to run repeatedly: existing rows are left untouched
 * (an existing admin's password is never reset, edited settings are never overwritten).
 *
 * Always creates: the SUPER_ADMIN from env, two screens, default settings.
 * Sample movies and showtimes: on by default, off when NODE_ENV=production.
 * Override with SEED_SAMPLE_DATA=true|false.
 */
import { z } from 'zod';
import type { Prisma, PrismaClient } from '../src/generated/prisma/client.js';
import { addDays, fromColomboDateTime, toColomboDate } from '../src/lib/colomboTime.js';
import { hashPassword } from '../src/lib/password.js';
import { createPrismaClient } from '../src/lib/prisma.js';
import { DEFAULT_SETTINGS } from '../src/lib/settings.js';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  SEED_SUPER_ADMIN_EMAIL: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  SEED_SUPER_ADMIN_PASSWORD: z.string().min(12).max(128),
  SEED_SUPER_ADMIN_NAME: z.string().trim().min(1).max(100).default('Super Admin'),
  SEED_SAMPLE_DATA: z.enum(['true', 'false']).optional(),
});

type Env = z.infer<typeof envSchema>;

const SCREENS = [
  { name: 'Screen 1', capacity: 300 },
  { name: 'Screen 2', capacity: 180 },
] as const;

const SAMPLE_DAYS = 7;

function readEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    // Report only the variable names and rules, never the values.
    const problems = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid seed environment:\n${problems.join('\n')}`);
  }
  return result.data;
}

async function seedSuperAdmin(prisma: PrismaClient, env: Env): Promise<void> {
  const email = env.SEED_SUPER_ADMIN_EMAIL;
  const existing = await prisma.admin.findUnique({ where: { email }, select: { role: true } });
  if (existing) {
    console.info(`Admin ${email} already exists (${existing.role}); left unchanged.`);
    return;
  }

  await prisma.admin.create({
    data: {
      email,
      name: env.SEED_SUPER_ADMIN_NAME,
      passwordHash: await hashPassword(env.SEED_SUPER_ADMIN_PASSWORD),
      role: 'SUPER_ADMIN',
    },
  });
  console.info(`Created SUPER_ADMIN ${email}.`);
}

async function seedScreens(prisma: PrismaClient): Promise<void> {
  for (const screen of SCREENS) {
    await prisma.screen.upsert({ where: { name: screen.name }, create: screen, update: {} });
  }
  console.info(`Screens: ${SCREENS.map((s) => s.name).join(', ')}.`);
}

async function seedSettings(prisma: PrismaClient): Promise<void> {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await prisma.setting.upsert({ where: { key }, create: { key, value }, update: {} });
  }
  console.info(`Settings: ${Object.keys(DEFAULT_SETTINGS).join(', ')}.`);
}

function sampleMovies(today: string): Prisma.MovieCreateInput[] {
  const sample = '[Sample data] ';
  return [
    {
      slug: 'monsoon-over-galle',
      title: 'Monsoon Over Galle',
      synopsis: `${sample}A fisherman's daughter fights to save her family's boat as the monsoon closes in.`,
      durationMinutes: 128,
      language: 'Sinhala',
      genres: ['Drama'],
      rating: 'PG',
      director: 'Nadeeka Perera',
      cast: ['Ishara Fernando', 'Kasun Jayasinghe'],
      releaseDate: new Date(`${addDays(today, -10)}T00:00:00Z`),
      status: 'NOW_SHOWING',
    },
    {
      slug: 'the-last-train-north',
      title: 'The Last Train North',
      synopsis: `${sample}Strangers on an overnight train discover they share a dangerous secret.`,
      durationMinutes: 142,
      language: 'Tamil',
      genres: ['Thriller', 'Mystery'],
      rating: '15+',
      director: 'Arun Sivakumar',
      cast: ['Priya Rajan', 'Vijay Kumaran'],
      releaseDate: new Date(`${addDays(today, -5)}T00:00:00Z`),
      status: 'NOW_SHOWING',
    },
    {
      slug: 'orbit-of-silence',
      title: 'Orbit of Silence',
      synopsis: `${sample}A lone engineer must restart a failing space station before it falls to Earth.`,
      durationMinutes: 135,
      language: 'English',
      genres: ['Sci-Fi', 'Adventure'],
      rating: 'PG',
      director: 'Hannah Cole',
      cast: ['Marcus Reid', 'Elena Park'],
      releaseDate: new Date(`${addDays(today, -3)}T00:00:00Z`),
      status: 'NOW_SHOWING',
    },
    {
      slug: 'lanterns-of-vesak',
      title: 'Lanterns of Vesak',
      synopsis: `${sample}Three friends race to finish the village's Vesak pandal in one week.`,
      durationMinutes: 118,
      language: 'Sinhala',
      genres: ['Comedy', 'Family'],
      rating: 'U',
      status: 'UPCOMING',
      releaseDate: new Date(`${addDays(today, 21)}T00:00:00Z`),
    },
    {
      slug: 'iron-reef',
      title: 'Iron Reef',
      synopsis: `${sample}A salvage crew uncovers a wartime wreck that someone wants kept buried.`,
      durationMinutes: 126,
      language: 'English',
      genres: ['Action'],
      rating: '15+',
      status: 'UPCOMING',
      releaseDate: new Date(`${addDays(today, 35)}T00:00:00Z`),
    },
  ];
}

/** Daily schedule in Colombo time. Times on each screen leave room for the longest film. */
const DAILY_SCHEDULE: { screen: string; slug: string; times: string[] }[] = [
  { screen: 'Screen 1', slug: 'monsoon-over-galle', times: ['10:30', '18:30'] },
  { screen: 'Screen 1', slug: 'orbit-of-silence', times: ['14:00', '21:30'] },
  { screen: 'Screen 2', slug: 'the-last-train-north', times: ['11:00', '15:00', '19:00'] },
];

async function seedSamples(prisma: PrismaClient): Promise<void> {
  const today = toColomboDate(new Date());

  const movieIds = new Map<string, string>();
  for (const movie of sampleMovies(today)) {
    const { id } = await prisma.movie.upsert({
      where: { slug: movie.slug },
      create: movie,
      update: {},
      select: { id: true },
    });
    movieIds.set(movie.slug, id);
  }

  const screens = await prisma.screen.findMany({
    where: { name: { in: SCREENS.map((s) => s.name) } },
    select: { id: true, name: true },
  });
  const screenIds = new Map(screens.map((s) => [s.name, s.id]));

  const wanted: { movieId: string; screenId: string; startsAt: Date }[] = [];
  for (let day = 0; day < SAMPLE_DAYS; day++) {
    const date = addDays(today, day);
    for (const { screen, slug, times } of DAILY_SCHEDULE) {
      const screenId = screenIds.get(screen);
      const movieId = movieIds.get(slug);
      if (!screenId || !movieId) throw new Error(`Missing screen or movie: ${screen} / ${slug}`);
      for (const time of times) {
        wanted.push({ movieId, screenId, startsAt: fromColomboDateTime(date, time) });
      }
    }
  }

  // Skip slots that already exist so re-running the seed does not duplicate showtimes.
  const instants = wanted.map((s) => s.startsAt.getTime());
  const existing = await prisma.showtime.findMany({
    where: {
      screenId: { in: [...screenIds.values()] },
      startsAt: {
        gte: new Date(Math.min(...instants)),
        lte: new Date(Math.max(...instants)),
      },
    },
    select: { screenId: true, startsAt: true },
  });
  const slotKey = (screenId: string, at: Date) => `${screenId}|${at.toISOString()}`;
  const taken = new Set(existing.map((s) => slotKey(s.screenId, s.startsAt)));
  const missing = wanted.filter((s) => !taken.has(slotKey(s.screenId, s.startsAt)));

  if (missing.length > 0) await prisma.showtime.createMany({ data: missing });
  console.info(
    `Sample data: ${movieIds.size} movies; ${missing.length} new showtimes ` +
      `(${today} to ${addDays(today, SAMPLE_DAYS - 1)}, Colombo time).`,
  );
}

async function main(): Promise<void> {
  const env = readEnv();
  const withSamples =
    env.SEED_SAMPLE_DATA === undefined
      ? env.NODE_ENV !== 'production'
      : env.SEED_SAMPLE_DATA === 'true';

  const prisma = createPrismaClient(env.DATABASE_URL);
  try {
    await seedSuperAdmin(prisma, env);
    await seedScreens(prisma);
    await seedSettings(prisma);
    if (withSamples) await seedSamples(prisma);
    else console.info('Sample data skipped.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Seed failed.');
  process.exitCode = 1;
});
