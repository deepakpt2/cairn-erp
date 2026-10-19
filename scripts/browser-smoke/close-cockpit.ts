import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { upsertTemplateTask } from '../../src/modules/finance/close-cockpit';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const COCKPIT = '/finance/close-cockpit';

/**
 * SCR-101 browser acceptance: close cockpit (CLOCO).
 *
 * The journey: a template is defined through the service, a
 * closing cycle is created from it in the workspace, released,
 * and its first task executed — completing in the grid. A gated
 * successor stays blocked behind its predecessor.
 */
export async function closeCockpit(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-101: build a closing cycle and execute its first task');

  await upsertTemplateTask({
    client, changedBy: 'browser.admin', templateCode: 'APRIL',
    task: { taskId: 'T10', taskName: 'Check period status', handlerCode: 'PERIOD_STATUS', sequence: 10 },
  });
  await upsertTemplateTask({
    client, changedBy: 'browser.admin', templateCode: 'APRIL',
    task: {
      taskId: 'T20', taskName: 'Review and sign off the close', handlerCode: 'MANUAL_CONFIRMATION',
      sequence: 20, criticalPath: true, requiresSignoff: true,
    },
    predecessors: ['T10'],
  });

  await page.goto(`${base}${COCKPIT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Period-End Close Cockpit', exact: true }).waitFor();

  await page.locator('input[name="taskListId"]').first().fill('APRIL_CLOSE');
  await page.locator('input[name="fiscalYear"]').fill('2026');
  await page.locator('input[name="postingPeriod"]').fill('4');
  await page.locator('select[name="templateCode"]').selectOption('APRIL');
  await page.getByRole('button', { name: 'Create from template', exact: true }).click();
  await page.getByText('APRIL_CLOSE · 1000 · 2026/04').waitFor();
  console.log('  ✓ closing cycle created from the template');

  await page.getByRole('button', { name: 'Release task list', exact: true }).click();
  const t10 = page.locator('tr', { hasText: 'Check period status' }).first();
  await t10.getByText('RELEASED', { exact: true }).waitFor();
  console.log('  ✓ task list released');

  await t10.getByRole('button', { name: 'Run', exact: true }).click();
  await t10.getByText('COMPLETED', { exact: true }).waitFor();
  console.log('  ✓ first task executed through its handler and completed');

  await page.getByText(/Period 2026\/04: no documents/).first().waitFor();
  console.log('  ✓ the execution log carries the handler result');

  const stored = await withTenant(client, async (tx) => tx.execute(sql`
    select status from closing_task_instance
    where client = ${client} and task_list_id = 'APRIL_CLOSE' and task_id = 'T20'
  `));
  assert.equal((stored as unknown as Array<{ status: string }>)[0]?.status, 'RELEASED');
  console.log('  ✓ the gated successor still waits behind its predecessor');
}
