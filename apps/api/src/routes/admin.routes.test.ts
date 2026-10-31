import { randomUUID } from 'node:crypto';
import { apiErrorSchema } from '@sk-cinema/shared';
import { Router, type Express } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_API_PATH, ADMIN_AUTH_PREFIX } from '../lib/apiPaths.js';
import { hashPassword } from '../lib/password.js';
import { CSRF_HEADER } from '../middleware/csrf.js';
import { SESSION_EXPIRED_MESSAGE } from '../services/auth.service.js';
import {
  ADMIN_ORIGIN,
  authClient,
  buildTestApp,
  fetchCsrf,
  inMemoryAuthDb,
  sessionFrom,
  testAdmin,
  type Session,
} from '../test/helpers.js';

const EMAIL = 'editor@skcinema.lk';
const PASSWORD = 'correct horse battery staple';
const UNAUTHORIZED_BODY = { error: { code: 'UNAUTHORIZED', message: SESSION_EXPIRED_MESSAGE } };
const CSRF_BODY = { error: { code: 'CSRF_INVALID', message: 'CSRF validation failed' } };
const AUTH_PATH = `${ADMIN_API_PATH}${ADMIN_AUTH_PREFIX}`;

/** The only admin endpoints that may answer without a session. */
const PUBLIC_AUTH_ENDPOINTS = [
  `GET ${AUTH_PATH}/csrf`,
  `POST ${AUTH_PATH}/login`,
  `POST ${AUTH_PATH}/refresh`,
  `POST ${AUTH_PATH}/logout`,
];

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

// ---------------------------------------------------------------------------
// Router introspection. Express 5 layers keep a route's path but not a `use()` mount path,
// so while the app is built, Router.prototype.use (behind app.use and router.use alike) is
// wrapped to remember the mount path of each layer it adds.
// ---------------------------------------------------------------------------

interface RouteLike {
  path: unknown;
  methods: Record<string, boolean | undefined>;
}

interface LayerLike {
  route?: RouteLike | undefined;
  handle: unknown;
}

interface RouterLike {
  stack: LayerLike[];
}

type UseFn = (this: RouterLike, ...args: unknown[]) => unknown;

const isRouter = (handle: unknown): handle is RouterLike =>
  typeof handle === 'function' && Array.isArray((handle as Partial<RouterLike>).stack);

function buildRecordedApp(options: Parameters<typeof buildTestApp>[0] = {}) {
  const mounts = new WeakMap<LayerLike, string>();
  const proto = Router.prototype as { use: UseFn };
  const originalUse = proto.use;
  proto.use = function recordUse(this: RouterLike, ...args: unknown[]) {
    const before = this.stack.length;
    const result = originalUse.apply(this, args);
    const [first] = args;
    if (typeof first !== 'function') {
      if (typeof first !== 'string') throw new Error('Unsupported mount path: extend this test');
      for (const layer of this.stack.slice(before)) mounts.set(layer, first);
    }
    return result;
  };
  try {
    const built = buildTestApp(options);
    return { ...built, mounts };
  } finally {
    proto.use = originalUse;
  }
}

const joinPath = (prefix: string, path: string) => (path === '/' ? prefix : `${prefix}${path}`);

/** Every "METHOD /full/path" registered anywhere in the app, nested routers included. */
function listEndpoints(app: Express, mounts: WeakMap<LayerLike, string>): string[] {
  const endpoints: string[] = [];
  const walk = (router: RouterLike, prefix: string) => {
    for (const layer of router.stack) {
      if (layer.route) {
        const { path, methods } = layer.route;
        if (typeof path !== 'string') throw new Error('Unsupported route path: extend this test');
        for (const [method, enabled] of Object.entries(methods)) {
          if (enabled) endpoints.push(`${method.toUpperCase()} ${joinPath(prefix, path)}`);
        }
      } else if (isRouter(layer.handle)) {
        walk(layer.handle, joinPath(prefix, mounts.get(layer) ?? '/'));
      }
    }
  };
  walk((app as unknown as { router: RouterLike }).router, '');
  return endpoints;
}

/** Fills `:param` segments; fails loudly on path syntax this test does not understand yet. */
function concretePath(path: string): string {
  if (/[*{}()]/.test(path)) throw new Error(`Unsupported path syntax in ${path}: extend this test`);
  return path.replace(/:\w+/g, randomUUID());
}

const isUnder = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

function setup() {
  const admin = testAdmin({ email: EMAIL, passwordHash });
  const db = inMemoryAuthDb({ admins: [admin] });
  const built = buildRecordedApp({ prisma: db.prisma });
  return { ...built, db, admin };
}

async function logIn(app: Express): Promise<Session> {
  const c = await authClient(app);
  const res = await c.post('/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  expect(res.status).toBe(200);
  return sessionFrom(res);
}

/**
 * A request with a valid CSRF cookie + token and the admin Origin, so CSRF passes and only the
 * session decides. `cookies` are extra "name=value" pairs (e.g. a session).
 */
async function send(app: Express, method: string, path: string, cookies: string[] = []) {
  const csrf = await fetchCsrf(app);
  const agent = request(app) as unknown as Record<string, (url: string) => request.Test>;
  const make = agent[method.toLowerCase()];
  if (!make) throw new Error(`Unsupported method ${method}`);
  return make
    .call(agent, path)
    .set('Origin', ADMIN_ORIGIN)
    .set(CSRF_HEADER, csrf.token)
    .set('Cookie', [csrf.cookie, ...cookies].join('; '));
}

function expectUnauthorized(res: request.Response) {
  expect(res.status).toBe(401);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body).toEqual(UNAUTHORIZED_BODY);
}

function expectNotFound(res: request.Response) {
  expect(res.status).toBe(404);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(apiErrorSchema.parse(res.body).error.code).toBe('NOT_FOUND');
}

describe('admin router: authentication by default', () => {
  it('the walker sees the whole app (sanity check)', () => {
    const { app, mounts } = setup();
    const endpoints = listEndpoints(app, mounts);

    expect(endpoints).toContain('GET /api/health');
    expect(endpoints).toContain(`GET ${ADMIN_API_PATH}/me`);
    expect(endpoints).toEqual(expect.arrayContaining(PUBLIC_AUTH_ENDPOINTS));
  });

  it('exposes only csrf, login, refresh and logout under /auth', () => {
    const { app, mounts } = setup();
    const authEndpoints = listEndpoints(app, mounts).filter((e) =>
      isUnder(e.split(' ')[1] ?? '', AUTH_PATH),
    );

    expect(authEndpoints.sort()).toEqual([...PUBLIC_AUTH_ENDPOINTS].sort());
  });

  it('answers every registered non-/auth admin route with 401 when there is no session', async () => {
    const { app, mounts, db } = setup();
    const protectedEndpoints = listEndpoints(app, mounts).filter((e) => {
      const path = e.split(' ')[1] ?? '';
      return isUnder(path, ADMIN_API_PATH) && !isUnder(path, AUTH_PATH);
    });
    expect(protectedEndpoints.length).toBeGreaterThan(0);

    for (const endpoint of protectedEndpoints) {
      const [method = '', path = ''] = endpoint.split(' ');
      const res = await send(app, method, concretePath(path));
      expect(res.status, endpoint).toBe(401);
      expectUnauthorized(res);
    }
    // Refused before any DB lookup: there is no access cookie to look up.
    expect(db.spies.admin.findUnique).not.toHaveBeenCalled();
  });

  it('still serves GET /me to a signed-in admin through the router-level guard, with one lookup', async () => {
    const { app, db, admin } = setup();
    const session = await logIn(app);
    db.spies.admin.findUnique.mockClear();

    const res = await request(app).get(`${ADMIN_API_PATH}/me`).set('Cookie', session.access);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ admin: { id: admin.id, email: EMAIL } });
    // requireAuth's session check and getMe's profile read: requireAuth ran once, not twice.
    expect(db.spies.admin.findUnique).toHaveBeenCalledTimes(2);
  });

  describe('unknown admin paths', () => {
    // Without a session nothing is revealed (401, like a real route); with one, the usual 404.
    const UNKNOWN: [string, string][] = [
      ['GET', `${ADMIN_API_PATH}/does-not-exist`],
      ['GET', `${ADMIN_API_PATH}/movies`],
      ['GET', ADMIN_API_PATH],
      ['GET', `${ADMIN_API_PATH}/`],
      ['POST', `${ADMIN_API_PATH}/does-not-exist`],
      ['DELETE', `${ADMIN_API_PATH}/movies/${randomUUID()}`],
      // Unknown or wrong-method /auth paths fall through the auth routes to the same guard.
      ['GET', `${AUTH_PATH}/does-not-exist`],
      ['POST', `${AUTH_PATH}/does-not-exist`],
      ['GET', `${AUTH_PATH}/login`],
      ['GET', `${AUTH_PATH}/logout`],
      ['PUT', `${AUTH_PATH}/refresh`],
    ];

    it.each(UNKNOWN)('%s %s answers 401 without a session', async (method, path) => {
      const { app, db } = setup();

      expectUnauthorized(await send(app, method, path));
      expect(db.spies.admin.findUnique).not.toHaveBeenCalled();
    });

    it.each(UNKNOWN)('%s %s answers 404 with a valid session', async (method, path) => {
      const { app } = setup();
      const session = await logIn(app);

      expectNotFound(await send(app, method, path, [session.access]));
    });

    it('checks CSRF before the session on unsafe methods', async () => {
      const { app } = setup();
      const session = await logIn(app);

      const res = await request(app)
        .post(`${ADMIN_API_PATH}/does-not-exist`)
        .set('Origin', ADMIN_ORIGIN)
        .set('Cookie', session.access);

      expect(res.status).toBe(403);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual(CSRF_BODY);
    });

    it('does not accept a CSRF cookie alone as a session', async () => {
      const { app } = setup();
      const csrf = await fetchCsrf(app);

      const res = await request(app).get(`${ADMIN_API_PATH}/me`).set('Cookie', csrf.cookie);

      expectUnauthorized(res);
    });
  });

  it('does not add no-store to public routes', async () => {
    const res = await request(buildTestApp().app).get('/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.headers['cache-control']).toBeUndefined();
  });
});
