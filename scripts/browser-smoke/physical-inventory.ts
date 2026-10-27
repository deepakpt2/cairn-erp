import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import type { BrowserTarget } from './targets';
import { chooseClosed } from './closed-fields';

type Context = { page: Page; base: string; target: BrowserTarget };

const PHYSICAL = '/inventory/physical-inventory';
const MIGO = '/inventory/migo';

/**
 * SCR-142 browser acceptance: MI01 — a blocked count, and the block refusing a real movement.
 *
 * The run creates a count document through the screen for one material with the posting block
 * set, reads back that nothing moved in the ledger, watches a 311 transfer of that material be
 * refused with the document's number, cancels the count in the screen's own words, and then
 * posts the same transfer successfully.
 */
export async function physicalInventoryCount(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-142: create a blocked count document, watch it refuse a transfer, cancel it, post');

  const company = await withTenant(client, async (tx) => {
    const companies = await tx.execute(sql`
      select company_code, currency from company_code where client = ${client} order by company_code limit 1
    `) as unknown as Array<{ company_code: string; currency: string }>;
    if (!companies[0]) throw new Error('the browser tenant carries no company code');
    const code = companies[0].company_code;
    const currency = companies[0].currency;

    // The type is named because the ledger refuses a valuation class the material type does not permit.
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, v.n, v.d, v.t, 'PC', 'browser.admin'
      from (values ('MPI-COUNT', 'Counted material', 'RAW'), ('MPI-FREE', 'Uncounted material', 'RAW')) as v(n, d, t)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, 'QP02', 'Count plant', ${code}, 'KW', 'browser.admin')
      on conflict (client, plant) do update set company_code = excluded.company_code
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      select ${client}, v.n, 'QP02', 'browser.admin'
      from (values ('MPI-COUNT'), ('MPI-FREE')) as v(n)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
      values (${client}, 'QP02', 'SQ01', 'Count store', true, false, 'browser.admin'),
             (${client}, 'QP02', 'SQ02', 'Other store', true, false, 'browser.admin')
      on conflict (client, plant, storage_location) do update set is_active = true
    `);
    await tx.execute(sql`
      insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                      standard_price, moving_average_price, price_unit, currency,
                                      total_stock_quantity, stock_value, created_by)
      select ${client}, v.n, 'QP02', 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1, ${currency}, 100, 1000, 'browser.admin'
      from (values ('MPI-COUNT'), ('MPI-FREE')) as v(n)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
      select ${client}, v.n, 'QP02', 'SQ01', 'UNRESTRICTED', 100, 'browser.admin'
      from (values ('MPI-COUNT'), ('MPI-FREE')) as v(n)
      on conflict (client, material_number, plant, storage_location, stock_type, batch_number) do update set quantity = 100
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
    await defineRange(tx, { client, objectCode: 'PHYINV', subObject: '*', prefix: 'PI', numberLength: 7, createdBy: 'browser.admin' });
    await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: 'MD', numberLength: 8, createdBy: 'browser.admin' });
  });

  // ── the count, created through the screen ────────────────────────────────────────────
  await page.goto(`${base}${PHYSICAL}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Physical Inventory', exact: true }).waitFor();

  await page.fill('input[name="plant"]', 'QP02');
  await page.fill('input[name="storageLocation"]', 'SQ01');
  await page.fill('input[name="plannedCountDate"]', '2026-10-20');
  await page.check('input[name="postingBlock"]');
  await page.fill('input[name="material-1"]', 'MPI-COUNT');
  await page.getByRole('button', { name: 'Create the count document', exact: true }).click();

  await page.locator('p[role="status"]').filter({ hasText: 'Created: physical inventory document' }).waitFor();
  const documentNumber = await page.locator('[data-inventory-document]').first().innerText();
  assert.match(documentNumber, /^PI-\d{4}-\d{7}$/, 'the count draws a year-bearing number');
  assert.equal(
    await page.locator('[data-posting-block]').first().getAttribute('data-posting-block'), 'true',
    'the document carries the block',
  );
  assert.equal(
    await page.locator('[data-stock="MPI-COUNT"]').first().innerText(), '100.000 PC',
    'the screen states the stock the count starts from',
  );

  // Nothing moved: the ledger is untouched by a count.
  const ledger = await withTenant(client, (tx) => tx.execute(sql`
    select
      (select count(*)::int from material_document where client = ${client}) as documents,
      (select count(*)::int from journal_entry where client = ${client}) as journals,
      (select quantity::text from stock_quantity where client = ${client}
        and material_number = 'MPI-COUNT' and plant = 'QP02' and storage_location = 'SQ01'
        and stock_type = 'UNRESTRICTED') as stock
  `)) as unknown as Array<{ documents: number; journals: number; stock: string }>;
  assert.equal(ledger[0].documents, 0, 'a count posts no material document');
  assert.equal(ledger[0].journals, 0, 'a count posts no journal');
  assert.equal(Number(ledger[0].stock), 100, 'a count moves no stock');

  // ── the block refuses a real movement, in the movement screen's own words ────────────
  await page.goto(`${base}${MIGO}`, { waitUntil: 'domcontentloaded' });
  await page.selectOption('select[name="migoAction"]', 'A04');
  await page.selectOption('select[name="migoReference"]', 'R10');
  await page.selectOption('select[name="movementTypeCode"]', '311');
  await page.fill('input[name="materialNumber"]', 'MPI-COUNT');
  await page.fill('input[name="quantity"]', '5');
  await chooseClosed(page, 'issuingPlant', 'QP02');
  await chooseClosed(page, 'issuingStorageLocation', 'SQ01');
  await chooseClosed(page, 'receivingPlant', 'QP02');
  await chooseClosed(page, 'receivingStorageLocation', 'SQ02');
  await page.fill('input[name="postingDate"]', '2026-10-20');
  await page.fill('input[name="documentDate"]', '2026-10-20');
  await page.getByRole('button', { name: 'Post the transfer', exact: true }).click();

  await page.locator('p[role="status"]')
    .filter({ hasText: `Physical inventory document ${documentNumber} blocks postings` }).waitFor();

  // ── the count is cancelled from the list, and the same transfer then posts ──────────
  await page.goto(`${base}${PHYSICAL}`, { waitUntil: 'domcontentloaded' });
  await page.locator(`[data-cancel="${documentNumber}"]`).click();
  await page.locator(`[data-document="${documentNumber}"] [data-status="CANCELLED"]`).waitFor();

  const cancelled = await withTenant(client, (tx) => tx.execute(sql`
    select status from physical_inventory_document
     where client = ${client} and inventory_document_number = ${documentNumber}
  `)) as unknown as Array<{ status: string }>;
  assert.equal(cancelled[0].status, 'CANCELLED', 'the block is released by the cancellation');

  await page.goto(`${base}${MIGO}`, { waitUntil: 'domcontentloaded' });
  await page.selectOption('select[name="migoAction"]', 'A04');
  await page.selectOption('select[name="migoReference"]', 'R10');
  await page.selectOption('select[name="movementTypeCode"]', '311');
  await page.fill('input[name="materialNumber"]', 'MPI-COUNT');
  await page.fill('input[name="quantity"]', '5');
  await chooseClosed(page, 'issuingPlant', 'QP02');
  await chooseClosed(page, 'issuingStorageLocation', 'SQ01');
  await chooseClosed(page, 'receivingPlant', 'QP02');
  await chooseClosed(page, 'receivingStorageLocation', 'SQ02');
  await page.fill('input[name="postingDate"]', '2026-10-20');
  await page.fill('input[name="documentDate"]', '2026-10-20');
  await page.getByRole('button', { name: 'Post the transfer', exact: true }).click();
  await page.locator('p[role="status"]').filter({ hasText: 'Posted: material document' }).waitFor();

  const moved = await withTenant(client, (tx) => tx.execute(sql`
    select
      (select quantity::text from stock_quantity where client = ${client}
        and material_number = 'MPI-COUNT' and plant = 'QP02' and storage_location = 'SQ01'
        and stock_type = 'UNRESTRICTED') as source,
      (select quantity::text from stock_quantity where client = ${client}
        and material_number = 'MPI-COUNT' and plant = 'QP02' and storage_location = 'SQ02'
        and stock_type = 'UNRESTRICTED') as destination
  `)) as unknown as Array<{ source: string; destination: string }>;
  assert.equal(Number(moved[0].source), 95, 'the transfer posted once the count was cancelled');
  assert.equal(Number(moved[0].destination), 5);

  // ── SCR-143: the reversal path, which used to bypass the block ──────────────────────
  // Post a 311 before any count exists, then block the material and try to reverse it.
  await page.goto(`${base}${MIGO}`, { waitUntil: 'domcontentloaded' });
  await page.selectOption('select[name="migoAction"]', 'A04');
  await page.selectOption('select[name="migoReference"]', 'R10');
  await page.selectOption('select[name="movementTypeCode"]', '311');
  await page.fill('input[name="materialNumber"]', 'MPI-FREE');
  await page.fill('input[name="quantity"]', '3');
  await chooseClosed(page, 'issuingPlant', 'QP02');
  await chooseClosed(page, 'issuingStorageLocation', 'SQ01');
  await chooseClosed(page, 'receivingPlant', 'QP02');
  await chooseClosed(page, 'receivingStorageLocation', 'SQ02');
  await page.fill('input[name="postingDate"]', '2026-10-20');
  await page.fill('input[name="documentDate"]', '2026-10-20');
  await page.getByRole('button', { name: 'Post the transfer', exact: true }).click();
  await page.locator('p[role="status"]').filter({ hasText: 'Posted: material document' }).waitFor();
  const toReverse = /Posted: material document ([^\s.]+)\./
    .exec(await page.locator('p[role="status"]').first().innerText())![1];

  await page.goto(`${base}${PHYSICAL}`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="plant"]', 'QP02');
  await page.fill('input[name="storageLocation"]', 'SQ01');
  await page.fill('input[name="plannedCountDate"]', '2026-10-20');
  await page.check('input[name="postingBlock"]');
  await page.fill('input[name="material-1"]', 'MPI-FREE');
  await page.getByRole('button', { name: 'Create the count document', exact: true }).click();
  await page.locator('p[role="status"]').filter({ hasText: 'Created: physical inventory document' }).waitFor();
  const blocking = await page.locator('[data-inventory-document]').last().innerText();

  const reversal = await withTenant(client, async (tx) => {
    try {
      const { reverseMaterialDocument } = await import('../../src/modules/inventory/material-document-reversal');
      await reverseMaterialDocument({
        client, changedBy: 'browser.admin', materialDocumentNumber: toReverse,
        postingDate: '2026-10-20', documentDate: '2026-10-20',
        requestKey: `rev-${Date.now()}`,
      });
      return 'posted';
    } catch (caught) {
      void tx;
      return (caught as Error).message;
    }
  });
  assert.match(reversal, /blocks postings for material MPI-FREE/,
    'the reversal answers to the count block like every other movement');

  await page.goto(`${base}${PHYSICAL}`, { waitUntil: 'domcontentloaded' });
  await page.locator(`[data-cancel="${blocking}"]`).click();
  await page.locator(`[data-document="${blocking}"] [data-status="CANCELLED"]`).waitFor();

  console.log(`SCR-142/143: ${documentNumber} blocked a transfer, and ${blocking} blocked a reversal until cancelled`);
}
