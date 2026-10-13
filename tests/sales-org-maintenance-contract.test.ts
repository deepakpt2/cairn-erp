import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  salesOrgDefinitionValuesSchema,
  salesOrgMaintenanceInputSchema,
  salesOrgDeactivationInputSchema,
} from '@/modules/foundation/sales-organization-maintenance';

const service = readFileSync('src/modules/foundation/sales-organization-maintenance.ts', 'utf8');
const schema = readFileSync('src/modules/foundation/schema.ts', 'utf8');
const migration = readFileSync('drizzle/0025_sales_organization_definition.sql', 'utf8');
const activityMigration = readFileSync('drizzle/0026_sales_org_activity_code.sql', 'utf8');

describe('SCR-020 Sales Organization definition contract', () => {
  it('validates the OVX5 field lengths, defaults, nested CAM address and definition-only request', () => {
    const base = { name: 'Regional Sales', address: { country: 'KW' } };
    expect(salesOrgDefinitionValuesSchema.safeParse(base).success).toBe(true);
    expect(salesOrgDefinitionValuesSchema.safeParse({ ...base, name: 'A Detailed Sales Organization Description Longer Than Thirty-Five Characters' }).success).toBe(false);
    expect(salesOrgDefinitionValuesSchema.parse(base)).toMatchObject({
      formText: null, currency: null, factoryCalendar: null, purchasingOrganization: null,
      referenceSalesOrg: null, alePurchaseOrders: false, rebateProcessingActive: false,
      intercompanyBillingCustomer: null, intercompanyBillingVendor: null,
    });
    expect(salesOrgDefinitionValuesSchema.safeParse({ ...base, currency: '' }).success).toBe(true);
    expect(salesOrgDefinitionValuesSchema.safeParse({ ...base, currency: 'US' }).success).toBe(false);
    expect(salesOrgDefinitionValuesSchema.safeParse({ ...base, currency: 'USD' }).success).toBe(true);
    expect(salesOrgDefinitionValuesSchema.safeParse({ ...base, currency: 'ABCDE' }).success).toBe(true);
    expect(salesOrgDefinitionValuesSchema.safeParse({ ...base, currency: 'USDDDD' }).success).toBe(false);
    expect(salesOrgDefinitionValuesSchema.safeParse({ ...base, formText: 'STANDARD' }).success).toBe(true);
    expect(salesOrgDefinitionValuesSchema.safeParse({ ...base, formText: 'TEXT-MODULE-TOO-LONG' }).success).toBe(false);
    expect(salesOrgDefinitionValuesSchema.safeParse({ ...base, factoryCalendar: '01' }).success).toBe(true);
    expect(salesOrgDefinitionValuesSchema.safeParse({ ...base, factoryCalendar: '001' }).success).toBe(false);
    expect(salesOrgDefinitionValuesSchema.safeParse({ ...base, purchasingOrganization: '1000' }).success).toBe(true);
    expect(salesOrgDefinitionValuesSchema.safeParse({ ...base, purchasingOrganization: 'P1000' }).success).toBe(false);
    expect(salesOrgDefinitionValuesSchema.safeParse({ ...base, referenceSalesOrg: '1000' }).success).toBe(true);
    expect(salesOrgDefinitionValuesSchema.safeParse({ ...base, referenceSalesOrg: 'SO100' }).success).toBe(false);
    expect(salesOrgDefinitionValuesSchema.safeParse({ ...base, rebateProcessingActive: true, alePurchaseOrders: true }).success).toBe(true);
    expect(salesOrgDefinitionValuesSchema.safeParse({ ...base, intercompanyBillingVendor: '12345' }).success).toBe(true);
    expect(salesOrgDefinitionValuesSchema.safeParse({ ...base, intercompanyBillingVendor: 'VENDOR' }).success).toBe(false);
    expect(salesOrgDefinitionValuesSchema.safeParse({ ...base, intercompanyBillingCustomer: 'CUST153' }).success).toBe(true);
    expect(salesOrgDefinitionValuesSchema.safeParse({ ...base, companyCode: '1000' }).success).toBe(false);
    expect(salesOrgDefinitionValuesSchema.safeParse({ ...base, address: { country: 'KW', unsupportedField: 'x' } }).success).toBe(false);

    expect(salesOrgMaintenanceInputSchema.safeParse({
      client: 'T153', changedBy: 'TEST', mode: 'CREATE', salesOrg: 's153', expectedVersion: 0, values: base,
    }).success).toBe(false);
    expect(salesOrgMaintenanceInputSchema.safeParse({
      client: 'T153', changedBy: 'TEST', mode: 'CREATE', salesOrg: 'S153', expectedVersion: 0,
      values: { ...base, companyCode: '1000' },
    }).success).toBe(false);
    expect(salesOrgMaintenanceInputSchema.parse({
      client: 'T153', changedBy: 'TEST', mode: 'CREATE', salesOrg: 'S153', expectedVersion: 0,
      values: base,
    }).languageKey).toBe('E');
    expect(salesOrgMaintenanceInputSchema.safeParse({
      client: 'T153', changedBy: 'TEST', languageKey: 'DE', mode: 'CREATE', salesOrg: 'S153', expectedVersion: 0, values: base,
    }).success).toBe(false);
    expect(salesOrgDeactivationInputSchema.safeParse({
      client: 'T153', changedBy: 'TEST', salesOrg: 'S153', expectedVersion: 1, isActive: true,
    }).success).toBe(false);
  });

  it('keeps Company Code out of the definition mutation and uses tenant-scoped optimistic history versions', () => {
    expect(service).toContain("const SALES_ORG_ACTIVITY = 'CFG.ORG.SALESORG.DEFINE'");
    expect(service).toContain("const salesOrgCodeSchema = z.string().trim().regex(/^[A-Z0-9]{4}$/)");
    expect(service).toContain("z.enum(['CREATE', 'CHANGE'])");
    expect(service).toContain("languageKey: z.string().trim().regex(/^[A-Z]$/).default('E')");
    expect(service).toContain('pg_advisory_xact_lock');
    expect(service).toContain('await auditVersion(tx, client, code)');
    expect(service).toContain('companyCode: null');
    expect(service).toContain('sameDefinition(before, after)');
    expect(service).toContain('EDITABLE_FIELDS');
    expect(service).toContain('await tx.update(salesOrgTable).set({');
    expect(service).toContain('Company Code is deliberately excluded; its changes belong solely to SCR-021.');
    expect(service).not.toMatch(/\.delete\s*\(/);
    expect(service).not.toMatch(/'ACTIVATE'|'REACTIVATE'/);
  });

  it('stores logon-language text separately, stores address details in CAM and preserves the canonical partner key', () => {
    expect(service).toContain('languageKey: string');
    expect(service).toContain('salesOrgText');
    expect(service).toContain('createCentralAddress(tx, client, changedBy');
    expect(service).toContain('from(centralAddress)');
    expect(service).toContain("definition.intercompanyBillingVendor = vendor.padStart(10, '0')");
    expect(service).toContain('intercompanyBillingVendor: values.intercompanyBillingVendor');
    expect(service).toContain('intercompanyBillingCustomer: values.intercompanyBillingCustomer');
    expect(service).toContain('securityRelevantFields: [\'isActive\', \'intercompanyBillingCustomer\', \'intercompanyBillingVendor\'');
  });

  it('validates active references and blocks deactivation while Sales Area data depends on the organisation', () => {
    expect(service).toContain('currencyReference.isActive');
    expect(service).toContain('countryReference.code');
    expect(service).toContain('factoryCalendarTable.isActive');
    expect(service).toContain('purchasingOrgTable.isActive');
    expect(service).toContain('salesOrgTable.isActive');
    expect(service).toContain("eq(bpRole.roleCode, 'CUSTOMER')");
    expect(service).toContain("eq(bpRole.roleCode, 'SUPPLIER')");
    expect(service).toContain('eq(bpRole.isActive, true)');
    expect(service).toContain('eq(businessPartner.isBlocked, false)');
    expect(service).toContain('from(salesArea)');
    expect(service).toContain('from(customerSalesArea)');
    expect(service).toContain('Retain the organization while sales-area records depend on it.');
  });

  it('aligns Drizzle definitions and preflights legacy migration data before DDL', () => {
    expect(schema).toContain("salesOrg: varchar('sales_org', { length: 4 })");
    expect(schema).toContain("name: varchar('name', { length: 35 }).notNull()");
    expect(schema).toContain("currency: varchar('currency', { length: 5 })");
    expect(schema).toContain("factoryCalendar: char('factory_calendar', { length: 2 })");
    expect(schema).toContain("purchasingOrganization: varchar('purchasing_organization', { length: 4 })");
    expect(schema).toContain("referenceSalesOrg: varchar('reference_sales_org', { length: 4 })");
    expect(schema).toContain("rebateProcessingActive: boolean('rebate_processing_active').notNull().default(false)");
    expect(schema).toContain("intercompanyBillingCustomer: varchar('intercompany_billing_customer', { length: 10 })");
    expect(schema).toContain("intercompanyBillingVendor: varchar('intercompany_billing_vendor', { length: 10 })");
    expect(schema).toContain("languageKey: char('language_key', { length: 1 }).notNull()");
    expect(schema).toContain("formText: char('form_text', { length: 12 })");
    expect(schema).toContain('central_address');
    expect(schema).toContain('sales_org_text');
    expect(migration).toContain("sales_org !~ '^[A-Z0-9]{4}$'");
    expect(migration).toContain('char_length(btrim(name)) > 35');
    expect(migration).toContain('CREATE TABLE sales_org_text');
    expect(migration).toContain('name varchar(35) NOT NULL');
    expect(migration).toContain('DROP COLUMN name');
    expect(migration).toContain("SELECT client, sales_org, 'E', btrim(name), 'STANDARD'");
    expect(migration).toContain('ALTER COLUMN currency DROP NOT NULL');
    expect(migration).toContain('sales_org_purchasing_org_fk');
    expect(migration).toContain('sales_org_reference_sales_org_fk');
    expect(migration).toContain('sales_org_intercompany_vendor_fk');
    expect(migration).toContain('sales_org_intercompany_customer_fk');
    expect(migration).toContain('rebate_processing_active boolean NOT NULL DEFAULT false');
    expect(migration).toContain('Cannot add the sales-area organisation reference while orphan sales areas exist.');
    expect(migration).toContain('Cannot add the sales organisation Company Code reference while orphan assignments exist.');
    expect(migration).toContain('ALTER COLUMN company_code DROP NOT NULL');
    expect(migration).toContain('ALTER COLUMN currency TYPE varchar(5) USING btrim(currency)');
    expect(migration).toContain('customer_sales_area_sales_area_fk');
  });

  it('renames the placeholder activity and derives completion from real Sales Organization data', () => {
    expect(activityMigration).toContain("'CFG.SALES.SALESORG.DEFINE'");
    expect(activityMigration).toContain("'CFG.ORG.SALESORG.DEFINE'");
    expect(activityMigration).toContain("THEN 'COMPLETED'");
    expect(activityMigration).toContain('replace(prerequisites');
    expect(activityMigration).toContain('DELETE FROM config_activity_status');
    expect(activityMigration).toContain('FROM sales_org o WHERE o.client = s.client');
  });
});
