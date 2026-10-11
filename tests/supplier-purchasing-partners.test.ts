import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, createTenant, db, destroyTenant, withTenant, type TestTenant } from './helpers';
import { saveBusinessPartner } from '../src/modules/foundation/business-partners';
import { listSupplierPartnerChoices, listSupplierPartnerFunctions, listSupplierPurchasingPartners } from '../src/modules/foundation/supplier-purchasing-partners';
import { supplierPartnerFunction, supplierPurchasingPartner } from '../src/modules/foundation/supplier-partner-schema';
import { saveSupplierPurchasing } from '../src/modules/foundation/supplier-purchasing';
import { applyStandardPackage } from '../src/modules/foundation/standard-config';

let alpha: TestTenant;
let beta: TestTenant;
let defaults: TestTenant;

async function partner(tenant: TestTenant, number: string, roles: ['SUPPLIER'] | ['CUSTOMER'] = ['SUPPLIER']) {
  await saveBusinessPartner({
    client: tenant.client, partnerNumber: number, expectedVersion: 0, changedBy: 'TEST',
    reason: 'Supplier partner read fixture', category: 'ORGANIZATION', name: `${number} Example Supplier`,
    name2: '', searchTerm: number, country: 'KW', region: '', street: 'Test street', city: 'Kuwait City',
    postalCode: '', taxNumber: '', email: '', phone: '', roles, isBlocked: false,
  });
}

beforeAll(async () => {
  alpha = await createTenant('supplier-partner-read-alpha');
  beta = await createTenant('supplier-partner-read-beta', { withConfiguration: false });
  defaults = await createTenant('supplier-partner-read-defaults');
  for (const number of ['ORDEROWNER', 'ALTORDER', 'ALTDELIVERY']) await partner(alpha, number);
  await partner(alpha, 'READCUSTOMER', ['CUSTOMER']);
  await saveSupplierPurchasing({
    client: alpha.client, partnerNumber: 'ORDEROWNER', purchasingOrg: '1000', expectedVersion: 0,
    changedBy: 'TEST', reason: 'Supplier partner read fixture', orderCurrency: alpha.currency,
    purchasingGroup: '001', incotermsCode: 'FCA', incotermsLocation: 'Kuwait City',
    paymentTermsCode: 'NET30', isBlocked: false,
  });
  await withTenant(alpha.client, async tx => {
    // Test a tenant-level multiple rule and an inactive historical function without
    // changing the standard package's unique initial settings.
    await tx.update(supplierPartnerFunction)
      .set({ allowsMultiple: true, changedBy: 'TEST' })
      .where(and(eq(supplierPartnerFunction.client, alpha.client), eq(supplierPartnerFunction.functionCode, 'ORDERING_PARTNER')));
    await tx.update(supplierPartnerFunction)
      .set({ isActive: false, changedBy: 'TEST' })
      .where(and(eq(supplierPartnerFunction.client, alpha.client), eq(supplierPartnerFunction.functionCode, 'DELIVERY_PARTNER')));
    await tx.insert(supplierPurchasingPartner).values([
      { client: alpha.client, partnerNumber: 'ORDEROWNER', purchasingOrg: '1000', functionCode: 'ORDERING_PARTNER', assignedPartnerNumber: 'ALTORDER', isDefault: true, createdBy: 'TEST' },
      { client: alpha.client, partnerNumber: 'ORDEROWNER', purchasingOrg: '1000', functionCode: 'DELIVERY_PARTNER', assignedPartnerNumber: 'ALTDELIVERY', createdBy: 'TEST' },
    ]);
  });
});

afterAll(async () => {
  await destroyTenant(alpha.client);
  await destroyTenant(beta.client);
  await destroyTenant(defaults.client);
  await closeDb();
});

describe('supplier purchasing partner-function read services', () => {
  it('seeds all standard catalogue functions with the approved unique initial settings', async () => {
    const rows = await listSupplierPartnerFunctions(defaults.client);
    expect(rows.map(row => [row.functionCode, row.displayName, row.allowsMultiple, row.isActive])).toEqual([
      ['DELIVERY_PARTNER', 'Delivery partner', false, true],
      ['INVOICE_SENDER', 'Invoice sender', false, true],
      ['ORDERING_PARTNER', 'Ordering partner', false, true],
    ]);
    expect(await listSupplierPartnerFunctions(beta.client)).toEqual([]);
  });

  it('lists only same-tenant active Supplier roles as assignment choices', async () => {
    expect((await listSupplierPartnerChoices(alpha.client)).map(row => row.partnerNumber)).toEqual([
      'ALTDELIVERY', 'ALTORDER', 'ORDEROWNER',
    ]);
    expect(await listSupplierPartnerChoices(beta.client)).toEqual([]);
  });

  it('preserves tenant-edited settings when the standard package is re-applied', async () => {
    await withTenant(defaults.client, async tx => {
      await tx.update(supplierPartnerFunction)
        .set({ allowsMultiple: true, changedBy: 'TEST' })
        .where(and(eq(supplierPartnerFunction.client, defaults.client), eq(supplierPartnerFunction.functionCode, 'ORDERING_PARTNER')));
      await tx.update(supplierPartnerFunction)
        .set({ isActive: false, changedBy: 'TEST' })
        .where(and(eq(supplierPartnerFunction.client, defaults.client), eq(supplierPartnerFunction.functionCode, 'DELIVERY_PARTNER')));
      await applyStandardPackage(tx, {
        client: defaults.client, companyCode: defaults.companyCode,
        companyName: `Test company ${defaults.client}`, currency: defaults.currency,
        country: 'KW', fiscalYearVariant: 'K4', activatedBy: 'TEST',
      });
    });
    const rows = await listSupplierPartnerFunctions(defaults.client);
    expect(rows.map(row => [row.functionCode, row.allowsMultiple, row.isActive])).toEqual([
      ['DELIVERY_PARTNER', false, false],
      ['INVOICE_SENDER', false, true],
      ['ORDERING_PARTNER', true, true],
    ]);
  });

  it('lists configured functions in stable order, including tenant-level and inactive configuration', async () => {
    const rows = await listSupplierPartnerFunctions(alpha.client);
    expect(rows.map(row => [row.functionCode, row.allowsMultiple, row.isActive])).toEqual([
      ['DELIVERY_PARTNER', false, false],
      ['INVOICE_SENDER', false, true],
      ['ORDERING_PARTNER', true, true],
    ]);
  });

  it('lists assignment labels/defaults and related supplier state within the requested tenant and scope', async () => {
    const rows = await listSupplierPurchasingPartners(alpha.client, 'ORDEROWNER', '1000');
    expect(rows.map(row => [row.functionCode, row.assignedPartnerNumber])).toEqual([
      ['DELIVERY_PARTNER', 'ALTDELIVERY'],
      ['ORDERING_PARTNER', 'ALTORDER'],
    ]);
    expect(rows[0]).toMatchObject({
      functionName: 'Delivery partner', functionAllowsMultiple: false, functionIsActive: false,
      assignedPartnerName: 'ALTDELIVERY Example Supplier', assignedPartnerStatus: 'CREATED',
      assignedPartnerIsBlocked: false, assignedSupplierIsActive: true, isDefault: false, version: 1,
    });
    expect(rows[1]).toMatchObject({
      functionName: 'Ordering partner', functionAllowsMultiple: true, functionIsActive: true,
      assignedPartnerName: 'ALTORDER Example Supplier', assignedSupplierIsActive: true, isDefault: true,
    });
    expect(await listSupplierPurchasingPartners(alpha.client, 'ORDEROWNER', '2000')).toEqual([]);
    expect(await listSupplierPurchasingPartners(beta.client, 'ORDEROWNER', '1000')).toEqual([]);
    expect(await db().execute(sql`select * from supplier_purchasing_partner`)).toHaveLength(0);
  });
});
