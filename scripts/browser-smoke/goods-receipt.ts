import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { initializeMaterialPeriodControl } from '../../src/modules/inventory/material-period-control';
import { defineRange } from '../../src/platform/numbering';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ORDERS = '/purchasing/orders';
const RECEIPT = '/inventory/goods-receipt';

/**
 * SCR-061 browser acceptance: goods receipt.
 *
 * The journey: fixtures standing, an order created through the grid,
 * the receipt posted against it from the movement screen, and the
 * reversal correcting it — the database remembering document, stock,
 * valuation and journal.
 */
export async function goodsReceiptMigo(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-061: verify order creation, the goods receipt posting, the reversal, and database evidence');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
      values (${client}, '1000', 'Browser purchasing organization', '1000', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by)
      values (${client}, 'V10000', 'ORGANIZATION', 'Browser Supplier', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, 'V10000', 'SUPPLIER', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
      values (${client}, 'V10000', 'SUPPLIER', '1000', 'USD', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      values (${client}, 'MAT-10001', 'Industrial steel plate', 'RAW', 'PC', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, overdelivery_tolerance, created_by)
      values (${client}, 'MAT-10001', '1000', 0, 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_valuation (
        client, material_number, valuation_area, valuation_class, price_control,
        standard_price, moving_average_price, price_unit, currency, created_by
      )
      values (${client}, 'MAT-10001', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values (${client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', 'BROWSER_SMOKE'),
             (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
  });
  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'BROWSER_SMOKE',
    });
  });
  await initializeMaterialPeriodControl({
    client, changedBy: 'BROWSER_SMOKE', companyCode: '1000',
    fiscalYear: 2026, period: 10, reason: 'Browser acceptance run',
  });

  // Create the order through the standing grid.
  await page.goto(`${base}${ORDERS}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Create Purchase Order', exact: true }).waitFor();
  const create = page.locator('section[aria-labelledby="po-create"]');
  await create.locator('label').filter({ hasText: 'Supplier' }).locator('input').fill('V10000');
  const headerSelects = create.locator('form > div select');
  await headerSelects.nth(0).selectOption('1000');
  await headerSelects.nth(1).evaluate((el) => {
    const select = el as unknown as { options: ArrayLike<{ value: string }>; value: string; dispatchEvent: (e: unknown) => void };
    select.value = select.options[1].value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await headerSelects.nth(2).selectOption('1000');
  const row = create.locator('tbody tr').first();
  const inputs = row.locator('input');
  await inputs.nth(0).fill('MAT-10001');
  await inputs.nth(2).fill('5');
  await inputs.nth(3).fill('PC');
  await inputs.nth(4).fill('100');
  await row.locator('select').nth(0).selectOption('1000');
  const panel = create.locator('fieldset').first();
  await panel.locator('input[type="date"]').fill('2026-11-15');
  await panel.locator('input[placeholder="Scheduled quantity"]').fill('5');
  await create.getByRole('button', { name: 'Save purchase order', exact: true }).click();
  const confirmation = create.getByText(/Purchase order POF-\d+ created\./);
  await confirmation.waitFor();
  const orderNumber = (await confirmation.textContent())?.match(/POF-\d+/)?.[0] ?? '';
  assert.ok(orderNumber, 'the created order number is shown');
  console.log(`  ✓ purchase order ${orderNumber} created through the grid`);

  await page.goto(`${base}${RECEIPT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Post Goods Receipt', exact: true }).waitFor();
  const operation = page.locator('section[aria-labelledby="gr-operation"]');
  await operation.locator('input[name="order"]').fill(orderNumber);
  await operation.getByRole('button', { name: 'Load reference', exact: true }).click();
  await page.waitForLoadState('networkidle');

  const items = page.locator('section[aria-labelledby="gr-items"]');
  await items.getByText(`Goods receipt for order ${orderNumber}`).waitFor();
  await items.getByRole('button', { name: 'Post goods receipt', exact: true }).click();
  const posted = items.getByText(/Goods receipt posted as material document \S+\./);
  await posted.waitFor();
  const docNumber = (await posted.textContent())?.match(/material document (\S+)\./)?.[1] ?? '';
  assert.ok(docNumber, 'the material document number is shown');
  console.log(`  ✓ goods receipt posted as material document ${docNumber}`);

  const midEvidence = await withTenant(client, async (tx) => {
    const stock = await tx.execute(sql`
      select quantity from stock_quantity
      where client = ${client} and material_number = 'MAT-10001' and plant = '1000'
    `);
    const journal = await tx.execute(sql`
      select debit_credit, amount_local from journal_entry_line jl
      join material_document md on md.client = jl.client and md.journal_document_number = jl.document_number
      where md.client = ${client} and md.material_document_number = ${docNumber}
    `);
    return {
      stock: stock as unknown as Array<{ quantity: string }>,
      journal: journal as unknown as Array<{ debit_credit: string; amount_local: string }>,
    };
  });
  assert.equal(Number(midEvidence.stock[0].quantity), 5);
  const debit = midEvidence.journal.filter((l) => l.debit_credit === 'S').reduce((s, l) => s + Number(l.amount_local), 0);
  const credit = midEvidence.journal.filter((l) => l.debit_credit === 'H').reduce((s, l) => s + Number(l.amount_local), 0);
  assert.equal(debit, 500);
  assert.equal(credit, 500);
  console.log('  ✓ stock stands at 5 and the journal balances at 500');

  await operation.locator('input[name="doc"]').fill(docNumber);
  await operation.getByRole('button', { name: 'Load reference', exact: true }).click();
  await page.waitForLoadState('networkidle');
  const documentSection = page.locator('section[aria-labelledby="gr-document"]');
  await documentSection.getByText(`Material document ${docNumber}`).waitFor();
  await documentSection.getByRole('button', { name: 'Reverse document', exact: true }).click();
  await documentSection.getByText(/Reversal posted as material document/).waitFor();
  console.log('  ✓ the reversal posts as a new document');

  const evidence = await withTenant(client, async (tx) => {
    const original = await tx.execute(sql`
      select status, reversed_by from material_document
      where client = ${client} and material_document_number = ${docNumber}
    `);
    const stock = await tx.execute(sql`
      select quantity from stock_quantity
      where client = ${client} and material_number = 'MAT-10001' and plant = '1000'
    `);
    return {
      original: (original as unknown as Array<{ status: string; reversed_by: string }>)[0],
      stock: (stock as unknown as Array<{ quantity: string }>)[0],
    };
  });
  assert.equal(evidence.original.status, 'REVERSED');
  assert.ok(evidence.original.reversed_by, 'the original names its reversal');
  assert.equal(Number(evidence.stock.quantity), 0);
  console.log('  ✓ the original stands reversed and the stock is whole again');
}
