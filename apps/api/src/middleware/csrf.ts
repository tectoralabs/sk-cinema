import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ERROR_CODES } from '@sk-cinema/shared';
import type { Request, RequestHandler, Response } from 'express';
import type { Config } from '../config/env.js';
import { readCsrfCookie, setCsrfCookie } from '../lib/authCookies.js';
import { AppError } from '../lib/errors.js';

export const CSRF_HEADER = 'X-CSRF-Token';

/** Methods that never change state. Everything else is checked (fail closed). */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 32 random bytes as base64url, without padding. */
const CSRF_COOKIE_BYTES = 32;
const CSRF_COOKIE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type CsrfFailure = 'origin_missing' | 'origin_not_allowed' | 'cookie_missing' | 'token_mismatch';

/**
 * The token is an HMAC of the cookie value, so the cookie alone can't be replayed as the
 * header, and a cookie planted without the server secret has no valid token.
 */
function tokenFor(cookieValue: string, csrfSecret: string): string {
  return createHmac('sha256', csrfSecret).update(cookieValue).digest('base64url');
}

function readValidCsrfCookie(req: Request): string | undefined {
  const value = readCsrfCookie(req);
  return value !== undefined && CSRF_COOKIE_PATTERN.test(value) ? value : undefined;
}

/**
 * Returns the CSRF token for this browser, creating the CSRF cookie when it is missing
 * or malformed. An existing cookie is reused, so every tab shares one token.
 */
export function issueCsrfToken(req: Request, res: Response, config: Pick<Config, 'auth'>): string {
  let cookieValue = readValidCsrfCookie(req);
  if (cookieValue === undefined) {
    cookieValue = randomBytes(CSRF_COOKIE_BYTES).toString('base64url');
    setCsrfCookie(res, cookieValue);
  }
  return tokenFor(cookieValue, config.auth.csrfSecret);
}

function originOf(url: string): string | undefined {
  return URL.canParse(url) ? new URL(url).origin : undefined;
}

function checkOrigin(req: Request, allowed: Set<string>): CsrfFailure | undefined {
  const origin = req.get('Origin');
  if (origin !== undefined) return allowed.has(origin) ? undefined : 'origin_not_allowed';

  const referer = req.get('Referer');
  if (referer === undefined) return 'origin_missing';
  const refererOrigin = originOf(referer);
  return refererOrigin !== undefined && allowed.has(refererOrigin)
    ? undefined
    : 'origin_not_allowed';
}

function checkToken(req: Request, csrfSecret: string): CsrfFailure | undefined {
  const cookieValue = readValidCsrfCookie(req);
  if (cookieValue === undefined) return 'cookie_missing';

  const header = req.get(CSRF_HEADER);
  if (header === undefined) return 'token_mismatch';

  const expected = Buffer.from(tokenFor(cookieValue, csrfSecret));
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? undefined
    : 'token_mismatch';
}

/**
 * Signed double-submit CSRF protection for cookie-authenticated routes. Unsafe requests
 * need an allowlisted Origin (or Referer when Origin is absent) and an X-CSRF-Token header
 * matching the CSRF cookie. Every failure gets the same 403 so clients can't tell which
 * check failed.
 */
export function csrfProtection(config: Pick<Config, 'auth' | 'corsOrigins'>): RequestHandler {
  const allowedOrigins = new Set(config.corsOrigins);
  const { csrfSecret } = config.auth;

  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const reason = checkOrigin(req, allowedOrigins) ?? checkToken(req, csrfSecret);
    if (reason !== undefined) {
      // Only the reason: never the token, cookie or header values.
      req.log.debug({ reason }, 'CSRF check failed');
      next(new AppError(403, ERROR_CODES.CSRF_INVALID, 'CSRF validation failed'));
      return;
    }
    next();
  };
}
