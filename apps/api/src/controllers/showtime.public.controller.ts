import type {
  PublicMovieIdParams,
  PublicShowtimeDatesResponse,
  PublicShowtimeListQuery,
  PublicShowtimeListResponse,
} from '@sk-cinema/shared';
import type { RequestHandler } from 'express';
import type { PublicShowtimeService } from '../services/showtime.public.service.js';

/** Public showtime endpoints. Input is already parsed by validate() in the routes. */
export function createPublicShowtimeController(service: PublicShowtimeService) {
  const listDates: RequestHandler = async (req, res) => {
    const { id } = req.params as PublicMovieIdParams;
    const dates = await service.listDates(id);
    res.json({ dates } satisfies PublicShowtimeDatesResponse);
  };

  const listForDate: RequestHandler = async (req, res) => {
    const { id } = req.params as PublicMovieIdParams;
    const { date } = req.query as PublicShowtimeListQuery;
    const items = await service.listForDate(id, date);
    res.json({ date, items } satisfies PublicShowtimeListResponse);
  };

  return { listDates, listForDate };
}

export type PublicShowtimeController = ReturnType<typeof createPublicShowtimeController>;
