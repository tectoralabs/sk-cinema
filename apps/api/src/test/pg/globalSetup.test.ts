import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaClient } from '../../lib/prisma.js';
import setup from './globalSetup.js';

/**
 * The order of the pg global setup, with no database: nothing may be migrated before the server
 * has confirmed the name of the database, and that check must not need any table.
 */
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
vi.mock('../../lib/prisma.js', () => ({ createPrismaClient: vi.fn() }));

const LOCAL_URL = 'postgresql://sk_test:s3cret@localhost:55432/sk_cinema_test';

/** What happened, in order: `migrate`, `disconnect`, or the SQL of a query. */
let steps: string[];

/** A client answering each query from `answers`, in order, and recording it in `steps`. */
function fakeClient(answers: unknown[][]) {
  return {
    $queryRaw: (sql: TemplateStringsArray) => {
      steps.push(sql.join('?'));
      return Promise.resolve(answers.shift() ?? []);
    },
    $disconnect: () => {
      steps.push('disconnect');
      return Promise.resolve();
    },
  };
}

function givenDatabase(...answers: unknown[][]) {
  vi.mocked(createPrismaClient).mockImplementation(
    () => fakeClient(answers) as unknown as ReturnType<typeof createPrismaClient>,
  );
}

function givenMigrateExits(status: number, stderr = '') {
  vi.mocked(spawnSync).mockImplementation((() => {
    steps.push('migrate');
    return { status, stdout: '', stderr };
  }) as unknown as typeof spawnSync);
}

const queries = () => steps.filter((step) => step !== 'migrate' && step !== 'disconnect');

beforeEach(() => {
  steps = [];
  vi.mocked(createPrismaClient).mockReset();
  vi.mocked(spawnSync).mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.stubEnv('TEST_DATABASE_URL', LOCAL_URL);
  vi.stubEnv('REQUIRE_PG_TESTS', '');
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('DIRECT_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('pg global setup', () => {
  // The first query reads no table: `_prisma_migrations` does not exist on a fresh database.
  it('checks the database name, then migrates, then checks the migrations', async () => {
    givenDatabase([{ db: 'sk_cinema_test' }], [{ migrations: 2n }]);
    givenMigrateExits(0);

    await setup();

    expect(steps.map((step) => step.replace(/\s+/g, ' ').trim())).toEqual([
      'SELECT current_database() AS db',
      'disconnect',
      'migrate',
      'SELECT count(*) AS migrations FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',
      'disconnect',
    ]);
  });

  it('never migrates a database the server names without _test', async () => {
    givenDatabase([{ db: 'sk_cinema' }]);
    givenMigrateExits(0);

    await expect(setup()).rejects.toThrow('Connected to "sk_cinema"');

    expect(spawnSync).not.toHaveBeenCalled();
    expect(steps).toEqual(['SELECT current_database() AS db', 'disconnect']);
  });

  it('never migrates when the first connection fails, and closes the client', async () => {
    vi.mocked(createPrismaClient).mockImplementation(
      () =>
        ({
          ...fakeClient([]),
          $queryRaw: () => Promise.reject(new Error('connection refused')),
        }) as unknown as ReturnType<typeof createPrismaClient>,
    );
    givenMigrateExits(0);

    await expect(setup()).rejects.toThrow('connection refused');

    expect(spawnSync).not.toHaveBeenCalled();
    expect(steps).toEqual(['disconnect']);
  });

  it('fails when migrate deploy recorded no migrations', async () => {
    givenDatabase([{ db: 'sk_cinema_test' }], [{ migrations: 0n }]);
    givenMigrateExits(0);

    await expect(setup()).rejects.toThrow('No migrations were recorded');
  });

  it('stops after a failed migrate deploy, with the password masked', async () => {
    givenDatabase([{ db: 'sk_cinema_test' }]);
    givenMigrateExits(1, `could not reach ${LOCAL_URL}`);

    const error = await setup().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('prisma migrate deploy failed');
    expect((error as Error).message).not.toContain('s3cret');
    expect(queries()).toHaveLength(1);
  });

  it('refuses an unsafe URL before connecting at all', async () => {
    vi.stubEnv('TEST_DATABASE_URL', 'postgresql://u:p@localhost:55432/sk_cinema');

    await expect(setup()).rejects.toThrow('does not end in "_test"');

    expect(createPrismaClient).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('does nothing without a URL', async () => {
    vi.stubEnv('TEST_DATABASE_URL', '');

    await setup();

    expect(createPrismaClient).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('fails without a URL when the pg tests are required', async () => {
    vi.stubEnv('TEST_DATABASE_URL', '');
    vi.stubEnv('REQUIRE_PG_TESTS', 'true');

    await expect(setup()).rejects.toThrow('TEST_DATABASE_URL is not set');

    expect(createPrismaClient).not.toHaveBeenCalled();
  });
});
