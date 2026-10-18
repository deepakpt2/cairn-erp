import type { Locator, Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/document-types';
const ACTIVITY = 'CFG.FIN.DOCTYPE.DEFINE';
const CODE = 'Z9';
const SPARE = 'Z8';
const REASON = 'Browser acceptance run';

/**
 * SCR-038 / OBA7 browser acceptance: defining document types.
 *
 * Unlike the define-screens before it, this registry does not start empty: the
 * standard package delivers the working set, and the run begins by reading the
 * delivered types standing as shipped. The journey then covers the owner's
 * contract (R-87) the way an operator meets it: a new type created against an
 * interval that exists, the same key refused, a change, deactivation and
 * reactivation, an unused type deleted — and finally the structural refusal,
 * a posted document inserted fixture-side under the new type, after which the
 * screen itself must refuse its deletion with the count.
 *
 * Everything is asserted twice: once in the browser, because the screen is
 * the product, and once in the database, because a form that renders a value
 * is not a form that stored it. The service's own refusals are asserted in
 * the service tests; this target drives the journey an operator can take.
 */
export async function documentTypesOba7(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-038 OBA7: verify the workbench route, the delivered registry, creation and its duplicate refusal, change, deactivation and reactivation, deletion, and the in-use refusal');

  // The fixture tenant defines intervals but has not completed the
  // number-range activity this screen requires first (the service tests
  // complete it the same way). Completing it here is fixture setup; the
  // prerequisite refusal itself is asserted in the service tests.
  await withTenant(client, (tx) => tx.execute(sql`
    insert into config_activity_status (client, activity_code, status, completed_at, completed_by, created_by)
    values (${client}, 'CFG.PLT.NUMBERRANGE.DEFINE', 'COMPLETED', now(), 'OBA7_TARGET', 'OBA7_TARGET')
    on conflict (client, activity_code) do update
      set status = 'COMPLETED', completed_at = now(), completed_by = 'OBA7_TARGET'
  `));

  // ── 1. The workbench routes here and the delivered registry stands ────────
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
  await page.getByRole('heading', { level: 1, name: 'Define Document Types', exact: true }).waitFor();
  assert.match(
    await page.locator('header .code').first().innerText(),
    new RegExp(`${ACTIVITY} · OBA7`),
    'The screen says which activity and which reference transaction it is.',
  );
  const deliveredRow = gridRow(page, 'SA');
  await deliveredRow.waitFor();
  assert.match(await deliveredRow.innerText(), /General journal entry/, 'The delivered type SA stands as shipped.');
  assert.match(await deliveredRow.innerText(), /RF_BELEG · GENERAL/, 'Drawing on the interval the package assigned.');
  console.log('  ✓ the workbench routes here and the delivered registry stands');

  // ── 2. Creating a type against a defined interval writes and documents it ─
  const panel = page.locator('section[aria-labelledby="doc-type-create-title"]');
  const interval = await createType(page, CODE, 'acceptance posting type');
  const [intervalObject, intervalSubObject] = interval.split('|');
  const stored = await storedType(client, CODE);
  assert.equal(stored?.number_range_object, intervalObject, 'The type draws on the interval the screen offered and was chosen.');
  assert.equal(stored?.number_range_sub_object, intervalSubObject, 'Interval sub-object stored as chosen.');
  assert.equal(stored?.allowed_account_types, 'DS', 'The checked account types are stored in canonical order.');
  assert.equal(stored?.is_active, true, 'A new type starts active.');
  const created = await documents(client, CODE);
  assert.equal(created.length, 1, 'One creation, one document.');
  assert.equal(created[0].reason, REASON, 'The reason is recorded, as the screen promises.');
  assert.equal(
    created[0].items.find((item) => item.fieldName === 'allowedAccountTypes')?.isSecurityRelevant,
    'true',
    'The account types are flagged security-relevant.',
  );
  console.log(`  ✓ ${CODE} defined against ${interval}, stored, and documented`);

  // ── 3. The same key again is refused, naming the change ───────────────────
  // Every field is filled again rather than trusted to have survived the
  // save's re-render (the OB08 target's lesson).
  await fillCreate(page, CODE, 'acceptance posting type');
  await panel.getByRole('button', { name: 'Create document type', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: /is already defined/ })
    .waitFor();
  assert.equal((await documents(client, CODE)).length, 1, 'A refused duplicate files no document.');
  console.log('  ✓ defining the same key again is refused and files nothing');

  // ── 4. A change corrects the description and nothing else moves ───────────
  const changeDialog = await openDialog(page, CODE, 'Change');
  await changeDialog.locator(`#doc-type-name-${CODE}`).fill('acceptance posting type, corrected');
  await changeDialog.locator(`#doc-type-change-reason-${CODE}`).fill(REASON);
  await changeDialog.getByRole('button', { name: 'Save document type', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Document Type ${CODE} updated`) })
    .waitFor();
  assert.equal((await storedType(client, CODE))?.name, 'acceptance posting type, corrected', 'The corrected description is stored.');
  await closeDialog(changeDialog);
  console.log(`  ✓ ${CODE} changed on screen and in the registry`);

  // ── 5. Deactivation stops the offer; reactivation restores it ─────────────
  const offDialog = await openDialog(page, CODE, 'Deactivate');
  await offDialog.locator(`#doc-type-toggle-reason-${CODE}`).fill(REASON);
  await offDialog.getByRole('button', { name: 'Deactivate', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Document Type ${CODE} deactivated`) })
    .waitFor();
  assert.equal((await storedType(client, CODE))?.is_active, false, 'The type stands deactivated.');
  // A successful toggle re-renders the row and its dialog unmounts with the
  // old state, so the run reloads rather than closing a dialog that is gone.
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');

  const onDialog = await openDialog(page, CODE, 'Reactivate');
  await onDialog.locator(`#doc-type-toggle-reason-${CODE}`).fill(REASON);
  await onDialog.getByRole('button', { name: 'Reactivate', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Document Type ${CODE} reactivated`) })
    .waitFor();
  assert.equal((await storedType(client, CODE))?.is_active, true, 'And active again.');
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  console.log(`  ✓ ${CODE} deactivated and reactivated, each state stored`);

  // ── 6. An unused type can be deleted, and the deletion is filed ───────────
  await createType(page, SPARE, 'Spare type, never used');
  const spareDialog = await openDialog(page, SPARE, 'Delete');
  await spareDialog.locator(`#doc-type-delete-reason-${SPARE}`).fill(REASON);
  await spareDialog.getByRole('button', { name: 'Delete', exact: true }).click();
  // The confirmation cannot be read where it was written: the save
  // revalidates, the row leaves the grid, and the dialog carrying the answer
  // unmounts with it (the OB08 target's lesson).
  await page.waitForFunction(
    (code) => ![...document.querySelectorAll('tbody tr')].some((row) => (row as HTMLElement).innerText.includes(code)),
    SPARE,
  );
  assert.equal(await storedType(client, SPARE), null, 'The spare type is gone.');
  const spareDocs = await documents(client, SPARE);
  assert.equal(spareDocs.length, 2, 'Creation and deletion: two documents.');
  assert.equal(spareDocs.find((document) => document.changeType === 'DELETE')?.reason, REASON);
  console.log(`  ✓ the unused ${SPARE} is deleted, and the deletion is documented`);

  // ── 7. Once an entry carries the type, the screen refuses its deletion ────
  await insertJournalEntry(client, CODE);

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const usedRow = gridRow(page, CODE);
  await usedRow.waitFor();
  assert.match(await usedRow.innerText(), /\b1\b/, 'The grid states how many entries carry the type.');
  const deleteDialog = await openDialog(page, CODE, 'Delete');
  const blocked = deleteDialog.getByRole('alert').filter({ hasText: /cannot be deleted/ });
  await blocked.waitFor();
  await deleteDialog.locator(`#doc-type-delete-reason-${CODE}`).fill(REASON);
  assert.equal(
    await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).isDisabled(),
    true,
    'The screen refuses before the click, so nothing reaches the service.',
  );
  assert.ok(await storedType(client, CODE), 'The used type still stands.');
  await closeDialog(deleteDialog);
  console.log(`  ✓ once an entry carries ${CODE}, deletion is refused on the screen`);

  console.log('SCR-038 OBA7 passed: workbench route, delivered registry, creation, duplicate refusal, change, lifecycle, deletion and the in-use refusal');
}

function gridRow(page: Page, code: string): Locator {
  // The key cell alone decides the row: a bare substring test matches other
  // rows (an account-type set of SA lives on the AF row), so the row is found
  // by its first cell holding exactly the key.
  return page
    .locator('section[aria-labelledby="doc-type-grid-title"]')
    .locator('tbody tr')
    .filter({ has: page.locator('td:first-child').getByText(code, { exact: true }) })
    .first();
}

async function fillCreate(page: Page, code: string, name: string): Promise<string> {
  const panel = page.locator('section[aria-labelledby="doc-type-create-title"]');
  await panel.locator('#doc-type-code').fill(code);
  await panel.locator('#doc-type-name').fill(name);
  const intervalSelect = panel.locator('#doc-type-interval');
  const values = (await intervalSelect.locator('option').all())
    .map(async (option) => option.getAttribute('value'));
  const options = await Promise.all(values);
  const interval = options.find((value) => value === 'RF_BELEG|GENERAL') ?? options.find((value) => value);
  assert.ok(interval, 'The screen offers at least one defined interval.');
  await intervalSelect.selectOption(interval as string);
  // Customers beside the pre-checked G/L accounts, so the stored letter set
  // proves the checkboxes, not the default, decided it.
  await panel.locator('input[name="accountTypes"][value="D"]').check();
  await panel.locator('#doc-type-reason').fill(REASON);
  return interval as string;
}

async function createType(page: Page, code: string, name: string): Promise<string> {
  const panel = page.locator('section[aria-labelledby="doc-type-create-title"]');
  const interval = await fillCreate(page, code, name);
  await panel.getByRole('button', { name: 'Create document type', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Document Type ${code} defined`) })
    .waitFor();
  return interval;
}

async function openDialog(page: Page, code: string, action: 'Change' | 'Delete' | 'Deactivate' | 'Reactivate'): Promise<Locator> {
  const row = gridRow(page, code);
  await row.waitFor();
  await row.getByText(action, { exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: new RegExp(`^${action}`) });
  await dialog.waitFor();
  return dialog;
}

/** Close a dialog rather than reloading: the run signs out from this page at the end. */
async function closeDialog(dialog: Locator) {
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

async function storedType(client: string, code: string) {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql`
      select name, allowed_account_types, is_active, number_range_object, number_range_sub_object from document_type
      where document_type = ${code}
    `),
  )) as unknown as Array<{
    name: string; allowed_account_types: string; is_active: boolean;
    number_range_object: string; number_range_sub_object: string;
  }>;
  return rows[0] ?? null;
}

/**
 * One posted document under the type — a debit and a credit, because the
 * database refuses a document that does not balance, fixture or otherwise.
 * What the deletion rule reads is that a journal entry carries the type, and
 * the service tests assert the same count from the same rows.
 */
async function insertJournalEntry(client: string, code: string) {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into journal_entry (
        client, document_number, fiscal_year, document_type, company_code,
        document_date, posting_date, posting_period, document_currency,
        local_currency, status, created_by
      ) values (${client}, 'OBA7-B1', 2026, ${code}, '1000',
        '2026-06-15', '2026-06-15', 6, 'KWD', 'KWD', 'POSTED', 'OBA7_TARGET')
    `);
    for (const [lineNumber, debitCredit] of [[1, 'S'], [2, 'H']] as const) {
      await tx.execute(sql`
        insert into journal_entry_line (
          client, document_number, fiscal_year, line_number, gl_account,
          company_code, debit_credit, amount_local, amount_document, currency
        ) values (${client}, 'OBA7-B1', 2026, ${lineNumber}, '140000',
          '1000', ${debitCredit}, 15.0000, 15.0000, 'KWD')
      `);
    }
  });
}

/** The documents this screen filed for a type, under the key the service files on. */
async function documents(client: string, code: string) {
  const all = await withTenant(client, (tx) => changeHistory(tx, client, 'document_type', code));
  return all.filter((document) => document.transactionCode === ACTIVITY);
}
