/** Audited tenant-scoped Sales Organization definition — SCR-020. Company Code assignment is SCR-021. */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { changeDocument } from '../../platform/tables/audit-trail';
import { country as countryReference, currency as currencyReference } from '../../platform/tables/reference';
import { businessPartner, bpRole } from './business-partner-schema';
import { customerSalesArea } from './customer-sales-area-schema';
import { createCentralAddress } from './central-address-maintenance';
import { centralAddress } from './central-address-schema';
import { factoryCalendar as factoryCalendarTable, purchasingOrg as purchasingOrgTable, salesArea, salesOrg as salesOrgTable, salesOrgText } from './schema';

const SALES_ORG_ACTIVITY = 'CFG.ORG.SALESORG.DEFINE';
const SALES_ORG_OBJECT_CLASS = 'sales_org';

const tenantKeySchema = z.string().regex(/^[A-Za-z0-9]{2,4}$/);
const salesOrgCodeSchema = z.string().trim().regex(/^[A-Z0-9]{4}$/);
const optionalReasonSchema = z.string().trim().max(500).optional().transform((value) => value || undefined);
const nullableText = (max: number) => z.string().trim().max(max).optional().transform((value) => value || null);
const optionalCustomerNumber = z
  .string()
  .trim()
  .max(10)
  .regex(/^([A-Z0-9][A-Z0-9_.-]{0,9})?$/)
  .optional()
  .transform((value) => value || null);
const optionalPurchasingOrganization = z
  .string()
  .trim()
  .regex(/^([A-Z0-9]{4})?$/)
  .optional()
  .transform((value) => value || null);
const optionalFactoryCalendar = z
  .string()
  .trim()
  .regex(/^([A-Z0-9]{2})?$/)
  .optional()
  .transform((value) => value || null);
/** Preserve the referenced Business Partner key; the OVX5 UI displays its numeric value as 10-digit, zero-padded. */
const optionalVendorNumber = z
  .string()
  .trim()
  .max(10)
  .regex(/^([0-9]{1,10})?$/)
  .optional()
  .transform((value) => value || null);

/** CAM fields are entered only through the address dialog and stored in central_address. */
export const salesOrgAddressValuesSchema = z.object({
  country: z.string().trim().regex(/^([A-Z]{2})?$/).optional().transform((value) => value || null),
  searchTerm1: nullableText(20),
  searchTerm2: nullableText(20),
  street: nullableText(60),
  houseNumber: nullableText(10),
  postalCode: nullableText(10),
  city: nullableText(40),
  region: nullableText(3),
  poBox: nullableText(10),
  poBoxPostalCode: nullableText(10),
  companyPostalCode: nullableText(10),
  telephone: nullableText(30),
  telephoneExtension: nullableText(10),
  mobilePhone: nullableText(30),
  faxNumber: nullableText(30),
  faxExtension: nullableText(10),
  emailAddress: nullableText(241),
}).strict();

/** Definition-only fields; localized descriptions are keyed by the one-character logon language, and Company Code remains SCR-021. */
export const salesOrgDefinitionValuesSchema = z.object({
  name: z.string().trim().min(1).max(35),
  formText: nullableText(12),
  currency: z.string().trim().max(5).optional()
    .transform((value) => value || null)
    .refine((value) => value === null || /^[A-Z0-9]{3,5}$/.test(value), 'Currency Key must contain 3 to 5 uppercase alphanumeric characters.'),
  factoryCalendar: optionalFactoryCalendar,
  purchasingOrganization: optionalPurchasingOrganization,
  referenceSalesOrg: optionalPurchasingOrganization,
  alePurchaseOrders: z.boolean().optional().default(false),
  rebateProcessingActive: z.boolean().optional().default(false),
  address: salesOrgAddressValuesSchema.optional().default({}),
  intercompanyBillingCustomer: optionalCustomerNumber,
  intercompanyBillingVendor: optionalVendorNumber,
}).strict();

export const salesOrgMaintenanceModeSchema = z.enum(['CREATE', 'CHANGE']);
export const salesOrgMaintenanceInputSchema = z.object({
  client: tenantKeySchema,
  changedBy: z.string().trim().min(1).max(60),
  /** One-character logon-language key supplied from the verified session. */
  languageKey: z.string().trim().regex(/^[A-Z]$/).default('E'),
  mode: salesOrgMaintenanceModeSchema,
  salesOrg: salesOrgCodeSchema,
  expectedVersion: z.number().int().nonnegative(),
  reason: optionalReasonSchema,
  values: salesOrgDefinitionValuesSchema,
}).strict();
export const salesOrgDeactivationInputSchema = z.object({
  client: tenantKeySchema,
  changedBy: z.string().trim().min(1).max(60),
  salesOrg: salesOrgCodeSchema,
  expectedVersion: z.number().int().nonnegative(),
  reason: optionalReasonSchema,
}).strict();
const salesOrgVersionInputSchema = z.object({ client: tenantKeySchema, salesOrg: salesOrgCodeSchema }).strict();

export type SalesOrgDefinitionValuesInput = z.input<typeof salesOrgDefinitionValuesSchema>;
export type SalesOrgDefinitionValues = z.output<typeof salesOrgDefinitionValuesSchema>;
export type SalesOrgMaintenanceInput = z.input<typeof salesOrgMaintenanceInputSchema>;
export type SalesOrgMaintenanceMode = z.infer<typeof salesOrgMaintenanceModeSchema>;
export type SalesOrgDeactivationInput = z.input<typeof salesOrgDeactivationInputSchema>;

type SalesOrgRow = typeof salesOrgTable.$inferSelect;
type SalesOrgTextRow = typeof salesOrgText.$inferSelect;
type CentralAddressRow = typeof centralAddress.$inferSelect;
type AddressValues = SalesOrgDefinitionValues['address'];
type DefinitionSnapshot = {
  salesOrg: string;
  languageKey: string;
  name: string | null;
  formText: string | null;
  currency: string | null;
  factoryCalendar: string | null;
  purchasingOrganization: string | null;
  referenceSalesOrg: string | null;
  alePurchaseOrders: boolean;
  rebateProcessingActive: boolean;
  intercompanyBillingCustomer: string | null;
  intercompanyBillingVendor: string | null;
  addressNumber: string | null;
  country: string | null;
  searchTerm1: string | null;
  searchTerm2: string | null;
  street: string | null;
  houseNumber: string | null;
  postalCode: string | null;
  city: string | null;
  region: string | null;
  poBox: string | null;
  poBoxPostalCode: string | null;
  companyPostalCode: string | null;
  telephone: string | null;
  telephoneExtension: string | null;
  mobilePhone: string | null;
  faxNumber: string | null;
  faxExtension: string | null;
  emailAddress: string | null;
  isActive: boolean;
};
const EDITABLE_FIELDS: Array<keyof Omit<DefinitionSnapshot, 'salesOrg' | 'isActive'>> = [
  'languageKey', 'name', 'formText', 'currency', 'factoryCalendar', 'purchasingOrganization', 'referenceSalesOrg',
  'alePurchaseOrders', 'rebateProcessingActive', 'intercompanyBillingCustomer', 'intercompanyBillingVendor',
  'addressNumber', 'country', 'searchTerm1', 'searchTerm2', 'street', 'houseNumber', 'postalCode', 'city', 'region',
  'poBox', 'poBoxPostalCode', 'companyPostalCode', 'telephone', 'telephoneExtension', 'mobilePhone', 'faxNumber',
  'faxExtension', 'emailAddress',
];
const FIELD_LABELS: Record<string, string> = {
  salesOrg: 'Sales Organization', languageKey: 'Logon language', name: 'Name / Description', formText: 'Form Text',
  currency: 'Currency Key', factoryCalendar: 'Factory Calendar', purchasingOrganization: 'Purch. Organization',
  referenceSalesOrg: 'Ref. Sales Org for Sales Docs', alePurchaseOrders: 'ALE Purchase Orders',
  rebateProcessingActive: 'Rebate Processing Active', addressNumber: 'Address Number', country: 'Country',
  searchTerm1: 'Search term 1', searchTerm2: 'Search term 2', street: 'Street', houseNumber: 'House number',
  postalCode: 'Postal code', city: 'City', region: 'Region', poBox: 'P.O. box', poBoxPostalCode: 'P.O. box postal code',
  companyPostalCode: 'Company postal code', telephone: 'Telephone', telephoneExtension: 'Telephone extension',
  mobilePhone: 'Mobile phone', faxNumber: 'Fax', faxExtension: 'Fax extension', emailAddress: 'E-mail address',
  intercompanyBillingCustomer: 'Customer for Intercompany Billing', intercompanyBillingVendor: 'Vendor',
  isActive: 'Active',
};

export class SalesOrgMaintenanceError extends Error {
  readonly code = 'CAIRN_CONFIG';
  constructor(message: string, readonly remedy = 'Review the Sales Organization definition and try again.') {
    super(message);
    this.name = 'SalesOrgMaintenanceError';
  }
}

function stringOrNull(value: string | null | undefined): string | null {
  return value?.trim() || null;
}
function hasAddress(values: AddressValues): boolean {
  return Object.values(values).some((value) => typeof value === 'string' && value.trim() !== '');
}
function sameAddress(before: AddressValues, after: AddressValues): boolean {
  return (Object.keys(before) as Array<keyof AddressValues>).every((field) => before[field] === after[field]);
}
function addressFromRow(row: CentralAddressRow | undefined): AddressValues {
  return {
    country: stringOrNull(row?.country),
    searchTerm1: row?.searchTerm1 ?? null,
    searchTerm2: row?.searchTerm2 ?? null,
    street: row?.street ?? null,
    houseNumber: row?.houseNumber ?? null,
    postalCode: row?.postalCode ?? null,
    city: row?.city ?? null,
    region: row?.region ?? null,
    poBox: row?.poBox ?? null,
    poBoxPostalCode: row?.poBoxPostalCode ?? null,
    companyPostalCode: row?.companyPostalCode ?? null,
    telephone: row?.telephone ?? null,
    telephoneExtension: row?.telephoneExtension ?? null,
    mobilePhone: row?.mobilePhone ?? null,
    faxNumber: row?.faxNumber ?? null,
    faxExtension: row?.faxExtension ?? null,
    emailAddress: row?.emailAddress ?? null,
  };
}
function currentSnapshot(
  code: string,
  row: SalesOrgRow,
  text: SalesOrgTextRow | undefined,
  address: CentralAddressRow | undefined,
  languageKey: string,
): DefinitionSnapshot {
  return {
    salesOrg: code,
    languageKey,
    name: stringOrNull(text?.name),
    formText: stringOrNull(text?.formText),
    currency: stringOrNull(row.currency),
    factoryCalendar: stringOrNull(row.factoryCalendar),
    purchasingOrganization: stringOrNull(row.purchasingOrganization),
    referenceSalesOrg: stringOrNull(row.referenceSalesOrg),
    alePurchaseOrders: row.alePurchaseOrders,
    rebateProcessingActive: row.rebateProcessingActive,
    intercompanyBillingCustomer: stringOrNull(row.intercompanyBillingCustomer),
    intercompanyBillingVendor: stringOrNull(row.intercompanyBillingVendor),
    addressNumber: stringOrNull(row.addressNumber),
    ...addressFromRow(address),
    isActive: row.isActive,
  };
}
function inputSnapshot(
  code: string,
  values: SalesOrgDefinitionValues,
  languageKey: string,
  addressNumber: string | null,
  isActive: boolean,
): DefinitionSnapshot {
  return {
    salesOrg: code,
    languageKey,
    name: values.name,
    formText: values.formText,
    currency: values.currency,
    factoryCalendar: values.factoryCalendar,
    purchasingOrganization: values.purchasingOrganization,
    referenceSalesOrg: values.referenceSalesOrg,
    alePurchaseOrders: values.alePurchaseOrders,
    rebateProcessingActive: values.rebateProcessingActive,
    intercompanyBillingCustomer: values.intercompanyBillingCustomer,
    intercompanyBillingVendor: values.intercompanyBillingVendor,
    addressNumber,
    ...values.address,
    isActive,
  };
}
function sameDefinition(before: DefinitionSnapshot, after: DefinitionSnapshot): boolean {
  return EDITABLE_FIELDS.every((field) => before[field] === after[field]);
}
function auditSnapshot(snapshot: DefinitionSnapshot) {
  const definition = Object.fromEntries([
    'salesOrg', ...EDITABLE_FIELDS, 'isActive',
  ].map((field) => [field, snapshot[field as keyof DefinitionSnapshot]]));
  const vendor = definition.intercompanyBillingVendor;
  if (typeof vendor === 'string' && /^[0-9]{1,10}$/.test(vendor)) {
    definition.intercompanyBillingVendor = vendor.padStart(10, '0');
  }
  // Company Code is deliberately excluded; its changes belong solely to SCR-021.
  return definition;
}
function organisationFields(values: SalesOrgDefinitionValues) {
  return {
    currency: values.currency,
    factoryCalendar: values.factoryCalendar,
    purchasingOrganization: values.purchasingOrganization,
    referenceSalesOrg: values.referenceSalesOrg,
    alePurchaseOrders: values.alePurchaseOrders,
    rebateProcessingActive: values.rebateProcessingActive,
    intercompanyBillingCustomer: values.intercompanyBillingCustomer,
    intercompanyBillingVendor: values.intercompanyBillingVendor,
  };
}
function centralAddressValues(values: AddressValues) {
  if (!values.country) throw new SalesOrgMaintenanceError('Country is required when maintaining a Central Address.', 'Choose a country in the Address Dialog or clear all address fields to leave ADRNR blank.');
  return { ...values, country: values.country };
}

async function validateReferences(tx: Tx, client: string, values: SalesOrgDefinitionValues) {
  if (values.currency) {
    const [currency] = await tx.select({ code: currencyReference.code }).from(currencyReference).where(and(
      eq(currencyReference.code, values.currency), eq(currencyReference.isActive, true),
    ));
    if (!currency) throw new SalesOrgMaintenanceError('Currency is not an active reference currency.', 'Choose a currency from the reference list or leave it blank.');
  }

  if (hasAddress(values.address)) {
    if (!values.address.country) throw new SalesOrgMaintenanceError('Country is required when maintaining a Central Address.', 'Choose a country in the Address Dialog or clear all address fields to leave ADRNR blank.');
    const [country] = await tx.select({ code: countryReference.code }).from(countryReference).where(eq(countryReference.code, values.address.country));
    if (!country) throw new SalesOrgMaintenanceError('Address country is not in the reference catalogue.', 'Choose a country from the Address Dialog country list.');
  }

  if (values.factoryCalendar) {
    const [calendar] = await tx.select({ code: factoryCalendarTable.calendarId }).from(factoryCalendarTable).where(and(
      eq(factoryCalendarTable.client, client),
      eq(factoryCalendarTable.calendarId, values.factoryCalendar),
      eq(factoryCalendarTable.isActive, true),
    ));
    if (!calendar) throw new SalesOrgMaintenanceError(
      'Factory Calendar is not active in this tenant\'s calendar customizing.',
      'Choose an active two-character calendar from the value help or leave the field blank.',
    );
  }

  if (values.purchasingOrganization) {
    const [purchasingOrganization] = await tx.select({ code: purchasingOrgTable.purchasingOrg })
      .from(purchasingOrgTable).where(and(
        eq(purchasingOrgTable.client, client),
        eq(purchasingOrgTable.purchasingOrg, values.purchasingOrganization),
        eq(purchasingOrgTable.isActive, true),
      ));
    if (!purchasingOrganization) throw new SalesOrgMaintenanceError(
      'Purch. Organization is not an active Purchasing Organization in this tenant.',
      'Choose an active four-character Purchasing Organization or leave the field blank.',
    );
  }

  if (values.referenceSalesOrg) {
    const [referenceSalesOrg] = await tx.select({ code: salesOrgTable.salesOrg }).from(salesOrgTable).where(and(
      eq(salesOrgTable.client, client),
      eq(salesOrgTable.salesOrg, values.referenceSalesOrg),
      eq(salesOrgTable.isActive, true),
    ));
    if (!referenceSalesOrg) throw new SalesOrgMaintenanceError(
      'Reference Sales Organization is not an active Sales Organization in this tenant.',
      'Choose an existing active Sales Organization or leave the field blank.',
    );
  }

  if (values.intercompanyBillingVendor) {
    const [vendor] = await tx.select({ partnerNumber: businessPartner.partnerNumber }).from(businessPartner)
      .innerJoin(bpRole, and(
        eq(bpRole.client, businessPartner.client),
        eq(bpRole.partnerNumber, businessPartner.partnerNumber),
        eq(bpRole.roleCode, 'SUPPLIER'),
        eq(bpRole.isActive, true),
      ))
      .where(and(
        eq(businessPartner.client, client),
        eq(businessPartner.partnerNumber, values.intercompanyBillingVendor),
        eq(businessPartner.isBlocked, false),
      ));
    if (!vendor) throw new SalesOrgMaintenanceError(
      'Vendor is not an active Supplier in this tenant.',
      'Choose an existing active numeric Vendor or leave the field blank.',
    );
  }

  if (values.intercompanyBillingCustomer) {
    const [customer] = await tx.select({ partnerNumber: businessPartner.partnerNumber }).from(businessPartner)
      .innerJoin(bpRole, and(
        eq(bpRole.client, businessPartner.client),
        eq(bpRole.partnerNumber, businessPartner.partnerNumber),
        eq(bpRole.roleCode, 'CUSTOMER'),
        eq(bpRole.isActive, true),
      ))
      .where(and(
        eq(businessPartner.client, client),
        eq(businessPartner.partnerNumber, values.intercompanyBillingCustomer),
        eq(businessPartner.isBlocked, false),
      ));
    if (!customer) throw new SalesOrgMaintenanceError('Intercompany billing customer is not an active customer in this tenant.', 'Choose an existing active customer or leave the field blank.');
  }
}

/** Read the optimistic change-document-count version for an existing tenant Sales Organization. */
export async function getSalesOrgDefinitionVersion(client: string, salesOrg: string): Promise<number> {
  const parsed = salesOrgVersionInputSchema.safeParse({ client, salesOrg });
  if (!parsed.success) throw invalidInput(parsed.error);
  return withTenant(parsed.data.client, (tx) => auditVersion(tx, parsed.data.client, parsed.data.salesOrg));
}

async function auditVersion(tx: Tx, client: string, code: string): Promise<number> {
  const [row] = await tx.select({ version: sql<number>`count(*)::int` }).from(changeDocument).where(and(
    eq(changeDocument.client, client),
    eq(changeDocument.objectClass, SALES_ORG_OBJECT_CLASS),
    eq(changeDocument.objectKey, code),
  ));
  return row?.version ?? 0;
}
async function lockSalesOrg(tx: Tx, client: string, code: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/sales_org/${code}`}, 0))`);
}
function invalidInput(error: z.ZodError): SalesOrgMaintenanceError {
  return new SalesOrgMaintenanceError(error.issues[0]?.message ?? 'Sales Organization definition is invalid.', 'Correct the indicated value and submit again.');
}
function staleVersion(code: string): SalesOrgMaintenanceError {
  return new SalesOrgMaintenanceError(`Sales Organization ${code} changed after it was opened.`, 'Reload the current definition before saving your changes.');
}

/** Create an unassigned Sales Organization or change its definition; the key is immutable. */
export async function saveSalesOrgDefinition(raw: SalesOrgMaintenanceInput) {
  const parsed = salesOrgMaintenanceInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);
  const { client, changedBy, languageKey, mode, salesOrg: code, expectedVersion, reason, values } = parsed.data;
  const orgFields = organisationFields(values);

  return withTenant(client, async (tx) => {
    await lockSalesOrg(tx, client, code);
    const [current] = await tx.select().from(salesOrgTable).where(and(
      eq(salesOrgTable.client, client), eq(salesOrgTable.salesOrg, code),
    )).for('update');
    const version = await auditVersion(tx, client, code);

    if (mode === 'CREATE') {
      if (current) throw new SalesOrgMaintenanceError(`Sales Organization ${code} already exists.`, 'Choose an unused code; inactive keys are retained and cannot be reused.');
      if (expectedVersion !== 0 || version !== 0) throw staleVersion(code);
      await validateReferences(tx, client, values);
      const addressNumber = hasAddress(values.address)
        ? await createCentralAddress(tx, client, changedBy, centralAddressValues(values.address))
        : null;
      await tx.insert(salesOrgTable).values({
        client, salesOrg: code, ...orgFields, addressNumber, companyCode: null, isActive: true, createdBy: changedBy,
      });
      await tx.insert(salesOrgText).values({
        client, salesOrg: code, languageKey, name: values.name, formText: values.formText, createdBy: changedBy,
      });
      const after = inputSnapshot(code, values, languageKey, addressNumber, true);
      const changeId = await recordChange(tx, {
        client, objectClass: SALES_ORG_OBJECT_CLASS, objectKey: code, changeType: 'CREATE', changedBy,
        transactionCode: SALES_ORG_ACTIVITY, reason,
        after: auditSnapshot(after),
        securityRelevantFields: ['isActive', 'intercompanyBillingCustomer', 'intercompanyBillingVendor', 'rebateProcessingActive', 'alePurchaseOrders'],
        fieldLabels: FIELD_LABELS,
      });
      if (!changeId) throw new SalesOrgMaintenanceError('Sales Organization creation could not be recorded in change history.');
      await markActivityComplete(tx, client, SALES_ORG_ACTIVITY, changedBy);
      return { salesOrg: code, addressNumber, created: true as const, changed: true as const, isActive: true, companyCode: null, version: version + 1 };
    }

    if (!current) throw new SalesOrgMaintenanceError(`Sales Organization ${code} was not found.`, 'Return to the overview and select an existing organization.');
    if (!current.isActive) throw new SalesOrgMaintenanceError(`Sales Organization ${code} is inactive and cannot be reactivated.`, 'Create a new organization with an unused code if a replacement is needed.');
    if (expectedVersion !== version) throw staleVersion(code);
    await validateReferences(tx, client, values);

    const [currentText] = await tx.select().from(salesOrgText).where(and(
      eq(salesOrgText.client, client), eq(salesOrgText.salesOrg, code), eq(salesOrgText.languageKey, languageKey),
    )).for('update');
    const [currentAddress] = current.addressNumber
      ? await tx.select().from(centralAddress).where(and(
        eq(centralAddress.client, client), eq(centralAddress.addressNumber, current.addressNumber),
      )).for('update')
      : [undefined];
    if (current.addressNumber && !currentAddress) throw new SalesOrgMaintenanceError(
      `Sales Organization ${code} refers to a missing Central Address.`,
      'Repair the Central Address reference before changing this organization.',
    );

    const before = currentSnapshot(code, current, currentText, currentAddress, languageKey);
    const wantsAddress = hasAddress(values.address);
    const addressNumber = wantsAddress
      ? current.addressNumber?.trim() ?? null
      : null;
    const after = inputSnapshot(code, values, languageKey, addressNumber, true);
    if (sameDefinition(before, after)) return {
      salesOrg: code, addressNumber, created: false as const, changed: false as const,
      isActive: current.isActive, companyCode: current.companyCode, version,
    };

    let resultingAddressNumber = addressNumber;
    if (wantsAddress && !resultingAddressNumber) {
      resultingAddressNumber = await createCentralAddress(tx, client, changedBy, centralAddressValues(values.address));
    } else if (wantsAddress && resultingAddressNumber && currentAddress
      && !sameAddress(addressFromRow(currentAddress), values.address)) {
      await tx.update(centralAddress).set({
        ...centralAddressValues(values.address), changedBy, changedAt: new Date(),
      }).where(and(
        eq(centralAddress.client, client), eq(centralAddress.addressNumber, resultingAddressNumber),
      ));
    }

    await tx.update(salesOrgTable).set({
      ...orgFields,
      addressNumber: resultingAddressNumber,
      changedBy,
      changedAt: new Date(),
    }).where(and(eq(salesOrgTable.client, client), eq(salesOrgTable.salesOrg, code)));

    if (currentText) {
      if (currentText.name.trim() !== values.name || (currentText.formText?.trim() ?? null) !== values.formText) {
        await tx.update(salesOrgText).set({
          name: values.name, formText: values.formText, changedBy, changedAt: new Date(),
        }).where(and(
          eq(salesOrgText.client, client), eq(salesOrgText.salesOrg, code), eq(salesOrgText.languageKey, languageKey),
        ));
      }
    } else {
      await tx.insert(salesOrgText).values({
        client, salesOrg: code, languageKey, name: values.name, formText: values.formText, createdBy: changedBy,
      });
    }

    const addressAfter = wantsAddress
      ? { ...values.address, country: values.address.country! }
      : addressFromRow(undefined);
    const auditAfter = { ...after, addressNumber: resultingAddressNumber, ...addressAfter };
    const changeId = await recordChange(tx, {
      client, objectClass: SALES_ORG_OBJECT_CLASS, objectKey: code, changeType: 'CHANGE', changedBy,
      transactionCode: SALES_ORG_ACTIVITY, reason,
      before: auditSnapshot(before), after: auditSnapshot(auditAfter),
      securityRelevantFields: ['intercompanyBillingCustomer', 'intercompanyBillingVendor', 'rebateProcessingActive', 'alePurchaseOrders'],
      fieldLabels: FIELD_LABELS,
    });
    if (!changeId) throw new SalesOrgMaintenanceError('Sales Organization change could not be recorded in change history.');
    await markActivityComplete(tx, client, SALES_ORG_ACTIVITY, changedBy);
    return {
      salesOrg: code, addressNumber: resultingAddressNumber, created: false as const, changed: true as const,
      isActive: true, companyCode: current.companyCode, version: version + 1,
    };
  });
}

/** Soft deactivation only; dependent sales-area data prevents deactivation. */
export async function deactivateSalesOrg(raw: SalesOrgDeactivationInput) {
  const parsed = salesOrgDeactivationInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);
  const { client, changedBy, salesOrg: code, expectedVersion, reason } = parsed.data;
  return withTenant(client, async (tx) => {
    await lockSalesOrg(tx, client, code);
    const [current] = await tx.select().from(salesOrgTable).where(and(
      eq(salesOrgTable.client, client), eq(salesOrgTable.salesOrg, code),
    )).for('update');
    if (!current) throw new SalesOrgMaintenanceError(`Sales Organization ${code} was not found.`, 'Return to the overview and select an existing organization.');
    const version = await auditVersion(tx, client, code);
    if (expectedVersion !== version) throw staleVersion(code);
    if (!current.isActive) return { salesOrg: code, changed: false as const, isActive: false, version };

    const [area] = await tx.select({ salesOrg: salesArea.salesOrg }).from(salesArea).where(and(
      eq(salesArea.client, client), eq(salesArea.salesOrg, code),
    )).limit(1);
    const [customerArea] = await tx.select({ salesOrg: customerSalesArea.salesOrg }).from(customerSalesArea).where(and(
      eq(customerSalesArea.client, client), eq(customerSalesArea.salesOrg, code),
    )).limit(1);
    if (area || customerArea) throw new SalesOrgMaintenanceError(
      `Sales Organization ${code} is still referenced by sales-area configuration and cannot be deactivated.`,
      'Retain the organization while sales-area records depend on it.',
    );

    await tx.update(salesOrgTable).set({ isActive: false, changedBy, changedAt: new Date() }).where(and(
      eq(salesOrgTable.client, client), eq(salesOrgTable.salesOrg, code),
    ));
    const changeId = await recordChange(tx, {
      client, objectClass: SALES_ORG_OBJECT_CLASS, objectKey: code, changeType: 'CHANGE', changedBy,
      transactionCode: SALES_ORG_ACTIVITY, reason,
      before: { salesOrg: code, isActive: true }, after: { salesOrg: code, isActive: false },
      securityRelevantFields: ['isActive'], fieldLabels: FIELD_LABELS,
    });
    if (!changeId) throw new SalesOrgMaintenanceError('Sales Organization deactivation could not be recorded in change history.');
    return { salesOrg: code, changed: true as const, isActive: false, version: version + 1 };
  });
}
