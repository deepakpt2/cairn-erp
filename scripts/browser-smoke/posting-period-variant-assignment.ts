import type { Locator, Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/posting-period-variants/assign-company-codes';
const VARIANTS_ROUTE = '/config/posting-period-variants';
const COMPANY_CODES_ROUTE = '/config/company-codes';
const ACTIVITY = 'CFG.FIN.PPV.ASSIGN';
/** The Company Code the standard package creates, posting against the seeded variant. */
const SEEDED_CODE = '1000';
const SEEDED_VARIANT = 'C001';
/** A second Company Code, created here, with nothing posted. */
const FREE = '2000';
/** Defined through the OBBO screen in this run. */
const FIRST = 'BP01';
const SECOND = 'BP02';
const REASON = 'Browser acceptance run';

/**
 * SCR-033 / OBBP browser acceptance: assigning the posting period variant a Company Code
 * posts against.
 *
 * The screen's one sharp edge is the clearing rule: a variant may be cleared only while the
 * Company Code has no journal entries. So the run walks one Company Code through assignment,
 * clearing while that is still allowed, reassignment — and then gives it a journal entry
 * fixture-side, after which the screen itself must refuse the clear before the click.
 *
 * Everything asserted here is asserted twice: once in the browser, because the screen is
 * the product, and once in the database, because a form that renders a value is not a
 * form that stored it. The service's own refusals are asserted in the service tests; this
 * target asserts the journey an operator can actually take.
 */
export async function postingPeriodVariantAssignmentObbp(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-033 OBBP: verify the assignment grid, assignment, clearing before and after posting, and the stale-row guard');

  // The variants this target assigns are defined the way a configurator defines them.
  await defineVariant(page, base, FIRST, 'Browser variant one');
  await defineVariant(page, base, SECOND, 'Browser variant two');

  // ── 1. The grid reads every Company Code beside what it posts against ─────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Assign Posting Period Variant to Company Code', exact: true }).waitFor();
  assert.match(
    await page.locator('header .code').first().innerText(),
    new RegExp(`${ACTIVITY} · OBBP`),
    'The screen says which activity and which reference transaction it is.',
  );
  const seededRow = gridRow(page, SEEDED_CODE);
  await seededRow.waitFor();
  const seededText = await seededRow.innerText();
  assert.match(seededText, new RegExp(SEEDED_VARIANT), 'The seeded book is shown posting against the package variant.');
  assert.match(seededText, /Standard period control/, 'And the variant is shown with its description.');

  await page.goto(`${base}/config`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const workbenchRow = page.locator('tr').filter({ hasText: ACTIVITY }).first();
  await workbenchRow.waitFor();
  assert.equal(
    await workbenchRow.getByRole('link', { name: 'Open', exact: true }).getAttribute('href'),
    ROUTE,
    'The workbench opens the screen that can do the work.',
  );
  console.log(`  ✓ the grid reads ${SEEDED_CODE} beside ${SEEDED_VARIANT} and its description, and the workbench routes here`);

  // ── 2. A second Company Code, with no variant yet ─────────────────────────
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
  // Case-insensitive on purpose: innerText reports what is rendered, and a chip is
  // upper-cased by its own styling.
  assert.match(await freeRow.innerText(), /Not assigned/i, 'A new Company Code posts against no variant yet.');
  console.log(`  ✓ ${FREE} defined through the Company Code screen and listed unassigned`);

  // ── 3. The choice is exactly the defined variants, and a reason is required ──
  const dialog = await openAssignment(page, FREE);
  const offered = await optionValues(dialog.locator(`#ppv-assign-variant-${FREE}`));
  assert.deepEqual(
    offered.sort(),
    (await storedVariants(client)).sort(),
    'Every defined variant can be assigned, and nothing else is offered.',
  );
  await dialog.locator(`#ppv-assign-variant-${FREE}`).selectOption(FIRST);
  assert.equal(
    await dialog.getByRole('button', { name: 'Assign variant', exact: true }).isDisabled(),
    true,
    'An assignment without a reason cannot be submitted.',
  );
  console.log('  ✓ the choice is exactly the defined variants, and a reason is required before the click');

  // ── 4. Assigning it writes the variant, the reason and the document ───────
  await dialog.locator(`#ppv-assign-reason-${FREE}`).fill(REASON);
  await dialog.getByRole('button', { name: 'Assign variant', exact: true }).click();
  const success = page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Company Code ${FREE} now posts against Posting Period Variant ${FIRST}`) });
  await success.waitFor();
  assert.match(
    await success.innerText(),
    /it posted against Not assigned/,
    'The answer says what the book posted against before, including when that was nothing.',
  );
  assert.equal(await storedCompanyVariant(client, FREE), FIRST, 'The assignment is stored.');
  assert.equal(await storedCompanyVariant(client, SEEDED_CODE), SEEDED_VARIANT, 'The seeded book was not touched.');

  const documents = await assignmentDocuments(client, FREE);
  assert.equal(documents.length, 1, 'One assignment, one document.');
  const [document] = documents;
  const variantItem = document.items.find((item) => item.fieldName === 'postingPeriodVariant')!;
  assert.equal(variantItem.newValue, FIRST, 'It records the variant the book now posts against.');
  assert.equal(variantItem.oldValue, null, 'It records that the book posted against nothing before.');
  assert.equal(variantItem.isSecurityRelevant, 'true', 'The variant is flagged security-relevant.');
  assert.equal(document.reason, REASON, 'The reason is recorded on the document, as the screen promises.');
  console.log(`  ✓ ${FREE} assigned to ${FIRST}, stored, and documented with the reason and the previous value`);

  // ── 5. Repeating the held variant is shown as the no-op it is ─────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const reopened = await openAssignment(page, FREE);
  assert.equal(
    await reopened.locator(`#ppv-assign-variant-${FREE}`).inputValue(),
    FIRST,
    'The dialog opens on the variant the book already posts against, rather than asking again.',
  );
  await reopened.locator(`#ppv-assign-reason-${FREE}`).fill(REASON);
  assert.equal(
    await reopened.getByRole('button', { name: 'Assign variant', exact: true }).isDisabled(),
    true,
    'Repeating the held variant offers no save: there is nothing to write.',
  );
  console.log('  ✓ the grid reads the assignment back and repeating it offers no save');

  // ── 6. Clearing is allowed while nothing has posted ───────────────────────
  await reopened.locator(`#ppv-assign-variant-${FREE}`).selectOption('');
  await reopened.getByText(/cannot post until another/).waitFor();
  assert.equal(
    await reopened.getByRole('button', { name: 'Assign variant', exact: true }).isDisabled(),
    false,
    'A Company Code with no journal entries may be cleared.',
  );
  await reopened.getByRole('button', { name: 'Assign variant', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Company Code ${FREE} no longer posts against a Posting Period Variant`) })
    .waitFor();
  assert.equal(await storedCompanyVariant(client, FREE), null, 'The assignment is cleared.');
  assert.equal((await assignmentDocuments(client, FREE)).length, 2, 'The clearing filed its own document.');
  console.log(`  ✓ ${FREE} cleared while nothing had posted, and the clearing is documented`);

  // ── 7. After an entry exists, the screen refuses the clear before the click ──
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const reassign = await openAssignment(page, FREE);
  await reassign.locator(`#ppv-assign-variant-${FREE}`).selectOption(SECOND);
  await reassign.locator(`#ppv-assign-reason-${FREE}`).fill(REASON);
  await reassign.getByRole('button', { name: 'Assign variant', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Company Code ${FREE} now posts against Posting Period Variant ${SECOND}`) })
    .waitFor();

  await insertJournalEntry(client, FREE);

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const postedDialog = await openAssignment(page, FREE);
  await postedDialog.locator(`#ppv-assign-variant-${FREE}`).selectOption('');
  const blocked = postedDialog.getByRole('alert').filter({ hasText: /cannot be cleared/ });
  await blocked.waitFor();
  assert.match(await blocked.innerText(), /has posted 1 document/, 'The refusal names the entries that stand against it.');
  await postedDialog.locator(`#ppv-assign-reason-${FREE}`).fill(REASON);
  assert.equal(
    await postedDialog.getByRole('button', { name: 'Assign variant', exact: true }).isDisabled(),
    true,
    'The screen refuses before the click, so nothing reaches the service.',
  );
  assert.equal(await storedCompanyVariant(client, FREE), SECOND, 'The book still posts against its variant.');
  assert.equal((await assignmentDocuments(client, FREE)).length, 3, 'A refused clearing files no document.');
  await closeDialog(postedDialog);
  console.log(`  ✓ once ${FREE} has posted, clearing is refused on the screen naming the entry, and nothing was written`);

  // ── 8. A row that changed underneath the form is refused ──────────────────
  const staleDialog = await openAssignment(page, FREE);
  await staleDialog.locator(`#ppv-assign-variant-${FREE}`).selectOption(FIRST);
  await staleDialog.locator(`#ppv-assign-reason-${FREE}`).fill(REASON);
  // The hidden field carries the variant the form was opened against. Claiming a different one
  // is what a second configurator saving first would look like to this request. The value is
  // passed in: this function runs in the browser, where the harness's constants do not exist.
  await staleDialog.locator('[name="expectedVariant"]').evaluate((field, claimed) => {
    (field as HTMLInputElement).value = claimed;
  }, SEEDED_VARIANT);
  await staleDialog.getByRole('button', { name: 'Assign variant', exact: true }).click();
  const stale = staleDialog.getByRole('alert').filter({ hasText: /changed after it was opened/ });
  await stale.waitFor();
  assert.match(
    await stale.innerText(),
    new RegExp(`It now posts against ${SECOND}`),
    'The refusal says what the book posts against now, so the reader knows which value won.',
  );
  assert.equal(await storedCompanyVariant(client, FREE), SECOND, 'Nothing was written by the stale request.');
  assert.equal((await assignmentDocuments(client, FREE)).length, 3, 'And it filed no document.');
  console.log('  ✓ a stale assignment is refused naming the variant that won, and nothing was written');

  // ── 9. The tenant ends as the screens left it ─────────────────────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await gridRow(page, SEEDED_CODE).waitFor();
  assert.equal(await storedCompanyVariant(client, SEEDED_CODE), SEEDED_VARIANT, 'The seeded book never moved.');
  assert.equal(await storedCompanyVariant(client, FREE), SECOND, 'The free book posts against the second variant.');
  assert.equal((await assignmentDocuments(client, SEEDED_CODE)).length, 0, 'Every refusal left no trace.');
  console.log(`  ✓ ${SEEDED_CODE} still in ${SEEDED_VARIANT}, ${FREE} in ${SECOND}, and no document from any refusal`);

  console.log('SCR-033 OBBP passed: grid, assignment, clearing before posting, the posted clearing refusal and the stale-row guard');
}

function gridRow(page: Page, companyCode: string): Locator {
  return page
    .locator('section[aria-labelledby="ppv-assign-grid-title"]')
    .locator('tbody tr')
    .filter({ hasText: companyCode })
    .first();
}

async function openAssignment(page: Page, companyCode: string): Promise<Locator> {
  const row = gridRow(page, companyCode);
  await row.waitFor();
  await row.getByText(/^(Assign|Change)$/).first().click();
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

/** Define a variant through the OBBO screen, the only place a variant comes from. */
async function defineVariant(page: Page, base: string, variant: string, name: string) {
  await page.goto(`${base}${VARIANTS_ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const panel = page.locator('section[aria-labelledby="ppv-create-title"]');
  await panel.locator('[name="variant"]').fill(variant);
  await panel.locator('[name="name"]').fill(name);
  await panel.getByRole('button', { name: 'Define variant', exact: true }).click();
  await page.getByRole('status').filter({ hasText: new RegExp(`${variant} defined, with 5 intervals`) }).waitFor();
  await page.goto(`${base}${VARIANTS_ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
}

async function storedCompanyVariant(client: string, companyCode: string): Promise<string | null> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql`select posting_period_variant from company_code where company_code = ${companyCode}`),
  )) as unknown as Array<{ posting_period_variant: string | null }>;
  return rows[0]?.posting_period_variant ?? null;
}

async function storedVariants(client: string): Promise<string[]> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql`select variant from posting_period_variant order by variant`),
  )) as unknown as Array<{ variant: string }>;
  return rows.map((row) => row.variant);
}

/**
 * One posted entry, fixture-side. Posting a real document through the journal screen would
 * test the journal, not this screen; what the clearing rule reads is that an entry exists
 * under the Company Code, and the service tests assert the same count from the same rows.
 */
async function insertJournalEntry(client: string, companyCode: string) {
  await withTenant(client, (tx) => tx.execute(sql`
    insert into journal_entry (
      client, document_number, fiscal_year, document_type, company_code,
      document_date, posting_date, posting_period, document_currency,
      local_currency, status, created_by
    ) values (${client}, 'OBBP-B1', 2026, 'SA', ${companyCode},
      '2026-06-15', '2026-06-15', 6, 'KWD', 'KWD', 'POSTED', 'OBBP_TARGET')
  `));
}

/**
 * The documents this screen filed for a Company Code.
 *
 * Filtered by activity, because defining the Company Code files a document under the same
 * object key and an unfiltered count would credit the definition to the assignment.
 */
async function assignmentDocuments(client: string, companyCode: string) {
  const documents = await withTenant(client, (tx) => changeHistory(tx, client, 'company_code', companyCode));
  return documents.filter((document) => document.transactionCode === ACTIVITY);
}
