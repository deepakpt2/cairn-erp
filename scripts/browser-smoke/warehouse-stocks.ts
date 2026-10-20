import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/inventory/warehouse-stocks';

/**
 * SCR-127 browser acceptance: MB52 warehouse stocks on hand.
 *
 * The fixture puts one material into all three standard stock types, a second
 * material into unrestricted plus a project stock type, a third with no valuation
 * record at all, and a fourth left at zero. One posted movement gives both drills
 * a window.
 *
 * The journey: the snapshot splits 20 unrestricted / 5 quality / 2 blocked for the
 * first material and adds to 27; the special column carries the project stock so
 * the second material totals 10; the unvalued material reads "unknown" and is
 * warned about by name; the zero line stays hidden until asked for; a bogus scope
 * of list and the one-character special stock indicator each refuse by name; the
 * valuation display can be switched off; and the movements link lands on MB51 for
 * the same material.
 */
export async function warehouseStocks(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-127: snapshot the warehouse stock by type and value, then drill into its movements');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into plant (client, plant, name, country, created_by) values
        (${client}, 'Q850', 'Plant 850', 'KW', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, v.number, v.description, t.material_type, 'PC', 'browser.admin'
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      cross join (values
        ('MB52-MAT', 'Split material'), ('MB52-SPC', 'Project material'),
        ('MB52-NOV', 'Unvalued material'), ('MB52-ZER', 'Empty location')) as v(number, description)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, created_by) values
        (${client}, 'Q850', 'SL85', 'Snapshot store', true, 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
        (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt for purchase order', 'RECEIPT', 'PURCHASE_ORDER', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, header_text, status, created_by) values
        (${client}, '5960000001', 2026, '2026-05-04', '2026-05-04', 'Snapshot receipt', 'POSTED', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document_line (
        client, material_document_number, line_number, movement_type, material_number, plant, storage_location,
        stock_type, entry_quantity, entry_unit, base_quantity, base_unit, unit_price, price_unit, currency, value, created_by
      ) values
        (${client}, '5960000001', 1, 'GOODS_RECEIPT_PO', 'MB52-MAT', 'Q850', 'SL85', 'UNRESTRICTED',
         20, 'PC', 20, 'PC', 10, 1, 'KWD', 200, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by) values
        (${client}, 'MB52-MAT', 'Q850', 'SL85', 'UNRESTRICTED', 20, 'browser.admin'),
        (${client}, 'MB52-MAT', 'Q850', 'SL85', 'QUALITY', 5, 'browser.admin'),
        (${client}, 'MB52-MAT', 'Q850', 'SL85', 'BLOCKED', 2, 'browser.admin'),
        (${client}, 'MB52-SPC', 'Q850', 'SL85', 'UNRESTRICTED', 7, 'browser.admin'),
        (${client}, 'MB52-SPC', 'Q850', 'SL85', 'PROJECT', 3, 'browser.admin'),
        (${client}, 'MB52-NOV', 'Q850', 'SL85', 'UNRESTRICTED', 4, 'browser.admin'),
        (${client}, 'MB52-ZER', 'Q850', 'SL85', 'UNRESTRICTED', 0, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into valuation_class (client, valuation_class, name, allowed_material_types, created_by)
      select ${client}, 'BROWSER_CLASS', 'Browser class', 'RAW,FINISHED,TRADE,SEMI', 'browser.admin'
      where not exists (select 1 from valuation_class where client = ${client} and valuation_class = 'BROWSER_CLASS')
    `);
    await tx.execute(sql`
      insert into material_valuation (
        client, material_number, valuation_area, valuation_class, price_control,
        standard_price, moving_average_price, price_unit, currency, accounting_status, created_by
      ) values
        (${client}, 'MB52-MAT', 'Q850', 'BROWSER_CLASS', 'STANDARD', 12.5, 0, 1, 'KWD', 'MAINTAINED', 'browser.admin'),
        (${client}, 'MB52-SPC', 'Q850', 'BROWSER_CLASS', 'MOVING_AVERAGE', 0, 200, 10, 'KWD', 'MAINTAINED', 'browser.admin')
      on conflict do nothing
    `);
  });

  // ── The snapshot with its four-way split and value ────────────────────────
  await page.goto(`${base}${ROUTE}?scopeOfList=ALV&plantFrom=Q850&plantTo=Q850`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: /Warehouse Stocks on Hand/i }).waitFor();

  const split = page.locator('tr[data-material="MB52-MAT"]').first();
  await split.waitFor();
  const splitCells = (await split.locator('td').allInnerTexts()).map((text) => text.trim());
  // unit, unrestricted, quality, blocked, special, total, price, currency, value
  assert.deepEqual(splitCells.slice(4, 10), ['PC', '20.000', '5.000', '2.000', '0.000', '27.000'],
    `the stock-type split adds to the total: ${splitCells.join(' | ')}`);
  assert.equal(splitCells[10], '12.5000', 'the standard price is shown per its price unit');
  assert.equal(splitCells[12], '337.50', 'the value is quantity × price');
  console.log('  ✓ unrestricted, quality and blocked split and add to the total, valued at the plant price');

  // ── Special stock is not silently dropped ────────────────────────────────
  const special = page.locator('tr[data-material="MB52-SPC"]').first();
  const specialCells = (await special.locator('td').allInnerTexts()).map((text) => text.trim());
  assert.deepEqual(specialCells.slice(5, 10), ['7.000', '0.000', '0.000', '3.000', '10.000'],
    `project stock lands in the special column: ${specialCells.join(' | ')}`);
  assert.equal(specialCells[12], '200.00', 'the moving average price honours its price unit of 10');
  console.log('  ✓ project stock is carried in the special column so the total is never short');

  // ── An unvalued material reads unknown, never zero ───────────────────────
  const unvalued = page.locator('tr[data-material="MB52-NOV"]').first();
  const unvaluedCells = (await unvalued.locator('td').allInnerTexts()).map((text) => text.trim());
  assert.equal(unvaluedCells[9], '4.000', 'the quantity is still shown');
  assert.equal(unvaluedCells[12], 'unknown', 'the value is unknown, not zero');
  await page.locator('section[aria-label="Report warnings"] li').filter({ hasText: 'MB52-NOV' }).waitFor();
  console.log('  ✓ a material with no valuation record is warned about by name and shows unknown');

  // ── Zero lines and the valuation switch ───────────────────────────────────
  assert.equal(await page.locator('tr[data-material="MB52-ZER"]').count(), 0, 'the zero line is suppressed');
  await page.goto(`${base}${ROUTE}?scopeOfList=STANDARD&plantFrom=Q850&plantTo=Q850&displayZero=on`,
    { waitUntil: 'domcontentloaded' });
  await page.locator('tr[data-material="MB52-ZER"]').first().waitFor();
  console.log('  ✓ zero-stock lines stay hidden until the display flag asks for them');

  await page.goto(`${base}${ROUTE}?scopeOfList=ALV&plantFrom=Q850&plantTo=Q850&valuationPriceOff=1`,
    { waitUntil: 'domcontentloaded' });
  const noValue = page.locator('tr[data-material="MB52-MAT"]').first();
  const noValueCells = (await noValue.locator('td').allInnerTexts()).map((text) => text.trim());
  assert.equal(noValueCells.length, 11, `the value columns are gone: ${noValueCells.join(' | ')}`);
  assert.equal(noValueCells[9], '27.000', 'the quantities stand');
  console.log('  ✓ switching the valuation display off removes the price and value columns');

  // ── Refusals by name ─────────────────────────────────────────────────────
  await page.goto(`${base}${ROUTE}?scopeOfList=HIERARCHY&plantFrom=Q850&plantTo=Q850`, { waitUntil: 'domcontentloaded' });
  await page.locator('div[role="alert"]').filter({ hasText: 'scope of list HIERARCHY' }).waitFor();
  console.log('  ✓ an unknown scope of list refuses by name');

  await page.goto(`${base}${ROUTE}?scopeOfList=ALV&plantFrom=Q850&plantTo=Q850&specialStockIndicator=Q`,
    { waitUntil: 'domcontentloaded' });
  await page.locator('div[role="alert"]').filter({ hasText: 'special stock indicator Q' }).waitFor();
  console.log('  ✓ the one-character special stock indicator is refused in favour of a stock type');

  // ── Drill into the movements ─────────────────────────────────────────────
  await page.goto(`${base}${ROUTE}?scopeOfList=ALV&plantFrom=Q850&plantTo=Q850`, { waitUntil: 'domcontentloaded' });
  await page.locator('tr[data-material="MB52-MAT"]').first().getByRole('link', { name: 'Movements' }).click();
  await page.waitForURL(/\/inventory\/material-document-list\?.*materialFrom=MB52-MAT/);
  await page.getByRole('heading', { name: /Material Documents: List Display/i }).waitFor();
  assert.equal((await page.locator('body').innerText()).includes('5960000001'), true, 'the movement is listed');
  console.log('  ✓ the row drills into the material document list for the same material');
}
