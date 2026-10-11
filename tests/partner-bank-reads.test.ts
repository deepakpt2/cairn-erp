import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { SessionContext } from '../src/platform/auth/session';
import type { Tx } from '../src/platform/db/client';
import { partnerBank } from '../src/modules/foundation/partner-bank-schema';

const mocks = vi.hoisted(() => ({ withTenant: vi.fn() }));
vi.mock('../src/platform/db/client', () => ({ withTenant: mocks.withTenant }));

import {
  listPartnerBankMetadata,
  lookupPartnerBankMetadata,
  PartnerBankMetadataAccessError,
} from '../src/modules/foundation/partner-bank-reads';

const RECORD_ID = 'f0c49b11-9ab2-4ca8-91d6-ef6a0c9f5f21';

function session(capabilities: string[], client = 'T123'): SessionContext {
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
                orderBy(...ordering: unknown[]) {
                  trace.orderBy = ordering;
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
    if (typeof callback !== 'function') {
      throw new Error('The test expected withTenant to receive a callback.');
    }
    return callback(tx);
  });
  return trace;
}

const row = {
  bankRecordId: RECORD_ID,
  partnerNumber: 'BP.100',
  accountHolder: 'Synthetic Holder',
  country: 'KW',
  bankName: 'Synthetic Bank',
  bankCode: 'TEST',
  bic: null,
  validFrom: '2026-01-01',
  validTo: null,
  isActive: true,
  version: 1,
};

describe('scoped partner-bank metadata lookup', () => {
  beforeEach(() => {
    mocks.withTenant.mockReset();
  });

  it('binds session tenant, partner, and UUIDv4 in one query and returns only metadata', async () => {
    const trace = configureTenantQuery([row]);

    const result = await lookupPartnerBankMetadata(
      session(['FND.PARTNER.DISPLAY']),
      'BP.100',
      RECORD_ID,
    );

    expect(trace.client).toBe('T123');
    expect(trace.table).toBe(partnerBank);
    expect(trace.limit).toBe(1);
    const query = new PgDialect().sqlToQuery(trace.condition as SQL);
    expect(query.sql).toContain('"partner_bank"."client" = $1');
    expect(query.sql).toContain('"partner_bank"."partner_number" = $2');
    expect(query.sql).toContain('"partner_bank"."bank_record_id" = $3');
    expect(query.params).toEqual(['T123', 'BP.100', RECORD_ID]);

    const selectedColumns = Object.keys(trace.selection as Record<string, unknown>);
    expect(selectedColumns).not.toContain('ibanCiphertext');
    expect(selectedColumns).not.toContain('localAccountNumberCiphertext');
    expect(result).toEqual({ ...row });
    expect(JSON.stringify(result)).not.toContain('ciphertext');
  });

  it('does not query without partner display access', async () => {
    await expect(lookupPartnerBankMetadata(session(['AUDIT.*']), 'BP.100', RECORD_ID))
      .rejects.toBeInstanceOf(PartnerBankMetadataAccessError);
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it('treats invalid partner or row keys as unavailable without a database query', async () => {
    await expect(lookupPartnerBankMetadata(session(['FND.PARTNER.DISPLAY']), 'bp.100', RECORD_ID))
      .resolves.toBeNull();
    await expect(lookupPartnerBankMetadata(session(['FND.PARTNER.DISPLAY']), 'BP.100', 'bank-row-1'))
      .resolves.toBeNull();
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it('returns null for missing rows and rejects an invalid-shaped ID returned by the database', async () => {
    configureTenantQuery([]);
    await expect(lookupPartnerBankMetadata(session(['FND.PARTNER.DISPLAY']), 'BP.100', RECORD_ID))
      .resolves.toBeNull();

    configureTenantQuery([{ ...row, bankRecordId: 'not-a-uuid' }]);
    await expect(lookupPartnerBankMetadata(session(['FND.PARTNER.DISPLAY']), 'BP.100', RECORD_ID))
      .resolves.toBeNull();
  });

  it('lists every matched row, including inactive history, using a metadata-only projection', async () => {
    const inactiveRow = {
      ...row,
      bankRecordId: 'f0c49b11-9ab2-4ca8-91d6-ef6a0c9f5f22',
      validFrom: '2025-01-01',
      isActive: false,
    };
    const trace = configureTenantQuery([row, inactiveRow]);

    const result = await listPartnerBankMetadata(session(['FND.PARTNER.DISPLAY']), 'BP.100');

    expect(trace.client).toBe('T123');
    expect(trace.table).toBe(partnerBank);
    const query = new PgDialect().sqlToQuery(trace.condition as SQL);
    expect(query.sql).toContain('"partner_bank"."client" = $1');
    expect(query.sql).toContain('"partner_bank"."partner_number" = $2');
    expect(query.params).toEqual(['T123', 'BP.100']);

    const ordering = trace.orderBy as SQL[];
    expect(ordering).toHaveLength(2);
    expect(new PgDialect().sqlToQuery(ordering[0]).sql)
      .toContain('"partner_bank"."valid_from" desc');
    expect(new PgDialect().sqlToQuery(ordering[1]).sql)
      .toContain('"partner_bank"."bank_record_id" asc');

    const selectedColumns = Object.keys(trace.selection as Record<string, unknown>);
    expect(selectedColumns).not.toContain('ibanCiphertext');
    expect(selectedColumns).not.toContain('localAccountNumberCiphertext');
    expect(selectedColumns).not.toContain('iban');
    expect(selectedColumns).not.toContain('localAccountNumber');
    expect(result).toEqual([row, inactiveRow]);
    expect(JSON.stringify(result)).not.toContain('ciphertext');
  });

  it('does not list without partner display access', async () => {
    await expect(listPartnerBankMetadata(session(['AUDIT.*']), 'BP.100'))
      .rejects.toBeInstanceOf(PartnerBankMetadataAccessError);
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it('rejects malformed partner selectors without querying and returns an empty list for no rows', async () => {
    await expect(listPartnerBankMetadata(session(['FND.PARTNER.DISPLAY']), 'bp.100'))
      .resolves.toBeNull();
    expect(mocks.withTenant).not.toHaveBeenCalled();

    const trace = configureTenantQuery([]);
    await expect(listPartnerBankMetadata(session(['FND.PARTNER.DISPLAY']), 'BP.100'))
      .resolves.toEqual([]);
    expect(trace.client).toBe('T123');
  });

  it('fails the full list closed if the database returns a malformed row ID', async () => {
    configureTenantQuery([{ ...row, bankRecordId: 'not-a-uuid' }]);
    await expect(listPartnerBankMetadata(session(['FND.PARTNER.DISPLAY']), 'BP.100'))
      .resolves.toBeNull();
  });
});
