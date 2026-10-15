import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('drizzle/0033_chart_of_accounts_ob13.sql', 'utf8');
const amendment = readFileSync('drizzle/0034_group_coa_registry_ob13.sql', 'utf8');
const policies = readFileSync('drizzle/9025_group_chart_of_accounts_policies.sql', 'utf8');
const foundationSchema = readFileSync('src/modules/foundation/schema.ts', 'utf8');
const financeSchema = readFileSync('src/modules/finance/schema.ts', 'utf8');

describe('SCR-026 Chart of Accounts migration contract', () => {
  it('maps CAIRN to CA01 across current relational references and preserves immutable audit history', () => {
    for (const table of ['chart_of_accounts', 'company_code', 'gl_account', 'supplier_company_code', 'customer_company_code']) {
      expect(migration).toContain(`UPDATE ${table}`);
    }
    expect(migration).toContain("SET chart_of_accounts = 'CA01'");
    expect(migration).toContain("SET group_chart = 'CA01'");
    expect(migration).toContain('Historical append-only change documents remain under their original key CAIRN.');
    expect(migration).not.toMatch(/UPDATE\s+change_document/i);
  });

  it('enforces Char 4, description 50, language support, account length and tenant-local references', () => {
    expect(migration).toContain("CHECK (chart_of_accounts ~ '^[A-Z0-9]{4}$')");
    expect(migration).toContain('ALTER COLUMN name TYPE varchar(50)');
    expect(migration).toContain('ALTER COLUMN account_number_length SET DEFAULT 10');
    expect(migration).toContain('Preserve existing account-number lengths');
    expect(migration).not.toMatch(/UPDATE\s+chart_of_accounts\s+SET\s+account_number_length/i);
    expect(migration).toContain("CHECK (language IN ('EN'))");
    expect(migration).toContain("CHECK (account_number_length BETWEEN 1 AND 10)");
    expect(migration).toContain('company_code_client_chart_of_accounts_fk');
    expect(migration).toContain('gl_account_client_chart_of_accounts_fk');
    expect(foundationSchema).toContain("chartOfAccounts: varchar('chart_of_accounts', { length: 4 }).notNull()");
    expect(foundationSchema).toContain("name: varchar('name', { length: 50 }).notNull()");
  });

  it('stores integration and block flags without introducing automatic cost-element behavior', () => {
    expect(migration).toContain("ADD COLUMN cost_element_integration varchar(12) NOT NULL DEFAULT 'AUTOMATIC'");
    expect(migration).toContain('ADD COLUMN is_blocked boolean NOT NULL DEFAULT false');
    expect(migration).toContain("CHECK (cost_element_integration IN ('AUTOMATIC', 'MANUAL', 'NONE'))");
    expect(foundationSchema).toContain("costElementIntegration: varchar('cost_element_integration', { length: 12 }).notNull().default('AUTOMATIC')");
    expect(financeSchema).toContain("accountNumber: varchar('account_number', { length: 10 }).notNull()");
    expect(financeSchema).toContain("glAccount: varchar('gl_account', { length: 10 }).notNull()");
  });
});

describe('SCR-026 / OB13 amendment: Group CoA registry and lifecycle schema contract', () => {
  it('creates the tenant-local registry with the OB13 field rules and converts no existing data', () => {
    expect(amendment).toContain('CREATE TABLE group_chart_of_accounts');
    expect(amendment).toContain('PRIMARY KEY (client, group_chart_of_accounts)');
    expect(amendment).toContain("CHECK (group_chart_of_accounts ~ '^[A-Z0-9]{4}$')");
    expect(amendment).toContain('CHECK (length(btrim(name)) BETWEEN 1 AND 50)');
    expect(amendment).toContain("CHECK (language IN ('EN'))");
    expect(amendment).toContain("language char(2) NOT NULL DEFAULT 'EN'");
    expect(amendment).toContain('is_active boolean NOT NULL DEFAULT true');
    expect(amendment).toContain('FOREIGN KEY (client) REFERENCES client (client)');

    // An existing Group CoA reference would violate tenant-wide key reservation, so the
    // migration refuses instead of rewriting accounting structure or copying charts.
    expect(amendment).toContain('WHERE group_chart IS NOT NULL');
    expect(amendment).toContain('must be re-keyed to registry-only codes before this migration runs');
    expect(amendment).not.toMatch(/UPDATE\s+chart_of_accounts\s+SET\s+group_chart/i);
    expect(amendment).not.toMatch(/INSERT INTO group_chart_of_accounts/i);
    expect(amendment).not.toMatch(/DROP TABLE/i);
    expect(amendment).not.toMatch(/DELETE FROM/i);
  });

  it('re-points Group CoA at the registry and reserves keys across both registries', () => {
    expect(amendment).toContain('DROP CONSTRAINT chart_of_accounts_client_group_chart_fk');
    expect(amendment).toContain('REFERENCES group_chart_of_accounts (client, group_chart_of_accounts)');
    expect(amendment).toContain('CREATE FUNCTION coa_key_registry_exclusive()');
    expect(amendment).toContain('BEFORE INSERT OR UPDATE OF client, chart_of_accounts ON chart_of_accounts');
    expect(amendment).toContain('BEFORE INSERT OR UPDATE OF client, group_chart_of_accounts ON group_chart_of_accounts');
    expect(amendment).toContain("USING ERRCODE = 'unique_violation'");
    // Least privilege: the runtime role may fire the trigger, nobody else may call it.
    expect(amendment).toContain('REVOKE ALL PRIVILEGES ON FUNCTION public.coa_key_registry_exclusive() FROM PUBLIC');
    expect(amendment).toContain('GRANT EXECUTE ON FUNCTION public.coa_key_registry_exclusive() TO cairn_app');
    expect(foundationSchema).toContain("export const groupChartOfAccounts = pgTable(\n  'group_chart_of_accounts',");
    expect(foundationSchema).toContain('foreignColumns: [groupChartOfAccounts.client, groupChartOfAccounts.groupChartOfAccounts]');
  });

  it('keeps lifecycle state in place: no delete path, retained rows and forced tenant isolation', () => {
    expect(amendment).not.toMatch(/is_active boolean NOT NULL DEFAULT false/i);
    expect(policies).toContain('ALTER TABLE group_chart_of_accounts ENABLE ROW LEVEL SECURITY');
    expect(policies).toContain('ALTER TABLE group_chart_of_accounts FORCE ROW LEVEL SECURITY');
    expect(policies).toContain("USING (client = current_setting('cairn.client', true))");
    expect(policies).toContain("WITH CHECK (client = current_setting('cairn.client', true))");
    expect(policies).toContain('REVOKE ALL ON TABLE group_chart_of_accounts FROM PUBLIC');
    expect(policies).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON group_chart_of_accounts TO cairn_app');
    expect(policies).not.toMatch(/GRANT[^;]*(TRUNCATE|REFERENCES|TRIGGER)[^;]*TO cairn_app/i);
  });
});
