import type { Locator, Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/account-determination';
const ACTIVITY = 'CFG.FIN.ACCTDET.DEFINE';
const REASON = 'Browser acceptance run';

/**
 * SCR-040 / OBYC browser acceptance: defining account determination.
 *
 * The screen is a master-detail pair — chart and event heading, the rows
 * under them — so the journey follows that shape: an inventory row created
 * with an account the screen itself offers (the chart's balance-sheet
 * accounts only), the duplicate refused, an offsetting row carrying the
 * extra dimension its event uses (valuation class and general modifier,
 * profit-and-loss accounts offered), the inventory account redirected by
 * change, and the offsetting row deleted with its deletion documented.
 *
 * Everything asserted here is asserted twice: once in the browser, because
 * the screen is the product, and once in the database, because a form that
 * renders a value is not a form that stored it. The service's judging
 * refusals — modifier-for-event, class standing, wrong kind, each named —
 * are asserted in the service tests; this target asserts the journey an
 * operator can actually take.
 */
export async function accountDeterminationObyc(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-040 OBYC: verify the workbench route, the master-detail start, the inventory row, the duplicate refusal, the offsetting row with its modifier, the redirect, and deletion');

  // ── 1. The workbench routes here; nothing stands until chart+event ────────
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
  await page.getByRole('heading', { level: 1, name: 'Define Account Determination', exact: true }).waitFor();
  assert.match(
    await page.locator('header .code').first().innerText(),
    new RegExp(`${ACTIVITY} · OBYC`),
    'The screen says which activity and which reference transaction it is.',
  );
  await page.getByText('Choose a chart of accounts and a posting event to see its determination rows.').waitFor();

  const panel = page.locator('section[aria-labelledby="acct-det-create-title"]');
  const chart = await chooseFirstOption(panel.locator('#acct-det-chart'));
  await panel.locator('#acct-det-event').selectOption('INVENTORY');
  await page.getByText('No determination rows stand for this chart and event.').waitFor();
  console.log(`  ✓ the workbench routes here and chart ${chart} + Inventory posting stand empty`);

  // ── 2. The inventory row, with an account the screen itself offers ────────
  const firstAccount = await chooseFirstOption(panel.locator('#acct-det-gl-account'));
  await panel.locator('#acct-det-reason').fill(REASON);
  await panel.getByRole('button', { name: 'Create determination', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Determination for Inventory posting in chart ${chart} defined`) })
    .waitFor();
  const storedFirst = await storedAccount(client, chart, 'INVENTORY', '', '');
  assert.equal(storedFirst, firstAccount, 'The offered account is what was stored.');
  const created = await documents(client, `${chart}/INVENTORY/ANY/NONE`);
  assert.equal(created.length, 1, 'One creation, one document.');
  assert.equal(created[0].reason, REASON, 'The reason is recorded, as the screen promises.');
  assert.equal(
    created[0].items.find((item) => item.fieldName === 'glAccount')?.isSecurityRelevant,
    'true',
    'The account is flagged security-relevant.',
  );
  console.log(`  ✓ the inventory row stands on ${firstAccount}, stored and documented`);

  // ── 3. The same key again is refused ──────────────────────────────────────
  // Every field is set again rather than trusted to have survived the
  // save's re-render (the OB08 target's lesson).
  await panel.locator('#acct-det-chart').selectOption(chart);
  await panel.locator('#acct-det-event').selectOption('INVENTORY');
  await panel.locator('#acct-det-gl-account').selectOption(firstAccount);
  await panel.locator('#acct-det-reason').fill(REASON);
  await panel.getByRole('button', { name: 'Create determination', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: /already stands with these modifiers/ })
    .waitFor();
  assert.equal((await documents(client, `${chart}/INVENTORY/ANY/NONE`)).length, 1, 'A refused duplicate files no document.');
  console.log('  ✓ defining the same key again is refused and files nothing');

  // ── 4. The offsetting row, with valuation class and general modifier ──────
  await panel.locator('#acct-det-event').selectOption('OFFSETTING_INVENTORY');
  await panel.locator('#acct-det-modifier').fill('VBR');
  const offsetAccount = await chooseFirstOption(panel.locator('#acct-det-gl-account'));
  await panel.locator('#acct-det-reason').fill(REASON);
  await panel.getByRole('button', { name: 'Create determination', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Determination for Offsetting entry for inventory in chart ${chart} defined`) })
    .waitFor();
  assert.equal(
    await storedAccount(client, chart, 'OFFSETTING_INVENTORY', '', 'VBR'),
    offsetAccount,
    'The offsetting row stands under its modifier.',
  );
  console.log(`  ✓ the offsetting row stands under modifier VBR on ${offsetAccount}`);

  // ── 5. A change redirects the inventory account ───────────────────────────
  await panel.locator('#acct-det-event').selectOption('INVENTORY');
  const row = gridRow(page, firstAccount);
  await row.waitFor();
  await row.getByText('Change', { exact: true }).first().click();
  const changeDialog = page.getByRole('dialog', { name: /^Change/ });
  await changeDialog.waitFor();
  const suffix = `${chart}-INVENTORY-ANY-NONE`;
  const glSelect = changeDialog.locator(`#acct-det-${suffix}-gl-account`);
  const values = (await glSelect.locator('option').all()).map(async (option) => option.getAttribute('value'));
  const secondAccount = (await Promise.all(values)).find((value) => value && value !== firstAccount);
  assert.ok(secondAccount, 'The chart offers a second balance-sheet account to redirect onto.');
  await glSelect.selectOption(secondAccount as string);
  await changeDialog.locator(`#acct-det-change-reason-${suffix}`).fill(REASON);
  await changeDialog.getByRole('button', { name: 'Save determination', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Determination for Inventory posting in chart ${chart} updated`) })
    .waitFor();
  assert.equal(await storedAccount(client, chart, 'INVENTORY', '', ''), secondAccount, 'The redirected account is stored.');
  await closeDialog(changeDialog);
  console.log(`  ✓ the inventory row now derives ${secondAccount}`);

  // ── 6. The offsetting row is deleted, and the deletion is filed ───────────
  await panel.locator('#acct-det-event').selectOption('OFFSETTING_INVENTORY');
  const offsetRow = gridRow(page, offsetAccount);
  await offsetRow.waitFor();
  await offsetRow.getByText('Delete', { exact: true }).first().click();
  const deleteDialog = page.getByRole('dialog', { name: /^Delete/ });
  await deleteDialog.waitFor();
  const offsetSuffix = `${chart}-OFFSETTING_INVENTORY-ANY-VBR`;
  await deleteDialog.locator(`#acct-det-delete-reason-${offsetSuffix}`).fill(REASON);
  await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForFunction(
    (account) => ![...document.querySelectorAll('section[aria-labelledby="acct-det-grid-title"] tbody tr')]
      .some((tr) => (tr as HTMLElement).innerText.includes(account)),
    offsetAccount,
  );
  assert.equal(await storedAccount(client, chart, 'OFFSETTING_INVENTORY', '', 'VBR'), null, 'The offsetting row is gone.');
  const offsetDocs = await documents(client, `${chart}/OFFSETTING_INVENTORY/ANY/VBR`);
  assert.equal(offsetDocs.length, 2, 'Creation and deletion: two documents.');
  assert.equal(offsetDocs.find((document) => document.changeType === 'DELETE')?.reason, REASON);
  console.log('  ✓ the offsetting row is deleted, and the deletion is documented');

  console.log('SCR-040 OBYC passed: workbench route, master-detail, creation, duplicate refusal, modifier row, redirect, deletion');
}

/** The first real (non-placeholder) value a select offers, asserting it offers one. */
async function chooseFirstOption(select: Locator): Promise<string> {
  const values = (await select.locator('option').all()).map(async (option) => option.getAttribute('value'));
  const first = (await Promise.all(values)).find((value) => value);
  assert.ok(first, 'The select offers at least one value.');
  await select.selectOption(first as string);
  return first as string;
}

function gridRow(page: Page, account: string): Locator {
  return page
    .locator('section[aria-labelledby="acct-det-grid-title"]')
    .locator('tbody tr')
    .filter({ hasText: account })
    .first();
}

/** Close a dialog rather than reloading: the run signs out from this page at the end. */
async function closeDialog(dialog: Locator) {
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

async function storedAccount(
  client: string,
  chart: string,
  event: string,
  valuationClass: string,
  generalModifier: string,
): Promise<string | null> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql`
      select gl_account from account_determination
      where chart_of_accounts = ${chart} and event = ${event}
        and valuation_class = ${valuationClass} and general_modifier = ${generalModifier}
    `),
  )) as unknown as Array<{ gl_account: string }>;
  return rows[0]?.gl_account ?? null;
}

/** The documents this screen filed for a key, under the naming the service files on. */
async function documents(client: string, objectKey: string) {
  const all = await withTenant(client, (tx) => changeHistory(tx, client, 'account_determination', objectKey));
  return all.filter((document) => document.transactionCode === ACTIVITY);
}
