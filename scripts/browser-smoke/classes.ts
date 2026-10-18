import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/classes';
const REASON = 'Browser acceptance run';

/**
 * SCR-058 / CL02 browser acceptance: classes.
 *
 * The journey: a characteristic fixture, the empty class grid, the
 * PO_RELEASE class created with its assignment through the editor,
 * its activation, and the database remembering.
 */
export async function classesCl02(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-058 CL02: verify the empty grid, class creation, activation, and database evidence');

  await withTenant(client, async (tx) => {
    for (const activity of ['CFG.PROC.CHARACTERISTIC.DEFINE', 'CFG.PROC.CLASS.DEFINE']) {
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
  });

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Define Classes', exact: true }).waitFor();
  const section = page.locator('section[aria-labelledby="class-grid"]');
  await section.getByText('No classes stand yet. Define the first below.').waitFor();
  console.log('  ✓ the class grid stands empty');

  const editor = page.locator('section[aria-labelledby="class-editor"]');
  const labels = editor.locator('label');
  await labels.filter({ hasText: 'Class name' }).locator('input').fill('PO_RELEASE');
  await labels.filter({ hasText: 'Description' }).locator('input').fill('Purchase order release');
  await editor.locator('fieldset input').first().fill('TOTAL_VALUE');
  await editor.locator('input[name="reason"]').fill(REASON);
  await editor.getByRole('button', { name: 'Save class', exact: true }).click();
  await page.getByText('Class PO_RELEASE saved under PURCHASE_ORDER.').waitFor();

  const row = section.locator('tr').filter({
    has: page.getByRole('cell', { name: 'PO_RELEASE', exact: true }),
  });
  await row.getByRole('cell', { name: 'DRAFT', exact: true }).waitFor();
  await row.getByRole('cell', { name: 'TOTAL_VALUE', exact: true }).waitFor();
  console.log('  ✓ the class stands as a draft with its characteristic');

  await row.getByRole('button', { name: 'Activate', exact: true }).click();
  await page.locator('input[name="reason"]').last().fill(REASON);
  await page.getByRole('button', { name: 'Activate', exact: true }).last().click();
  await page.getByText('Class PO_RELEASE is now active.').waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await row.getByRole('cell', { name: 'ACTIVE', exact: true }).waitFor();
  console.log('  ✓ the class is active');

  const evidence = await withTenant(client, async (tx) => {
    const assignments = await tx.execute(sql`
      select position, characteristic_name from class_assignment
      where client = ${client} and class_type = 'PURCHASE_ORDER' and class_name = 'PO_RELEASE'
    `);
    const history = await changeHistory(tx, client, 'classification_class', 'PURCHASE_ORDER/PO_RELEASE');
    return { assignments: assignments as unknown as Record<string, unknown>[], history };
  });
  assert.equal(evidence.assignments.length, 1);
  assert.equal(Number(evidence.assignments[0].position), 1);
  assert.equal(evidence.assignments[0].characteristic_name, 'TOTAL_VALUE');
  assert.ok(evidence.history.length >= 2, 'Creation and activation are both documented.');
  console.log('  ✓ the database remembers the class, its assignment and its acts');
}
