import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  assignedShare,
  displayPurchaseOrder,
  searchPurchaseOrders,
} from '../src/modules/purchasing/purchase-order-display';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR164_DISP';
const ORDER = 'PO-DISP1';

describe('SCR-164 purchase order display', () => {
  let client = '';
  let other = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
    if (other) await destroyTenant(other);
  });

  it('reads one order, keeps a reversal, and writes nothing', async () => {
    const tenant = await createTenant('scr164-purchase-order-display');
    client = tenant.client;
    other = (await createTenant('scr164-purchase-order-display-other')).client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, general_status, created_by)
        values (${client}, 'V-DISP', 'ORGANIZATION', 'Displayed supplier', 'CREATED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into purchasing_group (client, purchasing_group, name, created_by)
        values (${client}, '001', 'Buyer', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'MAT-DISP', 'Displayed material', t.material_type, u.code, ${ACTOR}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
        cross join (select code from unit_of_measure order by code limit 1) u
      `);
      const [unit] = await tx.execute(sql`select base_unit from material where client = ${client} and material_number = 'MAT-DISP'`) as unknown as Array<{ base_unit: string }>;
      await tx.execute(sql`
        insert into purchase_order
          (client, order_number, supplier_number, purchasing_org, purchasing_group, company_code, currency, document_date, created_by)
        values (${client}, ${ORDER}, 'V-DISP', '1000', '001', '1000', ${tenant.currency}, '2026-10-18', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into purchase_order_item
          (client, order_number, item_number, material_number, short_text, quantity, unit, net_price, price_unit, net_value, plant, created_by)
        values
          (${client}, ${ORDER}, 10, 'MAT-DISP', 'Bolts', 10, ${unit.base_unit}, 15, 1, 100, '1000', ${ACTOR}),
          (${client}, ${ORDER}, 20, 'MAT-DISP', 'Marked', 2, ${unit.base_unit}, 5, 1, 10, '1000', ${ACTOR})
      `);
      await tx.execute(sql`
        update purchase_order_item set marked_for_deletion = true
         where client = ${client} and order_number = ${ORDER} and item_number = 20
      `);
      await tx.execute(sql`
        insert into purchase_order_schedule_line
          (client, order_number, item_number, line_number, delivery_date, quantity, created_by)
        values
          (${client}, ${ORDER}, 10, 1, '2026-11-01', 6, ${ACTOR}),
          (${client}, ${ORDER}, 10, 2, '2026-11-15', 4, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into purchase_order_assignment
          (client, order_number, item_number, line_number, gl_account, cost_center, distribution_percentage, created_by)
        values
          (${client}, ${ORDER}, 10, 1, '400000', 'CC1000', 60, ${ACTOR}),
          (${client}, ${ORDER}, 10, 2, '400000', 'CC2000', 40, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
          (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt for purchase order', 'RECEIPT', 'PURCHASE_ORDER', ${ACTOR}),
          (${client}, 'RECEIPT_REVERSAL', 'Reversal of a goods receipt', 'REVERSAL', 'MATERIAL_DOCUMENT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document
          (client, material_document_number, document_year, document_date, posting_date, status, reversal_of, created_by)
        values
          (${client}, '5000000001', 2026, '2026-10-19', '2026-10-19', 'POSTED', null, ${ACTOR}),
          (${client}, '5000000002', 2026, '2026-10-20', '2026-10-20', 'POSTED', '5000000001', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant,
          stock_type, entry_quantity, entry_unit, base_quantity, base_unit, unit_price, price_unit, value,
          purchase_order_number, purchase_order_item, created_by
        ) values
          (${client}, '5000000001', 1, 'GOODS_RECEIPT_PO', 'MAT-DISP', '1000', 'UNRESTRICTED', 4, ${unit.base_unit}, 4, ${unit.base_unit}, 15, 1, 60, ${ORDER}, 10, ${ACTOR}),
          (${client}, '5000000002', 1, 'RECEIPT_REVERSAL', 'MAT-DISP', '1000', 'UNRESTRICTED', 1, ${unit.base_unit}, 1, ${unit.base_unit}, 15, 1, 15, ${ORDER}, 10, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into supplier_invoice (
          client, invoice_number, fiscal_year, category, supplier_number, company_code, purchase_order_number,
          invoice_date, posting_date, supplier_reference, currency, gross_amount, status, created_by
        ) values
          (${client}, 'VI-DISP1', 2026, 'INVOICE', 'V-DISP', '1000', ${ORDER}, '2026-10-21', '2026-10-21', 'REF-DISP1', ${tenant.currency}, 30, 'POSTED', ${ACTOR}),
          (${client}, 'VI-DISP2', 2026, 'INVOICE', 'V-DISP', '1000', ${ORDER}, '2026-10-21', '2026-10-21', 'REF-DISP2', ${tenant.currency}, 90, 'CANCELLED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into supplier_invoice_item (
          client, invoice_number, line_number, purchase_order_number, purchase_order_item, quantity, unit, net_amount, expected_amount, created_by
        ) values
          (${client}, 'VI-DISP1', 1, ${ORDER}, 10, 2, ${unit.base_unit}, 30, 30, ${ACTOR}),
          (${client}, 'VI-DISP2', 1, ${ORDER}, 10, 6, ${unit.base_unit}, 90, 90, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into change_document (id, client, object_class, object_key, change_type, changed_by)
        values ('scr164-change', ${client}, 'purchase_order', ${ORDER}, 'CREATE', ${ACTOR})
      `);
    });

    const before = await counts(client);
    const shown = await displayPurchaseOrder(client, ORDER);
    expect(shown.found).toBe(true);
    if (!shown.found) return;
    const item = shown.order.items.find((row) => row.itemNumber === 10);
    expect(item?.netValue).toBe('100.00');
    expect(item?.netPrice).toBe('15.00');
    expect(item?.schedules).toHaveLength(2);
    expect(item?.assignments.map((row) => row.assignedValue)).toEqual(['60.00', '40.00']);
    expect(item?.receivedQuantity).toBe('3.000');
    expect(item?.invoicedQuantity).toBe('2.000');
    expect(item?.state).toBe('PARTIALLY_DELIVERED');
    expect(shown.order.items.find((row) => row.itemNumber === 20)?.state).toBe('MARKED');
    expect(shown.order.headerState).toBe('MIXED');
    expect(shown.order.goods.map((row) => row.documentNumber).sort()).toEqual(['5000000001', '5000000002']);
    expect(shown.order.invoices.map((row) => row.invoiceNumber).sort()).toEqual(['VI-DISP1', 'VI-DISP2']);
    expect(shown.order.release.status).toBe('NOT_REQUIRED');
    expect(shown.order.supplierName).toBe('Displayed supplier');
    expect(shown.order.changes.length).toBeGreaterThan(0);
    expect(await displayPurchaseOrder(other, ORDER)).toEqual({
      found: false,
      message: 'Purchase order does not exist or is not available to this user.',
    });
    await expect(searchPurchaseOrders(client, { exchangeRate: '1' })).rejects.toThrow(/exchange rate/i);
    const rules = await withTenant(client, (tx) => tx.execute(sql`
      select variant, account_type, period_from, period_to
        from posting_period_rule where client = ${client}
    `)) as unknown as Array<{ variant: string; account_type: string; period_from: number; period_to: number }>;
    const rule = rules[0];
    if (rule) {
      await withTenant(client, (tx) => tx.execute(sql`
        update posting_period_rule
           set period_from = 12, period_to = 12, changed_by = ${ACTOR}, changed_at = now()
         where client = ${client} and variant = ${rule.variant} and account_type = ${rule.account_type}
      `));
    }
    const closed = await displayPurchaseOrder(client, ORDER);
    expect(closed.found).toBe(true);
    if (rule) {
      await withTenant(client, (tx) => tx.execute(sql`
        update posting_period_rule
           set period_from = ${rule.period_from}, period_to = ${rule.period_to}, changed_by = ${ACTOR}, changed_at = now()
         where client = ${client} and variant = ${rule.variant} and account_type = ${rule.account_type}
      `));
    }
    expect(await counts(client)).toEqual(before);
    expect(assignedShare('100.00', '33.33')).toBe('33.33');
  });

  it('reads an alternative-unit receipt back in the unit the order line counts in', async () => {
    // Two writing shapes sit in the same table: the converted pair a receipt posts today, and
    // the pair a receipt posted while the base figure was copied from the entry. A purchase-order
    // screen has to read both as three boxes and as two boxes, and the stock figure has to keep
    // saying thirty-six pieces.
    const ALT = 'PO-DISP2';
    const ONE = 'PO-DISP3';   // a single open line, for the search list's own state CTE
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into unit_of_measure (code, name) values ('BOX', 'Box'), ('PAL', 'Pallet') on conflict do nothing
      `);
    });
    // The alternative unit is whichever code the material does not count in, so the fixture does
    // not depend on what the reference catalogue happens to hold.
    const [master] = await withTenant(client, (tx) => tx.execute(sql`
      select base_unit from material where client = ${client} and material_number = 'MAT-DISP'
    `)) as unknown as Array<{ base_unit: string }>;
    const alt = master.base_unit === 'BOX' ? 'PAL' : 'BOX';
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into material_uom_conversion (client, material_number, alternative_unit, base_unit,
                                            numerator, denominator, created_by)
        values (${client}, 'MAT-DISP', ${alt}, ${master.base_unit}, 12, 1, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_order
          (client, order_number, supplier_number, purchasing_org, purchasing_group, company_code, currency,
           document_date, created_by)
        select ${client}, ${ALT}, supplier_number, purchasing_org, purchasing_group, company_code, currency,
               '2026-10-24', ${ACTOR}
          from purchase_order where client = ${client} and order_number = ${ORDER}
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_order
          (client, order_number, supplier_number, purchasing_org, purchasing_group, company_code, currency,
           document_date, created_by)
        select ${client}, ${ONE}, supplier_number, purchasing_org, purchasing_group, company_code, currency,
               '2026-10-27', ${ACTOR}
          from purchase_order where client = ${client} and order_number = ${ORDER}
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_order_item
          (client, order_number, item_number, material_number, short_text, quantity, unit, net_price, price_unit,
           net_value, plant, created_by)
        values
          (${client}, ${ALT}, 10, 'MAT-DISP', 'Converted, full', 3, ${alt}, 40, 1, 120, '1000', ${ACTOR}),
          (${client}, ${ALT}, 20, 'MAT-DISP', 'Legacy, open', 3, ${alt}, 40, 1, 120, '1000', ${ACTOR}),
          (${client}, ${ALT}, 30, 'MAT-DISP', 'Converted, part', 3, ${alt}, 40, 1, 120, '1000', ${ACTOR}),
          (${client}, ${ALT}, 40, 'MAT-DISP', 'Reversed once', 3, ${alt}, 40, 1, 120, '1000', ${ACTOR}),
          (${client}, ${ONE}, 10, 'MAT-DISP', 'Open in the search list', 3, ${alt}, 40, 1, 120, '1000', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material_document
          (client, material_document_number, document_year, document_date, posting_date, status, reversal_of, created_by)
        values
          (${client}, '5000000106', 2026, '2026-10-27', '2026-10-27', 'POSTED', null, ${ACTOR}),
          (${client}, '5000000101', 2026, '2026-10-24', '2026-10-24', 'POSTED', null, ${ACTOR}),
          (${client}, '5000000102', 2026, '2026-10-24', '2026-10-24', 'POSTED', null, ${ACTOR}),
          (${client}, '5000000103', 2026, '2026-10-25', '2026-10-25', 'POSTED', null, ${ACTOR}),
          (${client}, '5000000104', 2026, '2026-10-26', '2026-10-26', 'POSTED', null, ${ACTOR}),
          (${client}, '5000000105', 2026, '2026-10-26', '2026-10-26', 'POSTED', '5000000104', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant,
          stock_type, entry_quantity, entry_unit, base_quantity, base_unit, unit_price, price_unit, value,
          purchase_order_number, purchase_order_item, created_by
        ) values
          (${client}, '5000000101', 1, 'GOODS_RECEIPT_PO', 'MAT-DISP', '1000', 'UNRESTRICTED', 3, ${alt}, 36, ${master.base_unit}, 40, 1, 120, ${ALT}, 10, ${ACTOR}),
          (${client}, '5000000102', 1, 'GOODS_RECEIPT_PO', 'MAT-DISP', '1000', 'UNRESTRICTED', 2, ${alt}, 2, ${alt}, 40, 1, 80, ${ALT}, 20, ${ACTOR}),
          (${client}, '5000000103', 1, 'GOODS_RECEIPT_PO', 'MAT-DISP', '1000', 'UNRESTRICTED', 1, ${alt}, 12, ${master.base_unit}, 40, 1, 40, ${ALT}, 30, ${ACTOR}),
          (${client}, '5000000104', 1, 'GOODS_RECEIPT_PO', 'MAT-DISP', '1000', 'UNRESTRICTED', 2, ${alt}, 24, ${master.base_unit}, 40, 1, 80, ${ALT}, 40, ${ACTOR}),
          (${client}, '5000000105', 1, 'RECEIPT_REVERSAL', 'MAT-DISP', '1000', 'UNRESTRICTED', 1, ${alt}, 12, ${master.base_unit}, 40, 1, 40, ${ALT}, 40, ${ACTOR}),
          (${client}, '5000000106', 1, 'GOODS_RECEIPT_PO', 'MAT-DISP', '1000', 'UNRESTRICTED', 1, ${alt}, 12, ${master.base_unit}, 40, 1, 40, ${ONE}, 10, ${ACTOR})
        on conflict do nothing
      `);
    });

    const before = await counts(client);
    try {
      const shown = await displayPurchaseOrder(client, ALT);
      expect(shown.found).toBe(true);
      if (!shown.found) return;
      const item = (number: number) => shown.order.items.find((row) => row.itemNumber === number);

      // The converted line says three boxes, not the thirty-six pieces the material is stocked in.
      expect(item(10)).toMatchObject({
        receivedQuantity: '3.000', state: 'DELIVERED', unit: alt,
        conversion: { sameUnit: false, baseUnit: master.base_unit, numerator: 12, denominator: 1 },
      });
      // The legacy line's base figure already counted boxes, so no factor is applied to it.
      expect(item(20)?.receivedQuantity).toBe('2.000');
      expect(item(20)?.state).toBe('PARTIALLY_DELIVERED');
      // A partial receipt of one box is one box of three ordered, not twelve pieces of three.
      expect(item(30)?.receivedQuantity).toBe('1.000');
      expect(item(30)?.state).toBe('PARTIALLY_DELIVERED');
      // A reversal copied its original's pair, so two received less one reversed is one.
      expect(item(40)?.receivedQuantity).toBe('1.000');
      expect(item(40)?.state).toBe('PARTIALLY_DELIVERED');
      // The history rows keep the material's base figure: only the order-facing reading changed.
      expect(shown.order.goods.find((row) => row.documentNumber === '5000000101')?.baseQuantity).toBe('36.000');
      expect(shown.order.goods.find((row) => row.documentNumber === '5000000101')?.entryQuantity).toBe('3.000');

      // The search list derives the state from its own aggregate over the same figure, so an
      // order whose only line is one box of three has to be found under "partially delivered" and
      // not as delivered. Twelve pieces against three ordered is what the old reading reported.
      const searched = await searchPurchaseOrders(client, { order: ONE, itemState: 'PARTIALLY_DELIVERED' });
      expect(searched.rows.map((row) => row.orderNumber)).toEqual([ONE]);
      const delivered = await searchPurchaseOrders(client, { order: ONE, itemState: 'DELIVERED' });
      expect(delivered.rows).toEqual([]);

      expect(await counts(client)).toEqual(before);
    } finally {
      await withTenant(client, async (tx) => {
        await tx.execute(sql`
          delete from material_document_line
           where client = ${client} and purchase_order_number in (${ALT}, ${ONE})
        `);
        await tx.execute(sql`
          delete from material_document
           where client = ${client} and material_document_number like '50000001%'
        `);
        await tx.execute(sql`delete from purchase_order_item where client = ${client} and order_number in (${ALT}, ${ONE})`);
        await tx.execute(sql`delete from purchase_order where client = ${client} and order_number in (${ALT}, ${ONE})`);
        await tx.execute(sql`delete from material_uom_conversion where client = ${client} and material_number = 'MAT-DISP'`);
      });
    }
  });

  // The order screen shows what was received, what remains to be delivered, and the state the line
  // is in — all three read off the same figure, so a return that only cancels a receipt has to pull
  // the received quantity down rather than push it up, and a document the reversal module really
  // reversed has to cancel itself rather than count twice.
  it('nets a return and a reversed receipt against what the order screen says was received', async () => {
    const SIGNS = 'PO-DISP4';
    await withTenant(client, async (tx) => {
      const [master] = await tx.execute(sql`
        select base_unit from material where client = ${client} and material_number = 'MAT-DISP'
      `) as unknown as Array<{ base_unit: string }>;
      const unit = master.base_unit;
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
          (${client}, 'RETURN_TO_VENDOR', 'Return delivery to vendor', 'ISSUE', 'PURCHASE_ORDER', ${ACTOR}),
          (${client}, 'RETURN_TO_VENDOR_REV', 'Reversal of return delivery to vendor', 'REVERSAL', 'MATERIAL_DOCUMENT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_order
          (client, order_number, supplier_number, purchasing_org, purchasing_group, company_code, currency,
           document_date, created_by)
        select ${client}, ${SIGNS}, supplier_number, purchasing_org, purchasing_group, company_code, currency,
               '2026-10-28', ${ACTOR}
          from purchase_order where client = ${client} and order_number = ${ORDER}
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_order_item
          (client, order_number, item_number, material_number, short_text, quantity, unit, net_price, price_unit,
           net_value, plant, created_by)
        values
          (${client}, ${SIGNS}, 10, 'MAT-DISP', 'Returned in part', 4, ${unit}, 10, 1, 40, '1000', ${ACTOR}),
          (${client}, ${SIGNS}, 20, 'MAT-DISP', 'Returned in full', 4, ${unit}, 10, 1, 40, '1000', ${ACTOR}),
          (${client}, ${SIGNS}, 30, 'MAT-DISP', 'Receipt reversed', 4, ${unit}, 10, 1, 40, '1000', ${ACTOR}),
          (${client}, ${SIGNS}, 40, 'MAT-DISP', 'Return reversed', 4, ${unit}, 10, 1, 40, '1000', ${ACTOR})
      `);
      // Four lines of one order, each ordering four pieces: a receipt with a part return, a receipt
      // given back in full, a receipt the reversal module cancelled, and a return that was itself
      // reversed. The reversed receipt's document carries REVERSED and its reversal stands next to it.
      await tx.execute(sql`
        insert into material_document
          (client, material_document_number, document_year, document_date, posting_date, status, reversal_of, created_by)
        values
          (${client}, '5000000111', 2026, '2026-10-28', '2026-10-28', 'POSTED', null, ${ACTOR}),
          (${client}, '5000000112', 2026, '2026-10-28', '2026-10-28', 'POSTED', null, ${ACTOR}),
          (${client}, '5000000113', 2026, '2026-10-29', '2026-10-29', 'POSTED', null, ${ACTOR}),
          (${client}, '5000000114', 2026, '2026-10-29', '2026-10-29', 'POSTED', null, ${ACTOR}),
          (${client}, '5000000115', 2026, '2026-10-30', '2026-10-30', 'POSTED', null, ${ACTOR}),
          (${client}, '5000000116', 2026, '2026-10-30', '2026-10-30', 'POSTED', null, ${ACTOR}),
          (${client}, '5000000117', 2026, '2026-10-31', '2026-10-31', 'POSTED', '5000000116', ${ACTOR}),
          (${client}, '5000000118', 2026, '2026-10-31', '2026-10-31', 'REVERSED', null, ${ACTOR}),
          (${client}, '5000000119', 2026, '2026-11-01', '2026-11-01', 'POSTED', '5000000118', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant,
          stock_type, entry_quantity, entry_unit, base_quantity, base_unit, unit_price, price_unit, value,
          purchase_order_number, purchase_order_item, line_direction, reversal_of_document, reversal_of_line, created_by
        ) values
          (${client}, '5000000111', 1, 'GOODS_RECEIPT_PO', 'MAT-DISP', '1000', 'UNRESTRICTED', 4, ${unit}, 4, ${unit}, 10, 1, 40, ${SIGNS}, 10, 'RECEIPT', null, null, ${ACTOR}),
          (${client}, '5000000112', 1, 'RETURN_TO_VENDOR', 'MAT-DISP', '1000', 'UNRESTRICTED', 1, ${unit}, 1, ${unit}, 10, 1, 10, ${SIGNS}, 10, 'ISSUE', null, null, ${ACTOR}),
          (${client}, '5000000113', 1, 'GOODS_RECEIPT_PO', 'MAT-DISP', '1000', 'UNRESTRICTED', 4, ${unit}, 4, ${unit}, 10, 1, 40, ${SIGNS}, 20, 'RECEIPT', null, null, ${ACTOR}),
          (${client}, '5000000114', 1, 'RETURN_TO_VENDOR', 'MAT-DISP', '1000', 'UNRESTRICTED', 4, ${unit}, 4, ${unit}, 10, 1, 40, ${SIGNS}, 20, 'ISSUE', null, null, ${ACTOR}),
          (${client}, '5000000115', 1, 'GOODS_RECEIPT_PO', 'MAT-DISP', '1000', 'UNRESTRICTED', 4, ${unit}, 4, ${unit}, 10, 1, 40, ${SIGNS}, 40, 'RECEIPT', null, null, ${ACTOR}),
          (${client}, '5000000116', 1, 'RETURN_TO_VENDOR', 'MAT-DISP', '1000', 'UNRESTRICTED', 2, ${unit}, 2, ${unit}, 10, 1, 20, ${SIGNS}, 40, 'ISSUE', null, null, ${ACTOR}),
          (${client}, '5000000117', 1, 'RETURN_TO_VENDOR_REV', 'MAT-DISP', '1000', 'UNRESTRICTED', 2, ${unit}, 2, ${unit}, 10, 1, 20, ${SIGNS}, 40, 'RECEIPT', '5000000116', 1, ${ACTOR}),
          (${client}, '5000000118', 1, 'GOODS_RECEIPT_PO', 'MAT-DISP', '1000', 'UNRESTRICTED', 4, ${unit}, 4, ${unit}, 10, 1, 40, ${SIGNS}, 30, 'RECEIPT', null, null, ${ACTOR}),
          (${client}, '5000000119', 1, 'RECEIPT_REVERSAL', 'MAT-DISP', '1000', 'UNRESTRICTED', 4, ${unit}, 4, ${unit}, 10, 1, 40, ${SIGNS}, 30, 'ISSUE', '5000000118', 1, ${ACTOR})
        on conflict do nothing
      `);
    });

    const before = await counts(client);
    try {
      const shown = await displayPurchaseOrder(client, SIGNS);
      expect(shown.found).toBe(true);
      if (!shown.found) return;
      const item = (number: number) => shown.order.items.find((row) => row.itemNumber === number);

      // Given one of four pieces back, the line received three and still waits for one.
      expect(item(10)).toMatchObject({
        receivedQuantity: '3.000', remainingToDeliver: '1.000', remainingToInvoice: '3.000',
        state: 'PARTIALLY_DELIVERED',
      });
      // Returned in full, nothing was received: the screen must not say eight received of four
      // ordered, four to be delivered minus four, and received in full.
      expect(item(20)).toMatchObject({
        receivedQuantity: '0.000', remainingToDeliver: '4.000', remainingToInvoice: '0.000', state: 'OPEN',
      });
      // A receipt reversed by a posted document cancels itself once, not twice: it leaves the line
      // empty rather than at minus four received with eight still to come.
      expect(item(30)).toMatchObject({
        receivedQuantity: '0.000', remainingToDeliver: '4.000', remainingToInvoice: '0.000', state: 'OPEN',
      });
      // The return on the last line was itself reversed, which puts the goods back where they were.
      expect(item(40)).toMatchObject({
        receivedQuantity: '4.000', remainingToDeliver: '0.000', remainingToInvoice: '4.000', state: 'DELIVERED',
      });

      expect(await counts(client)).toEqual(before);
    } finally {
      await withTenant(client, async (tx) => {
        await tx.execute(sql`
          delete from material_document_line where client = ${client} and purchase_order_number = ${SIGNS}
        `);
        await tx.execute(sql`
          delete from material_document
           where client = ${client} and material_document_number in
                 ('5000000111', '5000000112', '5000000113', '5000000114', '5000000115',
                  '5000000116', '5000000117', '5000000118', '5000000119')
        `);
        await tx.execute(sql`
          delete from purchase_order_item where client = ${client} and order_number = ${SIGNS}
        `);
        await tx.execute(sql`
          delete from purchase_order where client = ${client} and order_number = ${SIGNS}
        `);
      });
    }
  });

});

async function counts(client: string) {
  return withTenant(client, async (tx) => {
    const [orders] = await tx.execute(sql`select count(*)::int as n from purchase_order where client = ${client}`) as unknown as Array<{ n: number }>;
    const [documents] = await tx.execute(sql`select count(*)::int as n from material_document where client = ${client}`) as unknown as Array<{ n: number }>;
    const [invoices] = await tx.execute(sql`select count(*)::int as n from supplier_invoice where client = ${client}`) as unknown as Array<{ n: number }>;
    const [journals] = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
    const [changes] = await tx.execute(sql`select count(*)::int as n from change_document where client = ${client}`) as unknown as Array<{ n: number }>;
    return { orders: orders.n, documents: documents.n, invoices: invoices.n, journals: journals.n, changes: changes.n };
  });
}
