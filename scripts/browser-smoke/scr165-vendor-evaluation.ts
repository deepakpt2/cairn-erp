import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/purchasing/vendor-evaluation';
const ACTOR = 'browser.admin';
const SUPPLIER = 'V-EVAL';

/**
 * SCR-165 browser acceptance (T864) — a vendor evaluation is checked, and a
 * manual score is the only write.
 *
 * The production build is the screen under test. Automatic scores are not
 * stored. A missing score is not zero. Rollback and the tenant boundary stay
 * in the service test.
 */
export async function scr165VendorEvaluation(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-165: a vendor evaluation is checked, and only a manual score is stored');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, general_status, created_by)
      values (${client}, ${SUPPLIER}, 'ORGANIZATION', 'Evaluated supplier', 'CREATED', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, ${SUPPLIER}, 'SUPPLIER', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
      values (${client}, '1000', 'Central', '1000', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchasing_group (client, purchasing_group, name, created_by)
      values (${client}, '001', 'Buyer', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_purchasing_org
        (client, partner_number, role_code, purchasing_org, order_currency, purchasing_status, is_blocked, created_by)
      values (${client}, ${SUPPLIER}, 'SUPPLIER', '1000', 'KWD', 'MAINTAINED', false, ${ACTOR})
      on conflict (client, partner_number, purchasing_org) do update
        set purchasing_status = 'MAINTAINED', is_blocked = false
    `);
    await tx.execute(sql`
      insert into vendor_evaluation_criterion
        (client, criterion_code, description, method, evidence, score_min, score_max, weight, created_by)
      values
        (${client}, 'PRICE', 'Price', 'AUTOMATIC', 'PRICE', 0, 100, 25, ${ACTOR}),
        (${client}, 'DELIVERY', 'Delivery', 'AUTOMATIC', 'DELIVERY', 0, 100, 25, ${ACTOR}),
        (${client}, 'QUALITY', 'Quality', 'MANUAL', 'NONE', 0, 100, 25, ${ACTOR}),
        (${client}, 'SERVICE', 'Service', 'MANUAL', 'NONE', 0, 100, 25, ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'MAT-EVAL', 'Evaluated material', t.material_type, 'PC', ${ACTOR}
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_order
        (client, order_number, supplier_number, purchasing_org, purchasing_group, company_code, currency, document_date, created_by)
      values (${client}, 'PO-EVAL1', ${SUPPLIER}, '1000', '001', '1000', 'KWD', '2026-10-01', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_order_item
        (client, order_number, item_number, material_number, short_text, quantity, unit, net_price, price_unit, net_value, plant, created_by)
      values (${client}, 'PO-EVAL1', 10, 'MAT-EVAL', 'Bolts', 10, 'PC', 10, 1, 100, '1000', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_order_schedule_line
        (client, order_number, item_number, line_number, delivery_date, quantity, created_by)
      values (${client}, 'PO-EVAL1', 10, 1, '2026-10-10', 10, ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
      values (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt for purchase order', 'RECEIPT', 'PURCHASE_ORDER', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document
        (client, material_document_number, document_year, document_date, posting_date, status, created_by)
      values (${client}, '5000000165', 2026, '2026-10-10', '2026-10-10', 'POSTED', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document_line (
        client, material_document_number, line_number, movement_type, material_number, plant,
        stock_type, entry_quantity, entry_unit, base_quantity, base_unit, unit_price, price_unit, value,
        purchase_order_number, purchase_order_item, created_by
      ) values (
        ${client}, '5000000165', 1, 'GOODS_RECEIPT_PO', 'MAT-EVAL', '1000', 'UNRESTRICTED',
        4, 'PC', 4, 'PC', 10, 1, 40, 'PO-EVAL1', 10, ${ACTOR}
      )
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_invoice (
        client, invoice_number, fiscal_year, category, supplier_number, company_code, purchase_order_number,
        invoice_date, posting_date, supplier_reference, currency, gross_amount, status, created_by
      ) values
        (${client}, 'VI-EVAL1', 2026, 'INVOICE', ${SUPPLIER}, '1000', 'PO-EVAL1', '2026-10-15', '2026-10-15', 'REF-EVAL1', 'KWD', 40, 'POSTED', ${ACTOR}),
        (${client}, 'VI-EVAL2', 2026, 'INVOICE', ${SUPPLIER}, '1000', 'PO-EVAL1', '2026-10-16', '2026-10-16', 'REF-EVAL2', 'KWD', 80, 'CANCELLED', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_invoice_item (
        client, invoice_number, line_number, purchase_order_number, purchase_order_item, quantity, unit, net_amount, expected_amount, created_by
      ) values
        (${client}, 'VI-EVAL1', 1, 'PO-EVAL1', 10, 4, 'PC', 40, 40, ${ACTOR}),
        (${client}, 'VI-EVAL2', 1, 'PO-EVAL1', 10, 8, 'PC', 80, 10, ${ACTOR})
      on conflict do nothing
    `);
  });

  async function standing() {
    return withTenant(client, async (tx) => {
      const [assessments] = await tx.execute(sql`select count(*)::int as n from vendor_evaluation_assessment where client = ${client}`) as unknown as Array<{ n: number }>;
      const [changes] = await tx.execute(sql`select count(*)::int as n from change_document where client = ${client} and object_class = 'vendor_evaluation_assessment'`) as unknown as Array<{ n: number }>;
      const [journals] = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
      const [documents] = await tx.execute(sql`select count(*)::int as n from material_document where client = ${client}`) as unknown as Array<{ n: number }>;
      return { assessments: assessments.n, changes: changes.n, journals: journals.n, documents: documents.n };
    });
  }

  const before = await standing();
  await page.goto(`${base}${ROUTE}`);
  await page.locator('#command-input').fill('ME61');
  await page.locator('#command-input').press('Enter');
  await page.waitForURL(/\/purchasing\/vendor-evaluation$/, { waitUntil: 'commit' });
  await page.getByRole('heading', { level: 1, name: 'Maintain vendor evaluation', exact: true }).waitFor();
  await page.getByText('PROC.VENDOR.EVALUATE', { exact: true }).waitFor();
  assert.equal(await page.getByText('ME61', { exact: true }).count(), 0);
  assert.match(await page.locator('[data-ve-read-only]').innerText(), /writes nothing/);
  console.log('  ✓ ME61 opens the evaluation, and the alias is not on the page');

  const supplier = page.locator('input[name="supplier"]');
  await supplier.click();
  await supplier.pressSequentially(SUPPLIER, { delay: 20 });
  await page.waitForFunction((expected) => {
    const input = document.querySelector('input[name="supplier"]');
    return input instanceof HTMLInputElement && input.value === expected;
  }, SUPPLIER);
  await page.waitForFunction(() => {
    const select = document.querySelector('select[name="purchasingOrg"]');
    return select instanceof HTMLSelectElement && [...select.options].some((option) => option.value === '1000');
  });
  await page.locator('select[name="purchasingOrg"]').selectOption('1000');
  await page.locator('input[name="periodFrom"]').fill('2026-10-01');
  await page.locator('input[name="periodTo"]').fill('2026-10-31');
  await page.locator('[data-ve-check]').click();
  await page.locator('[data-ve-score="PRICE"]').waitFor();
  assert.match(await page.locator('[data-ve-score="PRICE"]').innerText(), /100\.00/);
  assert.match(await page.locator('[data-ve-score="DELIVERY"]').innerText(), /100\.00/);
  assert.match(await page.locator('[data-ve-score="QUALITY"]').innerText(), /—/);
  assert.match(await page.locator('[data-ve-overall]').innerText(), /—/);
  assert.match(await page.locator('[data-ve-nothing-written]').innerText(), /Nothing was written/);
  assert.match(await page.locator('[data-ve-no-period]').innerText(), /closed accounting period/);
  assert.equal(await page.locator('[data-ve-save="PRICE"]').count(), 0);
  assert.deepEqual(await standing(), before);
  console.log('  ✓ the check shows the calculated scores, and nothing was written');

  await page.locator('#ve-score-QUALITY').fill('80');
  await page.locator('#ve-reason-QUALITY').fill('Accepted the lot');
  await page.locator('[data-ve-save-button="QUALITY"]').click();
  await page.locator('[data-ve-save-result="QUALITY"]').waitFor();
  assert.match(await page.locator('[data-ve-save-result="QUALITY"]').innerText(), /80\.00/);
  const saved = await standing();
  assert.equal(saved.assessments, before.assessments + 1);
  assert.equal(saved.changes, before.changes + 1);
  assert.equal(saved.journals, before.journals);
  assert.equal(saved.documents, before.documents);
  console.log('  ✓ the manual score stands, and nothing was posted');

  await page.goto(`${base}${ROUTE}?supplier=${SUPPLIER}&purchasingOrg=1000&periodFrom=2026-10-01&periodTo=2026-10-31&companyCode=1000`);
  await page.locator('[data-ve-refused]').waitFor();
  assert.match(await page.locator('[data-ve-refused]').innerText(), /company-code/i);
  assert.equal(await page.locator('[data-ve-evaluation]').count(), 0);
  assert.deepEqual(await standing(), saved);
  console.log('  ✓ a company code is refused, and nothing was written');
}
