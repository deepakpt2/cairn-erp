import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/activity-types';
const ACTIVITY = 'CFG.COST.ACTIVITYTYPE.DEFINE';
const REASON = 'Browser acceptance run';
const TYPE = 'LAB01';

/**
 * SCR-043 / KL01 browser acceptance: defining activity types.
 *
 * The journey follows the period shape of the master: a period created
 * inside the fixture tenant's controlling area with the unit the global
 * table offers, an overlapping period refused naming the period it
 * collides with, the period's facts changed, the type locked for
 * posting and unlocked again, and the period deleted. The judged
 * refusals that a screen cannot reach — a unit that does not stand,
 * digit and category catalogues — are asserted in the service tests;
 * this target asserts the journey an operator can actually take and
 * the documents it files.
 *
 * Everything asserted here is asserted twice: once in the browser,
 * because the screen is the product, and once in the database, because
 * a form that renders a value is not a form that stored it.
 */
export async function activityTypesKl01(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-043 KL01: verify the workbench route, the empty start, period creation, overlap refusal, change, the posting lock, and deletion');

  // The fixture tenant must stand where the screen's prerequisite stands:
  // the cost-centre activity completed, this activity ready to run.
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into config_activity_status (client, activity_code, status, created_by)
      values (${client}, 'CFG.COST.COSTCENTER.DEFINE', 'COMPLETED', 'BROWSER_SMOKE')
      on conflict (client, activity_code) do update set status = 'COMPLETED'
    `);
    await tx.execute(sql`
      insert into config_activity_status (client, activity_code, status, created_by)
      values (${client}, ${ACTIVITY}, 'NOT_STARTED', 'BROWSER_SMOKE')
      on conflict (client, activity_code) do nothing
    `);
  });

  // ── 1. The workbench routes here; the area stands empty ───────────────────
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
  await page.getByRole('heading', { level: 1, name: 'Define Activity Types', exact: true }).waitFor();
  assert.match(
    await page.locator('header .code').first().innerText(),
    new RegExp(`${ACTIVITY} · KL01`),
    'The screen says which activity and which reference transaction it is.',
  );
  await page.getByText('No activity types are defined for this controlling area yet.').waitFor();
  console.log('  ✓ the workbench routes here and the controlling area stands empty');

  // ── 2. A period, measured in a unit the global table offers ───────────────
  const panel = page.locator('section[aria-labelledby="act-type-create-title"]');
  await panel.locator('input[name="activityType"]').fill(TYPE);
  await panel.locator('input[name="validFrom"]').fill('2026-01-01');
  await panel.locator('input[name="validTo"]').fill('9999-12-31');
  await panel.locator('input[name="name"]').fill('Direct Labor Hours');
  await panel.locator('select[name="activityUnit"]').selectOption('HR');
  await panel.locator('select[name="category"]').selectOption('1');
  await panel.locator('select[name="priceIndicator"]').selectOption('3');
  await panel.locator('input[name="validCcCategories"][value="PRODUCTION"]').check();
  await panel.locator('input[name="validCcCategories"][value="SERVICE"]').check();
  await panel.locator('textarea[name="reason"]').fill(REASON);
  await panel.getByRole('button', { name: 'Create activity type period', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Activity Type ${TYPE} created`) })
    .waitFor();
  const stored = await storedPeriod(client, TYPE, '2026-01-01');
  assert.equal(stored?.activity_unit, 'HR', 'The offered unit is stored.');
  assert.equal(stored?.category, '1');
  assert.equal(stored?.price_indicator, '3');
  assert.equal(
    stored?.valid_cc_categories,
    'PRODUCTION,SERVICE',
    'The categories are stored as the canonical subset.',
  );
  const area = stored?.controlling_area as string;
  const created = await documents(client, `${area}/${TYPE}/2026-01-01`);
  assert.equal(created.length, 1, 'One creation, one document.');
  assert.equal(created[0].reason, REASON, 'The reason is recorded.');
  assert.equal(
    created[0].items.find((item) => item.fieldName === 'activityUnit')?.isSecurityRelevant,
    'true',
    'The unit is flagged security-relevant.',
  );
  console.log(`  ✓ the period stands in area ${area} measured in HR, documented`);

  // ── 3. An overlapping period is refused, naming the period it collides with ─
  await panel.locator('input[name="activityType"]').fill(TYPE);
  await panel.locator('input[name="validFrom"]').fill('2026-06-01');
  await panel.locator('input[name="validTo"]').fill('2026-12-31');
  await panel.locator('input[name="name"]').fill('Overlap attempt');
  await panel.locator('select[name="activityUnit"]').selectOption('HR');
  await panel.locator('textarea[name="reason"]').fill(REASON);
  await panel.getByRole('button', { name: 'Create activity type period', exact: true }).click();
  await panel
    .getByRole('alert')
    .filter({ hasText: 'overlaps the period 2026-01-01 to 9999-12-31' })
    .waitFor();
  assert.equal(
    await storedPeriod(client, TYPE, '2026-06-01'),
    null,
    'The refused period left nothing behind.',
  );
  console.log('  ✓ the overlapping period is refused and named; nothing stands behind it');

  // ── 4. The period's facts change through the dialog ────────────────────────
  const row = page
    .locator('tr')
    .filter({ has: page.locator('td:first-child').getByText(TYPE, { exact: true }) })
    .first();
  await row.getByRole('button', { name: 'Change', exact: true }).click();
  const changeDialog = page.getByRole('dialog', { name: `Change ${TYPE} · from 2026-01-01` });
  await changeDialog.locator('input[name="name"]').fill('Direct Labor Hours (renamed)');
  await changeDialog.locator('select[name="category"]').selectOption('3');
  await changeDialog.locator('textarea[name="reason"]').fill(REASON);
  await changeDialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await changeDialog.getByRole('status').filter({ hasText: 'changed' }).waitFor();
  await closeDialog(changeDialog);
  assert.equal(
    (await storedPeriod(client, TYPE, '2026-01-01'))?.name,
    'Direct Labor Hours (renamed)',
    'The renamed name is stored.',
  );
  assert.equal((await storedPeriod(client, TYPE, '2026-01-01'))?.category, '3');
  console.log('  ✓ the change stores the renamed facts through the dialog');

  // ── 5. The posting lock round ─────────────────────────────────────────────
  await row.getByText('Open').first().waitFor();
  await row.getByRole('button', { name: 'Lock', exact: true }).click();
  const lockDialog = page.getByRole('dialog', { name: `Lock ${TYPE} · from 2026-01-01` });
  await lockDialog.locator('textarea[name="reason"]').fill(REASON);
  await lockDialog.getByRole('button', { name: 'Lock activity type', exact: true }).click();
  await row.getByText('Locked').first().waitFor();
  assert.equal(
    (await storedPeriod(client, TYPE, '2026-01-01'))?.is_posting_locked,
    true,
    'The lock is stored.',
  );
  await row.getByRole('button', { name: 'Unlock', exact: true }).click();
  const unlockDialog = page.getByRole('dialog', { name: `Unlock ${TYPE} · from 2026-01-01` });
  await unlockDialog.locator('textarea[name="reason"]').fill(REASON);
  await unlockDialog.getByRole('button', { name: 'Unlock activity type', exact: true }).click();
  await row.getByText('Open').first().waitFor();
  console.log('  ✓ the type locks for posting and opens again');

  // ── 6. The period deletes, and the deletion is documented ────────────────
  await row.getByRole('button', { name: 'Delete', exact: true }).click();
  const deleteDialog = page.getByRole('dialog', { name: `Delete ${TYPE} · from 2026-01-01` });
  await deleteDialog.locator('textarea[name="reason"]').fill(REASON);
  await deleteDialog.getByRole('button', { name: 'Delete activity type period', exact: true }).click();
  await page.getByText('No activity types are defined for this controlling area yet.').waitFor();
  assert.equal(
    await storedPeriod(client, TYPE, '2026-01-01'),
    null,
    'The period is gone from the database.',
  );
  const gone = await documents(client, `${area}/${TYPE}/2026-01-01`);
  assert.ok(
    gone.some((document) => document.changeType === 'DELETE'),
    'The deletion is documented.',
  );
  console.log('  ✓ the period is deleted and the deletion is documented');
}

/** Close a dialog rather than reloading: the run signs out from this page at the end. */
async function closeDialog(dialog: ReturnType<Page['getByRole']>) {
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

async function storedPeriod(
  client: string,
  type: string,
  validFrom: string,
): Promise<Record<string, unknown> | null> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql`
      select controlling_area, name, activity_unit, category::text as category,
             price_indicator::text as price_indicator, valid_cc_categories, is_posting_locked
      from activity_type
      where activity_type = ${type} and valid_from = ${validFrom}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

/** The documents this screen filed for a period, under the naming the service files on. */
async function documents(client: string, objectKey: string) {
  const all = await withTenant(client, (tx) => changeHistory(tx, client, 'activity_type', objectKey));
  return all.filter((document) => document.transactionCode === ACTIVITY);
}
