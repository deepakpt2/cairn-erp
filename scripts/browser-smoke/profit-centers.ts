import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/profit-centers';
const ACTIVITY = 'CFG.COST.PROFITCENTER.DEFINE';
const REASON = 'Browser acceptance run';
const CENTRE = 'PC900';

/**
 * SCR-045 / KE51 browser acceptance: defining profit centres.
 *
 * The journey follows the period shape of the master: a period created
 * inside the tenant's controlling area, the same key refused again, an
 * overlapping period refused naming the period it collides with, the
 * period's facts changed, the centre locked for posting and unlocked
 * again, and the unused period deleted with its deletion documented.
 * The judged refusals a screen cannot reach — the responsible user
 * against the user directory, journal-guarded deletion — are asserted
 * in the service tests; this target asserts the journey an operator can
 * actually take.
 *
 * Everything asserted here is asserted twice: once in the browser,
 * because the screen is the product, and once in the database, because
 * a form that renders a value is not a form that stored it.
 */
export async function profitCentersKe51(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-045 KE51: verify the workbench route, the empty start, period creation, duplicate and overlap refusals, change, the posting lock, and deletion');

  // The fixture tenant must stand where the screen's prerequisite stands:
  // the controlling-area activity completed, this activity ready to run.
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into config_activity_status (client, activity_code, status, created_by)
      values (${client}, 'CFG.COST.CONTROLLINGAREA.DEFINE', 'COMPLETED', 'BROWSER_SMOKE')
      on conflict (client, activity_code) do update set status = 'COMPLETED'
    `);
    await tx.execute(sql`
      insert into config_activity_status (client, activity_code, status, created_by)
      values (${client}, ${ACTIVITY}, 'NOT_STARTED', 'BROWSER_SMOKE')
      on conflict (client, activity_code) do nothing
    `);
  });

  // ── 1. The workbench routes here; the area stands empty ──────────────────
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
  await page.getByRole('heading', { level: 1, name: 'Define Profit Centres', exact: true }).waitFor();
  assert.match(
    await page.locator('header .code').first().innerText(),
    new RegExp(`${ACTIVITY} · KE51`),
    'The screen says which activity and which reference transaction it is.',
  );
  await page.getByText('No profit centres are defined for this controlling area yet.').waitFor();
  console.log('  ✓ the workbench routes here and the controlling area stands empty');

  // ── 2. A period, with both texts and a segment ───────────────────────────
  const panel = page.locator('section[aria-labelledby="pc-create-title"]');
  await panel.locator('#pc-code').fill(CENTRE);
  await panel.locator('#pc-validFrom').fill('2026-01-01');
  await panel.locator('#pc-validTo').fill('9999-12-31');
  await panel.locator('#pc-name').fill('Acceptance Profit');
  await panel.locator('#pc-longText').fill('Acceptance Profit Centre (long)');
  await panel.locator('#pc-person').fill('Jane Doe');
  await panel.locator('#pc-segment').fill('SEG_ACC');
  await panel.locator('#pc-reason').fill(REASON);
  await panel.getByRole('button', { name: 'Create profit centre period', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Profit Centre ${CENTRE} created`) })
    .waitFor();
  const stored = await storedPeriod(client, CENTRE, '2026-01-01');
  assert.equal(stored?.name, 'Acceptance Profit', 'The short name is stored.');
  assert.equal(stored?.segment, 'SEG_ACC');
  const area = stored?.controlling_area as string;
  const created = await documents(client, `${area}/${CENTRE}/2026-01-01`);
  assert.equal(created.length, 1, 'One creation, one document.');
  assert.equal(created[0].reason, REASON, 'The reason is recorded.');
  assert.equal(
    created[0].items.find((item) => item.fieldName === 'segment')?.isSecurityRelevant,
    'true',
    'The segment is flagged security-relevant.',
  );
  console.log(`  ✓ the period stands in area ${area}, documented`);

  // ── 3. The same key again, and an overlapping period, are refused ────────
  await panel.locator('#pc-code').fill(CENTRE);
  await panel.locator('#pc-validFrom').fill('2026-01-01');
  await panel.locator('#pc-name').fill('Duplicate attempt');
  await panel.locator('#pc-reason').fill(REASON);
  await panel.getByRole('button', { name: 'Create profit centre period', exact: true }).click();
  await panel
    .getByRole('alert')
    .filter({ hasText: 'is already defined' })
    .waitFor();

  await panel.locator('#pc-code').fill(CENTRE);
  await panel.locator('#pc-validFrom').fill('2026-06-01');
  await panel.locator('#pc-validTo').fill('2026-12-31');
  await panel.locator('#pc-name').fill('Overlap attempt');
  await panel.locator('#pc-reason').fill(REASON);
  await panel.getByRole('button', { name: 'Create profit centre period', exact: true }).click();
  await panel
    .getByRole('alert')
    .filter({ hasText: 'overlaps the period 2026-01-01 to 9999-12-31' })
    .waitFor();
  assert.equal(
    await storedPeriod(client, CENTRE, '2026-06-01'),
    null,
    'The refused period left nothing behind.',
  );
  console.log('  ✓ the duplicate key and the overlapping period are refused');

  // ── 4. The period's facts change through the dialog ──────────────────────
  const row = page
    .locator('tr')
    .filter({ has: page.locator('td:first-child').getByText(CENTRE, { exact: true }) })
    .first();
  await row.getByText('Change', { exact: true }).first().click();
  const changeDialog = page.getByRole('dialog', { name: `Change ${CENTRE} · from 2026-01-01` });
  await changeDialog.locator('input[name="name"]').fill('Acceptance Centre v2');
  await changeDialog.locator('textarea[name="reason"]').fill(REASON);
  await changeDialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await changeDialog.getByRole('status').filter({ hasText: 'changed' }).waitFor();
  await closeDialog(changeDialog);
  assert.equal(
    (await storedPeriod(client, CENTRE, '2026-01-01'))?.name,
    'Acceptance Centre v2',
    'The renamed name is stored.',
  );
  console.log('  ✓ the change stores the renamed facts through the dialog');

  // ── 5. The posting lock round ────────────────────────────────────────────
  await row.getByText('Open').first().waitFor();
  await row.getByText('Lock', { exact: true }).first().click();
  const lockDialog = page.getByRole('dialog', { name: `Lock ${CENTRE} · from 2026-01-01` });
  await lockDialog.locator('textarea[name="reason"]').fill(REASON);
  await lockDialog.getByRole('button', { name: 'Lock profit centre', exact: true }).click();
  await closeDialog(lockDialog);
  await row.getByText('Locked').first().waitFor();
  assert.equal(
    (await storedPeriod(client, CENTRE, '2026-01-01'))?.is_posting_locked,
    true,
    'The lock is stored.',
  );
  await row.getByText('Unlock', { exact: true }).first().click();
  const unlockDialog = page.getByRole('dialog', { name: `Unlock ${CENTRE} · from 2026-01-01` });
  await unlockDialog.locator('textarea[name="reason"]').fill(REASON);
  await unlockDialog.getByRole('button', { name: 'Unlock profit centre', exact: true }).click();
  await closeDialog(unlockDialog);
  await row.getByText('Open').first().waitFor();
  console.log('  ✓ the centre locks for posting and opens again');

  // ── 6. The period deletes, and the deletion is documented ────────────────
  await row.getByText('Delete', { exact: true }).first().click();
  const deleteDialog = page.getByRole('dialog', { name: `Delete ${CENTRE} · from 2026-01-01` });
  await deleteDialog.locator('textarea[name="reason"]').fill(REASON);
  await deleteDialog.getByRole('button', { name: 'Delete profit centre period', exact: true }).click();
  await page.getByText('No profit centres are defined for this controlling area yet.').waitFor();
  assert.equal(
    await storedPeriod(client, CENTRE, '2026-01-01'),
    null,
    'The period is gone from the database.',
  );
  const gone = await documents(client, `${area}/${CENTRE}/2026-01-01`);
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
  centre: string,
  validFrom: string,
): Promise<Record<string, unknown> | null> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql`
      select controlling_area, name, segment, is_posting_locked
      from profit_center
      where profit_center = ${centre} and valid_from = ${validFrom}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

/** The documents this screen filed for a period, under the naming the service files on. */
async function documents(client: string, objectKey: string) {
  const all = await withTenant(client, (tx) => changeHistory(tx, client, 'profit_center', objectKey));
  return all.filter((document) => document.transactionCode === ACTIVITY);
}
