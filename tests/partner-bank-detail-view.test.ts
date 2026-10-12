import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { SessionContext } from '../src/platform/auth/session';
import type { Tx } from '../src/platform/db/client';
import {
  BankDataEncryptionError,
  encryptBankData,
  type BankDataKeyring,
} from '../src/platform/security/bank-data-encryption';
import { generateBankRecordId, type BankRecordId } from '../src/platform/security/bank-record-id';
import { partnerBank } from '../src/modules/foundation/partner-bank-schema';

const mocks = vi.hoisted(() => ({ withTenant: vi.fn() }));
vi.mock('../src/platform/db/client', () => ({ withTenant: mocks.withTenant }));

import {
  getPartnerBankMaskedDetail,
} from '../src/modules/foundation/partner-bank-detail-view';
import { PartnerBankMetadataAccessError } from '../src/modules/foundation/partner-bank-reads';

const CLIENT = 'T123';
const PARTNER = 'BP.100';
const keyring: BankDataKeyring = {
  activeKeyId: 'synthetic-key',
  keys: new Map([['synthetic-key', randomBytes(32)]]),
};

function session(capabilities: string[], client = CLIENT): SessionContext {
  return {
    user: {
      client,
      userId: '00000000-0000-4000-8000-000000000123',
      username: 'synthetic.reader',
      fullName: 'Synthetic Reader',
      email: null,
      mustChangePassword: false,
      capabilities,
    },
    expiresAt: new Date('2030-01-01T00:00:00Z'),
    renewed: false,
  };
}

function fakeTx(rows: unknown[], trace: Record<string, unknown>): Tx {
  return {
    select(selection: unknown) {
      trace.selection = selection;
      return {
        from(table: unknown) {
          trace.table = table;
          return {
            where(condition: unknown) {
              trace.condition = condition;
              return {
                limit(limit: number) {
                  trace.limit = limit;
                  return Promise.resolve(rows);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Tx;
}

function configureTenantQuery(rows: unknown[]) {
  const trace: Record<string, unknown> = {};
  const tx = fakeTx(rows, trace);
  mocks.withTenant.mockImplementation(async (client: string, callback: (tx: Tx) => Promise<unknown>) => {
    trace.client = client;
    if (typeof callback !== 'function') throw new Error('The test expected withTenant to receive a callback.');
    return callback(tx);
  });
  return trace;
}

function encryptedRow(
  identifierField: 'iban' | 'localAccountNumber',
  identifier: string,
  options: { bankRecordId?: BankRecordId; contextClient?: string; contextPartner?: string } = {},
) {
  const bankRecordId = options.bankRecordId ?? generateBankRecordId();
  const envelope = encryptBankData(identifier, {
    client: options.contextClient ?? CLIENT,
    partnerNumber: options.contextPartner ?? PARTNER,
    bankRecordId,
    field: identifierField,
  }, keyring);
  return {
    row: {
      client: CLIENT,
      bankRecordId,
      partnerNumber: PARTNER,
      accountHolder: 'Synthetic Holder',
      country: 'KW',
      bankName: 'Synthetic Bank',
      bankCode: 'SYN',
      ibanCiphertext: identifierField === 'iban' ? envelope : null,
      localAccountNumberCiphertext: identifierField === 'localAccountNumber' ? envelope : null,
      bic: null,
      validFrom: '2026-01-01',
      validTo: null,
      isActive: true,
      version: 1,
    },
    bankRecordId,
    envelope,
  };
}

describe('scoped D-074 partner-bank detail mask', () => {
  beforeEach(() => {
    mocks.withTenant.mockReset();
  });

  it('checks display access, scopes by tenant + partner + row ID, and returns only a final-four mask', async () => {
    const syntheticIdentifier = 'SYNTHETIC-ACCOUNT-9876';
    const fixture = encryptedRow('localAccountNumber', syntheticIdentifier);
    const trace = configureTenantQuery([fixture.row]);

    const result = await getPartnerBankMaskedDetail(
      session(['FND.PARTNER.DISPLAY']), PARTNER, fixture.bankRecordId, keyring,
    );

    expect(trace.client).toBe(CLIENT);
    expect(trace.table).toBe(partnerBank);
    expect(trace.limit).toBe(1);
    const query = new PgDialect().sqlToQuery(trace.condition as SQL);
    expect(query.sql).toContain('"partner_bank"."client" = $1');
    expect(query.sql).toContain('"partner_bank"."partner_number" = $2');
    expect(query.sql).toContain('"partner_bank"."bank_record_id" = $3');
    expect(query.params).toEqual([CLIENT, PARTNER, fixture.bankRecordId]);

    const selectedColumns = Object.keys(trace.selection as Record<string, unknown>);
    expect(selectedColumns).toContain('localAccountNumberCiphertext');
    expect(selectedColumns).toContain('ibanCiphertext');
    expect(selectedColumns).not.toContain('localAccountNumber');
    expect(selectedColumns).not.toContain('iban');
    expect(result).toEqual({
      accountHolder: 'Synthetic Holder',
      country: 'KW',
      bankName: 'Synthetic Bank',
      bankCode: 'SYN',
      bic: null,
      validFrom: '2026-01-01',
      validTo: null,
      isActive: true,
      version: 1,
      identifierKind: 'LOCAL_ACCOUNT_NUMBER',
      maskedIdentifier: '••••9876',
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(syntheticIdentifier);
    expect(serialized).not.toContain(fixture.envelope);
    expect(serialized).not.toContain(fixture.bankRecordId);
  });

  it('masks an IBAN with the same normal-detail format', async () => {
    const fixture = encryptedRow('iban', 'SYNTHETIC-IBAN-4321');
    configureTenantQuery([fixture.row]);

    await expect(getPartnerBankMaskedDetail(
      session(['FND.PARTNER.DISPLAY']), PARTNER, fixture.bankRecordId, keyring,
    )).resolves.toMatchObject({ identifierKind: 'IBAN', maskedIdentifier: '••••4321' });
  });

  it('denies before querying when actual partner-display capability is absent', async () => {
    const fixture = encryptedRow('localAccountNumber', 'SYNTHETIC-ACCOUNT-9876');

    await expect(getPartnerBankMaskedDetail(
      session(['AUDIT.*']), PARTNER, fixture.bankRecordId, keyring,
    )).rejects.toBeInstanceOf(PartnerBankMetadataAccessError);
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it('returns unavailable without querying for malformed partner or UUIDv4 selectors', async () => {
    await expect(getPartnerBankMaskedDetail(
      session(['FND.PARTNER.DISPLAY']), 'bp.100', generateBankRecordId(), keyring,
    )).resolves.toBeNull();
    await expect(getPartnerBankMaskedDetail(
      session(['FND.PARTNER.DISPLAY']), PARTNER, 'not-a-uuid', keyring,
    )).resolves.toBeNull();
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it('returns unavailable for absent/mismatched rows or malformed identifier-envelope state', async () => {
    const requestedId = generateBankRecordId();
    configureTenantQuery([]);
    await expect(getPartnerBankMaskedDetail(
      session(['FND.PARTNER.DISPLAY']), PARTNER, requestedId, keyring,
    )).resolves.toBeNull();

    const otherRow = encryptedRow('localAccountNumber', 'SYNTHETIC-ACCOUNT-9876');
    configureTenantQuery([otherRow.row]);
    await expect(getPartnerBankMaskedDetail(
      session(['FND.PARTNER.DISPLAY']), PARTNER, requestedId, keyring,
    )).resolves.toBeNull();

    const bothIdentifiers = encryptedRow('localAccountNumber', 'SYNTHETIC-ACCOUNT-9876');
    configureTenantQuery([{ ...bothIdentifiers.row, ibanCiphertext: bothIdentifiers.envelope }]);
    await expect(getPartnerBankMaskedDetail(
      session(['FND.PARTNER.DISPLAY']), PARTNER, bothIdentifiers.bankRecordId, keyring,
    )).resolves.toBeNull();

    configureTenantQuery([{ ...bothIdentifiers.row, ibanCiphertext: '' }]);
    await expect(getPartnerBankMaskedDetail(
      session(['FND.PARTNER.DISPLAY']), PARTNER, bothIdentifiers.bankRecordId, keyring,
    )).resolves.toBeNull();
  });

  it('fails with a generic crypto error when row-bound authenticated decryption fails', async () => {
    const fixture = encryptedRow('iban', 'SYNTHETIC-IBAN-4321', { contextPartner: 'BP.999' });
    configureTenantQuery([fixture.row]);

    const error = await getPartnerBankMaskedDetail(
      session(['FND.PARTNER.DISPLAY']), PARTNER, fixture.bankRecordId, keyring,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BankDataEncryptionError);
    expect((error as Error).message).not.toContain('SYNTHETIC-IBAN-4321');
  });
});
