import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/material-period-control';
const ACTIVITY = 'CFG.INV.MATPERIOD.DEFINE';
const REASON = 'Browser acceptance run';

/**
 * SCR-054 / OMSY browser acceptance: material period control.
 *
 * The journey: the company standing uninitialized, the record
 * initialized through its privileged act, backposting allowed, and
 * the period shifted — the database remembering every act.
 */
export async function materialPeriodControlOmsy(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-054 OMSY: verify the uninitialized company, initialization, the indicators, and the shift');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into config_activity_status (client, activity_code, status, created_by)
      values (${client}, ${ACTIVITY}, 'NOT_STARTED', 'BROWSER_SMOKE')
      on conflict (client, activity_code) do nothing
    `);
  });

  // ── 1. The company stands uninitialized ──────────────────────────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Define Material Period Control', exact: true }).waitFor();
  const section = page.locator('section[aria-labelledby="material-period-grid"]');
  const row = section.locator('tr').filter({
    has: page.getByRole('cell', { name: '1000', exact: true }),
  });
  await row.getByText('Not initialized', { exact: true }).waitFor();
  console.log('  ✓ the company stands uninitialized');

  // ── 2. The record is initialized through its act ─────────────────────────
  await row.getByRole('button', { name: 'Initialize', exact: true }).click();
  await page.locator('#mp-year').fill('2026');
  await page.locator('#mp-period').fill('10');
  await page.locator('#mp-init-reason').fill(REASON);
  await page.getByRole('button', { name: 'Initialize', exact: true }).last().click();
  await page.getByText('Material period for company code 1000 initialized at 2026 / 10.').waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await row.getByRole('cell', { name: '2026 / 10', exact: true }).waitFor();
  await row.getByRole('cell', { name: '2026 / 09', exact: true }).waitFor();
  console.log('  ✓ the record stands at 2026 / 10 with its previous period');

  // ── 3. Backposting is allowed ────────────────────────────────────────────
  await row.getByRole('button', { name: 'Indicators', exact: true }).click();
  await page.locator('input[name="allowBackposting"][value="true"]').check();
  await page.locator('#mp-ind-reason').fill(REASON);
  await page.getByRole('button', { name: 'Save indicators', exact: true }).click();
  await page.getByText('Backposting indicators for company code 1000 saved.').waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await row.getByRole('cell', { name: 'Allowed', exact: true }).waitFor();
  console.log('  ✓ backposting to the previous period is allowed');

  // ── 4. The period shifts exactly one ─────────────────────────────────────
  await row.getByRole('button', { name: 'Shift period', exact: true }).click();
  await page.locator('#mp-shift-reason').fill(REASON);
  await page.getByRole('button', { name: 'Shift period', exact: true }).last().click();
  await page.getByText(/shifted to 2026 \/ 11/).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await row.getByRole('cell', { name: '2026 / 11', exact: true }).waitFor();
  await row.getByRole('cell', { name: '2026 / 10', exact: true }).waitFor();
  console.log('  ✓ the period shifted to 2026 / 11');

  // ── 5. The database remembers every act ──────────────────────────────────
  const evidence = await withTenant(client, async (tx) => {
    const records = await tx.execute(sql`
      select current_fiscal_year, current_period, previous_fiscal_year, previous_period,
        allow_backposting from material_period_control
      where client = ${client} and company_code = '1000'
    `);
    const history = await changeHistory(tx, client, 'material_period_control', '1000');
    return {
      records: records as unknown as Record<string, unknown>[],
      history,
    };
  });
  assert.deepEqual(
    [
      Number(evidence.records[0].current_fiscal_year), Number(evidence.records[0].current_period),
      Number(evidence.records[0].previous_fiscal_year), Number(evidence.records[0].previous_period),
    ],
    [2026, 11, 2026, 10],
  );
  assert.equal(evidence.records[0].allow_backposting, true);
  assert.ok(evidence.history.length >= 3, 'Initialization, indicators and shift are all documented.');
  console.log('  ✓ the database remembers the initialization, the indicators and the shift');
}
