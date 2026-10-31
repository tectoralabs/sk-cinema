import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

// OWASP minimum for argon2id: 19 MiB memory, 2 iterations, 1 lane.
// argon2id is the library's default algorithm (asserted in password.test.ts).
const HASH_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

let dummyHash: Promise<string> | undefined;

export function hashPassword(password: string): Promise<string> {
  return hash(password, HASH_OPTIONS);
}

/** False for a wrong password or a malformed hash; never throws. */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

/** Builds the dummy hash once and caches it. A failed build is not cached, so it is retried. */
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url')).catch((error: unknown) => {
    dummyHash = undefined;
    throw error;
  });
  return dummyHash;
}

/**
 * Pre-computes the dummy hash so the first unknown-email login costs one verify,
 * like a real login, instead of a hash plus a verify. Call once at startup.
 */
export async function warmUpDummyPassword(): Promise<void> {
  await getDummyHash();
}

/**
 * Burns the same argon2 work as a real verify so a login for an unknown
 * email is not distinguishable by timing. Always resolves false.
 */
export async function verifyDummyPassword(password: string): Promise<false> {
  await verifyPassword(await getDummyHash(), password);
  return false;
}
