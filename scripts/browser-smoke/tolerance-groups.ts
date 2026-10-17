import type { Locator, Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/tolerance-groups';
const ACTIVITY = 'CFG.FIN.TOLERANCE.DEFINE';
const COMPANY = '1000';
const GROUP = 'TG01';
const REASON = 'Browser acceptance run';

/**
 * SCR-039 / OBA4 browser acceptance: defining employee tolerance groups.
 *
 * Nothing delivers groups, so this registry starts empty — the opposite of
 * the document-types screen beside it. The journey covers the contract the
 * owner settled (R-88) as an operator meets it: the tenant-wide default
 * group created with both key parts blank, a company group whose optional
 * differences default to zero, a duplicate refused, a change — and the
 * absence that is itself a ruling, no Delete offered anywhere, the screen
 * stating why where an operator would look for it.
 *
 * Everything asserted here is asserted twice: once in the browser, because
 * the screen is the product, and once in the database, because a form that
 * renders a value is not a form that stored it. The service's own refusals
 * are asserted in the service tests; this target asserts the journey an
 * operator can actually take.
 */
export async function toleranceGroupsOba4(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-039 OBA4: verify the workbench route, the empty start, the tenant-wide default group, the company group, the duplicate refusal, a change, and that no deletion is offered');

  // ── 1. The workbench routes here and the registry starts empty ────────────
  await page.goto(`${base}/config`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const workbenchRow = page.locator('tr').filter({ hasText: ACTIVITY }).first();
  await workbenchRow.waitFor();
  assert.equal(
    await workbenchRow.getByRole('link', { name: 'Open', exact: true }).getAttribute('href'),
    ROUTE,
    'The workbench opens the screen that can do the work.',
  );

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Define Employee Tolerance Groups', exact: true }).waitFor();
  assert.match(
    await page.locator('header .code').first().innerText(),
    new RegExp(`${ACTIVITY} · OBA4`),
    'The screen says which activity and which reference transaction it is.',
  );
  await page.getByText('No tolerance groups are defined in this tenant.').waitFor();
  // The no-deletion ruling is stated on the screen, not discovered by its absence alone.
  await page.getByText(/Tolerance groups cannot be deleted yet/).waitFor();
  console.log('  ✓ the workbench routes here and the registry starts empty, with the no-deletion position stated');

  // ── 2. The tenant-wide default group, both key parts blank ────────────────
  const panel = page.locator('section[aria-labelledby="tol-group-create-title"]');
  await fillLimits(page);
  await panel.getByRole('button', { name: 'Create tolerance group', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: /Tolerance Group Default group defined for All company codes/ })
    .waitFor();
  const defaultStored = await storedGroup(client, '', '');
  assert.equal(defaultStored?.max_document_amount, '100000.00', 'The document ceiling is stored as submitted.');
  assert.equal(defaultStored?.max_cash_discount_percent, '3.000', 'And the discount ceiling at its scale.');
  const defaultDocs = await documents(client, 'ALL/DEFAULT');
  assert.equal(defaultDocs.length, 1, 'One creation, one document.');
  assert.equal(defaultDocs[0].reason, REASON, 'The reason is recorded, as the screen promises.');
  assert.equal(
    defaultDocs[0].items.find((item) => item.fieldName === 'maxDocumentAmount')?.isSecurityRelevant,
    'true',
    'The limits are flagged security-relevant.',
  );
  console.log('  ✓ the tenant-wide default group stands with both key parts blank, stored and documented');

  // ── 3. The same blank key again is refused ────────────────────────────────
  await fillLimits(page);
  await panel.getByRole('button', { name: 'Create tolerance group', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: /The default group is already defined/ })
    .waitFor();
  assert.equal((await documents(client, 'ALL/DEFAULT')).length, 1, 'A refused duplicate files no document.');
  console.log('  ✓ defining the default group again is refused and files nothing');

  // ── 4. A company group, its optional differences left blank ───────────────
  await panel.locator('#tol-group-company').selectOption(COMPANY);
  await panel.locator('#tol-group-key').fill(GROUP);
  await panel.locator('#tol-group-maxDocumentAmount').fill('50000.00');
  await panel.locator('#tol-group-maxLineAmount').fill('0.00');
  await panel.locator('#tol-group-maxCashDiscountPercent').fill('5.000');
  await panel.locator('#tol-group-reason').fill(REASON);
  await panel.getByRole('button', { name: 'Create tolerance group', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Tolerance Group ${GROUP} defined for ${COMPANY}`) })
    .waitFor();
  const companyStored = await storedGroup(client, COMPANY, GROUP);
  assert.equal(companyStored?.max_line_amount, '0.00', 'The zero line ceiling stands: no ceiling, as stated.');
  assert.equal(companyStored?.payment_diff_revenue_amount, '0.00', 'The blank payment differences defaulted to zero.');
  console.log(`  ✓ ${GROUP} defined for ${COMPANY}, its blank differences standing at zero`);

  // ── 5. A change corrects a limit — and no Delete is offered ───────────────
  const row = gridRow(page, GROUP);
  await row.waitFor();
  assert.equal(await row.getByText('Delete', { exact: true }).count(), 0, 'No Delete is offered on any row.');
  const dialog = await openDialog(page, GROUP);
  await dialog.locator(`#tol-group-${COMPANY}-${GROUP}-maxLineAmount`).fill('25000.00');
  await dialog.locator(`#tol-group-change-reason-${COMPANY}-${GROUP}`).fill(REASON);
  await dialog.getByRole('button', { name: 'Save tolerance group', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Tolerance Group ${GROUP} for ${COMPANY} updated`) })
    .waitFor();
  assert.equal((await storedGroup(client, COMPANY, GROUP))?.max_line_amount, '25000.00', 'The corrected line ceiling is stored.');
  await closeDialog(dialog);
  console.log(`  ✓ ${GROUP} changed on screen and in the registry, with no Delete offered`);

  console.log('SCR-039 OBA4 passed: workbench route, empty start, tenant-wide default, company group, duplicate refusal, change, no deletion');
}

const LIMIT_DEFAULTS: Array<[string, string]> = [
  ['maxDocumentAmount', '100000.00'],
  ['maxLineAmount', '50000.00'],
  ['maxCashDiscountPercent', '3.000'],
  ['paymentDiffRevenueAmount', '10.00'],
  ['paymentDiffExpenseAmount', '10.00'],
  ['paymentDiffRevenuePercent', '0.5'],
  ['paymentDiffExpensePercent', '0.5'],
];

/**
 * Fill the create panel's limits (and reason) from scratch: uncontrolled
 * fields do not survive a save's re-render, so a retry that trusted them
 * would be refused for the wrong reason (the OB08 target's lesson).
 */
async function fillLimits(page: Page) {
  const panel = page.locator('section[aria-labelledby="tol-group-create-title"]');
  for (const [name, value] of LIMIT_DEFAULTS) {
    await panel.locator(`#tol-group-${name}`).fill(value);
  }
  await panel.locator('#tol-group-reason').fill(REASON);
}

function gridRow(page: Page, groupKey: string): Locator {
  return page
    .locator('section[aria-labelledby="tol-group-grid-title"]')
    .locator('tbody tr')
    .filter({ hasText: groupKey })
    .first();
}

async function openDialog(page: Page, groupKey: string): Promise<Locator> {
  const row = gridRow(page, groupKey);
  await row.waitFor();
  await row.getByText('Change', { exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: /^Change/ });
  await dialog.waitFor();
  return dialog;
}

/** Close a dialog rather than reloading: the run signs out from this page at the end. */
async function closeDialog(dialog: Locator) {
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

async function storedGroup(client: string, companyCode: string, groupKey: string) {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql`
      select max_document_amount, max_line_amount, max_cash_discount_percent, payment_diff_revenue_amount
      from employee_tolerance_group
      where company_code = ${companyCode} and group_key = ${groupKey}
    `),
  )) as unknown as Array<{
    max_document_amount: string; max_line_amount: string;
    max_cash_discount_percent: string; payment_diff_revenue_amount: string;
  }>;
  return rows[0] ?? null;
}

/** The documents this screen filed for a group, under the key the service files on. */
async function documents(client: string, objectKey: string) {
  const all = await withTenant(client, (tx) => changeHistory(tx, client, 'employee_tolerance_group', objectKey));
  return all.filter((document) => document.transactionCode === ACTIVITY);
}
