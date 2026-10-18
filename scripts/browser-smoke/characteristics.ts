import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/characteristics';
const ACTIVITY = 'CFG.PROC.CHARACTERISTIC.DEFINE';
const REASON = 'Browser acceptance run';

/**
 * SCR-057 / CT04 browser acceptance: characteristics.
 *
 * The journey: the empty characteristic grid, TOTAL_VALUE created as
 * a draft through the editor, its activation through the reasoned
 * act, and the database remembering.
 */
export async function characteristicsCt04(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-057 CT04: verify the empty grid, characteristic creation, activation, and database evidence');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into config_activity_status (client, activity_code, status, created_by)
      values (${client}, ${ACTIVITY}, 'NOT_STARTED', 'BROWSER_SMOKE')
      on conflict (client, activity_code) do nothing
    `);
  });

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Define Characteristics', exact: true }).waitFor();
  const section = page.locator('section[aria-labelledby="characteristic-grid"]');
  await section.getByText('No characteristics stand yet. Define the first below.').waitFor();
  console.log('  ✓ the characteristic grid stands empty');

  const editor = page.locator('section[aria-labelledby="characteristic-editor"]');
  const labels = editor.locator('label');
  await labels.filter({ hasText: 'Characteristic name' }).locator('input').fill('TOTAL_VALUE');
  await labels.filter({ hasText: 'Description' }).locator('input').fill('Total document value');
  await labels.filter({ hasText: 'Data format' }).locator('select').selectOption('NUM');
  await labels.filter({ hasText: 'Length' }).locator('input').fill('13');
  await labels.filter({ hasText: 'Decimal places' }).locator('input').fill('2');
  await editor.locator('input[name="reason"]').fill(REASON);
  await editor.getByRole('button', { name: 'Save characteristic', exact: true }).click();
  await page.getByText('Characteristic TOTAL_VALUE saved.').waitFor();

  const row = section.locator('tr').filter({
    has: page.getByRole('cell', { name: 'TOTAL_VALUE', exact: true }),
  });
  await row.getByRole('cell', { name: 'DRAFT', exact: true }).waitFor();
  console.log('  ✓ the characteristic stands as a draft');

  await row.getByRole('button', { name: 'Activate', exact: true }).click();
  await page.locator('input[name="reason"]').last().fill(REASON);
  await page.getByRole('button', { name: 'Activate', exact: true }).last().click();
  await page.getByText('Characteristic TOTAL_VALUE is now active.').waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await row.getByRole('cell', { name: 'ACTIVE', exact: true }).waitFor();
  console.log('  ✓ the characteristic is active');

  const evidence = await withTenant(client, async (tx) => {
    const records = await tx.execute(sql`
      select data_format, decimal_places, lifecycle_status from characteristic
      where client = ${client} and characteristic_name = 'TOTAL_VALUE'
    `);
    const history = await changeHistory(tx, client, 'characteristic', 'TOTAL_VALUE');
    return { records: records as unknown as Record<string, unknown>[], history };
  });
  assert.equal(evidence.records.length, 1);
  assert.equal(evidence.records[0].data_format, 'NUM');
  assert.equal(Number(evidence.records[0].decimal_places), 2);
  assert.equal(evidence.records[0].lifecycle_status, 'ACTIVE');
  assert.ok(evidence.history.length >= 2, 'Creation and activation are both documented.');
  console.log('  ✓ the database remembers the characteristic and its acts');
}
