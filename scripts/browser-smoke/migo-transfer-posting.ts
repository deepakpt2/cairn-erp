import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const MIGO = '/inventory/migo';

/**
 * SCR-141 browser acceptance: MIGO A04 + R10 — the transfer posting entered on the movement
 * screen against SAP's "Other", with the movement chosen on the item.
 *
 * Three legs on one screen: a 311 moving quantity inside a plant with no journal, a 301 across
 * two plants that carries value, and a 321 taking stock from quality inspection to unrestricted —
 * then a 311 whose plants differ, refused in the screen's own words.
 */
export async function migoTransferPosting(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-141: post transfers from MIGO A04 + R10, then watch a wrong pair refused');

  const company = await withTenant(client, async (tx) => {
    const companies = await tx.execute(sql`
      select company_code, currency from company_code where client = ${client} order by company_code limit 1
    `) as unknown as Array<{ company_code: string; currency: string }>;
    if (!companies[0]) throw new Error('the browser tenant carries no company code');
    const code = companies[0].company_code;
    const currency = companies[0].currency;

    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'MGT-MAT', 'Transferred material', t.material_type, 'PC', 'browser.admin'
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by) values
        (${client}, 'QG03', 'Transfer origin', ${code}, 'KW', 'browser.admin'),
        (${client}, 'QG04', 'Transfer destination', ${code}, 'KW', 'browser.admin')
      on conflict (client, plant) do update set company_code = excluded.company_code
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by) values
        (${client}, 'MGT-MAT', 'QG03', 'browser.admin'),
        (${client}, 'MGT-MAT', 'QG04', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by) values
        (${client}, 'QG03', 'SG03', 'Origin store', true, false, 'browser.admin'),
        (${client}, 'QG03', 'SG04', 'Origin second store', true, false, 'browser.admin'),
        (${client}, 'QG04', 'SG05', 'Destination store', true, false, 'browser.admin')
      on conflict (client, plant, storage_location) do update set is_active = true
    `);
    // The origin values at ten; the destination is standard-priced at twelve, so a cross-plant
    // transfer must carry the value and post the difference.
    await tx.execute(sql`
      insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                      standard_price, moving_average_price, price_unit, currency,
                                      total_stock_quantity, stock_value, created_by)
      values
        (${client}, 'MGT-MAT', 'QG03', 'RAW_INVENTORY', 'MOVING_AVERAGE', 12, 10, 1, ${currency}, 100, 1000, 'browser.admin'),
        (${client}, 'MGT-MAT', 'QG04', 'RAW_INVENTORY', 'STANDARD', 12, 12, 1, ${currency}, 0, 0, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by) values
        (${client}, 'MGT-MAT', 'QG03', 'SG03', 'UNRESTRICTED', 100, 'browser.admin'),
        (${client}, 'MGT-MAT', 'QG03', 'SG03', 'QUALITY', 20, 'browser.admin')
      on conflict (client, material_number, plant, storage_location, stock_type, batch_number) do update set quantity = excluded.quantity
    `);
    await tx.execute(sql`
      insert into gl_account (client, chart_of_accounts, account_number, name, account_type,
                              is_balance_sheet, is_open_item_managed, reconciliation_type,
                              requires_cost_object, is_tax_relevant, account_group, gl_account_type, created_by)
      select ${client}, c.chart_of_accounts, v.n, v.d, v.t,
             v.balance, false, null, false, false, 'GENL', v.kind, 'browser.admin'
      from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
      cross join (values
        ('123960', 'Raw material inventory', 'ASSET', true, 'BALANCE_SHEET'),
        ('593960', 'Price differences', 'EXPENSE', false, 'PL_STATEMENT')
      ) as v(n, d, t, balance, kind)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      select ${client}, c.chart_of_accounts, v.e, 'RAW_INVENTORY', '', v.a, 'browser.admin'
      from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
      cross join (values ('INVENTORY', '123960'), ('PRICE_DIFFERENCE', '593960')) as v(e, a)
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
    await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: 'MD', numberLength: 8, createdBy: 'browser.admin' });
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: company, subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'browser.admin',
    });
  });

  const post = async (fields: Record<string, string>) => {
    await page.goto(`${base}${MIGO}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { level: 1, name: 'Goods Movement', exact: true }).waitFor();
    await page.selectOption('select[name="migoAction"]', 'A04');
    await page.selectOption('select[name="migoReference"]', 'R10');
    const cell = page.locator('[data-cell]');
    await cell.waitFor();
    assert.equal(await cell.getAttribute('data-cell'), 'POST_HERE', 'A04 + R10 posts here');
    assert.match(await cell.innerText(), /311\/301\/321/, 'and names the movements on offer');

    await page.selectOption('select[name="movementTypeCode"]', fields.movement);
    await page.fill('input[name="materialNumber"]', 'MGT-MAT');
    await page.fill('input[name="quantity"]', fields.quantity);
    await page.fill('input[name="issuingPlant"]', fields.issuingPlant);
    await page.fill('input[name="issuingStorageLocation"]', fields.issuingLocation);
    await page.fill('input[name="receivingPlant"]', fields.receivingPlant);
    await page.fill('input[name="receivingStorageLocation"]', fields.receivingLocation);
    await page.fill('input[name="postingDate"]', '2026-10-16');
    await page.fill('input[name="documentDate"]', '2026-10-16');
    await page.getByRole('button', { name: 'Post the transfer', exact: true }).click();
  };

  const documentFrom = async () => {
    await page.locator('p[role="status"]').filter({ hasText: 'Posted: material document' }).waitFor();
    return /Posted: material document ([^\s.]+)\./
      .exec(await page.locator('p[role="status"]').first().innerText())![1];
  };

  // ── 311: inside one plant, quantity only, no journal ───────────────────────────────
  await post({
    movement: '311', quantity: '10',
    issuingPlant: 'QG03', issuingLocation: 'SG03',
    receivingPlant: 'QG03', receivingLocation: 'SG04',
  });
  const moved = await documentFrom();
  assert.match(await page.locator('p[role="status"]').first().innerText(), /Posted/);
  const noJournal = await page.locator('[data-transfer-document]').first().innerText();
  assert.equal(noJournal, moved);
  assert.match(
    await page.locator('section[aria-labelledby="movement-transfer-result"]').innerText(),
    /no journal/i, 'a 311 moves quantity only and says so',
  );

  const after311 = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select
        (select quantity::text from stock_quantity where client = ${client} and material_number = 'MGT-MAT'
          and plant = 'QG03' and storage_location = 'SG03' and stock_type = 'UNRESTRICTED') as source,
        (select quantity::text from stock_quantity where client = ${client} and material_number = 'MGT-MAT'
          and plant = 'QG03' and storage_location = 'SG04' and stock_type = 'UNRESTRICTED') as destination,
        (select journal_document_number from material_document
          where client = ${client} and material_document_number = ${moved}) as journal,
        (select count(*)::int from material_document_line
          where client = ${client} and material_document_number = ${moved}) as lines
    `) as unknown as Array<{ source: string; destination: string; journal: string | null; lines: number }>;
    return rows[0];
  });
  assert.equal(Number(after311.source), 90, 'the issuing location falls by ten');
  assert.equal(Number(after311.destination), 10, 'the receiving location rises by ten');
  assert.equal(after311.journal, null, 'a 311 posts no journal');
  assert.equal(after311.lines, 2, 'and stands as a two-line document');

  // ── 301: across plants, carrying value and posting the difference ──────────────────
  await post({
    movement: '301', quantity: '10',
    issuingPlant: 'QG03', issuingLocation: 'SG03',
    receivingPlant: 'QG04', receivingLocation: 'SG05',
  });
  const across = await documentFrom();

  const after301 = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select
        (select quantity::text from stock_quantity where client = ${client} and material_number = 'MGT-MAT'
          and plant = 'QG04' and storage_location = 'SG05' and stock_type = 'UNRESTRICTED') as arrived,
        (select stock_value::text from material_valuation where client = ${client}
          and material_number = 'MGT-MAT' and valuation_area = 'QG04') as destination_value,
        (select stock_value::text from material_valuation where client = ${client}
          and material_number = 'MGT-MAT' and valuation_area = 'QG03') as source_value,
        (select journal_document_number from material_document
          where client = ${client} and material_document_number = ${across}) as journal,
        (select count(*)::int from journal_entry_line where client = ${client}
          and document_number = (select journal_document_number from material_document
            where client = ${client} and material_document_number = ${across})) as journal_lines,
        (select count(*)::int from journal_entry_line where client = ${client}
          and gl_account = '593960'
          and document_number = (select journal_document_number from material_document
            where client = ${client} and material_document_number = ${across})) as difference_lines
    `) as unknown as Array<{
      arrived: string; destination_value: string; source_value: string;
      journal: string | null; journal_lines: number; difference_lines: number;
    }>;
    return rows[0];
  });
  assert.equal(Number(after301.arrived), 10, 'the far plant receives ten');
  assert.equal(Number(after301.destination_value), 120, 'valued at its own standard price of twelve');
  assert.equal(Number(after301.source_value), 900, 'and the origin falls by the value that left');
  assert.ok(after301.journal, 'a 301 that posts a difference carries a journal');
  assert.ok(after301.journal_lines >= 2, 'a debit and a credit at least');
  assert.ok(after301.difference_lines >= 1, 'and the valuation difference posted to its own account');

  // ── 321: quality inspection to unrestricted, same plant and location ───────────────
  await post({
    movement: '321', quantity: '5',
    issuingPlant: 'QG03', issuingLocation: 'SG03',
    receivingPlant: 'QG03', receivingLocation: 'SG03',
  });
  await documentFrom();

  const after321 = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select
        (select quantity::text from stock_quantity where client = ${client} and material_number = 'MGT-MAT'
          and plant = 'QG03' and storage_location = 'SG03' and stock_type = 'QUALITY') as quality,
        (select quantity::text from stock_quantity where client = ${client} and material_number = 'MGT-MAT'
          and plant = 'QG03' and storage_location = 'SG03' and stock_type = 'UNRESTRICTED') as unrestricted
    `) as unknown as Array<{ quality: string; unrestricted: string }>;
    return rows[0];
  });
  assert.equal(Number(after321.quality), 15, 'quality inspection falls from twenty to fifteen');
  assert.equal(Number(after321.unrestricted), 85, 'unrestricted rises from eighty to eighty-five');

  // ── a 311 whose plants differ is refused in the screen's own words ─────────────────
  await post({
    movement: '311', quantity: '1',
    issuingPlant: 'QG03', issuingLocation: 'SG03',
    receivingPlant: 'QG04', receivingLocation: 'SG05',
  });
  await page.locator('p[role="status"]')
    .filter({ hasText: 'moves inside one plant' }).waitFor();
  assert.match(
    await page.locator('p[role="status"]').first().innerText(),
    /QG04 differs from QG03/,
    'the refusal names both plants',
  );

  console.log(`SCR-141: ${moved} moved stock inside a plant, ${across} carried it between plants, and the wrong pair was refused`);
}
