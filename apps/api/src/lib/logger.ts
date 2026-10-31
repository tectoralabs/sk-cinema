import { pino, type DestinationStream, type Logger } from 'pino';
import type { Config } from '../config/env.js';

/**
 * Key names whose values are censored wherever they appear in a log line, from the top level
 * down to REDACT_DEPTH levels of nesting (e.g. `password`, `user.password`,
 * `req.body.password`, `req.raw.headers.cookie`). Request/response serializers already drop
 * headers, cookies and bodies, so this is a second line of defence against secrets logged by
 * hand. Only secret-bearing names belong here: ids, roles and reasons must stay readable.
 */
export const REDACT_KEYS = [
  // Credentials
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  // Tokens
  'token',
  'accessToken',
  'refreshToken',
  'tokenHash',
  'csrfToken',
  // Secrets (config.auth.*, Cloudinary, the DB URL)
  'jwtAccessSecret',
  'csrfSecret',
  'secret',
  'apiSecret',
  'databaseUrl',
  // Headers and cookies
  'cookie',
  'cookies',
  'set-cookie',
  'authorization',
  'x-csrf-token',
] as const;

/** Deepest level a REDACT_KEYS name is censored at (1 = top level). */
export const REDACT_DEPTH = 4;

/** `password` -> password; `x-csrf-token` -> ["x-csrf-token"] (fast-redact path syntax). */
const pathSegment = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`);

/**
 * pino `redact` paths for every key at every depth from 1 to REDACT_DEPTH:
 * `password`, `*.password`, `*.*.password`, ... and `["x-csrf-token"]`, `*["x-csrf-token"]`, ...
 * Plain paths compiled once by fast-redact: no per-line object walk of our own.
 */
export const REDACT_PATHS: string[] = REDACT_KEYS.flatMap((key) => {
  const segment = pathSegment(key);
  return Array.from({ length: REDACT_DEPTH }, (_, depth) => {
    if (depth === 0) return segment;
    const wildcards = Array<string>(depth).fill('*').join('.');
    return segment.startsWith('[') ? `${wildcards}${segment}` : `${wildcards}.${segment}`;
  });
});

export const REDACT_CENSOR = '[REDACTED]';

export function createLogger(
  config: Pick<Config, 'logLevel' | 'nodeEnv'>,
  destination?: DestinationStream,
): Logger {
  const pretty = config.nodeEnv === 'development' && destination === undefined;
  return pino(
    {
      level: config.logLevel,
      redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
      ...(pretty && {
        transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } },
      }),
    },
    destination,
  );
}
