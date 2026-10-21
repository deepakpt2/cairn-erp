import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const MBRL = '/inventory/return-delivery';
const MIGO = '/inventory/migo';

const PLANT = 'QR01';
const SLOC = 'SR01';

/**
 * SCR-145 browser acceptance (T844) — a return is not a cancellation.
 *
 * A goods receipt posted through MIGO, then read on MBRL: forty received, forty returnable. Fifteen
 * go back, and the receipt screen itself reports twenty-five received — the receipt document still
 * standing in full. The remainder goes back too, and a third attempt is refused quoting what is
 * left. The return is then reversed from MIGO's own MBST flow and both the stock and the received
 * quantity come back.
 */
export async function scr145ReturnDelivery(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-145: return part of a PO receipt, read the order down, return the rest, refuse the third, reverse');

  const company = await withTenant(client, async (tx) => {
    const companies = await tx.execute(sql`
      select company_code, currency from company_code where client = ${client} order by company_code limit 1
    `) as unknown as Array<{ company_code: string; currency: string }>;
    if (!companies[0]) throw new Error('the browser tenant carries no company code');
    const code = companies[0].company_code;
    const currency = companies[0].currency;

    await tx.execute(sql`
      insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
      values (${client}, '1000', 'Return purchasing org', ${code}, 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by)
      values (${client}, 'V50000', 'ORGANIZATION', 'Return Supplier', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, 'V50000', 'SUPPLIER', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
      values (${client}, 'V50000', 'SUPPLIER', '1000', ${currency}, 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'MRET-VEND', 'Vendor-returned plate', t.material_type, 'PC', 'browser.admin'
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, ${PLANT}, 'Return plant', ${code}, 'KW', 'browser.admin')
      on conflict (client, plant) do update set company_code = excluded.company_code
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, overdelivery_tolerance, created_by)
      values (${client}, 'MRET-VEND', ${PLANT}, 0, 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
      values (${client}, ${PLANT}, ${SLOC}, 'Return store', true, false, 'browser.admin')
      on conflict (client, plant, storage_location) do update set is_active = true
    `);
    await tx.execute(sql`
      insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                      standard_price, moving_average_price, price_unit, currency,
                                      total_stock_quantity, stock_value, created_by)
      values (${client}, 'MRET-VEND', ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, ${currency}, 0, 0, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      select ${client}, c.chart_of_accounts, v.e, v.vc, '', v.a, 'browser.admin'
      from (select chart_of_accounts from chart_of_accounts where client = ${client} order by chart_of_accounts limit 1) c
      cross join (values ('INVENTORY', 'RAW_INVENTORY', '120000'),
                         ('GR_IR_CLEARING', '', '210000'),
                         ('PRICE_DIFFERENCE', 'RAW_INVENTORY', '300000')) as v(e, vc, a)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                           previous_fiscal_year, previous_period, allow_backposting, created_by)
      values (${client}, ${code}, 2026, 10, 2026, 9, true, 'browser.admin')
      on conflict (client, company_code) do update set current_fiscal_year = 2026, current_period = 10
    `);
    return code;
  });

  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: 'browser.admin' });
    await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: '49', numberLength: 10, createdBy: 'browser.admin' });
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: company, subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'browser.admin',
    });
  });

  // ── 1 · a purchase order and its receipt, through the purchasing and MIGO screens ────
  const { createOrder } = await import('../../src/modules/purchasing/orders');
  const order = await createOrder({
    client, changedBy: 'browser.admin',
    supplierNumber: 'V50000', purchasingOrg: '1000', purchasingGroup: '001', companyCode: company, currency: '',
    items: [{
      materialNumber: 'MRET-VEND', shortText: 'Vendor-returned plate', quantity: 40, unit: 'PC',
      netPrice: 100, priceUnit: 1, taxCode: '', plant: PLANT, storageLocation: SLOC,
      markedForDeletion: false,
      scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 40 }],
      assignments: [] as never[],
    }],
  });

  // The receipt is posted on the goods receipt screen, against the order, as a user would.
  await page.goto(
    `${base}/inventory/goods-receipt?action=GOODS_RECEIPT&order=${encodeURIComponent(order.orderNumber)}`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.getByRole('heading', { level: 2, name: `Goods receipt for order ${order.orderNumber}`, exact: true }).waitFor();
  await page.fill('input[name="qty-10"]', '40');
  await page.fill('input[name="sloc-10"]', SLOC);
  await page.fill('input[name="postingDate"]', '2026-10-20');
  await page.fill('input[name="documentDate"]', '2026-10-20');
  await page.getByRole('button', { name: 'Post goods receipt', exact: true }).click();
  await page.locator('p[role="status"]').filter({ hasText: 'Goods receipt posted as material document' }).waitFor();

  const receipt = await withTenant(client, (tx) => tx.execute(sql`
    select material_document_number, document_year from material_document
     where client = ${client} and status = 'POSTED' and journal_document_number is not null
     order by material_document_number desc limit 1
  `)) as unknown as Array<{ material_document_number: string; document_year: number }>;
  assert.ok(receipt[0], 'a goods receipt was posted');
  const receiptNumber = receipt[0].material_document_number;

  // ── 2 · MBRL reads the receipt and states what may still be returned ────────────────
  await page.goto(`${base}${MBRL}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Return delivery to a vendor', exact: true }).waitFor();
  await page.fill('input[name="documentNumber"]', receiptNumber);
  await page.fill('input[name="documentYear"]', String(receipt[0].document_year));
  await page.getByRole('button', { name: 'Read the document', exact: true }).click();

  await page.locator('[data-reference-document]').waitFor();
  assert.equal(await page.locator('[data-reference-document]').innerText(), receiptNumber);
  assert.equal(await page.locator('[data-remaining="1"]').innerText(), '40.000', 'all forty are returnable');

  // ── 3 · fifteen go back, and the receipt still stands while received falls ──────────
  await page.fill('input[name="quantity-1"]', '15');
  await page.fill('input[name="postingDate"]', '2026-10-20');
  await page.fill('input[name="documentDate"]', '2026-10-20');
  await page.fill('input[name="externalReference"]', 'RMA-77120');
  await page.getByRole('button', { name: 'Post the return', exact: true }).click();
  await page.locator('[data-return-document]').waitFor();

  const returned = await page.locator('[data-return-document]').innerText();
  assert.notEqual(returned, receiptNumber, 'the return is its own document');
  assert.equal(
    await page.locator('[data-returns-against]').innerText(), receiptNumber,
    'and it names the receipt it returns against',
  );

  const state = await withTenant(client, (tx) => tx.execute(sql`
    select
      (select status from material_document where client = ${client}
        and material_document_number = ${receiptNumber}) as receipt_status,
      (select count(*)::int from material_document_line where client = ${client}
        and return_of_document = ${receiptNumber}) as return_lines,
      (select quantity::text from stock_quantity where client = ${client}
        and material_number = 'MRET-VEND' and plant = ${PLANT} and storage_location = ${SLOC}) as stock,
      (select reversal_of from material_document where client = ${client}
        and material_document_number = ${returned}) as return_is_reversal
  `)) as unknown as Array<{ receipt_status: string; return_lines: number; stock: string; return_is_reversal: string | null }>;
  assert.equal(state[0].receipt_status, 'POSTED', 'the receipt was never cancelled');
  assert.equal(state[0].return_lines, 1, 'the return points at the receipt');
  assert.equal(Number(state[0].stock), 25, 'fifteen pieces left the store');
  assert.equal(state[0].return_is_reversal, null, 'a return is not a reversal');

  // The receipt screen itself now reports twenty-five received on that order item — the number a
  // buyer reads, not a figure this script recomputed.
  const receivedOnScreen = async (): Promise<string> => {
    await page.goto(
      `${base}/inventory/goods-receipt?action=GOODS_RECEIPT&order=${encodeURIComponent(order.orderNumber)}`,
      { waitUntil: 'domcontentloaded' },
    );
    await page.getByRole('heading', { level: 2, name: `Goods receipt for order ${order.orderNumber}`, exact: true }).waitFor();
    const cells = await page.locator('table tbody tr').first().locator('td').allInnerTexts();
    return cells[4].trim();
  };
  assert.equal(Number(await receivedOnScreen()), 25, 'the order shows twenty-five received');

  // ── 4 · the remainder goes back; a third attempt is refused quoting what is left ─────
  await page.goto(`${base}${MBRL}`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="documentNumber"]', receiptNumber);
  await page.getByRole('button', { name: 'Read the document', exact: true }).click();
  await page.locator('[data-remaining="1"]').waitFor();
  assert.equal(await page.locator('[data-remaining="1"]').innerText(), '25.000');
  await page.fill('input[name="quantity-1"]', '25');
  await page.fill('input[name="postingDate"]', '2026-10-20');
  await page.fill('input[name="documentDate"]', '2026-10-20');
  await page.getByRole('button', { name: 'Post the return', exact: true }).click();
  await page.locator('[data-return-document]').waitFor();
  const secondReturnNumber = await page.locator('[data-return-document]').innerText();

  await page.goto(`${base}${MBRL}`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="documentNumber"]', receiptNumber);
  await page.getByRole('button', { name: 'Read the document', exact: true }).click();
  await page.locator('[data-item="1"][data-eligible="false"]').waitFor();
  const refusal = await page.locator('[data-refusal="1"]').innerText();
  assert.match(refusal, /already been returned in full/);
  assert.equal(
    await page.locator('input[name="quantity-1"]').isDisabled(), true,
    'a fully returned line offers no quantity field',
  );

  // ── 5 · reversing a return puts both the stock and the received quantity back ───────
  // Two returns stand (15 and 25). The second is reversed first: the goods came back, so the
  // received position must be 25 again — not 40, and not 15.
  assert.notEqual(secondReturnNumber, returned, 'the second return is its own document, not a replay of the first');

  const reverseViaMigo = async (documentNumber: string) => {
    await page.goto(`${base}${MIGO}`, { waitUntil: 'domcontentloaded' });
    await page.selectOption('select[name="migoAction"]', 'A03');
    await page.selectOption('select[name="migoReference"]', 'R05');
    await page.fill('input[name="materialDocumentNumber"]', documentNumber);
    await page.fill('input[name="postingDate"]', '2026-10-20');
    await page.fill('input[name="documentDate"]', '2026-10-20');
    await page.getByRole('button', { name: 'Post the cancellation', exact: true }).click();
    await page.locator('p[role="status"]').filter({ hasText: 'Reversed: material document' }).waitFor();
  };

  await reverseViaMigo(secondReturnNumber);

  const halfway = await withTenant(client, (tx) => tx.execute(sql`
    select (select quantity::text from stock_quantity where client = ${client}
              and material_number = 'MRET-VEND' and plant = ${PLANT} and storage_location = ${SLOC}) as stock
  `)) as unknown as Array<{ stock: string }>;
  // 40 received, 15 returned, 25 returned, the 25 reversed: fifteen have net gone back, so the
  // store holds 25 and the order shows 25 received. The two figures agree because the return
  // that still stands moved exactly what the received position lost.
  assert.equal(Number(halfway[0].stock), 25, 'the twenty-five pieces came back');
  assert.equal(Number(await receivedOnScreen()), 25, 'and the order shows twenty-five received');

  await reverseViaMigo(returned);

  const after = await withTenant(client, (tx) => tx.execute(sql`
    select
      (select quantity::text from stock_quantity where client = ${client}
        and material_number = 'MRET-VEND' and plant = ${PLANT} and storage_location = ${SLOC}) as stock,
      (select status from material_document where client = ${client}
        and material_document_number = ${returned}) as return_status
  `)) as unknown as Array<{ stock: string; return_status: string }>;
  assert.equal(after[0].return_status, 'REVERSED', 'the return is reversed, never deleted');
  assert.equal(Number(after[0].stock), 40, 'the fifteen pieces came back too');
  assert.equal(Number(await receivedOnScreen()), 40, 'and the order shows forty received again');

  // The receipt itself was never touched: reversing a return does not reverse what it returned
  // against, and the original document still stands as posted.
  const original = await withTenant(client, (tx) => tx.execute(sql`
    select status, journal_document_number from material_document
     where client = ${client} and material_document_number = ${receiptNumber}
  `)) as unknown as Array<{ status: string; journal_document_number: string | null }>;
  assert.equal(original[0].status, 'POSTED', 'the receipt still stands');
  assert.ok(original[0].journal_document_number, 'and its journal still stands');

  console.log('SCR-145: 40 received, 15 returned with the receipt still standing at 25 received, 25 returned to zero, a third attempt refused, and the reversal restored both stock and received quantity');
}
