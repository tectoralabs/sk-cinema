import { z } from 'zod';

/** Error body returned by every API endpoint: `{ error: { code, message, details? } }`. */
export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
