import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BankDataEncryptionError,
  decryptBankData,
  encryptBankData,
  type BankDataContext,
  type BankDataKeyring,
} from '../src/platform/security/bank-data-encryption';

const context: BankDataContext = {
  client: 'T999',
  partnerNumber: 'TEST-PARTNER',
  bankRecordId: 'TEST-BANK-ROW',
  field: 'localAccountNumber',
};

function keyring(activeKeyId = 'key-a', keys = new Map<string, Uint8Array>([['key-a', randomBytes(32)]])): BankDataKeyring {
  return { activeKeyId, keys };
}

function flipCiphertextByte(envelope: string): string {
  const parts = envelope.split('.');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  ciphertext[0] ^= 1;
  parts[3] = ciphertext.toString('base64url');
  return parts.join('.');
}

describe('versioned bank-data encryption primitive', () => {
  it('round-trips without storing plaintext in the envelope', () => {
    const secret = 'test-only-secret-value';
    const keys = keyring();
    const envelope = encryptBankData(secret, context, keys);

    expect(envelope).not.toContain(secret);
    expect(envelope.split('.')[0]).toBe('cbd1');
    expect(decryptBankData(envelope, context, keys)).toBe(secret);
  });

  it('uses a fresh nonce for each encryption', () => {
    const keys = keyring();
    const first = encryptBankData('test-only-secret-value', context, keys);
    const second = encryptBankData('test-only-secret-value', context, keys);

    expect(first).not.toBe(second);
    expect(first.split('.')[2]).not.toBe(second.split('.')[2]);
  });

  it('authenticates tenant, partner, row and field context', () => {
    const keys = keyring();
    const envelope = encryptBankData('test-only-secret-value', context, keys);

    expect(() => decryptBankData(envelope, { ...context, client: 'T998' }, keys)).toThrow(BankDataEncryptionError);
    expect(() => decryptBankData(envelope, { ...context, partnerNumber: 'OTHER-PARTNER' }, keys)).toThrow(
      BankDataEncryptionError,
    );
    expect(() => decryptBankData(envelope, { ...context, bankRecordId: 'OTHER-ROW' }, keys)).toThrow(
      BankDataEncryptionError,
    );
    expect(() => decryptBankData(envelope, { ...context, field: 'bic' }, keys)).toThrow(BankDataEncryptionError);
  });

  it('rejects tampered ciphertext and a missing key ID without revealing details', () => {
    const keys = keyring();
    const envelope = encryptBankData('test-only-secret-value', context, keys);

    const tamperError = caught(() => decryptBankData(flipCiphertextByte(envelope), context, keys));
    expect(tamperError).toBeInstanceOf(BankDataEncryptionError);
    expect(tamperError.message).not.toContain('test-only-secret-value');

    // Even an alias for the same key cannot be substituted: the key ID itself is AAD.
    const sharedKey = randomBytes(32);
    const aliases: BankDataKeyring = {
      activeKeyId: 'key-a',
      keys: new Map([
        ['key-a', sharedKey],
        ['key-b', sharedKey],
      ]),
    };
    const parts = encryptBankData('test-only-secret-value', context, aliases).split('.');
    parts[1] = 'key-b';
    expect(() => decryptBankData(parts.join('.'), context, aliases)).toThrow(BankDataEncryptionError);

    const missingPriorKey: BankDataKeyring = {
      activeKeyId: 'key-b',
      keys: new Map([['key-b', randomBytes(32)]]),
    };
    expect(() => decryptBankData(envelope, context, missingPriorKey)).toThrow(BankDataEncryptionError);
  });

  it('supports staged rotation: encrypt with the active key and read with a retained prior key', () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const oldKeyring: BankDataKeyring = { activeKeyId: 'key-a', keys: new Map([['key-a', oldKey]]) };
    const priorEnvelope = encryptBankData('test-only-secret-value', context, oldKeyring);
    const rotatedKeyring: BankDataKeyring = {
      activeKeyId: 'key-b',
      keys: new Map([
        ['key-a', oldKey],
        ['key-b', newKey],
      ]),
    };
    const newEnvelope = encryptBankData('test-only-secret-value', context, rotatedKeyring);

    expect(priorEnvelope.split('.')[1]).toBe('key-a');
    expect(newEnvelope.split('.')[1]).toBe('key-b');
    expect(decryptBankData(priorEnvelope, context, rotatedKeyring)).toBe('test-only-secret-value');
    expect(decryptBankData(newEnvelope, context, rotatedKeyring)).toBe('test-only-secret-value');
  });

  it('fails closed for malformed key material and malformed envelopes', () => {
    const invalidKeyring: BankDataKeyring = {
      activeKeyId: 'key-a',
      keys: new Map([['key-a', randomBytes(16)]]),
    };

    expect(() => encryptBankData('test-only-secret-value', context, invalidKeyring)).toThrow(BankDataEncryptionError);
    expect(() => decryptBankData('not-an-envelope', context, keyring())).toThrow(BankDataEncryptionError);
    expect(() => encryptBankData('test-only-secret-value', { ...context, field: '' }, keyring())).toThrow(
      BankDataEncryptionError,
    );
  });
});

function caught(callback: () => unknown): Error {
  try {
    callback();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error('Expected callback to throw.');
}
