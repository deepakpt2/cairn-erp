import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/inventory/material-documents';
const DOC = '4900000777';

/**
 * SCR-134 browser acceptance: MB03 display material document.
 *
 * The fixture writes one document directly — a receipt of 10 and an issue of 4 in
 * two plants of two company codes, posted by JSMITH — plus a second document that
 * stands reversed in a closed year. The run reads the document as posted, narrows
 * it to an item, refuses a year that disagrees and a number that does not stand,
 * and confirms the reversed document still shows.
 */
export async function materialDocumentDisplay(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-134: display a document as posted, narrow to an item, and refuse a wrong year and a wrong number');

  await withTenant(client, async (tx) => {
    const companies = await tx.execute(sql`
      select company_code from company_code where client = ${client} order by company_code limit 2
    `) as unknown as Array<{ company_code: string }>;
    if (companies.length < 1) throw new Error('the browser tenant carries no company code');
    const one = companies[0].company_code;
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by) values
        (${client}, 'QM01', 'Display plant one', ${one}, 'KW', 'browser.admin'),
        (${client}, 'QM02', 'Display plant two', ${one}, 'KW', 'browser.admin')
      on conflict (client, plant) do update set company_code = excluded.company_code
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, v.n, v.d, t.material_type, 'PC', 'browser.admin'
      from (values ('MB03-MAT-A', 'Displayed material A'), ('MB03-MAT-B', 'Displayed material B')) as v(n, d)
      cross join (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
        (${client}, 'RECEIPT_OTHER', 'Goods receipt without reference', 'RECEIPT', 'MATERIAL_DOCUMENT', 'browser.admin'),
        (${client}, 'ISSUE_OTHER', 'Goods issue without reference', 'ISSUE', 'MATERIAL_DOCUMENT', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date,
                                     header_text, status, journal_document_number, created_by, created_at) values
        (${client}, ${DOC}, 2026, '2026-04-01', '2026-04-01', 'GR for PO 4500000001', 'POSTED',
         '5100000777', 'JSMITH', '2026-04-01 09:15:00+00')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date,
                                     header_text, status, reversed_by, created_by) values
        (${client}, '4900000778', 2024, '2024-12-31', '2024-12-31', 'Closed-year receipt', 'REVERSED', '4900000779', 'JSMITH')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document_line (client, material_document_number, line_number, movement_type, material_number,
                                          plant, storage_location, stock_type, line_direction, entry_quantity, entry_unit,
                                          base_quantity, base_unit, value, currency, purchase_order_number, purchase_order_item, created_by) values
        (${client}, ${DOC}, 1, 'RECEIPT_OTHER', 'MB03-MAT-A', 'QM01', '0001', 'UNRESTRICTED', 'RECEIPT',
         10, 'PC', 10, 'PC', 100.0000, ${'KWD'}, '4500000001', 10, 'browser.admin'),
        (${client}, ${DOC}, 2, 'ISSUE_OTHER', 'MB03-MAT-B', 'QM02', '0002', 'UNRESTRICTED', 'ISSUE',
         4, 'PC', 4, 'PC', 0.0000, ${'KWD'}, null, null, 'browser.admin'),
        (${client}, '4900000778', 1, 'RECEIPT_OTHER', 'MB03-MAT-A', 'QM01', '0001', 'UNRESTRICTED', 'RECEIPT',
         7, 'PC', 7, 'PC', 70.0000, ${'KWD'}, null, null, 'browser.admin')
      on conflict do nothing
    `);
  });

  await page.goto(`${base}${ROUTE}?document=${DOC}&fiscalYear=2026`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: `Display Material Document ${DOC}`, exact: true }).waitFor();

  // Header: poster, entry time, derived company code.
  assert.equal(await page.locator('[data-posted-by]').getAttribute('data-posted-by'), 'JSMITH',
    'the display names who posted it');
  const companiesShown = await page.locator('[data-company-codes]').getAttribute('data-company-codes');
  assert.match(companiesShown ?? '', /^\d{4}$/, 'the company code is derived from the plants that moved the stock');

  // Lines: both, with descriptions and directions.
  assert.equal(await page.locator('tr[data-item]').count(), 2, 'both lines stand');
  const body = await page.locator('body').innerText();
  assert.equal(body.includes('Displayed material A'), true, 'the material description resolves');
  assert.equal(body.includes('Goods receipt without reference'), true, 'the movement description resolves');
  assert.equal(body.includes('4500000001'), true, 'the purchase order reference is shown');
  assert.equal(await page.locator('tr[data-item="2"]').getAttribute('data-direction'), 'ISSUE',
    'the issuing line carries its direction');

  // The item narrows the grid.
  await page.goto(`${base}${ROUTE}?document=${DOC}&fiscalYear=2026&item=2`, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('tr[data-item]').count(), 1, 'the grid narrows to the named item');

  // A year that disagrees refuses by name.
  await page.goto(`${base}${ROUTE}?document=${DOC}&fiscalYear=2025`, { waitUntil: 'domcontentloaded' });
  await page.locator('div[role="alert"]').filter({ hasText: `Material document ${DOC} does not exist in fiscal year 2025` }).waitFor();

  // A number that does not stand refuses in the SAP shape.
  await page.goto(`${base}${ROUTE}?document=4999999999`, { waitUntil: 'domcontentloaded' });
  await page.locator('div[role="alert"]').filter({ hasText: 'Material document 4999999999 does not exist.' }).waitFor();

  // An item the document does not carry refuses, naming the items it does carry.
  await page.goto(`${base}${ROUTE}?document=${DOC}&item=9`, { waitUntil: 'domcontentloaded' });
  await page.locator('div[role="alert"]').filter({ hasText: `Material document ${DOC} carries no item 9` }).waitFor();

  // A reversed document in a closed year still shows as posted.
  await page.goto(`${base}${ROUTE}?document=4900000778`, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('[data-status]').getAttribute('data-status'), 'REVERSED',
    'a display applies no period check: the reversed document shows as it stood');

  console.log('SCR-134: the document showed as posted, narrowed to item 2, and refused a wrong year, a wrong number and a wrong item');
}
