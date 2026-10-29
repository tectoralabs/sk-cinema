import { hash } from '@node-rs/argon2';

// OWASP minimum for argon2id: 19 MiB memory, 2 iterations, 1 lane.
// argon2id is the library's default algorithm (asserted in password.test.ts).
const HASH_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, HASH_OPTIONS);
}
