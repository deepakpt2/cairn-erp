import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import { DEFAULT_INTERVALS } from '../../src/modules/foundation/posting-period-variant-definition';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

function scope(ctx: Context) {
  return { page: ctx.page, BASE: ctx.base, CLIENT: ctx.target.client };
}

const ROUTE = '/config/posting-period-variants';
const ACTIVITY = 'CFG.FIN.PPV.DEFINE';
/** The variant the standard package ships, which the onboarded Company Code posts against. */
const SEEDED = 'C001';
/** Defined through the UI in this run; the fixture tenant is disposable. */
const CREATED = 'BP01';
const CREATED_NAME = 'Browser acceptance variant';
/** Inside the contract's thirty characters: a longer fixture is cut by the field, not stored. */
const RENAMED = 'Browser variant, renamed';

/**
 * SCR-031 / OBBO browser acceptance: the posting period variant registry.
 *
 * A posting period variant is not a label, it is the set of intervals a Company Code posts
 * against, so the intervals are asserted as carefully as the variant: what the screen offers
 * when a variant is created, what the table holds afterwards, and what a deletion takes away.
 *
 * Everything asserted here is asserted twice: once in the browser, because the screen is the
 * product, and once in the database, because a form that renders a value is not a form that
 * stored it.
 */
export async function postingPeriodVariantsObbo(ctx: Context) {
  const { page, BASE, CLIENT } = scope(ctx);
  console.log('SCR-031 OBBO: verify the registry, the interval set a variant is born with, and the deletion guards');

  // ── 1. The registry renders what the tenant holds ─────────────────────────
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Posting Period Variants', exact: true }).waitFor();
  assert.match(
    await page.locator('.code.text-2xs').first().innerText(),
    new RegExp(`${ACTIVITY} · OBBO`),
    'The screen says which activity and which reference transaction it is.',
  );

  const registry = listSection(page);
  await registry.locator('tbody tr').filter({ hasText: SEEDED }).first().waitFor();
  assert.match(
    await registry.locator('tbody tr').filter({ hasText: SEEDED }).first().innerText(),
    /Standard period control/,
    'The variant the standard package shipped is listed with its description.',
  );

  // The intervals are behind a disclosure, because a row per account type is not a grid column.
  const seededRow = registry.locator('tbody tr').filter({ hasText: SEEDED }).first();
  await seededRow.getByText(/Intervals:/).click();
  const intervalText = await seededRow.innerText();
  for (const interval of DEFAULT_INTERVALS) {
    assert.ok(
      intervalText.includes(interval.accountTypeLabel),
      `The interval for ${interval.accountTypeLabel} is shown.`,
    );
  }
  assert.match(intervalText, /periods 1 to 12/, 'The seeded interval range is shown in words.');
  // Scoped to the open disclosure: the row also carries the delete dialog's own copy of the
  // interval table, closed, and a hidden table is still in the DOM to be counted.
  assert.equal(
    await seededRow.locator('details[open] tbody tr').count(),
    DEFAULT_INTERVALS.length,
    'One interval row per account type, and no more.',
  );

  // The Company Code that posts against it is named, which is what makes the deletion guard
  // below legible before anybody clicks it.
  const companies = await storedCompanyCodes(CLIENT, SEEDED);
  assert.equal(companies.length > 0, true, 'The fixture tenant posts against the seeded variant.');
  const rowText = await seededRow.innerText();
  for (const company of companies) {
    assert.ok(rowText.includes(company), `Company Code ${company} is named in the row.`);
  }
  console.log(`  ✓ the registry lists ${SEEDED} with its ${DEFAULT_INTERVALS.length} intervals and the Company Codes posting against it`);

  // ── 2. The workbench sends the activity here ──────────────────────────────
  await page.goto(`${BASE}/config`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const workbenchRow = page.locator('tr').filter({ hasText: ACTIVITY }).first();
  await workbenchRow.waitFor();
  assert.equal(
    await workbenchRow.getByRole('link', { name: 'Open', exact: true }).getAttribute('href'),
    ROUTE,
    'The workbench opens the screen that can do the work.',
  );
  console.log('  ✓ the workbench routes the activity to this screen rather than to the control screen');

  // ── 3. The prerequisite is a refusal on the screen, not a mystery afterwards ──
  await setActivityStatus(CLIENT, 'CFG.FIN.FYV.ASSIGN', 'NOT_STARTED');
  await setActivityStatus(CLIENT, ACTIVITY, 'NOT_STARTED');
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await createPanel(page).locator('[name="variant"]').fill(CREATED);
  await createPanel(page).locator('[name="name"]').fill(CREATED_NAME);
  await createPanel(page).getByRole('button', { name: 'Define variant', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: /prerequisites are incomplete/ }).waitFor();
  assert.match(
    await page.getByRole('alert').first().innerText(),
    /CFG\.FIN\.FYV\.ASSIGN/,
    'The refusal names the activity that is missing.',
  );
  assert.equal(await storedVariant(CLIENT, CREATED), undefined, 'A refused definition writes nothing.');
  console.log('  ✓ defining without a fiscal year variant assigned is refused, naming the missing activity');

  // ── 4. The screen refuses what the service refuses, before the click ───────
  await setActivityStatus(CLIENT, 'CFG.FIN.FYV.ASSIGN', 'COMPLETED');
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const panel = createPanel(page);
  await panel.locator('[name="variant"]').fill(SEEDED);
  await panel.locator('[name="name"]').fill('A description nobody saves');
  await panel.getByRole('alert').filter({ hasText: /is already defined/ }).waitFor();
  assert.equal(
    await panel.getByRole('button', { name: 'Define variant', exact: true }).isDisabled(),
    true,
    'A key that is taken cannot be submitted.',
  );
  // The key is held upper case as it is typed, so the operator sees what will be stored.
  await panel.locator('[name="variant"]').fill('bp01');
  assert.equal(await panel.locator('[name="variant"]').inputValue(), 'BP01', 'The key is upper case on the way in.');
  await panel.locator('[name="name"]').fill('');
  await panel.getByRole('alert').filter({ hasText: /description is required/ }).waitFor();
  assert.equal(
    await panel.locator('[name="name"]').getAttribute('maxlength'),
    '30',
    'The description is held to the contract width by the field itself.',
  );
  // And held in practice: a longer value is cut at thirty on the way in, so the width cannot be
  // exceeded by typing or by paste, and the service never sees what the contract forbids.
  await panel.locator('[name="name"]').fill('x'.repeat(35));
  assert.equal(
    (await panel.locator('[name="name"]').inputValue()).length,
    30,
    'A description longer than the contract is cut at thirty characters.',
  );
  await panel.locator('[name="name"]').fill('');
  console.log('  ✓ a taken key and a missing description are refused on the screen, and the key is upper cased as typed');

  // ── 5. Defining a variant creates its interval set ────────────────────────
  await panel.locator('[name="name"]').fill(CREATED_NAME);
  // The form says what the ruling costs before anybody submits: the variant is born open.
  assert.match(
    await panel.innerText(),
    /Created with the variant/,
    'The form states the interval set it is about to create.',
  );
  await panel.getByRole('button', { name: 'Define variant', exact: true }).click();
  await page.getByRole('status').filter({ hasText: /defined, with 5 intervals/ }).waitFor();
  assert.match(
    await page.getByRole('status').first().innerText(),
    /whole fiscal year/,
    'The answer says the variant is open, which is the consequence of being born usable.',
  );

  const stored = await storedVariant(CLIENT, CREATED);
  assert.equal(stored?.name, CREATED_NAME, 'The description is stored as submitted.');
  assert.equal(stored?.is_active, true, 'A new variant is active.');
  const intervals = await storedIntervals(CLIENT, CREATED);
  assert.equal(intervals.length, DEFAULT_INTERVALS.length, 'One interval per account type was created.');
  for (const expected of DEFAULT_INTERVALS) {
    const actual = intervals.find((row) => row.account_type === expected.accountType);
    assert.ok(actual, `The interval for ${expected.accountType} exists.`);
    assert.equal(actual?.period_from, expected.periodFrom, `${expected.accountType} opens at the promised period.`);
    assert.equal(actual?.period_to, expected.periodTo, `${expected.accountType} closes at the promised period.`);
    assert.equal(actual?.year_shift_past, expected.yearShiftPast, `${expected.accountType} prior-year shift.`);
    assert.equal(actual?.year_shift_future, expected.yearShiftFuture, `${expected.accountType} future-year shift.`);
    assert.equal(actual?.allow_special_periods, expected.allowSpecialPeriods, `${expected.accountType} special periods.`);
  }

  const created = await documents(CLIENT, CREATED);
  assert.equal(created.filter((doc) => doc.changeType === 'CREATE').length, 1, 'One CREATE document was filed.');
  const createItems = await documentItems(CLIENT, CREATED, 'CREATE');
  const byField = new Map(createItems.map((item) => [item.field_name, item]));
  assert.equal(byField.get('variant')?.is_security_relevant, 'true', 'The key is flagged for the auditor.');
  assert.equal(byField.get('intervals')?.is_security_relevant, 'true', 'The interval set is flagged for the auditor.');
  assert.equal(byField.get('name')?.is_security_relevant, 'false', 'A description is not.');
  assert.equal(
    byField.get('intervals')?.new_value,
    'S 1-12 +special, K 1-12, D 1-12, A 1-12 +special, M 1-12',
    'The document carries the interval set it created, in the reading order.',
  );
  assert.equal(await activityStatus(CLIENT, ACTIVITY), 'COMPLETED', 'The activity is complete once a variant exists.');
  console.log(`  ✓ ${CREATED} defined through the screen with its ${DEFAULT_INTERVALS.length} intervals, filed and flagged`);

  // ── 6. The new variant is in the registry, and the seeded one is untouched ──
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const rows = listSection(page).locator('tbody tr');
  assert.equal(await rows.filter({ hasText: CREATED }).count(), 1, 'The new variant is listed.');
  assert.equal(await rows.filter({ hasText: SEEDED }).count(), 1, 'The seeded variant is still listed.');
  assert.equal(
    (await storedVariant(CLIENT, SEEDED))?.name,
    'Standard period control',
    'Defining another variant changed nothing about the one that was there.',
  );

  // ── 7. Changing the description, and saving it again unchanged ────────────
  await openRowDialog(page, CREATED, 'Change');
  const changeDialog = page.locator('details[open]');
  assert.equal(
    await changeDialog.locator('input[readonly]').inputValue(),
    CREATED,
    'The key is read-only on change: a different key is a different variant.',
  );
  await changeDialog.locator('[name="name"]').fill(RENAMED);
  await changeDialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('status').filter({ hasText: /description of Posting Period Variant BP01 was saved/ }).waitFor();
  assert.equal((await storedVariant(CLIENT, CREATED))?.name, RENAMED, 'The new description is stored.');
  assert.equal(
    (await storedIntervals(CLIENT, CREATED)).length,
    DEFAULT_INTERVALS.length,
    'Changing the description does not touch the intervals.',
  );
  const changeItems = await documentItems(CLIENT, CREATED, 'CHANGE');
  assert.equal(changeItems.length, 1, 'Only the field that moved is filed.');
  assert.equal(changeItems[0].field_name, 'name', 'The filed field is the description.');
  assert.equal(changeItems[0].old_value, CREATED_NAME, 'The document carries what it was.');
  console.log('  ✓ the description changed, one item filed, and the intervals left alone');

  // An identical re-save is a no-op: no document, and the screen says so rather than implying
  // a write happened.
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const before = await documents(CLIENT, CREATED);
  await openRowDialog(page, CREATED, 'Change');
  await page.locator('details[open]').getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('status').filter({ hasText: /already had that description/ }).waitFor();
  assert.equal(
    (await documents(CLIENT, CREATED)).length,
    before.length,
    'Saving what is already stored files nothing.',
  );
  console.log('  ✓ an identical re-save is reported as unchanged and files no document');

  // ── 8. A variant a Company Code posts against cannot be deleted ───────────
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await openRowDialog(page, SEEDED, 'Delete');
  const deleteDialog = page.locator('details[open]');
  await deleteDialog.getByRole('alert').filter({ hasText: /cannot be deleted/ }).waitFor();
  const refusal = await deleteDialog.getByRole('alert').first().innerText();
  for (const company of await storedCompanyCodes(CLIENT, SEEDED)) {
    assert.ok(refusal.includes(company), `The refusal names Company Code ${company}.`);
  }
  assert.match(refusal, /CFG\.FIN\.PPV\.ASSIGN/, 'The refusal names the activity that reassigns them.');
  assert.equal(
    await deleteDialog.getByRole('button', { name: 'Delete variant', exact: true }).isDisabled(),
    true,
    'The operator is not offered a button the write side would reject.',
  );
  await page.screenshot({ path: '.arena/posting-period-variants-delete-refused-review.png', fullPage: true });
  assert.ok(await storedVariant(CLIENT, SEEDED), 'The seeded variant survives the refused deletion.');
  console.log('  ✓ deletion of a variant in use is refused on the screen, naming every Company Code holding it');

  // ── 9. Deleting an unreferenced variant takes its own intervals ───────────
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await openRowDialog(page, CREATED, 'Delete');
  await page.locator('details[open]').getByRole('button', { name: 'Delete variant', exact: true }).click();
  // The dialog lives in the row the deletion removes, so the confirmation comes back as a
  // banner on the registry rather than into a node that no longer exists.
  await page.waitForURL(/deleted=BP01/, { waitUntil: 'commit' });
  await page.getByRole('status').filter({ hasText: /was deleted, with the 5 intervals it held/ }).waitFor();
  assert.equal(await storedVariant(CLIENT, CREATED), undefined, 'The variant row is gone.');
  assert.equal((await storedIntervals(CLIENT, CREATED)).length, 0, 'Its intervals went with it.');
  const removal = await documentItems(CLIENT, CREATED, 'DELETE');
  const removedFields = new Map(removal.map((item) => [item.field_name, item]));
  assert.equal(removedFields.get('variant')?.old_value, CREATED, 'The document carries the key that was deleted.');
  assert.equal(removedFields.get('variant')?.new_value, null, 'A deletion files a null new value.');
  assert.equal(removedFields.get('variant')?.is_security_relevant, 'true', 'The deletion is flagged for the auditor.');
  assert.equal(
    removedFields.get('intervals')?.old_value,
    'S 1-12 +special, K 1-12, D 1-12, A 1-12 +special, M 1-12',
    'The document carries the interval set that was removed, so the deletion is reviewable.',
  );
  console.log('  ✓ an unreferenced variant was deleted with its intervals, and the deletion is reviewable');

  // ── 10. The registry reads back without it ────────────────────────────────
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  assert.equal(
    await listSection(page).locator('tbody tr').filter({ hasText: CREATED }).count(),
    0,
    'The deleted variant is not listed.',
  );
  assert.equal(
    await listSection(page).locator('tbody tr').filter({ hasText: SEEDED }).count(),
    1,
    'The variant the tenant posts against is still there.',
  );
  console.log('  ✓ the registry reads back without the deleted variant and with the one in use');

  console.log('SCR-031 OBBO passed: registry, interval set, live refusals, change, no-op and deletion guards');
}

function createPanel(page: Page) {
  return page.locator('section[aria-labelledby="ppv-create-title"]');
}

function listSection(page: Page) {
  return page.locator('section[aria-labelledby="ppv-list-title"]');
}

/** Open a row's dialog. Its content is not reachable while the disclosure is closed. */
async function openRowDialog(page: Page, variant: string, action: 'Change' | 'Delete') {
  const row = listSection(page).locator('tbody tr').filter({ hasText: variant }).first();
  await row.waitFor();
  await row.getByText(action, { exact: true }).click();
  await page.locator('details[open]').waitFor();
}

type StoredVariant = { variant: string; name: string; is_active: boolean };

async function storedVariant(client: string, variant: string): Promise<StoredVariant | undefined> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(
      sql`select variant, name, is_active
            from posting_period_variant
           where variant = ${variant}`,
    ),
  )) as unknown as StoredVariant[];
  return rows[0];
}

type StoredInterval = {
  account_type: string;
  period_from: number;
  period_to: number;
  year_shift_past: number;
  year_shift_future: number;
  allow_special_periods: boolean;
};

async function storedIntervals(client: string, variant: string): Promise<StoredInterval[]> {
  return (await withTenant(client, (tx) =>
    tx.execute(
      sql`select account_type, period_from, period_to, year_shift_past, year_shift_future, allow_special_periods
            from posting_period_rule
           where variant = ${variant}
           order by account_type`,
    ),
  )) as unknown as StoredInterval[];
}


async function storedCompanyCodes(client: string, variant: string): Promise<string[]> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(
      sql`select company_code from company_code
           where posting_period_variant = ${variant}
           order by company_code`,
    ),
  )) as unknown as Array<{ company_code: string }>;
  return rows.map((row) => row.company_code);
}

async function documents(client: string, variant: string) {
  return withTenant(client, (tx) => changeHistory(tx, client, 'posting_period_variant', variant));
}

type StoredItem = {
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  is_security_relevant: string;
};

async function documentItems(client: string, variant: string, changeType: string): Promise<StoredItem[]> {
  return (await withTenant(client, (tx) =>
    tx.execute(
      sql`select i.field_name, i.old_value, i.new_value, i.is_security_relevant
            from change_document_item i
            join change_document d on d.id = i.change_document_id
           where d.object_class = 'posting_period_variant'
             and d.object_key = ${variant}
             and d.change_type = ${changeType}
           order by i.field_name`,
    ),
  )) as unknown as StoredItem[];
}

async function activityStatus(client: string, activityCode: string): Promise<string | undefined> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(
      sql`select status from config_activity_status where activity_code = ${activityCode}`,
    ),
  )) as unknown as Array<{ status: string }>;
  return rows[0]?.status;
}

/**
 * Move the workbench row behind the screen's back, because the point is what the screen says
 * when a prerequisite is missing — and completing it is another screen's acceptance.
 */
async function setActivityStatus(client: string, activityCode: string, status: string) {
  await withTenant(client, (tx) =>
    tx.execute(
      sql`insert into config_activity_status (client, activity_code, status, created_by)
          values (${client}, ${activityCode}, ${status}, 'BROWSER_FIXTURE')
          on conflict (client, activity_code) do update
             set status = ${status},
                 completed_at = case when ${status} = 'COMPLETED' then now() else null end,
                 completed_by = case when ${status} = 'COMPLETED' then 'BROWSER_FIXTURE' else null end`,
    ),
  );
}
