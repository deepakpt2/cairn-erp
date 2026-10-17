import type { Locator, Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/banks';
const CAPABILITY = 'CFG.FIN.BANK.DEFINE';
const COUNTRY = 'KW';
const KEY = 'SCR96';
const SPARE = 'SCR97';

/**
 * SCR-036 browser acceptance: maintaining the global bank master.
 *
 * This target differs from every tenant-configuration target before it in one
 * respect it must not blur: banks are global. There is no workbench row to
 * route from — maintaining shared reference data completes no tenant activity
 * (R-86) — so the run starts at the route itself. And because the master is
 * shared with every tenant, the run deletes what it creates: the last
 * checkpoint is the master empty again, which is how it shipped.
 *
 * The audit is asserted too, in the shape this object keeps it: the actor
 * columns on the row, not change documents a global row has no tenant to
 * file under.
 */
export async function banksBankMaster(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-036 bank master: verify the screen, creation and its duplicate refusal, the change, deletion, and the master left empty');

  // This target shares the master with everything else: it must arrive empty
  // and say so, and the checkpoints below put it back that way.
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Define Banks', exact: true }).waitFor();
  assert.match(
    await page.locator('header .code').first().innerText(),
    new RegExp(`${CAPABILITY} · FI01`),
    'The screen says which capability and which reference transaction it is.',
  );
  await page.getByText('No banks are defined in the bank master.').waitFor();
  console.log('  ✓ the screen opens under its capability and the master starts empty');

  // ── Creating a bank writes it, stamped with the actor ─────────────────────
  const panel = page.locator('section[aria-labelledby="bank-create-title"]');
  await panel.locator('#bank-country').selectOption(COUNTRY);
  await panel.locator('#bank-key').fill(KEY);
  await panel.locator('#bank-name').fill('National Bank of Kuwait');
  await panel.locator('#bank-city').fill('Kuwait City');
  await panel.locator('#bank-swift').fill('NBOKKWKW');
  await panel.getByRole('button', { name: 'Create bank', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Bank ${KEY} for ${COUNTRY} defined`) })
    .waitFor();
  const created = await storedBank(client);
  assert.equal(created?.name, 'National Bank of Kuwait', 'The name is stored as submitted.');
  assert.ok(created?.created_by, 'The creating actor is stamped on the row.');
  console.log(`  ✓ ${KEY} for ${COUNTRY} defined, stored, and stamped with its creator`);

  // ── The same key again is refused, naming the change ──────────────────────
  // Every field is filled again rather than trusted to have survived the
  // save's re-render (the OB08 target's lesson).
  await panel.locator('#bank-country').selectOption(COUNTRY);
  await panel.locator('#bank-key').fill(KEY);
  await panel.locator('#bank-name').fill('National Bank of Kuwait');
  await panel.locator('#bank-city').fill('Kuwait City');
  await panel.locator('#bank-swift').fill('NBOKKWKW');
  await panel.getByRole('button', { name: 'Create bank', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: /is already defined for/ })
    .waitFor();
  console.log('  ✓ defining the same key again is refused');

  // ── Changing the details, clearing the optional ones ──────────────────────
  const changeDialog = await openDialog(page, KEY, 'Change');
  await changeDialog.locator(`#bank-name-${COUNTRY}-${KEY}`).fill('Kuwait Finance House');
  await changeDialog.locator(`#bank-city-${COUNTRY}-${KEY}`).fill('');
  await changeDialog.locator(`#bank-swift-${COUNTRY}-${KEY}`).fill('KFHOKWKWXXX');
  await changeDialog.getByRole('button', { name: 'Save bank', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Bank ${KEY} for ${COUNTRY} updated`) })
    .waitFor();
  const changed = await storedBank(client);
  assert.equal(changed?.name, 'Kuwait Finance House', 'The corrected name is stored.');
  assert.equal(changed?.city, null, 'The cleared city is stored as cleared.');
  assert.equal(changed?.swift, 'KFHOKWKWXXX', 'The eleven-character SWIFT is stored.');
  assert.ok(changed?.changed_by, 'The changing actor is stamped beside the creator.');
  await closeDialog(changeDialog);
  console.log('  ✓ the change stores the new details and stamps the changer');

  // ── A second bank, deleted; then the first, deleted ───────────────────────
  await panel.locator('#bank-country').selectOption(COUNTRY);
  await panel.locator('#bank-key').fill(SPARE);
  await panel.locator('#bank-name').fill('Spare bank, never referenced');
  await panel.getByRole('button', { name: 'Create bank', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Bank ${SPARE} for ${COUNTRY} defined`) })
    .waitFor();

  await deleteThroughDialog(page, SPARE);
  assert.equal(await storedBank(client, SPARE), null, 'The spare bank is gone.');
  await deleteThroughDialog(page, KEY);
  assert.equal(await storedBank(client), null, 'The changed bank is gone.');

  // ── The master ends as it began: empty, for every tenant ──────────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByText('No banks are defined in the bank master.').waitFor();
  assert.equal(await bankCount(client), 0, 'No bank of this run remains in the shared master.');
  console.log('  ✓ both banks deleted and the shared master left empty, as it shipped');

  console.log('SCR-036 bank master passed: screen, creation, duplicate refusal, change, deletion and the master left empty');
}

function gridRow(page: Page, key: string): Locator {
  return page
    .locator('section[aria-labelledby="bank-grid-title"]')
    .locator('tbody tr')
    .filter({ hasText: key })
    .first();
}

async function openDialog(page: Page, key: string, action: 'Change' | 'Delete'): Promise<Locator> {
  const row = gridRow(page, key);
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

/**
 * Delete through the dialog, and assert where a deletion can be asserted: the
 * successful save revalidates, the row leaves the grid, and the dialog carrying
 * the answer unmounts with it (the OB08 target's lesson).
 */
async function deleteThroughDialog(page: Page, key: string) {
  const dialog = await openDialog(page, key, 'Delete');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForFunction(
    (bankKey) => ![...document.querySelectorAll('tbody tr')].some((row) => (row as HTMLElement).innerText.includes(bankKey)),
    key,
  );
}

async function storedBank(client: string, key: string = KEY) {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql`
      select name, city, swift, created_by, changed_by
      from bank_master where bank_country = ${COUNTRY} and bank_key = ${key}
    `),
  )) as unknown as Array<{
    name: string; city: string | null; swift: string | null;
    created_by: string; changed_by: string | null;
  }>;
  return rows[0] ?? null;
}

async function bankCount(client: string): Promise<number> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql`select count(*)::int as n from bank_master`),
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}
