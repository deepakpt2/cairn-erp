import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postJournalEntry } from '../../src/platform/posting';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const DISPLAY = '/finance/journal/document';
const JOURNAL = '/finance/journal';
const MB03 = '/inventory/material-documents';
const MB1A = '/inventory/goods-issue';

/**
 * SCR-137 browser acceptance: FB03 display accounting document.
 *
 * The journey this round is about: a document is read by its number and year, every
 * line carries its derived account type, a company that disagrees is refused in SAP's
 * own words, and the three anchors that used to show a journal number as text — the
 * journal list, MB03 and the goods issue result — now open this display. Nothing is
 * written: the document stands exactly as posted after every visit.
 */
export async function journalDocumentDisplay(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-137: read a document by number and year, derive KOART, refuse a wrong company, follow the anchors');

  // ---- Fixture: company, a supplier and a customer of it, and two documents ----
  const fixture = await withTenant(client, async (tx) => {
    const companies = await tx.execute(sql`
      select company_code from company_code where client = ${client} order by company_code limit 1
    `) as unknown as Array<{ company_code: string }>;
    if (!companies[0]) throw new Error('the browser tenant carries no company code');
    const company = companies[0].company_code;

    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by) values
        (${client}, 'FB03-V1', 'ORGANIZATION', 'Display vendor', 'browser.admin'),
        (${client}, 'FB03-C1', 'ORGANIZATION', 'Display customer', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by) values
        (${client}, 'FB03-V1', 'SUPPLIER', 'browser.admin'),
        (${client}, 'FB03-C1', 'CUSTOMER', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_company_code (client, partner_number, role_code, company_code, chart_of_accounts,
                                         reconciliation_account, company_status, is_blocked, created_by)
      select ${client}, 'FB03-V1', 'SUPPLIER', ${company}, c.chart_of_accounts, '210000', 'MAINTAINED', false, 'browser.admin'
      from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into customer_company_code (client, partner_number, role_code, company_code, chart_of_accounts,
                                         reconciliation_account, company_status, is_blocked, created_by)
      select ${client}, 'FB03-C1', 'CUSTOMER', ${company}, c.chart_of_accounts, '120000', 'MAINTAINED', false, 'browser.admin'
      from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
      on conflict do nothing
    `);
    return company;
  });

  // A second company, so the cross-check has somewhere to disagree.
  const otherCompany = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select company_code from company_code where client = ${client} order by company_code offset 1 limit 1
    `) as unknown as Array<{ company_code: string }>;
    if (rows[0]) return rows[0].company_code;
    throw new Error('the browser tenant carries only one company code, so the cross-check cannot be exercised');
  });

  const docs = await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: fixture, subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'browser.admin',
    });
    const plain = await postJournalEntry(tx, {
      client, companyCode: fixture, documentType: 'SA',
      documentDate: '2026-07-04', postingDate: '2026-07-04',
      fiscalYear: 2026, postingPeriod: 7, currency: 'USD', localCurrency: 'USD',
      reference: 'FB03-PLAIN',
      lines: [
        { glAccount: '400000', debitCredit: 'S', amount: '300.00', lineText: 'Revenue line' },
        { glAccount: '101000', debitCredit: 'H', amount: '300.00' },
      ],
      postedBy: 'browser.admin', transactionCode: 'FIN.JOURNAL.POST',
    });
    const partners = await postJournalEntry(tx, {
      client, companyCode: fixture, documentType: 'SA',
      documentDate: '2026-07-05', postingDate: '2026-07-05',
      fiscalYear: 2026, postingPeriod: 7, currency: 'USD', localCurrency: 'USD',
      reference: 'FB03-PARTNERS',
      lines: [
        { glAccount: '210000', debitCredit: 'H', amount: '90.00', businessPartner: 'FB03-V1' },
        { glAccount: '120000', debitCredit: 'S', amount: '30.00', businessPartner: 'FB03-C1' },
        { glAccount: '400000', debitCredit: 'S', amount: '90.00' },
        { glAccount: '101000', debitCredit: 'H', amount: '30.00' },
      ],
      postedBy: 'browser.admin', transactionCode: 'FIN.JOURNAL.POST',
    });
    return { plain: plain.documentNumber, partners: partners.documentNumber };
  });
  console.log('  ✓ two documents stand posted, one naming a vendor and a customer');

  // ---- Leg 1: the document by number and year, with no company given ----
  await page.goto(`${base}${DISPLAY}?document=${encodeURIComponent(docs.plain)}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Display Accounting Document', exact: true }).waitFor();
  const header = page.locator('section[aria-labelledby="dd-header"]');
  await header.getByText('FB03-PLAIN').waitFor();
  const lines = page.locator('section[aria-labelledby="dd-lines"]');
  await lines.getByText('Revenue line').waitFor();
  await lines.getByText(/Totals in USD: debits 300\.00, credits 300\.00/).waitFor();
  assert.equal(await page.locator('tr[data-account-type]').count(), 2, 'both lines stand with an account type');
  assert.equal(await page.locator('tr[data-account-type="S"]').count(), 2, 'without a partner every line is a G/L line');

  // ---- Leg 2: KOART derived per line — S, D and K in one document ----
  await page.goto(`${base}${DISPLAY}?document=${encodeURIComponent(docs.partners)}&company=${fixture}&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.locator('section[aria-labelledby="dd-lines"]').waitFor();
  assert.equal(await page.locator('tr[data-account-type="D"]').count(), 1, 'the vendor line is D');
  assert.equal(await page.locator('tr[data-account-type="K"]').count(), 1, 'the customer line is K');
  assert.equal(await page.locator('tr[data-account-type="S"]').count(), 2, 'the two G/L lines are S');
  assert.equal(await page.getByRole('cell', { name: 'D', exact: true }).count(), 1, 'the type is shown as a column, not only as an attribute');

  // ---- Leg 3: a company that disagrees refuses in SAP's own words ----
  await page.goto(`${base}${DISPLAY}?document=${encodeURIComponent(docs.plain)}&company=${otherCompany}&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-company-mismatch]').filter({
    hasText: `Document ${docs.plain} does not exist in company code ${otherCompany}.`,
  }).waitFor();
  assert.equal(await page.locator('section[aria-labelledby="dd-header"]').count(), 0, 'the document is not shown under a company it does not stand in');

  // ---- Leg 4: the flow panel keeps its own capability, the display its own ----
  await page.goto(`${base}${DISPLAY}?document=${encodeURIComponent(docs.plain)}&company=${fixture}&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.locator('section[aria-labelledby="dd-flow"]').waitFor();
  assert.equal(
    (await page.locator('section[aria-labelledby="dd-flow"]').innerText()).includes('No related documents stand linked')
      || (await page.locator('section[aria-labelledby="dd-flow"]').innerText()).includes('flow'),
    true,
    'the flow panel stands beside the document',
  );

  // ---- Leg 5: nothing was written ----
  const afterRead = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select count(*)::int as n, coalesce(sum(amount_local), 0)::text as total
      from journal_entry_line
      where client = ${client} and document_number = ${docs.partners} and fiscal_year = 2026
    `) as unknown as Array<{ n: number; total: string }>;
    return { lines: rows[0].n, total: Number(rows[0].total) };
  });
  assert.equal(afterRead.lines, 4, 'the display left the document exactly as posted');
  assert.equal(afterRead.total, 240, 'and its amounts untouched');

  // ---- Leg 6: the journal list drills here with its full key ----
  await page.goto(`${base}${JOURNAL}`, { waitUntil: 'domcontentloaded' });
  const row = page.locator('tr').filter({ hasText: docs.plain }).first();
  await row.waitFor();
  const rowLink = row.locator('a').first();
  const href = await rowLink.getAttribute('href');
  assert.match(href ?? '', /^\/finance\/journal\/document\?document=.+&company=.+&year=2026$/, 'the list links the display with the complete key');
  await rowLink.click();
  await page.getByRole('heading', { level: 1, name: 'Display Accounting Document', exact: true }).waitFor();
  await page.locator('section[aria-labelledby="dd-header"]').getByText('FB03-PLAIN').waitFor();
  console.log('  ✓ the journal list names its documents and drills to the display');

  // ---- Leg 7: MB03's journal number is the drill it was deferred for ----
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
        (${client}, 'RECEIPT_OTHER', 'Goods receipt without reference', 'RECEIPT', 'MATERIAL_DOCUMENT', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'FB03-MAT', 'Anchored material', t.material_type, 'PC', 'browser.admin'
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date,
                                     header_text, status, journal_document_number, created_by)
      values (${client}, '4900037001', 2026, '2026-07-04', '2026-07-04', 'Anchored receipt', 'POSTED',
              ${docs.plain}, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document_line (client, material_document_number, line_number, movement_type, material_number,
                                          plant, storage_location, stock_type, line_direction, entry_quantity, entry_unit,
                                          base_quantity, base_unit, value, currency, created_by)
      select ${client}, '4900037001', 1, 'RECEIPT_OTHER', 'FB03-MAT', p.plant, null, 'UNRESTRICTED', 'RECEIPT',
             5, 'PC', 5, 'PC', 50.0000, 'KWD', 'browser.admin'
      from (select plant from plant where client = ${client} order by plant limit 1) p
      on conflict do nothing
    `);
  });

  await page.goto(`${base}${MB03}?document=4900037001&fiscalYear=2026`, { waitUntil: 'domcontentloaded' });
  const journalLink = page.locator(`a[href*="/finance/journal/document?document=${encodeURIComponent(docs.plain)}"]`).first();
  await journalLink.waitFor();
  await journalLink.click();
  await page.getByRole('heading', { level: 1, name: 'Display Accounting Document', exact: true }).waitFor();
  await page.locator('section[aria-labelledby="dd-header"]').getByText('FB03-PLAIN').waitFor();
  console.log('  ✓ MB03 shows the journal number as a link and it opens the document');

  // ---- Leg 8: the goods issue result links its journal too ----
  const company = await withTenant(client, async (tx) => {
    const codes = await tx.execute(sql`
      select company_code from company_code where client = ${client} order by company_code limit 1
    `) as unknown as Array<{ company_code: string }>;
    const code = codes[0].company_code;
    const areas = await tx.execute(sql`
      select controlling_area from controlling_area where client = ${client} order by controlling_area limit 1
    `) as unknown as Array<{ controlling_area: string }>;
    if (!areas[0]) throw new Error('the browser tenant carries no controlling area');
    const area = areas[0].controlling_area;
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, 'QR01', 'Anchor plant', ${code}, 'KW', 'browser.admin')
      on conflict (client, plant) do update set company_code = excluded.company_code
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
      values (${client}, 'QR01', 'SR01', 'Anchor store', true, false, 'browser.admin')
      on conflict (client, plant, storage_location) do update set is_active = true
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'FB03-ISSUE', 'Anchor issue material', t.material_type, 'PC', 'browser.admin'
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      values (${client}, 'FB03-ISSUE', 'QR01', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                      standard_price, moving_average_price, price_unit, currency,
                                      total_stock_quantity, stock_value, created_by)
      values (${client}, 'FB03-ISSUE', 'QR01', 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1, 'KWD', 100, 1000, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
      values (${client}, 'FB03-ISSUE', 'QR01', 'SR01', 'UNRESTRICTED', 50, 'browser.admin')
      on conflict (client, material_number, plant, storage_location, stock_type) do update set quantity = 50
    `);
    await tx.execute(sql`
      insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                           previous_fiscal_year, previous_period, allow_backposting, created_by)
      values (${client}, ${code}, 2026, 10, 2026, 9, true, 'browser.admin')
      on conflict (client, company_code) do update set current_fiscal_year = 2026, current_period = 10
    `);
    await tx.execute(sql`
      insert into controlling_area_company (client, controlling_area, company_code, created_by)
      values (${client}, ${area}, ${code}, 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, is_posting_locked, created_by)
      values (${client}, ${area}, 'CC3701', '2026-01-01', '2026-12-31', 'Anchor centre', 'PRODUCTION', ${code}, false, 'browser.admin')
      on conflict do nothing
    `);
    return code;
  });

  await page.goto(`${base}${MB1A}`, { waitUntil: 'domcontentloaded' });
  await page.selectOption('select[name="movementTypeCode"]', '201');
  await page.fill('input[name="postingDate"]', '2026-10-15');
  await page.fill('input[name="documentDate"]', '2026-10-15');
  await page.fill('input[name="headerText"]', 'Anchored issue');
  await page.fill('input[name="material-1"]', 'FB03-ISSUE');
  await page.fill('input[name="plant-1"]', 'QR01');
  await page.fill('input[name="sloc-1"]', 'SR01');
  await page.fill('input[name="quantity-1"]', '5');
  await page.fill('input[name="costCenter-1"]', 'CC3701');
  await page.getByRole('button', { name: 'Post the goods issue', exact: true }).click();
  await page.locator('p[role="status"]').filter({ hasText: 'Issued: material document' }).waitFor();
  const issueJournalLink = page.locator('a[href*="/finance/journal/document?document="]').first();
  await issueJournalLink.waitFor();
  const issueHref = await issueJournalLink.getAttribute('href');
  await issueJournalLink.click();
  await page.getByRole('heading', { level: 1, name: 'Display Accounting Document', exact: true }).waitFor();
  assert.match(issueHref ?? '', /^\/finance\/journal\/document\?document=.+$/, 'the issue result links its journal');
  await page.locator('section[aria-labelledby="dd-header"]').waitFor();
  console.log('  ✓ the goods issue result links the journal it posted');

  console.log(`SCR-137: number and year identified the document in company ${company}; KOART came out S/D/K, a wrong company was refused, and all three anchors open the display`);
}
