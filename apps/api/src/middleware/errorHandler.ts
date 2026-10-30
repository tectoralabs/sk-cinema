import { ERROR_CODES, type ApiError } from '@sk-cinema/shared';
import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { AppError } from '../lib/errors.js';

function sendError(res: Response, status: number, error: ApiError['error']): void {
  res.status(status).json({ error } satisfies ApiError);
}

/** body-parser errors carry a `type` such as "entity.parse.failed". */
function bodyParserErrorType(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'type' in err && typeof err.type === 'string') {
    return err.type;
  }
  return undefined;
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  sendError(res, 404, { code: ERROR_CODES.NOT_FOUND, message: 'Route not found' });
};

/** Converts every error to `{ error: { code, message, details? } }`. Never leaks internals. */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof AppError) {
    if (err.status >= 500) req.log.error({ err }, 'Request failed');
    sendError(res, err.status, {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined && { details: err.details }),
    });
    return;
  }

  switch (bodyParserErrorType(err)) {
    case 'entity.parse.failed':
      sendError(res, 400, { code: ERROR_CODES.INVALID_JSON, message: 'Malformed JSON body' });
      return;
    case 'entity.too.large':
      sendError(res, 413, {
        code: ERROR_CODES.PAYLOAD_TOO_LARGE,
        message: 'Request body too large',
      });
      return;
  }

  req.log.error({ err }, 'Unhandled error');
  sendError(res, 500, { code: ERROR_CODES.INTERNAL_ERROR, message: 'Something went wrong' });
};
