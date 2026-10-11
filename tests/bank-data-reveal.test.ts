import { describe, expect, it } from 'vitest';
import type { SessionContext } from '../src/platform/auth/session';
import type { Tx } from '../src/platform/db/client';
import { auditAccessLog } from '../src/platform/tables/security';
import {
  authorizeAndRecordBankRevealAttempt,
  PARTNER_BANK_REVEAL_CAPABILITY,
  recordBankRevealOutcome,
  type BankRevealAttemptRequest,
} from '../src/platform/security/bank-data-reveal';

const SYNTHETIC_BANK_RECORD_ID = '00000000-0000-4000-8000-000000000001';

const validRequest: BankRevealAttemptRequest = {
  partnerKey: 'BP.100',
  bankRecordId: SYNTHETIC_BANK_RECORD_ID,
  requestedFields: ['iban', 'localAccountNumber'],
  purposeCode: 'DATA_CORRECTION',
};

function session(capabilities: string[]): SessionContext {
  return {
    user: {
      client: 'T123',
      userId: '00000000-0000-4000-8000-000000000123',
      username: 'bank.operator',
      fullName: 'Synthetic User',
      email: null,
      mustChangePassword: false,
      capabilities,
    },
    expiresAt: new Date('2030-01-01T00:00:00Z'),
    renewed: false,
  };
}

function captureTx(options: { failWrite?: boolean } = {}) {
  const writes: Array<{ table: unknown; values: unknown }> = [];
  const tx = {
    insert(table: unknown) {
      return {
        values(values: unknown) {
          if (options.failWrite) return Promise.reject(new Error('synthetic database error'));
          writes.push({ table, values });
          return Promise.resolve([]);
        },
      };
    },
  } as unknown as Tx;
  return { tx, writes };
}

function writtenValues(writes: Array<{ table: unknown; values: unknown }>) {
  expect(writes).toHaveLength(1);
  expect(writes[0].table).toBe(auditAccessLog);
  return writes[0].values as Record<string, unknown>;
}

describe('bank identifier reveal authorization/audit boundary', () => {
  it('allows the dedicated capability only with partner display, and uses standard wildcard matching', async () => {
    const authorized = captureTx();
    const result = await authorizeAndRecordBankRevealAttempt(
      authorized.tx,
      session(['FND.PARTNER.DISPLAY', PARTNER_BANK_REVEAL_CAPABILITY]),
      validRequest,
    );
    expect(result).toEqual({
      allowed: true,
      partnerKey: 'BP.100',
      bankRecordId: SYNTHETIC_BANK_RECORD_ID,
      fields: ['iban', 'localAccountNumber'],
      purposeCode: 'DATA_CORRECTION',
    });

    const administrator = captureTx();
    await expect(authorizeAndRecordBankRevealAttempt(
      administrator.tx,
      session(['*']),
      validRequest,
    )).resolves.toMatchObject({ allowed: true });

    const broadReadRoles = captureTx();
    const denied = await authorizeAndRecordBankRevealAttempt(
      broadReadRoles.tx,
      session(['FND.*', 'AUDIT.*']),
      validRequest,
    );
    expect(denied).toMatchObject({
      allowed: false,
      denialCode: 'MISSING_REVEAL_CAPABILITY',
      missingCapability: PARTNER_BANK_REVEAL_CAPABILITY,
    });
    expect(writtenValues(broadReadRoles.writes).eventType).toBe('CAPABILITY_DENIED');
  });

  it('writes only session-derived identity and safe request metadata for an allowed attempt', async () => {
    const { tx, writes } = captureTx();
    const spoofed = {
      ...validRequest,
      client: 'T999',
      userId: 'forged-user',
      username: 'forged-name',
      accountValue: 'SYNTHETIC-ACCOUNT-DO-NOT-LOG',
    } as BankRevealAttemptRequest;

    await authorizeAndRecordBankRevealAttempt(
      tx,
      session(['FND.PARTNER.DISPLAY', PARTNER_BANK_REVEAL_CAPABILITY]),
      spoofed,
    );

    const values = writtenValues(writes);
    expect(values.client).toBe('T123');
    expect(values.userId).toBe('00000000-0000-4000-8000-000000000123');
    expect(values.username).toBe('bank.operator');
    expect(values.eventType).toBe('READ');
    expect(values.transactionCode).toBe(PARTNER_BANK_REVEAL_CAPABILITY);
    expect(values.objectType).toBe('partner_bank');
    expect(values.objectKey).toBe(SYNTHETIC_BANK_RECORD_ID);
    const detail = JSON.parse(String(values.detail)) as Record<string, unknown>;
    expect(detail).toEqual({
      partnerKey: 'BP.100',
      fieldNames: ['iban', 'localAccountNumber'],
      outcome: 'AUTHORIZED',
      purposeCode: 'DATA_CORRECTION',
      denialCode: null,
    });
    expect(JSON.stringify(values)).not.toContain('SYNTHETIC-ACCOUNT-DO-NOT-LOG');
  });

  it('supports terminal success and denial events without carrying values', async () => {
    const attempt = await authorizeAndRecordBankRevealAttempt(
      captureTx().tx,
      session(['FND.PARTNER.DISPLAY', PARTNER_BANK_REVEAL_CAPABILITY]),
      validRequest,
    );
    if (!attempt.allowed) throw new Error('Synthetic authorization unexpectedly denied.');

    const success = captureTx();
    await recordBankRevealOutcome(success.tx, session(['*']), attempt, { outcome: 'SUCCESS' });
    const successValues = writtenValues(success.writes);
    const successDetail = JSON.parse(String(successValues.detail)) as Record<string, unknown>;
    expect(successValues.eventType).toBe('READ');
    expect(successDetail.outcome).toBe('SUCCESS');
    expect(successDetail.denialCode).toBeNull();

    const denied = captureTx();
    await recordBankRevealOutcome(denied.tx, session(['*']), attempt, {
      outcome: 'DENIED',
      denialCode: 'CRYPTO_FAILURE',
    });
    const deniedDetail = JSON.parse(String(writtenValues(denied.writes).detail)) as Record<string, unknown>;
    expect(deniedDetail.outcome).toBe('DENIED');
    expect(deniedDetail.denialCode).toBe('CRYPTO_FAILURE');
    expect(JSON.stringify(denied.writes.map((write) => write.values))).not.toContain('ciphertext');
  });

  it('audits missing partner-display authority without approving the attempt', async () => {
    const { tx, writes } = captureTx();
    const result = await authorizeAndRecordBankRevealAttempt(
      tx,
      session([PARTNER_BANK_REVEAL_CAPABILITY]),
      validRequest,
    );

    expect(result).toMatchObject({
      allowed: false,
      denialCode: 'MISSING_PARTNER_DISPLAY',
      missingCapability: 'FND.PARTNER.DISPLAY',
    });
    expect(writtenValues(writes).eventType).toBe('CAPABILITY_DENIED');
  });

  it('does not echo invalid fields, free text, or invalid keys into the audit detail', async () => {
    const { tx, writes } = captureTx();
    const sensitiveLookingText = 'SYNTHETIC ACCOUNT: 987654321';
    const result = await authorizeAndRecordBankRevealAttempt(
      tx,
      session(['FND.PARTNER.DISPLAY', PARTNER_BANK_REVEAL_CAPABILITY]),
      {
        partnerKey: sensitiveLookingText,
        bankRecordId: SYNTHETIC_BANK_RECORD_ID,
        requestedFields: ['iban', sensitiveLookingText],
        purposeCode: `FREE TEXT ${sensitiveLookingText}`,
      },
    );

    expect(result).toMatchObject({ allowed: false, denialCode: 'INVALID_OBJECT_KEY' });
    const values = writtenValues(writes);
    const detail = String(values.detail);
    expect(values.objectKey).toBe(SYNTHETIC_BANK_RECORD_ID);
    expect(detail).toContain('"partnerKey":null');
    expect(detail).toContain('"fieldNames":["iban"]');
    expect(detail).not.toContain(sensitiveLookingText);
    expect(detail).not.toContain('FREE TEXT');
  });

  it('rejects non-UUID bank-record IDs and omits them from audit fields', async () => {
    const { tx, writes } = captureTx();
    const rawId = 'bank-row-001';
    const result = await authorizeAndRecordBankRevealAttempt(
      tx,
      session(['FND.PARTNER.DISPLAY', PARTNER_BANK_REVEAL_CAPABILITY]),
      { ...validRequest, bankRecordId: rawId },
    );

    expect(result).toMatchObject({ allowed: false, denialCode: 'INVALID_OBJECT_KEY' });
    const values = writtenValues(writes);
    expect(values.objectKey).toBeNull();
    expect(JSON.stringify(values)).not.toContain(rawId);
  });

  it('denies invalid field sets and purpose strings using fixed audit metadata', async () => {
    const invalidFieldAttempt = captureTx();
    const rawValue = 'SYNTHETIC-ACCOUNT-987654321';
    const invalidFields = await authorizeAndRecordBankRevealAttempt(
      invalidFieldAttempt.tx,
      session(['FND.PARTNER.DISPLAY', PARTNER_BANK_REVEAL_CAPABILITY]),
      {
        ...validRequest,
        requestedFields: ['iban', rawValue],
        purposeCode: `FREE TEXT ${rawValue}`,
      },
    );
    expect(invalidFields).toMatchObject({ allowed: false, denialCode: 'INVALID_FIELDS' });
    const fieldDetail = String(writtenValues(invalidFieldAttempt.writes).detail);
    expect(fieldDetail).toContain('"fieldNames":["iban"]');
    expect(fieldDetail).not.toContain(rawValue);
    expect(fieldDetail).not.toContain('FREE TEXT');

    const invalidPurposeAttempt = captureTx();
    const invalidPurpose = await authorizeAndRecordBankRevealAttempt(
      invalidPurposeAttempt.tx,
      session(['FND.PARTNER.DISPLAY', PARTNER_BANK_REVEAL_CAPABILITY]),
      { ...validRequest, purposeCode: `FREE TEXT ${rawValue}` },
    );
    expect(invalidPurpose).toMatchObject({ allowed: false, denialCode: 'INVALID_PURPOSE' });
    const purposeDetail = String(writtenValues(invalidPurposeAttempt.writes).detail);
    expect(purposeDetail).toContain('"purposeCode":null');
    expect(purposeDetail).not.toContain(rawValue);
    expect(purposeDetail).not.toContain('FREE TEXT');
  });

  it('fails closed with a generic error if the audit insert fails', async () => {
    const { tx } = captureTx({ failWrite: true });
    await expect(authorizeAndRecordBankRevealAttempt(
      tx,
      session(['FND.PARTNER.DISPLAY', PARTNER_BANK_REVEAL_CAPABILITY]),
      validRequest,
    )).rejects.toThrow('The bank-data reveal attempt could not be recorded; the operation was denied.');
  });
});
