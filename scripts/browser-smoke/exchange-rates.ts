import type { Locator, Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/exchange-rates';
const ACTIVITY = 'CFG.FIN.EXRATE.MAINTAIN';
const TYPE = 'BUYING';
const FROM = 'EUR';
const TO = 'USD';
const VALID_FROM = '2026-01-01';
const OBJECT_KEY = `${TYPE}/${FROM}/${TO}/${VALID_FROM}`;
const REASON = 'Browser acceptance run';

/**
 * SCR-034 / OB08 browser acceptance: maintaining the exchange rates.
 *
 * A rate's sharp edges are its key and its arithmetic. The key — type, pair, and the
 * date the rate takes effect — cannot be edited, so the run creates a rate, is refused
 * a duplicate of it on the screen, changes the one thing that may change (the quoted
 * rate, with its ratios), and then deletes it. The ratios are exercised rather than
 * assumed: a rate quoted at 109 for 100 units must read back as an effective 1.09.
 *
 * Everything asserted here is asserted twice: once in the browser, because the screen
 * is the product, and once in the database, because a form that renders a value is
 * not a form that stored it. The service's own refusals are asserted in the service
 * tests; this target asserts the journey an operator can actually take.
 */
export async function exchangeRatesOb08(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-034 OB08: verify the workbench route, creation and its duplicate refusal, the ratio change, the stale guard and deletion');

  // ── 1. The workbench routes here and the seeded rate is listed ────────────
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
  await page.getByRole('heading', { level: 1, name: 'Maintain Exchange Rates', exact: true }).waitFor();
  assert.match(
    await page.locator('header .code').first().innerText(),
    new RegExp(`${ACTIVITY} · OB08`),
    'The screen says which activity and which reference transaction it is.',
  );
  const seededRow = page
    .locator('section[aria-labelledby="ex-rate-grid-title"]')
    .locator('tbody tr')
    .filter({ hasText: 'Average rate' })
    .filter({ hasText: 'KWD' })
    .first();
  await seededRow.waitFor();
  assert.match(await seededRow.innerText(), /3\.25650000/, 'The rate the package seeded for a KWD tenant is listed.');
  console.log('  ✓ the workbench routes here and the grid lists the rates the package seeded');

  // ── 2. Creating a rate writes it, with its document ───────────────────────
  const panel = page.locator('section[aria-labelledby="ex-rate-create-title"]');
  await panel.locator('#ex-rate-type').selectOption(TYPE);
  await panel.locator('#ex-rate-from').selectOption(FROM);
  await panel.locator('#ex-rate-to').selectOption(TO);
  await panel.locator('#ex-rate-valid-from').fill(VALID_FROM);
  await panel.locator('#ex-rate-rate').fill('1.08000000');
  await panel.locator('#ex-rate-reason').fill(REASON);
  await panel.getByRole('button', { name: 'Create rate', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Buying rate ${FROM} → ${TO} from ${VALID_FROM} created at 1.08000000`) })
    .waitFor();
  assert.equal(await storedRate(client), '1.08000000', 'The rate is stored as submitted.');
  const created = await rateDocuments(client);
  assert.equal(created.length, 1, 'One creation, one document.');
  assert.equal(created[0].reason, REASON, 'The reason is recorded on the document, as the screen promises.');
  const rateItem = created[0].items.find((item) => item.fieldName === 'rate')!;
  assert.equal(rateItem.newValue, '1.08000000', 'It records the rate that was created.');
  assert.equal(rateItem.isSecurityRelevant, 'true', 'The rate is flagged security-relevant.');
  console.log(`  ✓ ${TYPE} ${FROM} → ${TO} created at 1.08000000, stored, and documented with the reason`);

  // ── 3. The same key again is refused, naming the change ───────────────────
  // Every field is filled again rather than trusted to have survived the save's
  // re-render: an unfilled date would be refused for the wrong reason and the check
  // would pass against a refusal nobody aimed at.
  await panel.locator('#ex-rate-type').selectOption(TYPE);
  await panel.locator('#ex-rate-from').selectOption(FROM);
  await panel.locator('#ex-rate-to').selectOption(TO);
  await panel.locator('#ex-rate-valid-from').fill(VALID_FROM);
  await panel.locator('#ex-rate-rate').fill('1.08000000');
  await panel.locator('#ex-rate-reason').fill(REASON);
  await panel.getByRole('button', { name: 'Create rate', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: /is already maintained/ })
    .waitFor();
  assert.equal((await rateDocuments(client)).length, 1, 'A refused duplicate files no document.');
  console.log('  ✓ creating the same key again is refused and files nothing');

  // ── 4. The grid reads the rate back, ratios stated ────────────────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const row = gridRow(page, 'Buying rate');
  await row.waitFor();
  const rowText = await row.innerText();
  assert.match(rowText, /1\.08000000/, 'The grid shows the quoted rate.');
  assert.match(rowText, /1 : 1/, 'And the ratio it is quoted for.');
  console.log('  ✓ the grid reads the new rate back with its ratio');

  // ── 5. Changing the rate and its ratios states the effective rate ─────────
  const dialog = await openDialog(page, 'Buying rate', 'Change');
  await dialog.locator(`#ex-rate-new-rate-${TYPE}-${FROM}-${TO}-${VALID_FROM}`).fill('109.00000000');
  // Quoted per hundred units: the ratio sits on the From side, so 109 for 100 is 1.09 for one.
  await dialog.locator(`#ex-rate-ratio-from-${TYPE}-${FROM}-${TO}-${VALID_FROM}`).fill('100');
  await dialog.locator(`#ex-rate-change-reason-${TYPE}-${FROM}-${TO}-${VALID_FROM}`).fill(REASON);
  await dialog.getByRole('button', { name: 'Save rate', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`now stands at 109.00000000`) })
    .waitFor();
  assert.equal(await storedRate(client), '109.00000000', 'The corrected rate is stored.');

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const changedText = await gridRow(page, 'Buying rate').innerText();
  assert.match(changedText, /109\.00000000/, 'The grid shows the new quoted rate.');
  assert.match(changedText, /100 : 1/, 'And its new ratio.');
  assert.match(changedText, /1\.09000000/, 'And the effective rate the arithmetic produces.');
  console.log('  ✓ the change stores 109 at 100 : 1 and the grid states the effective 1.09000000');

  // ── 6. A rate that moved underneath the form refuses the change ───────────
  const staleDialog = await openDialog(page, 'Buying rate', 'Change');
  await staleDialog.locator(`#ex-rate-new-rate-${TYPE}-${FROM}-${TO}-${VALID_FROM}`).fill('2.00000000');
  await staleDialog.locator(`#ex-rate-change-reason-${TYPE}-${FROM}-${TO}-${VALID_FROM}`).fill(REASON);
  // The hidden field carries the rate the form opened against. Claiming a different one
  // is what a second configurator saving first would look like to this request.
  await staleDialog.locator('[name="expectedRate"]').evaluate((field) => {
    (field as HTMLInputElement).value = '1.08000000';
  });
  await staleDialog.getByRole('button', { name: 'Save rate', exact: true }).click();
  const stale = staleDialog.getByRole('alert').filter({ hasText: /changed after it was opened/ });
  await stale.waitFor();
  assert.match(await stale.innerText(), /It now stands at 109\.00000000/, 'The refusal says the rate that won.');
  assert.equal(await storedRate(client), '109.00000000', 'Nothing was written by the stale request.');
  assert.equal((await rateDocuments(client)).length, 2, 'And it filed no document.');
  await closeDialog(staleDialog);
  console.log('  ✓ a stale change is refused naming the rate that won, and nothing was written');

  // ── 7. A currency does not convert into itself ────────────────────────────
  await panel.locator('#ex-rate-type').selectOption(TYPE);
  await panel.locator('#ex-rate-from').selectOption(FROM);
  await panel.locator('#ex-rate-to').selectOption(FROM);
  await panel.getByRole('alert').filter({ hasText: /does not convert into itself/ }).waitFor();
  assert.equal(
    await panel.getByRole('button', { name: 'Create rate', exact: true }).isDisabled(),
    true,
    'The screen refuses before the click, so nothing reaches the service.',
  );
  console.log('  ✓ choosing the same currency twice is refused on the screen');

  // ── 8. Deleting the rate removes it and files what was removed ────────────
  const deleteDialog = await openDialog(page, 'Buying rate', 'Delete');
  await deleteDialog.locator(`#ex-rate-delete-reason-${TYPE}-${FROM}-${TO}-${VALID_FROM}`).fill(REASON);
  await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
  // The deletion's confirmation cannot be read where it was written: the save revalidates,
  // the row leaves the grid, and the dialog that carried the answer is unmounted with it.
  // A wait for that status would race the unmount rather than test the deletion, so what
  // counts is asserted where it survives — the database, the audit trail, and below the
  // reloaded grid.
  await page.waitForFunction(
    (expected) => !document.body.innerText.includes(expected),
    '109.00000000',
  );
  assert.equal(await storedRate(client), null, 'The rate is gone.');

  const documents = await rateDocuments(client);
  assert.equal(documents.length, 3, 'Create, change and delete: three documents.');
  const deletion = documents.find((document) => document.changeType === 'DELETE')!;
  assert.equal(
    deletion.items.find((item) => item.fieldName === 'rate')?.oldValue,
    '109.00000000',
    'The deletion files the rate it removed.',
  );

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Maintain Exchange Rates', exact: true }).waitFor();
  assert.equal(await gridRow(page, 'Buying rate').count(), 0, 'The grid no longer lists the deleted rate.');
  console.log('  ✓ the rate is deleted, the deletion is documented, and the grid reads back without it');

  console.log('SCR-034 OB08 passed: workbench route, creation, duplicate refusal, ratio arithmetic, stale guard and deletion');
}

function gridRow(page: Page, typeLabel: string): Locator {
  return page
    .locator('section[aria-labelledby="ex-rate-grid-title"]')
    .locator('tbody tr')
    .filter({ hasText: typeLabel })
    .filter({ hasText: FROM })
    .first();
}

async function openDialog(page: Page, typeLabel: string, action: 'Change' | 'Delete'): Promise<Locator> {
  const row = gridRow(page, typeLabel);
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

async function storedRate(client: string): Promise<string | null> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql`select rate from exchange_rate
                    where rate_type = ${TYPE} and from_currency = ${FROM}
                      and to_currency = ${TO} and valid_from = ${VALID_FROM}`),
  )) as unknown as Array<{ rate: string }>;
  return rows[0]?.rate ?? null;
}

/**
 * The documents this screen filed for the rate.
 *
 * Filtered by activity and read under the composite key the service files on, so the
 * tenant's seeded rates — written by the builder under a different provenance — are
 * never credited to this screen.
 */
async function rateDocuments(client: string) {
  const documents = await withTenant(client, (tx) => changeHistory(tx, client, 'exchange_rate', OBJECT_KEY));
  return documents.filter((document) => document.transactionCode === ACTIVITY);
}
