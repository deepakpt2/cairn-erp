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
    index('journal_entry_company_posting_idx').on(t.client, t.companyCode, t.postingDate, t.documentNumber),
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
    index('jel_company_account_idx').on(t.client, t.companyCode, t.glAccount, t.fiscalYear, t.documentNumber, t.lineNumber),
    index('jel_costcenter_idx').on(t.client, t.costCenter),
    index('jel_clearing_idx').on(t.client, t.clearingDocument),
  ],
);

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
