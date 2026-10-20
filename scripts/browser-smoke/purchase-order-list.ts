import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/purchasing/purchase-order-list';

/**
 * SCR-124 browser acceptance: ME2L purchase order list display.
 *
 * The journey: three orders stand with posted history behind them — one fully
 * delivered and invoiced, one partially delivered, one delivered but not
 * invoiced. The list shows the derived quantities and statuses, the perspective
 * changes the primary sort, the scope of selection narrows to the work still
 * outstanding, a vendor that does not stand refuses by name, and a row drills
 * down to the purchase order display.
 */
export async function purchaseOrderList(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-124: list purchase orders, derive delivery and invoice status, drill to the order');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into business_partner (client, partner_number, name, created_by) values
        (${client}, 'V70000', 'Vendor Seven', 'browser.admin'),
        (${client}, 'V80000', 'Vendor Eight', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchasing_org (client, purchasing_org, name, created_by) values
        (${client}, 'O700', 'Org Seven', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchasing_group (client, purchasing_group, name, created_by) values
        (${client}, 'G07', 'Group Seven', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into plant (client, plant, name, country, created_by) values
        (${client}, 'P700', 'Plant Seven', 'KW', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_order (
        client, order_number, document_type, supplier_number, purchasing_org, purchasing_group,
        company_code, currency, document_date, release_status, created_by
      ) values
        (${client}, '4700000001', 'STANDARD', 'V70000', 'O700', 'G07', '1000', 'USD', '2026-02-01', 'RELEASED', 'browser.admin'),
        (${client}, '4700000002', 'STANDARD', 'V80000', 'O700', 'G07', '1000', 'USD', '2026-02-05', 'RELEASED', 'browser.admin'),
        (${client}, '4700000003', 'STANDARD', 'V70000', 'O700', 'G07', '1000', 'USD', '2026-02-10', 'RELEASED', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_order_item (
        client, order_number, item_number, item_category, short_text, quantity, unit,
        net_price, price_unit, net_value, plant, marked_for_deletion, created_by
      ) values
        (${client}, '4700000001', 10, 'STANDARD', 'Completed order', 10, 'PC', 10, 1, 100, 'P700', false, 'browser.admin'),
        (${client}, '4700000002', 10, 'STANDARD', 'Partial order', 10, 'PC', 10, 1, 100, 'P700', false, 'browser.admin'),
        (${client}, '4700000003', 10, 'STANDARD', 'Awaiting invoice', 5, 'PC', 10, 1, 50, 'P700', false, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
        (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt for purchase order', 'RECEIPT', 'PURCHASE_ORDER', 'browser.admin'),
        (${client}, 'RECEIPT_REVERSAL', 'Reversal of a goods receipt', 'REVERSAL', 'MATERIAL_DOCUMENT', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, status, created_by) values
        (${client}, '5700000001', 2026, '2026-02-02', '2026-02-02', 'POSTED', 'browser.admin'),
        (${client}, '5700000002', 2026, '2026-02-06', '2026-02-06', 'POSTED', 'browser.admin'),
        (${client}, '5700000003', 2026, '2026-02-11', '2026-02-11', 'POSTED', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document_line (
        client, material_document_number, line_number, movement_type, material_number, plant,
        stock_type, entry_quantity, entry_unit, base_quantity, base_unit, unit_price, price_unit, value,
        purchase_order_number, purchase_order_item, created_by
      ) values
        (${client}, '5700000001', 1, 'GOODS_RECEIPT_PO', 'ME2L-MAT', 'P700', 'UNRESTRICTED', 10, 'PC', 10, 'PC', 10, 1, 100, '4700000001', 10, 'browser.admin'),
        (${client}, '5700000002', 1, 'GOODS_RECEIPT_PO', 'ME2L-MAT', 'P700', 'UNRESTRICTED', 4, 'PC', 4, 'PC', 10, 1, 40, '4700000002', 10, 'browser.admin'),
        (${client}, '5700000003', 1, 'GOODS_RECEIPT_PO', 'ME2L-MAT', 'P700', 'UNRESTRICTED', 5, 'PC', 5, 'PC', 10, 1, 50, '4700000003', 10, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'ME2L-MAT', 'List material', t.material_type, 'PC', 'browser.admin'
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_invoice (
        client, invoice_number, fiscal_year, category, supplier_number, company_code, purchase_order_number,
        invoice_date, posting_date, supplier_reference, currency, gross_amount, tax_amount, status, created_by
      ) values (${client}, 'SI7000001', 2026, 'INVOICE', 'V70000', '1000', '4700000001',
        '2026-02-03', '2026-02-03', 'REF-700', 'USD', 100, 0, 'POSTED', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_invoice_item (
        client, invoice_number, line_number, purchase_order_number, purchase_order_item, quantity, unit,
        net_amount, expected_amount, variance_amount, tax_amount, created_by
      ) values (${client}, 'SI7000001', 1, '4700000001', 10, 10, 'PC', 100, 100, 0, 0, 'browser.admin')
      on conflict do nothing
    `);
  });

  // ── The list under the default perspective ────────────────────────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { name: /Purchase Orders: List Display/i }).waitFor();
  await page.getByText('4700000001').waitFor();
  const completed = await page.locator('tr', { hasText: '4700000001' }).first().innerText();
  assert.equal(completed.includes('COMPLETED'), true, `completed derived: ${completed}`);
  assert.equal(completed.includes('Vendor Seven'), true, 'vendor name shown');
  const partial = await page.locator('tr', { hasText: '4700000002' }).first().innerText();
  assert.equal(partial.includes('PARTIALLY_DELIVERED'), true, `partial derived: ${partial}`);
  const awaiting = await page.locator('tr', { hasText: '4700000003' }).first().innerText();
  assert.equal(awaiting.includes('DELIVERED'), true, `delivered not invoiced: ${awaiting}`);
  console.log('  ✓ the list derives completed, partial and delivered-not-invoiced from posted history');

  // ── The scope of selection ────────────────────────────────────────────────
  await page.locator('select[name="scope"]').selectOption('STILL_TO_BE_DELIVERED');
  await page.getByRole('form', { name: 'Selection' }).getByRole('button', { name: 'Execute' }).click();
  await page.getByText('4700000002').waitFor();
  assert.equal(await page.getByText('4700000001').count(), 0, 'completed order leaves the outstanding scope');
  assert.equal(await page.getByText('4700000003').count(), 0, 'delivered order leaves the outstanding scope');
  console.log('  ✓ still-to-be-delivered narrows to the outstanding commitment');

  // ── The perspective changes the primary sort ──────────────────────────────
  await page.locator('select[name="scope"]').selectOption('ALL');
  await page.locator('select[name="perspective"]').selectOption('ORDER');
  await page.getByRole('form', { name: 'Selection' }).getByRole('button', { name: 'Execute' }).click();
  await page.getByText('4700000001').waitFor();
  const ordered = await page.locator('tbody tr[data-order]').evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('data-order')));
  assert.deepEqual(ordered, ['4700000001', '4700000002', '4700000003']);
  console.log('  ✓ the by-order perspective sorts by document number');

  // ── A vendor that does not stand refuses by name ──────────────────────────
  await page.goto(`${base}${ROUTE}?vendorFrom=V99999`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const refusal = page.locator('div[role="alert"]').filter({ hasText: 'vendor V99999' });
  await refusal.waitFor();
  console.log('  ✓ an unknown vendor refuses by name instead of answering an empty list');

  // ── Drill-down to the order display ───────────────────────────────────────
  await page.goto(`${base}${ROUTE}?orderFrom=4700000001&orderTo=4700000001`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.locator('tr', { hasText: '4700000001' }).first().getByRole('link').first().click();
  await page.waitForURL(/\/purchasing\/orders\?order=4700000001/);
  await page.waitForLoadState('networkidle');
  await page.getByText('4700000001').first().waitFor();
  console.log('  ✓ the row drills down to the purchase order display');
}
