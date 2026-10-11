import { readFileSync } from 'node:fs';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { partnerBank } from '../src/platform/schema';

const partnerBankConfig = getTableConfig(partnerBank);
const tableMigration = readFileSync('drizzle/0013_partner_bank_master.sql', 'utf8');
const envelopeBoundMigration = readFileSync('drizzle/0014_partner_bank_envelope_bound.sql', 'utf8');
const policyMigration = readFileSync('drizzle/9016_partner_bank_policies.sql', 'utf8');

describe('partner-bank schema migration contract', () => {
  it('registers a tenant-scoped typed table with ciphertext-only identifier columns', () => {
    const columns = partnerBankConfig.columns.map((column) => column.name);
    expect(partnerBankConfig.name).toBe('partner_bank');
    expect(columns).toContain('iban_ciphertext');
    expect(columns).toContain('local_account_number_ciphertext');
    expect(columns).not.toContain('iban');
    expect(columns).not.toContain('local_account_number');
    expect(partnerBankConfig.primaryKeys[0].columns.map((column) => column.name)).toEqual([
      'client',
      'bank_record_id',
    ]);
  });

  it('has no plaintext bank-identifier columns and requires one versioned envelope', () => {
    expect(tableMigration).toContain('"iban_ciphertext" varchar(5600)');
    expect(tableMigration).toContain('"local_account_number_ciphertext" varchar(5600)');
    expect(tableMigration).not.toMatch(/^\s*"iban"\s+varchar/im);
    expect(tableMigration).not.toMatch(/^\s*"local_account_number"\s+varchar/im);
    expect(tableMigration).toContain('partner_bank_one_account_identifier');
    expect(tableMigration).toContain('partner_bank_iban_envelope');
    expect(tableMigration).toContain('partner_bank_local_account_envelope');
    expect(tableMigration).toContain("'^cbd1[.]");
    expect(tableMigration).toMatch(/ALTER TABLE partner_bank ENABLE ROW LEVEL SECURITY/i);
    expect(tableMigration).toMatch(/ALTER TABLE partner_bank FORCE ROW LEVEL SECURITY/i);
  });

  it('uses a PostgreSQL-safe repetition pattern with a strict maximum envelope size', () => {
    expect(envelopeBoundMigration).toContain('[A-Za-z0-9_-]+');
    expect(envelopeBoundMigration).toContain('char_length(iban_ciphertext) <= 5540');
    expect(envelopeBoundMigration).toContain('char_length(local_account_number_ciphertext) <= 5540');
    expect(envelopeBoundMigration).not.toContain('{1,5462}');
    expect(envelopeBoundMigration).toMatch(/DROP CONSTRAINT partner_bank_iban_envelope[\s\S]*?ADD CONSTRAINT partner_bank_iban_envelope/i);
  });

  it('enforces tenant, partner, UUIDv4, country, date, and version boundaries', () => {
    expect(tableMigration).toMatch(/PRIMARY KEY\("client",\s*"bank_record_id"\)/i);
    expect(tableMigration).toMatch(/partner_bank_client_fk[\s\S]*?ON DELETE CASCADE/i);
    expect(tableMigration).toMatch(/partner_bank_partner_fk[\s\S]*?business_partner[\s\S]*?ON DELETE NO ACTION/i);
    expect(tableMigration).toMatch(/partner_bank_country_fk[\s\S]*?country[\s\S]*?ON DELETE NO ACTION/i);
    expect(tableMigration).toContain('partner_bank_uuidv4');
    expect(tableMigration).toContain('partner_bank_validity');
    expect(tableMigration).toContain('partner_bank_version');
    expect(tableMigration).not.toMatch(/EXCLUDE\s+USING|UNIQUE\s*\([^)]*valid_from/i);
  });

  it('forces tenant RLS and grants the app role read-only access', () => {
    expect(policyMigration).toMatch(/ALTER TABLE partner_bank ENABLE ROW LEVEL SECURITY/i);
    expect(policyMigration).toMatch(/ALTER TABLE partner_bank FORCE ROW LEVEL SECURITY/i);
    expect(policyMigration).toMatch(/CREATE POLICY partner_bank_tenant_select[\s\S]*?FOR SELECT[\s\S]*?current_setting\('cairn\.client', true\)/i);
    expect(policyMigration).toMatch(/REVOKE ALL PRIVILEGES ON TABLE partner_bank FROM cairn_app/i);
    expect(policyMigration).toMatch(/GRANT SELECT ON TABLE partner_bank TO cairn_app/i);
    expect(policyMigration).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE|TRUNCATE)/i);
  });
});
