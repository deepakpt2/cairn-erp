import type { Page } from '@playwright/test'; // eslint-disable-line @typescript-eslint/no-unused-vars
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/retained-earnings';

/**
 * SCR-121 browser acceptance: retained earnings account definition (OB53).
 *
 * The journey: the standard package's seeded indicator X stands on the
 * definition grid; a second indicator is defined through the screen and
 * lands as a determination row with a change document; deleting the
 * seeded indicator refuses because the delivered P&L accounts carry it;
 * and FS00 refuses to save a P&L account under an undefined indicator,
 * naming OB53, leaving the stored account untouched.
 */
export async function retainedEarnings(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-121: define retained earnings per indicator, FS00 forcing rule');

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { name: 'Retained Earnings Account', exact: true }).waitFor();
  const grid = page.locator('section[aria-labelledby="re-list"]');
  const seeded = grid.locator('tr', { hasText: '290000' });
  await seeded.getByText('CA01', { exact: true }).waitFor();
  await seeded.getByText('X', { exact: true }).waitFor();
  console.log('  ✓ the package-seeded indicator X stands defined for chart CA01');

  const maintainForm = page.locator('section[aria-labelledby="re-maintain"] form');
  await maintainForm.locator('[name="chartOfAccounts"]').selectOption('CA01');
  await maintainForm.locator('[name="indicator"]').fill('Z');
  await maintainForm.locator('[name="glAccount"]').fill('291000');
  await maintainForm.locator('[name="reason"]').fill('Browser acceptance: second indicator');
  await maintainForm.getByRole('button', { name: 'Save determination', exact: true }).click();
  await page.getByText('Indicator Z of chart CA01 closes to account 291000.', { exact: true }).waitFor();
  await grid.locator('tr', { hasText: '291000' }).getByText('Z', { exact: true }).waitFor();
  console.log('  ✓ indicator Z is defined through the screen');

  const deleteForm = page.locator('section[aria-labelledby="re-delete"] form');
  await deleteForm.locator('[name="chartOfAccounts"]').fill('CA01');
  await deleteForm.locator('[name="indicator"]').fill('X');
  await deleteForm.locator('[name="reason"]').fill('Browser acceptance: in-use deletion');
  await deleteForm.getByRole('button', { name: 'Delete determination', exact: true }).click();
  await page.getByText(/cannot be deleted/).waitFor();
  console.log('  ✓ deleting the seeded indicator refuses while P&L accounts carry it');

  await page.goto(`${base}/config/gl-accounts/edit?chart=CA01&account=300000`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const edit = page.locator('section[aria-labelledby="gl-master-field-title"]');
  await edit.waitFor();
  const indicator = edit.locator('[name="retainedEarningsIndicator"]');
  assert.equal(await indicator.inputValue(), 'X');
  await indicator.fill('Q');
  await edit.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText(/No retained earnings account stands defined \(OB53\) for indicator Q/).waitFor();
  console.log('  ✓ FS00 refuses the undefined indicator, naming OB53');

  const truth = await withTenant(client, async (tx) => {
    const determinations = await tx.execute(sql`
      select general_modifier as indicator, gl_account from account_determination
      where client = ${client} and chart_of_accounts = 'CA01' and event = 'RETAINED_EARNINGS'
      order by general_modifier
    `) as unknown as Array<{ indicator: string; gl_account: string }>;
    const account = await tx.execute(sql`
      select retained_earnings_indicator as indicator from gl_account
      where client = ${client} and chart_of_accounts = 'CA01' and account_number = '300000'
    `) as unknown as Array<{ indicator: string | null }>;
    const documents = await tx.execute(sql`
      select count(*)::int as n from change_document
      where client = ${client} and object_class = 'retained_earnings_account'
    `) as unknown as Array<{ n: number }>;
    return { determinations, indicator: account[0]?.indicator ?? null, documents: documents[0]?.n ?? 0 };
  });
  assert.deepEqual(truth.determinations.map((row) => ({ ...row })), [
    { indicator: 'X', gl_account: '290000' },
    { indicator: 'Z', gl_account: '291000' },
  ]);
  assert.equal(truth.indicator, 'X', 'the refused FS00 save left the stored indicator untouched');
  assert.ok(truth.documents >= 1, 'the screen save recorded a change document');
  console.log('  ✓ determinations, the untouched account and the change document stand in the database');
}
