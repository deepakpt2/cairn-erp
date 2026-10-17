import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/activity-rates';
const ACTIVITY = 'CFG.COST.ACTIVITYRATE.CONFIRM';
const REASON = 'Browser acceptance run';
const CENTRE = 'CC9001';
const TYPE = 'LAB01';

/**
 * SCR-044 / KP26 browser acceptance: planning activity prices.
 *
 * The journey follows the matrix shape of the screen: the workbench
 * route, masters seeded through the service layer so the screen has
 * something to plan against, a two-period plan saved and read back from
 * the database, the plan changed, and a period row deleted with its
 * deletion documented. The judged refusals a grid cannot show — a
 * master not valid in a period, an automatic indicator refusing entered
 * prices, the masters' deletion judges — are asserted in the service
 * tests; this target asserts the journey an operator can take.
 *
 * Everything asserted here is asserted twice: once in the browser,
 * because the screen is the product, and once in the database, because
 * a form that renders a value is not a form that stored it.
 */
export async function activityRatesKp26(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-044 KP26: verify the workbench route, masters seeded, the matrix save, the change, and the documented deletion');

  // The fixture tenant must stand where the screen's prerequisite
  // stands, with masters the screen can plan against.
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into config_activity_status (client, activity_code, status, created_by)
      values (${client}, 'CFG.COST.ACTIVITYTYPE.DEFINE', 'COMPLETED', 'BROWSER_SMOKE')
      on conflict (client, activity_code) do update set status = 'COMPLETED'
    `);
    await tx.execute(sql`
      insert into config_activity_status (client, activity_code, status, created_by)
      values (${client}, ${ACTIVITY}, 'NOT_STARTED', 'BROWSER_SMOKE')
      on conflict (client, activity_code) do nothing
    `);
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
      values (${client}, 'A000', ${CENTRE}, '2026-01-01', '9999-12-31', 'Acceptance centre', 'PRODUCTION', '1000', 'BROWSER_SMOKE')
      on conflict (client, controlling_area, cost_center, valid_from) do nothing
    `);
    await tx.execute(sql`
      insert into activity_type (client, controlling_area, activity_type, valid_from, valid_to, name, activity_unit, category, price_indicator, valid_cc_categories, created_by)
      values (${client}, 'A000', ${TYPE}, '2026-01-01', '9999-12-31', 'Acceptance labour', 'HR', '1', '3', '', 'BROWSER_SMOKE')
      on conflict (client, controlling_area, activity_type, valid_from) do nothing
    `);
  });

  // ── 1. The workbench routes here; the matrix shows periods ───────────────
  await page.goto(`${base}/config`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const workbenchRow = page.locator('tr').filter({ hasText: ACTIVITY }).first();
  await workbenchRow.waitFor();
  assert.equal(
    await workbenchRow.getByRole('link', { name: 'Open', exact: true }).getAttribute('href'),
    ROUTE,
    'The workbench opens the screen that can do the work.',
  );

  await page.goto(`${base}${ROUTE}?area=A000&version=000&year=2026&center=${CENTRE}&type=${TYPE}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Plan Activity Prices', exact: true }).waitFor();
  assert.match(
    await page.locator('header .code').first().innerText(),
    new RegExp(`${ACTIVITY} · KP26`),
    'The screen says which activity and which reference transaction it is.',
  );
  await page.getByLabel('Planned activity period 1').waitFor();
  console.log('  ✓ the workbench routes here and the period matrix stands');

  // ── 2. A plan across two periods saves and reads back ────────────────────
  await page.getByLabel('Planned activity period 1').fill('160');
  await page.getByLabel('Fixed price period 1').fill('50');
  await page.getByLabel('Variable price period 1').fill('10');
  await page.getByLabel('Planned activity period 2').fill('150');
  await page.getByLabel('Fixed price period 2').fill('50');
  // Capture the other cells as zeros: untouched cells submit as zero rows.
  await page.locator('#act-rate-reason').fill(REASON);
  await page.getByRole('button', { name: 'Save plan', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: /Plan saved for CC9001 \/ LAB01/ })
    .waitFor();
  const period1 = await storedRate(client, 1);
  assert.equal(period1?.planned_quantity, '160.000', 'The quantity is stored.');
  assert.equal(period1?.fixed_price, '50.00');
  assert.equal(period1?.variable_price, '10.00');
  const created = await documents(client);
  assert.ok(created.length >= 1, 'The save is documented.');
  assert.equal(created[0].reason, REASON, 'The reason is recorded.');
  assert.equal(
    created[0].items.find((item) => item.fieldName === 'p1FixedPrice')?.isSecurityRelevant,
    'true',
    'The fixed price is flagged security-relevant.',
  );
  console.log('  ✓ the plan stands in the database, documented');

  // ── 3. The plan changes through the matrix ───────────────────────────────
  await page.goto(`${base}${ROUTE}?area=A000&version=000&year=2026&center=${CENTRE}&type=${TYPE}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForLoadState('networkidle');
  const quantityCell = page.getByLabel('Planned activity period 1');
  await quantityCell.waitFor();
  assert.equal(await quantityCell.inputValue(), '160.000', 'The stored quantity renders back.');
  await quantityCell.fill('170');
  await page.locator('#act-rate-reason').fill(REASON);
  await page.getByRole('button', { name: 'Save plan', exact: true }).click();
  await page.getByRole('status').filter({ hasText: /Plan saved/ }).waitFor();
  assert.equal(
    (await storedRate(client, 1))?.planned_quantity,
    '170.000',
    'The changed quantity is stored.',
  );
  console.log('  ✓ the changed plan stores through the matrix');

  // ── 4. A period row deletes, and the deletion is documented ──────────────
  await page.goto(`${base}${ROUTE}?area=A000&version=000&year=2026&center=${CENTRE}&type=${TYPE}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForLoadState('networkidle');
  const row = page
    .locator('tr')
    .filter({ has: page.locator('td:first-child').getByText('2', { exact: true }) })
    .first();
  await row.getByText('Delete', { exact: true }).first().click();
  const deleteDialog = page.getByRole('dialog', {
    name: `Delete ${CENTRE} / ${TYPE} · period 2`,
  });
  await deleteDialog.locator('textarea[name="reason"]').fill(REASON);
  await deleteDialog.getByRole('button', { name: 'Delete activity rate', exact: true }).click();
  await page.getByRole('status').filter({ hasText: /period 2 deleted/ }).waitFor();
  assert.equal(await storedRate(client, 2), null, 'The period row is gone from the database.');
  const gone = await documents(client);
  assert.ok(
    gone.some((document) => document.changeType === 'DELETE'),
    'The deletion is documented.',
  );
  console.log('  ✓ the period row is deleted and the deletion is documented');
}

async function storedRate(
  client: string,
  period: number,
): Promise<Record<string, unknown> | null> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql`
      select planned_quantity::text as planned_quantity, fixed_price::text as fixed_price,
             variable_price::text as variable_price, price_unit
      from activity_rate
      where plan_version = '000' and fiscal_year = 2026 and period = ${period}
        and cost_center = ${CENTRE} and activity_type = ${TYPE}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

/** The documents this screen filed for the matrix, under the naming the service files on. */
async function documents(client: string) {
  const all = await withTenant(client, (tx) =>
    changeHistory(tx, client, 'activity_rate', `A000/000/2026/${CENTRE}/${TYPE}`),
  );
  return all.filter((document) => document.transactionCode === ACTIVITY);
}
