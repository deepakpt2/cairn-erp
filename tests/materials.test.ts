/** Material views: staged entry, scope, precision, stale-write refusal and history. */
import { beforeEach, afterEach, afterAll, describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTenant, destroyTenant, withTenant, closeDb, type TestTenant } from './helpers';
import { saveMaterialView, getMaterialDetail, listMaterials, requireUsableMaterial, type MaterialInput } from '@/modules/inventory/materials';

let tenant: TestTenant; let serial = 0;
beforeEach(async () => { tenant = await createTenant(`material-master-${++serial}`); });
afterEach(async () => { await destroyTenant(tenant.client); });
afterAll(closeDb);
const number = 'RAW-TEST';
function common() { return { client: tenant.client, materialNumber: number, changedBy: 'MASTER_OPERATOR', expectedVersion: 0, reason: 'Master verification' }; }
function basic(patch: Partial<Extract<MaterialInput, { view: 'BASIC' }>> = {}): MaterialInput {
  return { ...common(), view: 'BASIC', description: 'Raw component', materialType: 'RAW', materialGroup: 'RAW', baseUnit: 'KG', industrySector: 'MANUFACTURING', barcode: '', grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false, ...patch };
}
function mrp(patch: Partial<Extract<MaterialInput, { view: 'MRP' }>> = {}): MaterialInput {
  return { ...common(), view: 'MRP', plant: '1000', mrpType: 'REQUIREMENTS', mrpController: '001', procurementType: 'BUY', lotSizing: 'EXACT', fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0', safetyStock: '4.125', reorderPoint: '0', plannedDeliveryDays: 7, inHouseProductionDays: 0, ...patch };
}
function purchasing(patch: Partial<Extract<MaterialInput, { view: 'PURCHASING' }>> = {}): MaterialInput {
  return { ...common(), view: 'PURCHASING', plant: '1000', purchasingGroup: '001', orderUnit: 'KG', overdeliveryTolerance: '5.25', underdeliveryTolerance: '0', manufacturerPartNumber: '', ...patch };
}
function accounting(patch: Partial<Extract<MaterialInput, { view: 'ACCOUNTING' }>> = {}): MaterialInput {
  return { ...common(), view: 'ACCOUNTING', plant: '1000', valuationClass: 'RAW_INVENTORY', priceControl: 'MOVING_AVERAGE', standardPrice: '0', movingAveragePrice: '12.3456', priceUnit: '1', ...patch };
}
async function detail() { return (await getMaterialDetail(tenant.client, number))!; }

describe('material master', () => {
  it('saves an incomplete basic view and completes it later', async () => {
    expect((await saveMaterialView(basic({ description: '' }))).status).toBe('INCOMPLETE');
    expect((await saveMaterialView(basic({ expectedVersion: 1 }))).status).toBe('CREATED');
    expect((await detail()).base.description).toBe('Raw component');
  });

  it('keeps unchanged saves silent instead of filling the change log with noise', async () => {
    const first = await saveMaterialView(basic());
    const second = await saveMaterialView(basic({ expectedVersion: first.version }));
    expect(second.changed).toBe(false); expect(second.version).toBe(1);
    const docs = await withTenant(tenant.client, (tx) => tx.execute(sql`select count(*)::int as n from change_document where object_class = 'material'`));
    expect((docs as unknown as Array<{ n: number }>)[0].n).toBe(1);
  });

  it('extends purchasing and MRP independently on one plant segment', async () => {
    await saveMaterialView(basic()); await saveMaterialView(purchasing()); await saveMaterialView(mrp({ expectedVersion: 1 }));
    const p = (await detail()).plants[0];
    expect(p.purchasingStatus).toBe('CREATED'); expect(p.mrpStatus).toBe('CREATED');
    expect(p.purchasingGroup).toBe('001'); expect(p.safetyStock).toBe('4.125');
    const planning = await withTenant(tenant.client, (tx) => tx.execute(sql`select net_change, last_changed_by from planning_file`));
    expect((planning as unknown as Array<Record<string, unknown>>)[0]).toEqual({ net_change: true, last_changed_by: 'MASTER_OPERATOR' });
  });

  it('records exact prices and derives valuation currency from the company', async () => {
    await saveMaterialView(basic()); await saveMaterialView({ ...accounting(), currency: 'EUR', totalStockQuantity: '999', stockValue: '999' } as unknown as MaterialInput);
    const v = (await detail()).valuations[0];
    expect(v.currency).toBe('USD'); expect(v.movingAveragePrice).toBe('12.3456');
    expect(v.totalStockQuantity).toBe('0.000'); expect(v.stockValue).toBe('0.0000');
  });

  it('flags valuation maintenance as control-relevant with before/after evidence', async () => {
    await saveMaterialView(basic()); await saveMaterialView(accounting());
    await saveMaterialView(accounting({ expectedVersion: 1, movingAveragePrice: '13.0001', reason: 'Correct initial price' }));
    const items = await withTenant(tenant.client, (tx) => tx.execute(sql`select i.old_value, i.new_value, i.is_security_relevant, d.changed_by, d.reason from change_document d join change_document_item i on i.change_document_id = d.id where d.object_class = 'material_valuation' and d.change_type = 'CHANGE' and i.field_name = 'movingAveragePrice'`));
    expect((items as unknown as Array<Record<string,string>>)[0]).toEqual({ old_value: '12.3456', new_value: '13.0001', is_security_relevant: 'true', changed_by: 'MASTER_OPERATOR', reason: 'Correct initial price' });
  });

  it('refuses price changes with stock instead of silently changing book value', async () => {
    await saveMaterialView(basic()); await saveMaterialView(accounting());
    await withTenant(tenant.client, (tx) => tx.execute(sql`update material_valuation set total_stock_quantity = 1, stock_value = 12.3456`));
    await expect(saveMaterialView(accounting({ expectedVersion: 1, movingAveragePrice: '20' }))).rejects.toThrow('while stock exists');
    expect((await detail()).valuations[0].stockValue).toBe('12.3456');
  });

  it('refuses stale updates and preserves the first operator change', async () => {
    await saveMaterialView(basic());
    await saveMaterialView(basic({ expectedVersion: 1, description: 'First edit' }));
    await expect(saveMaterialView(basic({ expectedVersion: 1, description: 'Stale edit' }))).rejects.toThrow('changed after it was opened');
    expect((await detail()).base.description).toBe('First edit');
  });

  it('serialises two concurrent plant-view changes with the same version', async () => {
    await saveMaterialView(basic()); await saveMaterialView(mrp());
    const results = await Promise.allSettled([saveMaterialView(mrp({ expectedVersion: 1, safetyStock: '2' })), saveMaterialView(mrp({ expectedVersion: 1, safetyStock: '3' }))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await detail()).plants[0].version).toBe(2);
  });

  it('keeps fixed-lot and reorder settings incomplete until their quantities are maintained', async () => {
    await saveMaterialView(basic());
    expect((await saveMaterialView(mrp({ mrpType: 'REORDER', lotSizing: 'FIXED' }))).status).toBe('INCOMPLETE');
    expect((await saveMaterialView(mrp({ expectedVersion: 1, mrpType: 'REORDER', lotSizing: 'FIXED', fixedLotSize: '100', reorderPoint: '50' }))).status).toBe('CREATED');
  });

  it('allows filling a missing base unit after staged plant entry, then completing the view', async () => {
    await saveMaterialView(basic({ baseUnit: '' }));
    expect((await saveMaterialView(mrp())).status).toBe('INCOMPLETE');
    await saveMaterialView(basic({ expectedVersion: 1 }));
    expect((await saveMaterialView(mrp({ expectedVersion: 1 }))).status).toBe('CREATED');
  });

  it('blocks a material with an explicit reason and marks planning dirty', async () => {
    await saveMaterialView(basic()); await saveMaterialView(mrp());
    await expect(saveMaterialView(basic({ expectedVersion: 1, isBlocked: true, reason: '' }))).rejects.toThrow('requires a reason');
    await saveMaterialView(basic({ expectedVersion: 1, isBlocked: true, reason: 'Quality hold' }));
    expect((await detail()).base.isBlocked).toBe(true);
    const file = await withTenant(tenant.client, (tx) => tx.execute(sql`select reason from planning_file`));
    expect((file as unknown as Array<{ reason: string }>)[0].reason).toBe('MATERIAL_BLOCK_CHANGED');
  });

  it('does not allow material type or a used base unit to be changed', async () => {
    await saveMaterialView(basic());
    await expect(saveMaterialView(basic({ expectedVersion: 1, materialType: 'FINISHED' }))).rejects.toThrow('immutable');
    await saveMaterialView(mrp());
    await expect(saveMaterialView(basic({ expectedVersion: 1, baseUnit: 'PC' }))).rejects.toThrow('base unit cannot change');
  });

  it.each([{ grossWeight: '0', netWeight: '1' }, { baseUnit: 'INVALID' }, { materialGroup: 'UNKNOWN' }, { grossWeight: '1.0001' }])('rejects invalid basic data without saving: %j', async (patch) => {
    await expect(saveMaterialView(basic(patch))).rejects.toThrow();
    expect(await getMaterialDetail(tenant.client, number)).toBeNull();
  });

  it('refuses invalid lots, controllers and negative planning quantities', async () => {
    await saveMaterialView(basic());
    await expect(saveMaterialView(mrp({ minimumLotSize: '100', maximumLotSize: '10' }))).rejects.toThrow('Maximum lot size');
    await expect(saveMaterialView(mrp({ mrpController: '999' }))).rejects.toThrow('controller');
    await expect(saveMaterialView(mrp({ safetyStock: '-1' }))).rejects.toThrow('non-negative');
    expect((await detail()).plants).toHaveLength(0);
  });

  it('requires an order-unit conversion rather than guessing one', async () => {
    await saveMaterialView(basic());
    await expect(saveMaterialView(purchasing({ orderUnit: 'G' }))).rejects.toThrow('material-specific conversion');
  });

  it('validates the valuation-class/material-type combination', async () => {
    await saveMaterialView(basic());
    await expect(saveMaterialView(accounting({ valuationClass: 'FINISHED_INVENTORY' }))).rejects.toThrow('not allowed');
    expect((await detail()).valuations).toHaveLength(0);
  });

  it('keeps service materials out of inventory valuation and planning', async () => {
    await saveMaterialView(basic({ materialType: 'SERVICE', materialGroup: 'SERVICES', baseUnit: 'HR' }));
    await expect(saveMaterialView(accounting())).rejects.toThrow('not stock-valuated');
    await expect(saveMaterialView(mrp())).rejects.toThrow('non-stock material');
  });

  it('keeps identically numbered masters in different tenants separate', async () => {
    await saveMaterialView(basic());
    const other = await createTenant(`material-foreign-${serial}`);
    try {
      expect(other.client).not.toBe(tenant.client);
      await saveMaterialView({ ...basic({ description: 'Foreign description' }), client: other.client });
      expect((await listMaterials(tenant.client))[0].description).toBe('Raw component');
      expect(await getMaterialDetail(tenant.client, 'FOREIGN-ONLY')).toBeNull();
      const attempted = await withTenant(tenant.client, (tx) => tx.execute(sql`select * from material where client = ${other.client}`));
      expect((attempted as unknown as unknown[]).length).toBe(0);
    } finally { await destroyTenant(other.client); }
  });

  it('gates operational use on complete basic and organisational views', async () => {
    await saveMaterialView(basic({ description: '' }));
    await expect(withTenant(tenant.client, (tx) => requireUsableMaterial(tx, tenant.client, number, 'BASIC'))).rejects.toThrow('basic view');
    await saveMaterialView(basic({ expectedVersion: 1 }));
    await expect(withTenant(tenant.client, (tx) => requireUsableMaterial(tx, tenant.client, number, 'PURCHASING', '1000'))).rejects.toThrow('missing or incomplete');
    await saveMaterialView(purchasing());
    const usable = await withTenant(tenant.client, (tx) => requireUsableMaterial(tx, tenant.client, number, 'PURCHASING', '1000'));
    expect(usable.plantData?.orderUnit).toBe('KG');
    await saveMaterialView(basic({ expectedVersion: 2, isBlocked: true, reason: 'Operational hold' }));
    await expect(withTenant(tenant.client, (tx) => requireUsableMaterial(tx, tenant.client, number, 'PURCHASING', '1000'))).rejects.toThrow('blocked');
  });

  it('refuses a foreign or unknown plant and requires a basic record first', async () => {
    await expect(saveMaterialView(mrp())).rejects.toMatchObject({ message: 'Material RAW-TEST does not exist.', remedy: 'Create its basic view first.' });
    await saveMaterialView(basic());
    await expect(saveMaterialView(mrp({ plant: '9999' }))).rejects.toThrow('Plant');
  });
});
