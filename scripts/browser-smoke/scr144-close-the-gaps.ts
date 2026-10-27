import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import type { BrowserTarget } from './targets';
import { chooseClosed } from './closed-fields';

type Context = { page: Page; base: string; target: BrowserTarget };

const UOM = '/inventory/uom-conversion';
const RECONCILE = '/inventory/stock-reconcile';
const MIGO = '/inventory/migo';

const PLANT = 'QU03';
const SLOC = 'SU03';
const SLOC_TO = 'SU04';

/**
 * SCR-144 browser acceptance (T843) — the three gaps closed, through the screens.
 *
 * A conversion is maintained on its own screen; a goods issue entered in that unit is stored
 * with both quantities and moves the converted base quantity; a unit with no conversion is
 * refused by name in the screen's own words; the plant reconciles balanced; and a document is
 * reversed from MIGO's A03 + R05 cell rather than by leaving for another route.
 */
export async function scr144CloseTheGaps(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-144: maintain a conversion, post in it, refuse an unconverted unit, reconcile, reverse in MIGO');

  const company = await withTenant(client, async (tx) => {
    const companies = await tx.execute(sql`
      select company_code, currency from company_code where client = ${client} order by company_code limit 1
    `) as unknown as Array<{ company_code: string; currency: string }>;
    if (!companies[0]) throw new Error('the browser tenant carries no company code');
    const code = companies[0].company_code;
    const currency = companies[0].currency;

    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, v.n, v.d, t.material_type, 'PC', 'browser.admin'
      from (values ('SCR144-BOX', 'Converted material')) as v(n, d)
      cross join (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, ${PLANT}, 'Reconcile plant', ${code}, 'KW', 'browser.admin')
      on conflict (client, plant) do update set company_code = excluded.company_code
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      values (${client}, 'SCR144-BOX', ${PLANT}, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
      values (${client}, ${PLANT}, ${SLOC}, 'Reconcile store', true, false, 'browser.admin'),
             (${client}, ${PLANT}, ${SLOC_TO}, 'Receiving store', true, false, 'browser.admin')
      on conflict (client, plant, storage_location) do update set is_active = true
    `);
    await tx.execute(sql`
      insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                      standard_price, moving_average_price, price_unit, currency,
                                      total_stock_quantity, stock_value, created_by)
      values (${client}, 'SCR144-BOX', ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1, ${currency}, 0, 0, 'browser.admin')
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
  });

  // ── 1 · the conversion, maintained on its own screen ─────────────────────────────────
  await page.goto(`${base}${UOM}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Units of measure per material', exact: true }).waitFor();
  await page.fill('input[name="materialNumber"]', 'SCR144-BOX');
  await page.selectOption('select[name="alternativeUnit"]', 'BOX');
  await page.fill('input[name="numerator"]', '12');
  await page.fill('input[name="denominator"]', '1');
  await page.getByRole('button', { name: 'Maintain the conversion', exact: true }).click();
  await page.locator(`[data-conversion="SCR144-BOX/BOX"]`).waitFor();
  assert.equal(
    await page.locator('[data-ratio="12/1"]').first().getAttribute('data-ratio'), '12/1',
    'the screen states the ratio as maintained, not as a decimal',
  );

  // ── 2 · a starting quantity, so an issue has stock to move. The opening balance is a
  //        material document like any other, which is what reconcile reads.
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
      values (${client}, 'OPENING_BALANCE', 'Opening balance', 'RECEIPT', 'MATERIAL_DOCUMENT', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date,
                                     posting_date, header_text, status, created_by)
      values (${client}, 'MD-OPEN144', 2026, '2026-10-01', '2026-10-01', 'Opening balance', 'POSTED', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document_line (client, material_document_number, line_number, movement_type,
                                          material_number, plant, storage_location, stock_type, line_direction,
                                          entry_quantity, entry_unit, base_quantity, base_unit, created_by)
      values (${client}, 'MD-OPEN144', 1, 'OPENING_BALANCE', 'SCR144-BOX', ${PLANT}, ${SLOC}, 'UNRESTRICTED',
              'RECEIPT', 60, 'PC', 60, 'PC', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
      values (${client}, 'SCR144-BOX', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 60, 'browser.admin')
      on conflict (client, material_number, plant, storage_location, stock_type, batch_number)
      do update set quantity = 60
    `);
  });

  // ── 3 · a transfer entered in BOX moves pieces ─────────────────────────────────────
  const transfer = async (unit: string) => {
    await page.goto(`${base}${MIGO}`, { waitUntil: 'domcontentloaded' });
    await page.selectOption('select[name="migoAction"]', 'A04');
    await page.selectOption('select[name="migoReference"]', 'R10');
    await page.selectOption('select[name="movementTypeCode"]', '311');
    await page.fill('input[name="materialNumber"]', 'SCR144-BOX');
    await page.fill('input[name="quantity"]', '2');
    await page.fill('input[name="unit"]', unit);
    await chooseClosed(page, 'issuingPlant', PLANT);
    await chooseClosed(page, 'issuingStorageLocation', SLOC);
    await chooseClosed(page, 'receivingPlant', PLANT);
    await chooseClosed(page, 'receivingStorageLocation', SLOC_TO);
    await page.fill('input[name="postingDate"]', '2026-10-20');
    await page.fill('input[name="documentDate"]', '2026-10-20');
    await page.getByRole('button', { name: 'Post the transfer', exact: true }).click();
  };

  await transfer('BOX');
  await page.locator('p[role="status"]').filter({ hasText: 'Posted: material document' }).waitFor();

  const posted = await withTenant(client, (tx) => tx.execute(sql`
    select l.entry_quantity::text as entry_quantity, l.entry_unit, l.base_quantity::text as base_quantity,
           l.base_unit,
           (select quantity::text from stock_quantity s
             where s.client = l.client and s.material_number = 'SCR144-BOX' and s.plant = ${PLANT}
               and s.storage_location = ${SLOC} and s.stock_type = 'UNRESTRICTED') as source,
           (select quantity::text from stock_quantity s
             where s.client = l.client and s.material_number = 'SCR144-BOX' and s.plant = ${PLANT}
               and s.storage_location = ${SLOC_TO} and s.stock_type = 'UNRESTRICTED') as destination
      from material_document_line l
     where l.client = ${client} and l.material_number = 'SCR144-BOX'
       and l.movement_type <> 'OPENING_BALANCE' and l.line_direction = 'ISSUE'
     order by l.material_document_number desc, l.line_number
     limit 1
  `)) as unknown as Array<{
    entry_quantity: string; entry_unit: string; base_quantity: string; base_unit: string;
    source: string; destination: string;
  }>;
  assert.equal(Number(posted[0].entry_quantity), 2, 'the entry quantity is stored as entered');
  assert.equal(posted[0].entry_unit, 'BOX', 'the entry unit is stored as entered');
  assert.equal(Number(posted[0].base_quantity), 24, 'two boxes are twenty-four pieces');
  assert.equal(posted[0].base_unit, 'PC');
  assert.equal(Number(posted[0].source), 36, 'the issuing location moved the base quantity');
  assert.equal(Number(posted[0].destination), 24, 'the receiving location carries it');
  const issuedDocument = await withTenant(client, (tx) => tx.execute(sql`
    select material_document_number from material_document
     where client = ${client} and status = 'POSTED' and reversal_of is null
       and material_document_number <> 'MD-OPEN144'
     order by material_document_number desc limit 1
  `)) as unknown as Array<{ material_document_number: string }>;

  // ── 4 · an unconverted unit is refused by name, and nothing moves ───────────────────
  await transfer('GAL');
  await page.locator('p[role="status"]')
    .filter({ hasText: 'carries no conversion from GAL to its base unit PC' }).waitFor();

  const untouched = await withTenant(client, (tx) => tx.execute(sql`
    select quantity::text as stock from stock_quantity
     where client = ${client} and material_number = 'SCR144-BOX' and plant = ${PLANT}
       and storage_location = ${SLOC} and stock_type = 'UNRESTRICTED'
  `)) as unknown as Array<{ stock: string }>;
  assert.equal(Number(untouched[0].stock), 36, 'a refused unit moves no stock');

  // ── 5 · the plant reconciles balanced, through the reconcile screen ─────────────────
  await page.goto(`${base}${RECONCILE}?plant=${PLANT}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Stock reconciliation', exact: true }).waitFor();
  const verdict = page.locator('[data-reconcile-verdict]').first();
  await verdict.waitFor();
  assert.equal(await verdict.getAttribute('data-reconcile-verdict'), 'BALANCED',
    'the ledger and the projection agree');
  assert.ok(Number(await verdict.getAttribute('data-dimensions-checked')) >= 2,
    'the run checked both dimensions it was given');

  // ── 6 · reversal posted from MIGO's own A03 + R05 cell ──────────────────────────────
  await page.goto(`${base}${MIGO}`, { waitUntil: 'domcontentloaded' });
  await page.selectOption('select[name="migoAction"]', 'A03');
  await page.selectOption('select[name="migoReference"]', 'R05');
  await page.fill('input[name="materialDocumentNumber"]', issuedDocument[0].material_document_number);
  await page.fill('input[name="postingDate"]', '2026-10-20');
  await page.fill('input[name="documentDate"]', '2026-10-20');
  await page.getByRole('button', { name: 'Post the cancellation', exact: true }).click();
  await page.locator('p[role="status"]').filter({ hasText: 'Reversed: material document' }).waitFor();

  const reversed = await withTenant(client, (tx) => tx.execute(sql`
    select
      (select status from material_document where client = ${client}
        and material_document_number = ${issuedDocument[0].material_document_number}) as original_status,
      (select count(*)::int from material_document where client = ${client}
        and reversal_of = ${issuedDocument[0].material_document_number}) as reversals,
      (select quantity::text from stock_quantity where client = ${client}
        and material_number = 'SCR144-BOX' and plant = ${PLANT}
        and storage_location = ${SLOC} and stock_type = 'UNRESTRICTED') as source,
      (select quantity::text from stock_quantity where client = ${client}
        and material_number = 'SCR144-BOX' and plant = ${PLANT}
        and storage_location = ${SLOC_TO} and stock_type = 'UNRESTRICTED') as destination
  `)) as unknown as Array<{ original_status: string; reversals: number; source: string; destination: string }>;
  assert.equal(reversed[0].original_status, 'REVERSED', 'the original is reversed, never rewritten');
  assert.equal(reversed[0].reversals, 1, 'one reversal document stands against it');
  assert.equal(Number(reversed[0].source), 60, 'the reversal returned the twenty-four pieces');
  assert.equal(Number(reversed[0].destination), 0);

  // ── 7 · the screen still refuses A03 against anything but a document ───────────────
  await page.goto(`${base}${MIGO}`, { waitUntil: 'domcontentloaded' });
  await page.selectOption('select[name="migoAction"]', 'A03');
  await page.selectOption('select[name="migoReference"]', 'R10');
  // A03 against anything but a document posts nothing: the screen offers no cancellation form,
  // and the action refuses the cell if a form is forged anyway.
  assert.equal(
    await page.getByRole('button', { name: 'Post the cancellation', exact: true }).count(), 0,
    'A03 against a transfer reference offers no cancellation form',
  );
  assert.equal(
    await page.locator('text=Material document to cancel').count(), 0,
    'and no field to name one',
  );

  console.log('SCR-144: a conversion posted in BOX moved 24 PC, GAL was refused by name, the plant reconciled balanced, and A03 + R05 reversed the document inside MIGO');
}
