import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postJournalEntry, reverseJournalEntry } from '../../src/platform/posting';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const DISPLAY = '/finance/journal/document';

/**
 * SCR-090 browser acceptance: document display and flow (FB03).
 *
 * The journey: a document stands posted and reversed; the display
 * retrieves it by its complete key, walks to the reversal and
 * back, and reads the retained REVERSE history — read-only
 * throughout.
 */
export async function documentDisplayFb03(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-090: display by composite key, walk the reversal flow, read history');

  const docs = await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'BROWSER_SMOKE',
    });
    const original = await postJournalEntry(tx, {
      client, companyCode: '1000', documentType: 'SA',
      documentDate: '2026-03-15', postingDate: '2026-03-15',
      fiscalYear: 2026, postingPeriod: 3, currency: 'USD', localCurrency: 'USD',
      reference: 'FLOW-2026-001',
      lines: [
        { glAccount: '400000', debitCredit: 'S', amount: '500.00', lineText: 'Flow debit' },
        { glAccount: '101000', debitCredit: 'H', amount: '500.00' },
      ],
      postedBy: 'BROWSER_SMOKE', transactionCode: 'FIN.JOURNAL.POST',
    });
    const reversal = await reverseJournalEntry(tx, {
      client, documentNumber: original.documentNumber, fiscalYear: 2026,
      reversalDate: '2026-03-20', reason: 'Entered twice',
      reversedBy: 'BROWSER_SMOKE', transactionCode: 'FIN.DOCUMENT.REVERSE',
    });
    return { original: original.documentNumber, reversal: reversal.documentNumber };
  });
  console.log('  ✓ a document stands posted and reversed');

  await page.goto(`${base}${DISPLAY}?document=${encodeURIComponent(docs.original)}&company=1000&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Display Accounting Document', exact: true }).waitFor();
  const header = page.locator('section[aria-labelledby="dd-header"]');
  await header.getByText('REVERSED', { exact: true }).waitFor();
  await header.getByText('FLOW-2026-001').waitFor();
  const lines = page.locator('section[aria-labelledby="dd-lines"]');
  await lines.getByText('Flow debit').waitFor();
  await lines.getByText(/Totals in USD: debits 500\.00, credits 500\.00/).waitFor();
  console.log('  ✓ the complete key retrieves the document with its totals');

  const flow = page.locator('section[aria-labelledby="dd-flow"]');
  await flow.getByRole('link', { name: `Reversed by ${docs.reversal}` }).click();
  await page.waitForLoadState('networkidle');
  await header.getByText('POSTED', { exact: true }).waitFor();
  await flow.getByRole('link', { name: `Reversal of ${docs.original}` }).click();
  await page.waitForLoadState('networkidle');
  await header.getByText('REVERSED', { exact: true }).waitFor();
  console.log('  ✓ the flow walks the reversal chain both ways');

  const history = page.locator('section[aria-labelledby="dd-history"]');
  await history.getByText(/REVERSE by BROWSER_SMOKE/).waitFor();
  console.log('  ✓ the retained change history displays');

  await withTenant(client, async (tx) => {
    const journals = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`);
    assert.equal(Number((journals as unknown as { n: number }[])[0]?.n ?? 0), 2, 'display posted nothing');
  });
  console.log('  ✓ display mutated nothing');
}
