/**
 * Phase 5 T18b: the years a showtime request may name (showtimeDateSchema, 2020 to 2099), through
 * the routes on real Postgres. Outside them the answer is a 400 on the date field, never a 500
 * from the date arithmetic or from a timestamp Postgres or JavaScript cannot hold, and never the
 * "in the past" 400, which is a different promise.
 */
import {
  adminShowtimeListResponseSchema,
  showtimeBulkCreateResponseSchema,
} from '@sk-cinema/shared';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { describePg, disconnectTestPrisma, resetDatabase, testPrisma } from './db.js';
import { expectValidationError, freezeClock, signedInAdmin } from './http.js';

/** 2026-11-01 15:30 in Colombo. */
const NOW = new Date('2026-11-01T10:00:00.000Z');

async function fixtures() {
  const prisma = testPrisma();
  const movie = await prisma.movie.create({
    data: { slug: 'm', title: 'Main Feature', durationMinutes: 120, status: 'NOW_SHOWING' },
  });
  const screen = await prisma.screen.create({ data: { name: 'Screen 1' } });
  return { movie, screen, api: await signedInAdmin() };
}

const showtimeWrites = async () => ({
  showtimes: await testPrisma().showtime.count(),
  audits: await testPrisma().auditLog.count({ where: { entity: 'Showtime' } }),
});

describePg('showtime date limits through the routes on real Postgres', () => {
  beforeEach(async () => {
    freezeClock(NOW);
    await resetDatabase();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(disconnectTestPrisma);

  it('POST a year-2000 date: 400 on the date, nothing written', async () => {
    const { movie, screen, api } = await fixtures();

    const res = await api.post('/showtimes', {
      movieId: movie.id,
      screenId: screen.id,
      date: '2000-06-01',
      time: '23:45',
    });

    expectValidationError(res, ['body', 'date']);
    expect(await showtimeWrites()).toEqual({ showtimes: 0, audits: 0 });
  });

  it('PATCH to a year-2000 date: 400 on the date, the show stays where it was', async () => {
    const { movie, screen, api } = await fixtures();
    const startsAt = new Date('2026-11-03T13:30:00.000Z');
    const show = await testPrisma().showtime.create({
      data: { movieId: movie.id, screenId: screen.id, startsAt },
    });

    const res = await api.patch(`/showtimes/${show.id}`, { date: '2000-06-01', time: '23:45' });

    expectValidationError(res, ['body', 'date']);
    const stored = await testPrisma().showtime.findUniqueOrThrow({ where: { id: show.id } });
    expect(stored.startsAt).toEqual(startsAt);
    expect(await showtimeWrites()).toEqual({ showtimes: 1, audits: 0 });
  });

  it.each([
    ['from', 'from=0002-11-02'],
    ['to', 'to=9999-12-31'],
  ])('the admin list refuses an out-of-range ?%s with a 400', async (field, query) => {
    const { api } = await fixtures();

    const res = await api.get(`/showtimes?${query}`);

    expectValidationError(res, ['query', field]);
  });

  it('a list up to 2099-12-31 is a 200, and its end is the last moment of that Colombo day', async () => {
    const { movie, screen, api } = await fixtures();
    const show = (startsAt: string) => ({
      movieId: movie.id,
      screenId: screen.id,
      startsAt: new Date(startsAt),
    });
    await testPrisma().showtime.createMany({
      data: [
        // 2099-12-31 23:45 in Colombo: on the last day.
        show('2099-12-31T18:15:00.000Z'),
        // 2100-01-01 00:00 in Colombo: the exclusive end computed from `to`.
        show('2099-12-31T18:30:00.000Z'),
      ],
    });

    const res = await api.get('/showtimes?from=2099-12-31&to=2099-12-31');

    expect(res.status).toBe(200);
    const list = adminShowtimeListResponseSchema.parse(res.body);
    expect(list.items.map((item) => item.startsAt)).toEqual(['2099-12-31T18:15:00.000Z']);
    expect(list.total).toBe(1);
  });

  it('a bulk range ending 2099-12-31 is a 201, with rows at the right UTC instants', async () => {
    const { movie, screen, api } = await fixtures();

    const res = await api.post('/showtimes/bulk', {
      movieId: movie.id,
      screenId: screen.id,
      dateFrom: '2099-12-30',
      dateTo: '2099-12-31',
      times: ['02:30', '23:45'],
    });

    expect(res.status).toBe(201);
    const { created, items } = showtimeBulkCreateResponseSchema.parse(res.body);
    expect(created).toBe(4);
    const rows = await testPrisma().showtime.findMany({
      orderBy: { startsAt: 'asc' },
      select: { startsAt: true },
    });
    expect(rows.map((row) => row.startsAt.toISOString())).toEqual([
      '2099-12-29T21:00:00.000Z',
      '2099-12-30T18:15:00.000Z',
      '2099-12-30T21:00:00.000Z',
      '2099-12-31T18:15:00.000Z',
    ]);
    expect(items.map((item) => `${item.colomboDate} ${item.time}`)).toEqual([
      '2099-12-30 02:30',
      '2099-12-30 23:45',
      '2099-12-31 02:30',
      '2099-12-31 23:45',
    ]);
    expect(items[3]?.bookingUrl.endsWith('/20991231')).toBe(true);
  });

  it('a bulk starting in 2100 is a 400 on both dates, nothing written', async () => {
    const { movie, screen, api } = await fixtures();

    const res = await api.post('/showtimes/bulk', {
      movieId: movie.id,
      screenId: screen.id,
      dateFrom: '2100-01-01',
      dateTo: '2100-01-02',
      times: ['19:00'],
    });

    expectValidationError(res, ['body', 'dateFrom'], ['body', 'dateTo']);
    expect(await showtimeWrites()).toEqual({ showtimes: 0, audits: 0 });
  });

  it('a bulk running over into 2100 is a 400 on its end date, nothing written', async () => {
    const { movie, screen, api } = await fixtures();

    const res = await api.post('/showtimes/bulk', {
      movieId: movie.id,
      screenId: screen.id,
      dateFrom: '2099-12-31',
      dateTo: '2100-01-01',
      times: ['19:00'],
    });

    expectValidationError(res, ['body', 'dateTo']);
    expect(await showtimeWrites()).toEqual({ showtimes: 0, audits: 0 });
  });
});
