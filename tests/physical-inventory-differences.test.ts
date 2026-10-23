import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import {
  cancelPhysicalInventory,
  createPhysicalInventory,
} from '../src/modules/inventory/physical-inventory';
import { submitCounts } from '../src/modules/inventory/physical-inventory-count';
import {
  PhysicalInventoryDifferenceError,
  listDifferences,
  openDifferenceWorkflow,
} from '../src/modules/inventory/physical-inventory-differences';
import { createTenant, destroyTenant } from './helpers';

/**
 * SCR-148 / MI20 — the difference list reads the stored count and writes nothing.
 */
describe('SCR-148 physical inventory differences', () => {
  const ACTOR = 'SCR148_LIST';
  const DAY = '2026-10-15';
  const PLANT = '1000';
  const SLOC = '0001';
  let client = '';
  let otherClient = '';
  let documentNumber = '';
  let fiscalYear = 2026;
  let key = 0;
  const nextKey = () => `scr148-${++key}`;

  async function fingerprint(): Promise<string> {
    return withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select
          (select count(*) from material_document where client = ${client})::int as documents,
          (select count(*) from journal_entry where client = ${client})::int as journals,
          (select coalesce(sum(quantity), 0)::text from stock_quantity where client = ${client}) as stock,
          (select status || '/' || version::text from physical_inventory_document
            where client = ${client} and inventory_document_number = ${documentNumber}) as header,
          (select coalesce(string_agg(coalesce(difference_quantity::text, 'null'), ',' order by item_number), '')
             from physical_inventory_item
            where client = ${client} and inventory_document_number = ${documentNumber}) as differences
      `) as unknown as Array<{ documents: number; journals: number; stock: string; header: string; differences: string }>;
      const row = rows[0];
      return `${row.documents}/${row.journals}/${row.stock}/${row.header}/${row.differences}`;
    });
  }

  beforeAll(async () => {
    const tenant = await createTenant('scr148-mi20');
    client = tenant.client;
    const other = await createTenant('scr148-mi20-other');
    otherClient = other.client;
    await withTenant(client, async (tx) => {
      await defineRange(tx, {
        client, objectCode: 'PHYINV', subObject: '*', prefix: 'PI', numberLength: 7, createdBy: ACTOR,
      });
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        select ${client}, ${PLANT}, 'Difference plant', c.company_code, 'KW', ${ACTOR}
        from (select company_code from company_code where client = ${client} limit 1) c
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, allow_negative_stock, is_active, created_by)
        values (${client}, ${PLANT}, ${SLOC}, 'Difference store', false, true, ${ACTOR})
        on conflict (client, plant, storage_location) do update set is_active = true
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, m.number, m.description, 'RAW', 'PC', ${ACTOR}
        from (values
          ('DIFF-S', 'Shortage steel'),
          ('DIFF-P', 'Surplus bolts'),
          ('DIFF-Z', 'Exact count'),
          ('DIFF-U', 'Not yet counted'),
          ('DIFF-N', 'No valuation')
        ) m(number, description)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        select ${client}, m.number, ${PLANT}, ${ACTOR}
        from (values ('DIFF-S'), ('DIFF-P'), ('DIFF-Z'), ('DIFF-U'), ('DIFF-N')) m(number)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                             previous_fiscal_year, previous_period, allow_backposting, created_by)
        select ${client}, c.company_code, 2026, 10, 2026, 9, true, ${ACTOR}
        from (select company_code from company_code where client = ${client} limit 1) c
        on conflict (client, company_code) do update set
          current_fiscal_year = 2026, current_period = 10, allow_backposting = true
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        values
          (${client}, 'DIFF-S', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 100, ${ACTOR}),
          (${client}, 'DIFF-P', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 40, ${ACTOR}),
          (${client}, 'DIFF-Z', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 24, ${ACTOR}),
          (${client}, 'DIFF-U', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 8, ${ACTOR}),
          (${client}, 'DIFF-N', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 10, ${ACTOR})
        on conflict (client, material_number, plant, storage_location, stock_type, batch_number)
        do update set quantity = excluded.quantity
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency,
                                        total_stock_quantity, stock_value, created_by)
        values
          (${client}, 'DIFF-S', ${PLANT}, 'RAW_INVENTORY', 'STANDARD', 10, 10, 1, 'USD', 100, 1000, ${ACTOR}),
          (${client}, 'DIFF-P', ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 7.5, 10, 'USD', 40, 30, ${ACTOR}),
          (${client}, 'DIFF-Z', ${PLANT}, 'RAW_INVENTORY', 'STANDARD', 5, 5, 1, 'USD', 24, 120, ${ACTOR}),
          (${client}, 'DIFF-U', ${PLANT}, 'RAW_INVENTORY', 'STANDARD', 2, 2, 1, 'USD', 8, 16, ${ACTOR})
        on conflict do nothing
      `);
    });
    await withTenant(otherClient, async (tx) => {
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        select ${otherClient}, ${PLANT}, 'Other plant', c.company_code, 'KW', ${ACTOR}
        from (select company_code from company_code where client = ${otherClient} limit 1) c
        on conflict do nothing
      `);
    });

    const created = await createPhysicalInventory({
      client, createdBy: ACTOR, plant: PLANT, storageLocation: SLOC,
      plannedCountDate: DAY, postingBlock: false,
      materials: ['DIFF-S', 'DIFF-P', 'DIFF-Z', 'DIFF-U', 'DIFF-N'],
    });
    documentNumber = created.inventoryDocumentNumber;
    fiscalYear = created.fiscalYear;
    const item = (materialNumber: string) => created.items.find((i) => i.materialNumber === materialNumber)!.itemNumber;
    await submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear, countDate: DAY, requestKey: nextKey(),
      counterName: 'A. Counter',
      lines: [
        { itemNumber: item('DIFF-S'), quantity: 95 },
        { itemNumber: item('DIFF-P'), quantity: 44 },
        { itemNumber: item('DIFF-Z'), quantity: 24 },
        { itemNumber: item('DIFF-N'), quantity: 7 },
      ],
    });
  });

  afterAll(async () => {
    await destroyTenant(client);
    await destroyTenant(otherClient);
  });

  const list = (overrides: Parameters<typeof listDifferences>[1] = {
    plantFrom: PLANT, fiscalYear,
  }) => listDifferences(client, { plantFrom: PLANT, fiscalYear, ...overrides });

  it('shows a shortage and a surplus, and hides a zero and an uncounted item', async () => {
    const result = await list();
    expect(result.rows.map((r) => r.materialNumber).sort()).toEqual(['DIFF-N', 'DIFF-P', 'DIFF-S']);
    const shortage = result.rows.find((r) => r.materialNumber === 'DIFF-S')!;
    expect(shortage.direction).toBe('SHORTAGE');
    expect(shortage.label).toBe('PENDING');
    expect(shortage.differenceQuantity).toBe('-5.000');
    expect(shortage.bookQuantity).toBe('100.000');
    expect(shortage.bookBasis).toBe('DOCUMENT_CREATION');
    expect(shortage.description).toBe('Shortage steel');
    const surplus = result.rows.find((r) => r.materialNumber === 'DIFF-P')!;
    expect(surplus.direction).toBe('SURPLUS');
    expect(surplus.differenceQuantity).toBe('4.000');
    expect(result.rows.find((r) => r.materialNumber === 'DIFF-U')).toBeUndefined();
    expect(result.rows.find((r) => r.materialNumber === 'DIFF-Z')).toBeUndefined();
    expect(result.languageBasis).toBe('MATERIAL_MASTER');
  });

  it('does not treat an uncounted item as zero, and does not call a zero a shortage', async () => {
    const result = await list({ plantFrom: PLANT, fiscalYear, differenceExists: false, includeUncounted: true });
    const uncounted = result.rows.find((r) => r.materialNumber === 'DIFF-U')!;
    expect(uncounted.label).toBe('NOT_COUNTED');
    expect(uncounted.countedQuantity).toBeNull();
    expect(uncounted.direction).toBe('NONE');
    expect(uncounted.differenceQuantity).toBeNull();
    const exact = result.rows.find((r) => r.materialNumber === 'DIFF-Z')!;
    expect(exact.label).toBe('NO_DIFFERENCE');
    expect(exact.direction).toBe('NONE');
    expect(exact.differenceQuantity).toBe('0.000');
  });

  it('prices a standard shortage and a moving-average surplus by the price unit, in the currency decimals', async () => {
    const result = await list();
    const shortage = result.rows.find((r) => r.materialNumber === 'DIFF-S')!;
    expect(shortage.priceControl).toBe('STANDARD');
    expect(shortage.valuationBasis).toBe('CURRENT_PLANT_PRICE');
    expect(shortage.monetaryDifference).toBe('-50.00');
    expect(shortage.currency).toBe('USD');
    expect(shortage.monetaryReason).toBeNull();
    const surplus = result.rows.find((r) => r.materialNumber === 'DIFF-P')!;
    expect(surplus.priceControl).toBe('MOVING_AVERAGE');
    expect(surplus.priceUnit).toBe('10.000');
    expect(surplus.monetaryDifference).toBe('3.00');
  });

  it('names an unvalued material and does not invent a zero', async () => {
    const result = await list();
    const unvalued = result.rows.find((r) => r.materialNumber === 'DIFF-N')!;
    expect(unvalued.differenceQuantity).toBe('-3.000');
    expect(unvalued.monetaryDifference).toBeNull();
    expect(unvalued.valuationBasis).toBe('UNAVAILABLE');
    expect(unvalued.monetaryStatus).toBe('NO_VALUATION');
    expect(unvalued.monetaryReason).toMatch(/No valuation record/);
  });

  it('applies a monetary threshold without hiding an unvalued row or a genuine small shortage when asked', async () => {
    const result = await list({
      plantFrom: PLANT, fiscalYear, minimumDifferenceValue: 10, currency: 'USD',
    });
    expect(result.rows.map((r) => r.materialNumber).sort()).toEqual(['DIFF-N', 'DIFF-S']);
    expect(result.excludedUnvalued).toBe(0);
    const hidden = await list({
      plantFrom: PLANT, fiscalYear, minimumDifferenceValue: 10, currency: 'USD', includeUnvalued: false,
    });
    expect(hidden.rows.map((r) => r.materialNumber)).toEqual(['DIFF-S']);
    expect(hidden.excludedUnvalued).toBe(1);
  });

  it('refuses a threshold with no currency, a valuation type, and a range that runs backwards', async () => {
    await expect(list({ plantFrom: PLANT, fiscalYear, minimumDifferenceValue: 1 }))
      .rejects.toThrow(/needs the currency/);
    await expect(list({ plantFrom: PLANT, fiscalYear, valuationType: 'NEW' }))
      .rejects.toThrow(/Split valuation is not carried/);
    await expect(list({ plantFrom: PLANT, fiscalYear, materialFrom: 'DIFF-Z', materialTo: 'DIFF-A' }))
      .rejects.toThrow(/Material DIFF-Z is after DIFF-A/);
    await expect(list({ plantFrom: 'NOPE', fiscalYear })).rejects.toThrow(/Plant NOPE does not stand/);
    await expect(list({ plantFrom: PLANT, fiscalYear: 1999 })).rejects.toThrow(/not valid/);
  });

  it('filters by storage location, document and material, and does not leak another tenant', async () => {
    const narrowed = await list({
      plantFrom: PLANT, fiscalYear, storageLocationFrom: SLOC, storageLocationTo: SLOC,
      documentFrom: documentNumber, documentTo: documentNumber, materialFrom: 'DIFF-S', materialTo: 'DIFF-S',
    });
    expect(narrowed.rows.map((r) => r.materialNumber)).toEqual(['DIFF-S']);
    const other = await listDifferences(otherClient, { plantFrom: PLANT, fiscalYear });
    expect(other.rows).toEqual([]);
    expect(other.total).toBe(0);
  });

  it('keeps a row when the material period for the count date is closed, and says so', async () => {
    await withTenant(client, (tx) => tx.execute(sql`
      update material_period_control set current_fiscal_year = 2025, current_period = 1, allow_backposting = false
       where client = ${client}
    `));
    try {
      const result = await list({ plantFrom: PLANT, fiscalYear, showPeriodNote: true, materialFrom: 'DIFF-S', materialTo: 'DIFF-S' });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].periodNote).toMatch(/closed/);
      expect(result.rows[0].periodNote).toMatch(/not decided here/);
      expect(result.rows[0].countDate).toBe(DAY);
      expect(result.rows[0].plannedCountDate).toBe(DAY);
    } finally {
      await withTenant(client, (tx) => tx.execute(sql`
        update material_period_control set current_fiscal_year = 2026, current_period = 10, allow_backposting = true
         where client = ${client}
      `));
    }
  });

  it('flags a stored difference that no longer matches its two quantities, and does not overwrite it', async () => {
    await withTenant(client, (tx) => tx.execute(sql`
      update physical_inventory_item set difference_quantity = -9
       where client = ${client} and inventory_document_number = ${documentNumber} and material_number = 'DIFF-S'
    `));
    try {
      const result = await list({ plantFrom: PLANT, fiscalYear, materialFrom: 'DIFF-S', materialTo: 'DIFF-S' });
      expect(result.rows[0].differenceQuantity).toBe('-9.000');
      expect(result.rows[0].inconsistent).toBe(true);
      expect(result.rows[0].monetaryDifference).toBe('-90.00');
    } finally {
      await withTenant(client, (tx) => tx.execute(sql`
        update physical_inventory_item set difference_quantity = -5
         where client = ${client} and inventory_document_number = ${documentNumber} and material_number = 'DIFF-S'
      `));
    }
  });

  it('pages stably and falls back to the material number when a description is missing', async () => {
    const first = await list({ plantFrom: PLANT, fiscalYear, page: 1, pageSize: 1, sort: 'material' });
    const second = await list({ plantFrom: PLANT, fiscalYear, page: 2, pageSize: 1, sort: 'material' });
    expect(first.total).toBe(3);
    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(1);
    expect(first.rows[0].materialNumber < second.rows[0].materialNumber).toBe(true);
  });

  it('displays a document without opening the editor, and refuses posting and recount', async () => {
    const displayed = await openDifferenceWorkflow(client, {
      workflow: 'DISPLAY', documentNumber, fiscalYear,
    });
    expect(displayed?.items.map((i) => i.materialNumber)).toContain('DIFF-U');
    expect(displayed?.status).toBe('PARTIALLY_COUNTED');
    await expect(openDifferenceWorkflow(client, { workflow: 'POST', documentNumber, fiscalYear }))
      .rejects.toThrow(/does not post/);
    await expect(openDifferenceWorkflow(client, { workflow: 'RECOUNT', documentNumber, fiscalYear }))
      .rejects.toThrow(/does not create a recount/);
    await expect(openDifferenceWorkflow(client, { workflow: 'POST', documentNumber, fiscalYear }))
      .rejects.toBeInstanceOf(PhysicalInventoryDifferenceError);
  });

  it('leaves a cancelled document out of the list', async () => {
    const cancelled = await createPhysicalInventory({
      client, createdBy: ACTOR, plant: PLANT, storageLocation: SLOC,
      plannedCountDate: DAY, postingBlock: false, materials: ['DIFF-Z'],
    });
    await cancelPhysicalInventory({
      client, changedBy: ACTOR, inventoryDocumentNumber: cancelled.inventoryDocumentNumber, fiscalYear: cancelled.fiscalYear,
    });
    const result = await list({
      plantFrom: PLANT, fiscalYear, differenceExists: false, includeUncounted: true,
      documentFrom: cancelled.inventoryDocumentNumber, documentTo: cancelled.inventoryDocumentNumber,
    });
    expect(result.rows).toEqual([]);
  });

  it('writes nothing: counts, statuses, stock, documents and journals are unchanged', async () => {
    const before = await fingerprint();
    await list({ plantFrom: PLANT, fiscalYear, showPeriodNote: true, language: 'DE' });
    await openDifferenceWorkflow(client, { workflow: 'DISPLAY', documentNumber, fiscalYear });
    await expect(openDifferenceWorkflow(client, { workflow: 'POST', documentNumber, fiscalYear })).rejects.toThrow();
    expect(await fingerprint()).toBe(before);
  });
});
