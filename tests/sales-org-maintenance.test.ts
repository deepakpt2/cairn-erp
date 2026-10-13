import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { changeHistory } from '@/platform/change';
import { configActivityStatus } from '@/platform/tables/registry';
import { businessPartner, bpRole } from '@/modules/foundation/business-partner-schema';
import { centralAddress } from '@/modules/foundation/central-address-schema';
import { customerSalesArea } from '@/modules/foundation/customer-sales-area-schema';
import { factoryCalendar, salesArea, salesOrg, salesOrgText } from '@/modules/foundation/schema';
import {
  deactivateSalesOrg,
  getSalesOrgDefinitionVersion,
  SalesOrgMaintenanceError,
  saveSalesOrgDefinition,
  type SalesOrgDefinitionValuesInput,
} from '@/modules/foundation/sales-organization-maintenance';
import { closeDb, createTenant, destroyTenant, withTenant, type TestTenant } from './helpers';

const ACTIVITY = 'CFG.ORG.SALESORG.DEFINE';
const ACTOR = 'SCR020_MAINT_TEST';
let alpha: TestTenant | undefined;
let beta: TestTenant | undefined;

function tenantA() {
  if (!alpha) throw new Error('SCR-020 primary tenant fixture was not initialized.');
  return alpha;
}
function tenantB() {
  if (!beta) throw new Error('SCR-020 second tenant fixture was not initialized.');
  return beta;
}
function values(overrides: Partial<SalesOrgDefinitionValuesInput> = {}): SalesOrgDefinitionValuesInput {
  const { address, ...fields } = overrides;
  return {
    name: 'North Sales',
    formText: 'STANDARD',
    currency: 'USD',
    ...fields,
    address: { country: 'KW', ...(address ?? {}) },
  };
}
async function readOrganisation(client: string, code: string, languageKey = 'E') {
  return withTenant(client, async (tx) => {
    const [organisation] = await tx.select().from(salesOrg).where(and(
      eq(salesOrg.client, client), eq(salesOrg.salesOrg, code),
    ));
    if (!organisation) return null;
    const [text] = await tx.select().from(salesOrgText).where(and(
      eq(salesOrgText.client, client), eq(salesOrgText.salesOrg, code), eq(salesOrgText.languageKey, languageKey),
    ));
    const [address] = organisation.addressNumber
      ? await tx.select().from(centralAddress).where(and(
        eq(centralAddress.client, client), eq(centralAddress.addressNumber, organisation.addressNumber),
      ))
      : [undefined];
    return {
      ...organisation,
      salesOrg: organisation.salesOrg.trim(),
      currency: organisation.currency?.trim() ?? null,
      factoryCalendar: organisation.factoryCalendar?.trim() ?? null,
      addressNumber: organisation.addressNumber?.trim() ?? null,
      localizedName: text?.name ?? null,
      languageKey: text?.languageKey.trim() ?? null,
      formText: text?.formText?.trim() ?? null,
      country: address?.country.trim() ?? null,
      searchTerm1: address?.searchTerm1 ?? null,
      searchTerm2: address?.searchTerm2 ?? null,
      street: address?.street ?? null,
      houseNumber: address?.houseNumber ?? null,
      postalCode: address?.postalCode ?? null,
      city: address?.city ?? null,
      region: address?.region ?? null,
      poBox: address?.poBox ?? null,
      poBoxPostalCode: address?.poBoxPostalCode ?? null,
      companyPostalCode: address?.companyPostalCode ?? null,
      telephone: address?.telephone ?? null,
      telephoneExtension: address?.telephoneExtension ?? null,
      mobilePhone: address?.mobilePhone ?? null,
      faxNumber: address?.faxNumber ?? null,
      faxExtension: address?.faxExtension ?? null,
      emailAddress: address?.emailAddress ?? null,
    };
  });
}
async function history(client: string, code: string) {
  return withTenant(client, (tx) => changeHistory(tx, client, 'sales_org', code));
}
async function createDefinition(
  tenant: TestTenant,
  code: string,
  overrides: Partial<SalesOrgDefinitionValuesInput> = {},
  languageKey = 'E',
) {
  return saveSalesOrgDefinition({
    client: tenant.client,
    changedBy: ACTOR,
    languageKey,
    mode: 'CREATE',
    salesOrg: code,
    expectedVersion: 0,
    values: values(overrides),
  });
}
async function setActivity(client: string) {
  await withTenant(client, async (tx) => {
    // Fixture tenants (unlike real onboarding) have no activity-status rows, so the
    // reset must create the row first — otherwise both this reset and the service's
    // completion update are silent no-ops and the assertion sees no row at all.
    await tx
      .insert(configActivityStatus)
      .values({ client, activityCode: ACTIVITY, status: 'NOT_STARTED', createdBy: ACTOR })
      .onConflictDoNothing();
    await tx.update(configActivityStatus).set({
      status: 'NOT_STARTED', completedAt: null, completedBy: null, changedBy: ACTOR, changedAt: new Date(),
    }).where(and(eq(configActivityStatus.client, client), eq(configActivityStatus.activityCode, ACTIVITY)));
  });
}

beforeAll(async () => {
  alpha = await createTenant('scr020-sales-org-maintenance-alpha');
  beta = await createTenant('scr020-sales-org-maintenance-beta');
  await setActivity(alpha.client);
  await setActivity(beta.client);
}, Number(process.env.CAIRN_TEST_HOOK_TIMEOUT_MS ?? 30_000));

afterAll(async () => {
  try {
    if (alpha) await destroyTenant(alpha.client);
  } finally {
    try {
      if (beta) await destroyTenant(beta.client);
    } finally {
      await closeDb();
    }
  }
});

describe('SCR-020 Sales Organization definition service on disposable PostgreSQL', () => {
  it('creates an unassigned organisation with logon-language text, CAM data, vendor/customer references and complete audit', async () => {
    const tenant = tenantA();
    const code = 'S201';
    const vendorCode = '12345';
    const customerCode = 'CUST201';
    await withTenant(tenant.client, async (tx) => {
      await tx.insert(businessPartner).values({
        client: tenant.client, partnerNumber: vendorCode, category: 'ORGANIZATION', name: 'Intercompany Vendor',
        country: 'KW', createdBy: ACTOR,
      });
      await tx.insert(bpRole).values({ client: tenant.client, partnerNumber: vendorCode, roleCode: 'SUPPLIER', isActive: true, createdBy: ACTOR });
      await tx.insert(businessPartner).values({
        client: tenant.client, partnerNumber: customerCode, category: 'ORGANIZATION', name: 'Intercompany Customer',
        country: 'KW', createdBy: ACTOR,
      });
      await tx.insert(bpRole).values({ client: tenant.client, partnerNumber: customerCode, roleCode: 'CUSTOMER', isActive: true, createdBy: ACTOR });
      await tx.insert(factoryCalendar).values({
        client: tenant.client, calendarId: '01', name: 'Factory calendar one', createdBy: ACTOR,
      });
    });

    const result = await saveSalesOrgDefinition({
      client: tenant.client,
      changedBy: ACTOR,
      languageKey: 'D',
      mode: 'CREATE',
      salesOrg: ` ${code} `,
      expectedVersion: 0,
      reason: 'Initial SCR-020 definition',
      values: values({
        name: '  North Sales  ',
        formText: 'STANDARD',
        currency: 'USD',
        factoryCalendar: '01',
        purchasingOrganization: '1000',
        referenceSalesOrg: '1000',
        alePurchaseOrders: true,
        rebateProcessingActive: true,
        intercompanyBillingCustomer: customerCode,
        intercompanyBillingVendor: vendorCode,
        address: {
          country: 'KW', searchTerm1: '  NORTH  ', searchTerm2: 'REGIONAL', street: '  Gulf Road  ',
          houseNumber: '12A', postalCode: '70010', city: 'Al Jahra', region: 'JAH', poBox: '123',
          poBoxPostalCode: '70012', companyPostalCode: '70014', telephone: '+965 2222 0100',
          telephoneExtension: '101', mobilePhone: '+965 5550 0100', faxNumber: '+965 2222 0199',
          faxExtension: '199', emailAddress: 'sales@example.test',
        },
      }),
    });

    expect(result).toMatchObject({ salesOrg: code, created: true, changed: true, isActive: true, companyCode: null, version: 1 });
    expect(result.addressNumber).toMatch(/^\d{10}$/);
    expect(await readOrganisation(tenant.client, code, 'D')).toMatchObject({
      client: tenant.client, salesOrg: code, localizedName: 'North Sales', languageKey: 'D', formText: 'STANDARD',
      currency: 'USD', factoryCalendar: '01', purchasingOrganization: '1000', referenceSalesOrg: '1000',
      alePurchaseOrders: true, rebateProcessingActive: true, intercompanyBillingCustomer: customerCode,
      intercompanyBillingVendor: vendorCode, companyCode: null, isActive: true, addressNumber: result.addressNumber,
      country: 'KW', searchTerm1: 'NORTH', searchTerm2: 'REGIONAL', street: 'Gulf Road', houseNumber: '12A',
      postalCode: '70010', city: 'Al Jahra', region: 'JAH', poBox: '123', poBoxPostalCode: '70012',
      companyPostalCode: '70014', telephone: '+965 2222 0100', telephoneExtension: '101',
      mobilePhone: '+965 5550 0100', faxNumber: '+965 2222 0199', faxExtension: '199',
      emailAddress: 'sales@example.test', createdBy: ACTOR,
    });
    expect(await getSalesOrgDefinitionVersion(tenant.client, code)).toBe(1);
    const [created] = await history(tenant.client, code);
    expect(created).toMatchObject({ changeType: 'CREATE', changedBy: ACTOR, reason: 'Initial SCR-020 definition', transactionCode: ACTIVITY });
    expect(created.items.map((item) => item.fieldName)).toEqual(expect.arrayContaining([
      'salesOrg', 'languageKey', 'name', 'formText', 'currency', 'factoryCalendar', 'purchasingOrganization',
      'referenceSalesOrg', 'intercompanyBillingVendor', 'intercompanyBillingCustomer', 'rebateProcessingActive',
      'alePurchaseOrders', 'addressNumber', 'country', 'searchTerm1', 'street', 'city', 'isActive',
    ]));
    expect(created.items.map((item) => item.fieldName)).not.toContain('companyCode');
    expect(created.items.find((item) => item.fieldName === 'intercompanyBillingVendor')).toMatchObject({
      newValue: '0000012345', isSecurityRelevant: 'true',
    });
    expect(created.items.find((item) => item.fieldName === 'intercompanyBillingCustomer')).toMatchObject({
      newValue: customerCode, isSecurityRelevant: 'true',
    });

    const [status] = await withTenant(tenant.client, (tx) => tx.select().from(configActivityStatus).where(and(
      eq(configActivityStatus.client, tenant.client), eq(configActivityStatus.activityCode, ACTIVITY),
    )));
    expect(status).toMatchObject({ status: 'COMPLETED', completedBy: ACTOR });
  });

  it('changes definition and Central Address fields without overwriting separate Company Code assignment; no-op stays silent', async () => {
    const tenant = tenantA();
    const code = 'S202';
    await createDefinition(tenant, code, { name: 'Before change' });
    await withTenant(tenant.client, (tx) => tx.update(salesOrg).set({ companyCode: tenant.companyCode }).where(and(
      eq(salesOrg.client, tenant.client), eq(salesOrg.salesOrg, code),
    )));

    const unchanged = await saveSalesOrgDefinition({
      client: tenant.client, changedBy: ACTOR, mode: 'CHANGE', salesOrg: code, expectedVersion: 1,
      values: values({ name: 'Before change' }),
    });
    expect(unchanged).toMatchObject({ changed: false, version: 1, companyCode: tenant.companyCode });
    expect(await history(tenant.client, code)).toHaveLength(1);

    const changed = await saveSalesOrgDefinition({
      client: tenant.client, changedBy: ACTOR, mode: 'CHANGE', salesOrg: code, expectedVersion: 1,
      reason: 'Rename and amend address',
      values: values({ name: 'After change', formText: 'B202FORM', address: { country: 'KW', street: 'New Street' } }),
    });
    expect(changed).toMatchObject({ changed: true, version: 2, companyCode: tenant.companyCode });
    expect(await readOrganisation(tenant.client, code)).toMatchObject({
      localizedName: 'After change', formText: 'B202FORM', companyCode: tenant.companyCode,
      isActive: true, changedBy: ACTOR, country: 'KW', street: 'New Street',
    });
    const changes = await history(tenant.client, code);
    expect(changes).toHaveLength(2);
    expect(changes[0].items.map((item) => item.fieldName)).toEqual(expect.arrayContaining(['name', 'formText', 'street']));
    expect(changes.flatMap((entry) => entry.items).map((item) => item.fieldName)).not.toContain('companyCode');
  });

  it('soft-deactivates with retained history, blocks reactivation and refuses Sales Area dependencies', async () => {
    const tenant = tenantA();
    const independentCode = 'S203';
    await createDefinition(tenant, independentCode);
    expect(await readOrganisation(tenant.client, independentCode)).toMatchObject({ rebateProcessingActive: false });
    const deactivated = await deactivateSalesOrg({
      client: tenant.client, changedBy: ACTOR, salesOrg: independentCode, expectedVersion: 1,
      reason: 'Retire unused organisation',
    });
    expect(deactivated).toMatchObject({ salesOrg: independentCode, changed: true, isActive: false, version: 2 });
    expect(await readOrganisation(tenant.client, independentCode)).toMatchObject({ isActive: false, createdBy: ACTOR, changedBy: ACTOR });
    const deactivation = (await history(tenant.client, independentCode)).find((entry) => entry.items.some((item) => item.fieldName === 'isActive'));
    expect(deactivation?.items.find((item) => item.fieldName === 'isActive')).toMatchObject({
      oldValue: 'true', newValue: 'false', isSecurityRelevant: 'true',
    });
    await expect(saveSalesOrgDefinition({
      client: tenant.client, changedBy: ACTOR, mode: 'CHANGE', salesOrg: independentCode,
      expectedVersion: 2, values: values({ name: 'Reactivated Sales' }),
    })).rejects.toBeInstanceOf(SalesOrgMaintenanceError);

    const dependentCode = 'S204';
    await createDefinition(tenant, dependentCode);
    await withTenant(tenant.client, (tx) => tx.insert(salesArea).values({
      client: tenant.client, salesOrg: dependentCode, distributionChannel: '10', division: '00',
      name: 'SCR-020 dependent area', createdBy: ACTOR,
    }));
    await expect(deactivateSalesOrg({
      client: tenant.client, changedBy: ACTOR, salesOrg: dependentCode, expectedVersion: 1,
    })).rejects.toMatchObject({ message: expect.stringContaining('still referenced by sales-area configuration') });
    expect(await readOrganisation(tenant.client, dependentCode)).toMatchObject({ isActive: true });
  });

  it('validates active references, malformed values, stale versions and tenant isolation', async () => {
    const first = tenantA();
    const second = tenantB();
    const customerCode = 'CUST0201';
    await withTenant(first.client, async (tx) => {
      await tx.insert(businessPartner).values({
        client: first.client, partnerNumber: customerCode, category: 'ORGANIZATION', name: 'Intercompany Customer',
        country: 'KW', createdBy: ACTOR,
      });
      await tx.insert(bpRole).values({ client: first.client, partnerNumber: customerCode, roleCode: 'CUSTOMER', isActive: true, createdBy: ACTOR });
    });

    await createDefinition(first, 'S205', { intercompanyBillingCustomer: customerCode });
    await expect(createDefinition(first, 'S206', { currency: 'ZZZ' })).rejects.toBeInstanceOf(SalesOrgMaintenanceError);
    await expect(createDefinition(first, 'S207', { intercompanyBillingCustomer: 'MISSING01' })).rejects.toBeInstanceOf(SalesOrgMaintenanceError);
    await expect(createDefinition(first, 'S212', { purchasingOrganization: '9999' })).rejects.toBeInstanceOf(SalesOrgMaintenanceError);
    await expect(createDefinition(first, 'S216', { referenceSalesOrg: '9999' })).rejects.toBeInstanceOf(SalesOrgMaintenanceError);
    await expect(createDefinition(first, 'S218', { factoryCalendar: '99' })).rejects.toBeInstanceOf(SalesOrgMaintenanceError);
    await expect(createDefinition(first, 'S219', { address: { country: 'ZZ' } })).rejects.toBeInstanceOf(SalesOrgMaintenanceError);
    await expect(saveSalesOrgDefinition({
      client: first.client, changedBy: ACTOR, mode: 'CREATE', salesOrg: 'S220', expectedVersion: 0,
      values: { ...values(), address: { street: 'Address without country' } },
    })).rejects.toBeInstanceOf(SalesOrgMaintenanceError);
    await createDefinition(first, 'S217', { currency: '' });
    expect(await readOrganisation(first.client, 'S217')).toMatchObject({ currency: null });
    await expect(createDefinition(first, 'S213', { intercompanyBillingVendor: customerCode })).rejects.toBeInstanceOf(SalesOrgMaintenanceError);
    await expect(createDefinition(first, 'S214', { intercompanyBillingVendor: 'VENDOR01' })).rejects.toBeInstanceOf(SalesOrgMaintenanceError);
    await expect(saveSalesOrgDefinition({
      client: first.client, changedBy: ACTOR, mode: 'CREATE', salesOrg: 'S208', expectedVersion: 0,
      values: { ...values(), companyCode: first.companyCode } as never,
    })).rejects.toBeInstanceOf(SalesOrgMaintenanceError);

    await createDefinition(first, 'S209');
    await createDefinition(second, 'S209');
    await expect(saveSalesOrgDefinition({
      client: first.client, changedBy: ACTOR, mode: 'CHANGE', salesOrg: 'S209', expectedVersion: 0,
      values: values({ name: 'Stale update' }),
    })).rejects.toBeInstanceOf(SalesOrgMaintenanceError);
    await saveSalesOrgDefinition({
      client: first.client, changedBy: ACTOR, mode: 'CHANGE', salesOrg: 'S209', expectedVersion: 1,
      values: values({ name: 'Tenant A updated' }),
    });
    expect(await readOrganisation(first.client, 'S209')).toMatchObject({ localizedName: 'Tenant A updated' });
    expect(await readOrganisation(second.client, 'S209')).toMatchObject({ localizedName: 'North Sales' });
    expect(await getSalesOrgDefinitionVersion(first.client, 'S209')).toBe(2);
    expect(await getSalesOrgDefinitionVersion(second.client, 'S209')).toBe(1);
    expect(await history(first.client, 'S209')).toHaveLength(2);
    expect(await history(second.client, 'S209')).toHaveLength(1);
  });

  it('rejects blocked intercompany customers and vendors even when partner-role rows remain active', async () => {
    const tenant = tenantA();
    const customerCode = 'CUST0202';
    const vendorCode = '20202';
    await withTenant(tenant.client, async (tx) => {
      await tx.insert(businessPartner).values({
        client: tenant.client, partnerNumber: customerCode, category: 'ORGANIZATION', name: 'Blocked customer',
        country: 'KW', isBlocked: true, createdBy: ACTOR,
      });
      await tx.insert(bpRole).values({ client: tenant.client, partnerNumber: customerCode, roleCode: 'CUSTOMER', isActive: true, createdBy: ACTOR });
      await tx.insert(businessPartner).values({
        client: tenant.client, partnerNumber: vendorCode, category: 'ORGANIZATION', name: 'Blocked supplier',
        country: 'KW', isBlocked: true, createdBy: ACTOR,
      });
      await tx.insert(bpRole).values({ client: tenant.client, partnerNumber: vendorCode, roleCode: 'SUPPLIER', isActive: true, createdBy: ACTOR });
    });
    await expect(createDefinition(tenant, 'S210', { intercompanyBillingCustomer: customerCode })).rejects.toBeInstanceOf(SalesOrgMaintenanceError);
    expect(await readOrganisation(tenant.client, 'S210')).toBeNull();
    await expect(createDefinition(tenant, 'S215', { intercompanyBillingVendor: vendorCode })).rejects.toBeInstanceOf(SalesOrgMaintenanceError);
    expect(await readOrganisation(tenant.client, 'S215')).toBeNull();
  });

  it('keeps customer Sales Area dependents in the blocked deactivation path', async () => {
    const tenant = tenantA();
    const code = 'S211';
    const customerCode = 'CUST0211';
    await createDefinition(tenant, code);
    await withTenant(tenant.client, async (tx) => {
      await tx.insert(salesArea).values({
        client: tenant.client, salesOrg: code, distributionChannel: '11', division: '00',
        name: 'SCR-020 customer area', createdBy: ACTOR,
      });
      await tx.insert(businessPartner).values({
        client: tenant.client, partnerNumber: customerCode, category: 'ORGANIZATION', name: 'Customer with sales data',
        country: 'KW', createdBy: ACTOR,
      });
      await tx.insert(bpRole).values({ client: tenant.client, partnerNumber: customerCode, roleCode: 'CUSTOMER', isActive: true, createdBy: ACTOR });
      await tx.insert(customerSalesArea).values({
        client: tenant.client, partnerNumber: customerCode, salesOrg: code,
        distributionChannel: '11', division: '00', roleCode: 'CUSTOMER', createdBy: ACTOR,
      });
    });
    await expect(deactivateSalesOrg({ client: tenant.client, changedBy: ACTOR, salesOrg: code, expectedVersion: 1 }))
      .rejects.toBeInstanceOf(SalesOrgMaintenanceError);
    expect(await readOrganisation(tenant.client, code)).toMatchObject({ isActive: true });
  });
});
