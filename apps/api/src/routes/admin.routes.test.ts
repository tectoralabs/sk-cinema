import { randomUUID } from 'node:crypto';
import { inspect, isDeepStrictEqual } from 'node:util';
import { apiErrorSchema } from '@sk-cinema/shared';
import express, { Router, type Express, type RequestHandler } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import { ADMIN_API_PATH, ADMIN_AUTH_PREFIX } from '../lib/apiPaths.js';
import { hashPassword } from '../lib/password.js';
import type * as AuthModule from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import type * as CsrfModule from '../middleware/csrf.js';
import { CSRF_HEADER, csrfProtection } from '../middleware/csrf.js';
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

// The real guard factories, spied on so the walker can recognise the exact handlers they
// returned (requireAuth's handler is an anonymous arrow, so its name proves nothing).
vi.mock('../middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthModule>();
  return { ...actual, requireAuth: vi.fn(actual.requireAuth) };
});
vi.mock('../middleware/csrf.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CsrfModule>();
  return { ...actual, csrfProtection: vi.fn(actual.csrfProtection) };
});

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

/** Every method a `use()` middleware (or an `all()` route) is probed with. */
const PROBE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

// ---------------------------------------------------------------------------
// Router introspection (Express 5). Layers keep a route's path but not a `use()` mount path,
// so while an app is built, Router.prototype.use (behind app.use and router.use alike) is
// wrapped to record the mount path of EVERY layer it adds, plain middleware included.
//
// The walker then sorts each layer into exactly one of:
// - a route layer      -> "METHOD /full/path" endpoints;
// - a router           -> walked recursively;
// - plain middleware   -> listed with its full mount path, so it can be probed;
// and throws on anything else (a mounted Express app, a layer not added by use(), ...),
// because a shape the walker can't see into could hide unguarded admin endpoints.
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
type Mounts = WeakMap<LayerLike, string>;

/** A `use()` layer that is neither a router nor an app: it runs for its path and everything below. */
interface MiddlewareLayer {
  path: string;
  handle: unknown;
}

interface RouteWalk {
  endpoints: string[];
  middleware: MiddlewareLayer[];
}

const isExpressApp = (handle: unknown) =>
  typeof handle === 'function' &&
  typeof (handle as { set?: unknown }).set === 'function' &&
  typeof (handle as { handle?: unknown }).handle === 'function';

const isRouter = (handle: unknown): handle is RouterLike =>
  typeof handle === 'function' &&
  !isExpressApp(handle) &&
  Array.isArray((handle as Partial<RouterLike>).stack);

/** The mount path a use() call applies to its layers, the way router.use() reads its arguments. */
function mountPathOf(first: unknown): string {
  let arg = first;
  while (Array.isArray(arg) && arg.length > 0) arg = arg[0];
  if (typeof arg === 'function') return '/';
  if (typeof first === 'string') return first;
  throw new Error(
    `admin route walk: unsupported use() mount path ${inspect(first)}, extend this test`,
  );
}

/** Runs `build` with Router.prototype.use recording the mount path of every layer it adds. */
function recordMounts<T>(build: () => T): { built: T; mounts: Mounts } {
  const mounts: Mounts = new WeakMap();
  const proto = Router.prototype as { use: UseFn };
  const originalUse = proto.use;
  proto.use = function recordUse(this: RouterLike, ...args: unknown[]) {
    const path = mountPathOf(args[0]);
    const before = this.stack.length;
    const result = originalUse.apply(this, args);
    for (const layer of this.stack.slice(before)) mounts.set(layer, path);
    return result;
  };
  try {
    return { built: build(), mounts };
  } finally {
    proto.use = originalUse;
  }
}

const joinPath = (prefix: string, path: string) => (path === '/' ? prefix : `${prefix}${path}`);

/** Walks the whole app. Throws on any layer it cannot account for. */
function walkApp(app: Express, mounts: Mounts): RouteWalk {
  const endpoints: string[] = [];
  const middleware: MiddlewareLayer[] = [];

  const walk = (router: RouterLike, prefix: string) => {
    for (const layer of router.stack) {
      if (layer.route) {
        const { path, methods } = layer.route;
        const at = typeof path === 'string' ? joinPath(prefix, path) : inspect(path);
        if (typeof path !== 'string') {
          throw new Error(`admin route walk: unsupported route path ${at}, extend this test`);
        }
        for (const [method, enabled] of Object.entries(methods)) {
          if (!enabled) continue;
          // router.all() registers "_all": it answers every method, so probe all of them.
          const expanded = method === '_all' ? PROBE_METHODS : [method.toUpperCase()];
          for (const m of expanded) endpoints.push(`${m} ${at}`);
        }
        continue;
      }

      const mount = mounts.get(layer);
      const full = joinPath(prefix, mount ?? '/');
      const unrecognised = (what: string) =>
        new Error(
          `admin route walk: unrecognised layer at ${full || '/'} (${what}), extend this test`,
        );
      const { handle } = layer;

      if (mount === undefined) throw unrecognised('not added by use()');
      if (typeof handle !== 'function') throw unrecognised('handle is not a function');
      // app.use(path, subApp) wraps the sub-app in Express's `mounted_app`; router.use(path,
      // subApp) stores the app itself. Either way its routes are invisible from here.
      if (isExpressApp(handle) || handle.name === 'mounted_app') {
        throw unrecognised('a mounted Express app');
      }

      if (isRouter(handle)) walk(handle, full);
      else middleware.push({ path: full || '/', handle });
    }
  };

  walk((app as unknown as { router: RouterLike }).router, '');
  return { endpoints, middleware };
}

/** Fills `:param` segments; fails loudly on path syntax this test does not understand yet. */
function concretePath(path: string): string {
  if (/[*{}()]/.test(path)) throw new Error(`Unsupported path syntax in ${path}: extend this test`);
  return path.replace(/:\w+/g, randomUUID());
}

const isUnder = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

type Send = (method: string, path: string) => Promise<request.Response>;

/**
 * Sends every PROBE_METHOD, with no session, to each middleware's mount path and to a path
 * below it (a use() middleware also runs for sub-paths). Returns "METHOD /path -> status" for
 * every response `refused` does not accept, so a failure names each leak.
 */
async function probeWithoutSession(
  layers: MiddlewareLayer[],
  sendFn: Send,
  refused: (res: request.Response) => boolean,
): Promise<string[]> {
  const leaks: string[] = [];
  for (const { path } of layers) {
    const base = concretePath(path);
    for (const probePath of [base, `${base}/walk-probe`]) {
      for (const method of PROBE_METHODS) {
        const res = await sendFn(method, probePath);
        if (!refused(res)) leaks.push(`${method} ${probePath} -> ${res.status}`);
      }
    }
  }
  return leaks;
}

/** True when `handle` is one of the handlers `factory` (a vi.fn spy) has returned. */
const madeBy = (factory: Mock) => (handle: unknown) =>
  factory.mock.results.some((r) => r.type === 'return' && r.value === handle);

interface KnownGuard {
  name: string;
  /** Full mount path the guard must sit at. */
  path: string;
  matches: (handle: unknown) => boolean;
}

/**
 * The only use() middleware under /api/admin that is NOT probed. Keep this list small: every
 * other plain middleware under /api/admin must answer 401 to every method without a session.
 */
const KNOWN_GUARDS: KnownGuard[] = [
  {
    // Only sets Cache-Control: no-store and calls next(); it never answers a request.
    // Not exported from admin.routes.ts, so it is recognised by its (inferred) function name.
    name: 'noStore',
    path: ADMIN_API_PATH,
    matches: (handle) => typeof handle === 'function' && handle.name === 'noStore',
  },
  {
    // Can only refuse (403) or call next(). It sits above /auth on purpose, so login, refresh
    // and logout are CSRF-checked; it never grants access to anything.
    name: 'csrfProtection',
    path: ADMIN_API_PATH,
    matches: madeBy(vi.mocked(csrfProtection)),
  },
  {
    // The session guard (`authenticated`) itself: refuses with 401 or sets req.admin.
    name: 'requireAuth',
    path: ADMIN_API_PATH,
    matches: madeBy(vi.mocked(requireAuth)),
  },
];

const isKnownGuard = ({ path, handle }: MiddlewareLayer) =>
  KNOWN_GUARDS.some((guard) => guard.path === path && guard.matches(handle));

function requestFor(app: Express, method: string, path: string): request.Test {
  const agent = request(app) as unknown as Record<
    string,
    ((url: string) => request.Test) | undefined
  >;
  const make = agent[method.toLowerCase()];
  if (!make) throw new Error(`Unsupported method ${method}`);
  return make.call(agent, path);
}

function setup() {
  const admin = testAdmin({ email: EMAIL, passwordHash });
  const db = inMemoryAuthDb({ admins: [admin] });
  const { built, mounts } = recordMounts(() => buildTestApp({ prisma: db.prisma }));
  return { ...built, mounts, db, admin };
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
  return requestFor(app, method, path)
    .set('Origin', ADMIN_ORIGIN)
    .set(CSRF_HEADER, csrf.token)
    .set('Cookie', [csrf.cookie, ...cookies].join('; '));
}

const isUnauthorized = (res: request.Response) =>
  res.status === 401 &&
  res.headers['cache-control'] === 'no-store' &&
  isDeepStrictEqual(res.body, UNAUTHORIZED_BODY);

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
    const { endpoints } = walkApp(app, mounts);

    expect(endpoints).toContain('GET /api/health');
    expect(endpoints).toContain(`GET ${ADMIN_API_PATH}/me`);
    expect(endpoints).toEqual(expect.arrayContaining(PUBLIC_AUTH_ENDPOINTS));
  });

  it('exposes only csrf, login, refresh and logout under /auth', () => {
    const { app, mounts } = setup();
    const authEndpoints = walkApp(app, mounts).endpoints.filter((e) =>
      isUnder(e.split(' ')[1] ?? '', AUTH_PATH),
    );

    expect(authEndpoints.sort()).toEqual([...PUBLIC_AUTH_ENDPOINTS].sort());
  });

  it('answers every registered non-/auth admin route with 401 when there is no session', async () => {
    const { app, mounts, db } = setup();
    const protectedEndpoints = walkApp(app, mounts).endpoints.filter((e) => {
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

  it('finds each known guard exactly once, at its expected mount path', () => {
    const { app, mounts } = setup();
    const adminMiddleware = walkApp(app, mounts).middleware.filter((m) =>
      isUnder(m.path, ADMIN_API_PATH),
    );

    // Keeps the allowlist honest: a renamed or moved guard fails here instead of silently
    // turning its allowlist entry into a hole.
    for (const guard of KNOWN_GUARDS) {
      const found = adminMiddleware.filter((m) => m.path === guard.path && guard.matches(m.handle));
      expect(found, guard.name).toHaveLength(1);
    }
  });

  it('answers 401 without a session at every other use() middleware under /api/admin', async () => {
    const { app, mounts } = setup();
    const unguarded = walkApp(app, mounts).middleware.filter(
      (m) => isUnder(m.path, ADMIN_API_PATH) && !isKnownGuard(m),
    );

    const leaks = await probeWithoutSession(
      unguarded,
      (method, path) => send(app, method, path),
      isUnauthorized,
    );

    expect(leaks).toEqual([]);
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
    // Paths are chosen never to collide with real admin routes (e.g. /movies in Phase 4).
    const UNKNOWN: [string, string][] = [
      ['GET', `${ADMIN_API_PATH}/does-not-exist`],
      ['GET', `${ADMIN_API_PATH}/nothing-here`],
      ['GET', ADMIN_API_PATH],
      ['GET', `${ADMIN_API_PATH}/`],
      ['POST', `${ADMIN_API_PATH}/does-not-exist`],
      ['DELETE', `${ADMIN_API_PATH}/nothing-here/${randomUUID()}`],
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

// ---------------------------------------------------------------------------
// Self-test: the walker must catch the mistakes it exists to catch, on throwaway apps shaped
// like the real one (/api -> /admin router).
// ---------------------------------------------------------------------------

describe('admin route walk: self-test', () => {
  const ok: RequestHandler = (_req, res) => {
    res.json({ secret: 'leaked' });
  };
  /** Stands in for requireAuth: there is never a session in these probes. */
  const fakeGuard: RequestHandler = (_req, res) => {
    res.status(401).end();
  };
  const plainSend =
    (app: Express): Send =>
    (method, path) =>
      requestFor(app, method, path);

  /** /api -> /admin, with `configure` filling in the admin router. */
  function throwawayApp(configure: (admin: Router, app: Express) => void) {
    return recordMounts(() => {
      const app = express();
      const api = Router();
      const admin = Router();
      configure(admin, app);
      api.use('/admin', admin);
      app.use('/api', api);
      return app;
    });
  }

  it('flags an unguarded router.use() middleware and nothing below the guard', async () => {
    const { built: app, mounts } = throwawayApp((admin) => {
      admin.use('/leak', ok); // above the guard: answers without a session
      admin.use(fakeGuard);
      admin.use('/guarded', ok); // below the guard: protected
    });
    const adminMiddleware = walkApp(app, mounts).middleware.filter((m) =>
      isUnder(m.path, ADMIN_API_PATH),
    );
    expect(adminMiddleware.map((m) => m.path)).toEqual([
      `${ADMIN_API_PATH}/leak`,
      ADMIN_API_PATH,
      `${ADMIN_API_PATH}/guarded`,
    ]);

    const leaks = await probeWithoutSession(
      adminMiddleware,
      plainSend(app),
      (res) => res.status === 401,
    );

    const leakPath = `${ADMIN_API_PATH}/leak`;
    expect(leaks).toEqual(
      [leakPath, `${leakPath}/walk-probe`].flatMap((path) =>
        PROBE_METHODS.map((method) => `${method} ${path} -> 200`),
      ),
    );
  });

  it('records the mount path of middleware added with app.use() as well', () => {
    const { built: app, mounts } = recordMounts(() => {
      const app = express();
      app.use(`${ADMIN_API_PATH}/leak`, ok);
      return app;
    });

    expect(walkApp(app, mounts).middleware.map((m) => m.path)).toEqual([`${ADMIN_API_PATH}/leak`]);
  });

  it('rejects a sub-app mounted with app.use()', () => {
    const { built: app, mounts } = recordMounts(() => {
      const app = express();
      const sub = express();
      sub.get('/leak', ok);
      app.use(`${ADMIN_API_PATH}/sub`, sub);
      return app;
    });

    expect(() => walkApp(app, mounts)).toThrow(
      `admin route walk: unrecognised layer at ${ADMIN_API_PATH}/sub (a mounted Express app), extend this test`,
    );
  });

  it('rejects a sub-app mounted with router.use()', () => {
    const { built: app, mounts } = throwawayApp((admin) => {
      const sub = express();
      sub.get('/leak', ok);
      admin.use('/sub', sub);
    });

    expect(() => walkApp(app, mounts)).toThrow(
      `admin route walk: unrecognised layer at ${ADMIN_API_PATH}/sub (a mounted Express app), extend this test`,
    );
  });

  it('rejects a layer whose mount path was not recorded', () => {
    const { built: app } = throwawayApp((admin) => {
      admin.use(fakeGuard);
    });

    expect(() => walkApp(app, new WeakMap())).toThrow(
      'admin route walk: unrecognised layer at / (not added by use()), extend this test',
    );
  });

  it('rejects a use() mount path it cannot read', () => {
    expect(() =>
      throwawayApp((admin) => {
        admin.use(/\/leak/ as unknown as string, ok);
      }),
    ).toThrow('admin route walk: unsupported use() mount path /\\/leak/, extend this test');
  });
});
