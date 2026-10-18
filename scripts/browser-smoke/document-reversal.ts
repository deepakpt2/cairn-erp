import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postJournalEntry } from '../../src/platform/posting';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const REVERSAL = '/finance/document-reversal';

/**
 * SCR-072 browser acceptance: reverse accounting document.
 *
 * The journey: a posted journal stands displayed with its lines,
 * the reversal period is derived for the chosen posting date, and
 * the confirmed reversal posts a linked AB mirror — the original
 * standing REVERSED in the database, never edited or deleted.
 */
export async function documentReversalFb08(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-072: verify original display, derived period, AB reversal, and database evidence');

  let originalDocument = '';
  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'BROWSER_SMOKE',
    });
    const posted = await postJournalEntry(tx, {
      client, companyCode: '1000', documentType: 'SA',
      documentDate: '2026-10-02', postingDate: '2026-10-03',
      fiscalYear: 2026, postingPeriod: 10,
      currency: 'USD', localCurrency: 'USD',
      reference: 'BROW-REV-1', headerText: 'Browser reversal original',
      lines: [
        { glAccount: '100000', debitCredit: 'S', amount: '850.0000' },
        { glAccount: '200000', debitCredit: 'H', amount: '850.0000' },
      ],
      postedBy: 'BROWSER_SMOKE', transactionCode: 'FIN.DOCUMENT.REVERSE',
    });
    originalDocument = posted.documentNumber;
  });
  assert.ok(originalDocument, 'the original journal posted');
  console.log(`  ✓ an 850.00 journal stands posted as ${originalDocument}`);

  await page.goto(`${base}${REVERSAL}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Reverse Accounting Document', exact: true }).waitFor();
  const selection = page.locator('section[aria-labelledby="dr-selection"]');
  await selection.locator('input[name="companyCode"]').fill('1000');
  await selection.locator('input[name="documentNumber"]').fill(originalDocument);
  await selection.locator('input[name="fiscalYear"]').fill('2026');
  await selection.getByRole('button', { name: 'Display document', exact: true }).click();
  await page.waitForLoadState('networkidle');

  const review = page.locator('section[aria-labelledby="dr-review"]');
  await review.getByText(new RegExp(`SA document ${originalDocument.replaceAll('/', '\\/')} — POSTED`)).waitFor();
  await review.locator('tbody tr').nth(1).waitFor();
  await review.getByText(/Debits 850\.00 \/ credits 850\.00 USD/).waitFor();
  await review.getByText(/0 cleared line\(s\), clearing document for 0 item\(s\)/).waitFor();
  console.log('  ✓ the original displays its two lines and totals before any reversal');

  const deriveForm = review.locator('form').filter({ has: page.getByRole('button', { name: 'Derive period', exact: true }) });
  await deriveForm.locator('input[name="postingDate"]').fill('2026-11-20');
  await deriveForm.getByRole('button', { name: 'Derive period', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await review.getByText(/falls in fiscal year 2026, period 11/).waitFor();
  console.log('  ✓ posting date 2026-11-20 derives fiscal year 2026 period 11');

  const executeForm = review.locator('form').filter({ has: page.getByRole('button', { name: 'Reverse document', exact: true }) });
  await executeForm.locator('select[name="reasonCode"]').selectOption('01');
  await executeForm.locator('input[name="documentDate"]').fill('2026-11-05');
  await executeForm.locator('input[name="postingDate"]').fill('2026-11-20');
  await executeForm.locator('input[name="confirmed"]').check();
  await executeForm.getByRole('button', { name: 'Reverse document', exact: true }).click();
  await page.waitForLoadState('networkidle');

  const result = page.locator('section[aria-labelledby="dr-result"]');
  const done = result.getByText(/Reversal document .* stands posted as type AB in period 11/);
  await done.waitFor();
  const reversalDocument = (await done.textContent())?.match(/Reversal document (\S+) \(2026\)/)?.[1] ?? '';
  assert.ok(reversalDocument, 'the reversal document number is shown');
  assert.notEqual(reversalDocument, originalDocument);
  await review.getByText(new RegExp(`SA document ${originalDocument.replaceAll('/', '\\/')} — REVERSED`)).waitFor();
  console.log(`  ✓ reversal ${reversalDocument} stands posted as type AB in period 11`);

  const evidence = await withTenant(client, async (tx) => {
    const original = await tx.execute(sql`
      select status, reversed_by from journal_entry
      where client = ${client} and document_number = ${originalDocument} and fiscal_year = 2026
    `);
    const reversal = await tx.execute(sql`
      select document_type, status, reversal_of, document_date::text as dd, posting_date::text as pd, posting_period
      from journal_entry
      where client = ${client} and document_number = ${reversalDocument} and fiscal_year = 2026
    `);
    const lines = await tx.execute(sql`
      select debit_credit, amount_local::text as amount_local from journal_entry_line
      where client = ${client} and document_number = ${reversalDocument} and fiscal_year = 2026
      order by line_number
    `);
    const link = await tx.execute(sql`
      select reversal_reason, reversal_document_date::text as dd, reversal_posting_date::text as pd,
             reversal_posting_period, reversed_by
      from accounting_reversal_link
      where client = ${client} and original_document_number = ${originalDocument}
    `);
    return {
      original: (original as unknown as Array<{ status: string; reversed_by: string }>)[0],
      reversal: (reversal as unknown as Array<Record<string, unknown>>)[0],
      lines: lines as unknown as Array<{ debit_credit: string; amount_local: string }>,
      link: (link as unknown as Array<Record<string, unknown>>)[0],
    };
  });
  assert.equal(evidence.original.status, 'REVERSED');
  assert.equal(evidence.original.reversed_by, reversalDocument);
  assert.equal(evidence.reversal.document_type, 'AB');
  assert.equal(evidence.reversal.status, 'POSTED');
  assert.equal(evidence.reversal.reversal_of, originalDocument);
  assert.equal(evidence.reversal.dd, '2026-11-05');
  assert.equal(evidence.reversal.pd, '2026-11-20');
  assert.equal(evidence.reversal.posting_period, 11);
  assert.deepEqual(evidence.lines.map((l) => l.debit_credit), ['H', 'S']);
  assert.deepEqual(evidence.lines.map((l) => l.amount_local), ['850.0000', '850.0000']);
  assert.equal(evidence.link.reversal_reason, '01');
  assert.equal(evidence.link.dd, '2026-11-05');
  assert.equal(evidence.link.pd, '2026-11-20');
  assert.equal(evidence.link.reversal_posting_period, 11);
  console.log('  ✓ the database holds the REVERSED original, the AB mirror with swapped lines, and the link');
}
