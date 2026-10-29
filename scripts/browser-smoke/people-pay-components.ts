import type { Locator, Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import { getPayComponent, listPayComponents } from '../../src/modules/people/pay-components';
import { PAY_COMPONENT_CONFIG_OBJECT_CLASS, PAY_COMPONENT_OBJECT_CLASS } from '../../src/modules/people/schema';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/pay-components';
const ACTIVITY = 'CFG.PEOPLE.PAYCOMPONENT.DEFINE';
const RECORD_ACTIVITY = 'CFG.PEOPLE.RECORDTYPE.DEFINE';
const RECORD_ROUTE = '/config/people-record-types';
const COMPONENT = 'BASIC';
const FREE = 'RENTAL';
const AREA = 'A000';
const CENTRE = 'CC900';

/**
 * CFG.PEOPLE.PAYCOMPONENT.DEFINE browser acceptance for the pay structure.
 *
 * Two things are being checked here, and the second is the reason the run exists at all. The first is the
 * screen: a component is defined, its mapping written, and the refusals an operator can reach are reached —
 * the side a kind has no business with, and the expense account that will not accept a charge without saying
 * where it goes. The mapping form only ever offers accounts the chart has and the side allows, which is a
 * claim about the screen rather than the service, so it is counted from the browser.
 *
 * The second is that the workbench can open the step. Both People configuration activities were registered for
 * years as titles with no route, and `9193`'s own browser run is what caught it: the step was listed, the
 * screen existed, and nothing joined them. `9195` sets `route_path` in both the seed and the database, so this
 * journey asserts the link for the new activity and for the record types beside it.
 *
 * The general ledger accounts and the cost centre this journey maps to are written straight into the tenant
 * because FS00 and KS01 have their own acceptance targets: what matters here is that the pay screen offers
 * them, refuses the ones it should, and stores the pair it was given.
 */
export async function peoplePayComponents(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log(
    'People: verify the pay structure screen, the sides each kind may map, the account choices it offers, the cost-object rule, the retirement and the workbench links',
  );

  // ── 1. The workbench opens both People configuration steps ────────────────
  await page.goto(`${base}/config`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  for (const [activity, route] of [
    [ACTIVITY, ROUTE],
    [RECORD_ACTIVITY, RECORD_ROUTE],
  ] as const) {
    const row = page.locator('tr').filter({ hasText: activity }).first();
    await row.waitFor();
    assert.equal(
      await row.getByRole('link', { name: 'Open', exact: true }).getAttribute('href'),
      route,
      `The workbench opens ${activity} at ${route}: a listed step that cannot be opened is a promise the screen does not keep.`,
    );
  }
  console.log('  ✓ both People configuration steps open from the workbench, not only the new one');

  // ── 2. The masters a mapping needs, standing in the tenant ────────────────
  const chart = await seedMasters(client);
  console.log(`  ✓ the tenant has chart ${chart} with an expense account, one that needs no cost object, a payable, a blocked payable and a centre`);

  // ── 3. A component is defined, and the kind is asked for as a closed choice ─
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Pay components', exact: true }).waitFor();
  assert.match(
    await page.locator('header .code').first().innerText(),
    new RegExp(ACTIVITY),
    'The screen names the activity that maintains it.',
  );
  const define = panel(page, 'Define a pay component');
  const kinds = define.locator('[name="componentKind"] option');
  assert.equal(await kinds.count(), 4, 'Four kinds, which is what §15.2’s example contains — no fifth is offered.');
  await setField(define, 'code', COMPONENT);
  await setField(define, 'name', 'Basic salary');
  await setField(define, 'componentKind', 'EARNING');
  await setField(define, 'description', 'The monthly pay the contract names.');
  await define.getByRole('button', { name: 'Define component', exact: true }).click();
  await status(page, new RegExp(`Component ${COMPONENT} — Basic salary — defined as an earning`));
  let view = await getPayComponent(client, COMPONENT);
  assert.equal(view.componentKind, 'EARNING');
  assert.equal(view.affectsNetPay, true, 'An earning changes what the employee is paid, and the screen never asks.');
  assert.equal(view.mappings.length, 0, 'A component stands before its mapping does.');
  console.log(`  ✓ ${COMPONENT} is defined as an earning and reads back with its kind pinned`);

  // ── 4. The form offers only accounts the side may take ────────────────────
  await page.goto(`${base}${ROUTE}?component=${COMPONENT}&chart=${chart}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const mapping = panel(page, 'Define the mapping');
  await mapping.waitFor();
  const debitOptions = await optionValues(mapping.locator('[name="debitAccount"]'));
  assert.ok(debitOptions.includes('590100'), 'The debit select lists the expense account that demands a cost object.');
  assert.ok(debitOptions.includes('590200'), 'And the expense account that does not.');
  for (const absent of ['290100', '290200', '190100']) {
    assert.ok(!debitOptions.includes(absent), `A debit select offers expenses only, not ${absent}.`);
  }
  const creditOptions = await optionValues(mapping.locator('[name="creditAccount"]'));
  assert.ok(creditOptions.includes('290100'), 'The credit select lists the payable that is open for posting.');
  assert.ok(!creditOptions.includes('290200'), 'And leaves out the one the tenant has blocked.');
  assert.ok(!creditOptions.includes('590100'), 'Nor an expense, which belongs on the other side.');

  // ── 5. The cost-object rule, both ways, in the form ───────────────────────
  await setField(mapping, 'debitAccount', '590100');
  await setField(mapping, 'costReceiverCategory', 'NONE');
  await mapping.getByRole('button', { name: 'Define mapping', exact: true }).click();
  await status(page, /requires a cost object, so the debit cannot be mapped to none/);
  assert.equal((await getPayComponent(client, COMPONENT)).mappings.length, 0, 'A refused mapping wrote nothing.');

  await setField(mapping, 'debitAccount', '590100');
  await setField(mapping, 'costReceiverCategory', 'ASSIGNMENT');
  await mapping.getByRole('button', { name: 'Define mapping', exact: true }).click();
  await status(page, new RegExp(`Mapping for ${COMPONENT} in ${chart} defined: debit 590100, credit none, charged to the employee`));
  let stored = await mappingRow(client, COMPONENT, chart);
  assert.equal(stored?.debit_account, '590100', 'The account the form named is the one stored.');
  assert.equal(stored?.credit_account, null, 'An earning carries no payable of its own.');
  assert.equal(stored?.cost_receiver_category, 'ASSIGNMENT');
  assert.equal(stored?.cost_center, null, 'ASSIGNMENT names no centre: the assignment is the answer.');
  console.log('  ✓ an account that demands a cost object refuses NONE, and the accepted mapping stores the charge as chosen');

  // ── 6. A side the kind does not have is refused in the panel that edits it ─
  const change = panel(page, 'Change the mapping');
  await change.waitFor();
  await setField(change, 'creditAccount', '290100');
  await change.getByRole('button', { name: 'Save mapping', exact: true }).click();
  await status(page, /has no credit side/);
  stored = await mappingRow(client, COMPONENT, chart);
  assert.equal(stored?.credit_account, null, 'The refused credit left the standing mapping untouched.');
  console.log('  ✓ a credit on an earning is refused where the mapping is corrected, and nothing changed');

  // ── 7. A fixed centre, read back with its name ────────────────────────────
  const fixed = panel(page, 'Change the mapping');
  await setField(fixed, 'costReceiverCategory', 'FIXED');
  await setField(fixed, 'costCenter', `${AREA}/${CENTRE}`);
  await fixed.getByRole('button', { name: 'Save mapping', exact: true }).click();
  await status(page, /charged to A000\/CC900/);
  stored = await mappingRow(client, COMPONENT, chart);
  assert.equal(stored?.cost_receiver_category, 'FIXED');
  assert.equal(stored?.cost_center, CENTRE, 'The centre and its area are stored as a pair.');
  assert.match(
    await panel(page, 'This pay component').innerText(),
    new RegExp(`${AREA}/${CENTRE}`),
    'The mapping table reads the charge back, so a reader can see where the money would go.',
  );
  const docs = await documents(client, PAY_COMPONENT_CONFIG_OBJECT_CLASS, `${chart}/${COMPONENT}`);
  assert.equal(docs.length, 2, 'The definition and the correction are two documents, not one overwrite.');
  // Newest first, which is how the history is read: the correction is on top, the definition under it.
  assert.equal(docs[0]?.changeType, 'CHANGE', 'The correction is its own document, beside the definition.');
  assert.equal(docs[1]?.changeType, 'CREATE', 'And the definition it corrects is still filed, not rewritten.');
  console.log('  ✓ a fixed centre is mapped with its area, read back on the screen and documented beside it');

  // ── 8. A second component, mapped to nothing, and the search that finds both ─
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const rent = panel(page, 'Define a pay component');
  await setField(rent, 'code', FREE);
  await setField(rent, 'name', 'Rent allowance');
  await setField(rent, 'componentKind', 'DEDUCTION');
  await rent.getByRole('button', { name: 'Define component', exact: true }).click();
  await status(page, /defined as a deduction/);
  await page.goto(`${base}${ROUTE}?component=${FREE}&chart=${chart}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const only = panel(page, 'Define the mapping');
  await only.waitFor();
  await setField(only, 'creditAccount', '290100');
  await setField(only, 'costReceiverCategory', 'NONE');
  await only.getByRole('button', { name: 'Define mapping', exact: true }).click();
  await status(page, new RegExp(`Mapping for ${FREE} in ${chart} defined: debit none, credit 290100, charged to nothing`));

  await page.goto(`${base}${ROUTE}?q=RENT`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  assert.equal(await panel(page, 'Pay components').locator('tbody tr').count(), 1, 'The search answers on the one component.');
  await page.goto(`${base}${ROUTE}?q=nowhere`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await panel(page, 'Pay components').getByText('No pay component is defined for “nowhere”').waitFor();
  assert.equal((await listPayComponents(client, 'nowhere')).length, 0, 'And the list is empty for both the screen and the store.');
  console.log('  ✓ a deduction maps to its payable alone, and the search answers the same way the tenant holds it');

  // ── 9. Retiring a component leaves the mapping it already has ─────────────
  await page.goto(`${base}${ROUTE}?component=${COMPONENT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  // The change form belongs to the component's own panel, where the read-back and the edit sit together.
  const retire = panel(page, 'This pay component');
  await setField(retire, 'isValid', 'no');
  await retire.getByRole('button', { name: 'Change component', exact: true }).click();
  await status(page, /retired: every mapping that stands still stands/);
  view = await getPayComponent(client, COMPONENT);
  assert.equal(view.isValid, false);
  assert.equal(view.mappings.length, 1, 'Retiring stops what comes next and rewrites nothing that stands.');
  assert.equal(
    (await documents(client, PAY_COMPONENT_OBJECT_CLASS, COMPONENT)).length,
    2,
    'The definition and the retirement, both documented.',
  );
  console.log(`  ✓ ${COMPONENT} is retired with its mapping intact, and nothing on the screen deletes either`);

  assert.equal(await page.getByRole('button', { name: /delete/i }).count(), 0, 'No delete is offered anywhere on the pay structure.');
  const counts = await withTenant(
    client,
    async (tx) =>
      (await tx.execute(sql`
        select (select count(*) from pay_component) as components,
               (select count(*) from pay_component_config) as mappings`)) as unknown as Array<{
        components: number;
        mappings: number;
      }>,
  );
  assert.equal(Number(counts[0]?.components), 2, 'Two components in the tenant: this run wrote both.');
  assert.equal(Number(counts[0]?.mappings), 2, 'Two mappings, one per component — nothing half-written is left standing.');
}

/** The accounts and the centre a mapping may point at, written as masters rather than through their screens. */
async function seedMasters(client: string): Promise<string> {
  return withTenant(client, async (tx) => {
    const [chart] = (await tx.execute(
      sql`select chart_of_accounts as chart from chart_of_accounts where client = ${client} limit 1`,
    )) as unknown as Array<{ chart: string }>;
    const code = chart!.chart;
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, is_posting_locked, created_by)
      values (${client}, ${AREA}, ${CENTRE}, '2020-01-01', '9999-12-31', 'Payroll centre', 'PRODUCTION', '1000', false, 'browser.admin')
      on conflict do nothing`);
    await tx.execute(sql`
      insert into gl_account (client, chart_of_accounts, account_number, name, account_type,
                               is_balance_sheet, is_open_item_managed, reconciliation_type,
                               requires_cost_object, is_tax_relevant, is_blocked_posting, is_blocked_creation,
                               account_group, gl_account_type, language_key, sort_key, created_by)
      select ${client}, ${code}, v.n, v.d, v.t, v.bs, false, null, v.cost, false, v.blocked, false,
             'GENL', v.kind, 'EN', v.sort, 'browser.admin'
        from (values
          ('590100', 'Payroll expense',         'EXPENSE',   false, true,  false, 'PL_STATEMENT',  '950'),
          ('590200', 'Unrestricted expense',    'EXPENSE',   false, false, false, 'PL_STATEMENT',  '951'),
          ('290100', 'Payroll payable',         'LIABILITY', true,  false, false, 'BALANCE_SHEET', '952'),
          ('290200', 'Blocked payroll payable',   'LIABILITY', true,  false, true,  'BALANCE_SHEET', '953'),
          ('190100', 'Cash at bank',            'ASSET',     true,  false, false, 'BALANCE_SHEET', '954')
        ) as v(n, d, t, bs, cost, blocked, kind, sort)
      on conflict (client, chart_of_accounts, account_number) do update set
        name = excluded.name, account_type = excluded.account_type, is_balance_sheet = excluded.is_balance_sheet,
        requires_cost_object = excluded.requires_cost_object, is_blocked_posting = excluded.is_blocked_posting,
        gl_account_type = excluded.gl_account_type, changed_by = 'browser.admin', changed_at = now()`);
    return code;
  });
}

async function mappingRow(client: string, code: string, chart: string): Promise<Record<string, string | null> | undefined> {
  const rows = await withTenant(
    client,
    async (tx) =>
      (await tx.execute(sql`
        select debit_account, credit_account, cost_receiver_category, controlling_area, cost_center
          from pay_component_config
         where component_code = ${code} and chart_of_accounts = ${chart}`)) as unknown as Array<Record<string, string | null>>,
  );
  return rows[0];
}

async function optionValues(select: Locator): Promise<string[]> {
  return select.locator('option').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('value') ?? ''));
}

/** The change documents of one object, read on the tenant's own connection. */
async function documents(client: string, objectClass: string, objectKey: string) {
  return withTenant(client, (tx) => changeHistory(tx, client, objectClass, objectKey));
}

/** The block a screen marks for an operator, whether the label sits on its section or its form. */
function panel(page: Page, label: string): Locator {
  return page.locator(`[aria-label="${label}"]`).first();
}

async function status(page: Page, pattern: RegExp): Promise<string> {
  const notice = page.getByRole('status').filter({ hasText: pattern }).first();
  await notice.waitFor();
  return (await notice.innerText()).replace(/\s+/g, ' ');
}

async function setField(scope: Locator, name: string, value: string | boolean): Promise<void> {
  const control = scope.locator(`[name="${name}"]`).first();
  if (!(await control.isVisible())) return;
  const tag = (await control.evaluate((node) => node.tagName)).toLowerCase();
  if (tag === 'select') {
    await control.selectOption(String(value));
    return;
  }
  if ((await control.getAttribute('type')) === 'checkbox') {
    if (value) await control.check();
    else await control.uncheck();
    return;
  }
  await control.fill(String(value));
}
