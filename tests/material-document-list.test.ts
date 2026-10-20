import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  MaterialDocListError,
  listMaterialDocuments,
  type MaterialDocListSelection,
} from '../src/modules/inventory/material-document-list';
import { createTenant, destroyTenant } from './helpers';

/**
 * SCR-125 / MB51 acceptance for INV.MATERIALDOC.LIST.
 *
 * The list adds no state: it reads the ledger, joins the movement type and the
 * material description, and shows every line — reversed documents included,
 * with their reason. The suite pins the required posting-date range, the
 * movement-type filter over the canon's keys, the purchase-order traceability,
 * the stock-type judgement and refusal by name.
 */
describe('SCR-125 material document list (MB51)', () => {
  const ACTOR = 'SCR125_MB51_TEST';
  let client = '';

  beforeAll(async () => {
    const tenant = await createTenant('scr125-mb51-list');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into plant (client, plant, name, country, created_by) values
          (${client}, 'Q100', 'Plant 100', 'KW', ${ACTOR}),
          (${client}, 'Q200', 'Plant 200', 'KW', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by) values
          (${client}, 'MAT-100', 'Steel plate', 'RAW', 'PC', ${ACTOR}),
          (${client}, 'MAT-200', 'Copper wire', 'RAW', 'KG', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, created_by) values
          (${client}, 'Q100', 'SL01', 'Main store', true, ${ACTOR}),
          (${client}, 'Q200', 'SL02', 'Secondary store', true, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
          (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt for purchase order', 'RECEIPT', 'PURCHASE_ORDER', ${ACTOR}),
          (${client}, 'RECEIPT_REVERSAL', 'Reversal of a goods receipt', 'REVERSAL', 'MATERIAL_DOCUMENT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, name, created_by)
        values (${client}, 'V50000', 'Ledger supplier', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchasing_org (client, purchasing_org, name, created_by)
        values (${client}, 'O500', 'Ledger org', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchasing_group (client, purchasing_group, name, created_by)
        values (${client}, 'G05', 'Ledger group', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_order (
          client, order_number, document_type, supplier_number, purchasing_org, purchasing_group,
          company_code, currency, document_date, release_status, created_by
        ) values (${client}, '4600000001', 'STANDARD', 'V50000', 'O500', 'G05', '1000', 'USD', '2026-04-01', 'RELEASED', ${ACTOR})
        on conflict do nothing
      `);

      await tx.execute(sql`
        insert into material_document (
          client, material_document_number, document_year, document_date, posting_date, header_text,
          status, journal_document_number, created_by
        ) values
          (${client}, '4900000001', 2026, '2026-04-05', '2026-04-05', 'Receipt against order', 'POSTED', 'JE-1', 'POSTER_A'),
          (${client}, '4900000002', 2026, '2026-04-06', '2026-04-06', 'Second receipt', 'POSTED', 'JE-2', 'POSTER_B'),
          (${client}, '4900000003', 2026, '2026-04-07', '2026-04-07', 'Reversed receipt', 'REVERSED', 'JE-3', 'POSTER_A'),
          (${client}, '4900000004', 2026, '2026-04-08', '2026-04-08', 'Reversal of 4900000003', 'POSTED', null, 'POSTER_A'),
          (${client}, '4900000005', 2026, '2026-05-02', '2026-05-02', 'Outside the window', 'POSTED', 'JE-5', 'POSTER_A')
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant,
          storage_location, stock_type, entry_quantity, entry_unit, base_quantity, base_unit,
          unit_price, price_unit, currency, value, purchase_order_number, purchase_order_item, item_text, created_by
        ) values
          (${client}, '4900000001', 1, 'GOODS_RECEIPT_PO', 'MAT-100', 'Q100', 'SL01', 'UNRESTRICTED',
           4, 'PC', 4, 'PC', 12.5, 1, 'USD', 50, '4600000001', 10, 'First line', ${ACTOR}),
          (${client}, '4900000001', 2, 'GOODS_RECEIPT_PO', 'MAT-200', 'Q200', 'SL02', 'UNRESTRICTED',
           2, 'KG', 2, 'KG', 7, 1, 'USD', 14, null, null, 'Second line', ${ACTOR}),
          (${client}, '4900000002', 1, 'GOODS_RECEIPT_PO', 'MAT-100', 'Q100', 'SL01', 'UNRESTRICTED',
           1, 'PC', 1, 'PC', 12.5, 1, 'USD', 12.5, null, null, 'Third line', ${ACTOR}),
          (${client}, '4900000003', 1, 'GOODS_RECEIPT_PO', 'MAT-100', 'Q100', 'SL01', 'UNRESTRICTED',
           3, 'PC', 3, 'PC', 12.5, 1, 'USD', 37.5, null, null, 'Reversed line', ${ACTOR}),
          (${client}, '4900000004', 1, 'RECEIPT_REVERSAL', 'MAT-100', 'Q100', 'SL01', 'UNRESTRICTED',
           3, 'PC', 3, 'PC', 12.5, 1, 'USD', 37.5, null, null, 'Reversal line', ${ACTOR})
        on conflict do nothing
      `);
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  const window = { postingDateFrom: '2026-04-01', postingDateTo: '2026-04-30' };

  async function list(selection: Partial<MaterialDocListSelection> = {}) {
    return listMaterialDocuments({ client, selection: { maxHits: 100, ...window, ...selection } });
  }

  it('lists the ledger window newest first with the material description and movement direction', async () => {
    const result = await list();
    expect(result.capability).toBe('INV.MATERIALDOC.LIST');
    // 4900000005 posts in May and must not stand in an April window.
    expect(result.rows.map((r) => r.materialDocumentNumber)).toEqual([
      '4900000004', '4900000003', '4900000002', '4900000001', '4900000001',
    ]);
    const first = result.rows[0]!;
    expect(first).toMatchObject({
      movementType: 'RECEIPT_REVERSAL', movementDirection: 'REVERSAL', materialDescription: 'Steel plate',
      baseQuantity: 3, currency: 'USD', value: 37.5, plant: 'Q100', storageLocation: 'SL01',
    });
    expect(first.drillDown).toBe('/inventory/material-documents?document=4900000004');
  });

  it('requires a posting date range rather than scanning the whole ledger', async () => {
    await expect(listMaterialDocuments({
      client, selection: { postingDateFrom: '2026-04-01' },
    })).rejects.toThrow(/posting date range is required/i);
    await expect(listMaterialDocuments({
      client, selection: { postingDateFrom: '2026-05-01', postingDateTo: '2026-04-01' },
    })).rejects.toThrow(/inverted/);
  });

  it('lists a reversed document with its status, and its reversal as its own line', async () => {
    const result = await list({ documentDateFrom: '2026-04-07', documentDateTo: '2026-04-08' });
    const reversed = result.rows.find((r) => r.materialDocumentNumber === '4900000003');
    const reversal = result.rows.find((r) => r.materialDocumentNumber === '4900000004');
    expect(reversed?.status).toBe('REVERSED');
    expect(reversal?.movementDirection).toBe('REVERSAL');
    expect(result.warnings.join(' ')).toMatch(/stand reversed are listed/);
  });

  it('filters by material, plant, storage location, movement type, dates, stock type and user', async () => {
    const byMaterial = await list({ materialFrom: 'MAT-200', materialTo: 'MAT-200' });
    expect(byMaterial.rows).toHaveLength(1);
    expect(byMaterial.rows[0]?.storageLocation).toBe('SL02');

    const byPlant = await list({ plantFrom: 'Q200', plantTo: 'Q200' });
    expect(byPlant.rows.map((r) => r.materialNumber)).toEqual(['MAT-200']);

    const byLocation = await list({ storageLocationFrom: 'SL01', storageLocationTo: 'SL01' });
    expect(byLocation.rows).toHaveLength(4);

    const byMovement = await list({ movementTypeFrom: 'RECEIPT_REVERSAL', movementTypeTo: 'RECEIPT_REVERSAL' });
    expect(byMovement.rows.map((r) => r.materialDocumentNumber)).toEqual(['4900000004']);

    const byDocumentDate = await list({ documentDateFrom: '2026-04-06', documentDateTo: '2026-04-06' });
    expect(byDocumentDate.rows.map((r) => r.materialDocumentNumber)).toEqual(['4900000002']);

    const byStockType = await list({ stockType: 'UNRESTRICTED' });
    expect(byStockType.rows).toHaveLength(5);

    const byUser = await list({ userName: 'POSTER_B' });
    expect(byUser.rows.map((r) => r.materialDocumentNumber)).toEqual(['4900000002']);
  });

  it('traces a ledger line back to the purchase order it cites', async () => {
    const result = await list({ purchaseOrderFrom: '4600000001', purchaseOrderTo: '4600000001' });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ purchaseOrderNumber: '4600000001', purchaseOrderItem: 10, itemText: 'First line' });
  });

  it('truncates at the maximum hits and says so', async () => {
    const result = await list({ maxHits: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/truncated at 2 hits/);
  });

  it('refuses by name rather than answering an empty list', async () => {
    await expect(list({ materialFrom: 'MAT-999' })).rejects.toThrow(/material MAT-999/);
    await expect(list({ plantFrom: 'Q999' })).rejects.toThrow(/plant Q999/);
    await expect(list({ storageLocationFrom: 'SL99' })).rejects.toThrow(/storage location SL99/);
    await expect(list({ movementTypeFrom: 'NOT_A_MOVEMENT' })).rejects.toThrow(/movement type NOT_A_MOVEMENT/);
    await expect(list({ stockType: 'PROJECT' })).rejects.toThrow(/stock type PROJECT/);
    await expect(list({ userName: 'NOBODY' })).rejects.toThrow(/User NOBODY/);
    await expect(list({ purchaseOrderFrom: '4699999999', purchaseOrderTo: '4699999999' })).rejects.toThrow(/purchase order 4699999999/);
    await expect(list({ postingDateFrom: '2026-04-31' })).rejects.toThrow(/not a valid date/);
    await expect(list({ maxHits: 0 })).rejects.toThrow(/Maximum hits/);
    await expect(list({ plantFrom: 'Q999' })).rejects.toBeInstanceOf(MaterialDocListError);
    // A range over document numbers is a scan: unknown endpoints inside a range are fine.
    await expect(list({ purchaseOrderFrom: '4699999990', purchaseOrderTo: '4699999999' })).resolves.toMatchObject({ rowCount: 0 });
  });
});
