import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateBankRecordId } from '../src/platform/security/bank-record-id';
import {
  BankDataEncryptionError,
  decryptBankData,
  encryptBankData,
  reencryptBankData,
  reencryptBankDataBatch,
  verifyBankDataBatchOnActiveKey,
  type BankDataContext,
  type BankDataKeyring,
} from '../src/platform/security/bank-data-encryption';

const context: BankDataContext = {
  client: 'T999',
  partnerNumber: 'TEST-PARTNER',
  bankRecordId: generateBankRecordId(),
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
    expect(() => decryptBankData(envelope, { ...context, bankRecordId: generateBankRecordId() }, keys)).toThrow(
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

  it('re-encrypts retained-key values with the active key and then becomes idempotent', () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const oldKeyring: BankDataKeyring = { activeKeyId: 'key-a', keys: new Map([['key-a', oldKey]]) };
    const oldEnvelope = encryptBankData('test-only-secret-value', context, oldKeyring);
    const rotatedKeyring: BankDataKeyring = {
      activeKeyId: 'key-b',
      keys: new Map([
        ['key-a', oldKey],
        ['key-b', newKey],
      ]),
    };

    const reencrypted = reencryptBankData(oldEnvelope, context, rotatedKeyring);
    expect(reencrypted).not.toBe(oldEnvelope);
    expect(reencrypted.split('.')[1]).toBe('key-b');
    expect(reencrypted).not.toContain('test-only-secret-value');
    expect(decryptBankData(reencrypted, context, rotatedKeyring)).toBe('test-only-secret-value');
    expect(reencryptBankData(reencrypted, context, rotatedKeyring)).toBe(reencrypted);
  });

  it('authenticates already-current envelopes and refuses missing prior keys or wrong context', () => {
    const keys = keyring();
    const current = encryptBankData('test-only-secret-value', context, keys);
    expect(reencryptBankData(current, context, keys)).toBe(current);
    expect(() => reencryptBankData(flipCiphertextByte(current), context, keys)).toThrow(BankDataEncryptionError);
    expect(() => reencryptBankData(current, { ...context, field: 'bic' }, keys)).toThrow(BankDataEncryptionError);

    const missingPrior: BankDataKeyring = {
      activeKeyId: 'key-b',
      keys: new Map([['key-b', randomBytes(32)]]),
    };
    expect(() => reencryptBankData(current, context, missingPrior)).toThrow(BankDataEncryptionError);
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

    const malformedRecordId = { ...context, bankRecordId: 'TEST-BANK-ROW' } as unknown as BankDataContext;
    expect(() => encryptBankData('test-only-secret-value', malformedRecordId, keyring())).toThrow(
      BankDataEncryptionError,
    );
  });

  it('re-encrypts all non-null fields in a supplied batch and returns ciphertext only', () => {
    const plaintext = 'test-only-rotation-value';
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const oldKeyring: BankDataKeyring = { activeKeyId: 'key-a', keys: new Map([['key-a', oldKey]]) };
    const rotatedKeyring: BankDataKeyring = {
      activeKeyId: 'key-b',
      keys: new Map([
        ['key-a', oldKey],
        ['key-b', newKey],
      ]),
    };
    const bankRecordId = generateBankRecordId();
    const row = {
      client: context.client,
      partnerNumber: context.partnerNumber,
      bankRecordId,
      fields: {
        iban: encryptBankData(plaintext, { ...context, bankRecordId, field: 'iban' }, oldKeyring),
        localAccountNumber: null,
      },
    };
    const result = reencryptBankDataBatch([row], rotatedKeyring);
    const newIban = result.records[0].fields.iban;

    expect(result.reencryptedFieldCount).toBe(1);
    expect(newIban).not.toBe(row.fields.iban);
    expect(newIban?.split('.')[1]).toBe('key-b');
    expect(decryptBankData(String(newIban), { ...context, bankRecordId, field: 'iban' }, rotatedKeyring)).toBe(plaintext);
    expect(result.records[0].fields.localAccountNumber).toBeNull();
    expect(JSON.stringify(result)).not.toContain(plaintext);
    expect(row.fields.iban).not.toBe(newIban);
  });

  it('authenticates and leaves already-current batch fields unchanged', () => {
    const keys = keyring();
    const bankRecordId = generateBankRecordId();
    const current = encryptBankData('test-only-current-value', { ...context, bankRecordId, field: 'bic' }, keys);
    const result = reencryptBankDataBatch([{
      client: context.client,
      partnerNumber: context.partnerNumber,
      bankRecordId,
      fields: { bic: current },
    }], keys);

    expect(result.reencryptedFieldCount).toBe(0);
    expect(result.records[0].fields.bic).toBe(current);
  });

  it('fails the entire pure batch on an invalid envelope', () => {
    const bankRecordId = generateBankRecordId();
    const records = [{
      client: context.client,
      partnerNumber: context.partnerNumber,
      bankRecordId,
      fields: { iban: 'not-an-envelope' },
    }];

    expect(() => reencryptBankDataBatch(records, keyring())).toThrow(BankDataEncryptionError);
  });

  it('verifies every supplied ciphertext using an active-key-only keyring', () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const oldKeyring: BankDataKeyring = { activeKeyId: 'key-a', keys: new Map([['key-a', oldKey]]) };
    const rotatedKeyring: BankDataKeyring = {
      activeKeyId: 'key-b',
      keys: new Map([
        ['key-a', oldKey],
        ['key-b', newKey],
      ]),
    };
    const bankRecordId = generateBankRecordId();
    const records = reencryptBankDataBatch([{
      client: context.client,
      partnerNumber: context.partnerNumber,
      bankRecordId,
      fields: {
        iban: encryptBankData('test-only-verify-value', { ...context, bankRecordId, field: 'iban' }, oldKeyring),
        bic: null,
      },
    }], rotatedKeyring).records;
    const activeOnly: BankDataKeyring = { activeKeyId: 'key-b', keys: new Map([['key-b', newKey]]) };

    expect(verifyBankDataBatchOnActiveKey(records, activeOnly)).toEqual({
      activeKeyId: 'key-b',
      recordCount: 1,
      encryptedFieldCount: 1,
    });
  });

  it('rejects prior-key envelopes and refuses a verification keyring that retains old keys', () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const oldKeyring: BankDataKeyring = { activeKeyId: 'key-a', keys: new Map([['key-a', oldKey]]) };
    const rotatedKeyring: BankDataKeyring = {
      activeKeyId: 'key-b',
      keys: new Map([
        ['key-a', oldKey],
        ['key-b', newKey],
      ]),
    };
    const bankRecordId = generateBankRecordId();
    const oldRecords = [{
      client: context.client,
      partnerNumber: context.partnerNumber,
      bankRecordId,
      fields: {
        iban: encryptBankData('test-only-old-key-value', { ...context, bankRecordId, field: 'iban' }, oldKeyring),
      },
    }];
    const activeOnly: BankDataKeyring = { activeKeyId: 'key-b', keys: new Map([['key-b', newKey]]) };
    expect(() => verifyBankDataBatchOnActiveKey(oldRecords, activeOnly)).toThrow(BankDataEncryptionError);

    const currentEnvelope = encryptBankData(
      'test-only-current-key-value',
      { ...context, bankRecordId, field: 'bic' },
      rotatedKeyring,
    );
    const currentRecords = [{
      client: context.client,
      partnerNumber: context.partnerNumber,
      bankRecordId,
      fields: { bic: currentEnvelope },
    }];
    expect(() => verifyBankDataBatchOnActiveKey(currentRecords, rotatedKeyring)).toThrow(BankDataEncryptionError);
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
