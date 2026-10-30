import { describe, expect, it } from 'vitest';
import { hashPassword, verifyDummyPassword, verifyPassword } from './password.js';

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
