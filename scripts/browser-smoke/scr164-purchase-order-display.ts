import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/purchasing/purchase-order-display';
const ACTOR = 'browser.admin';
const ORDER = 'PO-DISP1';

/**
 * SCR-164 browser acceptance (T863) — a purchase order is read, and nothing is written.
 *
 * The production build is the screen under test. The purchase order number is
 * the key. A reversal stays visible. Rollback and the tenant boundary stay in
 * the service test.
 */
export async function scr164PurchaseOrderDisplay(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-164: a purchase order is read, and nothing is written');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, general_status, created_by)
      values (${client}, 'V-DISP', 'ORGANIZATION', 'Displayed supplier', 'CREATED', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, 'V-DISP', 'SUPPLIER', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into purchasing_group (client, purchasing_group, name, purchasing_org, created_by)
      values (${client}, '001', 'Buyer', '1000', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'MAT-DISP', 'Displayed material', t.material_type, 'PC', ${ACTOR}
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
    `);
    await tx.execute(sql`
      insert into purchase_order
        (client, order_number, supplier_number, purchasing_org, purchasing_group, company_code, currency, document_date, created_by)
      values (${client}, ${ORDER}, 'V-DISP', '1000', '001', '1000', 'KWD', '2026-10-18', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into purchase_order_item
        (client, order_number, item_number, material_number, short_text, quantity, unit, net_price, price_unit, net_value, plant, created_by)
      values (${client}, ${ORDER}, 10, 'MAT-DISP', 'Bolts', 10, 'PC', 15, 1, 100, '1000', ${ACTOR})
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
        (${client}, '5000000001', 1, 'GOODS_RECEIPT_PO', 'MAT-DISP', '1000', 'UNRESTRICTED', 4, 'PC', 4, 'PC', 15, 1, 60, ${ORDER}, 10, ${ACTOR}),
        (${client}, '5000000002', 1, 'RECEIPT_REVERSAL', 'MAT-DISP', '1000', 'UNRESTRICTED', 1, 'PC', 1, 'PC', 15, 1, 15, ${ORDER}, 10, ${ACTOR})
    `);
    await tx.execute(sql`
      insert into supplier_invoice (
        client, invoice_number, fiscal_year, category, supplier_number, company_code, purchase_order_number,
        invoice_date, posting_date, supplier_reference, currency, gross_amount, status, created_by
      ) values
        (${client}, 'VI-DISP1', 2026, 'INVOICE', 'V-DISP', '1000', ${ORDER}, '2026-10-21', '2026-10-21', 'REF-DISP1', 'KWD', 30, 'POSTED', ${ACTOR}),
        (${client}, 'VI-DISP2', 2026, 'INVOICE', 'V-DISP', '1000', ${ORDER}, '2026-10-21', '2026-10-21', 'REF-DISP2', 'KWD', 90, 'CANCELLED', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into supplier_invoice_item (
        client, invoice_number, line_number, purchase_order_number, purchase_order_item, quantity, unit, net_amount, expected_amount, created_by
      ) values
        (${client}, 'VI-DISP1', 1, ${ORDER}, 10, 2, 'PC', 30, 30, ${ACTOR}),
        (${client}, 'VI-DISP2', 1, ${ORDER}, 10, 6, 'PC', 90, 90, ${ACTOR})
    `);
  });

  async function standing() {
    return withTenant(client, async (tx) => {
      const [orders] = await tx.execute(sql`select count(*)::int as n from purchase_order where client = ${client}`) as unknown as Array<{ n: number }>;
      const [items] = await tx.execute(sql`select count(*)::int as n from purchase_order_item where client = ${client}`) as unknown as Array<{ n: number }>;
      const [documents] = await tx.execute(sql`select count(*)::int as n from material_document where client = ${client}`) as unknown as Array<{ n: number }>;
      const [invoices] = await tx.execute(sql`select count(*)::int as n from supplier_invoice where client = ${client}`) as unknown as Array<{ n: number }>;
      const [journals] = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
      const [changes] = await tx.execute(sql`select count(*)::int as n from change_document where client = ${client}`) as unknown as Array<{ n: number }>;
      return { orders: orders.n, items: items.n, documents: documents.n, invoices: invoices.n, journals: journals.n, changes: changes.n };
    });
  }

  const before = await standing();
  await page.goto(`${base}${ROUTE}`);
  await page.locator('#command-input').fill('ME23N');
  await page.locator('#command-input').press('Enter');
  await page.waitForURL(/\/purchasing\/purchase-order-display$/, { waitUntil: 'commit' });
  await page.getByRole('heading', { level: 1, name: 'Display purchase order', exact: true }).waitFor();
  await page.getByText('PROC.PO.DISPLAY', { exact: true }).waitFor();
  assert.equal(await page.getByText('ME23N', { exact: true }).count(), 0);
  assert.match(await page.locator('[data-po-read-only]').innerText(), /writes nothing/);
  console.log('  ✓ ME23N opens the display, and the alias is not on the page');

  const orderField = page.locator('input[name="order"]');
  await orderField.click();
  await orderField.pressSequentially(ORDER, { delay: 20 });
  await page.waitForFunction((expected) => {
    const input = document.querySelector('input[name="order"]');
    return input instanceof HTMLInputElement && input.value === expected;
  }, ORDER);
  await orderField.press('Enter');
  await page.locator(`[data-po-item="10"]`).waitFor();
  assert.match(await page.locator('[data-po-net="10"]').innerText(), /100/);
  assert.equal(await page.locator('[data-po-schedule="10-1"]').count(), 1);
  assert.equal(await page.locator('[data-po-schedule="10-2"]').count(), 1);
  assert.equal(await page.locator('[data-po-assignment="10-1"]').count(), 1);
  assert.equal(await page.locator('[data-po-assignment="10-2"]').count(), 1);
  await page.locator('[data-po-goods="5000000001"]').waitFor();
  await page.locator('[data-po-goods="5000000002"]').waitFor();
  await page.locator('[data-po-invoice="VI-DISP2"]').waitFor();
  assert.match(await page.locator('[data-po-nothing-written]').innerText(), /Nothing was written/);
  assert.match(await page.locator('[data-po-received="10"]').innerText(), /3/);
  assert.match(await page.locator('[data-po-invoiced="10"]').innerText(), /2/);
  assert.deepEqual(await standing(), before);
  console.log('  ✓ the order is shown, the reversal stays, and nothing was written');

  await page.goto(`${base}${ROUTE}?order=${ORDER}&exchangeRate=1`);
  await page.locator('[data-po-refused]').waitFor();
  assert.match(await page.locator('[data-po-refused]').innerText(), /exchange rate/i);
  assert.equal(await page.locator('[data-po-display]').count(), 0);
  assert.deepEqual(await standing(), before);
  console.log('  ✓ an exchange rate is refused, and nothing was written');
}
