import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** A bare origin such as https://example.com or http://localhost:5173 (no path, query or hash). */
const originSchema = z.url({ protocol: /^https?$/ }).refine((value) => {
  // Zod runs refinements even after the URL check fails; that failure is already reported.
  if (!URL.canParse(value)) return true;
  const url = new URL(value);
  return url.origin === value.replace(/\/$/, '') && url.username === '' && url.password === '';
}, 'must be a bare origin like https://example.com');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//, 'must be a postgresql:// connection string'),
    CORS_ORIGINS: z
      .string()
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim().replace(/\/$/, ''))
          .filter(Boolean),
      )
      .pipe(z.array(originSchema).min(1, 'must list at least one origin')),
    /** Number of reverse proxies in front of the app (e.g. Cloudflare + nginx = 2). 0 = none. */
    TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    env.CORS_ORIGINS.forEach((origin, index) => {
      if (!origin.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ORIGINS', index],
          message: 'must use https in production',
        });
      }
    });
  });

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  logLevel: (typeof LOG_LEVELS)[number];
  databaseUrl: string;
  corsOrigins: string[];
  trustProxy: number;
  rateLimit: { windowMs: number; max: number };
}

export class EnvValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment variables:\n${problems.map((p) => `  ${p}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Validates environment variables and returns typed config.
 * Throws EnvValidationError naming each bad variable — never its value.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }

  const env = result.data;
  return {
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    corsOrigins: env.CORS_ORIGINS,
    trustProxy: env.TRUST_PROXY,
    rateLimit: { windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_MAX },
  };
}
