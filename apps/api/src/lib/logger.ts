import { pino, type DestinationStream, type Logger } from 'pino';
import type { Config } from '../config/env.js';

/**
 * Paths censored if they ever reach a log line. Request/response serializers already drop
 * headers, so this is a second line of defence against secrets logged by hand.
 */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.cookie',
  '*.authorization',
  '*.secret',
  '*.apiSecret',
  '*.databaseUrl',
];

export function createLogger(
  config: Pick<Config, 'logLevel' | 'nodeEnv'>,
  destination?: DestinationStream,
): Logger {
  const pretty = config.nodeEnv === 'development' && destination === undefined;
  return pino(
    {
      level: config.logLevel,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      ...(pretty && {
        transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } },
      }),
    },
    destination,
  );
}
