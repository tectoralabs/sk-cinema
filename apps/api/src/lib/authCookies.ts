import type { CookieOptions, Request, Response } from 'express';
import type { Config } from '../config/env.js';

/**
 * Auth cookie names. `__Host-` makes the browser require Secure, Path=/ and no Domain,
 * so a sibling subdomain can neither set nor overwrite them. The refresh cookie needs a
 * narrower path, so it can only use `__Secure-`.
 */
export const ACCESS_COOKIE_NAME = '__Host-sk_access';
export const REFRESH_COOKIE_NAME = '__Secure-sk_refresh';
export const CSRF_COOKIE_NAME = '__Host-sk_csrf';

/** The refresh token is only ever sent to the auth endpoints (refresh, logout). */
export const REFRESH_COOKIE_PATH = '/api/admin/auth';

/**
 * Shared by every auth cookie. Secure stays on in development too: browsers treat
 * http://localhost as a secure context. No Domain, so cookies stay host-only.
 */
const BASE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
} as const satisfies CookieOptions;

const ACCESS_COOKIE_OPTIONS = { ...BASE_COOKIE_OPTIONS, path: '/' } as const;
const REFRESH_COOKIE_OPTIONS = { ...BASE_COOKIE_OPTIONS, path: REFRESH_COOKIE_PATH } as const;
// Session cookie (no Max-Age): the admin app fetches a CSRF token on load, which recreates it.
const CSRF_COOKIE_OPTIONS = { ...BASE_COOKIE_OPTIONS, path: '/' } as const;

export interface AuthCookieValues {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry of the refresh token. Rotation keeps the original value. */
  refreshExpiresAt: Date;
}

export function setAuthCookies(
  res: Response,
  { accessToken, refreshToken, refreshExpiresAt }: AuthCookieValues,
  config: Pick<Config, 'auth'>,
): void {
  res.cookie(ACCESS_COOKIE_NAME, accessToken, {
    ...ACCESS_COOKIE_OPTIONS,
    maxAge: config.auth.accessTokenTtlSeconds * 1000,
  });
  // Express turns maxAge (ms) into Max-Age (whole seconds) and Expires = now + maxAge.
  const remainingMs = Math.max(0, refreshExpiresAt.getTime() - Date.now());
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, { ...REFRESH_COOKIE_OPTIONS, maxAge: remainingMs });
}

/**
 * Deletes the access and refresh cookies. Name, path and attributes must match how they
 * were set, or browsers keep the originals. The CSRF cookie is kept: it is not tied to a
 * session, and keeping it means the admin app's current CSRF token stays valid for the
 * next login.
 */
export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE_NAME, ACCESS_COOKIE_OPTIONS);
  res.clearCookie(REFRESH_COOKIE_NAME, REFRESH_COOKIE_OPTIONS);
}

export function setCsrfCookie(res: Response, value: string): void {
  res.cookie(CSRF_COOKIE_NAME, value, CSRF_COOKIE_OPTIONS);
}

/**
 * A cookie's raw value, or undefined when it is missing, empty or not a string
 * (cookie-parser turns `j:` prefixed values into objects).
 */
function readCookie(req: Request, name: string): string | undefined {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export const readAccessToken = (req: Request) => readCookie(req, ACCESS_COOKIE_NAME);
export const readRefreshToken = (req: Request) => readCookie(req, REFRESH_COOKIE_NAME);
export const readCsrfCookie = (req: Request) => readCookie(req, CSRF_COOKIE_NAME);
