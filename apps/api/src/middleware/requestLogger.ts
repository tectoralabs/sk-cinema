import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import { pinoHttp, stdSerializers } from 'pino-http';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Accept a caller's request ID (e.g. from a proxy) only if it is short and plain. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

function genReqId(req: Request, res: Response): string {
  const incoming = req.headers['x-request-id'];
  const id =
    typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

/**
 * Logs one line per request with its ID, and attaches `req.log` / `req.id`.
 * Headers, cookies, query strings and bodies are never logged.
 */
export function requestLogger(logger: Logger) {
  return pinoHttp<Request, Response>({
    logger,
    genReqId,
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    // Client IP as resolved by Express, which honours the `trust proxy` setting.
    customProps: (req) => ({ ip: req.ip }),
    serializers: {
      req: (req: { id: unknown; method: string; url: string }) => ({
        id: req.id,
        method: req.method,
        url: req.url.split('?')[0],
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      err: stdSerializers.err,
    },
  });
}
