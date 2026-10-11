/**
 * Deployment-secret configuration for the bank-data keyring — CAIRN.md D-068 / B-055.
 *
 * Load on demand only; importing this module never reads process.env. The secret
 * value itself is never included in errors or logs.
 */
import { isBankDataKeyId, type BankDataKeyring } from './bank-data-encryption';

export const BANK_DATA_KEYRING_ENV = 'CAIRN_BANK_DATA_KEYRING_JSON';
const KEY_BYTES = 32;
const KEY_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_CONFIG_BYTES = 16_384;
const MAX_KEY_COUNT = 16;

/** Safe configuration error; it intentionally omits the supplied secret value. */
export class BankDataKeyringConfigError extends Error {
  readonly code = 'CAIRN_BANK_DATA_KEYRING_CONFIG_INVALID';

  constructor() {
    super('Bank-data keyring configuration is missing or invalid.');
    this.name = 'BankDataKeyringConfigError';
  }
}

/**
 * Reads the deployment-secret variable only when called. There is no development
 * fallback or implicit key generation; an unset value fails closed.
 */
export function loadBankDataKeyring(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): BankDataKeyring {
  return parseBankDataKeyring(environment[BANK_DATA_KEYRING_ENV]);
}

/**
 * Strict JSON contract: {"activeKeyId":"id","keys":{"id":"<32-byte base64url>"}}.
 * Key bytes are canonical, unpadded base64url; IDs must match the encryption
 * envelope grammar. Retain prior IDs and key material until all old ciphertext
 * has been re-encrypted and verified.
 */
export function parseBankDataKeyring(serialized: string | undefined): BankDataKeyring {
  try {
    if (
      typeof serialized !== 'string' ||
      serialized.length === 0 ||
      Buffer.byteLength(serialized, 'utf8') > MAX_CONFIG_BYTES
    ) {
      fail();
    }

    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed)) fail();
    const rootKeys = Object.keys(parsed);
    if (rootKeys.length !== 2 || !rootKeys.includes('activeKeyId') || !rootKeys.includes('keys')) fail();

    const activeKeyId = parsed.activeKeyId;
    const sourceKeys = parsed.keys;
    if (!isBankDataKeyId(activeKeyId) || !isRecord(sourceKeys)) fail();

    const entries = Object.entries(sourceKeys);
    if (entries.length === 0 || entries.length > MAX_KEY_COUNT) fail();

    const keys = new Map<string, Uint8Array>();
    for (const [keyId, encoded] of entries) {
      if (!isBankDataKeyId(keyId) || typeof encoded !== 'string' || !KEY_BASE64URL_PATTERN.test(encoded)) {
        fail();
      }
      const material = Buffer.from(encoded, 'base64url');
      if (material.byteLength !== KEY_BYTES || material.toString('base64url') !== encoded) fail();
      keys.set(keyId, material);
    }

    if (!keys.has(activeKeyId)) fail();
    return { activeKeyId, keys };
  } catch {
    throw new BankDataKeyringConfigError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(): never {
  throw new BankDataKeyringConfigError();
}
