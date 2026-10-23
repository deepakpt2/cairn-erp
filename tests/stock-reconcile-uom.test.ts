import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import {
  RECONCILE_CAPABILITY,
  StockReconcileError,
  rebuildStockDimension,
  reconcileStock,
} from '../src/modules/inventory/stock-reconcile';
import {
  UOM_CAPABILITY,
  UnitConversionError,
  defineUomConversion,
  toBaseQuantity,
} from '../src/modules/inventory/unit-conversion';
import { postGoodsIssue, GoodsIssueError } from '../src/modules/inventory/goods-issue';
import { createPhysicalInventory } from '../src/modules/inventory/physical-inventory';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

/**
 * SCR-144 — the three structural gaps against the MIGO production specification:
 * the projection is rebuildable, the entry unit converts or refuses, and the balance is guarded.
 */
const ACTOR = 'SCR144_TEST';
const PLANT = 'QU01';
const COMPANY = '1000';

describe('SCR-144 reconcile and unit conversion', () => {
  let fx: TestTenant;
  let client = '';

  beforeAll(async () => {
    fx = await createTenant('scr144-recon');
    client = fx.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, v.n, v.d, 'RAW', v.u, ${ACTOR}
        from (values ('UOM-MAT', 'Converted material', 'PC'), ('UOM-PLAIN', 'Base unit only', 'PC')) as v(n, d, u)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        select ${client}, ${PLANT}, 'Unit plant', c.company_code, 'KW', ${ACTOR}
        from (select company_code from company_code where client = ${client} order by company_code limit 1) c
        on conflict (client, plant) do update set company_code = excluded.company_code
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        select ${client}, v.n, ${PLANT}, ${ACTOR}
        from (values ('UOM-MAT'), ('UOM-PLAIN')) as v(n)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
        values (${client}, ${PLANT}, 'SU01', 'Unit store', true, false, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency,
                                        total_stock_quantity, stock_value, created_by)
        select ${client}, v.n, ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1, c.currency, 100, 1000, ${ACTOR}
        from (values ('UOM-MAT'), ('UOM-PLAIN')) as v(n)
        cross join (select currency from company_code where client = ${client} limit 1) c
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
        values (${client}, 'OPENING_BALANCE', 'Opening balance', 'RECEIPT', 'MATERIAL_DOCUMENT', ${ACTOR})
        on conflict do nothing
      `);
      // Opening stock is backed by an opening document, because reconcile treats a projection
      // row with no ledger behind it as a ghost — which is exactly what it is.
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date,
                                       posting_date, header_text, status, created_by)
        values (${client}, 'MD-OPEN001', 2026, '2026-01-01', '2026-01-01', 'Opening balance', 'POSTED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (client, material_document_number, line_number, movement_type,
                                            material_number, plant, storage_location, stock_type, line_direction,
                                            entry_quantity, entry_unit, base_quantity, base_unit, created_by)
        select ${client}, 'MD-OPEN001', v.i, 'OPENING_BALANCE', v.n, ${PLANT}, 'SU01', 'UNRESTRICTED', 'RECEIPT',
               100, 'PC', 100, 'PC', ${ACTOR}
        from (values ('UOM-MAT', 1), ('UOM-PLAIN', 2)) as v(n, i)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        select ${client}, v.n, ${PLANT}, 'SU01', 'UNRESTRICTED', 100, ${ACTOR}
        from (values ('UOM-MAT'), ('UOM-PLAIN')) as v(n)
        on conflict (client, material_number, plant, storage_location, stock_type) do update set quantity = 100
      `);
      await tx.execute(sql`
        insert into gl_account (client, chart_of_accounts, account_number, name, account_type,
                                is_balance_sheet, is_open_item_managed, reconciliation_type,
                                requires_cost_object, is_tax_relevant, account_group, gl_account_type, created_by)
        select ${client}, c.chart_of_accounts, v.n, v.d, v.t,
               v.balance, false, null, false, false, 'GENL', v.kind, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        cross join (values
          ('125960', 'Unit inventory', 'ASSET', true, 'BALANCE_SHEET'),
          ('596960', 'Unit consumption', 'EXPENSE', false, 'PL_STATEMENT'),
          ('597960', 'Unit scrap', 'EXPENSE', false, 'PL_STATEMENT')
        ) as v(n, d, t, balance, kind)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        select ${client}, c.chart_of_accounts, v.e, 'RAW_INVENTORY', '', v.a, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        cross join (values ('INVENTORY', '125960'), ('CONSUMPTION', '596960'),
                           ('SCRAP', '597960'), ('PRODUCTION_CONSUMPTION', '596960')) as v(e, a)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                             previous_fiscal_year, previous_period, allow_backposting, created_by)
        select ${client}, c.company_code, 2026, 10, 2026, 9, true, ${ACTOR}
        from (select company_code from company_code where client = ${client} limit 1) c
        on conflict (client, company_code) do update set current_fiscal_year = 2026, current_period = 10
      `);
    });
    await withTenant(client, (tx) => defineRange(tx, {
      client, objectCode: 'MATDOC', subObject: '*', prefix: 'MD', numberLength: 8, createdBy: ACTOR,
    }));
    await withTenant(client, (tx) => defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: COMPANY, subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: ACTOR,
    }));
    await withTenant(client, (tx) => defineRange(tx, {
      client, objectCode: 'PHYINV', subObject: '*', prefix: 'PI', numberLength: 10, createdBy: ACTOR,
    }));
  }, 180_000);

  afterAll(async () => {
    if (client) await destroyTenant(client);
  }, 180_000);

  it('names its capabilities', () => {
    expect(RECONCILE_CAPABILITY).toBe('INV.STOCK.RECONCILE');
    expect(UOM_CAPABILITY).toBe('INV.STOCK.UOM');
  });

  it('converts at 1:1 for the base unit and needs no row', async () => {
    const result = await withTenant(client, (tx) => toBaseQuantity(tx, client, {
      materialNumber: 'UOM-MAT', quantity: 5,
    }));
    expect(result.baseQuantity).toBe(5);
    expect(result.baseUnit).toBe('PC');
    expect(result.factor).toBe('1/1');
  });

  it('converts an alternative unit by its exact ratio, rounded to the base unit’s decimals', async () => {
    await defineUomConversion({
      client, changedBy: ACTOR, materialNumber: 'UOM-MAT',
      alternativeUnit: 'BOX', numerator: 12, denominator: 1,
    });
    const result = await withTenant(client, (tx) => toBaseQuantity(tx, client, {
      materialNumber: 'UOM-MAT', quantity: 2, entryUnit: 'BOX',
    }));
    expect(result.baseQuantity).toBe(24);
    expect(result.factor).toBe('12');
  });

  it('refuses an alternative unit the material has no conversion for, by name', async () => {
    const error = await withTenant(client, (tx) => toBaseQuantity(tx, client, {
      materialNumber: 'UOM-PLAIN', quantity: 1, entryUnit: 'GAL',
    })).catch((e: unknown) => e as UnitConversionError);
    expect(error.message).toMatch(/carries no conversion from GAL to its base unit PC/);
    expect(error.remedy).toContain('INV.STOCK.UOM');
  });

  it('refuses a conversion to the material’s own base unit', async () => {
    await expect(defineUomConversion({
      client, changedBy: ACTOR, materialNumber: 'UOM-MAT',
      alternativeUnit: 'PC', numerator: 1, denominator: 1,
    })).rejects.toThrow(/cannot convert to itself/);
  });

  it('refuses a non-positive ratio', async () => {
    await expect(defineUomConversion({
      client, changedBy: ACTOR, materialNumber: 'UOM-MAT',
      alternativeUnit: 'KG', numerator: 0, denominator: 1,
    })).rejects.toThrow(/positive whole numerator and denominator/);
  });

  it('posts a goods issue in an alternative unit, storing both quantities', async () => {
    const posted = await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '551',
      postingDate: '2026-10-20', documentDate: '2026-10-20',
      lines: [{
        materialNumber: 'UOM-MAT', plant: PLANT, storageLocation: 'SU01',
        quantity: 2, entryUnit: 'BOX',
      }],
      requestKey: 'uom-issue-1',
    });
    expect(posted.materialDocumentNumber).toMatch(/^MD-/);

    const [line] = await withTenant(client, (tx) => tx.execute(sql`
      select entry_quantity::text as entry, entry_unit, base_quantity::text as base, base_unit
        from material_document_line
       where client = ${client} and material_document_number = ${posted.materialDocumentNumber}
    `)) as unknown as Array<{ entry: string; entry_unit: string; base: string; base_unit: string }>;
    expect(Number(line.entry)).toBe(2);
    expect(line.entry_unit).toBe('BOX');
    expect(Number(line.base)).toBe(24);
    expect(line.base_unit).toBe('PC');

    const [stock] = await withTenant(client, (tx) => tx.execute(sql`
      select quantity::text as q from stock_quantity
       where client = ${client} and material_number = 'UOM-MAT' and plant = ${PLANT}
         and storage_location = 'SU01' and stock_type = 'UNRESTRICTED'
    `)) as unknown as Array<{ q: string }>;
    expect(Number(stock.q)).toBe(76, 'the stock fell by the BASE quantity, not the entered one');
  });

  it('refuses a goods issue in an unconverted unit, leaving stock untouched', async () => {
    const error = await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '551',
      postingDate: '2026-10-20', documentDate: '2026-10-20',
      lines: [{
        materialNumber: 'UOM-PLAIN', plant: PLANT, storageLocation: 'SU01',
        quantity: 1, entryUnit: 'GAL',
      }],
      requestKey: 'uom-issue-2',
    }).catch((e: unknown) => e as GoodsIssueError);
    expect(error.message).toMatch(/carries no conversion from GAL to its base unit PC/);
    expect(error.remedy).toMatch(/INV\.STOCK\.UOM/);

    const [stock] = await withTenant(client, (tx) => tx.execute(sql`
      select quantity::text as q from stock_quantity
       where client = ${client} and material_number = 'UOM-PLAIN' and plant = ${PLANT}
         and storage_location = 'SU01' and stock_type = 'UNRESTRICTED'
    `)) as unknown as Array<{ q: string }>;
    expect(Number(stock.q)).toBe(100, 'a refused conversion must not move stock');
  });

  it('reconciles the projection against the ledger and calls it balanced', async () => {
    const result = await reconcileStock(client, { plant: PLANT });
    expect(result.balanced).toBe(true);
    expect(result.drift).toEqual([]);
    expect(result.dimensionsChecked).toBeGreaterThan(0);
  });

  it('finds drift, and the rebuild repairs it from the ledger', async () => {
    await withTenant(client, (tx) => tx.execute(sql`
      update stock_quantity set quantity = 999
       where client = ${client} and material_number = 'UOM-MAT' and plant = ${PLANT}
         and storage_location = 'SU01' and stock_type = 'UNRESTRICTED'
    `));
    const drift = await reconcileStock(client, { plant: PLANT });
    expect(drift.balanced).toBe(false);
    expect(drift.drift).toHaveLength(1);
    expect(drift.drift[0].projectedQuantity).toBe('999.000');
    expect(drift.drift[0].ledgerQuantity).toBe('76.000');
    expect(drift.drift[0].difference).toBe('923.000');

    const rebuilt = await rebuildStockDimension({
      client, changedBy: ACTOR, materialNumber: 'UOM-MAT', plant: PLANT,
      storageLocation: 'SU01', stockType: 'UNRESTRICTED',
    });
    expect(rebuilt.ledgerQuantity).toBe('76.000');
    expect((await reconcileStock(client, { plant: PLANT })).balanced).toBe(true);
  });

  it('treats a projection row with no documents behind it as drift, and the rebuild removes it', async () => {
    await withTenant(client, (tx) => tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
      values (${client}, 'UOM-PLAIN', ${PLANT}, 'SU01', 'BLOCKED', 15, ${ACTOR})
      on conflict do nothing
    `));
    const drift = await reconcileStock(client, { plant: PLANT });
    expect(drift.balanced).toBe(false);
    const ghost = drift.drift.find((row) => row.stockType === 'BLOCKED');
    expect(ghost?.ledgerQuantity).toBe('0.000');
    expect(ghost?.projectedQuantity).toBe('15.000');

    await rebuildStockDimension({
      client, changedBy: ACTOR, materialNumber: 'UOM-PLAIN', plant: PLANT,
      storageLocation: 'SU01', stockType: 'BLOCKED',
    });
    expect((await reconcileStock(client, { plant: PLANT })).balanced).toBe(true);
    const rows = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as n from stock_quantity
       where client = ${client} and material_number = 'UOM-PLAIN' and stock_type = 'BLOCKED'
    `)) as unknown as Array<{ n: number }>;
    expect(rows[0].n).toBe(0, 'a dimension the ledger does not know is removed, not zeroed');
  });

  it('refuses to rebuild a dimension while a physical inventory count holds it open', async () => {
    const count = await createPhysicalInventory({
      client, createdBy: ACTOR, plant: PLANT, storageLocation: 'SU01',
      plannedCountDate: '2026-10-21', postingBlock: true, materials: ['UOM-MAT'],
    });
    const error = await rebuildStockDimension({
      client, changedBy: ACTOR, materialNumber: 'UOM-MAT',
      plant: PLANT, storageLocation: 'SU01', stockType: 'UNRESTRICTED',
    }).catch((e: unknown) => e as StockReconcileError);
    expect(error).toBeInstanceOf(StockReconcileError);
    expect(error.message).toMatch(new RegExp(count.inventoryDocumentNumber));

    // Counted stock is not silently rewritten: the projection still stands where the count found it.
    const [row] = await withTenant(client, (tx) => tx.execute(sql`
      select quantity::text from stock_quantity
       where client = ${client} and material_number = 'UOM-MAT' and plant = ${PLANT}
         and storage_location = 'SU01' and stock_type = 'UNRESTRICTED'
    `)) as unknown as Array<{ quantity: string }>;
    expect(row.quantity).toBe('76.000');
  });
});
