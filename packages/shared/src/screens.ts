import { z } from 'zod';
import {
  deletedFilterSchema,
  pageQuerySchema,
  pageSizeQuerySchema,
  queryBooleanSchema,
  querySearchSchema,
  singleLineTextSchema,
} from './common.js';

/* -------------------------------------------------------------------------- */
/* Building blocks                                                            */
/* -------------------------------------------------------------------------- */

/** Matches `Screen.name VarChar(50)`. */
export const SCREEN_NAME_MAX_LENGTH = 50;

/** Largest seat count accepted for a screen. */
export const SCREEN_CAPACITY_MAX = 2000;

/**
 * Screen name, trimmed, 1–50 characters, no control characters. Names are unique ignoring case;
 * the screens service enforces that (409 CONFLICT), not this schema.
 */
export const screenNameSchema = singleLineTextSchema(SCREEN_NAME_MAX_LENGTH);

/** Seat count: a whole number from 1 to SCREEN_CAPACITY_MAX. */
export const screenCapacitySchema = z.number().int().min(1).max(SCREEN_CAPACITY_MAX);

/* -------------------------------------------------------------------------- */
/* Params                                                                     */
/* -------------------------------------------------------------------------- */

/** Params of admin routes addressing a screen by ID, e.g. /api/admin/screens/:id. */
export const screenIdParamsSchema = z.strictObject({
  id: z.uuid(),
});

export type ScreenIdParams = z.infer<typeof screenIdParamsSchema>;

/* -------------------------------------------------------------------------- */
/* Request bodies                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Body of POST /api/admin/screens. `capacity` is optional; send `null` or leave it out for
 * "unknown". New screens are active; visibility has its own endpoint.
 */
export const screenCreateBodySchema = z.strictObject({
  name: screenNameSchema,
  capacity: screenCapacitySchema.nullable().optional(),
});

export type ScreenCreateBody = z.infer<typeof screenCreateBodySchema>;
export type ScreenCreateBodyInput = z.input<typeof screenCreateBodySchema>;

/** Body of PATCH /api/admin/screens/:id. At least one field; `capacity: null` clears it. */
export const screenUpdateBodySchema = z
  .strictObject({
    name: screenNameSchema.optional(),
    capacity: screenCapacitySchema.nullable().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one field to update',
  });

export type ScreenUpdateBody = z.infer<typeof screenUpdateBodySchema>;
export type ScreenUpdateBodyInput = z.input<typeof screenUpdateBodySchema>;

/** Body of PATCH /api/admin/screens/:id/active. */
export const screenActiveBodySchema = z.strictObject({
  isActive: z.boolean(),
});

export type ScreenActiveBody = z.infer<typeof screenActiveBodySchema>;

/* -------------------------------------------------------------------------- */
/* Query strings                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Query of GET /api/admin/screens. All values arrive as strings and are converted here.
 * Results are sorted by name (the service decides the exact collation).
 */
export const adminScreenListQuerySchema = z.strictObject({
  /** Search by name. Whitespace-only is treated as no search. */
  search: querySearchSchema.optional(),
  /** Only the literal strings 'true' and 'false' are accepted. */
  isActive: queryBooleanSchema.optional(),
  /** Soft-deleted screens: hide them (default), include them, or show only them. */
  deleted: deletedFilterSchema.default('exclude'),
  page: pageQuerySchema,
  pageSize: pageSizeQuerySchema,
});

export type AdminScreenListQuery = z.infer<typeof adminScreenListQuerySchema>;
export type AdminScreenListQueryInput = z.input<typeof adminScreenListQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

/** A screen as returned by admin endpoints: every column, timestamps as ISO 8601 strings. */
export const adminScreenSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  capacity: z.number().int().nullable(),
  isActive: z.boolean(),
  deletedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type AdminScreen = z.infer<typeof adminScreenSchema>;

/** Response of GET /api/admin/screens. */
export const adminScreenListResponseSchema = z.strictObject({
  items: z.array(adminScreenSchema),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
  total: z.number().int().min(0),
});

export type AdminScreenListResponse = z.infer<typeof adminScreenListResponseSchema>;

/**
 * Response of admin endpoints that return a single screen
 * (get, create, update, active, soft delete, restore), as the movie endpoints do.
 */
export const adminScreenResponseSchema = z.strictObject({
  screen: adminScreenSchema,
});

export type AdminScreenResponse = z.infer<typeof adminScreenResponseSchema>;
