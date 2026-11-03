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

/** The 4xx status an http-errors style error (body-parser, raw-body) carries, if any. */
function clientErrorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
  for (const value of [status, statusCode]) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 400 && value < 500) {
      return value;
    }
  }
  return undefined;
}

/** body-parser / raw-body error types that mean "the client sent something unreadable". */
const UNREADABLE_BODY_TYPES: ReadonlySet<string> = new Set([
  'request.aborted',
  'request.size.invalid',
  'stream.encoding.set',
]);

/**
 * Malformed input that is the client's fault, mapped to a 4xx with a fixed message: a URL
 * parameter with a bad percent escape (Express throws a URIError whose message echoes the
 * text), and body-parser failures other than bad JSON and size (unsupported Content-Encoding or
 * charset, a corrupt gzip body, an aborted upload). Never echoes the input.
 */
function malformedRequest(
  err: unknown,
): { status: number; error: ApiError['error']; kind: string } | undefined {
  if (err instanceof URIError) {
    return {
      status: 400,
      kind: 'URIError',
      error: { code: ERROR_CODES.BAD_REQUEST, message: 'Malformed request URL' },
    };
  }
  const type = bodyParserErrorType(err);
  const status = clientErrorStatus(err);
  if (type === 'encoding.unsupported' || type === 'charset.unsupported') {
    return {
      status: 415,
      kind: type,
      error: {
        code: ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
        message: 'Unsupported content encoding or charset',
      },
    };
  }
  if (status === 415) {
    return {
      status: 415,
      kind: type ?? 'http.415',
      error: { code: ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, message: 'Unsupported media type' },
    };
  }
  if (status !== undefined || (type !== undefined && UNREADABLE_BODY_TYPES.has(type))) {
    return {
      status: 400,
      kind: type ?? `http.${String(status)}`,
      error: { code: ERROR_CODES.BAD_REQUEST, message: 'The request could not be read' },
    };
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

  const malformed = malformedRequest(err);
  if (malformed) {
    // Client mistakes, not server faults: no error-level line, and only the kind and status are
    // logged (an error message here can echo the client's own text).
    req.log.info({ kind: malformed.kind, status: malformed.status }, 'Malformed request');
    res.set('Cache-Control', 'no-store');
    sendError(res, malformed.status, malformed.error);
    return;
  }

  req.log.error({ err }, 'Unhandled error');
  sendError(res, 500, { code: ERROR_CODES.INTERNAL_ERROR, message: 'Something went wrong' });
};
