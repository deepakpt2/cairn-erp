import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import type { BrowserTarget } from './targets';
import { chooseClosed } from './closed-fields';

type Context = { page: Page; base: string; target: BrowserTarget };

const PARK = '/finance/journal/park';

/**
 * SCR-087 browser acceptance: park a journal entry (FV50).
 *
 * The journey: a balanced two-line document parks as PK-… with no
 * journal behind it, judges to COMPLETED, then posts through the
 * engine — the parked record standing POSTED and naming its
 * canonical document.
 */
export async function parkedJournalFv50(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-087: park, complete and post a journal, and verify the database');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'PARKDOC', subObject: '*',
      prefix: 'PK', numberLength: 7, createdBy: 'BROWSER_SMOKE',
    });
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'BROWSER_SMOKE',
    });
  });
  console.log('  ✓ parked number range stands');

  await page.goto(`${base}${PARK}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Park a Journal Entry', exact: true }).waitFor();
  const form = page.locator('section[aria-labelledby="pj-header"]');
  await chooseClosed(form, 'companyCode', '1000');
  await form.locator('input[name="documentDate"]').fill('2026-10-01');
  await form.locator('input[name="postingDate"]').fill('2026-10-01');
  await chooseClosed(form, 'currency', 'USD');
  await form.locator('input[name="reference"]').fill('PARK-2026-001');
  await form.getByLabel('G/L account').nth(0).fill('400000');
  await form.getByLabel('Amount').nth(0).fill('250');
  await form.getByLabel('G/L account').nth(1).fill('101000');
  await form.getByLabel('Debit or credit').nth(1).selectOption('H');
  await form.getByLabel('Amount').nth(1).fill('250');
  await form.getByRole('button', { name: 'Park document', exact: true }).click();
  await page.getByText(/Document parked as PK-\d+: debits 250\.00, credits 250\.00\. No account has moved\./).waitFor();
  console.log('  ✓ the document stands parked through the form');

  const before = await withTenant(client, async (tx) => {
    const parked = await tx.execute(sql`
      select parked_number from parked_journal_header where client = ${client} and status = 'PARKED'
    `);
    const journals = await tx.execute(sql`
      select count(*)::int as n from journal_entry where client = ${client} and status = 'POSTED'
    `);
    return {
      parked: (parked as unknown as { parked_number: string }[])[0]?.parked_number,
      journals: Number((journals as unknown as { n: number }[])[0]?.n ?? 0),
    };
  });
  assert.ok(before.parked?.startsWith('PK-'), 'parked number drawn');
  assert.equal(before.journals, 0, 'parking moved no account');
  console.log('  ✓ no journal stands behind the parked document');

  const list = page.locator('section[aria-labelledby="pj-list"]');
  await list.getByRole('button', { name: 'Save as complete', exact: true }).click();
  await page.getByText(/stands COMPLETED and ready to post\./).waitFor();
  await list.getByRole('button', { name: 'Post', exact: true }).click();
  await page.getByText(/posted as document \S+\./).waitFor();
  console.log('  ✓ completion judged and posting converted the parked document');

  await withTenant(client, async (tx) => {
    const headers = await tx.execute(sql`
      select status, posted_document_number from parked_journal_header where client = ${client}
    `);
    const [header] = headers as unknown as { status: string; posted_document_number: string }[];
    assert.equal(header.status, 'POSTED');
    assert.ok(header.posted_document_number, 'posted reference retained');
    const lines = await tx.execute(sql`
      select debit_credit, amount::text as amount from journal_entry_line
      where client = ${client} and document_number = ${header.posted_document_number} order by line_number
    `);
    const rows = (lines as unknown as { debit_credit: string; amount: string }[])
      .map((r) => ({ side: r.debit_credit, amount: r.amount }));
    assert.deepEqual(rows, [
      { side: 'S', amount: '250.0000' },
      { side: 'H', amount: '250.0000' },
    ]);
  });
  console.log('  ✓ the parked record names its posted document, balanced through the engine');
}
