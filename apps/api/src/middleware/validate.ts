import { ERROR_CODES, type ValidationIssue } from '@sk-cinema/shared';
import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { AppError } from '../lib/errors.js';

type Part = 'body' | 'query' | 'params';
type ObjectSchema = z.ZodObject;

export type RequestSchemas = Partial<Record<Part, ObjectSchema>>;

/**
 * Validates req.body / req.query / req.params and replaces each with the parsed value
 * (so coercions and defaults apply). Unknown keys are always rejected.
 * Parts without a schema are left as they are.
 */
export function validate(schemas: RequestSchemas): RequestHandler {
  const strict = Object.fromEntries(
    Object.entries(schemas).map(([part, schema]) => [part, schema.strict()]),
  ) as RequestSchemas;

  return (req, _res, next) => {
    const issues: ValidationIssue[] = [];
    const parsed: Partial<Record<Part, unknown>> = {};

    for (const part of ['params', 'query', 'body'] as const) {
      const schema = strict[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (result.success) {
        parsed[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          issues.push({
            path: [part, ...issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p))],
            message: issue.message,
          });
        }
      }
    }

    if (issues.length > 0) {
      next(new AppError(400, ERROR_CODES.VALIDATION_ERROR, 'Invalid request', issues));
      return;
    }

    if ('body' in parsed) req.body = parsed.body;
    if ('params' in parsed) req.params = parsed.params as typeof req.params;
    // Express 5 exposes req.query as a getter, so shadow it on this request.
    if ('query' in parsed) {
      Object.defineProperty(req, 'query', { value: parsed.query, enumerable: true });
    }
    next();
  };
}
