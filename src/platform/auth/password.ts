/**
 * Password hashing — CAIRN.md §23
 *
 * scrypt from Node's standard library. No third-party dependency for the single
 * most security-sensitive function in the system, and a memory-hard algorithm so
 * a stolen hash is expensive to attack rather than merely inconvenient.
 *
 * Format: scrypt$N$r$p$salt$hash — the parameters travel with the hash, so they
 * can be raised later without invalidating existing passwords.
 */
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

/**
 * Typed wrapper around the callback form. `promisify` loses the options
 * overload, and the cost parameters are the whole point of using scrypt.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

const PARAMS = { N: 16384, r: 8, p: 1, keyLength: 32 };

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(plain.normalize('NFKC'), salt, PARAMS.keyLength, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: 64 * 1024 * 1024,
  });

  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('hex'),
    derived.toString('hex'),
  ].join('$');
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');

  const derived = await scrypt(plain.normalize('NFKC'), salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });

  // Constant-time comparison: never leak how much of the hash matched.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Minimum policy, enforced at the screen and again here. */
export function checkPasswordPolicy(plain: string): string | null {
  if (plain.length < 10) return 'Password must be at least 10 characters.';
  if (!/[A-Za-z]/.test(plain)) return 'Password must contain at least one letter.';
  if (!/[0-9]/.test(plain)) return 'Password must contain at least one digit.';
  return null;
}
