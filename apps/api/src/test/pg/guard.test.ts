import { describe, expect, it } from 'vitest';
import {
  assertSafeTestDatabaseUrl,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
  UnsafeTestDatabaseError,
} from './guard.js';

const LOCAL_URL = 'postgresql://sk_test:sk_test@localhost:55432/sk_cinema_test';

describe('assertSafeTestDatabaseUrl', () => {
  it.each([
    ['the local Docker URL', LOCAL_URL],
    ['127.0.0.1', 'postgresql://u:p@127.0.0.1:55432/sk_cinema_test'],
    ['IPv6 loopback', 'postgresql://u:p@[::1]:55432/sk_cinema_test'],
    ['the CI service container host', 'postgresql://u:p@postgres:5432/sk_cinema_test'],
    ['the postgres:// scheme', 'postgres://u:p@localhost/sk_cinema_test'],
    ['an upper-case host', 'postgresql://u:p@LOCALHOST:55432/sk_cinema_test'],
    ['allowed params', `${LOCAL_URL}?schema=public&connect_timeout=15&sslmode=disable`],
  ])('accepts %s', (_label, url) => {
    expect(assertSafeTestDatabaseUrl(url)).toBe('sk_cinema_test');
  });

  it('refuses a neon.tech URL even if the name ends in _test', () => {
    const url = 'postgresql://u:p@ep-cool-name-123456.ap-southeast-1.aws.neon.tech/sk_cinema_test';
    expect(() => assertSafeTestDatabaseUrl(url)).toThrow(/neon\.tech/);
  });

  it('refuses neon.tech hidden in a query parameter', () => {
    expect(() => assertSafeTestDatabaseUrl(`${LOCAL_URL}?application_name=x.NEON.TECH`)).toThrow(
      UnsafeTestDatabaseError,
    );
  });

  it('refuses a database name that does not end in _test', () => {
    expect(() => assertSafeTestDatabaseUrl('postgresql://u:p@localhost:55432/sk_cinema')).toThrow(
      /database name "sk_cinema" does not end in "_test"/,
    );
  });

  it.each([
    ['a bare "_test"', 'postgresql://u:p@localhost/_test'],
    ['no database name', 'postgresql://u:p@localhost:55432'],
    ['"_test" only in a parameter', 'postgresql://u:p@localhost/sk_cinema?schema=x_test'],
  ])('refuses %s', (_label, url) => {
    expect(() => assertSafeTestDatabaseUrl(url)).toThrow(/does not end in "_test"/);
  });

  it.each([
    ['a remote host', 'postgresql://u:p@db.example.com:5432/sk_cinema_test'],
    ['a LAN IP', 'postgresql://u:p@192.168.1.20:5432/sk_cinema_test'],
    ['a look-alike host', 'postgresql://u:p@localhost.example.com/sk_cinema_test'],
    ['multiple hosts', 'postgresql://u:p@localhost,db.example.com/sk_cinema_test'],
  ])('refuses %s', (_label, url) => {
    expect(() => assertSafeTestDatabaseUrl(url)).toThrow(/host ".*" is not one of/);
  });

  it.each([
    ['host', `${LOCAL_URL}?host=db.example.com`],
    ['hostaddr', `${LOCAL_URL}?hostaddr=10.0.0.5`],
    ['dbname', `${LOCAL_URL}?dbname=sk_cinema`],
    ['database', `${LOCAL_URL}?database=sk_cinema`],
  ])('refuses the retargeting query parameter "%s"', (key, url) => {
    expect(() => assertSafeTestDatabaseUrl(url)).toThrow(`query parameter "${key}" is not allowed`);
  });

  it.each([
    ['not a URL', 'not a url'],
    ['another scheme', 'mysql://u:p@localhost/sk_cinema_test'],
    ['an empty string', ''],
  ])('refuses %s', (_label, url) => {
    expect(() => assertSafeTestDatabaseUrl(url)).toThrow(/not a valid postgresql/);
  });

  it.each(['DATABASE_URL', 'DIRECT_URL'])('refuses a URL equal to %s', (name) => {
    expect(() => assertSafeTestDatabaseUrl(LOCAL_URL, { [name]: LOCAL_URL })).toThrow(
      `same database as ${name}`,
    );
  });

  it('refuses the same host, port and database as DATABASE_URL with other credentials or params', () => {
    const env = { DATABASE_URL: 'postgresql://app:secret@127.0.0.1:55432/sk_cinema_test' };
    expect(() =>
      assertSafeTestDatabaseUrl('postgresql://u:p@127.0.0.1:55432/sk_cinema_test?schema=x', env),
    ).toThrow('same database as DATABASE_URL');
  });

  it('accepts a different database on the same server as DATABASE_URL', () => {
    const env = {
      DATABASE_URL: 'postgresql://app:secret@localhost:55432/sk_cinema',
      DIRECT_URL: 'postgresql://app:secret@localhost:55432/sk_cinema',
    };
    expect(assertSafeTestDatabaseUrl(LOCAL_URL, env)).toBe('sk_cinema_test');
  });

  it('never echoes the password in the error message', () => {
    const url = 'postgresql://u:hunter2-secret@db.example.com/sk_cinema_test';
    expect(() => assertSafeTestDatabaseUrl(url)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('hunter2') as unknown }),
    );
  });
});

describe('resolveTestDatabaseUrl', () => {
  it('returns undefined (skip) when TEST_DATABASE_URL is not set', () => {
    expect(resolveTestDatabaseUrl({})).toBeUndefined();
  });

  it('treats a blank TEST_DATABASE_URL as not set', () => {
    expect(resolveTestDatabaseUrl({ TEST_DATABASE_URL: '  ' })).toBeUndefined();
  });

  it.each(['false', '0', ''])('still skips when REQUIRE_PG_TESTS=%j', (value) => {
    expect(resolveTestDatabaseUrl({ REQUIRE_PG_TESTS: value })).toBeUndefined();
  });

  it.each(['true', 'TRUE', '1'])(
    'fails when REQUIRE_PG_TESTS=%s and TEST_DATABASE_URL is missing',
    (value) => {
      expect(() => resolveTestDatabaseUrl({ REQUIRE_PG_TESTS: value })).toThrow(
        'REQUIRE_PG_TESTS=true but TEST_DATABASE_URL is not set',
      );
    },
  );

  it('fails on an unrecognised REQUIRE_PG_TESTS value instead of guessing', () => {
    expect(() => resolveTestDatabaseUrl({ REQUIRE_PG_TESTS: 'yes' })).toThrow(
      'REQUIRE_PG_TESTS must be "true" or "false"',
    );
  });

  it('returns a safe URL', () => {
    expect(resolveTestDatabaseUrl({ TEST_DATABASE_URL: LOCAL_URL, REQUIRE_PG_TESTS: 'true' })).toBe(
      LOCAL_URL,
    );
  });

  it('refuses an unsafe URL even when the tests are not required', () => {
    expect(() =>
      resolveTestDatabaseUrl({ TEST_DATABASE_URL: 'postgresql://u:p@localhost/sk_cinema' }),
    ).toThrow(UnsafeTestDatabaseError);
  });

  it('applies the DATABASE_URL check from the same environment', () => {
    expect(() =>
      resolveTestDatabaseUrl({ TEST_DATABASE_URL: LOCAL_URL, DATABASE_URL: LOCAL_URL }),
    ).toThrow('same database as DATABASE_URL');
  });
});

describe('redactDatabaseUrl', () => {
  it('masks the password', () => {
    expect(redactDatabaseUrl(LOCAL_URL)).toBe(
      'postgresql://sk_test:***@localhost:55432/sk_cinema_test',
    );
  });

  it('does not echo an unparseable URL', () => {
    expect(redactDatabaseUrl('nope:secret')).toBe('<unparseable URL>');
  });
});
