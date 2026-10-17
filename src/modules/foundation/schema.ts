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
  smallint,
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
import { bankMaster, country, currency as currencyReference } from '../../platform/tables/reference';
import { centralAddress } from './central-address-schema';

/* ══ Enterprise structure ═══════════════════════════════════════════════════ */

/**
 * Group Chart of Accounts registry (OB13 amendment, SCR-026).
 *
 * Consolidation keys live in their own tenant-local registry instead of being derived
 * from operational charts, so the Group CoA F4 can never offer a chart that is also used
 * for posting. A four-character key is reserved tenant-wide across both registries: the
 * mutual-exclusion trigger `coa_key_registry_exclusive` rejects a code that already exists
 * on the other side.
 */
export const groupChartOfAccounts = pgTable(
  'group_chart_of_accounts',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    groupChartOfAccounts: varchar('group_chart_of_accounts', { length: 4 }).notNull(),
    name: varchar('name', { length: 50 }).notNull(),
    language: char('language', { length: 2 }).notNull().default('EN'),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.groupChartOfAccounts] }),
    check('group_chart_of_accounts_key_format', sql`${t.groupChartOfAccounts} ~ '^[A-Z0-9]{4}$'`),
    check('group_chart_of_accounts_name_nonempty', sql`length(btrim(${t.name})) between 1 and 50`),
    check('group_chart_of_accounts_language_format', sql`${t.language} ~ '^[A-Z]{2}$'`),
    check('group_chart_of_accounts_language_supported', sql`${t.language} in ('EN')`),
  ],
);

/** Chart of accounts — the list of accounts a company code keeps (§8.2). */
export const chartOfAccounts = pgTable(
  'chart_of_accounts',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    chartOfAccounts: varchar('chart_of_accounts', { length: 4 }).notNull(),
    name: varchar('name', { length: 50 }).notNull(),
    language: char('language', { length: 2 }).notNull().default('EN'),
    /** Numeric account-number length (1–10). Locked after accounts or transactions exist. */
    accountNumberLength: integer('account_number_length').notNull().default(10),
    /** Optional Group CoA reference for consolidation; resolves to the Group CoA registry. */
    groupChart: varchar('group_chart', { length: 4 }),
    /** Stored only in SCR-026; operational cost-element generation is deferred. */
    costElementIntegration: varchar('cost_element_integration', { length: 12 }).notNull().default('AUTOMATIC'),
    /** Blocks new G/L master records and Company Code assignment. */
    isBlocked: boolean('is_blocked').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.chartOfAccounts] }),
    check('chart_of_accounts_key_format', sql`${t.chartOfAccounts} ~ '^[A-Z0-9]{4}$'`),
    check('chart_of_accounts_name_nonempty', sql`length(btrim(${t.name})) between 1 and 50`),
    check('chart_of_accounts_language_format', sql`${t.language} ~ '^[A-Z]{2}$'`),
    check('chart_of_accounts_language_supported', sql`${t.language} in ('EN')`),
    check('chart_of_accounts_account_length', sql`${t.accountNumberLength} between 1 and 10`),
    check('chart_of_accounts_group_key_format', sql`${t.groupChart} is null or ${t.groupChart} ~ '^[A-Z0-9]{4}$'`),
    check('chart_of_accounts_group_not_self', sql`${t.groupChart} is null or ${t.groupChart} <> ${t.chartOfAccounts}`),
    check('chart_of_accounts_cost_element_integration', sql`${t.costElementIntegration} in ('AUTOMATIC', 'MANUAL', 'NONE')`),
    foreignKey({
      name: 'chart_of_accounts_client_group_chart_fk',
      columns: [t.client, t.groupChart],
      foreignColumns: [groupChartOfAccounts.client, groupChartOfAccounts.groupChartOfAccounts],
    }),
  ],
);

/**
 * Fiscal year variant — how a fiscal year is split into periods (§8.2, §14.3).
 *
 * Rebuilt for SCR-029/OB29 on the contract's own widths and flags: a two-character key, a
 * thirty-character description, and the year-dependent indicator that decides whether the
 * period list is maintained per calendar year or holds for every year. The previous pair of
 * tables stored a period's start and end; the contract stores the end and a year shift, and
 * the period engine derives each start from the period before it, which is how the reference
 * product computes it and the only way a hand-maintained period list can stay consistent.
 */
export const fiscalYearVariant = pgTable(
  'fiscal_year_variant',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    /** Fiscal Year Variant: two uppercase letters or digits, immutable. */
    variant: varchar('variant', { length: 2 }).notNull(),
    /** Description. */
    name: varchar('name', { length: 30 }).notNull(),
    /** Calendar Year: the fiscal year is the calendar year, January to December. */
    isCalendarYear: boolean('is_calendar_year').notNull().default(false),
    /** Posting Periods: ordinary periods in the year, 1 to 16. */
    regularPeriods: smallint('regular_periods').notNull(),
    /** Special Periods: year-end adjustment periods, 0 to 4, never for daily posting. */
    specialPeriods: smallint('special_periods').notNull().default(0),
    /** Year Dependent: periods vary by calendar year, e.g. a 4-4-5 retail calendar. */
    isYearDependent: boolean('is_year_dependent').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    version: integer('version').notNull().default(1),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.variant] }),
    check('fiscal_year_variant_key_format_ck', sql`${t.variant} ~ '^[A-Z0-9]{2}$'`),
    check('fiscal_year_variant_name_not_blank_ck', sql`length(btrim(${t.name})) > 0`),
    check('fiscal_year_variant_regular_periods_ck', sql`${t.regularPeriods} between 1 and 16`),
    check('fiscal_year_variant_special_periods_ck', sql`${t.specialPeriods} between 0 and 4`),
  ],
);

/**
 * One row per posting period, holding the period's **end** and its year shift.
 *
 * A period's start is never stored: it is the previous period's end plus one day, and the
 * first period starts the day after the last period of the fiscal year before it. Storing
 * both would let a variant disagree with its own period list, which is a defect nobody finds
 * until an auditor does.
 *
 * `calendar_year` is 0 for a variant whose periods hold for every year, and the actual year
 * for a year-dependent one, so a 4-4-5 calendar can keep a row set per year without the
 * year-independent majority paying for it.
 */
export const fiscalYearPeriod = pgTable(
  'fiscal_year_period',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    variant: varchar('variant', { length: 2 }).notNull(),
    /** Calendar Year; 0 means the row holds for every year. */
    calendarYear: integer('calendar_year').notNull().default(0),
    /** Posting Period: 1 to `regular_periods`, then the special periods. */
    period: smallint('period').notNull(),
    /** REGULAR | SPECIAL — period control refuses daily postings into a special period. */
    periodType: varchar('period_type', { length: 10 }).notNull(),
    /** Month in which the period ends. */
    month: smallint('month').notNull(),
    /** Day on which the period ends; 31 means the last day of the month. */
    day: smallint('day').notNull().default(31),
    /** Year shift: +1 when the end falls in the next calendar year, −1 in the previous. */
    yearShift: smallint('year_shift').notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.variant, t.calendarYear, t.period] }),
    index('fiscal_year_period_variant_idx').on(t.client, t.variant, t.calendarYear),
    foreignKey({
      name: 'fiscal_year_period_variant_fk',
      columns: [t.client, t.variant],
      foreignColumns: [fiscalYearVariant.client, fiscalYearVariant.variant],
    }).onDelete('cascade'),
    check('fiscal_year_period_type_ck', sql`${t.periodType} in ('REGULAR', 'SPECIAL')`),
    check('fiscal_year_period_number_ck', sql`${t.period} between 1 and 20`),
    check('fiscal_year_period_month_ck', sql`${t.month} between 1 and 12`),
    check('fiscal_year_period_day_ck', sql`${t.day} between 1 and 31`),
    check('fiscal_year_period_year_shift_ck', sql`${t.yearShift} between -1 and 1`),
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
    /** Thirty characters, per the OBBO contract; migration 0041 refused to shorten anything. */
    name: varchar('name', { length: 30 }).notNull(),
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
    // OBBO: an interval is a child of its variant and cannot outlive it. The primary key
    // already carries the (client, variant) prefix a parent-side check needs, so no index.
    foreignKey({
      name: 'posting_period_rule_client_variant_fk',
      columns: [t.client, t.variant],
      foreignColumns: [postingPeriodVariant.client, postingPeriodVariant.variant],
    }),
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
    chartOfAccounts: varchar('chart_of_accounts', { length: 4 }),
    fiscalYearVariant: varchar('fiscal_year_variant', { length: 2 }),
    postingPeriodVariant: varchar('posting_period_variant', { length: 4 }),
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
    intercompanyClearingAccount: varchar('intercompany_clearing_account', { length: 10 }),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.companyCode] }),
    index('company_code_coa_idx').on(t.client, t.chartOfAccounts),
    foreignKey({
      name: 'company_code_client_chart_of_accounts_fk',
      columns: [t.client, t.chartOfAccounts],
      foreignColumns: [chartOfAccounts.client, chartOfAccounts.chartOfAccounts],
    }),
    // OB37: a company code posts in one fiscal year variant, and a variant in use cannot be
    // removed. Nullable, because a company code is defined before its variant is assigned.
    index('company_code_fyv_idx').on(t.client, t.fiscalYearVariant),
    foreignKey({
      name: 'company_code_client_fiscal_year_variant_fk',
      columns: [t.client, t.fiscalYearVariant],
      foreignColumns: [fiscalYearVariant.client, fiscalYearVariant.variant],
    }),
    // OBBO: a company code posts against one posting period variant, and a variant in use
    // cannot be removed. Nullable, because a company code is defined before its variant is
    // assigned. The trigger cairn_assert_company_code_refs() still fires first on a write
    // and names the activity that defines the missing variant.
    index('company_code_ppv_idx').on(t.client, t.postingPeriodVariant),
    foreignKey({
      name: 'company_code_client_posting_period_variant_fk',
      columns: [t.client, t.postingPeriodVariant],
      foreignColumns: [postingPeriodVariant.client, postingPeriodVariant.variant],
    }),
  ],
);

/** Plant — a production or storage site, optionally assigned to a company code after definition. */
export const plant = pgTable(
  'plant',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    plant: varchar('plant', { length: 10 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    companyCode: varchar('company_code', { length: 10 }),
    country: char('country', { length: 2 }).notNull(),
    city: varchar('city', { length: 80 }),
    region: varchar('region', { length: 80 }),
    postalCode: varchar('postal_code', { length: 20 }),
    street: varchar('street', { length: 160 }),
    houseNumber: varchar('house_number', { length: 40 }),
    /** Legacy free-form address retained as-is; new Plant maintenance uses the structured fields above. */
    address: text('address'),
    /** Optional code only; no factory-calendar master is available yet, so this is not validated or operational. */
    factoryCalendar: varchar('factory_calendar', { length: 10 }),
    /** Cairn-specific descriptive flag, not an operational gate; both role flags default true and may both be false. */
    isProductionSite: boolean('is_production_site').notNull().default(true),
    /** Cairn-specific descriptive flag, not an operational gate. */
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
    foreignKey({
      name: 'plant_client_company_code_fk',
      columns: [t.client, t.companyCode],
      foreignColumns: [companyCode.client, companyCode.companyCode],
    }),
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
    /** Persisted configuration only; stock-movement enforcement is not implemented. */
    allowNegativeStock: boolean('allow_negative_stock').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.plant, t.storageLocation] }),
    foreignKey({
      name: 'storage_location_client_plant_fk',
      columns: [t.client, t.plant],
      foreignColumns: [plant.client, plant.plant],
    }),
  ],
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
    companyCode: varchar('company_code', { length: 10 }),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.purchasingOrg] }),
    index('purchasing_org_company_code_idx').on(t.client, t.companyCode),
    foreignKey({
      name: 'purchasing_org_client_company_code_fk',
      columns: [t.client, t.companyCode],
      foreignColumns: [companyCode.client, companyCode.companyCode],
    }),
  ],
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

/** Buyer/team definition. New groups have no Company Code, Plant or Purchasing Organisation assignment. */
export const purchasingGroup = pgTable(
  'purchasing_group',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    /** Three-character uppercase alphanumeric Purchasing Group key. */
    purchasingGroup: varchar('purchasing_group', { length: 3 }).notNull(),
    /** Retain legacy Cairn description width; starter labels exceed the published 18-character T024 field length. */
    name: varchar('name', { length: 120 }).notNull(),
    /** Contact columns shown on the overview; all are optional. */
    telNoPurchGroup: varchar('tel_no_purch_group', { length: 12 }),
    faxNumber: varchar('fax_number', { length: 31 }),
    telephone: varchar('telephone', { length: 30 }),
    extension: varchar('extension', { length: 10 }),
    emailAddress: varchar('email_address', { length: 241 }),
    /** Legacy compatibility fields are retained for existing consumers; new definitions do not set them. */
    purchasingOrg: varchar('purchasing_org', { length: 10 }),
    responsibleBuyer: varchar('responsible_buyer', { length: 80 }),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.purchasingGroup] }),
    check('purchasing_group_key_format_ck', sql`${t.purchasingGroup} ~ '^[A-Z0-9]{3}$'`),
  ],
);

/** Tenant-local factory-calendar customizing used by the OVX5 value help. */
export const factoryCalendar = pgTable(
  'factory_calendar',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    calendarId: char('calendar_id', { length: 2 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.calendarId] }),
    check('factory_calendar_key_format_ck', sql`${t.calendarId} ~ '^[A-Z0-9]{2}$'`),
  ],
);

/** Sales organisation — legally responsible for sales (§6.1). */
export const salesOrg = pgTable(
  'sales_org',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    salesOrg: varchar('sales_org', { length: 4 }).notNull(),
    /** Set only by the separate SCR-021 assignment activity. */
    companyCode: varchar('company_code', { length: 10 }),
    /** Optional currency key for pricing and reporting in the Sales Organization. */
    currency: varchar('currency', { length: 5 }),
    /** Optional CAM address association; address contents live only in central_address. */
    addressNumber: char('address_number', { length: 10 }),
    /** Two-character legacy factory-calendar key; rules are maintained separately. */
    factoryCalendar: char('factory_calendar', { length: 2 }),
    /** Optional sourcing Purchasing Organization shown on the OVX5 definition. */
    purchasingOrganization: varchar('purchasing_organization', { length: 4 }),
    /** Optional reference Sales Organization used for sales document-type determination. */
    referenceSalesOrg: varchar('reference_sales_org', { length: 4 }),
    /** Optional ALE integration switch; persisted here, while ALE processing is a separate integration. */
    alePurchaseOrders: boolean('ale_purchase_orders').notNull().default(false),
    /** Optional intercompany billing customer/vendor master keys. */
    intercompanyBillingCustomer: varchar('intercompany_billing_customer', { length: 10 }),
    intercompanyBillingVendor: varchar('intercompany_billing_vendor', { length: 10 }),
    rebateProcessingActive: boolean('rebate_processing_active').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.salesOrg] }),
    check('sales_org_key_format_ck', sql`${t.salesOrg} ~ '^[A-Z0-9]{4}$'`),
    check('sales_org_address_number_format_ck', sql`${t.addressNumber} is null or ${t.addressNumber} ~ '^[0-9]{10}$'`),
    check('sales_org_factory_calendar_format_ck', sql`${t.factoryCalendar} is null or ${t.factoryCalendar} ~ '^[A-Z0-9]{2}$'`),
    check('sales_org_purchasing_org_format_ck', sql`${t.purchasingOrganization} is null or ${t.purchasingOrganization} ~ '^[A-Z0-9]{4}$'`),
    check('sales_org_reference_sales_org_format_ck', sql`${t.referenceSalesOrg} is null or ${t.referenceSalesOrg} ~ '^[A-Z0-9]{4}$'`),
    check('sales_org_intercompany_vendor_format_ck', sql`${t.intercompanyBillingVendor} is null or ${t.intercompanyBillingVendor} ~ '^[0-9]{1,10}$'`),
    foreignKey({ name: 'sales_org_company_code_fk', columns: [t.client, t.companyCode], foreignColumns: [companyCode.client, companyCode.companyCode] }),
    foreignKey({ name: 'sales_org_address_number_fk', columns: [t.client, t.addressNumber], foreignColumns: [centralAddress.client, centralAddress.addressNumber] }),
    foreignKey({ name: 'sales_org_factory_calendar_fk', columns: [t.client, t.factoryCalendar], foreignColumns: [factoryCalendar.client, factoryCalendar.calendarId] }),
    foreignKey({ name: 'sales_org_purchasing_org_fk', columns: [t.client, t.purchasingOrganization], foreignColumns: [purchasingOrg.client, purchasingOrg.purchasingOrg] }),
    foreignKey({ name: 'sales_org_reference_sales_org_fk', columns: [t.client, t.referenceSalesOrg], foreignColumns: [t.client, t.salesOrg] }),
  ],
);

/** Language-dependent Sales Organization texts (TVKOT analogue, including the form-text key). */
export const salesOrgText = pgTable(
  'sales_org_text',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    salesOrg: varchar('sales_org', { length: 4 }).notNull(),
    /** One-character logon-language key; English is E. */
    languageKey: char('language_key', { length: 1 }).notNull(),
    name: varchar('name', { length: 35 }).notNull(),
    /** Optional language-dependent 12-character standard text-module key. */
    formText: char('form_text', { length: 12 }),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.salesOrg, t.languageKey] }),
    check('sales_org_text_language_format_ck', sql`${t.languageKey} ~ '^[A-Z]$'`),
    foreignKey({ name: 'sales_org_text_sales_org_fk', columns: [t.client, t.salesOrg], foreignColumns: [salesOrg.client, salesOrg.salesOrg] }),
  ],
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

/** Sales Organization ↔ Distribution Channel assignment — OVXK. */
export const salesOrgDistributionChannel = pgTable(
  'sales_org_distribution_channel',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    salesOrg: varchar('sales_org', { length: 4 }).notNull(),
    // Match the existing master key type; the OVXI contract is enforced as CHAR 2 below.
    distributionChannel: varchar('distribution_channel', { length: 4 }).notNull(),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.salesOrg, t.distributionChannel] }),
    check('sales_org_distribution_channel_sales_org_format_ck', sql`${t.salesOrg} ~ '^[A-Z0-9]{4}$'`),
    check('sales_org_distribution_channel_channel_format_ck', sql`${t.distributionChannel} ~ '^[A-Z0-9]{2}$'`),
    foreignKey({
      name: 'sales_org_distribution_channel_sales_org_fk',
      columns: [t.client, t.salesOrg],
      foreignColumns: [salesOrg.client, salesOrg.salesOrg],
    }),
    foreignKey({
      name: 'sales_org_distribution_channel_definition_fk',
      columns: [t.client, t.distributionChannel],
      foreignColumns: [distributionChannel.client, distributionChannel.distributionChannel],
    }),
    index('sales_org_distribution_channel_channel_idx').on(t.client, t.distributionChannel, t.salesOrg),
  ],
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

/** Sales Organization ↔ Division assignment — OVXA. */
export const salesOrgDivision = pgTable(
  'sales_org_division',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    salesOrg: varchar('sales_org', { length: 4 }).notNull(),
    // Match the existing definition column width; the OVXB Char 2 contract is checked below.
    division: varchar('division', { length: 4 }).notNull(),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.salesOrg, t.division] }),
    check('sales_org_division_sales_org_format_ck', sql`${t.salesOrg} ~ '^[A-Z0-9]{4}$'`),
    check('sales_org_division_division_format_ck', sql`${t.division} ~ '^[A-Z0-9]{2}$'`),
    foreignKey({
      name: 'sales_org_division_sales_org_fk',
      columns: [t.client, t.salesOrg],
      foreignColumns: [salesOrg.client, salesOrg.salesOrg],
    }),
    foreignKey({
      name: 'sales_org_division_definition_fk',
      columns: [t.client, t.division],
      foreignColumns: [division.client, division.division],
    }),
    index('sales_org_division_division_idx').on(t.client, t.division, t.salesOrg),
  ],
);

/** Sales area — the combination sales data is maintained against (§9.1). */
export const salesArea = pgTable(
  'sales_area',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    salesOrg: varchar('sales_org', { length: 4 }).notNull(),
    distributionChannel: varchar('distribution_channel', { length: 2 }).notNull(),
    division: varchar('division', { length: 2 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.salesOrg, t.distributionChannel, t.division] }),
    check('sales_area_sales_org_key_format_ck', sql`${t.salesOrg} ~ '^[A-Z0-9]{4}$'`),
    check('sales_area_distribution_channel_key_format_ck', sql`${t.distributionChannel} ~ '^[A-Z0-9]{2}$'`),
    check('sales_area_division_key_format_ck', sql`${t.division} ~ '^[A-Z0-9]{2}$'`),
    check('sales_area_name_not_blank_ck', sql`length(btrim(${t.name})) > 0`),
    foreignKey({ name: 'sales_area_sales_org_fk', columns: [t.client, t.salesOrg], foreignColumns: [salesOrg.client, salesOrg.salesOrg] }),
    foreignKey({
      name: 'sales_area_sales_org_distribution_channel_assignment_fk',
      columns: [t.client, t.salesOrg, t.distributionChannel],
      foreignColumns: [salesOrgDistributionChannel.client, salesOrgDistributionChannel.salesOrg, salesOrgDistributionChannel.distributionChannel],
    }),
    foreignKey({
      name: 'sales_area_sales_org_division_assignment_fk',
      columns: [t.client, t.salesOrg, t.division],
      foreignColumns: [salesOrgDivision.client, salesOrgDivision.salesOrg, salesOrgDivision.division],
    }),
  ],
);

/** Controlling Area — the cost-accounting boundary, which may span Company Codes. */
export const controllingArea = pgTable(
  'controlling_area',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    controllingArea: varchar('controlling_area', { length: 4 }).notNull(),
    name: varchar('name', { length: 30 }).notNull(),
    organizationName: varchar('organization_name', { length: 30 }),
    /** SINGLE permits one assigned Company Code; MULTIPLE permits several. */
    companyCodeScope: varchar('company_code_scope', { length: 8 }).notNull().default('SINGLE'),
    currency: char('currency', { length: 3 }).notNull(),
    fiscalYearVariant: varchar('fiscal_year_variant', { length: 2 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.controllingArea] }),
    check('controlling_area_key_format_ck', sql`${t.controllingArea} ~ '^[A-Z0-9]{4}$'`),
    check('controlling_area_name_not_blank_ck', sql`length(btrim(${t.name})) > 0`),
    check('controlling_area_organization_name_not_blank_ck', sql`${t.organizationName} is null or length(btrim(${t.organizationName})) > 0`),
    check('controlling_area_company_code_scope_ck', sql`${t.companyCodeScope} in ('SINGLE', 'MULTIPLE')`),
    check('controlling_area_currency_format_ck', sql`btrim(${t.currency}) ~ '^[A-Z]{3}$'`),
    check('controlling_area_fiscal_year_variant_format_ck', sql`${t.fiscalYearVariant} ~ '^[A-Z0-9]{2}$'`),
    foreignKey({
      name: 'controlling_area_fiscal_year_variant_fk',
      columns: [t.client, t.fiscalYearVariant],
      foreignColumns: [fiscalYearVariant.client, fiscalYearVariant.variant],
    }),
    foreignKey({
      name: 'controlling_area_currency_reference_fk',
      columns: [t.currency],
      foreignColumns: [currencyReference.code],
    }),
  ],
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
  (t) => [
    primaryKey({ columns: [t.client, t.controllingArea, t.companyCode] }),
    uniqueIndex('controlling_area_company_code_unique_idx').on(t.client, t.companyCode),
    check('controlling_area_company_code_format_ck', sql`${t.companyCode} ~ '^[A-Za-z0-9]{4}$'`),
    foreignKey({
      name: 'controlling_area_company_area_fk',
      columns: [t.client, t.controllingArea],
      foreignColumns: [controllingArea.client, controllingArea.controllingArea],
    }),
    foreignKey({
      name: 'controlling_area_company_company_code_fk',
      columns: [t.client, t.companyCode],
      foreignColumns: [companyCode.client, companyCode.companyCode],
    }),
  ],
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
    /**
     * The translation ratio the rate is quoted for (SCR-034 / R-84; the package's
     * FFACT/TFACT). The effective rate is rate × ratioTo / ratioFrom. A ratio is a
     * unit count — 1, 10, 100 — so it is an integer, at least one, and defaults to
     * the one every row meant before the columns existed.
     */
    ratioFrom: integer('ratio_from').notNull().default(1),
    ratioTo: integer('ratio_to').notNull().default(1),
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
    check('exchange_rate_ratio_from_positive', sql`${t.ratioFrom} >= 1`),
    check('exchange_rate_ratio_to_positive', sql`${t.ratioTo} >= 1`),
  ],
);

/**
 * Tax code — the levy a journal line names, defined per country (SCR-035 / R-85).
 *
 * Journal lines have carried `tax_code` as free text since the first posting schema;
 * this is the registry that gives the text a meaning. The code is up to four
 * characters — the line's own width, not the reference package's two — the rate a
 * percentage at two decimals between nothing and everything, and the condition
 * type / account key are the operator-entered values a posting rule reads: tenant
 * data, shape-checked, there being no condition master to validate them against.
 * No active flag: the lifecycle is deletion, refused while lines carry the code.
 */
/**
 * The tenant's own bank inside a company code (SCR-037, migration 0045). The
 * bank it names lives in the global bank master; only the reference is stored,
 * held by foreign key, and the display facts are read from there.
 */
export const houseBank = pgTable(
  'house_bank',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    companyCode: varchar('company_code', { length: 10 }).notNull(),
    houseBankKey: varchar('house_bank_key', { length: 5 }).notNull(),
    bankCountry: char('bank_country', { length: 2 }).notNull(),
    bankKey: varchar('bank_key', { length: 15 }).notNull(),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.companyCode, t.houseBankKey] }),
    foreignKey({
      columns: [t.client, t.companyCode],
      foreignColumns: [companyCode.client, companyCode.companyCode],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.bankCountry, t.bankKey],
      foreignColumns: [bankMaster.bankCountry, bankMaster.bankKey],
    }),
    index('house_bank_bank_idx').on(t.bankCountry, t.bankKey),
    check('house_bank_key_format', sql`${t.houseBankKey} ~ '^[A-Z0-9]{1,5}$'`),
  ],
);

/**
 * An account held at a house bank (SCR-037, migration 0045): the number money
 * moves through, an optional IBAN, a currency, and the G/L account its
 * postings clear through. The house bank foreign key restricts deletion at
 * the database, as the service refuses it with the count.
 */
export const bankAccount = pgTable(
  'bank_account',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    companyCode: varchar('company_code', { length: 10 }).notNull(),
    houseBankKey: varchar('house_bank_key', { length: 5 }).notNull(),
    accountId: varchar('account_id', { length: 5 }).notNull(),
    accountNumber: varchar('account_number', { length: 18 }).notNull(),
    iban: varchar('iban', { length: 34 }),
    currency: char('currency', { length: 3 }).notNull(),
    glAccount: varchar('gl_account', { length: 10 }).notNull(),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.companyCode, t.houseBankKey, t.accountId] }),
    foreignKey({
      columns: [t.client, t.companyCode, t.houseBankKey],
      foreignColumns: [houseBank.client, houseBank.companyCode, houseBank.houseBankKey],
    }).onDelete('restrict'),
    check('bank_account_id_format', sql`${t.accountId} ~ '^[A-Z0-9]{1,5}$'`),
    check('bank_account_number_nonempty', sql`length(btrim(${t.accountNumber})) between 1 and 18`),
    check('bank_account_iban_format', sql`${t.iban} is null or ${t.iban} ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'`),
  ],
);

export const taxCode = pgTable(
  'tax_code',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    country: char('country', { length: 2 })
      .notNull()
      .references(() => country.code),
    taxCode: varchar('tax_code', { length: 4 }).notNull(),
    name: varchar('name', { length: 50 }).notNull(),
    taxType: varchar('tax_type', { length: 4 }).notNull(),
    ratePercent: numeric('rate_percent', { precision: 7, scale: 2 }).notNull(),
    accountKey: varchar('account_key', { length: 3 }),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.country, t.taxCode] }),
    index('tax_code_code_idx').on(t.client, t.taxCode),
    check('tax_code_code_format', sql`${t.taxCode} ~ '^[A-Z0-9]{1,4}$'`),
    check('tax_code_name_nonempty', sql`length(btrim(${t.name})) between 1 and 50`),
    check('tax_code_type_format', sql`${t.taxType} ~ '^[A-Z0-9]{1,4}$'`),
    check('tax_code_rate_bounds', sql`${t.ratePercent} between 0 and 100`),
    check('tax_code_account_key_format', sql`${t.accountKey} is null or ${t.accountKey} ~ '^[A-Z0-9]{1,3}$'`),
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

/**
 * Employee tolerance group (SCR-039, migration 0047): the posting ceilings
 * attached to a group of users in a company code — per document, per line
 * item, for cash discount, and for the payment differences a payment may
 * book on its own. Both key parts may be blank as deliberate stored values:
 * a blank company code is the tenant-wide scope standing under every
 * company code, and a blank group key is the default group of its scope.
 * Whether blank carries an FK depends on the column, so the company code is
 * validated by the service rather than by a foreign key. Zero is a stored
 * meaning, not a missing value: a zero limit imposes no ceiling (R-88).
 */
export const employeeToleranceGroup = pgTable(
  'employee_tolerance_group',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    /** '' = tenant-wide scope; otherwise a company code of the tenant. */
    companyCode: varchar('company_code', { length: 10 }).notNull().default(''),
    /** '' = the default group of its scope. */
    groupKey: varchar('group_key', { length: 4 }).notNull().default(''),
    maxDocumentAmount: numeric('max_document_amount', { precision: 15, scale: 2 }).notNull(),
    maxLineAmount: numeric('max_line_amount', { precision: 13, scale: 2 }).notNull(),
    maxCashDiscountPercent: numeric('max_cash_discount_percent', { precision: 6, scale: 3 }).notNull(),
    paymentDiffRevenueAmount: numeric('payment_diff_revenue_amount', { precision: 7, scale: 2 }).notNull().default('0'),
    paymentDiffExpenseAmount: numeric('payment_diff_expense_amount', { precision: 7, scale: 2 }).notNull().default('0'),
    paymentDiffRevenuePercent: numeric('payment_diff_revenue_percent', { precision: 3, scale: 1 }).notNull().default('0'),
    paymentDiffExpensePercent: numeric('payment_diff_expense_percent', { precision: 3, scale: 1 }).notNull().default('0'),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.companyCode, t.groupKey] }),
    index('employee_tolerance_group_company_idx').on(t.client, t.companyCode),
    check('employee_tolerance_group_company_format', sql`${t.companyCode} ~ '^([A-Z0-9]{4})?$'`),
    check('employee_tolerance_group_key_format', sql`${t.groupKey} ~ '^([A-Z0-9]{1,4})?$'`),
    check('employee_tolerance_group_amount_bounds', sql`${t.maxDocumentAmount} >= 0 and ${t.maxLineAmount} >= 0 and ${t.paymentDiffRevenueAmount} >= 0 and ${t.paymentDiffExpenseAmount} >= 0`),
    check('employee_tolerance_group_discount_bounds', sql`${t.maxCashDiscountPercent} between 0 and 100`),
    check('employee_tolerance_group_diff_percent_bounds', sql`${t.paymentDiffRevenuePercent} between 0 and 99.9 and ${t.paymentDiffExpensePercent} between 0 and 99.9`),
    check('employee_tolerance_group_line_within_document', sql`${t.maxLineAmount} = 0 or ${t.maxDocumentAmount} = 0 or ${t.maxLineAmount} <= ${t.maxDocumentAmount}`),
  ],
);

export * from './payment-terms-schema';
export * from './payment-method-schema';

export * from './business-partner-schema';
export * from './partner-bank-schema';
export * from './partner-bank-country-profile-schema';
export * from './partner-bank-profile-activation-audit-schema';

export * from './supplier-company-schema';

export * from './supplier-purchasing-schema';
export * from './supplier-partner-schema';

export * from './customer-company-schema';
export * from './customer-sales-area-schema';

export * from './central-address-schema';
