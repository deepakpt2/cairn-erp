import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/release-strategies';
const REASON = 'Browser acceptance run';

/**
 * SCR-059 browser acceptance: release strategies.
 *
 * The journey: classification fixtures standing, the empty grid, a
 * group with its code and a strategy created through the editors,
 * the strategy activated, and the database remembering.
 */
export async function releaseStrategiesConfig(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-059: verify the empty grid, group and strategy creation, activation, and database evidence');

  await withTenant(client, async (tx) => {
    for (const activity of ['CFG.PROC.CHARACTERISTIC.DEFINE', 'CFG.PROC.CLASS.DEFINE', 'CFG.PROC.RELEASE.DEFINE']) {
      await tx.execute(sql`
        insert into config_activity_status (client, activity_code, status, created_by)
        values (${client}, ${activity}, 'NOT_STARTED', 'BROWSER_SMOKE')
        on conflict (client, activity_code) do nothing
      `);
    }
    await tx.execute(sql`
      insert into characteristic (
        client, characteristic_name, description, data_format, value_length, decimal_places,
        lifecycle_status, created_by
      )
      values (${client}, 'TOTAL_VALUE', 'Total document value', 'NUM', 13, 2, 'ACTIVE', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into class_type (client, class_type, description, object_category, created_by)
      values (${client}, 'PURCHASE_ORDER', 'Purchase order release classes', 'PURCHASING', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into classification_class (client, class_type, class_name, description, lifecycle_status, created_by)
      values (${client}, 'PURCHASE_ORDER', 'PO_RELEASE', 'Purchase order release', 'ACTIVE', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into class_assignment (client, class_type, class_name, position, characteristic_name, created_by)
      values (${client}, 'PURCHASE_ORDER', 'PO_RELEASE', 1, 'TOTAL_VALUE', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
  });

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Define Release Strategies', exact: true }).waitFor();
  const section = page.locator('section[aria-labelledby="release-grid"]');
  await section.getByText('No release strategies stand yet. Define the first below.').waitFor();
  console.log('  ✓ the release grid stands empty');

  const groupEditor = page.locator('section[aria-labelledby="release-group-editor"]');
  const groupLabels = groupEditor.locator('label');
  await groupLabels.filter({ hasText: 'Group code' }).locator('input').fill('PO');
  await groupLabels.filter({ hasText: 'Description' }).locator('input').fill('Purchase order releases');
  await groupEditor.locator('fieldset input').nth(0).fill('MGR');
  await groupEditor.locator('fieldset input').nth(1).fill('Purchasing manager');
  await groupEditor.locator('input[name="reason"]').fill(REASON);
  await groupEditor.getByRole('button', { name: 'Save group', exact: true }).click();
  await page.getByText('Release group PO saved.').waitFor();
  console.log('  ✓ the group stands with its code');

  const editor = page.locator('section[aria-labelledby="release-editor"]');
  const labels = editor.locator('label');
  await labels.filter({ hasText: 'Release group' }).locator('select').selectOption('PO');
  await labels.filter({ hasText: 'Strategy' }).locator('input').fill('HIGH');
  await labels.filter({ hasText: 'Description' }).locator('input').fill('High value orders');
  await labels.filter({ hasText: 'Class' }).locator('select').selectOption('PO_RELEASE');
  const criteriaRow = editor.locator('fieldset').first().locator('div.grid').first();
  await criteriaRow.locator('select').first().selectOption('TOTAL_VALUE');
  await criteriaRow.locator('input').first().fill('1000');
  await editor.locator('fieldset').nth(1).locator('select').first().selectOption('MGR');
  await editor.locator('input[name="reason"]').fill(REASON);
  await editor.getByRole('button', { name: 'Save strategy', exact: true }).click();
  await page.getByText('Strategy HIGH saved in group PO.').waitFor();

  const row = section.locator('tr').filter({
    has: page.getByRole('cell', { name: 'HIGH', exact: true }),
  });
  await row.getByRole('cell', { name: 'DRAFT', exact: true }).waitFor();
  console.log('  ✓ the strategy stands as a draft');

  await row.getByRole('button', { name: 'Activate', exact: true }).click();
  await page.locator('input[name="reason"]').last().fill(REASON);
  await page.getByRole('button', { name: 'Activate', exact: true }).last().click();
  await page.getByText('Strategy HIGH is now active.').waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await row.getByRole('cell', { name: 'ACTIVE', exact: true }).waitFor();
  console.log('  ✓ the strategy is active');

  const evidence = await withTenant(client, async (tx) => {
    const criteria = await tx.execute(sql`
      select characteristic_name, operator, value_from from release_strategy_criterion
      where client = ${client} and group_code = 'PO' and strategy_code = 'HIGH'
    `);
    const steps = await tx.execute(sql`
      select release_code from release_strategy_step
      where client = ${client} and group_code = 'PO' and strategy_code = 'HIGH'
    `);
    const history = await changeHistory(tx, client, 'release_strategy', 'PO/HIGH');
    return {
      criteria: criteria as unknown as Record<string, unknown>[],
      steps: steps as unknown as Record<string, unknown>[],
      history,
    };
  });
  assert.equal(evidence.criteria.length, 1);
  assert.equal(evidence.criteria[0].characteristic_name, 'TOTAL_VALUE');
  assert.equal(evidence.steps.map((s) => s.release_code).join(','), 'MGR');
  assert.ok(evidence.history.length >= 2, 'Creation and activation are both documented.');
  console.log('  ✓ the database remembers the strategy, its criterion, its step and its acts');
}
