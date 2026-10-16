/**
 * SCR-028 / FS00 stage 2 — G/L account master schema contract.
 *
 * Migration `0036` and its policies `9026` are the database; the Drizzle definitions,
 * the shared vocabulary and the screen's baseline are the code that must agree with it.
 * These assertions compare the layers against each other rather than restating the
 * migration, so a drift in any one of them fails here: the field status matrix in SQL,
 * the field list in the schema module, the vocabulary the services validate against and
 * the baseline the screen falls back to are all the same twelve fields.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_TYPES,
  FIELD_STATUSES,
  GL_ACCOUNT_FIELDS,
  GL_ACCOUNT_TYPES,
  RECONCILIATION_TYPES,
  SUPPORTED_LANGUAGE_KEYS,
  accountNumberInRange,
  deriveGlAccountType,
  deriveIsBalanceSheet,
  isBalanceSheetAccountType,
} from '@/modules/finance/gl-account-vocabulary';
import { DEFAULT_FIELD_STATUS, resolveFieldStatus } from '@/app/config/gl-accounts/fieldStatus';

const migration = readFileSync('drizzle/0036_gl_account_master_fs00.sql', 'utf8');
const policies = readFileSync('drizzle/9026_gl_account_master_policies_fs00.sql', 'utf8');
const groupSchema = readFileSync('src/modules/finance/gl-account-group-schema.ts', 'utf8');
const financeSchema = readFileSync('src/modules/finance/schema.ts', 'utf8');
const services = readFileSync('src/modules/foundation/services.ts', 'utf8');
const standardConfig = readFileSync('src/modules/foundation/standard-config.ts', 'utf8');

/** The quoted values of a `CHECK (… IN ('A', 'B'))` list, in stated order. */
function checkList(source: string, constraint: string): string[] {
  const start = source.indexOf(constraint);
  if (start === -1) throw new Error(`Constraint ${constraint} is missing from the migration.`);
  const listStart = source.indexOf('IN (', start);
  const body = source.slice(listStart, source.indexOf(')', listStart) + 1);
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

/** The quoted field keys of the Drizzle check built from a sql template. */
function drizzleFieldList(): string[] {
  const match = groupSchema.match(/\$\{t\.fieldKey\} in \(([\s\S]*?)\)/);
  if (!match) throw new Error('The field status check is missing from the Drizzle definition.');
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

describe('FS00 Account Group registry', () => {
  it('is chart-scoped, because a chart owns the length its ranges are read against', () => {
    expect(migration).toContain('CREATE TABLE gl_account_group');
    expect(migration).toContain('PRIMARY KEY (client, chart_of_accounts, account_group)');
    expect(migration).toContain('gl_account_group_client_chart_fk');
    expect(migration).toContain('REFERENCES chart_of_accounts (client, chart_of_accounts)');
  });

  it('carries the contracted field rules', () => {
    expect(migration).toContain('description varchar(50) NOT NULL');
    expect(migration).toContain('from_account_number varchar(10) NOT NULL');
    expect(migration).toContain('to_account_number varchar(10) NOT NULL');
    expect(migration).toContain("CHECK (account_group ~ '^[A-Z0-9]{4}$')");
    expect(migration).toContain('CHECK (length(btrim(description)) BETWEEN 1 AND 50)');
    expect(migration).toContain('is_active boolean NOT NULL DEFAULT true');
    expect(migration).toContain('version integer NOT NULL DEFAULT 1');
  });

  it('orders ranges right-padded, so a short bound never swallows a longer number', () => {
    expect(migration).toContain(
      "CHECK (rpad(from_account_number, 10, '0') <= rpad(to_account_number, 10, '0'))",
    );
    expect(accountNumberInRange('1000', '0010', '0099')).toBe(false);
    expect(accountNumberInRange('0050', '0010', '0099')).toBe(true);
    // A six-character account read against the ten-character bounds migration 0036 writes.
    expect(accountNumberInRange('100000', '0000000000', '9999999999')).toBe(true);
    expect(groupSchema).toContain("rpad(${t.fromAccountNumber}, 10, '0')");
  });

  it('offers the F4 an active-group index', () => {
    expect(migration).toContain(
      'ON gl_account_group (client, chart_of_accounts, is_active, account_group)',
    );
  });
});

describe('FS00 field status matrix', () => {
  it('is one row per group and field, cascading with its group', () => {
    expect(migration).toContain('CREATE TABLE gl_account_group_field_status');
    expect(migration).toContain(
      'PRIMARY KEY (client, chart_of_accounts, account_group, field_key)',
    );
    expect(migration).toContain('gl_account_group_field_status_group_fk');
    expect(migration).toContain(
      'REFERENCES gl_account_group (client, chart_of_accounts, account_group)\n    ON DELETE CASCADE',
    );
  });

  it('allows exactly the three statuses the screen renders', () => {
    expect(checkList(migration, 'gl_account_group_field_status_status')).toEqual([
      ...FIELD_STATUSES,
    ]);
  });

  it('controls the same twelve fields in SQL, in the schema module and on the screen', () => {
    expect(checkList(migration, 'gl_account_group_field_status_field')).toEqual([
      ...GL_ACCOUNT_FIELDS,
    ]);
    expect(drizzleFieldList()).toEqual([...GL_ACCOUNT_FIELDS]);
    expect(Object.keys(DEFAULT_FIELD_STATUS)).toEqual([...GL_ACCOUNT_FIELDS]);
  });

  it('leaves the identity keys and the derived flag out of the matrix', () => {
    const controlled = GL_ACCOUNT_FIELDS as readonly string[];
    const wronglyControlled = ['account_number', 'chart_of_accounts', 'account_group', 'is_balance_sheet']
      .filter((field) => controlled.includes(field));
    expect(wronglyControlled).toEqual([]);
  });

  it('falls back to the baseline where a group defines no row', () => {
    expect(resolveFieldStatus(undefined, 'name')).toBe('MANDATORY');
    expect(resolveFieldStatus({ name: 'SUPPRESS' }, 'name')).toBe('SUPPRESS');
    expect(resolveFieldStatus({ name: 'SUPPRESS' }, 'sortKey')).toBe('OPTIONAL');
  });
});

describe('FS00 group-side account master', () => {
  it('resolves to the OB13 Group CoA registry', () => {
    expect(migration).toContain('CREATE TABLE group_chart_accounts');
    expect(migration).toContain(
      'PRIMARY KEY (client, group_chart_of_accounts, group_account_number)',
    );
    expect(migration).toContain('group_chart_accounts_registry_fk');
    expect(migration).toContain(
      'REFERENCES group_chart_of_accounts (client, group_chart_of_accounts)',
    );
  });

  it('holds a number, a name and an account type, and starts empty', () => {
    expect(migration).toContain('group_account_number varchar(10) NOT NULL');
    expect(migration).toContain('name varchar(200) NOT NULL');
    expect(checkList(migration, 'group_chart_accounts_type_vocabulary')).toEqual([
      ...ACCOUNT_TYPES,
    ]);
    // Built with its foreign key but without maintenance UI, so no rows are seeded.
    expect(migration).not.toMatch(/INSERT INTO group_chart_accounts/i);
  });
});

describe('FS00 G/L account master fields', () => {
  it('adds the contracted columns with their defaults', () => {
    expect(migration).toContain('ADD COLUMN account_group varchar(4)');
    expect(migration).toContain("ADD COLUMN gl_account_type varchar(16) NOT NULL DEFAULT 'BALANCE_SHEET'");
    expect(migration).toContain('ADD COLUMN group_account_number varchar(10)');
    expect(migration).toContain("ADD COLUMN language_key varchar(2) NOT NULL DEFAULT 'EN'");
    expect(migration).toContain("ADD COLUMN sort_key varchar(3) NOT NULL DEFAULT '000'");
    expect(migration).toContain('ADD COLUMN is_blocked_posting boolean NOT NULL DEFAULT false');
    expect(migration).toContain('ADD COLUMN is_blocked_creation boolean NOT NULL DEFAULT false');
  });

  it('mirrors them in the Drizzle definition and drops the legacy single block flag', () => {
    const columns = [
      "accountGroup: varchar('account_group', { length: 4 }).notNull()",
      "glAccountType: varchar('gl_account_type', { length: 16 }).notNull().default('BALANCE_SHEET')",
      "groupAccountNumber: varchar('group_account_number', { length: 10 })",
      "languageKey: varchar('language_key', { length: 2 }).notNull().default('EN')",
      "sortKey: varchar('sort_key', { length: 3 }).notNull().default('000')",
      "isBlockedPosting: boolean('is_blocked_posting').notNull().default(false)",
      "isBlockedCreation: boolean('is_blocked_creation').notNull().default(false)",
    ];
    expect(columns.filter((column) => !financeSchema.includes(column))).toEqual([]);
    expect(financeSchema).not.toContain("boolean('is_blocked')");
    expect(migration).toContain('DROP COLUMN is_blocked');
    expect(migration).toContain('is_blocked_posting = is_blocked');
    expect(migration).toContain('is_blocked_creation = is_blocked');
  });

  it('moves the reconciliation indicator to the contracted plural vocabulary and keeps MATERIAL', () => {
    expect(migration).toContain("WHEN 'CUSTOMER' THEN 'CUSTOMERS'");
    expect(migration).toContain("WHEN 'VENDOR' THEN 'VENDORS'");
    expect(migration).toContain("WHEN 'ASSET' THEN 'ASSETS'");
    expect(checkList(migration, 'gl_account_reconciliation_vocabulary')).toEqual([
      ...RECONCILIATION_TYPES,
    ]);
    expect(RECONCILIATION_TYPES).toContain('MATERIAL');
    const vocabulary = RECONCILIATION_TYPES as readonly string[];
    expect(['CUSTOMER', 'VENDOR', 'ASSET'].filter((value) => vocabulary.includes(value))).toEqual([]);
    // An unknown value is refused before the rewrite rather than failing the new check.
    expect(migration).toContain('is not a value this migration knows how to map');
  });

  it('pins the balance-sheet flag to the statement type it is derived from', () => {
    expect(migration).toContain(
      "ADD CONSTRAINT gl_account_balance_sheet_derived\n    CHECK (is_balance_sheet = (gl_account_type = 'BALANCE_SHEET'))",
    );
    expect(migration).toContain(
      "gl_account_type = CASE\n    WHEN account_type IN ('ASSET', 'LIABILITY', 'EQUITY') THEN 'BALANCE_SHEET'",
    );
    const disagreements = ACCOUNT_TYPES.filter(
      (accountType) =>
        deriveIsBalanceSheet(deriveGlAccountType(accountType)) !==
        isBalanceSheetAccountType(accountType),
    );
    expect(disagreements).toEqual([]);
    expect(deriveGlAccountType('ASSET')).toBe('BALANCE_SHEET');
    expect(deriveGlAccountType('EXPENSE')).toBe('PL_STATEMENT');
    expect(checkList(migration, 'gl_account_gl_account_type_vocabulary')).toEqual([
      ...GL_ACCOUNT_TYPES,
    ]);
  });

  it('keeps the account number immutable and inside the chart vocabulary', () => {
    expect(migration).toContain("ADD CONSTRAINT gl_account_number_format\n    CHECK (account_number ~ '^[A-Za-z0-9]{1,10}$')");
    expect(migration).not.toMatch(/SET\s+account_number/i);
    expect(migration).not.toMatch(/DROP CONSTRAINT\s+gl_account_client_chart_of_accounts_account_number_pk/i);
    // A different number is a different account, so the key stays as it was.
    expect(financeSchema).toContain(
      'primaryKey({ columns: [t.client, t.chartOfAccounts, t.accountNumber] })',
    );
  });

  it('binds every account to a group of its own chart', () => {
    expect(migration).toContain('ALTER COLUMN account_group SET NOT NULL');
    expect(migration).toContain('gl_account_client_group_fk');
    expect(migration).toContain(
      'REFERENCES gl_account_group (client, chart_of_accounts, account_group)',
    );
    expect(migration).toContain('ON gl_account (client, chart_of_accounts, account_group)');
  });

  it('explains why the group account number has no declarative foreign key', () => {
    expect(migration).toContain('chart_of_accounts.group_chart');
    expect(migration).toMatch(/no column pair a constraint could reference/i);
    expect(financeSchema).toMatch(/the service layer validates the number against that registry/i);
  });

  it('constrains language and sort key to what the platform supports', () => {
    expect(checkList(migration, 'gl_account_language_supported')).toEqual([
      ...SUPPORTED_LANGUAGE_KEYS,
    ]);
    expect(migration).toContain("CHECK (sort_key ~ '^[A-Za-z0-9]{3}$')");
    expect(migration).toContain("CHECK (language_key ~ '^[A-Z]{2}$')");
  });
});

describe('FS00 tenant isolation for the new tables', () => {
  it('forces row-level security and grants DML only to the application role', () => {
    const tables = ['gl_account_group', 'gl_account_group_field_status', 'group_chart_accounts'];
    const expected = tables.flatMap((table) => [
      `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
      `CREATE POLICY tenant_isolation ON ${table}`,
      `REVOKE ALL ON TABLE ${table} FROM PUBLIC`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO cairn_app`,
    ]);
    expect(expected.filter((statement) => !policies.includes(statement))).toEqual([]);
    expect(policies).toContain("current_setting('cairn.client', true)");
  });
});

describe('FS00 provisioning and service guards', () => {
  it('defines an Account Group before it defines any account', () => {
    expect(standardConfig).toContain("export const STANDARD_ACCOUNT_GROUP = 'GENL'");
    expect(standardConfig).toContain('.insert(glAccountGroup)');
    expect(standardConfig).toContain("'0'.repeat(chartDefinition.accountNumberLength)");
    expect(standardConfig).toContain('accountGroup: STANDARD_ACCOUNT_GROUP');
    expect(standardConfig.indexOf('.insert(glAccountGroup)')).toBeLessThan(
      standardConfig.indexOf('.insert(glAccount)'),
    );
    // The standard package speaks the contracted plural vocabulary.
    const singular = ["reconciliation: 'CUSTOMER'", "reconciliation: 'VENDOR'", "reconciliation: 'ASSET'"];
    expect(singular.filter((value) => standardConfig.includes(value))).toEqual([]);
  });

  it('refuses a package spec whose balance-sheet label contradicts its type', () => {
    expect(standardConfig).toContain('isBalanceSheetAccountType(spec.type)');
    expect(standardConfig).toContain('the flag is derived from the G/L Account Type');
    expect(standardConfig).toContain('isBalanceSheet: deriveIsBalanceSheet(glAccountType)');
  });

  it('derives the balance-sheet flag instead of accepting it', () => {
    expect(services).toContain('isBalanceSheet: deriveIsBalanceSheet(glAccountType)');
    expect(services).not.toMatch(/isBalanceSheet:\s*input\.isBalanceSheet/);
    expect(services).toMatch(/is_balance_sheet` is not an input/);
  });

  it('validates the Account Group against the registry before storing an account', () => {
    expect(services).toContain('is not defined for Chart of Accounts');
    expect(services).toContain('is deactivated.');
    expect(services).toContain('is outside the');
    expect(services).toContain('accountNumberInRange(accountNumber, group.fromAccountNumber, group.toAccountNumber)');
  });

  it('refuses a blocked chart before it consults the group', () => {
    const blockedGuard = services.indexOf('new G/L accounts cannot be created');
    const groupGuard = services.indexOf('is not defined for Chart of Accounts');
    expect(blockedGuard).toBeGreaterThan(-1);
    expect(groupGuard).toBeGreaterThan(-1);
    expect(blockedGuard).toBeLessThan(groupGuard);
  });

  it('treats both blocks as security-relevant changes', () => {
    expect(services).toContain("'isBlockedPosting',");
    expect(services).toContain("'isBlockedCreation',");
    expect(services).not.toContain("securityRelevantFields: ['accountType', 'isBlocked'");
  });

  it('reads the reconciliation F4s from the plural vocabulary', () => {
    const supplier = readFileSync('src/modules/foundation/supplier-companies.ts', 'utf8');
    const customer = readFileSync('src/modules/foundation/customer-companies.ts', 'utf8');
    expect(supplier).toContain("eq(glAccount.reconciliationType,'VENDORS')");
    expect(supplier).toContain('eq(glAccount.isBlockedPosting,false)');
    expect(customer).toContain("eq(glAccount.reconciliationType,'CUSTOMERS')");
    expect(customer).toContain('eq(glAccount.isBlockedPosting,false)');
  });
});
