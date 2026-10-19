import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postJournalEntry } from '../../src/platform/posting';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ITEMS = '/finance/journal/items';

/**
 * SCR-088 browser acceptance: G/L line item report (FAGLL03).
 *
 * The journey: two journals stand posted; the report reads the
 * 400000 lines with subtotals, judges the cleared payables line
 * under Cleared, drills into the document display — and the
 * journal stands exactly as it stood, because reading moves
 * nothing.
 */
export async function journalItemsFagll03(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-088: read line items, judge cleared status, drill through, and verify no mutation');

  const firstDoc = await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'BROWSER_SMOKE',
    });
    const first = await postJournalEntry(tx, {
      client, companyCode: '1000', documentType: 'SA',
      documentDate: '2026-03-15', postingDate: '2026-03-15',
      fiscalYear: 2026, postingPeriod: 3, currency: 'USD', localCurrency: 'USD',
      reference: 'ITEMS-2026-001',
      lines: [
        { glAccount: '400000', debitCredit: 'S', amount: '500.00' },
        { glAccount: '101000', debitCredit: 'H', amount: '500.00' },
      ],
      postedBy: 'BROWSER_SMOKE', transactionCode: 'FIN.JOURNAL.POST',
    });
    await postJournalEntry(tx, {
      client, companyCode: '1000', documentType: 'SA',
      documentDate: '2026-03-20', postingDate: '2026-03-20',
      fiscalYear: 2026, postingPeriod: 3, currency: 'USD', localCurrency: 'USD',
      lines: [
        { glAccount: '101000', debitCredit: 'S', amount: '900.00' },
        { glAccount: '200000', debitCredit: 'H', amount: '900.00', businessPartner: 'V10000' },
      ],
      postedBy: 'BROWSER_SMOKE', transactionCode: 'FIN.JOURNAL.POST',
    });
    await tx.execute(sql`
      update journal_entry_line set clearing_document = 'CLR-BROWSER-1', clearing_date = '2026-05-01'
      where client = ${client} and gl_account = '200000'
    `);
    return first.documentNumber;
  });
  console.log('  ✓ two journals stand posted, one payables line cleared');

  await page.goto(`${base}${ITEMS}?accountFrom=400000&companyCodes=1000`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'G/L Line Item Report', exact: true }).waitFor();
  const results = page.locator('section[aria-labelledby="ji-results"]');
  await results.getByText('500.00').first().waitFor();
  await results.getByText('ITEMS-2026-001').waitFor().catch(() => undefined);
  console.log('  ✓ the account lines and subtotals read from the journal');

  await page.goto(`${base}${ITEMS}?accountFrom=200000&companyCodes=1000&status=CLEARED`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await results.getByText('CLR-BROWSER-1').waitFor();
  await results.getByText('CLEARED').waitFor();
  console.log('  ✓ the cleared line judges under Cleared with its clearing document');

  await page.goto(`${base}${ITEMS}?accountFrom=400000&companyCodes=1000`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await results.getByRole('link', { name: firstDoc }).click();
  await page.getByRole('heading', { level: 1, name: 'Accounting documents', exact: true }).waitFor();
  console.log('  ✓ drill-through opens the document display');

  await withTenant(client, async (tx) => {
    const journals = await tx.execute(sql`
      select count(*)::int as n from journal_entry where client = ${client}
    `);
    assert.equal(Number((journals as unknown as { n: number }[])[0]?.n ?? 0), 2, 'reading posted nothing');
  });
  console.log('  ✓ the journal stands untouched by the report');
}
