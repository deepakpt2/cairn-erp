import type { Locator, Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import { periodWindows } from '../../src/platform/periods';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/fiscal-year-variants';
const ASSIGN_ROUTE = '/config/fiscal-year-variants/assign-company-codes';
const ACTIVITY = 'CFG.FIN.FYV.DEFINE';
/** The variant the standard package defines and both books already post in. */
const SEEDED = 'K4';
/** A calendar-year variant: its periods are derived from its own counts and never maintained. */
const CALENDAR = 'K6';
/** A shifted, year-dependent variant: nothing is derived, so its periods must be maintained. */
const MAINTAINED = 'V4';
/** The Company Code the onboarding run creates, used here to make a variant referenced. */
const COMPANY_CODE = '1000';
const REASON = 'Browser acceptance run';

/**
 * SCR-029 / OB29 browser acceptance: the fiscal year variant registry and its period lists.
 *
 * A browser tenant starts with no variants at all, so this target defines its own and then proves
 * the two halves of the screen against each other. The half that is easy to get wrong is the
 * period list, because half of every period is never stored: a row holds the period's end, and the
 * posting engine derives each start from the previous end. The rendered windows are therefore
 * compared with the engine's own output, for a derived list and for a maintained one.
 *
 * The retirement guard needs a variant that something actually posts in, and creating that
 * reference is the OB37 screen's job, so this target drives it: the two screens must agree about
 * what "in use" means, and only one of them can be right if they are tested apart.
 */
export async function fiscalYearVariantsOb29(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-029 OB29: verify the registry, derived and maintained period lists, and the retirement guards');

  // ── 1. The registry renders what the package defined, periods included ────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Fiscal Year Variants', exact: true }).waitFor();
  assert.match(
    await page.locator('.code.text-2xs').first().innerText(),
    new RegExp(`${ACTIVITY} · OB29`),
    'The screen says which activity and which reference transaction it is.',
  );
  assert.equal(
    await page.locator('section[aria-labelledby="fyv-variant-list-title"] tbody tr').count(),
    1,
    'The standard package defines exactly one variant, and this screen adds none behind your back.',
  );
  const seededRow = variantRow(page, SEEDED);
  await seededRow.waitFor();
  assert.match(await seededRow.innerText(), /Calendar year \+ 4 special/, 'The seeded variant is listed with its description.');
  assert.equal((await storedPeriods(client, SEEDED)).length, 16, 'Its periods were derived when the package was installed.');

  // The periods sit behind a disclosure, and what they show is what posting will enforce.
  await seededRow.getByText('Periods', { exact: true }).click();
  const seededGrid = seededRow.locator('details[open]');
  await seededGrid.waitFor();
  // A calendar-year variant has no list to maintain, so its panel says the periods are derived
  // rather than showing a grid: the sixteen rows exist, and nothing on the screen can drift from
  // the counts that produced them. The engine comparison belongs to the maintained variant below.
  assert.equal(
    await seededGrid.locator('tbody tr').count(),
    0,
    'There is no period grid for a variant whose periods follow from its own parameters.',
  );
  assert.match(
    await seededGrid.innerText(),
    /12 posting periods and 4 special periods .* derived from its own parameters/,
    'The panel names the counts the periods were derived from.',
  );
  console.log(`  ✓ the registry lists ${SEEDED} with its 16 derived periods and no list to maintain`);

  // ── 2. The workbench sends the activity here ──────────────────────────────
  await page.goto(`${base}/config`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const workbenchRow = page.locator('tr').filter({ hasText: ACTIVITY }).first();
  await workbenchRow.waitFor();
  assert.equal(
    await workbenchRow.getByRole('link', { name: 'Open', exact: true }).getAttribute('href'),
    ROUTE,
    'The workbench opens the screen that can do the work.',
  );
  console.log('  ✓ the workbench routes the activity to this screen');

  // ── 3. A calendar-year variant derives its own periods ────────────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const panel = createPanel(page);
  await panel.locator('[name="variant"]').fill(CALENDAR);
  await panel.locator('[name="name"]').fill('Calendar year, two adjustment');
  await panel.locator('[name="specialPeriods"]').fill('2');
  await panel.locator('[name="isCalendarYear"]').check();
  await panel.locator('[name="reason"]').fill(REASON);
  await submitCreate(page).click();
  await page.getByRole('status').filter({ hasText: /defined, with 14 period\(s\) derived/ }).waitFor();

  const calendar = await storedVariant(client, CALENDAR);
  assert.equal(calendar?.is_calendar_year, true, 'The flag is stored.');
  assert.equal(calendar?.version, 1, 'A new variant starts at version one.');
  const derived = await storedPeriods(client, CALENDAR);
  assert.equal(derived.length, 14, 'Twelve ordinary periods and the two entered for year-end adjustment were derived.');
  assert.equal(
    derived.every((row) => row.calendar_year === 0),
    true,
    'A calendar-year variant holds one list for every year, stored against year zero.',
  );
  assert.equal(
    derived.filter((row) => row.period_type === 'SPECIAL').length,
    2,
    'The two adjustment periods are typed as special.',
  );
  console.log(`  ✓ ${CALENDAR} defined through the screen, with 14 periods derived from the counts entered`);

  // ── 4. A variant defined here is derived from the counts entered ──────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const calendarRow = variantRow(page, CALENDAR);
  await calendarRow.waitFor();
  assert.match(
    await calendarRow.innerText(),
    /Calendar year, two adjustment/,
    'The variant defined a moment ago is listed with the description that was typed.',
  );
  await calendarRow.getByText('Periods', { exact: true }).click();
  const calendarPanel = calendarRow.locator('details[open]');
  await calendarPanel.waitFor();
  assert.equal(
    await calendarPanel.locator('tbody tr').count(),
    0,
    'Its periods are derived too, so there is no list to maintain.',
  );
  assert.match(
    await calendarPanel.innerText(),
    /12 posting periods and 2 special periods .* derived from its own parameters/,
    'The panel names the counts that were entered, not the ones the package ships.',
  );
  console.log(`  ✓ ${CALENDAR} is listed with its own description and derived from the counts entered`);

  // ── 5. The screen refuses what the service refuses, before the click ──────
  await createPanel(page).locator('[name="name"]').fill('A description nobody saves');
  // The key field holds the contract width itself, so a longer key never reaches the service:
  // asserting the cut is the point, because a field that accepted three characters would leave
  // the refusal to the database.
  assert.equal(
    await createPanel(page).locator('[name="variant"]').getAttribute('maxlength'),
    '2',
    'The key field is held to the contract width.',
  );
  await createPanel(page).locator('[name="variant"]').fill('ABC');
  assert.equal(
    await createPanel(page).locator('[name="variant"]').inputValue(),
    'AB',
    'A longer key is cut to two characters by the field.',
  );

  await createPanel(page).locator('[name="variant"]').fill(SEEDED);
  await problem(page, /is already defined/).waitFor();
  assert.equal(await submitCreate(page).isDisabled(), true, 'A key that is taken cannot be submitted.');

  await createPanel(page).locator('[name="variant"]').fill(MAINTAINED);
  await problem(page, /State why this variant is defined/).waitFor();
  assert.equal(await submitCreate(page).isDisabled(), true, 'A definition without a reason cannot be submitted.');
  assert.equal(
    await createPanel(page).locator('[name="name"]').getAttribute('maxlength'),
    '30',
    'The description is held to the contract width by the field itself.',
  );
  console.log('  ✓ a short key, a taken key and a missing reason are refused on the screen, before the click');

  // ── 6. A shifted variant is defined with nothing derived ──────────────────
  await createPanel(page).locator('[name="variant"]').fill(MAINTAINED);
  await createPanel(page).locator('[name="name"]').fill('April to March');
  await createPanel(page).locator('[name="specialPeriods"]').fill('0');
  await createPanel(page).locator('[name="isYearDependent"]').check();
  await createPanel(page).locator('[name="reason"]').fill(REASON);
  await submitCreate(page).click();
  await page.getByRole('status').filter({ hasText: /defined, with 0 period\(s\) derived/ }).waitFor();
  assert.equal((await storedPeriods(client, MAINTAINED)).length, 0, 'Nothing was derived for a shifted year.');
  assert.equal((await storedVariant(client, MAINTAINED))?.is_year_dependent, true, 'The flag is stored.');
  console.log(`  ✓ ${MAINTAINED} defined with a shifted year and no periods, because its year does not derive them`);

  // ── 7. The maintained list is written one calendar year at a time ─────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const maintainedRow = variantRow(page, MAINTAINED);
  await maintainedRow.getByText('Periods', { exact: true }).click();
  const editor = maintainedRow.locator('details[open]');
  await editor.waitFor();
  assert.equal(await editor.locator('tbody tr').count(), 12, 'One row per period the variant defines.');
  assert.equal(
    await editor.getByRole('button', { name: 'Save period list', exact: true }).isDisabled(),
    true,
    'A period list without a reason cannot be saved.',
  );
  // Every period end is a number input too, so the year field is picked out by its own bounds.
  const year = Number(await editor.locator('input[type="number"][max="9999"]').inputValue());
  assert.ok(year >= 1 && year <= 9999, 'A year-dependent variant is maintained one calendar year at a time.');

  await editor.locator(`#fyv-periods-reason-${MAINTAINED}`).fill(REASON);
  await editor.getByRole('button', { name: 'Save period list', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Periods of ${MAINTAINED} for ${year} saved: 12 period\\(s\\)`) })
    .waitFor();

  const saved = await storedPeriods(client, MAINTAINED);
  assert.equal(saved.length, 12, 'Twelve ends were stored.');
  assert.equal(
    saved.every((row) => row.calendar_year === year),
    true,
    'They are stored against the calendar year the editor was showing.',
  );

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const readBack = variantRow(page, MAINTAINED);
  await readBack.getByText('Periods', { exact: true }).click();
  const readBackGrid = readBack.locator('details[open]');
  await readBackGrid.waitFor();
  // An editable grid shows the ends that were stored, in the fields that hold them. The derived
  // starts appear only once the list is read-only, which is where they are compared below.
  const storedEnds = await storedPeriods(client, MAINTAINED);
  for (const stored of storedEnds) {
    // exact: without it, "day 1" also matches the labels of periods 11 and 12.
    const day = readBackGrid.getByRole('spinbutton', { name: `Ends on day ${stored.period}`, exact: true });
    assert.equal(
      await day.inputValue(),
      String(stored.day),
      `Period ${stored.period} offers the day that was stored.`,
    );
  }
  console.log(`  ✓ the maintained list saved for ${year} and the grid offers back every end that was stored`);

  // ── 8. Saving the same list again changes nothing ─────────────────────────
  const versionBefore = (await storedVariant(client, MAINTAINED))?.version;
  const documentsBefore = (await documents(client, MAINTAINED, 'fiscal_year_period')).length;
  await readBack.locator(`#fyv-periods-reason-${MAINTAINED}`).fill(REASON);
  await readBackGrid.getByRole('button', { name: 'Save period list', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: /was already stored exactly as submitted; nothing was changed/ })
    .waitFor();
  assert.equal((await storedVariant(client, MAINTAINED))?.version, versionBefore, 'A no-op does not move the version.');
  assert.equal(
    (await documents(client, MAINTAINED, 'fiscal_year_period')).length,
    documentsBefore,
    'A no-op files no document.',
  );
  console.log('  ✓ an identical period list is reported unchanged, moves no version and files no document');

  // ── 9. The assignment screen reads the same registry ──────────────────────
  // Which variant a Company Code posts in is decided on the OB37 screen, so the retirement guard
  // below is only meaningful if the two screens agree about what is defined and what is in use.
  await page.goto(`${base}${ASSIGN_ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const assignmentRow = page
    .locator('section[aria-labelledby="fyv-assignment-grid-title"]')
    .locator('tbody tr')
    .filter({ hasText: COMPANY_CODE })
    .first();
  await assignmentRow.waitFor();
  assert.match(
    await assignmentRow.innerText(),
    new RegExp(SEEDED),
    `Company Code ${COMPANY_CODE} is shown posting in the variant the package assigned.`,
  );
  await assignmentRow.getByText('Assign', { exact: true }).first().click();
  const assignment = page.getByRole('dialog', { name: `Assign ${COMPANY_CODE}` });
  await assignment.waitFor();
  // By value, not by text: the placeholder option carries a label but no variant.
  const offered = await assignment
    .locator(`#fyv-assignment-variant-${COMPANY_CODE} option:not([value=""])`)
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  const active = (await storedActiveVariants(client)).sort();
  assert.deepEqual(
    offered.sort(),
    active,
    'The assignment offers exactly the variants this screen defines as active.',
  );
  assert.equal(
    await assignment.getByRole('button', { name: 'Assign', exact: true }).isDisabled(),
    true,
    'An assignment without a reason cannot be submitted.',
  );
  await assignment.getByRole('button', { name: 'Close', exact: true }).click();
  console.log(`  ✓ the assignment screen offers exactly the ${active.length} active variants, and needs a reason`);

  // ── 10. A variant the books post in cannot be retired ─────────────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await openLifecycle(page, SEEDED, 'Deactivate');
  const guarded = page.getByRole('dialog', { name: `Deactivate ${SEEDED}` });
  await guarded.locator(`#fyv-lifecycle-${SEEDED}`).fill(REASON);
  await guarded.getByRole('button', { name: 'Deactivate', exact: true }).click();
  const refusal = guarded.getByRole('alert').filter({ hasText: /is still used by/ });
  await refusal.waitFor();
  const books = await referencingBooks(client, SEEDED);
  const refusalText = await refusal.innerText();
  assert.match(
    refusalText,
    new RegExp(`\\(${books} in all\\)`),
    'The refusal says how many books still post in the variant.',
  );
  assert.match(refusalText, new RegExp(COMPANY_CODE), 'The refusal names a book that still uses it.');
  assert.equal((await storedVariant(client, SEEDED))?.is_active, true, 'The variant is still active.');
  await page.screenshot({ path: '.arena/fiscal-year-variants-lifecycle-refused-review.png', fullPage: true });
  console.log(`  ✓ retiring ${SEEDED} is refused while ${books} book(s) post in it, and nothing was written`);

  // ── 11. Retirement, and the starts the engine derives ─────────────────────
  // Retiring a variant nothing references is allowed, and retirement makes its period list
  // read-only — which is the only rendering that shows the start the engine derives from each
  // stored end. So the comparison the whole screen exists for happens here.
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await openLifecycle(page, MAINTAINED, 'Deactivate');
  const retiring = page.getByRole('dialog', { name: `Deactivate ${MAINTAINED}` });
  await retiring.locator(`#fyv-lifecycle-${MAINTAINED}`).fill(REASON);
  await retiring.getByRole('button', { name: 'Deactivate', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: /deactivated\. Company Codes and Controlling Areas keep it/ })
    .waitFor();
  assert.equal((await storedVariant(client, MAINTAINED))?.is_active, false, 'The flag is stored.');

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const retiredRow = variantRow(page, MAINTAINED);
  await retiredRow.getByText('Periods', { exact: true }).click();
  const retiredGrid = retiredRow.locator('details[open]');
  await retiredGrid.waitFor();
  assert.equal(
    await retiredGrid.getByRole('button', { name: 'Save period list', exact: true }).count(),
    0,
    'A retired variant offers no save: its list is read-only.',
  );
  await assertRenderedWindows(client, MAINTAINED, year, retiredGrid);
  assert.match(
    await retiredGrid.innerText(),
    /Special periods share the last ordinary period|\d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2}/,
    'The read-only list shows a window, or says why a period has none.',
  );

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await openLifecycle(page, MAINTAINED, 'Reactivate');
  const restoring = page.getByRole('dialog', { name: `Reactivate ${MAINTAINED}` });
  await restoring.locator(`#fyv-lifecycle-${MAINTAINED}`).fill(REASON);
  await restoring.getByRole('button', { name: 'Reactivate', exact: true }).click();
  await page.getByRole('status').filter({ hasText: /is active again/ }).waitFor();
  assert.equal((await storedVariant(client, MAINTAINED))?.is_active, true, 'The variant is active again.');
  // Retirement is not deletion: neither list lost a row.
  assert.equal((await storedPeriods(client, MAINTAINED)).length, 12, 'The maintained periods were retained.');
  assert.equal((await storedPeriods(client, SEEDED)).length, 16, 'The seeded variant kept its derived periods.');
  // Leave the screen the way a reader would find it. The run signs out from here, and a lifecycle
  // dialog left open covers the sign-out control with its own overlay.
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const restoredRow = variantRow(page, MAINTAINED);
  await restoredRow.waitFor();
  await restoredRow.getByText('Deactivate', { exact: true }).first().waitFor();
  console.log(`  ✓ ${MAINTAINED} retired, its derived starts shown against the engine, then restored with nothing removed`);

  console.log('SCR-029 OB29 passed: registry, derived and maintained periods, no-op and retirement guards');
}

function createPanel(page: Page) {
  return page.locator('section[aria-labelledby="fyv-variant-create-title"]');
}

function variantRow(page: Page, variant: string) {
  return page
    .locator('section[aria-labelledby="fyv-variant-list-title"]')
    .locator('tbody tr')
    .filter({ hasText: variant })
    .first();
}

/**
 * A live validation problem in the create panel.
 *
 * These are plain paragraphs: the role belongs to the message an action returns, not to the
 * checks the form runs while it is being filled, so filtering on role="alert" finds nothing here.
 */
function problem(page: Page, text: RegExp) {
  return createPanel(page).locator('p').filter({ hasText: text }).first();
}

function submitCreate(page: Page) {
  return createPanel(page).getByRole('button', { name: 'Create Fiscal Year Variant', exact: true });
}

/** Open a row's lifecycle dialog. Its content is not reachable while the disclosure is closed. */
async function openLifecycle(page: Page, variant: string, action: 'Deactivate' | 'Reactivate') {
  const row = variantRow(page, variant);
  await row.waitFor();
  await row.getByText(action, { exact: true }).first().click();
  await page.getByRole('dialog', { name: `${action} ${variant}` }).waitFor();
}

/**
 * Assert that every window a grid renders is the window the posting engine derives.
 *
 * The engine is asked directly rather than the rule being copied here: the screen claims to show
 * what posting will enforce, and a harness with its own third implementation of the rule could
 * agree with the screen while both were wrong.
 */
async function assertRenderedWindows(client: string, variant: string, year: number, grid: Locator) {
  const regular = (await storedPeriods(client, variant))
    .filter((row) => row.period_type === 'REGULAR' && row.calendar_year === year)
    .map((row) => ({ period: row.period, month: row.month, day: row.day, yearShift: row.year_shift }));
  assert.ok(regular.length > 0, 'There is an ordinary period list to compare.');
  const rendered = await grid.innerText();
  for (const window of periodWindows(regular, year)) {
    const start = new Date(window.start).toISOString().slice(0, 10);
    const end = new Date(window.end).toISOString().slice(0, 10);
    assert.ok(rendered.includes(`${start} → ${end}`), `Period ${window.period} shows ${start} → ${end}.`);
  }
}

type StoredVariant = {
  variant: string;
  name: string;
  is_calendar_year: boolean;
  regular_periods: number;
  special_periods: number;
  is_year_dependent: boolean;
  is_active: boolean;
  version: number;
};

async function storedVariant(client: string, variant: string): Promise<StoredVariant | undefined> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(
      sql`select variant, name, is_calendar_year, regular_periods, special_periods,
                 is_year_dependent, is_active, version
            from fiscal_year_variant
           where variant = ${variant}`,
    ),
  )) as unknown as StoredVariant[];
  return rows[0];
}

type StoredPeriod = {
  calendar_year: number;
  period: number;
  period_type: string;
  month: number;
  day: number;
  year_shift: number;
};

async function storedPeriods(client: string, variant: string): Promise<StoredPeriod[]> {
  return (await withTenant(client, (tx) =>
    tx.execute(
      sql`select calendar_year, period, period_type, month, day, year_shift
            from fiscal_year_period
           where variant = ${variant}
           order by calendar_year, period`,
    ),
  )) as unknown as StoredPeriod[];
}

/** The variants this screen defines as active — the set the assignment screen must offer. */
async function storedActiveVariants(client: string): Promise<string[]> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql`select variant from fiscal_year_variant where is_active order by variant`),
  )) as unknown as Array<{ variant: string }>;
  return rows.map((row) => row.variant);
}

/** How many books post in a variant: the count the retirement refusal must name. */
async function referencingBooks(client: string, variant: string): Promise<number> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(
      sql`select
            (select count(*)::int from company_code where fiscal_year_variant = ${variant})
          + (select count(*)::int from controlling_area where fiscal_year_variant = ${variant})
            as books`,

    ),
  )) as unknown as Array<{ books: number }>;
  return Number(rows[0]?.books ?? 0);
}

async function documents(client: string, variant: string, objectClass = 'fiscal_year_variant') {
  return withTenant(client, (tx) => changeHistory(tx, client, objectClass, variant));
}
