import { z } from 'zod';

/** Error codes the API can return. Clients should branch on these, not on messages. */
export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_JSON: 'INVALID_JSON',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** One entry of `details` on a VALIDATION_ERROR. */
export interface ValidationIssue {
  /** Where the problem is: "body", "query" or "params", then the field path. */
  path: (string | number)[];
  message: string;
}

/** Error body returned by every API endpoint: `{ error: { code, message, details? } }`. */
export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
