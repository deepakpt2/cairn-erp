import type { Locator, Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/tax-codes';
const ACTIVITY = 'CFG.FIN.TAXCODE.DEFINE';
const COUNTRY = 'KW';
const CODE = 'V1';
const SPARE = 'A0';
const REASON = 'Browser acceptance run';

/**
 * SCR-035 / FTXP browser acceptance: defining the tax codes.
 *
 * A code's sharp edges are its key and its usage. The key — country and code — cannot
 * be edited, so the run creates a code, is refused a duplicate of it, changes the one
 * thing that may change (the rate, guarded on the rate the form opened against), and
 * then makes the code *used*: two journal lines carry it fixture-side, after which
 * the screen itself must refuse the deletion with the count, because journal lines
 * store the code without its country and the history it names therefore stands.
 *
 * Everything asserted here is asserted twice: once in the browser, because the screen
 * is the product, and once in the database, because a form that renders a value is
 * not a form that stored it. The service's own refusals are asserted in the service
 * tests; this target asserts the journey an operator can actually take.
 */
export async function taxCodesFtxp(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-035 FTXP: verify the workbench route, creation and its duplicate refusal, the guarded change, the usage refusal and deletion');

  // ── 1. The workbench routes here and the registry starts empty ────────────
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
  await page.getByRole('heading', { level: 1, name: 'Define Tax Codes for Sales and Purchases', exact: true }).waitFor();
  assert.match(
    await page.locator('header .code').first().innerText(),
    new RegExp(`${ACTIVITY} · FTXP`),
    'The screen says which activity and which reference transaction it is.',
  );
  await page.getByText('No tax codes are defined in this tenant.').waitFor();
  console.log('  ✓ the workbench routes here and the registry starts empty, as a new table should');

  // ── 2. Creating a code writes it, with its document ───────────────────────
  const panel = page.locator('section[aria-labelledby="tax-code-create-title"]');
  await panel.locator('#tax-code-country').selectOption(COUNTRY);
  await panel.locator('#tax-code-code').fill(CODE);
  await panel.locator('#tax-code-name').fill('Standard input tax');
  await panel.locator('#tax-code-type').fill('VST');
  await panel.locator('#tax-code-rate').fill('5.00');
  await panel.locator('#tax-code-account-key').fill('NVV');
  await panel.locator('#tax-code-reason').fill(REASON);
  await panel.getByRole('button', { name: 'Create tax code', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Tax Code ${CODE} for ${COUNTRY} defined at 5.00%`) })
    .waitFor();
  assert.equal(await storedRate(client), '5.00', 'The rate is stored as submitted.');
  const created = await codeDocuments(client);
  assert.equal(created.length, 1, 'One creation, one document.');
  assert.equal(created[0].reason, REASON, 'The reason is recorded on the document, as the screen promises.');
  assert.equal(
    created[0].items.find((item) => item.fieldName === 'ratePercent')?.isSecurityRelevant,
    'true',
    'The rate is flagged security-relevant.',
  );
  console.log(`  ✓ ${CODE} for ${COUNTRY} defined at 5.00%, stored, and documented with the reason`);

  // ── 3. The same key again is refused, naming the change ───────────────────
  // Every field is filled again rather than trusted to have survived the save's
  // re-render: an unfilled one would be refused for the wrong reason and the check
  // would pass against a refusal nobody aimed at (the OB08 target's lesson).
  await panel.locator('#tax-code-country').selectOption(COUNTRY);
  await panel.locator('#tax-code-code').fill(CODE);
  await panel.locator('#tax-code-name').fill('Standard input tax');
  await panel.locator('#tax-code-type').fill('VST');
  await panel.locator('#tax-code-rate').fill('5.00');
  await panel.locator('#tax-code-reason').fill(REASON);
  await panel.getByRole('button', { name: 'Create tax code', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: /is already defined for/ })
    .waitFor();
  assert.equal((await codeDocuments(client)).length, 1, 'A refused duplicate files no document.');
  console.log('  ✓ defining the same key again is refused and files nothing');

  // ── 4. Changing the rate, guarded on the rate the form opened against ─────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const dialog = await openDialog(page, CODE, 'Change');
  await dialog.locator(`#tax-code-rate-${COUNTRY}-${CODE}`).fill('7.50');
  await dialog.locator(`#tax-code-change-reason-${COUNTRY}-${CODE}`).fill(REASON);
  await dialog.getByRole('button', { name: 'Save tax code', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Tax Code ${CODE} for ${COUNTRY} now stands at 7.50%`) })
    .waitFor();
  assert.equal(await storedRate(client), '7.50', 'The corrected rate is stored.');
  await closeDialog(dialog);

  const staleDialog = await openDialog(page, CODE, 'Change');
  await staleDialog.locator(`#tax-code-rate-${COUNTRY}-${CODE}`).fill('9.00');
  await staleDialog.locator(`#tax-code-change-reason-${COUNTRY}-${CODE}`).fill(REASON);
  // The hidden field carries the rate the form opened against. Claiming the previous
  // one is what a second configurator saving first would look like to this request.
  await staleDialog.locator('[name="expectedRate"]').evaluate((field) => {
    (field as HTMLInputElement).value = '5.00';
  });
  await staleDialog.getByRole('button', { name: 'Save tax code', exact: true }).click();
  const stale = staleDialog.getByRole('alert').filter({ hasText: /changed after it was opened/ });
  await stale.waitFor();
  assert.match(await stale.innerText(), /It now stands at 7.50%/, 'The refusal says the rate that won.');
  assert.equal(await storedRate(client), '7.50', 'Nothing was written by the stale request.');
  assert.equal((await codeDocuments(client)).length, 2, 'And it filed no document.');
  await closeDialog(staleDialog);
  console.log('  ✓ the change stores 7.50% and a stale change is refused naming the rate that won');

  // ── 5. Once lines carry the code, the screen refuses its deletion ─────────
  await insertJournalLines(client, CODE);

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const usedRow = gridRow(page, CODE);
  await usedRow.waitFor();
  assert.match(await usedRow.innerText(), /\b2\b/, 'The grid states how many lines carry the code.');
  const deleteDialog = await openDialog(page, CODE, 'Delete');
  const blocked = deleteDialog.getByRole('alert').filter({ hasText: /cannot be deleted/ });
  await blocked.waitFor();
  assert.match(await blocked.innerText(), /posted on 2 journal line/, 'The refusal names the lines that stand against it.');
  await deleteDialog.locator(`#tax-code-delete-reason-${COUNTRY}-${CODE}`).fill(REASON);
  assert.equal(
    await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).isDisabled(),
    true,
    'The screen refuses before the click, so nothing reaches the service.',
  );
  assert.equal(await storedRate(client), '7.50', 'The used code still stands.');
  await closeDialog(deleteDialog);
  console.log(`  ✓ once lines carry ${CODE}, deletion is refused on the screen naming both of them`);

  // ── 6. An unused code can be deleted, and the deletion is filed ───────────
  await panel.locator('#tax-code-country').selectOption(COUNTRY);
  await panel.locator('#tax-code-code').fill(SPARE);
  await panel.locator('#tax-code-name').fill('Spare code, never used');
  await panel.locator('#tax-code-type').fill('MWS');
  await panel.locator('#tax-code-rate').fill('0.00');
  await panel.locator('#tax-code-reason').fill(REASON);
  await panel.getByRole('button', { name: 'Create tax code', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Tax Code ${SPARE} for ${COUNTRY} defined at 0.00%`) })
    .waitFor();

  const spareDialog = await openDialog(page, SPARE, 'Delete');
  await spareDialog.locator(`#tax-code-delete-reason-${COUNTRY}-${SPARE}`).fill(REASON);
  await spareDialog.getByRole('button', { name: 'Delete', exact: true }).click();
  // The confirmation cannot be read where it was written: the save revalidates, the
  // row leaves the grid, and the dialog carrying the answer unmounts with it (the
  // OB08 target's lesson). The database, the audit trail and the reloaded grid are
  // where the deletion is asserted. Rate 0.00 is not unique text on this page, so
  // the row's own code is what is waited out of the document.
  await page.waitForFunction(
    (code) => ![...document.querySelectorAll('tbody tr')].some((row) => (row as HTMLElement).innerText.includes(code)),
    SPARE,
  );
  assert.equal(await storedRate(client, SPARE), null, 'The spare code is gone.');
  const spareDocs = await codeDocuments(client, SPARE);
  assert.equal(spareDocs.length, 2, 'Creation and deletion: two documents.');
  assert.equal(spareDocs.find((document) => document.changeType === 'DELETE')?.reason, REASON);
  console.log(`  ✓ the unused ${SPARE} is deleted, and the deletion is documented`);

  // ── 7. The tenant ends as the screens left it ─────────────────────────────
  assert.equal(await storedRate(client), '7.50', 'The used code kept its corrected rate.');
  assert.equal((await codeDocuments(client)).length, 2, 'Every refusal left no trace.');
  console.log(`  ✓ ${CODE} stands at 7.50% with two documents, and no document from any refusal`);

  console.log('SCR-035 FTXP passed: workbench route, creation, duplicate refusal, guarded change, usage refusal and deletion');
}

function gridRow(page: Page, code: string): Locator {
  return page
    .locator('section[aria-labelledby="tax-code-grid-title"]')
    .locator('tbody tr')
    .filter({ hasText: code })
    .first();
}

async function openDialog(page: Page, code: string, action: 'Change' | 'Delete'): Promise<Locator> {
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

async function storedRate(client: string, code: string = CODE): Promise<string | null> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql`select rate_percent from tax_code where country = ${COUNTRY} and tax_code = ${code}`),
  )) as unknown as Array<{ rate_percent: string }>;
  return rows[0]?.rate_percent ?? null;
}

/**
 * One posted document whose two lines carry the code — a debit and a credit, because
 * the database refuses a document that does not balance, fixture or otherwise. What
 * the deletion rule reads is that lines carry the code, and the service tests assert
 * the same count from the same rows.
 */
async function insertJournalLines(client: string, code: string) {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into journal_entry (
        client, document_number, fiscal_year, document_type, company_code,
        document_date, posting_date, posting_period, document_currency,
        local_currency, status, created_by
      ) values (${client}, 'FTXP-B1', 2026, 'SA', '1000',
        '2026-06-15', '2026-06-15', 6, 'KWD', 'KWD', 'POSTED', 'FTXP_TARGET')
    `);
    for (const [lineNumber, debitCredit] of [[1, 'S'], [2, 'H']] as const) {
      await tx.execute(sql`
        insert into journal_entry_line (
          client, document_number, fiscal_year, line_number, gl_account,
          company_code, debit_credit, amount_local, amount_document, currency,
          tax_code
        ) values (${client}, 'FTXP-B1', 2026, ${lineNumber}, '140000',
          '1000', ${debitCredit}, 15.0000, 15.0000, 'KWD',
          ${code})
      `);
    }
  });
}

/**
 * The documents this screen filed for a code, read under the composite key the
 * service files on and filtered by activity, so nothing else in the tenant is
 * credited to this screen.
 */
async function codeDocuments(client: string, code: string = CODE) {
  const documents = await withTenant(client, (tx) => changeHistory(tx, client, 'tax_code', `${COUNTRY}/${code}`));
  return documents.filter((document) => document.transactionCode === ACTIVITY);
}
