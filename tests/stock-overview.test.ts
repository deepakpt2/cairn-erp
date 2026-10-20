import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  StockOverviewError,
  stockOverview,
  type StockOverviewSelection,
} from '../src/modules/inventory/stock-overview';
import { createTenant, destroyTenant } from './helpers';

/**
 * SCR-128 / MMBE acceptance for INV.STOCK.VIEW.
 *
 * The suite pins the tree: three levels with every parent folded from the
 * children it shows, zero suppression at every level, the required single
 * material, refusal by name for the deferred and unknown keys, and the drills.
 */
describe('SCR-128 stock overview (MMBE)', () => {
  const ACTOR = 'SCR128_MMBE_TEST';
  const MATERIAL = 'MAT-OVW';
  let client = '';

  beforeAll(async () => {
    const tenant = await createTenant('scr128-mmbe');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into plant (client, plant, name, country, created_by) values
          (${client}, 'QA01', 'Plant A', 'KW', ${ACTOR}),
          (${client}, 'QA02', 'Plant B', 'KW', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, ${MATERIAL}, 'Overview material', t.material_type, 'PC', ${ACTOR}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, created_by) values
          (${client}, 'QA01', 'SL1', 'Store 1', true, ${ACTOR}),
          (${client}, 'QA01', 'SL2', 'Store 2', true, ${ACTOR}),
          (${client}, 'QA02', 'SL3', 'Store 3', true, ${ACTOR}),
          (${client}, 'QA02', 'SL4', 'Empty store', true, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
          (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt for purchase order', 'RECEIPT', 'PURCHASE_ORDER', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date, posting_date, header_text, status, created_by) values
          (${client}, '6200000001', 2026, '2026-06-03', '2026-06-03', 'Overview receipt', 'POSTED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant,
          storage_location, stock_type, entry_quantity, entry_unit, base_quantity, base_unit,
          unit_price, price_unit, currency, value, created_by
        ) values
          (${client}, '6200000001', 1, 'GOODS_RECEIPT_PO', ${MATERIAL}, 'QA01', 'SL1', 'UNRESTRICTED', 30, 'PC', 30, 'PC', 1, 1, 'USD', 30, ${ACTOR})
        on conflict do nothing
      `);
      // QA01 / SL1: 30 unrestricted + 5 quality; QA01 / SL2: 4 blocked + 3 project;
      // QA02 / SL3: 7 unrestricted; QA02 / SL4: zero only.
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by) values
          (${client}, ${MATERIAL}, 'QA01', 'SL1', 'UNRESTRICTED', 30, ${ACTOR}),
          (${client}, ${MATERIAL}, 'QA01', 'SL1', 'QUALITY', 5, ${ACTOR}),
          (${client}, ${MATERIAL}, 'QA01', 'SL2', 'BLOCKED', 4, ${ACTOR}),
          (${client}, ${MATERIAL}, 'QA01', 'SL2', 'PROJECT', 3, ${ACTOR}),
          (${client}, ${MATERIAL}, 'QA02', 'SL3', 'UNRESTRICTED', 7, ${ACTOR}),
          (${client}, ${MATERIAL}, 'QA02', 'SL4', 'UNRESTRICTED', 0, ${ACTOR})
        on conflict do nothing
      `);
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function tree(selection: Partial<StockOverviewSelection> = {}) {
    return stockOverview({ client, selection: { material: MATERIAL, maxHits: 100, ...selection } });
  }

  it('builds the three levels and folds every parent from its children', async () => {
    const result = await tree();
    expect(result.capability).toBe('INV.STOCK.VIEW');
    expect(result.material).toBe(MATERIAL);
    expect(result.materialDescription).toBe('Overview material');
    expect(result.baseUnit).toBe('PC');

    const a = result.plants.find((p) => p.plant === 'QA01')!;
    expect(a.storageLocations.map((l) => l.storageLocation)).toEqual(['SL1', 'SL2']);
    const sl1 = a.storageLocations.find((l) => l.storageLocation === 'SL1')!;
    expect(sl1.quantity).toBe(35);
    expect(sl1.stockTypes).toEqual([
      { stockType: 'QUALITY', isUnrestricted: false, isQualityInspection: true, isBlocked: false, quantity: 5 },
      { stockType: 'UNRESTRICTED', isUnrestricted: true, isQualityInspection: false, isBlocked: false, quantity: 30 },
    ]);
    const sl2 = a.storageLocations.find((l) => l.storageLocation === 'SL2')!;
    expect(sl2.stockTypes.map((t) => [t.stockType, t.quantity])).toEqual([['BLOCKED', 4], ['PROJECT', 3]]);
    expect(a.quantity).toBe(42);
    expect(a).toMatchObject({ unrestrictedQuantity: 30, qualityInspectionQuantity: 5, blockedQuantity: 4, specialQuantity: 3 });

    const b = result.plants.find((p) => p.plant === 'QA02')!;
    expect(b.quantity).toBe(7);
    expect(result.totalQuantity).toBe(49);
    expect(result).toMatchObject({ unrestrictedQuantity: 37, qualityInspectionQuantity: 5, blockedQuantity: 4, specialQuantity: 3 });
  });

  it('every parent total equals the sum of the children it shows', async () => {
    for (const displayZero of [false, true]) {
      const result = await tree({ displayZero });
      let plantSum = 0;
      for (const plant of result.plants) {
        const locationSum = plant.storageLocations.reduce((sum, l) => sum + l.quantity, 0);
        expect(Number(locationSum.toFixed(3)), `${plant.plant} locations`).toBe(plant.quantity);
        for (const location of plant.storageLocations) {
          const typeSum = location.stockTypes.reduce((sum, t) => sum + t.quantity, 0);
          expect(Number(typeSum.toFixed(3)), `${plant.plant}/${location.storageLocation}`).toBe(location.quantity);
        }
        plantSum += plant.quantity;
      }
      expect(Number(plantSum.toFixed(3))).toBe(result.totalQuantity);
    }
  });

  it('suppresses zero nodes at every level unless asked for', async () => {
    const suppressed = await tree();
    // SL4 holds nothing but a zero line: the location and its plant both vanish.
    expect(suppressed.plants.some((p) => p.plant === 'QA02' && p.storageLocations.some((l) => l.storageLocation === 'SL4'))).toBe(false);
    const shown = await tree({ displayZero: true });
    const sl4 = shown.plants.find((p) => p.plant === 'QA02')!.storageLocations.find((l) => l.storageLocation === 'SL4');
    expect(sl4).toBeDefined();
    expect(sl4!.quantity).toBe(0);
    expect(sl4!.stockTypes.map((t) => t.quantity)).toEqual([0]);
    expect(shown.totalQuantity).toBe(49);
  });

  it('narrows on plant and storage-location ranges', async () => {
    const onlyB = await tree({ plantFrom: 'QA02', plantTo: 'QA02' });
    expect(onlyB.plants.map((p) => p.plant)).toEqual(['QA02']);
    const onlySl2 = await tree({ storageLocationFrom: 'SL2', storageLocationTo: 'SL2' });
    expect(onlySl2.plants.map((p) => p.plant)).toEqual(['QA01']);
    expect(onlySl2.plants[0]!.storageLocations.map((l) => l.storageLocation)).toEqual(['SL2']);
    expect(onlySl2.totalQuantity).toBe(7);
  });

  it('requires the single material and refuses a range approach', async () => {
    await expect(stockOverview({ client, selection: {} })).rejects.toThrow(/A material is required/);
    await expect(stockOverview({ client, selection: { material: 'MAT-999' } })).rejects.toThrow(/material MAT-999 does not stand/);
    await expect(stockOverview({ client, selection: { material: 'MAT-999' } })).rejects.toBeInstanceOf(StockOverviewError);
  });

  it('refuses an unknown expansion level, the special stock indicator and the deferred fields by name', async () => {
    await expect(tree({ expansionLevel: 'BATCH' })).rejects.toThrow(/expansion level BATCH does not stand/);
    expect((await tree({ expansionLevel: 'plant' })).expansionLevel).toBe('PLANT');
    await expect(tree({ specialStockIndicator: 'E' })).rejects.toThrow(/special stock indicator E does not stand/);
    const remedy = await tree({ specialStockIndicator: 'E' }).catch((error: StockOverviewError) => error);
    expect((remedy as StockOverviewError).remedy).toMatch(/named stock type/);
    await expect(tree({ batch: 'B0001' })).rejects.toThrow(/Batch B0001 is not maintained/);
  });

  it('refuses keys that do not stand and inverted ranges, by name', async () => {
    await expect(tree({ plantFrom: 'QZ99' })).rejects.toThrow(/plant QZ99/);
    await expect(tree({ storageLocationFrom: 'SL9' })).rejects.toThrow(/storage location SL9/);
    await expect(tree({ plantFrom: 'QA02', plantTo: 'QA01' })).rejects.toThrow(/plant range is inverted/);
    await expect(tree({ maxHits: 0 })).rejects.toThrow(/Maximum hits/);
  });

  it('gives every plant and location node its three drills', async () => {
    const result = await tree();
    const plant = result.plants.find((p) => p.plant === 'QA01')!;
    expect(plant.movementsDrillDown).toContain('/inventory/material-document-list?materialFrom=MAT-OVW');
    expect(plant.rollforwardDrillDown).toContain('/inventory/stock-on-posting-date?materialFrom=MAT-OVW');
    expect(plant.warehouseDrillDown).toContain('/inventory/warehouse-stocks?materialFrom=MAT-OVW');
    const location = plant.storageLocations.find((l) => l.storageLocation === 'SL1')!;
    expect(location.movementsDrillDown).toContain('storageLocationFrom=SL1');
    expect(location.movementsDrillDown).toContain('postingDateFrom=2026-06-03');
    expect(location.rollforwardDrillDown).toContain('dateFrom=2026-06-03');
    expect(location.warehouseDrillDown).not.toContain('postingDateFrom');
  });

  it('truncates at the maximum rows and says so', async () => {
    const result = await tree({ maxHits: 2 });
    expect(result.truncated).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/truncated at 2 stock rows/);
  });

  it('warns when every line is zero rather than answering a silent empty tree', async () => {
    const empty = await stockOverview({ client, selection: { material: MATERIAL, storageLocationFrom: 'SL4', displayZero: false } });
    expect(empty.plants).toHaveLength(0);
    expect(empty.warnings.join(' ')).toMatch(/Every stock line is zero/);
    // An unknown location still refuses before the warning can be reached.
    await expect(tree({ storageLocationFrom: 'SL9' })).rejects.toThrow(/storage location SL9/);
  });
});
