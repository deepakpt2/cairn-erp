/**
 * Foundation — enterprise structure and financial configuration
 * CAIRN.md §6, §8.2, §14.3
 *
 * This module is requirement R-06 in schema form: define an object, then assign
 * it to something else. The tables here are what a company's implementation plan
 * is actually made of.
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
} from 'drizzle-orm/pg-core';
import { auditColumns, client } from '../../platform/tables/tenancy';

/* ══ Enterprise structure ═══════════════════════════════════════════════════ */

/** Chart of accounts — the list of accounts a company code keeps (§8.2). */
export const chartOfAccounts = pgTable(
  'chart_of_accounts',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    chartOfAccounts: varchar('chart_of_accounts', { length: 8 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    language: char('language', { length: 2 }).notNull().default('EN'),
    /** Account number length. Changing this after accounts exist is refused. */
    accountNumberLength: integer('account_number_length').notNull().default(6),
    /** Whether a group chart exists above this one (structural; consolidation). */
    groupChart: varchar('group_chart', { length: 8 }),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [primaryKey({ columns: [t.client, t.chartOfAccounts] })],
);

/** Fiscal year variant — how the year is split into periods (§8.2, §14.3). */
export const fiscalYearVariant = pgTable(
  'fiscal_year_variant',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    variant: varchar('variant', { length: 4 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    /** Number of ordinary posting periods: 12, or 13 for a 4-4-5 year. */
    regularPeriods: integer('regular_periods').notNull().default(12),
    /** Extra periods for year-end adjustment, usually 4. Never used for daily postings. */
    specialPeriods: integer('special_periods').notNull().default(4),
    /** True when period 1 starts in January. False for a shifted fiscal year. */
    isCalendarYear: boolean('is_calendar_year').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [primaryKey({ columns: [t.client, t.variant] })],
);

/**
 * One row per posting period, with its calendar mapping.
 *
 * Derived from the variant rather than hand-maintained, because a fiscal year
 * definition that disagrees with its own period list is a defect nobody finds
 * until an auditor does.
 */
export const fiscalYearPeriod = pgTable(
  'fiscal_year_period',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    variant: varchar('variant', { length: 4 }).notNull(),
    /** 1–12 for ordinary periods; 13+ for special periods. */
    period: integer('period').notNull(),
    /** REGULAR | SPECIAL */
    periodType: varchar('period_type', { length: 10 }).notNull(),
    /** Month (1–12) in which the period starts, within the fiscal year. */
    startMonth: integer('start_month').notNull(),
    startDay: integer('start_day').notNull().default(1),
    endMonth: integer('end_month').notNull(),
    /** 31 means "end of month"; the variant of the month handles the rest. */
    endDay: integer('end_day').notNull().default(31),
    name: varchar('name', { length: 60 }),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.variant, t.period] }),
    index('fiscal_year_period_variant_idx').on(t.client, t.variant),
  ],
);

/** Which account types may be posted in which periods (§14.3). */
export const postingPeriodVariant = pgTable(
  'posting_period_variant',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    variant: varchar('variant', { length: 4 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [primaryKey({ columns: [t.client, t.variant] })],
);

/**
 * The rule itself: for one account type, which periods are open.
 *
 * Account types follow the reference model's classification because the same
 * distinction matters to users and to auditors:
 *   S = general ledger, K = vendor, D = customer, A = asset, M = material.
 * A period is typically closed for vendors and customers first, to stop late
 * invoices, while the general ledger stays open for closing entries.
 */
export const postingPeriodRule = pgTable(
  'posting_period_rule',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    variant: varchar('variant', { length: 4 }).notNull(),
    accountType: char('account_type', { length: 1 }).notNull(),
    /** Open interval, inclusive. */
    periodFrom: integer('period_from').notNull(),
    periodTo: integer('period_to').notNull(),
    /** How many prior years remain open (rare, but real in practice). */
    yearShiftPast: integer('year_shift_past').notNull().default(0),
    /** How many future years may be posted to (usually 1, for next-year accruals). */
    yearShiftFuture: integer('year_shift_future').notNull().default(0),
    /** Special periods are permitted only when this is true. */
    allowSpecialPeriods: boolean('allow_special_periods').notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.variant, t.accountType] }),
  ],
);

/** Company code — the legal entity that keeps its own books (§6.1). */
export const companyCode = pgTable(
  'company_code',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    companyCode: varchar('company_code', { length: 10 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    /** Assignments — the "assign" half of the define/assign chain. */
    chartOfAccounts: varchar('chart_of_accounts', { length: 8 }).notNull(),
    fiscalYearVariant: varchar('fiscal_year_variant', { length: 4 }).notNull(),
    postingPeriodVariant: varchar('posting_period_variant', { length: 4 }).notNull(),
    /** Local currency: the books are kept in this currency (§14.4). */
    currency: char('currency', { length: 3 }).notNull(),
    country: char('country', { length: 2 }).notNull(),
    city: varchar('city', { length: 80 }),
    address: text('address'),
    language: char('language', { length: 2 }).notNull().default('EN'),
    taxRegistrationNumber: varchar('tax_registration_number', { length: 40 }),
    /** Credit control area for credit management (D-029). */
    creditControlArea: varchar('credit_control_area', { length: 4 }),
    /** Intercompany clearing account used when this company trades with affiliates. */
    intercompanyClearingAccount: varchar('intercompany_clearing_account', { length: 20 }),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.companyCode] }),
    index('company_code_coa_idx').on(t.client, t.chartOfAccounts),
  ],
);

/** Plant — a production or storage site belonging to exactly one company code. */
export const plant = pgTable(
  'plant',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    plant: varchar('plant', { length: 10 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    companyCode: varchar('company_code', { length: 10 }).notNull(),
    country: char('country', { length: 2 }).notNull(),
    city: varchar('city', { length: 80 }),
    address: text('address'),
    /** Plant is a production site, a storage site, or both. */
    isProductionSite: boolean('is_production_site').notNull().default(true),
    isStorageSite: boolean('is_storage_site').notNull().default(true),
    /** Default storage location used when a movement does not specify one. */
    defaultStorageLocation: varchar('default_storage_location', { length: 10 }),
    /** Language for printed shop papers. */
    language: char('language', { length: 2 }).notNull().default('EN'),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.plant] }),
    index('plant_company_idx').on(t.client, t.companyCode),
  ],
);

/** Storage location — a stock area within a plant. */
export const storageLocation = pgTable(
  'storage_location',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    plant: varchar('plant', { length: 10 }).notNull(),
    storageLocation: varchar('storage_location', { length: 10 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    /** Negative stock is refused unless explicitly permitted for this area. */
    allowNegativeStock: boolean('allow_negative_stock').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [primaryKey({ columns: [t.client, t.plant, t.storageLocation] })],
);

/** Purchasing organisation — negotiates and issues purchase orders (§6.1). */
export const purchasingOrg = pgTable(
  'purchasing_org',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    purchasingOrg: varchar('purchasing_org', { length: 10 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    companyCode: varchar('company_code', { length: 10 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [primaryKey({ columns: [t.client, t.purchasingOrg] })],
);

/** Assignment: which purchasing organisations may buy for which plants. */
export const purchasingOrgPlant = pgTable(
  'purchasing_org_plant',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    purchasingOrg: varchar('purchasing_org', { length: 10 }).notNull(),
    plant: varchar('plant', { length: 10 }).notNull(),
    ...auditColumns,
  },
  (t) => [primaryKey({ columns: [t.client, t.purchasingOrg, t.plant] })],
);

/** Purchasing group — the buyer or buying team responsible for a category. */
export const purchasingGroup = pgTable(
  'purchasing_group',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    purchasingGroup: varchar('purchasing_group', { length: 6 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    purchasingOrg: varchar('purchasing_org', { length: 10 }),
    responsibleBuyer: varchar('responsible_buyer', { length: 80 }),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [primaryKey({ columns: [t.client, t.purchasingGroup] })],
);

/** Sales organisation — legally responsible for sales (§6.1). */
export const salesOrg = pgTable(
  'sales_org',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    salesOrg: varchar('sales_org', { length: 10 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    companyCode: varchar('company_code', { length: 10 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    country: char('country', { length: 2 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [primaryKey({ columns: [t.client, t.salesOrg] })],
);

export const distributionChannel = pgTable(
  'distribution_channel',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    distributionChannel: varchar('distribution_channel', { length: 4 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [primaryKey({ columns: [t.client, t.distributionChannel] })],
);

export const division = pgTable(
  'division',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    division: varchar('division', { length: 4 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [primaryKey({ columns: [t.client, t.division] })],
);

/** Sales area — the combination sales data is maintained against (§9.1). */
export const salesArea = pgTable(
  'sales_area',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    salesOrg: varchar('sales_org', { length: 10 }).notNull(),
    distributionChannel: varchar('distribution_channel', { length: 4 }).notNull(),
    division: varchar('division', { length: 4 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.salesOrg, t.distributionChannel, t.division] }),
  ],
);

/** Controlling area — the cost accounting boundary, may span company codes. */
export const controllingArea = pgTable(
  'controlling_area',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    controllingArea: varchar('controlling_area', { length: 4 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    fiscalYearVariant: varchar('fiscal_year_variant', { length: 4 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [primaryKey({ columns: [t.client, t.controllingArea] })],
);

/** Assignment: company codes participating in a controlling area. */
export const controllingAreaCompany = pgTable(
  'controlling_area_company',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    controllingArea: varchar('controlling_area', { length: 4 }).notNull(),
    companyCode: varchar('company_code', { length: 10 }).notNull(),
    ...auditColumns,
  },
  (t) => [primaryKey({ columns: [t.client, t.controllingArea, t.companyCode] })],
);

/** Credit control area — shared credit limit boundary (D-029). */
export const creditControlArea = pgTable(
  'credit_control_area',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    creditControlArea: varchar('credit_control_area', { length: 4 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    /** Percentage of the limit at which a document is only warned, not blocked. */
    warningThresholdPercent: integer('warning_threshold_percent').notNull().default(90),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [primaryKey({ columns: [t.client, t.creditControlArea] })],
);

/** Exchange rate — maintained per rate type with a validity date (§14.4). */
export const exchangeRate = pgTable(
  'exchange_rate',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    /** BUYING | SELLING | AVERAGE */
    rateType: varchar('rate_type', { length: 12 }).notNull().default('AVERAGE'),
    fromCurrency: char('from_currency', { length: 3 }).notNull(),
    toCurrency: char('to_currency', { length: 3 }).notNull(),
    validFrom: date('valid_from').notNull(),
    /** Quoted as: 1 unit of fromCurrency = rate units of toCurrency. */
    rate: numeric('rate', { precision: 18, scale: 8 }).notNull(),
    /** True when the rate is quoted indirectly (units of foreign per 1 local). */
    isIndirectQuote: boolean('is_indirect_quote').notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    primaryKey({
      columns: [t.client, t.rateType, t.fromCurrency, t.toCurrency, t.validFrom],
    }),
    index('exchange_rate_lookup_idx').on(
      t.client,
      t.rateType,
      t.fromCurrency,
      t.toCurrency,
    ),
  ],
);

/**
 * Document type — classifies a document and drives its number range and the
 * account types it may touch (§8.2).
 */
export const documentType = pgTable(
  'document_type',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    documentType: varchar('document_type', { length: 12 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    /** Which number range object this type draws from. */
    numberRangeObject: varchar('number_range_object', { length: 40 }).notNull(),
    numberRangeSubObject: varchar('number_range_sub_object', { length: 24 })
      .notNull()
      .default('*'),
    /** Account types this type may post to, e.g. 'S' or 'SK'. */
    allowedAccountTypes: varchar('allowed_account_types', { length: 8 })
      .notNull()
      .default('S'),
    /** Reversal behaviour: REVERSE_ONLY, REVERSE_AND_ALT_DATE, NO_REVERSE. */
    reversalMode: varchar('reversal_mode', { length: 24 })
      .notNull()
      .default('REVERSE_AND_ALT_DATE'),
    /** Document type used for the reversal document, if different. */
    reversalDocumentType: varchar('reversal_document_type', { length: 12 }),
    /** Whether the reference field must be filled. */
    requiresReference: boolean('requires_reference').notNull().default(false),
    /** Whether line text is mandatory. */
    requiresLineText: boolean('requires_line_text').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [primaryKey({ columns: [t.client, t.documentType] })],
);

export * from './payment-terms-schema';

export * from './business-partner-schema';

export * from './supplier-company-schema';

export * from './supplier-purchasing-schema';
