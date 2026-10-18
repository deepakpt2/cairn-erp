import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/purchasing/orders';

/**
 * SCR-060 browser acceptance: release acts.
 *
 * The journey: release fixtures standing, an order created through
 * the grid claimed at creation, the wrong code refused, the sequence
 * released step by step until the document stands released, and
 * cancel returning it to the first step — the database remembering.
 */
export async function releaseActs(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-060: verify determination on create, the sequenced acts, full release, cancel, and database evidence');

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
      insert into characteristic (
        client, characteristic_name, description, data_format, value_length, decimal_places,
        lifecycle_status, created_by
      )
      values (${client}, 'TOTAL_VALUE', 'Total document value', 'NUM', 13, 2, 'ACTIVE', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into class_type (client, class_type, description, object_category, created_by)
      values (${client}, 'PURCHASE_ORDER', 'Purchase order release classes', 'PURCHASING', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into classification_class (client, class_type, class_name, description, lifecycle_status, created_by)
      values (${client}, 'PURCHASE_ORDER', 'PO_RELEASE', 'Purchase order release', 'ACTIVE', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into class_assignment (client, class_type, class_name, position, characteristic_name, created_by)
      values (${client}, 'PURCHASE_ORDER', 'PO_RELEASE', 1, 'TOTAL_VALUE', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into release_group (client, group_code, document_category, description, created_by)
      values (${client}, 'PO', 'PURCHASE_ORDER', 'Purchase order releases', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into release_code (client, group_code, code, description, created_by)
      values (${client}, 'PO', 'MGR', 'Purchasing manager', 'BROWSER_SMOKE'),
             (${client}, 'PO', 'FIN', 'Finance approver', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into release_strategy (
        client, group_code, strategy_code, description, class_type, class_name, priority, lifecycle_status, created_by
      )
      values (${client}, 'PO', 'HIGH', 'High value orders', 'PURCHASE_ORDER', 'PO_RELEASE', 100, 'ACTIVE', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into release_strategy_criterion (
        client, group_code, strategy_code, characteristic_name, operator, value_from, created_by
      )
      values (${client}, 'PO', 'HIGH', 'TOTAL_VALUE', 'GE', '1000', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into release_strategy_step (client, group_code, strategy_code, step, release_code, created_by)
      values (${client}, 'PO', 'HIGH', 1, 'MGR', 'BROWSER_SMOKE'),
             (${client}, 'PO', 'HIGH', 2, 'FIN', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
  });

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
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
  await inputs.nth(1).fill('Industrial steel plate');
  await inputs.nth(2).fill('10');
  await inputs.nth(3).fill('PC');
  await inputs.nth(4).fill('150');
  await row.locator('select').nth(0).selectOption('1000');
  const panel = create.locator('fieldset').first();
  await panel.locator('input[type="date"]').fill('2026-11-15');
  await panel.locator('input[placeholder="Scheduled quantity"]').fill('10');
  await create.getByRole('button', { name: 'Save purchase order', exact: true }).click();
  const confirmation = create.getByText(/Purchase order POF-\d+ created\./);
  await confirmation.waitFor();
  const number = (await confirmation.textContent())?.match(/POF-\d+/)?.[0] ?? '';
  assert.ok(number, 'the created order number is shown');
  console.log(`  ✓ purchase order ${number} created through the grid`);

  const overview = page.locator('section[aria-labelledby="po-overview"]');
  await overview.getByText('Pending · step 0 of 2').waitFor();
  console.log('  ✓ determination claimed the order at creation');

  await overview.getByRole('link', { name: number, exact: true }).click();
  await page.waitForLoadState('networkidle');
  const release = page.locator('section[aria-labelledby="po-release"]');
  await release.getByText(/Strategy PO \/ HIGH/).waitFor();

  await release.locator('select[name="releaseCode"]').selectOption('FIN');
  await release.getByRole('button', { name: 'Release step 1', exact: true }).click();
  await release.getByText(/acts under release code MGR, not FIN/).waitFor();
  console.log('  ✓ the wrong code is refused at the first step');

  await release.locator('select[name="releaseCode"]').selectOption('MGR');
  await release.getByRole('button', { name: 'Release step 1', exact: true }).click();
  await release.getByText(new RegExp(`Purchase order ${number} released through step 1 of 2\\.`)).waitFor();
  console.log('  ✓ the first act advances the document');

  await release.locator('select[name="releaseCode"]').selectOption('FIN');
  await release.getByRole('button', { name: 'Release step 2', exact: true }).click();
  await release.getByText(new RegExp(`Purchase order ${number} is fully released\\.`)).waitFor();
  await overview.getByText('Released', { exact: true }).waitFor();
  console.log('  ✓ the last act releases the document and the overview follows');

  await release.getByRole('button', { name: 'Cancel release', exact: true }).click();
  await release.getByText(/cancelled; it stands at the first step again/).waitFor();
  await overview.getByText('Pending · step 0 of 2').waitFor();
  console.log('  ✓ cancel returns the document to the first step');

  const evidence = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select strategy_code, current_step, status from document_release
      where client = ${client} and document_category = 'PURCHASE_ORDER' and document_number = ${number}
    `);
    const headerRows = await tx.execute(sql`
      select release_status from purchase_order where client = ${client} and order_number = ${number}
    `);
    const history = await changeHistory(tx, client, 'purchase_order', number);
    return {
      rows: rows as unknown as Record<string, unknown>[],
      header: headerRows as unknown as Record<string, unknown>[],
      history,
    };
  });
  assert.equal(evidence.rows.length, 1);
  assert.equal(evidence.rows[0].strategy_code, 'HIGH');
  assert.equal(Number(evidence.rows[0].current_step), 0);
  assert.equal(evidence.rows[0].status, 'PENDING');
  assert.equal(evidence.header[0].release_status, 'UNRELEASED');
  assert.ok(evidence.history.length >= 4, 'Creation and every act are documented.');
  console.log('  ✓ the database remembers the standing state, the header and every act');
}
