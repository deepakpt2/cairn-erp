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
