import type { PrismaClient } from '../../generated/prisma/client.js';
import { testPrisma } from './db.js';

/*
 * Forcing two requests to interleave on real Postgres, without sleeps or luck.
 *
 * A real request runs against interceptDb(client, hook), which lets a test pause it at a chosen
 * Prisma call. The test then polls pg_stat_activity (bounded) to see what the other request is
 * doing. Every wait here ends with a clear error after WAIT_BOUND_MS, well inside the 10 s
 * transaction timeout and the 15 s test timeout, so a failure releases its connections and locks.
 */

/** How long any one wait here may take before the test fails. */
const WAIT_BOUND_MS = 5_000;
const POLL_INTERVAL_MS = 10;

/** One Prisma call made through interceptDb. */
export interface DbCall {
  /** Through a transaction client, or the root client. */
  scope: 'root' | 'tx';
  /** The delegate (`movie`, `showtime`, ...), or `$queryRaw`. */
  model: string;
  /** The delegate's method (`create`, ...), or `$queryRaw`. */
  method: string;
  args: readonly unknown[];
}

/** Sees every call, and must run `proceed()` for it to happen. */
export type DbHook = (call: DbCall, proceed: () => Promise<unknown>) => Promise<unknown>;

const DELEGATES: ReadonlySet<string> = new Set(['movie', 'screen', 'showtime', 'setting']);

type AnyFunction = (...args: unknown[]) => unknown;

/** A delegate whose methods go through the hook. */
function wrapDelegate(delegate: object, model: string, scope: DbCall['scope'], hook: DbHook) {
  return new Proxy(
    {},
    {
      get(_, method) {
        const value = Reflect.get(delegate, method) as unknown;
        if (typeof value !== 'function' || typeof method !== 'string') return value;
        return (...args: unknown[]) =>
          hook({ scope, model, method, args }, () =>
            // Prisma's promises are lazy: resolving one is what sends the query.
            Promise.resolve((value as AnyFunction).apply(delegate, args)),
          );
      },
    },
  );
}

function wrapClient<C extends object>(client: C, scope: DbCall['scope'], hook: DbHook): C {
  const proxy = new Proxy(
    {},
    {
      get(_, prop) {
        const value = Reflect.get(client, prop) as unknown;
        if (prop === '$transaction') {
          return (run: (tx: object) => Promise<unknown>, options?: unknown) =>
            (value as AnyFunction).call(
              client,
              (tx: object) => run(wrapClient(tx, 'tx', hook)),
              options,
            );
        }
        if (prop === '$queryRaw') {
          return (...args: unknown[]) =>
            hook({ scope, model: '$queryRaw', method: '$queryRaw', args }, () =>
              Promise.resolve((value as AnyFunction).apply(client, args)),
            );
        }
        if (typeof prop === 'string' && DELEGATES.has(prop)) {
          return wrapDelegate(value as object, prop, scope, hook);
        }
        return typeof value === 'function' ? (value as AnyFunction).bind(client) : value;
      },
    },
  );
  return proxy as C;
}

/**
 * The client, with every delegate call and `$queryRaw` (on it and on the transaction clients it
 * hands out) going through `hook`. Interactive `$transaction` only: no service uses the array form.
 */
export function interceptDb(client: PrismaClient, hook: DbHook): PrismaClient {
  return wrapClient(client, 'root', hook);
}

/** Matches a write (or any call) made through a transaction client. */
export const inTransaction =
  (model: string, method: string) =>
  (call: DbCall): boolean =>
    call.scope === 'tx' && call.model === model && call.method === method;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** `promise`, failing after WAIT_BOUND_MS. */
async function bounded<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${String(WAIT_BOUND_MS)} ms waiting for ${what}`));
    }, WAIT_BOUND_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `check` until it returns a value, failing after WAIT_BOUND_MS. */
async function pollUntil<T>(what: string, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + WAIT_BOUND_MS;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${String(WAIT_BOUND_MS)} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * The SQL of every backend of this database now waiting on a lock. The pg project runs its files
 * one at a time, so these all belong to the running test.
 */
export async function lockWaiters(): Promise<string[]> {
  const rows = await testPrisma().$queryRaw<{ query: string }[]>`
    SELECT query FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND wait_event_type = 'Lock'`;
  return rows.map((row) => row.query);
}

/** Resolves once `parties` callers have arrived; fails after WAIT_BOUND_MS. */
export function rendezvous(parties: number): () => Promise<void> {
  let arrived = 0;
  const everyone = deferred();
  return async () => {
    arrived += 1;
    if (arrived >= parties) everyone.resolve();
    await bounded(everyone.promise, `${String(parties)} requests to pass their pre-check`);
  };
}

const settle = <T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> =>
  promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  );

export interface InOrderRace<A, B> {
  first: PromiseSettledResult<A>;
  second: PromiseSettledResult<B>;
  /** The SQL `second` was seen waiting on, or null if it finished without ever waiting. */
  secondBlockedOn: string | null;
}

export interface InOrderOptions<A, B> {
  /** The call `first` pauses at: its first write, with its locks taken and its checks passed. */
  gate: (call: DbCall) => boolean;
  first: (db: PrismaClient) => Promise<A>;
  second: (db: PrismaClient) => Promise<B>;
}

/**
 * Runs two requests so that `first` is known to get there first, whatever the scheduler does:
 *
 * 1. `first` runs up to its gate and stays there, its transaction open, nothing written yet;
 * 2. `second` starts;
 * 3. `first` is released when `second` has been SEEN waiting on a lock, or has finished;
 * 4. both finish.
 *
 * With the row locks working, `second` waits at step 3, then sees `first`'s commit and is
 * refused. With them missing, `second` passes its checks without seeing anything and commits;
 * then `first` commits too: the real double booking, deterministically, so the test fails on the
 * invariant rather than on a timeout.
 */
export async function runInOrder<A, B>({
  gate,
  first,
  second,
}: InOrderOptions<A, B>): Promise<InOrderRace<A, B>> {
  const atGate = deferred();
  const release = deferred();
  let gatePassed = false;
  const firstDb = interceptDb(testPrisma(), async (call, proceed) => {
    if (!gatePassed && gate(call)) {
      gatePassed = true;
      atGate.resolve();
      await release.promise;
    }
    return proceed();
  });

  const firstRun = settle(first(firstDb));
  let secondRun: Promise<PromiseSettledResult<B>> | undefined;
  let secondBlockedOn: string | null;
  try {
    const reachedGate = await bounded(
      Promise.race([atGate.promise.then(() => true), firstRun.then(() => false)]),
      'the first request to reach its gate',
    );
    if (!reachedGate) {
      const outcome = await firstRun;
      throw new Error(
        'The first request finished without reaching its gate: ' +
          (outcome.status === 'rejected' ? String(outcome.reason) : 'it succeeded'),
      );
    }

    secondRun = settle(second(testPrisma()));
    let secondDone = false;
    void secondRun.then(() => {
      secondDone = true;
    });
    const seen = await pollUntil('the second request to wait on a lock or finish', async () => {
      const [waitingOn] = await lockWaiters();
      if (waitingOn !== undefined) return { waitingOn };
      return secondDone ? { waitingOn: null } : undefined;
    });
    secondBlockedOn = seen.waitingOn;
  } finally {
    // Whatever happened: let the first request finish, and wait for both, so no transaction or
    // connection outlives the test.
    release.resolve();
    await firstRun;
    if (secondRun !== undefined) await secondRun;
  }
  return { first: await firstRun, second: await secondRun, secondBlockedOn };
}

/** Reads a test's race result: the request's value, or its error rethrown. */
export function succeeded<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}

/** Reads a test's race result: what the request was refused with. */
export function refused(result: PromiseSettledResult<unknown>): unknown {
  if (result.status === 'fulfilled') {
    throw new Error('Expected this request to be refused, but it succeeded');
  }
  return result.reason;
}

export interface FirstLockMeeting {
  /** The client for one request. */
  clientFor: () => PrismaClient;
  /** True when a request was seen waiting on another's lock, instead of taking its own. */
  sawWaiter: () => boolean;
  /** The SQL a request was seen waiting on, if any. */
  waitedOn: () => string | null;
}

/**
 * Makes `parties` requests stop right after they take their first lock matching `isLock`, until
 * every one of them has too, or the rest are waiting. So requests locking the same rows in
 * opposite orders are sure to each hold one and want the other's: a real deadlock. Requests
 * locking in the same order just queue up on the first row.
 */
export function meetAfterFirstLock(
  parties: number,
  isLock: (call: DbCall) => boolean,
): FirstLockMeeting {
  let arrived = 0;
  let waitedOn: string | null = null;
  const arrive = async () => {
    arrived += 1;
    await pollUntil('every request to take its first lock or wait', async () => {
      if (arrived >= parties) return true;
      const waiters = await lockWaiters();
      if (waiters.length < parties - arrived) return undefined;
      waitedOn = waiters[0] ?? waitedOn;
      return true;
    });
  };
  return {
    clientFor: () => {
      let locked = false;
      return interceptDb(testPrisma(), async (call, proceed) => {
        const result = await proceed();
        if (!locked && isLock(call)) {
          locked = true;
          await arrive();
        }
        return result;
      });
    },
    sawWaiter: () => waitedOn !== null,
    waitedOn: () => waitedOn,
  };
}
