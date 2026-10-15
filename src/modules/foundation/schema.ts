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
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { auditColumns, client } from '../../platform/tables/tenancy';
import { country, currency as currencyReference } from '../../platform/tables/reference';
import { centralAddress } from './central-address-schema';

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
    chartOfAccounts: varchar('chart_of_accounts', { length: 8 }),
    fiscalYearVariant: varchar('fiscal_year_variant', { length: 4 }),
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
    intercompanyClearingAccount: varchar('intercompany_clearing_account', { length: 20 }),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.companyCode] }),
    index('company_code_coa_idx').on(t.client, t.chartOfAccounts),
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
