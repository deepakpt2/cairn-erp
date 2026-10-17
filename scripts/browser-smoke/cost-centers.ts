import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/cost-centers';
const ACTIVITY = 'CFG.COST.COSTCENTER.DEFINE';
const REASON = 'Browser acceptance run';
const CENTRE = 'CC9001';

/**
 * SCR-041 / KS01 browser acceptance: defining cost centres.
 *
 * The journey follows the period shape of the master: a period created
 * inside the tenant's controlling area on a company code the screen
 * itself offers (the codes assigned to that area), the same key refused
 * again, an overlapping period refused naming the period it collides
 * with, the period's facts changed, the centre locked for posting and
 * unlocked again, and the unused period deleted with its deletion
 * documented. The service's judging refusals — company not assigned to
 * the area, span against siblings, deletion against journal documents
 * dated inside the period — are asserted in the service tests; this
 * target asserts the journey an operator can actually take.
 *
 * Everything asserted here is asserted twice: once in the browser,
 * because the screen is the product, and once in the database, because
 * a form that renders a value is not a form that stored it.
 */
export async function costCentersKs01(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-041 KS01: verify the workbench route, the empty start, period creation, duplicate and overlap refusals, change, the posting lock, and deletion');

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
  await page.getByRole('heading', { level: 1, name: 'Define Cost Centres', exact: true }).waitFor();
  assert.match(
    await page.locator('header .code').first().innerText(),
    new RegExp(`${ACTIVITY} · KS01`),
    'The screen says which activity and which reference transaction it is.',
  );
  await page.getByText('No cost centres are defined for this controlling area yet.').waitFor();
  console.log('  ✓ the workbench routes here and the controlling area stands empty');

  // ── 2. A period, on a company code the screen itself offers ──────────────
  const panel = page.locator('section[aria-labelledby="cost-center-create-title"]');
  await panel.locator('#cost-center-code').fill(CENTRE);
  await panel.locator('#cost-center-validFrom').fill('2026-01-01');
  await panel.locator('#cost-center-validTo').fill('9999-12-31');
  await panel.locator('#cost-center-name').fill('Acceptance cost centre');
  await panel.locator('#cost-center-category').selectOption('PRODUCTION');
  const companySelect = panel.locator('#cost-center-company');
  const companyValues = (await companySelect.locator('option').all()).map(
    async (option) => option.getAttribute('value'),
  );
  const company = (await Promise.all(companyValues)).find((value) => value);
  assert.ok(company, 'The area offers at least one assigned company code.');
  await companySelect.selectOption(company as string);
  await panel.locator('#cost-center-reason').fill(REASON);
  await panel.getByRole('button', { name: 'Create cost centre period', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Cost Centre ${CENTRE} created`) })
    .waitFor();
  const stored = await storedPeriod(client, CENTRE, '2026-01-01');
  assert.equal(stored?.company_code, company, 'The offered company code is stored.');
  assert.equal(stored?.category, 'PRODUCTION');
  const area = stored?.controlling_area as string;
  const created = await documents(client, `${area}/${CENTRE}/2026-01-01`);
  assert.equal(created.length, 1, 'One creation, one document.');
  assert.equal(created[0].reason, REASON, 'The reason is recorded.');
  assert.equal(
    created[0].items.find((item) => item.fieldName === 'companyCode')?.isSecurityRelevant,
    'true',
    'The company code is flagged security-relevant.',
  );
  console.log(`  ✓ the period stands in area ${area} on company ${company}, documented`);

  // ── 3. The same key again, and an overlapping period, are refused ────────
  await panel.locator('#cost-center-code').fill(CENTRE);
  await panel.locator('#cost-center-validFrom').fill('2026-01-01');
  await panel.locator('#cost-center-validTo').fill('9999-12-31');
  await panel.locator('#cost-center-name').fill('Acceptance cost centre');
  await panel.locator('#cost-center-company').selectOption(company as string);
  await panel.locator('#cost-center-reason').fill(REASON);
  await panel.getByRole('button', { name: 'Create cost centre period', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: /already defined/ }).waitFor();
  assert.equal(
    (await documents(client, `${area}/${CENTRE}/2026-01-01`)).length,
    1,
    'A refused duplicate files no document.',
  );

  await panel.locator('#cost-center-code').fill(CENTRE);
  await panel.locator('#cost-center-validFrom').fill('2026-06-01');
  await panel.locator('#cost-center-validTo').fill('2026-12-31');
  await panel.locator('#cost-center-name').fill('Acceptance cost centre');
  await panel.locator('#cost-center-company').selectOption(company as string);
  await panel.locator('#cost-center-reason').fill(REASON);
  await panel.getByRole('button', { name: 'Create cost centre period', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: /overlaps the period 2026-01-01/ }).waitFor();
  console.log('  ✓ the same key again and an overlapping period are refused');

  // ── 4. A change corrects the period's facts ──────────────────────────────
  const row = gridRow(page, CENTRE);
  await row.waitFor();
  await row.getByText('Change', { exact: true }).first().click();
  const changeDialog = page.getByRole('dialog', { name: /^Change/ });
  await changeDialog.waitFor();
  const suffix = `${CENTRE}-2026-01-01`;
  await changeDialog.locator(`#cost-center-${suffix}-name`).fill('Acceptance cost centre (renamed)');
  await changeDialog.locator(`#cost-center-change-reason-${suffix}`).fill(REASON);
  await changeDialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Cost Centre ${CENTRE} changed`) })
    .waitFor();
  assert.equal(
    (await storedPeriod(client, CENTRE, '2026-01-01'))?.name,
    'Acceptance cost centre (renamed)',
    'The corrected name is stored.',
  );
  await closeDialog(changeDialog);
  console.log('  ✓ the period reads back renamed');

  // ── 5. The posting lock stops postings being offered the centre ──────────
  await row.getByText('Lock', { exact: true }).first().click();
  const lockDialog = page.getByRole('dialog', { name: /^Lock/ });
  await lockDialog.waitFor();
  await lockDialog.locator(`#cost-center-lock-reason-${suffix}`).fill(REASON);
  await lockDialog.getByRole('button', { name: 'Lock cost centre', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Cost Centre ${CENTRE} locked for posting`) })
    .waitFor();
  assert.equal(
    (await storedPeriod(client, CENTRE, '2026-01-01'))?.is_posting_locked,
    true,
    'The lock is stored.',
  );
  // A successful lock unmounts its own dialog; reload rather than close it.
  await page.goto(`${base}${ROUTE}?area=${area}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const lockedRow = gridRow(page, CENTRE);
  await lockedRow.getByText('Locked', { exact: true }).waitFor();
  console.log('  ✓ the centre stands locked for posting');

  // ── 6. The unused period is deleted, and the deletion is filed ───────────
  await lockedRow.getByText('Delete', { exact: true }).first().click();
  const deleteDialog = page.getByRole('dialog', { name: /^Delete/ });
  await deleteDialog.waitFor();
  await deleteDialog.locator(`#cost-center-delete-reason-${suffix}`).fill(REASON);
  await deleteDialog.getByRole('button', { name: 'Delete cost centre period', exact: true }).click();
  await page.waitForFunction(
    () => ![...document.querySelectorAll('section[aria-labelledby="cost-center-grid-title"] tbody tr')]
      .some((tr) => (tr as HTMLElement).innerText.includes('CC9001')),
  );
  assert.equal(await storedPeriod(client, CENTRE, '2026-01-01'), null, 'The period is gone.');
  const all = await documents(client, `${area}/${CENTRE}/2026-01-01`);
  assert.ok(
    all.some((document) => document.changeType === 'DELETE' && document.reason === REASON),
    'The deletion is documented with its reason.',
  );
  console.log('  ✓ the period is deleted, and the deletion is documented');

  console.log('SCR-041 KS01 passed: workbench route, empty start, creation, refusals, change, lock, deletion');
}

function gridRow(page: Page, centre: string) {
  return page
    .locator('section[aria-labelledby="cost-center-grid-title"]')
    .locator('tbody tr')
    .filter({ has: page.locator('td:first-child').getByText(centre, { exact: true }) })
    .first();
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
      select controlling_area, company_code, category, name, is_posting_locked
      from cost_center
      where cost_center = ${centre} and valid_from = ${validFrom}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

/** The documents this screen filed for a period, under the naming the service files on. */
async function documents(client: string, objectKey: string) {
  const all = await withTenant(client, (tx) => changeHistory(tx, client, 'cost_center', objectKey));
  return all.filter((document) => document.transactionCode === ACTIVITY);
}
