/**
 * RFC 6238 time-based one-time passwords, with nothing but `node:crypto`.
 *
 * HMAC-SHA-1, 20-byte secret, 30 s period, T0 = 0, six digits — what every authenticator app
 * expects by default. Pure and synchronous: no database, no clock of its own (callers pass `nowMs`).
 */
import { createHmac, randomBytes } from 'node:crypto';

import { constantTimeEquals } from './session';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** ±1 step (±30 s). Every extra step is 30 more seconds in which a captured code works. */
export const TOTP_SKEW_STEPS = 1;
export const TOTP_SECRET_BYTES = 20;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out; // RFC 4648 uppercase, no padding
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/=+$/, '').replace(/[\s-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Not a base32 string.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret(): { bytes: Buffer; base32: string } {
  const bytes = randomBytes(TOTP_SECRET_BYTES);
  return { bytes, base32: base32Encode(bytes) };
}

export function stepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

export function totpForStep(secret: Uint8Array, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', secret).update(counter).digest();
  const offset = hmac[19]! & 0x0f;
  const binary =
    (((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!) >>> 0;
  return (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0');
}

/**
 * The step a code was generated for, or null.
 *
 * Replay: a step `<= lastUsedStep` is refused even when the code is right, which is what makes a code
 * single-use. All candidate steps are compared (no early exit) with `constantTimeEquals`, never `===`.
 */
export function acceptTotp(
  secret: Uint8Array,
  code: string,
  nowMs: number,
  lastUsedStep: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = stepAt(nowMs);
  let accepted: number | null = null;
  for (let step = now - TOTP_SKEW_STEPS; step <= now + TOTP_SKEW_STEPS; step += 1) {
    const match = constantTimeEquals(totpForStep(secret, step), code);
    if (match && (lastUsedStep === null || step > lastUsedStep) && (accepted === null || step > accepted)) accepted = step;
  }
  return accepted;
}

/** `issuer` has its spaces removed (a space breaks some apps); both parts are percent-encoded. */
export function otpauthUri(input: { issuer: string; account: string; secretBase32: string }): string {
  const issuer = encodeURIComponent(input.issuer.replace(/\s+/g, ''));
  return `otpauth://totp/${issuer}:${encodeURIComponent(input.account)}?secret=${input.secretBase32}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}
