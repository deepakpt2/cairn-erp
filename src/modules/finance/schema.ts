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
import { chartOfAccounts, companyCode as foundationCompanyCode, creditControlArea, fiscalYearVariant } from '../foundation/schema';
import { businessPartner } from '../foundation/business-partner-schema';
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
    index('journal_entry_company_posting_idx').on(t.client, t.companyCode, t.postingDate, t.documentNumber),
    index('journal_entry_origin_idx').on(t.client, t.originClass, t.originKey),
    index('journal_entry_company_year_period_idx').on(t.client, t.companyCode, t.fiscalYear, t.postingPeriod),
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
    /** Line assignment (SCR-096): matching and reporting reference, at most 18 characters. */
    assignment: varchar('assignment', { length: 18 }),
    /** Tax return stamp (SCR-097): the update run that reported this tax line, if any. */
    taxReturnRunId: varchar('tax_return_run_id', { length: 24 }),
    lineText: text('line_text'),
    /** Clearing state for open item management. */
    clearingDocument: varchar('clearing_document', { length: 40 }),
    clearingDate: date('clearing_date'),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.client, t.documentNumber, t.fiscalYear, t.lineNumber] }),
    check('journal_entry_line_dc_ck', sql`${t.debitCredit} in ('S', 'H')`),
    check('journal_entry_line_amount_ck', sql`${t.amountDocument} > 0 and ${t.amountLocal} > 0`),
    index('jel_account_idx').on(t.client, t.glAccount, t.fiscalYear),
    index('jel_company_account_idx').on(t.client, t.companyCode, t.glAccount, t.fiscalYear, t.documentNumber, t.lineNumber),
    index('jel_costcenter_idx').on(t.client, t.costCenter),
    index('jel_profitcenter_idx').on(t.client, t.profitCenter, t.fiscalYear, t.companyCode),
    index('jel_clearing_idx').on(t.client, t.clearingDocument),
    index('journal_entry_line_partner_open_idx').on(t.client, t.businessPartner, t.clearingDocument),
    index('journal_entry_line_tax_report_idx').on(t.client, t.taxCode, t.taxReturnRunId),
  ],
);

/**
 * Direct-posting request registry (SCR-096 / R-144): one row per
 * accepted FB50 submission key, naming the document it produced.
 * Idempotency bookkeeping only — never a document store.
 */
export const journalPostingRequest = pgTable('journal_posting_request', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  requestKey: varchar('request_key', { length: 64 }).notNull(),
  actor: varchar('actor', { length: 60 }).notNull(),
  documentNumber: varchar('document_number', { length: 40 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.requestKey] }),
]);

/**
 * Tax return execution log (SCR-097 / R-145): one row per advance
 * return execution, test runs included — the audit trail. Update
 * runs additionally stamp the journal lines they report.
 */
export const taxReturnRun = pgTable('tax_return_run', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  runId: varchar('run_id', { length: 24 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  taxGroup: varchar('tax_group', { length: 10 }),
  postingDateFrom: date('posting_date_from', { mode: 'string' }).notNull(),
  postingDateTo: date('posting_date_to', { mode: 'string' }).notNull(),
  taxReturnCountry: char('tax_return_country', { length: 2 }).notNull(),
  isTestRun: boolean('is_test_run').notNull().default(true),
  doNotUpdateDocuments: boolean('do_not_update_documents').notNull().default(false),
  isCorrectedReturn: boolean('is_corrected_return').notNull().default(false),
  electronicReturn: boolean('electronic_return').notNull().default(false),
  clearingAccount: varchar('clearing_account', { length: 10 }),
  totalTaxBase: numeric('total_tax_base', { precision: 23, scale: 4 }).notNull().default('0'),
  totalInputTax: numeric('total_input_tax', { precision: 23, scale: 4 }).notNull().default('0'),
  totalOutputTax: numeric('total_output_tax', { precision: 23, scale: 4 }).notNull().default('0'),
  netTax: numeric('net_tax', { precision: 23, scale: 4 }).notNull().default('0'),
  currency: char('currency', { length: 3 }).notNull(),
  transferDocumentNumber: varchar('transfer_document_number', { length: 40 }),
  linesReported: integer('lines_reported').notNull().default(0),
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.runId] }),
  index('tax_return_run_company_idx').on(t.client, t.companyCode, t.postingDateFrom),
]);

/**
 * FX valuation run and item protocol (SCR-098 / R-146): the audit
 * record of every valuation execution with the exact rates used.
 */
export const fxValuationRun = pgTable('fx_valuation_run', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  runId: varchar('run_id', { length: 24 }).notNull(),
  requestKey: varchar('request_key', { length: 64 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  valuationArea: varchar('valuation_area', { length: 6 }).notNull(),
  valuationKeyDate: date('valuation_key_date', { mode: 'string' }).notNull(),
  postingDate: date('posting_date', { mode: 'string' }).notNull(),
  reversalDate: date('reversal_date', { mode: 'string' }),
  valuationMethod: varchar('valuation_method', { length: 12 }).notNull(),
  documentType: varchar('document_type', { length: 12 }).notNull(),
  isTestRun: boolean('is_test_run').notNull().default(true),
  includeOpenItems: boolean('include_open_items').notNull().default(true),
  includeBalances: boolean('include_balances').notNull().default(true),
  status: varchar('status', { length: 12 }).notNull().default('TEST'),
  totalGainAmount: numeric('total_gain_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  totalLossAmount: numeric('total_loss_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  postingDocumentNumber: varchar('posting_document_number', { length: 40 }),
  reversalDocumentNumber: varchar('reversal_document_number', { length: 40 }),
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.client, t.runId] }),
  uniqueIndex('fx_valuation_run_request_uq').on(t.client, t.requestKey),
  check('fx_valuation_run_status_ck', sql`${t.status} in ('TEST', 'COMPLETED', 'REVERSED')`),
]);

export const fxValuationItem = pgTable('fx_valuation_item', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  runId: varchar('run_id', { length: 24 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  valuationArea: varchar('valuation_area', { length: 6 }).notNull(),
  itemNumber: integer('item_number').notNull(),
  sourceKind: varchar('source_kind', { length: 12 }).notNull(),
  accountNumber: varchar('account_number', { length: 10 }).notNull(),
  sourceDocument: varchar('source_document', { length: 40 }),
  sourceLine: integer('source_line'),
  currency: char('currency', { length: 3 }).notNull(),
  foreignAmount: numeric('foreign_amount', { precision: 23, scale: 4 }).notNull(),
  carryingAmount: numeric('carrying_amount', { precision: 23, scale: 4 }).notNull(),
  valuationRate: numeric('valuation_rate', { precision: 18, scale: 8 }),
  rateType: varchar('rate_type', { length: 12 }).notNull(),
  requiredAmount: numeric('required_amount', { precision: 23, scale: 4 }),
  adjustmentAmount: numeric('adjustment_amount', { precision: 23, scale: 4 }),
  classification: varchar('classification', { length: 8 }),
  postingDocument: varchar('posting_document', { length: 40 }),
  status: varchar('status', { length: 12 }).notNull(),
  error: text('error'),
}, (t) => [
  primaryKey({ columns: [t.client, t.runId, t.itemNumber] }),
  foreignKey({
    columns: [t.client, t.runId],
    foreignColumns: [fxValuationRun.client, fxValuationRun.runId],
  }).onDelete('cascade'),
  index('fx_valuation_item_source_idx').on(t.client, t.companyCode, t.valuationArea, t.sourceDocument, t.sourceLine, t.status),
  check('fx_valuation_item_kind_ck', sql`${t.sourceKind} in ('OPEN_ITEM', 'BALANCE')`),
  check('fx_valuation_item_class_ck', sql`${t.classification} is null or ${t.classification} in ('GAIN', 'LOSS', 'NONE')`),
  check('fx_valuation_item_status_ck', sql`${t.status} in ('CALCULATED', 'POSTED', 'SKIPPED', 'ERROR')`),
]);

/**
 * GR/IR reclassification run and item protocol (SCR-099 / R-147).
 */
export const grirReclassRun = pgTable('grir_reclass_run', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  runId: varchar('run_id', { length: 24 }).notNull(),
  requestKey: varchar('request_key', { length: 64 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  keyDate: date('key_date', { mode: 'string' }).notNull(),
  postingDate: date('posting_date', { mode: 'string' }),
  reversalDate: date('reversal_date', { mode: 'string' }),
  isTestRun: boolean('is_test_run').notNull().default(true),
  createAccruals: boolean('create_accruals').notNull().default(false),
  status: varchar('status', { length: 12 }).notNull().default('TEST'),
  totalAccrualAmount: numeric('total_accrual_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  accrualDocumentNumber: varchar('accrual_document_number', { length: 40 }),
  reversalDocumentNumber: varchar('reversal_document_number', { length: 40 }),
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.client, t.runId] }),
  uniqueIndex('grir_reclass_run_request_uq').on(t.client, t.requestKey),
  check('grir_reclass_run_status_ck', sql`${t.status} in ('TEST', 'COMPLETED', 'REVERSED')`),
]);

export const grirReclassItem = pgTable('grir_reclass_item', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  runId: varchar('run_id', { length: 24 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  itemNumber: integer('item_number').notNull(),
  purchaseOrder: varchar('purchase_order', { length: 20 }).notNull(),
  purchaseOrderItem: integer('purchase_order_item').notNull(),
  vendor: varchar('vendor', { length: 40 }).notNull(),
  material: varchar('material', { length: 40 }),
  plant: varchar('plant', { length: 10 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  orderedQuantity: numeric('ordered_quantity', { precision: 13, scale: 3 }).notNull(),
  receivedQuantity: numeric('received_quantity', { precision: 13, scale: 3 }).notNull(),
  invoicedQuantity: numeric('invoiced_quantity', { precision: 13, scale: 3 }).notNull(),
  openQuantity: numeric('open_quantity', { precision: 13, scale: 3 }).notNull(),
  receivedValue: numeric('received_value', { precision: 23, scale: 4 }).notNull(),
  invoicedValue: numeric('invoiced_value', { precision: 23, scale: 4 }).notNull(),
  openValue: numeric('open_value', { precision: 23, scale: 4 }).notNull(),
  classification: varchar('classification', { length: 28 }).notNull(),
  accrualAmount: numeric('accrual_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  accrualDocument: varchar('accrual_document', { length: 40 }),
  status: varchar('status', { length: 12 }).notNull(),
  error: text('error'),
}, (t) => [
  primaryKey({ columns: [t.client, t.runId, t.itemNumber] }),
  foreignKey({
    columns: [t.client, t.runId],
    foreignColumns: [grirReclassRun.client, grirReclassRun.runId],
  }).onDelete('cascade'),
  index('grir_reclass_item_po_idx').on(t.client, t.companyCode, t.purchaseOrder, t.purchaseOrderItem, t.status),
  check('grir_reclass_item_class_ck', sql`${t.classification} in ('RECONCILED', 'GOODS_RECEIVED_NOT_INVOICED', 'INVOICED_NOT_RECEIVED', 'QUANTITY_DIFFERENCE', 'VALUE_DIFFERENCE')`),
  check('grir_reclass_item_status_ck', sql`${t.status} in ('ANALYZED', 'ACCRUED', 'SKIPPED', 'ERROR')`),
]);

/**
 * Accrual/deferral metadata (SCR-100 / R-148): the reversal data
 * of a canonical journal document, keyed by its identity. The
 * ledger itself stays in journal_entry / journal_entry_line.
 */
export const accrualDocument = pgTable('accrual_document', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  documentNumber: varchar('document_number', { length: 40 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  reversalDate: date('reversal_date', { mode: 'string' }).notNull(),
  reversalReason: varchar('reversal_reason', { length: 2 }).notNull(),
  reversalStatus: varchar('reversal_status', { length: 12 }).notNull().default('PENDING'),
  reversalDocumentNumber: varchar('reversal_document_number', { length: 40 }),
  reversalFiscalYear: integer('reversal_fiscal_year'),
  reversedAt: timestamp('reversed_at', { withTimezone: true }),
  reversedBy: varchar('reversed_by', { length: 60 }),
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.companyCode, t.documentNumber, t.fiscalYear] }),
  foreignKey({
    columns: [t.client, t.documentNumber, t.fiscalYear],
    foreignColumns: [journalEntry.client, journalEntry.documentNumber, journalEntry.fiscalYear],
  }).onDelete('cascade'),
  index('accrual_document_due_idx').on(t.client, t.companyCode, t.reversalStatus, t.reversalDate),
  check('accrual_document_status_ck', sql`${t.reversalStatus} in ('PENDING', 'REVERSED')`),
  check('accrual_document_reversed_ck', sql`(${t.reversalStatus} = 'REVERSED') = (${t.reversalDocumentNumber} is not null and ${t.reversedAt} is not null and ${t.reversedBy} is not null)`),
]);

/**
 * Period-end close cockpit (SCR-101 / R-149): reusable task
 * templates, period-specific task lists and instances, dependency
 * edges, an append-only execution log and event trail.
 */
export const closingTaskTemplate = pgTable('closing_task_template', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  templateCode: varchar('template_code', { length: 30 }).notNull(),
  taskId: varchar('task_id', { length: 30 }).notNull(),
  taskName: varchar('task_name', { length: 80 }).notNull(),
  parentTaskId: varchar('parent_task_id', { length: 30 }),
  sequence: integer('sequence').notNull().default(0),
  handlerCode: varchar('handler_code', { length: 40 }).notNull(),
  owner: varchar('owner', { length: 12 }),
  criticalPath: boolean('critical_path').notNull().default(false),
  requiresEvidence: boolean('requires_evidence').notNull().default(false),
  requiresSignoff: boolean('requires_signoff').notNull().default(false),
  parameters: text('parameters'),
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: varchar('updated_by', { length: 60 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.client, t.templateCode, t.taskId] }),
  foreignKey({
    columns: [t.client, t.templateCode, t.parentTaskId],
    foreignColumns: [t.client, t.templateCode, t.taskId],
  }).onDelete('cascade'),
  check('closing_task_template_handler_ck', sql`${t.handlerCode} in ('PERIOD_STATUS', 'ACCRUAL_REVERSALS', 'FX_VALUATION', 'MANUAL_CONFIRMATION')`),
  check('closing_task_template_parent_ck', sql`${t.parentTaskId} is null or ${t.parentTaskId} <> ${t.taskId}`),
]);

export const closingTaskTemplateDependency = pgTable('closing_task_template_dependency', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  templateCode: varchar('template_code', { length: 30 }).notNull(),
  taskId: varchar('task_id', { length: 30 }).notNull(),
  predecessorTaskId: varchar('predecessor_task_id', { length: 30 }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.client, t.templateCode, t.taskId, t.predecessorTaskId] }),
  foreignKey({
    columns: [t.client, t.templateCode, t.taskId],
    foreignColumns: [closingTaskTemplate.client, closingTaskTemplate.templateCode, closingTaskTemplate.taskId],
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.client, t.templateCode, t.predecessorTaskId],
    foreignColumns: [closingTaskTemplate.client, closingTaskTemplate.templateCode, closingTaskTemplate.taskId],
  }).onDelete('cascade'),
  check('closing_task_template_dep_self_ck', sql`${t.taskId} <> ${t.predecessorTaskId}`),
]);

export const closingTaskList = pgTable('closing_task_list', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  taskListId: varchar('task_list_id', { length: 30 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  postingPeriod: integer('posting_period').notNull(),
  description: varchar('description', { length: 80 }),
  status: varchar('status', { length: 12 }).notNull().default('INITIAL'),
  templateCode: varchar('template_code', { length: 30 }),
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: varchar('updated_by', { length: 60 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.client, t.companyCode, t.taskListId, t.fiscalYear, t.postingPeriod] }),
  check('closing_task_list_status_ck', sql`${t.status} in ('INITIAL', 'RELEASED', 'FINALIZED')`),
  check('closing_task_list_period_ck', sql`${t.postingPeriod} between 1 and 16`),
]);

export const closingTaskInstance = pgTable('closing_task_instance', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  taskListId: varchar('task_list_id', { length: 30 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  postingPeriod: integer('posting_period').notNull(),
  taskId: varchar('task_id', { length: 30 }).notNull(),
  taskName: varchar('task_name', { length: 80 }).notNull(),
  parentTaskId: varchar('parent_task_id', { length: 30 }),
  sequence: integer('sequence').notNull().default(0),
  handlerCode: varchar('handler_code', { length: 40 }).notNull(),
  owner: varchar('owner', { length: 12 }),
  status: varchar('status', { length: 12 }).notNull().default('INITIAL'),
  criticalPath: boolean('critical_path').notNull().default(false),
  requiresEvidence: boolean('requires_evidence').notNull().default(false),
  requiresSignoff: boolean('requires_signoff').notNull().default(false),
  parameters: text('parameters'),
  evidenceRef: varchar('evidence_ref', { length: 120 }),
  signedOffBy: varchar('signed_off_by', { length: 60 }),
  signedOffAt: timestamp('signed_off_at', { withTimezone: true }),
  dueDate: date('due_date', { mode: 'string' }),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastExecutedAt: timestamp('last_executed_at', { withTimezone: true }),
  lastExecutionId: varchar('last_execution_id', { length: 24 }),
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: varchar('updated_by', { length: 60 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.client, t.companyCode, t.taskListId, t.fiscalYear, t.postingPeriod, t.taskId] }),
  foreignKey({
    columns: [t.client, t.companyCode, t.taskListId, t.fiscalYear, t.postingPeriod],
    foreignColumns: [closingTaskList.client, closingTaskList.companyCode, closingTaskList.taskListId, closingTaskList.fiscalYear, closingTaskList.postingPeriod],
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.client, t.companyCode, t.taskListId, t.fiscalYear, t.postingPeriod, t.parentTaskId],
    foreignColumns: [t.client, t.companyCode, t.taskListId, t.fiscalYear, t.postingPeriod, t.taskId],
  }).onDelete('cascade'),
  check('closing_task_instance_handler_ck', sql`${t.handlerCode} in ('PERIOD_STATUS', 'ACCRUAL_REVERSALS', 'FX_VALUATION', 'MANUAL_CONFIRMATION')`),
  check('closing_task_instance_status_ck', sql`${t.status} in ('INITIAL', 'RELEASED', 'RUNNING', 'COMPLETED', 'ERROR', 'BLOCKED')`),
  check('closing_task_instance_parent_ck', sql`${t.parentTaskId} is null or ${t.parentTaskId} <> ${t.taskId}`),
]);

export const closingTaskDependency = pgTable('closing_task_dependency', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  taskListId: varchar('task_list_id', { length: 30 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  postingPeriod: integer('posting_period').notNull(),
  taskId: varchar('task_id', { length: 30 }).notNull(),
  predecessorTaskId: varchar('predecessor_task_id', { length: 30 }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.client, t.companyCode, t.taskListId, t.fiscalYear, t.postingPeriod, t.taskId, t.predecessorTaskId] }),
  foreignKey({
    columns: [t.client, t.companyCode, t.taskListId, t.fiscalYear, t.postingPeriod, t.taskId],
    foreignColumns: [closingTaskInstance.client, closingTaskInstance.companyCode, closingTaskInstance.taskListId, closingTaskInstance.fiscalYear, closingTaskInstance.postingPeriod, closingTaskInstance.taskId],
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.client, t.companyCode, t.taskListId, t.fiscalYear, t.postingPeriod, t.predecessorTaskId],
    foreignColumns: [closingTaskInstance.client, closingTaskInstance.companyCode, closingTaskInstance.taskListId, closingTaskInstance.fiscalYear, closingTaskInstance.postingPeriod, closingTaskInstance.taskId],
  }).onDelete('cascade'),
  check('closing_task_dep_self_ck', sql`${t.taskId} <> ${t.predecessorTaskId}`),
]);

export const closingExecutionLog = pgTable('closing_execution_log', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  executionId: varchar('execution_id', { length: 24 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  taskListId: varchar('task_list_id', { length: 30 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  postingPeriod: integer('posting_period').notNull(),
  taskId: varchar('task_id', { length: 30 }).notNull(),
  attempt: integer('attempt').notNull(),
  mode: varchar('mode', { length: 12 }).notNull(),
  status: varchar('status', { length: 12 }).notNull(),
  initiatedBy: varchar('initiated_by', { length: 60 }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  resultSummary: varchar('result_summary', { length: 240 }),
  errorDetails: text('error_details'),
  generatedDocumentNumber: varchar('generated_document_number', { length: 40 }),
  generatedFiscalYear: integer('generated_fiscal_year'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.executionId] }),
  foreignKey({
    columns: [t.client, t.companyCode, t.taskListId, t.fiscalYear, t.postingPeriod, t.taskId],
    foreignColumns: [closingTaskInstance.client, closingTaskInstance.companyCode, closingTaskInstance.taskListId, closingTaskInstance.fiscalYear, closingTaskInstance.postingPeriod, closingTaskInstance.taskId],
  }).onDelete('cascade'),
  index('closing_execution_log_task_idx').on(t.client, t.companyCode, t.taskListId, t.fiscalYear, t.postingPeriod, t.taskId, t.createdAt),
  check('closing_execution_log_mode_ck', sql`${t.mode} in ('FOREGROUND', 'BACKGROUND')`),
  check('closing_execution_log_status_ck', sql`${t.status} in ('SCHEDULED', 'RUNNING', 'SUCCEEDED', 'FAILED')`),
]);

export const closingTaskEvent = pgTable('closing_task_event', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  eventId: varchar('event_id', { length: 24 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  taskListId: varchar('task_list_id', { length: 30 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  postingPeriod: integer('posting_period').notNull(),
  taskId: varchar('task_id', { length: 30 }),
  eventType: varchar('event_type', { length: 20 }).notNull(),
  actor: varchar('actor', { length: 60 }).notNull(),
  reason: varchar('reason', { length: 240 }),
  detail: varchar('detail', { length: 240 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.eventId] }),
  foreignKey({
    columns: [t.client, t.companyCode, t.taskListId, t.fiscalYear, t.postingPeriod],
    foreignColumns: [closingTaskList.client, closingTaskList.companyCode, closingTaskList.taskListId, closingTaskList.fiscalYear, closingTaskList.postingPeriod],
  }).onDelete('cascade'),
  check('closing_task_event_type_ck', sql`${t.eventType} in ('CREATED', 'RELEASED', 'EXECUTED', 'RETRIED', 'OVERRIDE', 'SIGNOFF', 'EVIDENCE', 'FINALIZED', 'REOPENED')`),
]);


/**
 * Balance carryforward protocol (SCR-102 / R-150): one row per
 * execution (test runs included, repeats allowed) and the
 * per-account result protocol. Openings themselves derive from
 * the posted journal; no balance-summary table exists.
 */
export const carryforwardRun = pgTable('carryforward_run', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  runId: varchar('run_id', { length: 24 }).notNull(),
  ledger: varchar('ledger', { length: 2 }).notNull(),
  sourceFiscalYear: integer('source_fiscal_year').notNull(),
  targetFiscalYear: integer('target_fiscal_year').notNull(),
  companyCodes: varchar('company_codes', { length: 240 }).notNull(),
  isTestRun: boolean('is_test_run').notNull().default(true),
  status: varchar('status', { length: 12 }).notNull().default('RUNNING'),
  accountsProcessed: integer('accounts_processed').notNull().default(0),
  carriedAmount: numeric('carried_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  plTransferAmount: numeric('pl_transfer_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  errorCount: integer('error_count').notNull().default(0),
  transferDocuments: varchar('transfer_documents', { length: 480 }),
  executedBy: varchar('executed_by', { length: 60 }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.client, t.runId] }),
  index('carryforward_run_scope_idx').on(t.client, t.ledger, t.targetFiscalYear, t.status, t.startedAt),
  check('carryforward_run_status_ck', sql`${t.status} in ('RUNNING', 'COMPLETED', 'FAILED')`),
  check('carryforward_run_years_ck', sql`${t.targetFiscalYear} = ${t.sourceFiscalYear} + 1`),
]);

export const carryforwardResult = pgTable('carryforward_result', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  runId: varchar('run_id', { length: 24 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  accountNumber: varchar('account_number', { length: 10 }).notNull(),
  accountCategory: varchar('account_category', { length: 16 }).notNull(),
  profitCenter: varchar('profit_center', { length: 20 }).notNull().default(''),
  currency: char('currency', { length: 3 }).notNull(),
  sourceClosingBalance: numeric('source_closing_balance', { precision: 23, scale: 4 }).notNull(),
  targetOpeningBalance: numeric('target_opening_balance', { precision: 23, scale: 4 }).notNull(),
  retainedEarningsAccount: varchar('retained_earnings_account', { length: 10 }),
  transferDocumentNumber: varchar('transfer_document_number', { length: 40 }),
  status: varchar('status', { length: 12 }).notNull(),
  detail: varchar('detail', { length: 240 }),
}, (t) => [
  primaryKey({ columns: [t.client, t.runId, t.companyCode, t.accountNumber, t.profitCenter, t.currency] }),
  foreignKey({
    columns: [t.client, t.runId],
    foreignColumns: [carryforwardRun.client, carryforwardRun.runId],
  }).onDelete('cascade'),
  check('carryforward_result_category_ck', sql`${t.accountCategory} in ('BALANCE_SHEET', 'PL_STATEMENT')`),
  check('carryforward_result_status_ck', sql`${t.status} in ('CARRIED', 'TRANSFERRED', 'EXCEPTION')`),
]);



/**
 * Payment run (SCR-063 / R-111). Parameters with company and method
 * children, the proposal with its named exceptions, and payment
 * documents as the execution's retained evidence.
 */
const tenantClient = () => varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' });

export const paymentRun = pgTable('payment_run', {
  client: tenantClient(),
  runDate: date('run_date', { mode: 'string' }).notNull(),
  runId: varchar('run_id', { length: 5 }).notNull(),
  postingDate: date('posting_date', { mode: 'string' }).notNull(),
  documentCutoffDate: date('document_cutoff_date', { mode: 'string' }).notNull(),
  nextPaymentDate: date('next_payment_date', { mode: 'string' }).notNull(),
  supplierFrom: varchar('supplier_from', { length: 20 }),
  supplierTo: varchar('supplier_to', { length: 20 }),
  status: varchar('status', { length: 12 }).notNull().default('PARAMETERS'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.runDate, t.runId] }),
  check('payment_run_status_ck', sql`${t.status} in ('PARAMETERS', 'PROPOSAL', 'EXECUTED', 'CANCELLED')`),
]);

export const paymentRunCompany = pgTable('payment_run_company', {
  client: tenantClient(),
  runDate: date('run_date', { mode: 'string' }).notNull(),
  runId: varchar('run_id', { length: 5 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  payingCompanyCode: varchar('paying_company_code', { length: 10 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.runDate, t.runId, t.companyCode] }),
  foreignKey({ columns: [t.client, t.runDate, t.runId], foreignColumns: [paymentRun.client, paymentRun.runDate, paymentRun.runId] }).onDelete('cascade'),
]);

export const paymentRunMethod = pgTable('payment_run_method', {
  client: tenantClient(),
  runDate: date('run_date', { mode: 'string' }).notNull(),
  runId: varchar('run_id', { length: 5 }).notNull(),
  paymentMethod: varchar('payment_method', { length: 2 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.runDate, t.runId, t.paymentMethod] }),
  foreignKey({ columns: [t.client, t.runDate, t.runId], foreignColumns: [paymentRun.client, paymentRun.runDate, paymentRun.runId] }).onDelete('cascade'),
]);

export const paymentProposalItem = pgTable('payment_proposal_item', {
  client: tenantClient(),
  runDate: date('run_date', { mode: 'string' }).notNull(),
  runId: varchar('run_id', { length: 5 }).notNull(),
  itemNumber: integer('item_number').notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  payingCompanyCode: varchar('paying_company_code', { length: 10 }).notNull(),
  accountType: char('account_type', { length: 1 }).notNull().default('K'),
  accountId: varchar('account_id', { length: 20 }).notNull(),
  journalDocumentNumber: varchar('journal_document_number', { length: 40 }).notNull(),
  journalFiscalYear: integer('journal_fiscal_year').notNull(),
  journalLineNumber: integer('journal_line_number').notNull(),
  invoiceNumber: varchar('invoice_number', { length: 20 }),
  currency: varchar('currency', { length: 3 }).notNull(),
  amount: numeric('amount', { precision: 23, scale: 4 }).notNull(),
  dueDate: date('due_date', { mode: 'string' }),
  paymentMethod: varchar('payment_method', { length: 2 }),
  exceptionCode: varchar('exception_code', { length: 40 }),
  exceptionText: varchar('exception_text', { length: 200 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.runDate, t.runId, t.itemNumber] }),
  foreignKey({ columns: [t.client, t.runDate, t.runId], foreignColumns: [paymentRun.client, paymentRun.runDate, paymentRun.runId] }).onDelete('cascade'),
  check('payment_proposal_account_type_ck', sql`${t.accountType} in ('K', 'D')`),
]);

export const paymentDocument = pgTable('payment_document', {
  client: tenantClient(),
  runDate: date('run_date', { mode: 'string' }).notNull(),
  runId: varchar('run_id', { length: 5 }).notNull(),
  itemNumber: integer('item_number').notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  payingCompanyCode: varchar('paying_company_code', { length: 10 }).notNull(),
  accountId: varchar('account_id', { length: 20 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  amount: numeric('amount', { precision: 23, scale: 4 }).notNull(),
  journalDocumentNumber: varchar('journal_document_number', { length: 40 }).notNull(),
  journalFiscalYear: integer('journal_fiscal_year').notNull(),
  journalLineNumber: integer('journal_line_number').notNull(),
  invoiceNumber: varchar('invoice_number', { length: 20 }),
  houseBankKey: varchar('house_bank_key', { length: 5 }).notNull(),
  bankAccountId: varchar('bank_account_id', { length: 5 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.runDate, t.runId, t.itemNumber] }),
  foreignKey({ columns: [t.client, t.runDate, t.runId], foreignColumns: [paymentRun.client, paymentRun.runDate, paymentRun.runId] }).onDelete('restrict'),
]);

/** Outgoing payment record (SCR-078 / R-126). One row per posted vendor payment; allocations stand as clearing stamps on the journal lines, as with incoming payment. */
export const outgoingPayment = pgTable('outgoing_payment', {
  client: tenantClient(),
  paymentNumber: varchar('payment_number', { length: 20 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  vendorNumber: varchar('vendor_number', { length: 20 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  documentDate: date('document_date', { mode: 'string' }).notNull(),
  postingDate: date('posting_date', { mode: 'string' }).notNull(),
  clearingDate: date('clearing_date', { mode: 'string' }).notNull(),
  valueDate: date('value_date', { mode: 'string' }),
  bankGlAccount: varchar('bank_gl_account', { length: 10 }).notNull(),
  amount: numeric('amount', { precision: 23, scale: 4 }).notNull(),
  discountAmount: numeric('discount_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  onAccountAmount: numeric('on_account_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  currency: char('currency', { length: 3 }).notNull(),
  reference: varchar('reference', { length: 16 }),
  journalDocumentNumber: varchar('journal_document_number', { length: 40 }).notNull(),
  itemsCleared: integer('items_cleared').notNull(),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.paymentNumber] }),
]);

/** Vendor down payment record (SCR-081): the KA journal stands the truth. */
export const vendorDownPayment = pgTable('vendor_down_payment', {
  client: tenantClient(),
  paymentNumber: varchar('payment_number', { length: 20 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  vendorNumber: varchar('vendor_number', { length: 20 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  documentDate: date('document_date', { mode: 'string' }).notNull(),
  postingDate: date('posting_date', { mode: 'string' }).notNull(),
  valueDate: date('value_date', { mode: 'string' }),
  bankGlAccount: varchar('bank_gl_account', { length: 10 }).notNull(),
  specialGlIndicator: varchar('special_gl_indicator', { length: 1 }).notNull(),
  alternativeReconciliationAccount: varchar('alternative_reconciliation_account', { length: 10 }).notNull(),
  amount: numeric('amount', { precision: 23, scale: 4 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  reference: varchar('reference', { length: 16 }),
  headerText: varchar('header_text', { length: 100 }),
  journalDocumentNumber: varchar('journal_document_number', { length: 40 }).notNull(),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.paymentNumber] }),
]);

/** Down-payment clearing record (SCR-082): the KZ journal stands the truth. */
export const vendorDownPaymentClearing = pgTable('vendor_down_payment_clearing', {
  client: tenantClient(),
  clearingNumber: varchar('clearing_number', { length: 20 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  vendorNumber: varchar('vendor_number', { length: 20 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  specialGlIndicator: varchar('special_gl_indicator', { length: 1 }).notNull(),
  alternativeReconciliationAccount: varchar('alternative_reconciliation_account', { length: 10 }).notNull(),
  documentDate: date('document_date', { mode: 'string' }).notNull(),
  postingDate: date('posting_date', { mode: 'string' }).notNull(),
  clearingDate: date('clearing_date', { mode: 'string' }).notNull(),
  totalApplied: numeric('total_applied', { precision: 23, scale: 4 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  reference: varchar('reference', { length: 16 }),
  journalDocumentNumber: varchar('journal_document_number', { length: 40 }).notNull(),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.clearingNumber] }),
]);

/** Customer down payment record (SCR-083): the DZ journal stands the truth. */
export const customerDownPayment = pgTable('customer_down_payment', {
  client: tenantClient(),
  paymentNumber: varchar('payment_number', { length: 20 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  customerNumber: varchar('customer_number', { length: 20 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  documentDate: date('document_date', { mode: 'string' }).notNull(),
  postingDate: date('posting_date', { mode: 'string' }).notNull(),
  valueDate: date('value_date', { mode: 'string' }),
  bankGlAccount: varchar('bank_gl_account', { length: 10 }).notNull(),
  specialGlIndicator: varchar('special_gl_indicator', { length: 1 }).notNull(),
  alternativeReconciliationAccount: varchar('alternative_reconciliation_account', { length: 10 }).notNull(),
  amount: numeric('amount', { precision: 23, scale: 4 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  reference: varchar('reference', { length: 16 }),
  headerText: varchar('header_text', { length: 100 }),
  journalDocumentNumber: varchar('journal_document_number', { length: 40 }).notNull(),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.paymentNumber] }),
]);

/**
 * Customer down payment clearing (SCR-084): the header of one DZ
 * transfer clearing; the journal lines stand the balance truth and
 * the item rows below remember the pairwise allocations.
 */
export const customerDownPaymentClearing = pgTable('customer_down_payment_clearing', {
  client: tenantClient(),
  clearingNumber: varchar('clearing_number', { length: 20 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  customerNumber: varchar('customer_number', { length: 20 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  specialGlIndicator: varchar('special_gl_indicator', { length: 1 }).notNull(),
  alternativeReconciliationAccount: varchar('alternative_reconciliation_account', { length: 10 }).notNull(),
  documentDate: date('document_date', { mode: 'string' }).notNull(),
  postingDate: date('posting_date', { mode: 'string' }).notNull(),
  clearingDate: date('clearing_date', { mode: 'string' }).notNull(),
  /** Summary of the allocation rows; reconciled to them at posting. */
  totalApplied: numeric('total_applied', { precision: 23, scale: 4 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  reference: varchar('reference', { length: 16 }),
  journalDocumentNumber: varchar('journal_document_number', { length: 40 }).notNull(),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.clearingNumber] }),
  check('customer_dp_clearing_amount_ck', sql`${t.totalApplied} > 0`),
]);

/**
 * One pairwise allocation of a clearing (SCR-084): a down-payment
 * journal line applied to an invoice journal line. Composite foreign
 * keys guarantee both source lines exist in this tenant; their roles
 * (customer, indicator, eligibility) are judged by the service.
 */
export const customerDownPaymentClearingItem = pgTable('customer_down_payment_clearing_item', {
  client: tenantClient(),
  clearingNumber: varchar('clearing_number', { length: 20 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  mappingNumber: integer('mapping_number').notNull(),
  downPaymentDocumentNumber: varchar('down_payment_document_number', { length: 40 }).notNull(),
  downPaymentFiscalYear: integer('down_payment_fiscal_year').notNull(),
  downPaymentLineNumber: integer('down_payment_line_number').notNull(),
  invoiceDocumentNumber: varchar('invoice_document_number', { length: 40 }).notNull(),
  invoiceFiscalYear: integer('invoice_fiscal_year').notNull(),
  invoiceLineNumber: integer('invoice_line_number').notNull(),
  allocationCurrency: char('allocation_currency', { length: 3 }).notNull(),
  allocatedAmount: numeric('allocated_amount', { precision: 23, scale: 4 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.clearingNumber, t.fiscalYear, t.mappingNumber] }),
  foreignKey({
    columns: [t.client, t.clearingNumber],
    foreignColumns: [customerDownPaymentClearing.client, customerDownPaymentClearing.clearingNumber],
    name: 'customer_dp_clearing_item_header_fk',
  }),
  foreignKey({
    columns: [t.client, t.downPaymentDocumentNumber, t.downPaymentFiscalYear, t.downPaymentLineNumber],
    foreignColumns: [journalEntryLine.client, journalEntryLine.documentNumber, journalEntryLine.fiscalYear, journalEntryLine.lineNumber],
    name: 'customer_dp_clearing_item_dp_fk',
  }),
  foreignKey({
    columns: [t.client, t.invoiceDocumentNumber, t.invoiceFiscalYear, t.invoiceLineNumber],
    foreignColumns: [journalEntryLine.client, journalEntryLine.documentNumber, journalEntryLine.fiscalYear, journalEntryLine.lineNumber],
    name: 'customer_dp_clearing_item_invoice_fk',
  }),
  check('customer_dp_clearing_item_amount_ck', sql`${t.allocatedAmount} > 0`),
  index('cdpci_down_payment_idx').on(t.client, t.downPaymentDocumentNumber, t.downPaymentFiscalYear),
  index('cdpci_invoice_idx').on(t.client, t.invoiceDocumentNumber, t.invoiceFiscalYear),
]);

/**
 * Customer down payment request (SCR-085): a noted item. The record
 * is itself the document — no journal stands behind it, and no
 * account moves until an actual receipt (F-29) fulfills it.
 */
export const customerDownPaymentRequest = pgTable('customer_down_payment_request', {
  client: tenantClient(),
  requestNumber: varchar('request_number', { length: 20 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  customerNumber: varchar('customer_number', { length: 20 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  specialGlIndicator: varchar('special_gl_indicator', { length: 1 }).notNull(),
  targetSpecialGlIndicator: varchar('target_special_gl_indicator', { length: 1 }).notNull(),
  documentDate: date('document_date', { mode: 'string' }).notNull(),
  postingDate: date('posting_date', { mode: 'string' }).notNull(),
  dueDate: date('due_date', { mode: 'string' }).notNull(),
  documentType: varchar('document_type', { length: 12 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  reference: varchar('reference', { length: 16 }),
  requestedAmount: numeric('requested_amount', { precision: 23, scale: 4 }).notNull(),
  /** OPEN | PARTIAL | FULFILLED advance with fulfillment; CLOSED/REVERSED reserved. */
  status: varchar('status', { length: 12 }).notNull().default('OPEN'),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.requestNumber] }),
  check('customer_dp_request_amount_ck', sql`${t.requestedAmount} > 0`),
  check('customer_dp_request_status_ck', sql`${t.status} in ('OPEN', 'PARTIAL', 'FULFILLED', 'CLOSED', 'REVERSED')`),
  index('cdpr_customer_idx').on(t.client, t.companyCode, t.customerNumber, t.dueDate),
]);

/**
 * One fulfillment of a request by an actual F-29 receipt line
 * (SCR-085). Fulfilled and remaining amounts derive from the ACTIVE
 * rows; history is never erased, only reversed by status.
 */
export const downPaymentRequestFulfillment = pgTable('down_payment_request_fulfillment', {
  client: tenantClient(),
  requestNumber: varchar('request_number', { length: 20 }).notNull(),
  requestFiscalYear: integer('request_fiscal_year').notNull(),
  fulfillmentNumber: integer('fulfillment_number').notNull(),
  actualDocumentNumber: varchar('actual_document_number', { length: 40 }).notNull(),
  actualFiscalYear: integer('actual_fiscal_year').notNull(),
  actualLineNumber: integer('actual_line_number').notNull(),
  fulfillmentCurrency: char('fulfillment_currency', { length: 3 }).notNull(),
  fulfilledAmount: numeric('fulfilled_amount', { precision: 23, scale: 4 }).notNull(),
  status: varchar('status', { length: 12 }).notNull().default('ACTIVE'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.requestNumber, t.requestFiscalYear, t.fulfillmentNumber] }),
  foreignKey({
    columns: [t.client, t.requestNumber],
    foreignColumns: [customerDownPaymentRequest.client, customerDownPaymentRequest.requestNumber],
    name: 'dp_request_fulfillment_request_fk',
  }),
  foreignKey({
    columns: [t.client, t.actualDocumentNumber, t.actualFiscalYear, t.actualLineNumber],
    foreignColumns: [journalEntryLine.client, journalEntryLine.documentNumber, journalEntryLine.fiscalYear, journalEntryLine.lineNumber],
    name: 'dp_request_fulfillment_actual_fk',
  }),
  check('dp_request_fulfillment_amount_ck', sql`${t.fulfilledAmount} > 0`),
  check('dp_request_fulfillment_status_ck', sql`${t.status} in ('ACTIVE', 'REVERSED')`),
  index('dprf_actual_idx').on(t.client, t.actualDocumentNumber, t.actualFiscalYear),
]);

/**
 * Vendor down payment request (SCR-086): the vendor twin of the
 * customer noted item — the record is itself the document, no
 * journal stands behind it, and no account moves until an actual
 * payment (F-48) fulfills it.
 */
export const vendorDownPaymentRequest = pgTable('vendor_down_payment_request', {
  client: tenantClient(),
  requestNumber: varchar('request_number', { length: 20 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  vendorNumber: varchar('vendor_number', { length: 20 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  specialGlIndicator: varchar('special_gl_indicator', { length: 1 }).notNull(),
  targetSpecialGlIndicator: varchar('target_special_gl_indicator', { length: 1 }).notNull(),
  documentDate: date('document_date', { mode: 'string' }).notNull(),
  postingDate: date('posting_date', { mode: 'string' }).notNull(),
  dueDate: date('due_date', { mode: 'string' }).notNull(),
  documentType: varchar('document_type', { length: 12 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  reference: varchar('reference', { length: 16 }),
  requestedAmount: numeric('requested_amount', { precision: 23, scale: 4 }).notNull(),
  /** OPEN | PARTIAL | FULFILLED advance with fulfillment; CLOSED/REVERSED reserved. */
  status: varchar('status', { length: 12 }).notNull().default('OPEN'),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.requestNumber] }),
  check('vendor_dp_request_amount_ck', sql`${t.requestedAmount} > 0`),
  check('vendor_dp_request_status_ck', sql`${t.status} in ('OPEN', 'PARTIAL', 'FULFILLED', 'CLOSED', 'REVERSED')`),
  index('vdpr_vendor_idx').on(t.client, t.companyCode, t.vendorNumber, t.dueDate),
]);

/**
 * One fulfillment of a vendor request by an actual F-48 payment
 * line (SCR-086). Fulfilled and remaining amounts derive from the
 * ACTIVE rows; history is never erased, only reversed by status.
 */
export const vendorDpRequestFulfillment = pgTable('vendor_dp_request_fulfillment', {
  client: tenantClient(),
  requestNumber: varchar('request_number', { length: 20 }).notNull(),
  requestFiscalYear: integer('request_fiscal_year').notNull(),
  fulfillmentNumber: integer('fulfillment_number').notNull(),
  actualDocumentNumber: varchar('actual_document_number', { length: 40 }).notNull(),
  actualFiscalYear: integer('actual_fiscal_year').notNull(),
  actualLineNumber: integer('actual_line_number').notNull(),
  fulfillmentCurrency: char('fulfillment_currency', { length: 3 }).notNull(),
  fulfilledAmount: numeric('fulfilled_amount', { precision: 23, scale: 4 }).notNull(),
  status: varchar('status', { length: 12 }).notNull().default('ACTIVE'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.requestNumber, t.requestFiscalYear, t.fulfillmentNumber] }),
  foreignKey({
    columns: [t.client, t.requestNumber],
    foreignColumns: [vendorDownPaymentRequest.client, vendorDownPaymentRequest.requestNumber],
    name: 'vendor_dp_fulfillment_request_fk',
  }),
  foreignKey({
    columns: [t.client, t.actualDocumentNumber, t.actualFiscalYear, t.actualLineNumber],
    foreignColumns: [journalEntryLine.client, journalEntryLine.documentNumber, journalEntryLine.fiscalYear, journalEntryLine.lineNumber],
    name: 'vendor_dp_fulfillment_actual_fk',
  }),
  check('vendor_dp_fulfillment_amount_ck', sql`${t.fulfilledAmount} > 0`),
  check('vendor_dp_fulfillment_status_ck', sql`${t.status} in ('ACTIVE', 'REVERSED')`),
  index('vdprf_actual_idx').on(t.client, t.actualDocumentNumber, t.actualFiscalYear),
]);

/**
 * Parked journal header (SCR-087): a preliminary G/L document in
 * staging. No journal stands behind it until posting converts it;
 * after posting the record is retained naming the canonical
 * document. Version-checked edits; deletion is a logical status.
 */
/** Asset class — tenant configuration governing numbering, quantity and depreciation defaults (SCR-091). */
export const assetClass = pgTable('asset_class', {
  client: tenantClient(),
  assetClass: varchar('asset_class', { length: 8 }).notNull(),
  name: varchar('name', { length: 60 }).notNull(),
  /** INTERNAL draws from the ASSETNR range; EXTERNAL validates a supplied number unused. */
  numbering: varchar('numbering', { length: 8 }).notNull().default('INTERNAL'),
  quantityManaged: boolean('quantity_managed').notNull().default(false),
  defaultDepreciationKey: varchar('default_depreciation_key', { length: 4 }),
  /** Account determination: the acquisition reconciliation account this class debits (SCR-092). */
  reconAccount: varchar('recon_account', { length: 10 }),
  /** Account determination: accumulated depreciation this class reverses at retirement (SCR-093). */
  accumDeprAccount: varchar('accum_depr_account', { length: 10 }),
  /** Account determination: loss on retirement without proceeds this class debits (SCR-093). */
  retirementLossAccount: varchar('retirement_loss_account', { length: 10 }),
  /** Account determination: depreciation expense this class debits in the run (SCR-094). */
  depreciationExpenseAccount: varchar('depreciation_expense_account', { length: 10 }),
  defaultUsefulLifeYears: integer('default_useful_life_years'),
  defaultUsefulLifePeriods: integer('default_useful_life_periods'),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.assetClass] }),
  check('asset_class_numbering_ck', sql`${t.numbering} in ('INTERNAL', 'EXTERNAL')`),
]);

/** Depreciation area — tenant configuration (SCR-091). */
export const depreciationArea = pgTable('depreciation_area', {
  client: tenantClient(),
  areaCode: varchar('area_code', { length: 2 }).notNull(),
  name: varchar('name', { length: 60 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [primaryKey({ columns: [t.client, t.areaCode] })]);

/** Depreciation key — tenant configuration (SCR-091). */
export const depreciationKey = pgTable('depreciation_key', {
  client: tenantClient(),
  keyCode: varchar('key_code', { length: 4 }).notNull(),
  name: varchar('name', { length: 60 }).notNull(),
  /** STRAIGHT_LINE | DECLINING_BALANCE — method vocabulary of the future depreciation run. */
  method: varchar('method', { length: 20 }).notNull().default('STRAIGHT_LINE'),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [primaryKey({ columns: [t.client, t.keyCode] })]);

/**
 * Fixed asset master (SCR-091): identity under the complete key
 * (tenant, company, main number, sub-number). Master data only —
 * no values stand here; acquisition and depreciation post later.
 */
export const fixedAsset = pgTable('fixed_asset', {
  client: tenantClient(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  assetNumber: varchar('asset_number', { length: 12 }).notNull(),
  subNumber: varchar('sub_number', { length: 4 }).notNull().default('0000'),
  assetClass: varchar('asset_class', { length: 8 }).notNull(),
  description1: varchar('description_1', { length: 50 }).notNull(),
  description2: varchar('description_2', { length: 25 }),
  inventoryNumber: varchar('inventory_number', { length: 30 }),
  serialNumber: varchar('serial_number', { length: 30 }),
  quantity: numeric('quantity', { precision: 13, scale: 3 }),
  unitOfMeasure: varchar('unit_of_measure', { length: 3 }),
  capitalizationDate: date('capitalization_date', { mode: 'string' }),
  deactivationDate: date('deactivation_date', { mode: 'string' }),
  status: varchar('status', { length: 12 }).notNull().default('ACTIVE'),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.companyCode, t.assetNumber, t.subNumber] }),
  check('fixed_asset_status_ck', sql`${t.status} in ('ACTIVE', 'DEACTIVATED', 'RETIRED')`),
  check('fixed_asset_version_ck', sql`${t.version} > 0`),
  uniqueIndex('fixed_asset_inventory_uk').on(t.client, t.companyCode, t.inventoryNumber)
    .where(sql`${t.inventoryNumber} is not null`),
  index('fixed_asset_class_idx').on(t.client, t.companyCode, t.assetClass),
]);

/** Time-dependent asset assignments (SCR-091): [validFrom, validTo) intervals, history never rewritten. */
export const assetAssignment = pgTable('asset_assignment', {
  client: tenantClient(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  assetNumber: varchar('asset_number', { length: 12 }).notNull(),
  subNumber: varchar('sub_number', { length: 4 }).notNull().default('0000'),
  validFrom: date('valid_from', { mode: 'string' }).notNull(),
  validTo: date('valid_to', { mode: 'string' }),
  costCenter: varchar('cost_center', { length: 20 }),
  profitCenter: varchar('profit_center', { length: 20 }),
  plant: varchar('plant', { length: 10 }),
  location: varchar('location', { length: 20 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.companyCode, t.assetNumber, t.subNumber, t.validFrom] }),
  foreignKey({
    columns: [t.client, t.companyCode, t.assetNumber, t.subNumber],
    foreignColumns: [fixedAsset.client, fixedAsset.companyCode, fixedAsset.assetNumber, fixedAsset.subNumber],
    name: 'asset_assignment_asset_fk',
  }),
  check('asset_assignment_interval_ck', sql`${t.validTo} is null or ${t.validTo} > ${t.validFrom}`),
]);

/** Per-area depreciation parameters of one asset (SCR-091). */
export const assetDepreciation = pgTable('asset_depreciation', {
  client: tenantClient(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  assetNumber: varchar('asset_number', { length: 12 }).notNull(),
  subNumber: varchar('sub_number', { length: 4 }).notNull().default('0000'),
  areaCode: varchar('area_code', { length: 2 }).notNull(),
  depreciationKey: varchar('depreciation_key', { length: 4 }).notNull(),
  usefulLifeYears: integer('useful_life_years').notNull(),
  usefulLifePeriods: integer('useful_life_periods').notNull().default(0),
  depreciationStartDate: date('depreciation_start_date', { mode: 'string' }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.companyCode, t.assetNumber, t.subNumber, t.areaCode] }),
  foreignKey({
    columns: [t.client, t.companyCode, t.assetNumber, t.subNumber],
    foreignColumns: [fixedAsset.client, fixedAsset.companyCode, fixedAsset.assetNumber, fixedAsset.subNumber],
    name: 'asset_depreciation_asset_fk',
  }),
  check('asset_depreciation_years_ck', sql`${t.usefulLifeYears} >= 0`),
  check('asset_depreciation_periods_ck', sql`${t.usefulLifePeriods} between 0 and 11`),
  check('asset_depreciation_life_ck', sql`${t.usefulLifeYears} * 12 + ${t.usefulLifePeriods} > 0`),
]);

/** Asset transaction types — tenant configuration (SCR-092). */
export const assetTransactionType = pgTable('asset_transaction_type', {
  client: tenantClient(),
  typeCode: varchar('type_code', { length: 4 }).notNull(),
  name: varchar('name', { length: 60 }).notNull(),
  /** ACQUISITION today; further kinds arrive with their rounds. */
  kind: varchar('kind', { length: 16 }).notNull().default('ACQUISITION'),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.typeCode] }),
  check('asset_transaction_type_kind_ck', sql`${t.kind} in ('ACQUISITION', 'RETIREMENT')`),
]);

/**
 * Asset transaction — the value record of one asset posting
 * (SCR-092). Not a second ledger: the journal stays the financial
 * authority, and asset values derive from ACTIVE rows here.
 */
export const assetTransaction = pgTable('asset_transaction', {
  client: tenantClient(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  assetNumber: varchar('asset_number', { length: 12 }).notNull(),
  subNumber: varchar('sub_number', { length: 4 }).notNull().default('0000'),
  documentNumber: varchar('document_number', { length: 40 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  transactionType: varchar('transaction_type', { length: 4 }).notNull(),
  documentDate: date('document_date', { mode: 'string' }).notNull(),
  postingDate: date('posting_date', { mode: 'string' }).notNull(),
  assetValueDate: date('asset_value_date', { mode: 'string' }).notNull(),
  amount: numeric('amount', { precision: 23, scale: 4 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  offsetAccount: varchar('offset_account', { length: 10 }).notNull(),
  reference: varchar('reference', { length: 60 }),
  lineText: varchar('line_text', { length: 50 }),
  /** ACTIVE | REVERSED */
  status: varchar('status', { length: 12 }).notNull().default('ACTIVE'),
  reversalDocumentNumber: varchar('reversal_document_number', { length: 40 }),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.companyCode, t.assetNumber, t.subNumber, t.documentNumber, t.fiscalYear] }),
  foreignKey({
    columns: [t.client, t.companyCode, t.assetNumber, t.subNumber],
    foreignColumns: [fixedAsset.client, fixedAsset.companyCode, fixedAsset.assetNumber, fixedAsset.subNumber],
    name: 'asset_transaction_asset_fk',
  }),
  check('asset_transaction_status_ck', sql`${t.status} in ('ACTIVE', 'REVERSED')`),
  check('asset_transaction_amount_ck', sql`${t.amount} > 0`),
  uniqueIndex('asset_transaction_request_uk').on(t.client, t.requestKey)
    .where(sql`${t.requestKey} is not null`),
  index('asset_transaction_asset_idx').on(t.client, t.companyCode, t.assetNumber, t.subNumber, t.status),
  index('asset_transaction_report_idx').on(t.client, t.companyCode, t.assetValueDate),
]);

/**
 * Asset retirement — the value record of one retirement posting
 * (SCR-093 / R-141). Not a second ledger: the journal stays the
 * financial authority, and remaining asset values derive from
 * ACTIVE acquisition rows less ACTIVE retirement rows here.
 */
export const assetRetirement = pgTable('asset_retirement', {
  client: tenantClient(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  assetNumber: varchar('asset_number', { length: 12 }).notNull(),
  subNumber: varchar('sub_number', { length: 4 }).notNull().default('0000'),
  documentNumber: varchar('document_number', { length: 40 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  transactionType: varchar('transaction_type', { length: 4 }).notNull(),
  /** COMPLETE | PERCENT | AMOUNT */
  scope: varchar('scope', { length: 10 }).notNull(),
  /** PERCENT scope basis: percentage of the remaining retireable acquisition value. */
  retirementPercent: numeric('retirement_percent', { precision: 7, scale: 4 }),
  /** AMOUNT scope basis: the requested acquisition value to retire. */
  retirementAmount: numeric('retirement_amount', { precision: 23, scale: 4 }),
  retiredAcquisitionValue: numeric('retired_acquisition_value', { precision: 23, scale: 4 }).notNull(),
  accumDepreciationReversed: numeric('accum_depreciation_reversed', { precision: 23, scale: 4 }).notNull().default('0'),
  netBookValueLoss: numeric('net_book_value_loss', { precision: 23, scale: 4 }).notNull().default('0'),
  currency: char('currency', { length: 3 }).notNull(),
  documentDate: date('document_date', { mode: 'string' }).notNull(),
  postingDate: date('posting_date', { mode: 'string' }).notNull(),
  assetValueDate: date('asset_value_date', { mode: 'string' }).notNull(),
  reference: varchar('reference', { length: 60 }),
  lineText: varchar('line_text', { length: 50 }),
  /** ACTIVE | REVERSED */
  status: varchar('status', { length: 12 }).notNull().default('ACTIVE'),
  reversalDocumentNumber: varchar('reversal_document_number', { length: 40 }),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.companyCode, t.assetNumber, t.subNumber, t.documentNumber, t.fiscalYear] }),
  foreignKey({
    columns: [t.client, t.companyCode, t.assetNumber, t.subNumber],
    foreignColumns: [fixedAsset.client, fixedAsset.companyCode, fixedAsset.assetNumber, fixedAsset.subNumber],
    name: 'asset_retirement_asset_fk',
  }),
  check('asset_retirement_scope_ck', sql`${t.scope} in ('COMPLETE', 'PERCENT', 'AMOUNT')`),
  check('asset_retirement_status_ck', sql`${t.status} in ('ACTIVE', 'REVERSED')`),
  check('asset_retirement_value_ck', sql`${t.retiredAcquisitionValue} > 0`),
  check('asset_retirement_percent_ck', sql`${t.retirementPercent} is null or (${t.retirementPercent} > 0 and ${t.retirementPercent} <= 100)`),
  uniqueIndex('asset_retirement_request_uk').on(t.client, t.requestKey)
    .where(sql`${t.requestKey} is not null`),
  index('asset_retirement_asset_idx').on(t.client, t.companyCode, t.assetNumber, t.subNumber, t.status),
  index('asset_retirement_report_idx').on(t.client, t.companyCode, t.assetValueDate),
]);

/**
 * Depreciation run header — one execution of the run (SCR-094 /
 * R-142). The run record is the execution log; the journal stays
 * the financial authority and `asset_depreciation_posting` holds
 * what was actually posted per asset, area and period.
 */
export const assetDepreciationRun = pgTable('asset_depreciation_run', {
  client: tenantClient(),
  runId: varchar('run_id', { length: 36 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  postingPeriod: integer('posting_period').notNull(),
  /** 1 Planned · 2 Repeat · 3 Restart · 4 Unplanned */
  runType: varchar('run_type', { length: 1 }).notNull(),
  isTestRun: boolean('is_test_run').notNull().default(true),
  postingDate: date('posting_date', { mode: 'string' }).notNull(),
  documentType: varchar('document_type', { length: 12 }),
  /** SIMULATED | COMPLETED | COMPLETED_WITH_WARNINGS | FAILED */
  status: varchar('status', { length: 24 }).notNull(),
  totalCalculatedAmount: numeric('total_calculated_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  totalPostedAmount: numeric('total_posted_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  currency: char('currency', { length: 3 }).notNull(),
  documentNumber: varchar('document_number', { length: 40 }),
  documentFiscalYear: integer('document_fiscal_year'),
  restartOfRunId: varchar('restart_of_run_id', { length: 36 }),
  errorMessage: text('error_message'),
  executedBy: varchar('executed_by', { length: 60 }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.runId] }),
  check('asset_depreciation_run_type_ck', sql`${t.runType} in ('1', '2', '3', '4')`),
  check('asset_depreciation_run_status_ck', sql`${t.status} in ('SIMULATED', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED')`),
  check('asset_depreciation_run_period_ck', sql`${t.postingPeriod} between 1 and 16`),
  index('asset_depreciation_run_company_idx').on(t.client, t.companyCode, t.fiscalYear, t.postingPeriod),
]);

/** Depreciation run item — one calculated asset × area outcome of a run (SCR-094). */
export const assetDepreciationRunItem = pgTable('asset_depreciation_run_item', {
  client: tenantClient(),
  runId: varchar('run_id', { length: 36 }).notNull(),
  itemNumber: integer('item_number').notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  assetNumber: varchar('asset_number', { length: 12 }).notNull(),
  subNumber: varchar('sub_number', { length: 4 }).notNull().default('0000'),
  areaCode: varchar('area_code', { length: 2 }).notNull(),
  depreciationKey: varchar('depreciation_key', { length: 4 }).notNull(),
  calculatedAmount: numeric('calculated_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  previouslyPostedAmount: numeric('previously_posted_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  adjustmentAmount: numeric('adjustment_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  currency: char('currency', { length: 3 }).notNull(),
  expenseAccount: varchar('expense_account', { length: 10 }),
  accumAccount: varchar('accum_account', { length: 10 }),
  costCenter: varchar('cost_center', { length: 20 }),
  profitCenter: varchar('profit_center', { length: 20 }),
  /** CALCULATED | POSTED | SKIPPED | FAILED */
  itemStatus: varchar('item_status', { length: 12 }).notNull(),
  documentNumber: varchar('document_number', { length: 40 }),
  message: text('message'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.runId, t.itemNumber] }),
  foreignKey({
    columns: [t.client, t.runId],
    foreignColumns: [assetDepreciationRun.client, assetDepreciationRun.runId],
    name: 'asset_depreciation_run_item_run_fk',
  }),
  foreignKey({
    columns: [t.client, t.companyCode, t.assetNumber, t.subNumber],
    foreignColumns: [fixedAsset.client, fixedAsset.companyCode, fixedAsset.assetNumber, fixedAsset.subNumber],
    name: 'asset_depreciation_run_item_asset_fk',
  }),
  check('asset_depreciation_run_item_status_ck', sql`${t.itemStatus} in ('CALCULATED', 'POSTED', 'SKIPPED', 'FAILED')`),
  check('asset_depreciation_run_item_amount_ck', sql`${t.calculatedAmount} >= 0`),
  uniqueIndex('asset_depreciation_run_item_asset_uk').on(t.client, t.runId, t.companyCode, t.assetNumber, t.subNumber, t.areaCode),
  index('asset_depreciation_run_item_asset_idx').on(t.client, t.companyCode, t.assetNumber, t.subNumber, t.areaCode, t.itemStatus),
]);

/**
 * Posted depreciation per asset × area × period (SCR-094) — the
 * value record the retirement reversal (SCR-093) reads. The
 * journal remains the financial authority.
 */
export const assetDepreciationPosting = pgTable('asset_depreciation_posting', {
  client: tenantClient(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  assetNumber: varchar('asset_number', { length: 12 }).notNull(),
  subNumber: varchar('sub_number', { length: 4 }).notNull().default('0000'),
  areaCode: varchar('area_code', { length: 2 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  postingPeriod: integer('posting_period').notNull(),
  postedAmount: numeric('posted_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  currency: char('currency', { length: 3 }).notNull(),
  runId: varchar('run_id', { length: 36 }).notNull(),
  documentNumber: varchar('document_number', { length: 40 }),
  documentFiscalYear: integer('document_fiscal_year'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.companyCode, t.assetNumber, t.subNumber, t.areaCode, t.fiscalYear, t.postingPeriod] }),
  foreignKey({
    columns: [t.client, t.companyCode, t.assetNumber, t.subNumber],
    foreignColumns: [fixedAsset.client, fixedAsset.companyCode, fixedAsset.assetNumber, fixedAsset.subNumber],
    name: 'asset_depreciation_posting_asset_fk',
  }),
  index('asset_depreciation_posting_asset_idx').on(t.client, t.companyCode, t.assetNumber, t.subNumber, t.areaCode),
  index('asset_depreciation_posting_report_idx').on(t.client, t.companyCode, t.fiscalYear, t.postingPeriod),
]);

export const parkedJournalHeader = pgTable('parked_journal_header', {
  client: tenantClient(),
  parkedNumber: varchar('parked_number', { length: 20 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  documentType: varchar('document_type', { length: 12 }).notNull(),
  documentDate: date('document_date', { mode: 'string' }).notNull(),
  postingDate: date('posting_date', { mode: 'string' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  reference: varchar('reference', { length: 16 }),
  headerText: varchar('header_text', { length: 100 }),
  /** PARKED | COMPLETED | POSTED | DELETED; REJECTED reserved for the approval workflow. */
  status: varchar('status', { length: 16 }).notNull().default('PARKED'),
  /** Optimistic-concurrency version; every edit increments it. */
  version: integer('version').notNull().default(1),
  /** Reason carried by the standing status (deletion today). */
  statusReason: text('status_reason'),
  postedDocumentNumber: varchar('posted_document_number', { length: 40 }),
  postedFiscalYear: integer('posted_fiscal_year'),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  postedByUser: varchar('posted_by_user', { length: 60 }),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.parkedNumber] }),
  check('parked_journal_status_ck', sql`${t.status} in ('PARKED', 'COMPLETED', 'POSTED', 'DELETED', 'REJECTED')`),
  check('parked_journal_version_ck', sql`${t.version} > 0`),
  check('parked_journal_posted_ref_ck', sql`${t.status} <> 'POSTED' or (${t.postedDocumentNumber} is not null and ${t.postedFiscalYear} is not null and ${t.postedAt} is not null and ${t.postedByUser} is not null)`),
  index('parked_journal_status_idx').on(t.client, t.companyCode, t.status, t.postingDate),
]);

/** One staged line of a parked journal (SCR-087). */
export const parkedJournalLine = pgTable('parked_journal_line', {
  client: tenantClient(),
  parkedNumber: varchar('parked_number', { length: 20 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  lineNumber: integer('line_number').notNull(),
  glAccount: varchar('gl_account', { length: 10 }).notNull(),
  debitCredit: char('debit_credit', { length: 1 }).notNull(),
  amount: numeric('amount', { precision: 23, scale: 4 }).notNull(),
  costCenter: varchar('cost_center', { length: 20 }),
  profitCenter: varchar('profit_center', { length: 20 }),
  taxCode: varchar('tax_code', { length: 4 }),
  /** Retained on the parked record; the house journal line has no assignment column. */
  assignment: varchar('assignment', { length: 18 }),
  lineText: varchar('line_text', { length: 100 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.parkedNumber, t.fiscalYear, t.lineNumber] }),
  foreignKey({
    columns: [t.client, t.parkedNumber],
    foreignColumns: [parkedJournalHeader.client, parkedJournalHeader.parkedNumber],
    name: 'parked_journal_line_header_fk',
  }),
  check('parked_journal_line_dc_ck', sql`${t.debitCredit} in ('S', 'H')`),
  check('parked_journal_line_amount_ck', sql`${t.amount} > 0`),
  index('parked_journal_line_gl_idx').on(t.client, t.glAccount),
]);

export const incomingPayment = pgTable('incoming_payment', {  client: tenantClient(),
  paymentNumber: varchar('payment_number', { length: 20 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  customerNumber: varchar('customer_number', { length: 20 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  documentDate: date('document_date', { mode: 'string' }).notNull(),
  postingDate: date('posting_date', { mode: 'string' }).notNull(),
  clearingDate: date('clearing_date', { mode: 'string' }).notNull(),
  bankGlAccount: varchar('bank_gl_account', { length: 10 }).notNull(),
  amount: numeric('amount', { precision: 23, scale: 4 }).notNull(),
  /** Completion totals (SCR-079 / R-127): discount taken and the on-account remainder of this receipt. */
  discountAmount: numeric('discount_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  onAccountAmount: numeric('on_account_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  currency: char('currency', { length: 3 }).notNull(),
  reference: varchar('reference', { length: 16 }),
  journalDocumentNumber: varchar('journal_document_number', { length: 40 }).notNull(),
  itemsCleared: integer('items_cleared').notNull(),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.paymentNumber] }),
]);

/** Reversal reason register (SCR-072 / R-120). Tenant-configured reversal reasons; 2-char code at STGRD parity. Never edited while in use — deactivation only. */
export const reversalReason = pgTable('reversal_reason', {
  client: tenantClient(),
  reasonCode: varchar('reason_code', { length: 2 }).notNull(),
  reasonDescription: varchar('reason_description', { length: 80 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.reasonCode] }),
]);

/** Accounting reversal link (SCR-072 / R-120). One successful reversal ever per original; identity unique both ways. */
export const accountingReversalLink = pgTable('accounting_reversal_link', {
  client: tenantClient(),
  originalCompanyCode: varchar('original_company_code', { length: 10 }).notNull(),
  originalDocumentNumber: varchar('original_document_number', { length: 40 }).notNull(),
  originalFiscalYear: integer('original_fiscal_year').notNull(),
  reversalCompanyCode: varchar('reversal_company_code', { length: 10 }).notNull(),
  reversalDocumentNumber: varchar('reversal_document_number', { length: 40 }).notNull(),
  reversalFiscalYear: integer('reversal_fiscal_year').notNull(),
  reversalReason: varchar('reversal_reason', { length: 2 }).notNull(),
  reversalDocumentDate: date('reversal_document_date', { mode: 'string' }).notNull(),
  reversalPostingPeriod: integer('reversal_posting_period').notNull(),
  reversalPostingDate: date('reversal_posting_date', { mode: 'string' }).notNull(),
  reversalCurrency: char('reversal_currency', { length: 3 }),
  reversedBy: varchar('reversed_by', { length: 60 }).notNull(),
  reversalAmountLocal: numeric('reversal_amount_local', { precision: 23, scale: 4 }).notNull().default('0'),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.originalCompanyCode, t.originalDocumentNumber, t.originalFiscalYear] }),
  uniqueIndex('accounting_reversal_link_reversal_uq').on(t.client, t.reversalCompanyCode, t.reversalDocumentNumber, t.reversalFiscalYear),
  index('accounting_reversal_link_reason_idx').on(t.client, t.reversalReason),
  index('accounting_reversal_link_reversal_idx').on(t.client, t.reversalDocumentNumber),
]);

/** Clearing reset record (SCR-071 / R-119). Retained evidence of a reset: never edited or deleted. */
export const clearingReset = pgTable('clearing_reset', {
  client: tenantClient(),
  resetNumber: varchar('reset_number', { length: 20 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  clearingDocument: varchar('clearing_document', { length: 40 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  clearingDate: date('clearing_date', { mode: 'string' }).notNull(),
  itemsReset: integer('items_reset').notNull(),
  itemRefs: text('item_refs').notNull(),
  reason: varchar('reason', { length: 500 }).notNull(),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.resetNumber] }),
]);

/** Dunning run (SCR-074 / R-122). Parameters of one dunning execution; identity is run date + identification. */
export const dunningRun = pgTable('dunning_run', {
  client: tenantClient(),
  runDate: date('run_date', { mode: 'string' }).notNull(),
  runId: varchar('run_id', { length: 6 }).notNull(),
  dunningDate: date('dunning_date', { mode: 'string' }).notNull(),
  postedThroughDate: date('posted_through_date', { mode: 'string' }).notNull(),
  accountType: varchar('account_type', { length: 8 }).notNull().default('CUSTOMER'),
  status: varchar('status', { length: 12 }).notNull().default('PARAMETERS'),
  customerFrom: varchar('customer_from', { length: 40 }),
  customerTo: varchar('customer_to', { length: 40 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.runDate, t.runId] }),
  check('dunning_run_id_ck', sql`length(${t.runId}) between 1 and 6`),
  check('dunning_run_type_ck', sql`${t.accountType} = 'CUSTOMER'`),
  check('dunning_run_status_ck', sql`${t.status} in ('PARAMETERS', 'PROPOSED', 'COMPLETED', 'CANCELLED')`),
  check('dunning_run_cutoff_ck', sql`${t.postedThroughDate} <= ${t.dunningDate}`),
]);

/** Company codes a dunning run processes (SCR-074 / R-122). */
export const dunningRunCompany = pgTable('dunning_run_company', {
  client: tenantClient(),
  runDate: date('run_date', { mode: 'string' }).notNull(),
  runId: varchar('run_id', { length: 6 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.runDate, t.runId, t.companyCode] }),
  foreignKey({ columns: [t.client, t.runDate, t.runId], foreignColumns: [dunningRun.client, dunningRun.runDate, dunningRun.runId] }).onDelete('cascade'),
]);

/** Account-level dunning result (SCR-074 / R-122): a proposed level, or a named exception. */
export const dunningRunAccount = pgTable('dunning_run_account', {
  client: tenantClient(),
  runDate: date('run_date', { mode: 'string' }).notNull(),
  runId: varchar('run_id', { length: 6 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  customer: varchar('customer', { length: 40 }).notNull(),
  proposedLevel: integer('proposed_level'),
  currency: char('currency', { length: 3 }),
  totalOverdue: numeric('total_overdue', { precision: 23, scale: 4 }).notNull().default('0'),
  status: varchar('status', { length: 12 }).notNull().default('PROPOSED'),
  exceptionReason: varchar('exception_reason', { length: 500 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.runDate, t.runId, t.companyCode, t.customer] }),
  foreignKey({
    columns: [t.client, t.runDate, t.runId, t.companyCode],
    foreignColumns: [dunningRunCompany.client, dunningRunCompany.runDate, dunningRunCompany.runId, dunningRunCompany.companyCode],
  }).onDelete('cascade'),
  check('dunning_run_account_status_ck', sql`${t.status} in ('PROPOSED', 'EXCLUDED', 'COMPLETED')`),
  check('dunning_run_account_level_ck', sql`${t.proposedLevel} is null or ${t.proposedLevel} >= 1`),
]);

/** Item-level dunning proposal (SCR-074 / R-122): one overdue item at its proposed level. */
export const dunningRunItem = pgTable('dunning_run_item', {
  client: tenantClient(),
  runDate: date('run_date', { mode: 'string' }).notNull(),
  runId: varchar('run_id', { length: 6 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  customer: varchar('customer', { length: 40 }).notNull(),
  documentNumber: varchar('document_number', { length: 40 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  lineNumber: integer('line_number').notNull(),
  dueDate: date('due_date', { mode: 'string' }).notNull(),
  daysOverdue: integer('days_overdue').notNull(),
  overdueAmount: numeric('overdue_amount', { precision: 23, scale: 4 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  proposedLevel: integer('proposed_level').notNull(),
  status: varchar('status', { length: 12 }).notNull().default('PROPOSED'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.runDate, t.runId, t.companyCode, t.customer, t.documentNumber, t.fiscalYear, t.lineNumber] }),
  foreignKey({
    columns: [t.client, t.runDate, t.runId, t.companyCode, t.customer],
    foreignColumns: [dunningRunAccount.client, dunningRunAccount.runDate, dunningRunAccount.runId, dunningRunAccount.companyCode, dunningRunAccount.customer],
  }).onDelete('cascade'),
  check('dunning_run_item_status_ck', sql`${t.status} in ('PROPOSED', 'EXCLUDED', 'COMPLETED')`),
  check('dunning_run_item_amount_ck', sql`${t.overdueAmount} > 0`),
  check('dunning_run_item_level_ck', sql`${t.proposedLevel} >= 1`),
  index('dunning_run_item_source_idx').on(t.client, t.documentNumber, t.fiscalYear, t.lineNumber),
]);

/** Dunning notice (SCR-074 / R-122): one per account at finalization; a record, never a posting. */
export const dunningNotice = pgTable('dunning_notice', {
  client: tenantClient(),
  noticeNumber: varchar('notice_number', { length: 80 }).notNull(),
  runDate: date('run_date', { mode: 'string' }).notNull(),
  runId: varchar('run_id', { length: 6 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  customer: varchar('customer', { length: 40 }).notNull(),
  dunningLevel: integer('dunning_level').notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  amount: numeric('amount', { precision: 23, scale: 4 }).notNull(),
  noticeDate: date('notice_date', { mode: 'string' }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.noticeNumber] }),
  uniqueIndex('dunning_notice_run_account_uq').on(t.client, t.runDate, t.runId, t.companyCode, t.customer),
  check('dunning_notice_level_ck', sql`${t.dunningLevel} >= 1`),
]);

/** Direct vendor invoice header (SCR-075 / R-123). The KR journal is the authoritative posting. */
export const vendorInvoice = pgTable('vendor_invoice', {
  client: tenantClient(),
  invoiceNumber: varchar('invoice_number', { length: 20 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  category: varchar('category', { length: 12 }).notNull().default('INVOICE'),
  creditOf: varchar('credit_of', { length: 20 }),
  vendorNumber: varchar('vendor_number', { length: 40 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  documentDate: date('document_date', { mode: 'string' }).notNull(),
  postingDate: date('posting_date', { mode: 'string' }).notNull(),
  reference: varchar('reference', { length: 40 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  grossAmount: numeric('gross_amount', { precision: 23, scale: 4 }).notNull(),
  taxAmount: numeric('tax_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  paymentTerms: varchar('payment_terms', { length: 12 }),
  baselineDate: date('baseline_date', { mode: 'string' }),
  dueDate: date('due_date', { mode: 'string' }),
  headerText: varchar('header_text', { length: 100 }),
  status: varchar('status', { length: 12 }).notNull().default('POSTED'),
  journalDocumentNumber: varchar('journal_document_number', { length: 40 }),
  cancelledBy: varchar('cancelled_by', { length: 20 }),
  cancellationOf: varchar('cancellation_of', { length: 20 }),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.invoiceNumber] }),
  check('vendor_invoice_category_ck', sql`${t.category} in ('INVOICE', 'CREDIT_MEMO')`),
  check('vendor_invoice_status_ck', sql`${t.status} in ('POSTED', 'CANCELLED')`),
  check('vendor_invoice_gross_ck', sql`${t.grossAmount} > 0`),
  uniqueIndex('vendor_invoice_request_key_uq').on(t.client, t.requestKey),
]);

/** Direct vendor invoice line (SCR-075 / R-123): a tax-exclusive net amount and its assignments. */
export const vendorInvoiceLine = pgTable('vendor_invoice_line', {
  client: tenantClient(),
  invoiceNumber: varchar('invoice_number', { length: 20 }).notNull(),
  lineNumber: integer('line_number').notNull(),
  glAccount: varchar('gl_account', { length: 10 }).notNull(),
  netAmount: numeric('net_amount', { precision: 23, scale: 4 }).notNull(),
  taxCode: varchar('tax_code', { length: 4 }),
  taxAmount: numeric('tax_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  costCenter: varchar('cost_center', { length: 20 }),
  profitCenter: varchar('profit_center', { length: 20 }),
  lineText: varchar('line_text', { length: 100 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.invoiceNumber, t.lineNumber] }),
  foreignKey({ columns: [t.client, t.invoiceNumber], foreignColumns: [vendorInvoice.client, vendorInvoice.invoiceNumber] }).onDelete('restrict'),
  check('vendor_invoice_line_amount_ck', sql`${t.netAmount} > 0`),
]);

/**
 * Customer credit management (SCR-103 / R-151): judged credit
 * vocabularies, the per-customer/area credit record with
 * optimistic-locking version, and the append-only change audit.
 */
export const creditRiskCategory = pgTable('credit_risk_category', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  riskCategory: varchar('risk_category', { length: 3 }).notNull(),
  name: varchar('name', { length: 80 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.client, t.riskCategory] })]);

export const creditRepresentativeGroup = pgTable('credit_representative_group', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  groupCode: varchar('group_code', { length: 3 }).notNull(),
  name: varchar('name', { length: 80 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.client, t.groupCode] })]);

export const customerCreditGroup = pgTable('customer_credit_group', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  groupCode: varchar('group_code', { length: 4 }).notNull(),
  name: varchar('name', { length: 80 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.client, t.groupCode] })]);

export const creditBlockReason = pgTable('credit_block_reason', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  reasonCode: varchar('reason_code', { length: 2 }).notNull(),
  name: varchar('name', { length: 80 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.client, t.reasonCode] })]);

export const customerCredit = pgTable('customer_credit', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  customer: varchar('customer', { length: 40 }).notNull(),
  creditControlArea: varchar('credit_control_area', { length: 4 }).notNull(),
  creditLimit: numeric('credit_limit', { precision: 23, scale: 4 }).notNull(),
  creditCurrency: char('credit_currency', { length: 3 }).notNull(),
  riskCategory: varchar('risk_category', { length: 3 }).notNull(),
  creditRepresentativeGroup: varchar('credit_representative_group', { length: 3 }),
  creditLimitValidTo: date('credit_limit_valid_to', { mode: 'string' }),
  customerCreditGroup: varchar('customer_credit_group', { length: 4 }),
  isBlocked: boolean('is_on_hold').notNull().default(false),
  blockReason: varchar('block_reason', { length: 2 }),
  version: integer('version').notNull().default(1),
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: varchar('updated_by', { length: 60 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.client, t.customer, t.creditControlArea] }),
  index('customer_credit_area_idx').on(t.client, t.creditControlArea, t.customer),
  foreignKey({
    columns: [t.client, t.customer],
    foreignColumns: [businessPartner.client, businessPartner.partnerNumber],
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.client, t.creditControlArea],
    foreignColumns: [creditControlArea.client, creditControlArea.creditControlArea],
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.client, t.riskCategory],
    foreignColumns: [creditRiskCategory.client, creditRiskCategory.riskCategory],
  }),
  foreignKey({
    columns: [t.client, t.creditRepresentativeGroup],
    foreignColumns: [creditRepresentativeGroup.client, creditRepresentativeGroup.groupCode],
  }),
  foreignKey({
    columns: [t.client, t.customerCreditGroup],
    foreignColumns: [customerCreditGroup.client, customerCreditGroup.groupCode],
  }),
  check('customer_credit_limit_ck', sql`${t.creditLimit} >= 0`),
  check('customer_credit_block_ck', sql`(${t.isBlocked} and ${t.blockReason} is not null) or not ${t.isBlocked}`),
]);

export const creditChangeAudit = pgTable('credit_change_audit', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  auditId: varchar('audit_id', { length: 24 }).notNull(),
  customer: varchar('customer', { length: 40 }).notNull(),
  creditControlArea: varchar('credit_control_area', { length: 4 }).notNull(),
  field: varchar('field', { length: 40 }).notNull(),
  previousValue: varchar('previous_value', { length: 120 }),
  newValue: varchar('new_value', { length: 120 }),
  changedBy: varchar('changed_by', { length: 60 }).notNull(),
  changeReason: varchar('change_reason', { length: 240 }).notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.auditId] }),
  foreignKey({
    columns: [t.client, t.customer, t.creditControlArea],
    foreignColumns: [customerCredit.client, customerCredit.customer, customerCredit.creditControlArea],
  }).onDelete('cascade'),
  index('credit_change_audit_record_idx').on(t.client, t.customer, t.creditControlArea, t.changedAt),
]);

/**
 * Credit determinations (SCR-105 / R-153): the single
 * authoritative credit status per sales document, superseding
 * rather than editing, with an append-only release event trail.
 */
export const creditDetermination = pgTable('credit_determination', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  determinationId: varchar('determination_id', { length: 24 }).notNull(),
  salesDocument: varchar('sales_document', { length: 20 }).notNull(),
  documentDate: date('document_date', { mode: 'string' }).notNull(),
  salesOrg: varchar('sales_org', { length: 4 }),
  customer: varchar('customer', { length: 40 }).notNull(),
  creditControlArea: varchar('credit_control_area', { length: 4 }).notNull(),
  orderValue: numeric('order_value', { precision: 23, scale: 4 }).notNull(),
  orderCurrency: char('order_currency', { length: 3 }).notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  reason: varchar('reason', { length: 24 }).notNull(),
  exposureAtCheck: numeric('exposure_at_check', { precision: 23, scale: 4 }).notNull().default('0'),
  limitAtCheck: numeric('limit_at_check', { precision: 23, scale: 4 }),
  releasedBy: varchar('released_by', { length: 60 }),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  isOverride: boolean('is_override').notNull().default(false),
  approvalRef: varchar('approval_ref', { length: 40 }),
  supersedes: varchar('supersedes', { length: 24 }),
  version: integer('version').notNull().default(1),
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.determinationId] }),
  foreignKey({
    columns: [t.client, t.customer],
    foreignColumns: [businessPartner.client, businessPartner.partnerNumber],
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.client, t.creditControlArea],
    foreignColumns: [creditControlArea.client, creditControlArea.creditControlArea],
  }).onDelete('cascade'),
  index('credit_determination_scope_idx').on(t.client, t.creditControlArea, t.status, t.documentDate, t.customer),
  index('credit_determination_document_idx').on(t.client, t.salesDocument, t.createdAt),
  check('credit_determination_status_ck', sql`${t.status} in ('BLOCKED', 'PASSED', 'RELEASED')`),
  check('credit_determination_value_ck', sql`${t.orderValue} >= 0`),
  check('credit_determination_released_ck', sql`(${t.status} = 'RELEASED') = (${t.releasedBy} is not null and ${t.releasedAt} is not null)`),
]);

export const creditReleaseEvent = pgTable('credit_release_event', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  eventId: varchar('event_id', { length: 24 }).notNull(),
  determinationId: varchar('determination_id', { length: 24 }).notNull(),
  salesDocument: varchar('sales_document', { length: 20 }).notNull(),
  eventType: varchar('event_type', { length: 20 }).notNull(),
  actor: varchar('actor', { length: 60 }).notNull(),
  reason: varchar('reason', { length: 240 }),
  approvalRef: varchar('approval_ref', { length: 40 }),
  beforeStatus: varchar('before_status', { length: 16 }),
  afterStatus: varchar('after_status', { length: 16 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.eventId] }),
  foreignKey({
    columns: [t.client, t.determinationId],
    foreignColumns: [creditDetermination.client, creditDetermination.determinationId],
  }).onDelete('cascade'),
  check('credit_release_event_type_ck', sql`${t.eventType} in ('CHECK', 'RELEASE', 'OVERRIDE_RELEASE', 'REJECT', 'REBLOCK')`),
]);

/**
 * Financial statement versions (SCR-106 / R-154): the version
 * binds to a chart, nodes form the hierarchy, assignments place
 * account ranges with a presentation sign. Configuration only —
 * statements derive and persist nothing.
 */
export const financialStatementVersion = pgTable('financial_statement_version', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  version: varchar('version', { length: 10 }).notNull(),
  name: varchar('name', { length: 80 }).notNull(),
  chartOfAccounts: varchar('chart_of_accounts', { length: 4 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.version] }),
  foreignKey({
    columns: [t.client, t.chartOfAccounts],
    foreignColumns: [chartOfAccounts.client, chartOfAccounts.chartOfAccounts],
  }).onDelete('cascade'),
]);

export const financialStatementNode = pgTable('financial_statement_node', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  version: varchar('version', { length: 10 }).notNull(),
  node: varchar('node', { length: 20 }).notNull(),
  description: varchar('description', { length: 120 }).notNull(),
  parentNode: varchar('parent_node', { length: 20 }),
  sequence: integer('sequence').notNull().default(0),
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.version, t.node] }),
  foreignKey({
    columns: [t.client, t.version],
    foreignColumns: [financialStatementVersion.client, financialStatementVersion.version],
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.client, t.version, t.parentNode],
    foreignColumns: [t.client, t.version, t.node],
  }).onDelete('cascade'),
  check('financial_statement_node_parent_ck', sql`${t.parentNode} is null or ${t.parentNode} <> ${t.node}`),
]);

export const financialStatementAssignment = pgTable('financial_statement_assignment', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  version: varchar('version', { length: 10 }).notNull(),
  node: varchar('node', { length: 20 }).notNull(),
  accountFrom: varchar('account_from', { length: 10 }).notNull(),
  accountTo: varchar('account_to', { length: 10 }).notNull(),
  presentationSign: varchar('presentation_sign', { length: 8 }).notNull().default('NORMAL'),
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.version, t.node, t.accountFrom, t.accountTo] }),
  foreignKey({
    columns: [t.client, t.version, t.node],
    foreignColumns: [financialStatementNode.client, financialStatementNode.version, financialStatementNode.node],
  }).onDelete('cascade'),
  check('financial_statement_assignment_sign_ck', sql`${t.presentationSign} in ('NORMAL', 'INVERTED')`),
  check('financial_statement_assignment_range_ck', sql`${t.accountFrom} <= ${t.accountTo}`),
]);

/**
 * Company-code segment of the G/L master (SCR-110 / R-158):
 * account currency, tax category, open-item management, sort
 * key and posting block per company. Where a row stands it
 * governs; the chart-level flag remains the fallback.
 */
export const glAccountCompany = pgTable('gl_account_company', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  chartOfAccounts: varchar('chart_of_accounts', { length: 4 }).notNull(),
  glAccount: varchar('gl_account', { length: 10 }).notNull(),
  accountCurrency: char('account_currency', { length: 3 }).notNull(),
  taxCategory: varchar('tax_category', { length: 2 }),
  isOpenItemManaged: boolean('is_open_item_managed').notNull().default(false),
  sortKey: varchar('sort_key', { length: 3 }).notNull().default('000'),
  isBlockedPosting: boolean('is_blocked_posting').notNull().default(false),
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: varchar('updated_by', { length: 60 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.client, t.companyCode, t.glAccount] }),
  foreignKey({
    columns: [t.client, t.chartOfAccounts, t.glAccount],
    foreignColumns: [glAccount.client, glAccount.chartOfAccounts, glAccount.accountNumber],
  }).onDelete('cascade'),
  index('gl_account_company_chart_idx').on(t.client, t.chartOfAccounts, t.glAccount),
]);

/** FS15 transfer run header (SCR-110): execution metadata. */
export const glAccountTransferRun = pgTable('gl_account_transfer_run', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  runId: varchar('run_id', { length: 24 }).notNull(),
  sourceCompanyCode: varchar('source_company_code', { length: 10 }).notNull(),
  targetCompanyCode: varchar('target_company_code', { length: 10 }).notNull(),
  chartOfAccounts: varchar('chart_of_accounts', { length: 4 }).notNull(),
  accountFrom: varchar('account_from', { length: 10 }),
  accountTo: varchar('account_to', { length: 10 }),
  testRun: boolean('test_run').notNull(),
  withCompanyData: boolean('with_company_data').notNull(),
  overwriteExisting: boolean('overwrite_existing').notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  executedBy: varchar('executed_by', { length: 60 }).notNull(),
  executedAt: timestamp('executed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.runId] }),
  check('gl_account_transfer_run_status_ck', sql`${t.status} in ('COMPLETED', 'PARTIALLY_FAILED', 'FAILED')`),
  check('gl_account_transfer_run_companies_ck', sql`${t.sourceCompanyCode} <> ${t.targetCompanyCode}`),
]);

/** Per-account protocol of an FS15 run (SCR-110). */
export const glAccountTransferResult = pgTable('gl_account_transfer_result', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  runId: varchar('run_id', { length: 24 }).notNull(),
  glAccount: varchar('gl_account', { length: 10 }).notNull(),
  action: varchar('action', { length: 10 }).notNull(),
  reason: varchar('reason', { length: 400 }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.client, t.runId, t.glAccount] }),
  foreignKey({
    columns: [t.client, t.runId],
    foreignColumns: [glAccountTransferRun.client, glAccountTransferRun.runId],
  }).onDelete('cascade'),
  check('gl_account_transfer_result_action_ck', sql`${t.action} in ('CREATED', 'UPDATED', 'SKIPPED', 'ERROR')`),
]);


const consAudit = {
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: varchar('updated_by', { length: 60 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
};

/** Consolidation data basis (SCR-116): binds the standing journal provider. */
export const consolidationDataBasis = pgTable('consolidation_data_basis', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  basis: varchar('basis', { length: 24 }).notNull(),
  title: varchar('title', { length: 80 }).notNull(),
  provider: varchar('provider', { length: 12 }).notNull().default('JOURNAL'),
  ...consAudit,
}, (t) => [
  primaryKey({ columns: [t.client, t.basis] }),
  check('consolidation_data_basis_provider_ck', sql`${t.provider} = 'JOURNAL'`),
]);

export const consolidationDimension = pgTable('consolidation_dimension', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  basis: varchar('basis', { length: 24 }).notNull(),
  dimension: varchar('dimension', { length: 24 }).notNull(),
  sourceField: varchar('source_field', { length: 40 }).notNull(),
  ...consAudit,
}, (t) => [
  primaryKey({ columns: [t.client, t.basis, t.dimension] }),
  foreignKey({
    columns: [t.client, t.basis],
    foreignColumns: [consolidationDataBasis.client, consolidationDataBasis.basis],
  }).onDelete('cascade'),
]);

export const consolidationArea = pgTable('consolidation_area', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  area: varchar('area', { length: 4 }).notNull(),
  title: varchar('title', { length: 80 }).notNull(),
  dataBasis: varchar('data_basis', { length: 24 }).notNull(),
  consChart: varchar('cons_chart', { length: 4 }).notNull(),
  fiscalYearVariant: varchar('fiscal_year_variant', { length: 2 }).notNull(),
  status: varchar('status', { length: 8 }).notNull().default('DRAFT'),
  ...consAudit,
}, (t) => [
  primaryKey({ columns: [t.client, t.area] }),
  foreignKey({
    columns: [t.client, t.dataBasis],
    foreignColumns: [consolidationDataBasis.client, consolidationDataBasis.basis],
  }),
  foreignKey({
    columns: [t.client, t.fiscalYearVariant],
    foreignColumns: [fiscalYearVariant.client, fiscalYearVariant.variant],
  }),
  check('consolidation_area_status_ck', sql`${t.status} in ('DRAFT', 'ACTIVE')`),
]);

export const consolidationUnit = pgTable('consolidation_unit', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  area: varchar('area', { length: 4 }).notNull(),
  unit: varchar('unit', { length: 10 }).notNull(),
  title: varchar('title', { length: 80 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  ...consAudit,
}, (t) => [
  primaryKey({ columns: [t.client, t.area, t.unit] }),
  foreignKey({
    columns: [t.client, t.area],
    foreignColumns: [consolidationArea.client, consolidationArea.area],
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.client, t.companyCode],
    foreignColumns: [foundationCompanyCode.client, foundationCompanyCode.companyCode],
  }),
]);

export const consolidationGroup = pgTable('consolidation_group', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  area: varchar('area', { length: 4 }).notNull(),
  groupName: varchar('group_name', { length: 24 }).notNull(),
  title: varchar('title', { length: 80 }).notNull(),
  parentGroup: varchar('parent_group', { length: 24 }),
  ...consAudit,
}, (t) => [
  primaryKey({ columns: [t.client, t.area, t.groupName] }),
  foreignKey({
    columns: [t.client, t.area],
    foreignColumns: [consolidationArea.client, consolidationArea.area],
  }).onDelete('cascade'),
]);

export const consolidationUnitAssignment = pgTable('consolidation_unit_assignment', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  area: varchar('area', { length: 4 }).notNull(),
  groupName: varchar('group_name', { length: 24 }).notNull(),
  unit: varchar('unit', { length: 10 }).notNull(),
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to').notNull(),
  ...consAudit,
}, (t) => [
  primaryKey({ columns: [t.client, t.area, t.groupName, t.unit, t.validFrom] }),
  foreignKey({
    columns: [t.client, t.area, t.groupName],
    foreignColumns: [consolidationGroup.client, consolidationGroup.area, consolidationGroup.groupName],
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.client, t.area, t.unit],
    foreignColumns: [consolidationUnit.client, consolidationUnit.area, consolidationUnit.unit],
  }).onDelete('cascade'),
  check('consolidation_unit_assignment_validity_ck', sql`${t.validFrom} <= ${t.validTo}`),
]);

export const consolidationGroupAccount = pgTable('consolidation_group_account', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  consChart: varchar('cons_chart', { length: 4 }).notNull(),
  account: varchar('account', { length: 10 }).notNull(),
  title: varchar('title', { length: 80 }).notNull(),
  ...consAudit,
}, (t) => [
  primaryKey({ columns: [t.client, t.consChart, t.account] }),
]);

export const consolidationAccountMapping = pgTable('consolidation_account_mapping', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  consChart: varchar('cons_chart', { length: 4 }).notNull(),
  sourceChart: varchar('source_chart', { length: 4 }).notNull(),
  sourceFrom: varchar('source_from', { length: 10 }).notNull(),
  sourceTo: varchar('source_to', { length: 10 }).notNull(),
  groupAccount: varchar('group_account', { length: 10 }).notNull(),
  ...consAudit,
}, (t) => [
  primaryKey({ columns: [t.client, t.consChart, t.sourceChart, t.sourceFrom, t.sourceTo] }),
  foreignKey({
    columns: [t.client, t.consChart, t.groupAccount],
    foreignColumns: [consolidationGroupAccount.client, consolidationGroupAccount.consChart, consolidationGroupAccount.account],
  }),
  check('consolidation_account_mapping_range_ck', sql`${t.sourceFrom} <= ${t.sourceTo}`),
]);

export const consolidationMethod = pgTable('consolidation_method', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  area: varchar('area', { length: 4 }).notNull(),
  method: varchar('method', { length: 12 }).notNull(),
  kind: varchar('kind', { length: 24 }).notNull(),
  title: varchar('title', { length: 80 }).notNull(),
  ...consAudit,
}, (t) => [
  primaryKey({ columns: [t.client, t.area, t.method] }),
  foreignKey({
    columns: [t.client, t.area],
    foreignColumns: [consolidationArea.client, consolidationArea.area],
  }).onDelete('cascade'),
  check('consolidation_method_kind_ck', sql`${t.kind} in ('CURRENCY_TRANSLATION', 'INTERCOMPANY_ELIMINATION', 'INVESTMENT', 'OTHER')`),
]);

export const consolidationVersion = pgTable('consolidation_version', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  area: varchar('area', { length: 4 }).notNull(),
  version: varchar('version', { length: 3 }).notNull(),
  title: varchar('title', { length: 80 }).notNull(),
  ...consAudit,
}, (t) => [
  primaryKey({ columns: [t.client, t.area, t.version] }),
  foreignKey({
    columns: [t.client, t.area],
    foreignColumns: [consolidationArea.client, consolidationArea.area],
  }).onDelete('cascade'),
]);

export const consolidationTask = pgTable('consolidation_task', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  area: varchar('area', { length: 4 }).notNull(),
  version: varchar('version', { length: 3 }).notNull(),
  task: varchar('task', { length: 16 }).notNull(),
  parentTask: varchar('parent_task', { length: 16 }),
  sequence: integer('sequence').notNull().default(10),
  taskType: varchar('task_type', { length: 24 }).notNull(),
  method: varchar('method', { length: 12 }),
  unit: varchar('unit', { length: 10 }),
  groupName: varchar('group_name', { length: 24 }),
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to').notNull(),
  ...consAudit,
}, (t) => [
  primaryKey({ columns: [t.client, t.area, t.version, t.task] }),
  foreignKey({
    columns: [t.client, t.area, t.version],
    foreignColumns: [consolidationVersion.client, consolidationVersion.area, consolidationVersion.version],
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.client, t.area, t.method],
    foreignColumns: [consolidationMethod.client, consolidationMethod.area, consolidationMethod.method],
  }),
  foreignKey({
    columns: [t.client, t.area, t.unit],
    foreignColumns: [consolidationUnit.client, consolidationUnit.area, consolidationUnit.unit],
  }),
  foreignKey({
    columns: [t.client, t.area, t.groupName],
    foreignColumns: [consolidationGroup.client, consolidationGroup.area, consolidationGroup.groupName],
  }),
  check('consolidation_task_type_ck', sql`${t.taskType} in ('DATA_COLLECTION', 'CURRENCY_TRANSLATION', 'ELIMINATION', 'INVESTMENT', 'VALIDATION', 'OTHER')`),
  check('consolidation_task_validity_ck', sql`${t.validFrom} <= ${t.validTo}`),
]);

/** Consolidation monitor execution attempt (SCR-117): immutable attempt history. */
export const consolidationExecution = pgTable('consolidation_execution', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  runId: varchar('run_id', { length: 24 }).notNull(),
  area: varchar('area', { length: 4 }).notNull(),
  groupName: varchar('group_name', { length: 24 }).notNull(),
  unit: varchar('unit', { length: 10 }),
  unitScope: varchar('unit_scope', { length: 10 }).notNull().default(''),
  version: varchar('version', { length: 3 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  period: integer('period').notNull(),
  task: varchar('task', { length: 16 }).notNull(),
  configurationVersion: varchar('configuration_version', { length: 64 }).notNull(),
  configurationSnapshot: text('configuration_snapshot').notNull(),
  attemptNumber: integer('attempt_number').notNull(),
  mode: varchar('mode', { length: 6 }).notNull(),
  status: varchar('status', { length: 10 }).notNull().default('RUNNING'),
  executedBy: varchar('executed_by', { length: 60 }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  durationMs: integer('duration_ms'),
  resultSummary: text('result_summary').notNull().default(''),
  processedCount: integer('processed_count').notNull().default(0),
  warningCount: integer('warning_count').notNull().default(0),
  errorCount: integer('error_count').notNull().default(0),
  generatedDocumentRefs: text('generated_document_refs').notNull().default('[]'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.runId] }),
  foreignKey({
    columns: [t.client, t.area],
    foreignColumns: [consolidationArea.client, consolidationArea.area],
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.client, t.area, t.groupName],
    foreignColumns: [consolidationGroup.client, consolidationGroup.area, consolidationGroup.groupName],
  }),
  foreignKey({
    columns: [t.client, t.area, t.unit],
    foreignColumns: [consolidationUnit.client, consolidationUnit.area, consolidationUnit.unit],
  }),
  foreignKey({
    columns: [t.client, t.area, t.version],
    foreignColumns: [consolidationVersion.client, consolidationVersion.area, consolidationVersion.version],
  }),
  foreignKey({
    columns: [t.client, t.area, t.version, t.task],
    foreignColumns: [consolidationTask.client, consolidationTask.area, consolidationTask.version, consolidationTask.task],
  }),
  uniqueIndex('consolidation_execution_running_uq')
    .on(t.client, t.area, t.groupName, t.unitScope, t.version, t.fiscalYear, t.period, t.task)
    .where(sql`${t.status} = 'RUNNING'`),
  index('consolidation_execution_scope_idx')
    .on(t.client, t.area, t.groupName, t.version, t.fiscalYear, t.period, t.task, t.startedAt),
  check('consolidation_execution_mode_ck', sql`${t.mode} in ('TEST', 'UPDATE')`),
  check('consolidation_execution_status_ck', sql`${t.status} in ('RUNNING', 'COMPLETED', 'WARNING', 'ERROR', 'BLOCKED', 'CANCELLED')`),
  check('consolidation_execution_period_ck', sql`${t.period} between 1 and 20`),
  check('consolidation_execution_year_ck', sql`${t.fiscalYear} between 1900 and 2199`),
  check('consolidation_execution_attempt_ck', sql`${t.attemptNumber} >= 1`),
  check('consolidation_execution_unit_scope_ck', sql`${t.unitScope} = coalesce(${t.unit}, '')`),
]);

/** Append-only detail lines for one consolidation execution attempt. */
export const consolidationExecutionLog = pgTable('consolidation_execution_log', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  runId: varchar('run_id', { length: 24 }).notNull(),
  sequence: integer('sequence').notNull(),
  level: varchar('level', { length: 8 }).notNull(),
  message: text('message').notNull(),
  reference: varchar('reference', { length: 120 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.runId, t.sequence] }),
  foreignKey({
    columns: [t.client, t.runId],
    foreignColumns: [consolidationExecution.client, consolidationExecution.runId],
  }).onDelete('cascade'),
  check('consolidation_execution_log_level_ck', sql`${t.level} in ('INFO', 'WARNING', 'ERROR')`),
  check('consolidation_execution_log_sequence_ck', sql`${t.sequence} >= 1`),
]);

/** Current consolidation task state, separate from immutable execution history. */
export const consolidationTaskStatus = pgTable('consolidation_task_status', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  area: varchar('area', { length: 4 }).notNull(),
  groupName: varchar('group_name', { length: 24 }).notNull(),
  unit: varchar('unit', { length: 10 }),
  unitScope: varchar('unit_scope', { length: 10 }).notNull().default(''),
  version: varchar('version', { length: 3 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  period: integer('period').notNull(),
  task: varchar('task', { length: 16 }).notNull(),
  status: varchar('status', { length: 10 }).notNull().default('OPEN'),
  blockedReason: text('blocked_reason').notNull().default(''),
  latestRunId: varchar('latest_run_id', { length: 24 }),
  lastMode: varchar('last_mode', { length: 6 }),
  executedBy: varchar('executed_by', { length: 60 }),
  executedAt: timestamp('executed_at', { withTimezone: true }),
  durationMs: integer('duration_ms'),
  resultSummary: text('result_summary').notNull().default(''),
  warningCount: integer('warning_count').notNull().default(0),
  errorCount: integer('error_count').notNull().default(0),
  attemptCount: integer('attempt_count').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.area, t.groupName, t.unitScope, t.version, t.fiscalYear, t.period, t.task] }),
  foreignKey({
    columns: [t.client, t.area],
    foreignColumns: [consolidationArea.client, consolidationArea.area],
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.client, t.area, t.groupName],
    foreignColumns: [consolidationGroup.client, consolidationGroup.area, consolidationGroup.groupName],
  }),
  foreignKey({
    columns: [t.client, t.area, t.unit],
    foreignColumns: [consolidationUnit.client, consolidationUnit.area, consolidationUnit.unit],
  }),
  foreignKey({
    columns: [t.client, t.area, t.version],
    foreignColumns: [consolidationVersion.client, consolidationVersion.area, consolidationVersion.version],
  }),
  foreignKey({
    columns: [t.client, t.area, t.version, t.task],
    foreignColumns: [consolidationTask.client, consolidationTask.area, consolidationTask.version, consolidationTask.task],
  }),
  foreignKey({
    columns: [t.client, t.latestRunId],
    foreignColumns: [consolidationExecution.client, consolidationExecution.runId],
  }),
  index('consolidation_task_status_scope_idx')
    .on(t.client, t.area, t.groupName, t.version, t.fiscalYear, t.period, t.status),
  check('consolidation_task_status_status_ck', sql`${t.status} in ('OPEN', 'BLOCKED', 'RUNNING', 'COMPLETED', 'WARNING', 'ERROR')`),
  check('consolidation_task_status_mode_ck', sql`${t.lastMode} is null or ${t.lastMode} in ('TEST', 'UPDATE')`),
  check('consolidation_task_status_period_ck', sql`${t.period} between 1 and 20`),
  check('consolidation_task_status_year_ck', sql`${t.fiscalYear} between 1900 and 2199`),
  check('consolidation_task_status_unit_scope_ck', sql`${t.unitScope} = coalesce(${t.unit}, '')`),
]);
