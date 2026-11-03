import { describe, expect, it } from 'vitest';
import { UnsafeTestDatabaseError } from './guard.js';
import { assertServerDatabaseIsTest, resetDatabaseOn, type ResetClient } from './reset.js';

/** Records each statement, in order, and answers `current_database()` with `serverName`. */
function fakeClient(serverName: string | undefined, tables: string[] = ['Movie', 'Screen']) {
  const steps: string[] = [];
  const client: ResetClient = {
    $queryRaw: ((sql: TemplateStringsArray) => {
      const text = sql.join('?');
      steps.push(text.trim().replace(/\s+/g, ' '));
      if (text.includes('current_database')) {
        return Promise.resolve(serverName === undefined ? [] : [{ name: serverName }]);
      }
      return Promise.resolve(tables.map((tablename) => ({ tablename })));
    }) as ResetClient['$queryRaw'],
    $executeRawUnsafe: (sql: string) => {
      steps.push(sql);
      return Promise.resolve(0);
    },
  };
  return { client, steps };
}

describe('resetDatabaseOn: the server names the database before anything is truncated', () => {
  it('asks current_database() first, then truncates', async () => {
    const { client, steps } = fakeClient('sk_cinema_test');

    await resetDatabaseOn(client, 'sk_cinema_test');

    expect(steps[0]).toContain('current_database()');
    expect(steps.at(-1)).toBe('TRUNCATE TABLE "Movie", "Screen" RESTART IDENTITY CASCADE');
  });

  it.each(['sk_cinema', 'production', 'sk_cinema_test_backup', 'x test', ''])(
    'refuses a server database named %j without truncating or even listing tables',
    async (name) => {
      const { client, steps } = fakeClient(name);

      await expect(resetDatabaseOn(client, 'sk_cinema_test')).rejects.toThrow(
        UnsafeTestDatabaseError,
      );

      expect(steps).toHaveLength(1);
    },
  );

  it('refuses a server database that ends in _test but is not the name the URL accepted', async () => {
    const { client, steps } = fakeClient('other_test');

    await expect(resetDatabaseOn(client, 'sk_cinema_test')).rejects.toThrow(
      /"other_test" is not the one the URL named \("sk_cinema_test"\)/,
    );

    expect(steps).toHaveLength(1);
  });

  it('refuses when the server gives no name at all', async () => {
    const { client, steps } = fakeClient(undefined);

    await expect(assertServerDatabaseIsTest(client, 'sk_cinema_test')).rejects.toThrow(
      UnsafeTestDatabaseError,
    );

    expect(steps).toHaveLength(1);
  });
});
