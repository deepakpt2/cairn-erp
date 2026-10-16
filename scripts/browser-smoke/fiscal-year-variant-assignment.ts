import type { Locator, Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/fiscal-year-variants/assign-company-codes';
const VARIANTS_ROUTE = '/config/fiscal-year-variants';
const COMPANY_CODES_ROUTE = '/config/company-codes';
const ACTIVITY = 'CFG.FIN.FYV.ASSIGN';
/** The Company Code the standard package creates, linked to Controlling Area A000. */
const LINKED = '1000';
/** A second Company Code, created here, with no Controlling Area and nothing posted. */
const FREE = '2000';
const SEEDED_VARIANT = 'K4';
const SHIFTED = 'V4';
const SPARE = 'K6';
const AREA = 'A000';
const REASON = 'Browser acceptance run';

/**
 * SCR-030 / OB37 browser acceptance: assigning the fiscal year variant a Company Code posts in.
 *
 * The screen's whole difficulty is that it is not free to choose. A Company Code linked to a
 * Controlling Area shares that area's variant, so the interesting cases are the refusals: the one
 * the screen makes before the click, naming the area and the variant it holds, and the one the
 * service makes when the row changed underneath the form.
 *
 * A success needs a Company Code whose variant is genuinely its own, so this target defines a
 * second one through the Company Code screen and assigns that, leaving the linked book untouched.
 * The variants it assigns are defined through the OB29 screen, because that is where variants come
 * from: a harness that inserted them would be testing an assignment nobody could make.
 */
export async function fiscalYearVariantAssignmentOb37(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-030 OB37: verify the assignment grid, the Controlling Area refusal, a clean assignment and the guards');

  // The variants this target assigns are defined the way a configurator defines them.
  await defineVariant(page, base, { variant: SHIFTED, name: 'April to March', specialPeriods: 0, yearDependent: true });
  await defineVariant(page, base, { variant: SPARE, name: 'Calendar year, two adjustment', specialPeriods: 2, calendarYear: true });

  // ── 1. The grid reads every Company Code beside what it posts in ──────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Assign Fiscal Year Variant to Company Code', exact: true }).waitFor();
  assert.match(
    await page.locator('.code.text-2xs').first().innerText(),
    new RegExp(`${ACTIVITY} · OB37`),
    'The screen says which activity and which reference transaction it is.',
  );
  const linkedRow = gridRow(page, LINKED);
  await linkedRow.waitFor();
  const linkedText = await linkedRow.innerText();
  assert.match(linkedText, new RegExp(SEEDED_VARIANT), 'The linked book is shown posting in the package variant.');
  assert.match(linkedText, new RegExp(`Area variant ${SEEDED_VARIANT}`), 'The grid shows the Controlling Area variant beside it.');
  assert.match(linkedText, /Nothing posted/, 'The grid says whether anything was posted in that book.');

  await page.goto(`${base}/config`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const workbenchRow = page.locator('tr').filter({ hasText: ACTIVITY }).first();
  await workbenchRow.waitFor();
  assert.equal(
    await workbenchRow.getByRole('link', { name: 'Open', exact: true }).getAttribute('href'),
    ROUTE,
    'The workbench opens the screen that can do the work.',
  );
  console.log(`  ✓ the grid reads ${LINKED} beside its variant, its area and its postings, and the workbench routes here`);

  // ── 2. A linked book cannot move while the area holds another variant ─────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const linkedDialog = await openAssignment(page, LINKED);
  await linkedDialog.locator(`#fyv-assignment-variant-${LINKED}`).selectOption(SHIFTED);
  const conflict = linkedDialog.getByRole('alert').filter({ hasText: /Controlling Area/ });
  await conflict.waitFor();
  const conflictText = await conflict.innerText();
  assert.match(conflictText, new RegExp(AREA), 'The refusal names the Controlling Area that holds the book.');
  assert.match(conflictText, new RegExp(SEEDED_VARIANT), 'It names the variant that area posts in.');
  assert.match(conflictText, new RegExp(SHIFTED), 'It names the variant the book was being moved to.');
  assert.equal(
    await linkedDialog.getByRole('button', { name: 'Assign', exact: true }).isDisabled(),
    true,
    'The screen refuses before the click, so nothing reaches the service.',
  );
  assert.equal(await storedCompanyVariant(client, LINKED), SEEDED_VARIANT, 'The linked book still posts in its variant.');
  assert.equal((await assignmentDocuments(client, LINKED)).length, 0, 'A refused assignment files no document.');
  await page.screenshot({ path: '.arena/fyv-assignment-area-conflict-review.png', fullPage: true });
  console.log(`  ✓ moving ${LINKED} is refused on the screen, naming ${AREA} and both variants, and nothing was written`);

  // ── 3. Choosing the variant a book already posts in is answered, not refused ─
  // The screen says so as a notice and still lets the request through, because "nothing to do" is
  // an answer the service gives rather than a rule the form enforces. What matters is that the
  // answer files no document and moves nothing.
  await linkedDialog.locator(`#fyv-assignment-variant-${LINKED}`).selectOption(SEEDED_VARIANT);
  await linkedDialog.getByRole('status').filter({ hasText: /already posts in/ }).waitFor();
  await linkedDialog.locator(`#fyv-assignment-reason-${LINKED}`).fill(REASON);
  assert.equal(
    await linkedDialog.getByRole('button', { name: 'Assign', exact: true }).isDisabled(),
    false,
    'The notice does not block the request; the service is what answers it.',
  );
  await linkedDialog.getByRole('button', { name: 'Assign', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`already posted in Fiscal Year Variant ${SEEDED_VARIANT}; nothing was changed`) })
    .waitFor();
  assert.equal(await storedCompanyVariant(client, LINKED), SEEDED_VARIANT, 'The book still posts in its variant.');
  assert.equal((await assignmentDocuments(client, LINKED)).length, 0, 'A change that did nothing filed no document.');
  console.log(`  ✓ re-choosing ${SEEDED_VARIANT} for ${LINKED} is answered as a no-op that files no document`);

  // ── 4. A second Company Code, with no area and no variant yet ─────────────
  await page.goto(`${base}${COMPANY_CODES_ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.locator('[name="companyCode"]').fill(FREE);
  await page.locator('[name="name"]').fill('Second book');
  await page.locator('[name="country"]').selectOption('KW');
  await page.locator('[name="currency"]').selectOption('KWD');
  await page.locator('[name="city"]').fill('Al Jahra');
  await page.getByRole('button', { name: 'Create company code', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Company code ${FREE} defined`) })
    .waitFor();

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const freeRow = gridRow(page, FREE);
  await freeRow.waitFor();
  const freeText = await freeRow.innerText();
  // Case-insensitive on purpose: innerText reports what is rendered, and a chip is upper-cased by
  // its own styling, so the catalogue's 'Not assigned' arrives as 'NOT ASSIGNED'.
  assert.match(freeText, /Not assigned/i, 'A new Company Code posts in no variant yet.');
  assert.match(freeText, /No Controlling Area/i, 'And it is linked to no area, so its variant is its own.');
  console.log(`  ✓ ${FREE} defined through the Company Code screen and listed with no variant and no area`);

  // ── 5. The choice is exactly the active variants, and a reason is required ─
  const freeDialog = await openAssignment(page, FREE);
  const offered = await optionValues(freeDialog.locator(`#fyv-assignment-variant-${FREE}`));
  assert.deepEqual(offered.sort(), (await storedActiveVariants(client)).sort(), 'Only active variants can be assigned.');
  await freeDialog.locator(`#fyv-assignment-variant-${FREE}`).selectOption(SHIFTED);
  await freeDialog.getByRole('alert').filter({ hasText: /A reason is required/ }).waitFor();
  assert.equal(
    await freeDialog.getByRole('button', { name: 'Assign', exact: true }).isDisabled(),
    true,
    'An assignment without a reason cannot be submitted.',
  );
  console.log('  ✓ the choice is exactly the active variants, and a reason is required before the click');

  // ── 6. Assigning it writes the variant, the reason and the document ───────
  await freeDialog.locator(`#fyv-assignment-reason-${FREE}`).fill(REASON);
  await freeDialog.getByRole('button', { name: 'Assign', exact: true }).click();
  // Scoped, because the dialog also carries a live notice with the same role: reading every
  // status on the page would resolve to two elements and say nothing about either.
  const success = page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Company Code ${FREE} now posts in Fiscal Year Variant ${SHIFTED}`) });
  await success.waitFor();
  assert.match(
    await success.innerText(),
    /it posted in Not assigned/,
    'The answer says what the book posted in before, including when that was nothing.',
  );
  assert.equal(await storedCompanyVariant(client, FREE), SHIFTED, 'The assignment is stored.');
  assert.equal(await storedCompanyVariant(client, LINKED), SEEDED_VARIANT, 'The linked book was not touched.');

  const documents = await assignmentDocuments(client, FREE);
  assert.equal(documents.length, 1, 'One assignment, one document.');
  // Read through the history the screen itself reads, rather than around it.
  const [document] = documents;
  const fields = document.items.map((item) => item.fieldName);
  assert.ok(fields.includes('fiscalYearVariant'), 'The document names the field that changed.');
  const variantItem = document.items.find((item) => item.fieldName === 'fiscalYearVariant')!;
  assert.equal(variantItem.newValue, SHIFTED, 'It records the variant the book now posts in.');
  assert.equal(variantItem.oldValue, null, 'It records that the book posted in nothing before.');
  assert.equal(document.reason, REASON, 'The reason is recorded on the document, as the screen promises.');
  console.log(`  ✓ ${FREE} assigned to ${SHIFTED}, stored, and documented with the reason and the previous value`);

  // ── 7. The grid reads the change back ─────────────────────────────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const reassigned = gridRow(page, FREE);
  await reassigned.waitFor();
  assert.match(await reassigned.innerText(), new RegExp(SHIFTED), 'The grid shows the variant that was assigned.');
  const reopened = await openAssignment(page, FREE);
  assert.equal(
    await reopened.locator(`#fyv-assignment-variant-${FREE}`).inputValue(),
    SHIFTED,
    'The dialog opens on the variant the book already posts in, rather than asking again.',
  );
  await reopened.getByRole('status').filter({ hasText: /already posts in/ }).waitFor();
  await reopened.locator(`#fyv-assignment-reason-${FREE}`).fill(REASON);
  await reopened.getByRole('button', { name: 'Assign', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: /nothing was changed/ })
    .waitFor();
  assert.equal((await assignmentDocuments(client, FREE)).length, 1, 'A second identical assignment filed no second document.');
  console.log('  ✓ the grid reads the assignment back and a second identical one files no second document');

  // ── 8. A retired variant is not offered ───────────────────────────────────
  await retireVariant(page, base, SPARE);
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const afterRetirement = await openAssignment(page, FREE);
  const offeredNow = await optionValues(afterRetirement.locator(`#fyv-assignment-variant-${FREE}`));
  assert.ok(!offeredNow.includes(SPARE), 'A retired variant cannot be assigned.');
  assert.deepEqual(offeredNow.sort(), (await storedActiveVariants(client)).sort(), 'The choice still matches the registry.');
  await closeDialog(afterRetirement);
  console.log(`  ✓ retiring ${SPARE} removes it from the choice, and the choice still matches the registry`);

  // ── 9. A row that changed underneath the form is refused ──────────────────
  const staleDialog = await openAssignment(page, FREE);
  await staleDialog.locator(`#fyv-assignment-variant-${FREE}`).selectOption(SEEDED_VARIANT);
  await staleDialog.locator(`#fyv-assignment-reason-${FREE}`).fill(REASON);
  // The hidden field carries the variant the form was opened against. Claiming a different one is
  // what a second configurator saving first would look like to this request.
  // The value is passed in: this function runs in the browser, where the harness's constants do
  // not exist.
  await staleDialog.locator('[name="expectedVariant"]').evaluate((field, claimed) => {
    (field as HTMLInputElement).value = claimed;
  }, SEEDED_VARIANT);
  await staleDialog.getByRole('button', { name: 'Assign', exact: true }).click();
  const stale = staleDialog.getByRole('alert').filter({ hasText: /changed after it was opened/ });
  await stale.waitFor();
  assert.match(
    await stale.innerText(),
    new RegExp(`It now posts in ${SHIFTED}`),
    'The refusal says what the book posts in now, so the reader knows which value won.',
  );
  assert.equal(await storedCompanyVariant(client, FREE), SHIFTED, 'Nothing was written by the stale request.');
  assert.equal((await assignmentDocuments(client, FREE)).length, 1, 'And it filed no document.');
  console.log('  ✓ a stale assignment is refused naming the variant that won, and nothing was written');

  // ── 10. The tenant ends as the two screens left it ────────────────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await gridRow(page, LINKED).waitFor();
  assert.equal(await storedCompanyVariant(client, LINKED), SEEDED_VARIANT, 'The linked book never moved.');
  assert.equal(await storedCompanyVariant(client, FREE), SHIFTED, 'The free book posts in the shifted variant.');
  assert.equal((await assignmentDocuments(client, LINKED)).length, 0, 'Every refusal left no trace.');
  console.log(`  ✓ ${LINKED} still in ${SEEDED_VARIANT}, ${FREE} in ${SHIFTED}, and no document from any refusal`);

  console.log('SCR-030 OB37 passed: grid, area conflict, clean assignment, active-only choice and the stale-row guard');
}

function gridRow(page: Page, companyCode: string): Locator {
  return page
    .locator('section[aria-labelledby="fyv-assignment-grid-title"]')
    .locator('tbody tr')
    .filter({ hasText: companyCode })
    .first();
}

async function openAssignment(page: Page, companyCode: string): Promise<Locator> {
  const row = gridRow(page, companyCode);
  await row.waitFor();
  await row.getByText('Assign', { exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: `Assign ${companyCode}` });
  await dialog.waitFor();
  return dialog;
}

/** Close a dialog rather than reloading: the run signs out from this page at the end. */
async function closeDialog(dialog: Locator) {
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

async function optionValues(select: Locator): Promise<string[]> {
  return select
    .locator('option:not([value=""])')
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
}

/** Define a variant through the OB29 screen, the only place a variant comes from. */
async function defineVariant(
  page: Page,
  base: string,
  values: { variant: string; name: string; specialPeriods?: number; calendarYear?: boolean; yearDependent?: boolean },
) {
  await page.goto(`${base}${VARIANTS_ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const panel = page.locator('section[aria-labelledby="fyv-variant-create-title"]');
  await panel.locator('[name="variant"]').fill(values.variant);
  await panel.locator('[name="name"]').fill(values.name);
  if (values.specialPeriods !== undefined) {
    await panel.locator('[name="specialPeriods"]').fill(String(values.specialPeriods));
  }
  if (values.calendarYear) await panel.locator('[name="isCalendarYear"]').check();
  if (values.yearDependent) await panel.locator('[name="isYearDependent"]').check();
  await panel.locator('[name="reason"]').fill(REASON);
  await panel.getByRole('button', { name: 'Create Fiscal Year Variant', exact: true }).click();
  await page.getByRole('status').filter({ hasText: /defined, with \d+ period\(s\) derived/ }).waitFor();
  // Leave the registry with no dialog open, so the next screen starts from a clean page.
  await page.goto(`${base}${VARIANTS_ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
}

/** Retire a variant through the OB29 screen. */
async function retireVariant(page: Page, base: string, variant: string) {
  await page.goto(`${base}${VARIANTS_ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const row = page
    .locator('section[aria-labelledby="fyv-variant-list-title"]')
    .locator('tbody tr')
    .filter({ hasText: variant })
    .first();
  await row.waitFor();
  await row.getByText('Deactivate', { exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: `Deactivate ${variant}` });
  await dialog.waitFor();
  await dialog.locator(`#fyv-lifecycle-${variant}`).fill(REASON);
  await dialog.getByRole('button', { name: 'Deactivate', exact: true }).click();
  await page.getByRole('status').filter({ hasText: /deactivated\./ }).waitFor();
  await page.goto(`${base}${VARIANTS_ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
}

async function storedCompanyVariant(client: string, companyCode: string): Promise<string | null> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql`select fiscal_year_variant from company_code where company_code = ${companyCode}`),
  )) as unknown as Array<{ fiscal_year_variant: string | null }>;
  return rows[0]?.fiscal_year_variant ?? null;
}

async function storedActiveVariants(client: string): Promise<string[]> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql`select variant from fiscal_year_variant where is_active order by variant`),
  )) as unknown as Array<{ variant: string }>;
  return rows.map((row) => row.variant);
}

/**
 * The documents this screen filed for a Company Code.
 *
 * Filtered by activity, because defining the Company Code files a document under the same object
 * key and an unfiltered count would credit the definition to the assignment.
 */
async function assignmentDocuments(client: string, companyCode: string) {
  const documents = await withTenant(client, (tx) => changeHistory(tx, client, 'company_code', companyCode));
  return documents.filter((document) => document.transactionCode === ACTIVITY);
}
