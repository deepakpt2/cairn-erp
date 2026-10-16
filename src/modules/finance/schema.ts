/**
 * Finance — journal entry and GL accounts
 * CAIRN.md §14.1 (universal journal), §8.8
 *
 * The M1a slice of the finance module: enough to prove the posting engine's
 * invariants end to end. Account determination, subledgers, assets, banking and
 * closing arrive in M1b–M1e and extend these tables rather than replacing them.
 */
import {
  pgTable,
  varchar,
  char,
  text,
  integer,
  boolean,
  timestamp,
  date,
  numeric,
  primaryKey,
  uniqueIndex,
  index,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { auditColumns, client } from '../../platform/tables/tenancy';
import { chartOfAccounts } from '../foundation/schema';
import { glAccountGroup } from './gl-account-group-schema';

/** Chart-of-accounts level account definition, plus the company-code segment (§8.2). */
export const glAccount = pgTable(
  'gl_account',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    chartOfAccounts: varchar('chart_of_accounts', { length: 4 }).notNull(),
    accountNumber: varchar('account_number', { length: 10 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    /** ASSET | LIABILITY | EQUITY | REVENUE | EXPENSE — drives statement placement. */
    accountType: varchar('account_type', { length: 16 }).notNull(),
    /** Account Group: owns the number range and the field status matrix. */
    accountGroup: varchar('account_group', { length: 4 }).notNull(),
    /** G/L Account Type: balance sheet accounts carry forward, P/L accounts close. */
    glAccountType: varchar('gl_account_type', { length: 16 }).notNull().default('BALANCE_SHEET'),
    /**
     * Derived from `glAccountType` and pinned by a check, so the stored flag can never
     * drift from the indicator the screen shows (FS00 contract: computed, not entered).
     */
    isBalanceSheet: boolean('is_balance_sheet').notNull(),
    /** Open item management: items stay open until explicitly cleared (§14.2). */
    isOpenItemManaged: boolean('is_open_item_managed').notNull().default(false),
    /** Reconciliation account: CUSTOMERS | VENDORS | ASSETS | MATERIAL — §14.2. */
    reconciliationType: varchar('reconciliation_type', { length: 16 }),
    /** Whether postings to this account require a cost object. */
    requiresCostObject: boolean('requires_cost_object').notNull().default(false),
    /** Tax-relevant accounts participate in tax determination. */
    isTaxRelevant: boolean('is_tax_relevant').notNull().default(false),
    /**
     * Optional group-side account for consolidation roll-up. No declarative foreign key:
     * the group chart is resolved through `chart_of_accounts.group_chart` rather than
     * stored here, so the service layer validates the number against that registry.
     */
    groupAccountNumber: varchar('group_account_number', { length: 10 }),
    /** Language Key. */
    languageKey: varchar('language_key', { length: 2 }).notNull().default('EN'),
    /** Sort Key — three-character line item sort assignment. */
    sortKey: varchar('sort_key', { length: 3 }).notNull().default('000'),
    /** Posting block: the account exists but may not be posted to. */
    isBlockedPosting: boolean('is_blocked_posting').notNull().default(false),
    /** Creation block: the master record may not be created. */
    isBlockedCreation: boolean('is_blocked_creation').notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.chartOfAccounts, t.accountNumber] }),
    index('gl_account_type_idx').on(t.client, t.accountType),
    index('gl_account_group_idx').on(t.client, t.chartOfAccounts, t.accountGroup),
    foreignKey({
      name: 'gl_account_client_chart_of_accounts_fk',
      columns: [t.client, t.chartOfAccounts],
      foreignColumns: [chartOfAccounts.client, chartOfAccounts.chartOfAccounts],
    }),
    foreignKey({
      name: 'gl_account_client_group_fk',
      columns: [t.client, t.chartOfAccounts, t.accountGroup],
      foreignColumns: [
        glAccountGroup.client,
        glAccountGroup.chartOfAccounts,
        glAccountGroup.accountGroup,
      ],
    }),
    check('gl_account_number_format', sql`${t.accountNumber} ~ '^[A-Za-z0-9]{1,10}$'`),
    check(
      'gl_account_type_vocabulary',
      sql`${t.accountType} in ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')`,
    ),
    check(
      'gl_account_gl_account_type_vocabulary',
      sql`${t.glAccountType} in ('BALANCE_SHEET', 'PL_STATEMENT')`,
    ),
    check(
      'gl_account_reconciliation_vocabulary',
      sql`${t.reconciliationType} is null or ${t.reconciliationType} in ('CUSTOMERS', 'VENDORS', 'ASSETS', 'MATERIAL')`,
    ),
    check(
      'gl_account_balance_sheet_derived',
      sql`${t.isBalanceSheet} = (${t.glAccountType} = 'BALANCE_SHEET')`,
    ),
    check('gl_account_language_format', sql`${t.languageKey} ~ '^[A-Z]{2}$'`),
    check('gl_account_language_supported', sql`${t.languageKey} in ('EN')`),
    check('gl_account_sort_key_format', sql`${t.sortKey} ~ '^[A-Za-z0-9]{3}$'`),
  ],
);

/** Accounting document header. One per posting, never deleted — only reversed (D-017). */
export const journalEntry = pgTable(
  'journal_entry',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    documentNumber: varchar('document_number', { length: 40 }).notNull(),
    /** Presentation is separate from the immutable company/year/number identity. */
    displayNumber: varchar('display_number', { length: 40 }).notNull().default(''),
    fiscalYear: integer('fiscal_year').notNull(),
    documentType: varchar('document_type', { length: 12 }).notNull(),
    companyCode: varchar('company_code', { length: 10 }).notNull(),
    documentDate: date('document_date').notNull(),
    postingDate: date('posting_date').notNull(),
    postingPeriod: integer('posting_period').notNull(),
    /** Document currency and the local currency of the company code. */
    documentCurrency: char('document_currency', { length: 3 }).notNull(),
    localCurrency: char('local_currency', { length: 3 }).notNull(),
    /** Stored on the document so it is self-contained and reproducible (§14.4). */
    exchangeRate: numeric('exchange_rate', { precision: 18, scale: 8 }).notNull().default('1'),
    reference: varchar('reference', { length: 60 }),
    headerText: text('header_text'),
    /** POSTED | PARKED | REVERSED */
    status: varchar('status', { length: 16 }).notNull().default('POSTED'),
    /** Reversal chain — the original is never touched except for this link. */
    reversalOf: varchar('reversal_of', { length: 40 }),
    reversedBy: varchar('reversed_by', { length: 40 }),
    reversalReason: text('reversal_reason'),
    /** Source document that caused this posting, e.g. a material document. */
    originClass: varchar('origin_class', { length: 48 }),
    originKey: varchar('origin_key', { length: 120 }),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [
    // The primary key IS the document identity — no separate unique index needed.
    primaryKey({ columns: [t.client, t.documentNumber, t.fiscalYear] }),
    index('journal_entry_company_date_idx').on(t.client, t.companyCode, t.postingDate),
    index('journal_entry_origin_idx').on(t.client, t.originClass, t.originKey),
  ],
);

/**
 * Accounting document line. Carries the full set of account assignments so one
 * table answers GL, cost centre, profit centre and subledger questions (§14.1).
 */
export const journalEntryLine = pgTable(
  'journal_entry_line',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    documentNumber: varchar('document_number', { length: 40 }).notNull(),
    fiscalYear: integer('fiscal_year').notNull(),
    lineNumber: integer('line_number').notNull(),
    glAccount: varchar('gl_account', { length: 10 }).notNull(),
    companyCode: varchar('company_code', { length: 10 }).notNull(),
    /** S = debit, H = credit. Stored explicitly rather than as a sign. */
    debitCredit: char('debit_credit', { length: 1 }).notNull(),
    /** Always positive; the direction lives in debitCredit. */
    amountLocal: numeric('amount_local', { precision: 23, scale: 4 }).notNull(),
    amountDocument: numeric('amount_document', { precision: 23, scale: 4 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    /** Account assignments — the reason one unified table beats many (§14.1). */
    costCenter: varchar('cost_center', { length: 20 }),
    profitCenter: varchar('profit_center', { length: 20 }),
    internalOrder: varchar('internal_order', { length: 20 }),
    productionOrder: varchar('production_order', { length: 24 }),
    businessPartner: varchar('business_partner', { length: 20 }),
    material: varchar('material', { length: 40 }),
    plant: varchar('plant', { length: 10 }),
    taxCode: varchar('tax_code', { length: 4 }),
    lineText: text('line_text'),
    /** Clearing state for open item management. */
    clearingDocument: varchar('clearing_document', { length: 40 }),
    clearingDate: date('clearing_date'),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.client, t.documentNumber, t.fiscalYear, t.lineNumber] }),
    index('jel_account_idx').on(t.client, t.glAccount, t.fiscalYear),
    index('jel_costcenter_idx').on(t.client, t.costCenter),
    index('jel_clearing_idx').on(t.client, t.clearingDocument),
  ],
);
