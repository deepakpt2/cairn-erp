import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  WarehouseStockError,
  listWarehouseStocks,
  type WarehouseStockSelection,
} from '../src/modules/inventory/warehouse-stocks';
import { createTenant, destroyTenant } from './helpers';

/**
 * SCR-127 / MB52 acceptance for INV.STOCK.WAREHOUSE.
 *
 * The suite pins the snapshot: the four-way stock-type pivot and its total, the
 * valuation under both price controls and per price unit, an honest unknown
 * where no valuation record stands, the zero-stock toggle, refusal by name for
 * the scope of list and the deferred fields, and that nothing is ever written.
 */
describe('SCR-127 warehouse stocks on hand (MB52)', () => {
  const ACTOR = 'SCR127_MB52_TEST';
  const CURRENCY = 'USD';
  let client = '';

  beforeAll(async () => {
    const tenant = await createTenant('scr127-mb52');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into plant (client, plant, name, country, created_by) values
          (${client}, 'Q900', 'Plant 900', 'KW', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, v.number, v.description, t.material_type, 'PC', ${ACTOR}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
        cross join (values
          ('MAT-900', 'Standard priced'), ('MAT-910', 'Moving average priced'),
          ('MAT-920', 'Unvalued material'), ('MAT-930', 'Empty location')) as v(number, description)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, created_by) values
          (${client}, 'Q900', 'SL90', 'Main store', true, ${ACTOR}),
          (${client}, 'Q900', 'SL91', 'Inspection store', true, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
          (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt for purchase order', 'RECEIPT', 'PURCHASE_ORDER', ${ACTOR})
        on conflict do nothing
      `);
      // A single posted movement, so the drills have a window to carry.
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date, posting_date, header_text, status, created_by) values
          (${client}, '6100000001', 2026, '2026-05-04', '2026-05-04', 'Snapshot receipt', 'POSTED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant,
          storage_location, stock_type, entry_quantity, entry_unit, base_quantity, base_unit,
          unit_price, price_unit, currency, value, created_by
        ) values
          (${client}, '6100000001', 1, 'GOODS_RECEIPT_PO', 'MAT-900', 'Q900', 'SL90', 'UNRESTRICTED', 20, 'PC', 20, 'PC', 10, 1, ${CURRENCY}, 200, ${ACTOR})
        on conflict do nothing
      `);
      // The stock master: unrestricted, quality and blocked for the first material,
      // a special stock type for the second, an unvalued material and an all-zero line.
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by) values
          (${client}, 'MAT-900', 'Q900', 'SL90', 'UNRESTRICTED', 20, ${ACTOR}),
          (${client}, 'MAT-900', 'Q900', 'SL90', 'QUALITY', 5, ${ACTOR}),
          (${client}, 'MAT-900', 'Q900', 'SL90', 'BLOCKED', 2, ${ACTOR}),
          (${client}, 'MAT-910', 'Q900', 'SL91', 'UNRESTRICTED', 7, ${ACTOR}),
          (${client}, 'MAT-910', 'Q900', 'SL91', 'PROJECT', 3, ${ACTOR}),
          (${client}, 'MAT-920', 'Q900', 'SL90', 'UNRESTRICTED', 4, ${ACTOR}),
          (${client}, 'MAT-930', 'Q900', 'SL90', 'UNRESTRICTED', 0, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into valuation_class (client, valuation_class, name, allowed_material_types, created_by)
        select ${client}, 'TEST_CLASS', 'Test class', 'RAW,FINISHED,TRADE,SEMI', ${ACTOR} where not exists (
          select 1 from valuation_class where client = ${client} and valuation_class = 'TEST_CLASS')
      `);
      // MAT-900 is standard priced at 12.50 per 1, MAT-910 moving average at 200 per 10
      // (i.e. 20 per unit). MAT-920 has no valuation record at all.
      await tx.execute(sql`
        insert into material_valuation (
          client, material_number, valuation_area, valuation_class, price_control,
          standard_price, moving_average_price, price_unit, currency, accounting_status, created_by
        ) values
          (${client}, 'MAT-900', 'Q900', 'TEST_CLASS', 'STANDARD', 12.5, 0, 1, ${CURRENCY}, 'MAINTAINED', ${ACTOR}),
          (${client}, 'MAT-910', 'Q900', 'TEST_CLASS', 'MOVING_AVERAGE', 0, 200, 10, ${CURRENCY}, 'MAINTAINED', ${ACTOR})
        on conflict do nothing
      `);
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function report(selection: Partial<WarehouseStockSelection> = {}) {
    return listWarehouseStocks({ client, localCurrency: CURRENCY, selection: { maxHits: 100, ...selection } });
  }

  it('pivots the snapshot on stock type and the columns add up to the total', async () => {
    const result = await report({ scopeOfList: 'ALV' });
    expect(result.capability).toBe('INV.STOCK.WAREHOUSE');
    const row = result.rows.find((r) => r.materialNumber === 'MAT-900')!;
    expect(row).toMatchObject({
      materialDescription: 'Standard priced', plant: 'Q900', storageLocation: 'SL90', baseUnit: 'PC',
      unrestrictedQuantity: 20, qualityInspectionQuantity: 5, blockedQuantity: 2, specialQuantity: 0,
      totalQuantity: 27,
    });
    const special = result.rows.find((r) => r.materialNumber === 'MAT-910')!;
    expect(special).toMatchObject({ unrestrictedQuantity: 7, specialQuantity: 3, totalQuantity: 10 });
    // Four columns, one total: always.
    for (const r of result.rows) {
      expect(
        Number((r.unrestrictedQuantity + r.qualityInspectionQuantity + r.blockedQuantity + r.specialQuantity).toFixed(3)),
        r.materialNumber,
      ).toBe(r.totalQuantity);
    }
    expect(result.totals).toMatchObject({ unrestrictedQuantity: 31, qualityInspectionQuantity: 5, blockedQuantity: 2, specialQuantity: 3, totalQuantity: 41 });
  });

  it('values each line at the price its control selects, honouring the price unit', async () => {
    const result = await report();
    const standard = result.rows.find((r) => r.materialNumber === 'MAT-900')!;
    // 27 × 12.50 / 1
    expect(standard).toMatchObject({ priceControl: 'STANDARD', price: 12.5, priceUnit: 1, currency: CURRENCY, value: 337.5 });
    const moving = result.rows.find((r) => r.materialNumber === 'MAT-910')!;
    // 10 × 200 / 10
    expect(moving).toMatchObject({ priceControl: 'MOVING_AVERAGE', price: 200, priceUnit: 10, value: 200 });
    expect(result.totals.value).toBe(537.5);
  });

  it('reports an unknown value for an unvalued material and never a zero', async () => {
    const result = await report();
    const unvalued = result.rows.find((r) => r.materialNumber === 'MAT-920')!;
    expect(unvalued.price).toBeNull();
    expect(unvalued.value).toBeNull();
    expect(unvalued.totalQuantity).toBe(4);
    const warned = result.warnings.join(' ');
    expect(warned).toMatch(/No valuation stands for 1 material\(s\): MAT-920/);
    expect(warned).toMatch(/unknown, not zero/);
    // The footer stays the sum of what could be valued.
    expect(result.totals.value).toBe(537.5);
  });

  it('suppresses zero-stock lines unless asked for', async () => {
    const suppressed = await report();
    expect(suppressed.rows.some((r) => r.materialNumber === 'MAT-930')).toBe(false);
    const shown = await report({ displayZero: true });
    const empty = shown.rows.find((r) => r.materialNumber === 'MAT-930')!;
    expect(empty.totalQuantity).toBe(0);
  });

  it('drops the price and value columns when the valuation display is switched off', async () => {
    const result = await report({ valuationPriceDisplay: false });
    expect(result.valuationPriceDisplay).toBe(false);
    expect(result.rows.every((r) => r.price === null && r.value === null)).toBe(true);
    expect(result.rows.find((r) => r.materialNumber === 'MAT-900')!.totalQuantity).toBe(27);
  });

  it('drills each row into the movements and the rollforward over the recorded ledger', async () => {
    const result = await report();
    const row = result.rows.find((r) => r.materialNumber === 'MAT-900')!;
    expect(row.movementsDrillDown).toBe(
      '/inventory/material-document-list?materialFrom=MAT-900&materialTo=MAT-900&plantFrom=Q900&plantTo=Q900'
      + '&storageLocationFrom=SL90&storageLocationTo=SL90&postingDateFrom=2026-05-04&postingDateTo=2026-05-04',
    );
    expect(row.rollforwardDrillDown).toBe(
      '/inventory/stock-on-posting-date?materialFrom=MAT-900&materialTo=MAT-900&plantFrom=Q900&plantTo=Q900'
      + '&storageLocationFrom=SL90&storageLocationTo=SL90&dateFrom=2026-05-04&dateTo=2026-05-04',
    );
  });

  it('requires the scope of list and refuses an unknown one by name', async () => {
    const byDefault = await report();
    expect(byDefault.scopeOfList).toBe('ALV');
    expect((await report({ scopeOfList: 'standard' })).scopeOfList).toBe('STANDARD');
    await expect(report({ scopeOfList: 'HIERARCHY' })).rejects.toThrow(/scope of list HIERARCHY does not stand/);
  });

  it('refuses the special stock indicator and the deferred fields by name', async () => {
    await expect(report({ specialStockIndicator: 'Q' })).rejects.toThrow(/special stock indicator Q does not stand/);
    const specialRemedy = await report({ specialStockIndicator: 'L' }).catch((error: WarehouseStockError) => error);
    expect((specialRemedy as WarehouseStockError).remedy).toMatch(/named stock type/);
    await expect(report({ valuationType: '0010' })).rejects.toThrow(/Valuation type 0010 is not maintained/);
    await expect(report({ batch: 'B0001' })).rejects.toThrow(/Batch B0001 is not maintained/);
    await expect(report({ scopeOfList: 'BOGUS' })).rejects.toBeInstanceOf(WarehouseStockError);
  });

  it('refuses a key that does not stand, by name', async () => {
    await expect(report({ materialFrom: 'MAT-999' })).rejects.toThrow(/material MAT-999/);
    await expect(report({ plantFrom: 'Q999' })).rejects.toThrow(/plant Q999/);
    await expect(report({ storageLocationFrom: 'SL99' })).rejects.toThrow(/storage location SL99/);
    await expect(report({ stockType: 'PIPELINE' })).rejects.toThrow(/stock type PIPELINE/);
    await expect(report({ materialFrom: 'MAT-930', materialTo: 'MAT-900' })).rejects.toThrow(/material range is inverted/);
    await expect(report({ maxHits: 0 })).rejects.toThrow(/Maximum hits/);
  });

  it('narrows on ranges and stock type', async () => {
    const one = await report({ materialFrom: 'MAT-910', materialTo: 'MAT-910' });
    expect(one.rows.map((r) => r.materialNumber)).toEqual(['MAT-910']);
    const blocked = await report({ stockType: 'BLOCKED' });
    expect(blocked.rows.map((r) => [r.materialNumber, r.totalQuantity])).toEqual([['MAT-900', 2]]);
    expect(blocked.rows[0]!.unrestrictedQuantity).toBe(0);
  });

  it('truncates at the maximum hits and says so', async () => {
    const result = await report({ displayZero: true, maxHits: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/truncated at 2 hits/);
  });
});
