import { describe, expect, it } from 'vitest';
import { hashPassword } from './password.js';

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
