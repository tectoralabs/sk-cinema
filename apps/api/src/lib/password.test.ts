import type * as Argon2 from '@node-rs/argon2';
import { describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyDummyPassword, verifyPassword } from './password.js';

// Real argon2, wrapped in spies so the warm-up tests can count hash/verify calls.
vi.mock('@node-rs/argon2', async (importOriginal) => {
  const actual = await importOriginal<typeof Argon2>();
  return { ...actual, hash: vi.fn(actual.hash), verify: vi.fn(actual.verify) };
});

describe('hashPassword', () => {
  it('produces an argon2id hash with the configured cost', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
  });

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same password'),
      hashPassword('same password'),
    ]);
    expect(a).not.toBe(b);
  });
});

describe('verifyPassword', () => {
  it('accepts the correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'Correct horse battery staple')).resolves.toBe(false);
  });

  it.each(['', 'not-a-hash', '$argon2id$v=19$m=19456,t=2,p=1$broken'])(
    'returns false for a malformed hash (%j)',
    async (malformed) => {
      await expect(verifyPassword(malformed, 'anything')).resolves.toBe(false);
    },
  );
});

describe('verifyDummyPassword', () => {
  it('always resolves false', async () => {
    await expect(verifyDummyPassword('correct horse battery staple')).resolves.toBe(false);
    await expect(verifyDummyPassword('')).resolves.toBe(false);
  });
});

describe('warmUpDummyPassword', () => {
  // A fresh module instance per test, so the cached dummy hash starts empty.
  async function freshModules() {
    vi.resetModules();
    const argon2 = await import('@node-rs/argon2');
    const password = await import('./password.js');
    return { argon2, password };
  }

  it('pre-computes the dummy hash so the next dummy verify only verifies', async () => {
    const { argon2, password } = await freshModules();

    await password.warmUpDummyPassword();
    expect(argon2.hash).toHaveBeenCalledTimes(1);
    expect(argon2.verify).not.toHaveBeenCalled();

    await expect(password.verifyDummyPassword('anything')).resolves.toBe(false);
    expect(argon2.hash).toHaveBeenCalledTimes(1);
    expect(argon2.verify).toHaveBeenCalledTimes(1);
  });

  it('hashes only once, even when called concurrently', async () => {
    const { argon2, password } = await freshModules();

    await Promise.all([password.warmUpDummyPassword(), password.warmUpDummyPassword()]);
    await password.warmUpDummyPassword();
    expect(argon2.hash).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed warm-up instead of caching the failure', async () => {
    const { argon2, password } = await freshModules();
    vi.mocked(argon2.hash).mockRejectedValueOnce(new Error('out of memory'));

    await expect(password.warmUpDummyPassword()).rejects.toThrow('out of memory');
    await expect(password.warmUpDummyPassword()).resolves.toBeUndefined();
    await expect(password.verifyDummyPassword('anything')).resolves.toBe(false);
    expect(argon2.hash).toHaveBeenCalledTimes(2);
  });
});
