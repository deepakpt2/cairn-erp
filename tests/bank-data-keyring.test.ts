import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BANK_DATA_KEYRING_ENV,
  BankDataKeyringConfigError,
  loadBankDataKeyring,
  parseBankDataKeyring,
} from '../src/platform/security/bank-data-keyring';

function encodedKey(): string {
  return randomBytes(32).toString('base64url');
}

function config(activeKeyId: string, keys: Record<string, string>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ activeKeyId, keys, ...extra });
}

describe('deployment-secret bank-data keyring configuration', () => {
  it('loads the active and retained prior keys from the named environment value', () => {
    const active = randomBytes(32);
    const previous = randomBytes(32);
    const serialized = JSON.stringify({
      activeKeyId: 'key-current',
      keys: {
        'key-current': active.toString('base64url'),
        'key-previous': previous.toString('base64url'),
      },
    });

    const keyring = loadBankDataKeyring({ [BANK_DATA_KEYRING_ENV]: serialized });

    expect(keyring.activeKeyId).toBe('key-current');
    expect(Buffer.from(keyring.keys.get('key-current')!)).toEqual(active);
    expect(Buffer.from(keyring.keys.get('key-previous')!)).toEqual(previous);
  });

  it('fails closed when the keyring secret is unset or blank', () => {
    expect(() => loadBankDataKeyring({})).toThrow(BankDataKeyringConfigError);
    expect(() => parseBankDataKeyring(undefined)).toThrow(BankDataKeyringConfigError);
    expect(() => parseBankDataKeyring('')).toThrow(BankDataKeyringConfigError);
    expect(() => parseBankDataKeyring('   ')).toThrow(BankDataKeyringConfigError);
  });

  it('rejects malformed JSON and unsupported object shapes', () => {
    const key = encodedKey();
    expect(() => parseBankDataKeyring('{not-json')).toThrow(BankDataKeyringConfigError);
    expect(() => parseBankDataKeyring('[]')).toThrow(BankDataKeyringConfigError);
    expect(() => parseBankDataKeyring(config('key-a', { 'key-a': key }, { extra: true }))).toThrow(
      BankDataKeyringConfigError,
    );
  });

  it('requires a valid active key ID that is present in the key map', () => {
    const key = encodedKey();
    expect(() => parseBankDataKeyring(config('missing', { 'key-a': key }))).toThrow(BankDataKeyringConfigError);
    expect(() => parseBankDataKeyring(config('not a key id', { 'not a key id': key }))).toThrow(
      BankDataKeyringConfigError,
    );
  });

  it('accepts only canonical unpadded base64url encoding of exactly 32 bytes', () => {
    expect(() => parseBankDataKeyring(config('key-a', { 'key-a': 'not*base64url' }))).toThrow(
      BankDataKeyringConfigError,
    );
    expect(() => parseBankDataKeyring(config('key-a', { 'key-a': randomBytes(16).toString('base64url') }))).toThrow(
      BankDataKeyringConfigError,
    );
    expect(() => parseBankDataKeyring(config('key-a', { 'key-a': `${encodedKey()}=` }))).toThrow(
      BankDataKeyringConfigError,
    );
  });

  it('rejects empty key maps and excessive retained-key sets', () => {
    expect(() => parseBankDataKeyring(config('key-a', {}))).toThrow(BankDataKeyringConfigError);
    const manyKeys = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`key-${index}`, encodedKey()]));
    expect(() => parseBankDataKeyring(config('key-0', manyKeys))).toThrow(BankDataKeyringConfigError);
  });

  it('returns a generic error without echoing the supplied key material or JSON', () => {
    const marker = `test-only-${encodedKey()}`;
    const serialized = config('key-a', { 'key-a': marker });
    let error: unknown;
    try {
      parseBankDataKeyring(serialized);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BankDataKeyringConfigError);
    expect((error as Error).message).not.toContain(marker);
    expect((error as Error).message).not.toContain(serialized);
    expect((error as BankDataKeyringConfigError).code).toBe('CAIRN_BANK_DATA_KEYRING_CONFIG_INVALID');
  });
});
