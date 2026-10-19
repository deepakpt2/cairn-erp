import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ANALYSIS = '/finance/grir-reclass';

/**
 * SCR-099 browser acceptance: GR/IR clearing account analysis.
 *
 * The journey: a purchase order stands 10 received against 6
 * invoiced; the analysis executes in test mode from its selection
 * and classifies the open 4 / 400 as goods received not invoiced —
 * while posting nothing to the ledger.
 */
export async function grIrAnalysis(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-099: analyze a partly invoiced purchase order item');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by)
      values (${client}, 'V100', 'ORGANIZATION', 'Browser vendor', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
      values (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt for PO', 'RECEIPT', 'PURCHASE_ORDER', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_order (client, order_number, supplier_number, purchasing_org, purchasing_group, company_code, currency, document_date, created_by)
      values (${client}, 'PO-1', 'V100', '1000', '001', '1000', 'KWD', '2026-04-01', 'browser.admin')
    `);
    await tx.execute(sql`
      insert into purchase_order_item (client, order_number, item_number, short_text, quantity, unit, net_price, net_value, plant, created_by)
      values (${client}, 'PO-1', 1, 'Browser item', 10, 'EA', 100, 1000, '1000', 'browser.admin')
    `);
    await tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, status, created_by)
      values (${client}, 'MD-1', 2026, '2026-04-05', '2026-04-05', 'POSTED', 'browser.admin')
    `);
    await tx.execute(sql`
      insert into material_document_line (client, material_document_number, line_number, movement_type, material_number, plant, entry_quantity, entry_unit, base_quantity, base_unit, purchase_order_number, purchase_order_item, created_by)
      values (${client}, 'MD-1', 1, 'GOODS_RECEIPT_PO', 'MAT1', '1000', 10, 'EA', 10, 'EA', 'PO-1', 1, 'browser.admin')
    `);
    await tx.execute(sql`
      insert into supplier_invoice (client, invoice_number, fiscal_year, category, supplier_number, company_code, purchase_order_number, invoice_date, posting_date, supplier_reference, currency, gross_amount, status, created_by)
      values (${client}, 'INV-1', 2026, 'INVOICE', 'V100', '1000', 'PO-1', '2026-04-10', '2026-04-10', 'REF-1', 'KWD', 600, 'POSTED', 'browser.admin')
    `);
    await tx.execute(sql`
      insert into supplier_invoice_item (client, invoice_number, line_number, purchase_order_number, purchase_order_item, quantity, unit, net_amount, expected_amount, created_by)
      values (${client}, 'INV-1', 1, 'PO-1', 1, 6, 'EA', 600, 600, 'browser.admin')
    `);
  });
  console.log('  ✓ PO-1 stands 10 received against 6 invoiced at 100 each');

  const journalsBefore = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`);
    return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
  });

  await page.goto(`${base}${ANALYSIS}?run=1&requestKey=browser-grir-1&companyCode=1000&keyDate=2026-04-30&testRun=on`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'GR/IR Clearing Account Analysis', exact: true }).waitFor();
  await page.getByText('PO-1/1').waitFor();
  await page.getByText('Goods received, not invoiced').waitFor();
  await page.getByText('400.00').first().waitFor();
  console.log('  ✓ the protocol classifies the open 4 / 400 correctly');

  const journalsAfter = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`);
    return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
  });
  assert.equal(journalsAfter, journalsBefore, 'the analysis posted nothing');
  console.log('  ✓ analysis alone posted nothing');
}
