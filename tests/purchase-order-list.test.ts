import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  PoListError,
  listPurchaseOrders,
  type PoListSelection,
} from '../src/modules/purchasing/purchase-order-list';
import { createTenant, destroyTenant } from './helpers';

/**
 * SCR-124 / ME2L acceptance for PROC.PO.LIST.
 *
 * The list adds no state. It reads the standing purchase orders and derives
 * what the package's scope of selection needs from posted history: delivered
 * quantity from material-document lines by movement direction (cancelled
 * documents contribute nothing), invoiced quantity from supplier invoices that
 * stand posted. The suite pins the four perspectives, the four scopes, the
 * deletion rule, the requisition linkage and refusal by name.
 */
describe('SCR-124 purchase order list (ME2L suite)', () => {
  const ACTOR = 'SCR124_ME2L_TEST';
  let client = '';

  beforeAll(async () => {
    const tenant = await createTenant('scr124-po-list');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, name, created_by) values
          (${client}, 'V10000', 'Vendor One', ${ACTOR}),
          (${client}, 'V20000', 'Vendor Two', ${ACTOR}),
          (${client}, 'V30000', 'Vendor Three', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchasing_org (client, purchasing_org, name, created_by) values
          (${client}, 'O100', 'Org One', ${ACTOR}), (${client}, 'O200', 'Org Two', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchasing_group (client, purchasing_group, name, created_by) values
          (${client}, 'G01', 'Group One', ${ACTOR}), (${client}, 'G02', 'Group Two', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, country, created_by) values
          (${client}, 'P100', 'Plant One', 'KW', ${ACTOR}), (${client}, 'P200', 'Plant Two', 'KW', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_group (client, material_group, name, is_active, created_by)
        values (${client}, 'MG01', 'Group material', true, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${client}, 'M100', 'Ordered material', 'RAW', 'PC', ${ACTOR}) on conflict do nothing
      `);
      // The requisition one order converts.
      await tx.execute(sql`
        insert into purchase_requisition_item (
          client, requisition_number, item_number, document_type, item_category, material_number,
          short_text, quantity, unit, requisition_date, delivery_date, plant, purchasing_group,
          creation_source, created_by
        ) values (${client}, '9100000001', 10, 'STANDARD', 'STANDARD', 'M100', 'Demand',
          5, 'PC', '2026-01-20', '2026-02-20', 'P100', 'G01', 'MANUAL', ${ACTOR})
        on conflict do nothing
      `);

      await tx.execute(sql`
        insert into purchase_order (
          client, order_number, document_type, supplier_number, purchasing_org, purchasing_group,
          company_code, currency, document_date, release_status, created_by
        ) values
          (${client}, '4500000001', 'STANDARD', 'V10000', 'O100', 'G01', '1000', 'USD', '2026-02-01', 'RELEASED', ${ACTOR}),
          (${client}, '4500000002', 'STANDARD', 'V20000', 'O200', 'G02', '1000', 'USD', '2026-02-05', 'UNRELEASED', ${ACTOR}),
          (${client}, '4500000003', 'STANDARD', 'V30000', 'O100', 'G01', '1000', 'USD', '2026-02-10', 'RELEASED', ${ACTOR}),
          (${client}, '4500000004', 'STANDARD', 'V10000', 'O100', 'G01', '1000', 'USD', '2026-02-15', 'RELEASED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_order_item (
          client, order_number, item_number, item_category, material_number, short_text,
          quantity, unit, net_price, price_unit, net_value, plant, material_group,
          requisition_number, requisition_item, marked_for_deletion, created_by
        ) values
          (${client}, '4500000001', 10, 'STANDARD', 'M100', 'Completed line', 10, 'PC', 10, 1, 100, 'P100', 'MG01', null, null, false, ${ACTOR}),
          (${client}, '4500000002', 10, 'STANDARD', 'M100', 'Partial line', 10, 'PC', 20, 1, 200, 'P200', 'MG01', null, null, false, ${ACTOR}),
          (${client}, '4500000003', 10, 'STANDARD', 'M100', 'Delivered not invoiced', 5, 'PC', 30, 1, 150, 'P100', 'MG01', '9100000001', 10, false, ${ACTOR}),
          (${client}, '4500000004', 10, 'STANDARD', 'M100', 'Marked line', 2, 'PC', 5, 1, 10, 'P100', 'MG01', null, null, true, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_order_schedule_line (client, order_number, item_number, line_number, delivery_date, quantity, created_by) values
          (${client}, '4500000001', 10, 1, '2026-03-01', 10, ${ACTOR}),
          (${client}, '4500000002', 10, 1, '2026-03-05', 10, ${ACTOR})
        on conflict do nothing
      `);

      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
          (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt for purchase order', 'RECEIPT', 'PURCHASE_ORDER', ${ACTOR}),
          (${client}, 'RECEIPT_REVERSAL', 'Reversal of a goods receipt', 'REVERSAL', 'MATERIAL_DOCUMENT', ${ACTOR})
        on conflict do nothing
      `);
      // Goods receipts: 10 of line 1; 5 then a reversal of 1 on line 2; 5 on line 3
      // and a reversed document that must not count.
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date, posting_date, status, created_by) values
          (${client}, '5000000001', 2026, '2026-02-02', '2026-02-02', 'POSTED', ${ACTOR}),
          (${client}, '5000000002', 2026, '2026-02-06', '2026-02-06', 'POSTED', ${ACTOR}),
          (${client}, '5000000003', 2026, '2026-02-07', '2026-02-07', 'POSTED', ${ACTOR}),
          (${client}, '5000000004', 2026, '2026-02-11', '2026-02-11', 'POSTED', ${ACTOR}),
          (${client}, '5000000005', 2026, '2026-02-12', '2026-02-12', 'REVERSED', ${ACTOR}),
          (${client}, '5000000006', 2026, '2026-02-13', '2026-02-13', 'POSTED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant,
          stock_type, entry_quantity, entry_unit, base_quantity, base_unit, unit_price, price_unit, value,
          purchase_order_number, purchase_order_item, created_by
        ) values
          (${client}, '5000000001', 1, 'GOODS_RECEIPT_PO', 'M100', 'P100', 'UNRESTRICTED', 10, 'PC', 10, 'PC', 10, 1, 100, '4500000001', 10, ${ACTOR}),
          (${client}, '5000000002', 1, 'GOODS_RECEIPT_PO', 'M100', 'P200', 'UNRESTRICTED', 5, 'PC', 5, 'PC', 20, 1, 100, '4500000002', 10, ${ACTOR}),
          (${client}, '5000000003', 1, 'RECEIPT_REVERSAL', 'M100', 'P200', 'UNRESTRICTED', 1, 'PC', 1, 'PC', 20, 1, 20, '4500000002', 10, ${ACTOR}),
          (${client}, '5000000004', 1, 'GOODS_RECEIPT_PO', 'M100', 'P100', 'UNRESTRICTED', 5, 'PC', 5, 'PC', 30, 1, 150, '4500000003', 10, ${ACTOR}),
          (${client}, '5000000005', 1, 'GOODS_RECEIPT_PO', 'M100', 'P100', 'UNRESTRICTED', 5, 'PC', 5, 'PC', 30, 1, 150, '4500000003', 10, ${ACTOR})
        on conflict do nothing
      `);
      // The reversal module does not delete the original's lines, it posts a document that cancels
      // them and marks the original reversed. The fixture's reversed receipt only tells that story
      // once its reversal stands next to it; the reader has to count both or neither.
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date, posting_date,
                                       status, reversal_of, created_by)
        values (${client}, '5000000007', 2026, '2026-01-18', '2026-01-18', 'POSTED', '5000000005', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant,
          stock_type, entry_quantity, entry_unit, base_quantity, base_unit, unit_price, price_unit, value,
          purchase_order_number, purchase_order_item, line_direction, reversal_of_document, reversal_of_line, created_by
        ) values
          (${client}, '5000000007', 1, 'RECEIPT_REVERSAL', 'M100', 'P100', 'UNRESTRICTED', 5, 'PC', 5, 'PC',
           30, 1, 150, '4500000003', 10, 'ISSUE', '5000000005', 1, ${ACTOR})
        on conflict do nothing
      `);

      // Invoice for line 1 only.
      await tx.execute(sql`
        insert into supplier_invoice (
          client, invoice_number, fiscal_year, category, supplier_number, company_code, purchase_order_number,
          invoice_date, posting_date, supplier_reference, currency, gross_amount, tax_amount, status, created_by
        ) values (${client}, 'SI0000001', 2026, 'INVOICE', 'V10000', '1000', '4500000001',
          '2026-02-03', '2026-02-03', 'REF-1', 'USD', 100, 0, 'POSTED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_invoice_item (
          client, invoice_number, line_number, purchase_order_number, purchase_order_item, quantity, unit,
          net_amount, expected_amount, variance_amount, tax_amount, created_by
        ) values (${client}, 'SI0000001', 1, '4500000001', 10, 10, 'PC', 100, 100, 0, 0, ${ACTOR})
        on conflict do nothing
      `);
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function list(selection: Partial<PoListSelection> = {}) {
    return listPurchaseOrders({ client, selection: { maxHits: 100, ...selection } });
  }

  it('lists every order line with the vendor name and derived quantities', async () => {
    const result = await list();
    expect(result.capability).toBe('PROC.PO.LIST');
    expect(result.perspective).toBe('VENDOR');
    expect(result.perspectiveAlias).toBe('ME2L');
    const byOrder = new Map(result.rows.map((r) => [r.orderNumber, r]));
    expect(byOrder.get('4500000001')).toMatchObject({
      supplierName: 'Vendor One', quantity: 10, deliveredQuantity: 10, invoicedQuantity: 10, status: 'COMPLETED',
    });
    // 5 received less a reversal of 1.
    expect(byOrder.get('4500000002')).toMatchObject({
      deliveredQuantity: 4, invoicedQuantity: 0, openDeliveryQuantity: 6, status: 'PARTIALLY_DELIVERED',
      releaseStatus: 'UNRELEASED',
    });
    // The reversed goods-receipt document contributes nothing.
    expect(byOrder.get('4500000003')).toMatchObject({
      deliveredQuantity: 5, invoicedQuantity: 0, openInvoiceQuantity: 5, status: 'DELIVERED',
    });
    expect(byOrder.get('4500000004')).toMatchObject({ markedForDeletion: true, status: 'MARKED' });
    expect(byOrder.get('4500000002')?.deliveryDate).toBe('2026-03-05');
    expect(byOrder.get('4500000003')?.deliveryDate).toBe('');
  });

  it('applies the scope of selection over the derived quantities', async () => {
    const deliver = await list({ scope: 'STILL_TO_BE_DELIVERED' });
    expect(deliver.rows.map((r) => r.orderNumber)).toEqual(['4500000002']);

    // A partially delivered line also stands open for invoicing: 4 delivered,
    // nothing invoiced yet.
    const invoice = await list({ scope: 'STILL_TO_BE_INVOICED' });
    expect(invoice.rows.map((r) => r.orderNumber)).toEqual(['4500000002', '4500000003']);

    const completed = await list({ scope: 'COMPLETED' });
    expect(completed.rows.map((r) => r.orderNumber)).toEqual(['4500000001']);

    // A marked item is never outstanding work, whatever its quantities.
    for (const scope of ['STILL_TO_BE_DELIVERED', 'STILL_TO_BE_INVOICED', 'COMPLETED'] as const) {
      const rows = await list({ scope });
      expect(rows.rows.some((r) => r.markedForDeletion)).toBe(false);
    }
  });

  it('honours the four perspectives in the primary sort and names its alias', async () => {
    const byVendor = await list({ perspective: 'VENDOR' });
    expect(byVendor.perspectiveAlias).toBe('ME2L');
    expect(byVendor.rows.map((r) => r.supplierNumber)).toEqual(['V10000', 'V10000', 'V20000', 'V30000']);

    const byOrder = await list({ perspective: 'ME2N', scope: 'ALL' });
    expect(byOrder.rows.map((r) => r.orderNumber)).toEqual(['4500000001', '4500000002', '4500000003', '4500000004']);

    const byMaterial = await list({ perspective: 'MATERIAL' });
    expect(byMaterial.perspectiveAlias).toBe('ME2M');
    expect(byMaterial.rows).toHaveLength(4);

    const byGroup = await list({ perspective: 'MATERIAL_GROUP' });
    expect(byGroup.perspectiveAlias).toBe('ME2C');
    expect(byGroup.rows).toHaveLength(4);
  });

  it('filters by every range the package names', async () => {
    const byVendor = await list({ vendorFrom: 'V20000', vendorTo: 'V20000' });
    expect(byVendor.rows.map((r) => r.orderNumber)).toEqual(['4500000002']);

    const byOrg = await list({ purchasingOrgFrom: 'O100', purchasingOrgTo: 'O100' });
    expect(byOrg.rows.map((r) => r.orderNumber).sort()).toEqual(['4500000001', '4500000003', '4500000004']);

    const byGroup = await list({ purchasingGroupFrom: 'G02', purchasingGroupTo: 'G02' });
    expect(byGroup.rows.map((r) => r.orderNumber)).toEqual(['4500000002']);

    const byPlant = await list({ plantFrom: 'P200', plantTo: 'P200' });
    expect(byPlant.rows.map((r) => r.orderNumber)).toEqual(['4500000002']);

    const byMaterial = await list({ materialFrom: 'M100', materialTo: 'M100' });
    expect(byMaterial.rows).toHaveLength(4);

    const byMaterialGroup = await list({ materialGroupFrom: 'MG01', materialGroupTo: 'MG01' });
    expect(byMaterialGroup.rows).toHaveLength(4);

    const byOrder = await list({ orderFrom: '4500000002', orderTo: '4500000003' });
    expect(byOrder.rows.map((r) => r.orderNumber).sort()).toEqual(['4500000002', '4500000003']);

    const byDate = await list({ documentDateFrom: '2026-02-05', documentDateTo: '2026-02-10' });
    expect(byDate.rows.map((r) => r.orderNumber).sort()).toEqual(['4500000002', '4500000003']);
  });

  it('links a converted requisition back to its requested demand', async () => {
    const result = await list({ orderFrom: '4500000003', orderTo: '4500000003' });
    expect(result.rows[0]).toMatchObject({
      requisitionNumber: '9100000001', requisitionItem: 10, requisitionQuantity: 5,
    });
    const plain = await list({ orderFrom: '4500000001', orderTo: '4500000001' });
    expect(plain.rows[0]?.requisitionNumber).toBe('');
    expect(plain.rows[0]?.requisitionQuantity).toBeNull();
  });

  it('truncates at the maximum hits and says so', async () => {
    const result = await list({ maxHits: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/truncated at 2 hits/);
  });

  it('refuses by name rather than answering an empty list', async () => {
    await expect(list({ vendorFrom: 'V99999' })).rejects.toThrow(/vendor V99999/);
    await expect(list({ purchasingOrgFrom: 'OZZZ' })).rejects.toThrow(/purchasing organisation OZZZ/);
    await expect(list({ purchasingGroupTo: 'GZZ' })).rejects.toThrow(/purchasing group GZZ/);
    await expect(list({ plantFrom: 'PZZZ' })).rejects.toThrow(/plant PZZZ/);
    await expect(list({ materialFrom: 'MZZZ' })).rejects.toThrow(/material MZZZ/);
    await expect(list({ materialGroupFrom: 'MGZZ' })).rejects.toThrow(/material group MGZZ/);
    await expect(list({ orderFrom: '4599999999', orderTo: '4599999999' })).rejects.toThrow(/purchase order 4599999999/);
    await expect(list({ vendorFrom: 'V30000', vendorTo: 'V10000' })).rejects.toThrow(/inverted/);
    await expect(list({ documentDateFrom: '2026-02-30' })).rejects.toThrow(/not a valid date/);
    await expect(list({ perspective: 'CUSTOMER' })).rejects.toThrow(/CUSTOMER/);
    await expect(list({ scope: 'SOMETIME' })).rejects.toThrow(/SOMETIME/);
    await expect(list({ maxHits: 0 })).rejects.toThrow(/Maximum hits/);
    await expect(list({ vendorFrom: 'V99999' })).rejects.toBeInstanceOf(PoListError);
    // A range over document numbers is a scan: unknown endpoints inside a range are fine.
    await expect(list({ orderFrom: '4599999990', orderTo: '4599999999' })).resolves.toMatchObject({ rowCount: 0 });
  });

  it('drills each row down to the order display', async () => {
    const result = await list({ orderFrom: '4500000001', orderTo: '4500000001' });
    expect(result.rows[0]?.drillDown).toBe('/purchasing/orders?order=4500000001');
  });

  it('measures an alternative-unit receipt against the order line in the order unit', async () => {
    // The order counts 3 boxes of M100, which the material counts as 36 pieces. A receipt of one
    // box leaves two boxes open, and the line still belongs to "still to be delivered" — neither
    // of which the reader says when it measures the stored base figure against the ordered one.
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into unit_of_measure (code, name) values ('BOX', 'Box') on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_uom_conversion (client, material_number, alternative_unit, base_unit,
                                            numerator, denominator, created_by)
        values (${client}, 'M100', 'BOX', 'PC', 12, 1, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_order (client, order_number, document_type, supplier_number, purchasing_org,
                                    purchasing_group, company_code, currency, document_date, release_status, created_by)
        values (${client}, '4500000009', 'STANDARD', 'V10000', 'O100', 'G01', '1000', 'USD', '2026-02-20',
                'RELEASED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_order_item (client, order_number, item_number, item_category, material_number,
                                         short_text, quantity, unit, net_price, price_unit, net_value, plant,
                                         material_group, requisition_number, requisition_item, marked_for_deletion, created_by)
        values (${client}, '4500000009', 10, 'STANDARD', 'M100', 'Boxed line', 3, 'BOX', 40, 1, 120, 'P100',
                'MG01', null, null, false, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date, posting_date,
                                       status, created_by)
        values (${client}, '5000000009', 2026, '2026-02-21', '2026-02-21', 'POSTED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant,
          stock_type, entry_quantity, entry_unit, base_quantity, base_unit, unit_price, price_unit, value,
          purchase_order_number, purchase_order_item, created_by
        ) values
          (${client}, '5000000009', 1, 'GOODS_RECEIPT_PO', 'M100', 'P100', 'UNRESTRICTED', 1, 'BOX', 12, 'PC',
           40, 1, 40, '4500000009', 10, ${ACTOR})
        on conflict do nothing
      `);
    });

    try {
      const rows = await list({ orderFrom: '4500000009', orderTo: '4500000009' });
      const row = rows.rows.find((entry) => entry.orderNumber === '4500000009' && entry.itemNumber === 10);
      expect(row).toMatchObject({
        quantity: 3, deliveredQuantity: 1, openDeliveryQuantity: 2, status: 'PARTIALLY_DELIVERED',
      });

      const open = await list({ scope: 'STILL_TO_BE_DELIVERED', orderFrom: '4500000009', orderTo: '4500000009' });
      expect(open.rows.map((entry) => entry.orderNumber)).toEqual(['4500000009']);

      const completed = await list({ scope: 'COMPLETED', orderFrom: '4500000009', orderTo: '4500000009' });
      expect(completed.rows).toEqual([]);
    } finally {
      await withTenant(client, async (tx) => {
        await tx.execute(sql`delete from material_document_line where client = ${client} and material_document_number = '5000000009'`);
        await tx.execute(sql`delete from material_document where client = ${client} and material_document_number = '5000000009'`);
        await tx.execute(sql`delete from purchase_order_item where client = ${client} and order_number = '4500000009'`);
        await tx.execute(sql`delete from purchase_order where client = ${client} and order_number = '4500000009'`);
        await tx.execute(sql`delete from material_uom_conversion where client = ${client} and material_number = 'M100'`);
      });
    }
  });


  // What the line shows as delivered is what reached the plant and stayed there: a return takes
  // quantity back, and a reversal cancels the movement it points at. Counting every receipt-linked
  // line as a receipt reports four pieces received and returned in full as eight delivered, fully
  // delivered, with eight still to invoice.
  it('nets a return and a reversed receipt against the delivered quantity', async () => {
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
          (${client}, 'RETURN_TO_VENDOR', 'Return delivery to vendor', 'ISSUE', 'PURCHASE_ORDER', ${ACTOR}),
          (${client}, 'RETURN_TO_VENDOR_REV', 'Reversal of return delivery to vendor', 'REVERSAL', 'MATERIAL_DOCUMENT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_order (client, order_number, document_type, supplier_number, purchasing_org,
                                    purchasing_group, company_code, currency, document_date, release_status, created_by)
        values (${client}, '4500000010', 'STANDARD', 'V10000', 'O100', 'G01', '1000', 'USD', '2026-02-20',
                'RELEASED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_order_item (client, order_number, item_number, item_category, material_number,
                                         short_text, quantity, unit, net_price, price_unit, net_value, plant,
                                         material_group, requisition_number, requisition_item, marked_for_deletion, created_by)
        values
          (${client}, '4500000010', 10, 'STANDARD', 'M100', 'Received, nothing back', 4, 'PC', 10, 1, 40, 'P100', 'MG01', null, null, false, ${ACTOR}),
          (${client}, '4500000010', 20, 'STANDARD', 'M100', 'Partly returned', 4, 'PC', 10, 1, 40, 'P100', 'MG01', null, null, false, ${ACTOR}),
          (${client}, '4500000010', 30, 'STANDARD', 'M100', 'Returned in full', 4, 'PC', 10, 1, 40, 'P100', 'MG01', null, null, false, ${ACTOR}),
          (${client}, '4500000010', 40, 'STANDARD', 'M100', 'Return reversed', 4, 'PC', 10, 1, 40, 'P100', 'MG01', null, null, false, ${ACTOR}),
          (${client}, '4500000010', 50, 'STANDARD', 'M100', 'Receipt reversed', 4, 'PC', 10, 1, 40, 'P100', 'MG01', null, null, false, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date, posting_date,
                                       status, reversal_of, created_by)
        values
          (${client}, '7000000011', 2026, '2026-02-21', '2026-02-21', 'POSTED', null, ${ACTOR}),
          (${client}, '7000000012', 2026, '2026-02-21', '2026-02-21', 'POSTED', null, ${ACTOR}),
          (${client}, '7000000013', 2026, '2026-02-22', '2026-02-22', 'POSTED', null, ${ACTOR}),
          (${client}, '7000000014', 2026, '2026-02-22', '2026-02-22', 'POSTED', null, ${ACTOR}),
          (${client}, '7000000015', 2026, '2026-02-23', '2026-02-23', 'POSTED', null, ${ACTOR}),
          (${client}, '7000000016', 2026, '2026-02-23', '2026-02-23', 'POSTED', null, ${ACTOR}),
          (${client}, '7000000017', 2026, '2026-02-24', '2026-02-24', 'POSTED', '7000000016', ${ACTOR}),
          (${client}, '7000000018', 2026, '2026-02-24', '2026-02-24', 'REVERSED', null, ${ACTOR}),
          (${client}, '7000000019', 2026, '2026-02-25', '2026-02-25', 'POSTED', '7000000018', ${ACTOR})
        on conflict do nothing
      `);
      // Every line carries the purchase order reference both the goods receipt and the return write:
      // the receipt adds, the issue subtracts, and the reversal cancels the movement it points at.
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant,
          stock_type, entry_quantity, entry_unit, base_quantity, base_unit, unit_price, price_unit, value,
          purchase_order_number, purchase_order_item, line_direction, reversal_of_document, reversal_of_line, created_by
        ) values
          (${client}, '7000000011', 1, 'GOODS_RECEIPT_PO', 'M100', 'P100', 'UNRESTRICTED', 4, 'PC', 4, 'PC', 10, 1, 40, '4500000010', 10, 'RECEIPT', null, null, ${ACTOR}),
          (${client}, '7000000012', 1, 'GOODS_RECEIPT_PO', 'M100', 'P100', 'UNRESTRICTED', 4, 'PC', 4, 'PC', 10, 1, 40, '4500000010', 20, 'RECEIPT', null, null, ${ACTOR}),
          (${client}, '7000000012', 2, 'RETURN_TO_VENDOR', 'M100', 'P100', 'UNRESTRICTED', 1, 'PC', 1, 'PC', 10, 1, 10, '4500000010', 20, 'ISSUE', null, null, ${ACTOR}),
          (${client}, '7000000013', 1, 'GOODS_RECEIPT_PO', 'M100', 'P100', 'UNRESTRICTED', 4, 'PC', 4, 'PC', 10, 1, 40, '4500000010', 30, 'RECEIPT', null, null, ${ACTOR}),
          (${client}, '7000000014', 1, 'RETURN_TO_VENDOR', 'M100', 'P100', 'UNRESTRICTED', 4, 'PC', 4, 'PC', 10, 1, 40, '4500000010', 30, 'ISSUE', null, null, ${ACTOR}),
          (${client}, '7000000015', 1, 'GOODS_RECEIPT_PO', 'M100', 'P100', 'UNRESTRICTED', 4, 'PC', 4, 'PC', 10, 1, 40, '4500000010', 40, 'RECEIPT', null, null, ${ACTOR}),
          (${client}, '7000000016', 1, 'RETURN_TO_VENDOR', 'M100', 'P100', 'UNRESTRICTED', 2, 'PC', 2, 'PC', 10, 1, 20, '4500000010', 40, 'ISSUE', null, null, ${ACTOR}),
          (${client}, '7000000017', 1, 'RETURN_TO_VENDOR_REV', 'M100', 'P100', 'UNRESTRICTED', 2, 'PC', 2, 'PC', 10, 1, 20, '4500000010', 40, 'RECEIPT', '7000000016', 1, ${ACTOR}),
          (${client}, '7000000018', 1, 'GOODS_RECEIPT_PO', 'M100', 'P100', 'UNRESTRICTED', 4, 'PC', 4, 'PC', 10, 1, 40, '4500000010', 50, 'RECEIPT', null, null, ${ACTOR}),
          (${client}, '7000000019', 1, 'RECEIPT_REVERSAL', 'M100', 'P100', 'UNRESTRICTED', 4, 'PC', 4, 'PC', 10, 1, 40, '4500000010', 50, 'ISSUE', '7000000018', 1, ${ACTOR})
        on conflict do nothing
      `);
    });

    try {
      const rows = await list({ orderFrom: '4500000010', orderTo: '4500000010' });
      const item = (number: number) => rows.rows.find((entry) => entry.itemNumber === number);

      // A receipt alone is the case the reader already got right.
      expect(item(10)).toMatchObject({
        quantity: 4, deliveredQuantity: 4, openDeliveryQuantity: 0, openInvoiceQuantity: 4, status: 'DELIVERED',
      });
      // One piece given back is three delivered, not five, and the line stays open.
      expect(item(20)).toMatchObject({
        deliveredQuantity: 3, openDeliveryQuantity: 1, openInvoiceQuantity: 3, status: 'PARTIALLY_DELIVERED',
      });
      // Returned in full, the line is back where it started: nothing delivered, nothing to invoice.
      expect(item(30)).toMatchObject({
        deliveredQuantity: 0, openDeliveryQuantity: 4, openInvoiceQuantity: 0, status: 'OPEN',
      });
      // A return reversed again restores the receipt; two cancellations do not remove the goods.
      expect(item(40)).toMatchObject({
        deliveredQuantity: 4, openDeliveryQuantity: 0, openInvoiceQuantity: 4, status: 'DELIVERED',
      });
      // A receipt whose document was really reversed cancels itself: it reads as nothing, never as
      // minus four received with eight still to come.
      expect(item(50)).toMatchObject({
        deliveredQuantity: 0, openDeliveryQuantity: 4, openInvoiceQuantity: 0, status: 'OPEN',
      });

      const open = await list({ scope: 'STILL_TO_BE_DELIVERED', orderFrom: '4500000010', orderTo: '4500000010' });
      expect(open.rows.map((entry) => entry.itemNumber)).toEqual([20, 30, 50]);
    } finally {
      await withTenant(client, async (tx) => {
        await tx.execute(sql`
          delete from material_document_line
           where client = ${client} and purchase_order_number = '4500000010'
        `);
        await tx.execute(sql`
          delete from material_document
           where client = ${client} and material_document_number in
                 ('7000000011', '7000000012', '7000000013', '7000000014', '7000000015',
                  '7000000016', '7000000017', '7000000018', '7000000019')
        `);
        await tx.execute(sql`
          delete from purchase_order_item where client = ${client} and order_number = '4500000010'
        `);
        await tx.execute(sql`
          delete from purchase_order where client = ${client} and order_number = '4500000010'
        `);
      });
    }
  });
});
