import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, createTenant, db, destroyTenant, withTenant, type TestTenant } from './helpers';
import { saveBusinessPartner } from '../src/modules/foundation/business-partners';
import { saveSupplierPurchasing } from '../src/modules/foundation/supplier-purchasing';
import { listSupplierPurchasingPartners } from '../src/modules/foundation/supplier-purchasing-partners';
import { removeSupplierPurchasingPartner, saveSupplierPurchasingPartner } from '../src/modules/foundation/supplier-purchasing-partner-writes';
import { bpRole } from '../src/modules/foundation/business-partner-schema';
import { supplierPartnerFunction } from '../src/modules/foundation/supplier-partner-schema';

let alpha: TestTenant;
let beta: TestTenant;

async function partner(tenant: TestTenant, number: string, roles: ['SUPPLIER'] | ['CUSTOMER'] = ['SUPPLIER']) {
  await saveBusinessPartner({
    client: tenant.client, partnerNumber: number, expectedVersion: 0, changedBy: 'TEST',
    reason: 'Supplier partner assignment fixture', category: 'ORGANIZATION', name: `${number} Example Supplier`,
    name2: '', searchTerm: number, country: 'KW', region: '', street: 'Test street', city: 'Kuwait City',
    postalCode: '', taxNumber: '', email: '', phone: '', roles, isBlocked: false,
  });
}

const input = (
  functionCode: 'ORDERING_PARTNER' | 'DELIVERY_PARTNER' | 'INVOICE_SENDER',
  assignedPartnerNumber: string,
  patch: Partial<Parameters<typeof saveSupplierPurchasingPartner>[0]> = {},
) => ({
  client: alpha.client, partnerNumber: 'FOCAL', purchasingOrg: '1000', functionCode,
  assignedPartnerNumber, expectedVersion: 0, isDefault: false,
  changedBy: 'TEST', reason: 'Supplier partner assignment test', ...patch,
});

beforeAll(async () => {
  alpha = await createTenant('supplier-partner-write-alpha');
  beta = await createTenant('supplier-partner-write-beta', { withConfiguration: false });
  for (const number of ['FOCAL', 'ALTONE', 'ALTTWO', 'ALTTHREE', 'INACTIVE', 'CUSTOMERONLY']) {
    await partner(alpha, number, number === 'CUSTOMERONLY' ? ['CUSTOMER'] : ['SUPPLIER']);
  }
  await saveSupplierPurchasing({
    client: alpha.client, partnerNumber: 'FOCAL', purchasingOrg: '1000', expectedVersion: 0,
    changedBy: 'TEST', reason: 'Supplier partner assignment fixture', orderCurrency: alpha.currency,
    purchasingGroup: '001', incotermsCode: 'FCA', incotermsLocation: 'Kuwait City',
    paymentTermsCode: 'NET30', isBlocked: false,
  });
  await withTenant(alpha.client, async tx => {
    await tx.update(supplierPartnerFunction)
      .set({ allowsMultiple: true, changedBy: 'TEST' })
      .where(and(eq(supplierPartnerFunction.client, alpha.client), eq(supplierPartnerFunction.functionCode, 'DELIVERY_PARTNER')));
    await tx.update(supplierPartnerFunction)
      .set({ isActive: false, changedBy: 'TEST' })
      .where(and(eq(supplierPartnerFunction.client, alpha.client), eq(supplierPartnerFunction.functionCode, 'INVOICE_SENDER')));
    await tx.update(bpRole)
      .set({ isActive: false, changedBy: 'TEST' })
      .where(and(eq(bpRole.client, alpha.client), eq(bpRole.partnerNumber, 'INACTIVE'), eq(bpRole.roleCode, 'SUPPLIER')));
  });
});

afterAll(async () => {
  await destroyTenant(alpha.client);
  await destroyTenant(beta.client);
  await closeDb();
});

describe('supplier purchasing partner assignment writes', () => {
  it('enforces unique cardinality, replaces with version checks, audits changes, and removes cleanly', async () => {
    expect(await saveSupplierPurchasingPartner(input('ORDERING_PARTNER', 'ALTONE'))).toEqual({ changed: true, version: 1, isDefault: false });
    await expect(saveSupplierPurchasingPartner(input('ORDERING_PARTNER', 'ALTTWO'))).rejects.toThrow('only one');
    await expect(saveSupplierPurchasingPartner(input('ORDERING_PARTNER', 'ALTONE', { expectedVersion: 1, isDefault: true }))).rejects.toThrow('only be selected');

    expect(await saveSupplierPurchasingPartner(input('ORDERING_PARTNER', 'ALTTWO', {
      expectedVersion: 1, replaceAssignedPartnerNumber: 'ALTONE',
    }))).toEqual({ changed: true, version: 2, isDefault: false });
    await expect(saveSupplierPurchasingPartner(input('ORDERING_PARTNER', 'ALTTHREE', {
      expectedVersion: 1, replaceAssignedPartnerNumber: 'ALTTWO',
    }))).rejects.toThrow('changed after');
    expect(await listSupplierPurchasingPartners(alpha.client, 'FOCAL', '1000')).toMatchObject([
      { functionCode: 'ORDERING_PARTNER', assignedPartnerNumber: 'ALTTWO', isDefault: false, version: 2 },
    ]);
    expect(await removeSupplierPurchasingPartner({
      client: alpha.client, partnerNumber: 'FOCAL', purchasingOrg: '1000', functionCode: 'ORDERING_PARTNER',
      assignedPartnerNumber: 'ALTTWO', expectedVersion: 2, changedBy: 'TEST', reason: 'Remove test assignment',
    })).toEqual({ changed: true, removedVersion: 2 });
    expect(await listSupplierPurchasingPartners(alpha.client, 'FOCAL', '1000')).toEqual([]);
    const history = await withTenant(alpha.client, tx => tx.execute(sql`
      select count(*)::int as count from change_document
      where object_class='supplier_purchasing_partner' and object_key in
        ('FOCAL/1000/ORDERING_PARTNER/ALTONE','FOCAL/1000/ORDERING_PARTNER/ALTTWO')
    `));
    expect((history as unknown as Array<{ count: number }>)[0].count).toBe(4);
  });

  it('allows multiple assignments without a default and atomically transfers the single default', async () => {
    await saveSupplierPurchasingPartner(input('DELIVERY_PARTNER', 'ALTONE'));
    await saveSupplierPurchasingPartner(input('DELIVERY_PARTNER', 'ALTTWO'));
    let rows = await listSupplierPurchasingPartners(alpha.client, 'FOCAL', '1000');
    expect(rows.map(row => row.isDefault)).toEqual([false, false]);

    await saveSupplierPurchasingPartner(input('DELIVERY_PARTNER', 'ALTONE', { expectedVersion: 1, isDefault: true }));
    await saveSupplierPurchasingPartner(input('DELIVERY_PARTNER', 'ALTTWO', { expectedVersion: 1, isDefault: true }));
    rows = await listSupplierPurchasingPartners(alpha.client, 'FOCAL', '1000');
    expect(rows.map(row => [row.assignedPartnerNumber, row.isDefault, row.version])).toEqual([
      ['ALTTWO', true, 2], ['ALTONE', false, 3],
    ]);
    await expect(saveSupplierPurchasingPartner(input('DELIVERY_PARTNER', 'ALTONE', { expectedVersion: 2, isDefault: true }))).rejects.toThrow('changed after');

    await removeSupplierPurchasingPartner({
      client: alpha.client, partnerNumber: 'FOCAL', purchasingOrg: '1000', functionCode: 'DELIVERY_PARTNER',
      assignedPartnerNumber: 'ALTTWO', expectedVersion: 2, changedBy: 'TEST', reason: 'Remove default assignment',
    });
    rows = await listSupplierPurchasingPartners(alpha.client, 'FOCAL', '1000');
    expect(rows).toMatchObject([{ assignedPartnerNumber: 'ALTONE', isDefault: false, version: 3 }]);
    await removeSupplierPurchasingPartner({
      client: alpha.client, partnerNumber: 'FOCAL', purchasingOrg: '1000', functionCode: 'DELIVERY_PARTNER',
      assignedPartnerNumber: 'ALTONE', expectedVersion: 3, changedBy: 'TEST', reason: 'Remove last assignment',
    });
    expect(await listSupplierPurchasingPartners(alpha.client, 'FOCAL', '1000')).toEqual([]);
  });

  it('requires a focal purchasing segment and active Supplier roles/function for new assignments', async () => {
    await expect(saveSupplierPurchasingPartner(input('ORDERING_PARTNER', 'CUSTOMERONLY'))).rejects.toThrow('active Supplier role');
    await expect(saveSupplierPurchasingPartner(input('ORDERING_PARTNER', 'INACTIVE'))).rejects.toThrow('active Supplier role');
    await expect(saveSupplierPurchasingPartner(input('INVOICE_SENDER', 'ALTONE'))).rejects.toThrow('missing or inactive');
    await expect(saveSupplierPurchasingPartner({ ...input('ORDERING_PARTNER', 'ALTONE'), partnerNumber: 'MISSING' })).rejects.toThrow('active Supplier role');
    await expect(saveSupplierPurchasingPartner({ ...input('ORDERING_PARTNER', 'ALTONE'), purchasingOrg: '2000' })).rejects.toThrow('segment first');
  });

  it('serializes concurrent unique-role additions and keeps other tenants/unscoped reads isolated', async () => {
    const results = await Promise.allSettled([
      saveSupplierPurchasingPartner(input('ORDERING_PARTNER', 'ALTONE')),
      saveSupplierPurchasingPartner(input('ORDERING_PARTNER', 'ALTTWO')),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await listSupplierPurchasingPartners(beta.client, 'FOCAL', '1000')).toEqual([]);
    expect(await db().execute(sql`select * from supplier_purchasing_partner`)).toHaveLength(0);
  });
});
