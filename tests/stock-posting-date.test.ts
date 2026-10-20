import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  StockPostingDateError,
  stockOnPostingDate,
  type StockPostingDateSelection,
} from '../src/modules/inventory/stock-posting-date';
import { createTenant, destroyTenant } from './helpers';

/**
 * SCR-126 / MB5B acceptance for INV.STOCK.POSTINGDATE.
 *
 * The rollforward is read from the immutable ledger: opening is what was posted
 * before the window, receipts and issues what posted inside it, closing their
 * sum. The suite pins the arithmetic, the exclusion of reversed documents, the
 * zero-stock toggle, the required ranges, and the control that compares the
 * closing position with the stock master without ever adjusting it.
 */
describe('SCR-126 stocks on posting date (MB5B)', () => {
  const ACTOR = 'SCR126_MB5B_TEST';
  let client = '';

  beforeAll(async () => {
    const tenant = await createTenant('scr126-mb5b');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into plant (client, plant, name, country, created_by) values
          (${client}, 'Q300', 'Plant 300', 'KW', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by) values
          (${client}, 'MAT-300', 'Rolled material', 'RAW', 'PC', ${ACTOR}),
          (${client}, 'MAT-400', 'Netted material', 'RAW', 'PC', ${ACTOR}),
          (${client}, 'MAT-500', 'Drifted material', 'RAW', 'PC', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, created_by) values
          (${client}, 'Q300', 'SL30', 'Rollforward store', true, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
          (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt for purchase order', 'RECEIPT', 'PURCHASE_ORDER', ${ACTOR}),
          (${client}, 'RECEIPT_REVERSAL', 'Reversal of a goods receipt', 'REVERSAL', 'MATERIAL_DOCUMENT', ${ACTOR})
        on conflict do nothing
      `);

      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date, posting_date, header_text, status, created_by) values
          (${client}, '6000000001', 2026, '2026-03-20', '2026-03-20', 'Opening receipt', 'POSTED', ${ACTOR}),
          (${client}, '6000000002', 2026, '2026-04-05', '2026-04-05', 'April receipt', 'POSTED', ${ACTOR}),
          (${client}, '6000000003', 2026, '2026-04-10', '2026-04-10', 'April issue', 'POSTED', ${ACTOR}),
          (${client}, '6000000004', 2026, '2026-04-06', '2026-04-06', 'Reversed receipt', 'REVERSED', ${ACTOR}),
          (${client}, '6000000005', 2026, '2026-04-07', '2026-04-07', 'Netted in', 'POSTED', ${ACTOR}),
          (${client}, '6000000006', 2026, '2026-04-20', '2026-04-20', 'Netted out', 'POSTED', ${ACTOR}),
          (${client}, '6000000007', 2026, '2026-04-12', '2026-04-12', 'Drift receipt', 'POSTED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant,
          storage_location, stock_type, entry_quantity, entry_unit, base_quantity, base_unit,
          unit_price, price_unit, currency, value, created_by
        ) values
          (${client}, '6000000001', 1, 'GOODS_RECEIPT_PO', 'MAT-300', 'Q300', 'SL30', 'UNRESTRICTED', 10, 'PC', 10, 'PC', 10, 1, 'USD', 100, ${ACTOR}),
          (${client}, '6000000002', 1, 'GOODS_RECEIPT_PO', 'MAT-300', 'Q300', 'SL30', 'UNRESTRICTED', 5, 'PC', 5, 'PC', 10, 1, 'USD', 50, ${ACTOR}),
          (${client}, '6000000003', 1, 'RECEIPT_REVERSAL', 'MAT-300', 'Q300', 'SL30', 'UNRESTRICTED', 2, 'PC', 2, 'PC', 10, 1, 'USD', 20, ${ACTOR}),
          (${client}, '6000000004', 1, 'GOODS_RECEIPT_PO', 'MAT-300', 'Q300', 'SL30', 'UNRESTRICTED', 99, 'PC', 99, 'PC', 10, 1, 'USD', 990, ${ACTOR}),
          (${client}, '6000000005', 1, 'GOODS_RECEIPT_PO', 'MAT-400', 'Q300', 'SL30', 'UNRESTRICTED', 3, 'PC', 3, 'PC', 10, 1, 'USD', 30, ${ACTOR}),
          (${client}, '6000000006', 1, 'RECEIPT_REVERSAL', 'MAT-400', 'Q300', 'SL30', 'UNRESTRICTED', 3, 'PC', 3, 'PC', 10, 1, 'USD', 30, ${ACTOR}),
          (${client}, '6000000007', 1, 'GOODS_RECEIPT_PO', 'MAT-500', 'Q300', 'SL30', 'UNRESTRICTED', 4, 'PC', 4, 'PC', 10, 1, 'USD', 40, ${ACTOR})
        on conflict do nothing
      `);
      // The stock master agrees for MAT-300 (10 + 5 - 2 = 13) and nets MAT-400 to
      // zero, but drifts from the ledger for MAT-500 (1 on hand against 4 moved).
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by) values
          (${client}, 'MAT-300', 'Q300', 'SL30', 'UNRESTRICTED', 13, ${ACTOR}),
          (${client}, 'MAT-400', 'Q300', 'SL30', 'UNRESTRICTED', 0, ${ACTOR}),
          (${client}, 'MAT-500', 'Q300', 'SL30', 'UNRESTRICTED', 1, ${ACTOR})
        on conflict do nothing
      `);
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  const window = { materialFrom: 'MAT-300', materialTo: 'MAT-500', plantFrom: 'Q300', plantTo: 'Q300', dateFrom: '2026-04-01', dateTo: '2026-04-30' };

  async function report(selection: Partial<StockPostingDateSelection> = {}) {
    return stockOnPostingDate({ client, selection: { maxHits: 100, ...window, ...selection } });
  }

  it('rolls opening forward through receipts and issues to the closing position', async () => {
    const result = await report({ materialFrom: 'MAT-300', materialTo: 'MAT-300' });
    expect(result.capability).toBe('INV.STOCK.POSTINGDATE');
    const row = result.rows[0]!;
    expect(row).toMatchObject({
      materialNumber: 'MAT-300', materialDescription: 'Rolled material', plant: 'Q300',
      storageLocation: 'SL30', stockType: 'UNRESTRICTED', baseUnit: 'PC',
      openingQuantity: 10, openingValue: 100,
      receiptQuantity: 5, receiptValue: 50,
      issueQuantity: 2, issueValue: 20,
      closingQuantity: 13, closingValue: 130,
    });
    expect(row.drillDown).toContain('/inventory/material-document-list?materialFrom=MAT-300');
    expect(row.drillDown).toContain('postingDateFrom=2026-04-01');
  });

  it('leaves a reversed document out of every figure', async () => {
    const result = await report({ materialFrom: 'MAT-300', materialTo: 'MAT-300' });
    // The 99 received on the reversed document would swamp the receipt figure.
    expect(result.rows[0]!.receiptQuantity).toBe(5);
    expect(result.rows[0]!.closingQuantity).toBe(13);
  });

  it('suppresses a line that nets to zero unless zero stock lines are asked for', async () => {
    const suppressed = await report();
    expect(suppressed.rows.map((r) => r.materialNumber)).toEqual(['MAT-300', 'MAT-500']);

    const shown = await report({ displayZero: true });
    const netted = shown.rows.find((r) => r.materialNumber === 'MAT-400');
    expect(netted).toMatchObject({ openingQuantity: 0, receiptQuantity: 3, issueQuantity: 3, closingQuantity: 0 });
  });

  it('compares the closing position with the stock master and never adjusts it', async () => {
    const result = await report();
    const warned = result.warnings.join(' ');
    expect(warned).toMatch(/differs from the stock master for 1 row/);
    expect(warned).toMatch(/MAT-500/);
    expect(warned).toMatch(/closing 4\.000 against stock on hand 1\.000/);
    // The ledger figure stands: nothing is adjusted to the snapshot.
    expect(result.rows.find((r) => r.materialNumber === 'MAT-500')?.closingQuantity).toBe(4);
    // The agreeing rows raise nothing.
    expect(warned).not.toContain('MAT-300');
  });

  it('refuses to run without the required ranges', async () => {
    await expect(report({ materialFrom: '' })).rejects.toThrow(/material range is required/i);
    await expect(report({ plantFrom: '' })).rejects.toThrow(/plant range is required/i);
    await expect(report({ dateFrom: '' })).rejects.toThrow(/reporting date range is required/i);
    await expect(report({ dateFrom: '2026-04-30', dateTo: '2026-04-01' })).rejects.toThrow(/inverted/);
    await expect(report({ materialFrom: 'MAT-300', materialTo: 'MAT-200' })).rejects.toThrow(/material range is inverted/);
  });

  it('refuses a key that does not stand, by name', async () => {
    await expect(report({ materialFrom: 'MAT-999', materialTo: 'MAT-999' })).rejects.toThrow(/material MAT-999/);
    await expect(report({ plantFrom: 'Q999', plantTo: 'Q999' })).rejects.toThrow(/plant Q999/);
    await expect(report({ storageLocationFrom: 'SL99' })).rejects.toThrow(/storage location SL99/);
    await expect(report({ stockType: 'PROJECT' })).rejects.toThrow(/stock type PROJECT/);
    await expect(report({ materialFrom: 'MAT-999', materialTo: 'MAT-999' })).rejects.toBeInstanceOf(StockPostingDateError);
    await expect(report({ dateTo: '2026-04-31' })).rejects.toThrow(/not a valid date/);
    await expect(report({ maxHits: 0 })).rejects.toThrow(/Maximum hits/);
  });

  it('evaluates only the stock type asked for', async () => {
    const result = await report({ stockType: 'UNRESTRICTED' });
    expect(result.selection.stockType).toBe('UNRESTRICTED');
    expect(result.rows.every((r) => r.stockType === 'UNRESTRICTED')).toBe(true);
    // The default is unrestricted when none is supplied.
    const byDefault = await stockOnPostingDate({
      client,
      selection: { materialFrom: 'MAT-300', materialTo: 'MAT-300', plantFrom: 'Q300', plantTo: 'Q300', dateFrom: '2026-04-01', dateTo: '2026-04-30' },
    });
    expect(byDefault.selection.stockType).toBe('UNRESTRICTED');
  });

  it('truncates at the maximum hits and says so', async () => {
    const result = await report({ displayZero: true, maxHits: 1 });
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/truncated at 1 hits/);
  });
});
