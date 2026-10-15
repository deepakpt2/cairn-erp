import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('drizzle/0033_chart_of_accounts_ob13.sql', 'utf8');
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
