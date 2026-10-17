import type { Locator, Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/house-banks';
const ACTIVITY = 'CFG.FIN.HOUSEBANK.DEFINE';
const BANK_ROUTE = '/config/banks';
const COMPANY = '1000';
const BANK_KEY = 'B959A';
const HOUSE = 'NBK01';
const ACCOUNT = 'ACC01';
const REASON = 'Browser acceptance run';

/**
 * SCR-037 / FI12 browser acceptance: house banks and their accounts.
 *
 * The journey crosses the seam SCR-036 built on purpose: the bank is defined
 * in the global master first (through its own screen), then named by the
 * house bank here. The sharp edges the run asserts are the two-level ones —
 * a house bank whose deletion is refused on the screen while its account
 * stands, deletion done in the order the structure demands, and the master
 * bank deleted again at the end, because the master is shared and ships
 * empty.
 *
 * Everything is asserted twice: once in the browser, because the screen is
 * the product, and once in the database, because a form that renders a value
 * is not a form that stored it. The service's own refusals — including each
 * named G/L failure — are asserted in the service tests; this target drives
 * the valid path an operator can actually take, plus the structural refusal
 * the screen itself must state.
 */
export async function houseBanksFi12(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-037 FI12: verify the workbench route, the master bank fixture, house bank and account creation, the structural refusal, and deletion in order');

  // ── 1. The bank exists in the master before anything can name it ──────────
  await page.goto(`${base}${BANK_ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const bankPanel = page.locator('section[aria-labelledby="bank-create-title"]');
  await bankPanel.locator('#bank-country').selectOption('KW');
  await bankPanel.locator('#bank-key').fill(BANK_KEY);
  await bankPanel.locator('#bank-name').fill('acceptance Bank');
  await bankPanel.locator('#bank-city').fill('Kuwait City');
  await bankPanel.locator('#bank-swift').fill('ACBKKWKW');
  await bankPanel.getByRole('button', { name: 'Create bank', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Bank ${BANK_KEY} for KW defined`) })
    .waitFor();
  console.log(`  ✓ the bank ${BANK_KEY} is defined in the master, through its own screen`);

  // ── 2. The workbench routes here and no house banks stand ─────────────────
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
  await page.getByRole('heading', { level: 1, name: 'Define House Banks', exact: true }).waitFor();
  assert.match(
    await page.locator('header .code').first().innerText(),
    new RegExp(`${ACTIVITY} · FI12`),
    'The screen says which activity and which reference transaction it is.',
  );
  await page.getByText('No house banks are defined for this company code.').waitFor();
  console.log('  ✓ the workbench routes here and no house banks stand');

  // ── 3. Creating the house bank displays the master's facts ────────────────
  const panel = page.locator('section[aria-labelledby="house-bank-create-title"]');
  await panel.locator('#house-bank-key').fill(HOUSE);
  await panel.locator('#house-bank-bank').selectOption(`KW/${BANK_KEY}`);
  await panel.locator('#house-bank-reason').fill(REASON);
  await panel.getByRole('button', { name: 'Create house bank', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`House Bank ${HOUSE} defined for ${COMPANY}`) })
    .waitFor();
  const grid = page.locator('section[aria-labelledby="house-bank-grid-title"]');
  const houseRow = grid.locator('tbody tr').filter({ hasText: HOUSE }).first();
  await houseRow.waitFor();
  assert.match(await houseRow.innerText(), /acceptance Bank/, 'The grid shows the bank name read from the master.');
  assert.match(await houseRow.innerText(), /ACBKKWKW/, 'And the SWIFT code, equally borrowed.');
  const houseDocs = await documents(client, 'house_bank', `${COMPANY}/${HOUSE}`);
  assert.equal(houseDocs.length, 1, 'One creation, one document.');
  assert.equal(houseDocs[0].reason, REASON, 'The reason is recorded, as the screen promises.');
  console.log(`  ✓ ${HOUSE} defined for ${COMPANY}, displaying the master's facts and documented`);

  // ── 4. The same key again is refused, naming the change ───────────────────
  // Every field is filled again rather than trusted to have survived the
  // save's re-render (the OB08 target's lesson).
  await panel.locator('#house-bank-key').fill(HOUSE);
  await panel.locator('#house-bank-bank').selectOption(`KW/${BANK_KEY}`);
  await panel.locator('#house-bank-reason').fill(REASON);
  await panel.getByRole('button', { name: 'Create house bank', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: /is already defined for/ })
    .waitFor();
  assert.equal((await documents(client, 'house_bank', `${COMPANY}/${HOUSE}`)).length, 1, 'A refused duplicate files no document.');
  console.log('  ✓ defining the same key again is refused and files nothing');

  // ── 5. An account under it, with the G/L the screen offers ────────────────
  await houseRow.getByText(/account\(s\)/).first().click();
  const accounts = page.locator('section[aria-labelledby="house-bank-accounts-title"]');
  await accounts.getByText(new RegExp(`Bank accounts of ${HOUSE}`)).waitFor();
  const suffix = `${COMPANY}-${HOUSE}`;
  await accounts.locator(`#bank-account-id-${suffix}`).fill(ACCOUNT);
  await accounts.locator(`#bank-account-number-${suffix}`).fill('000123456789');
  await accounts.locator(`#bank-account-iban-${suffix}`).fill('KW81CBKU1234567890123456789012');
  await accounts.locator(`#bank-account-currency-${suffix}`).selectOption('KWD');
  const glSelect = accounts.locator(`#bank-account-gl-${suffix}`);
  const glOptions = await glSelect.locator('option').all();
  const glAccount = (await Promise.all(glOptions.map(async (option) => option.getAttribute('value'))))
    .find((value) => value);
  assert.ok(glAccount, 'The screen offers at least one asset balance-sheet account of the chart.');
  await glSelect.selectOption(glAccount as string);
  await accounts.locator(`#bank-account-reason-${suffix}`).fill(REASON);
  await accounts.getByRole('button', { name: 'Create bank account', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Bank Account ${ACCOUNT} defined under ${HOUSE}`) })
    .waitFor();
  const storedAccount = await storedBankAccount(client);
  assert.equal(storedAccount?.gl_account, glAccount, 'The offered G/L account is what was stored.');
  assert.equal(storedAccount?.iban, 'KW81CBKU1234567890123456789012', 'The thirty-character IBAN is stored whole.');
  console.log(`  ✓ account ${ACCOUNT} defined under ${HOUSE} with the offered G/L account`);

  // ── 6. The house bank's deletion is refused while the account stands ──────
  const deleteDialog = await openDialog(page, houseRow, 'Delete');
  const blocked = deleteDialog.getByRole('alert').filter({ hasText: /cannot be deleted/ });
  await blocked.waitFor();
  await deleteDialog.locator(`#house-bank-delete-reason-${COMPANY}-${HOUSE}`).fill(REASON);
  assert.equal(
    await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).isDisabled(),
    true,
    'The screen refuses before the click, so nothing reaches the service.',
  );
  await closeDialog(deleteDialog);
  console.log('  ✓ the house bank deletion is refused on the screen while its account stands');

  // ── 7. Deletion in the order the structure demands ────────────────────────
  await accounts.locator('tbody tr').filter({ hasText: ACCOUNT }).first()
    .getByText('Delete', { exact: true }).first().click();
  const accountDelete = page.getByRole('dialog', { name: new RegExp(`^Delete ${ACCOUNT}`) });
  await accountDelete.waitFor();
  await accountDelete.locator(`#bank-account-delete-reason-${COMPANY}-${HOUSE}-${ACCOUNT}`).fill(REASON);
  await accountDelete.getByRole('button', { name: 'Delete', exact: true }).click();
  // The answer cannot be read where it was written and the database cannot be
  // asked before the request lands: wait for the row to leave the grid first,
  // as every deletion checkpoint in this harness has had to learn.
  await page.waitForFunction(
    (account) => ![...document.querySelectorAll('section[aria-labelledby="house-bank-accounts-title"] tbody tr')]
      .some((row) => (row as HTMLElement).innerText.includes(account)),
    ACCOUNT,
  );
  assert.equal(await storedBankAccount(client), null, 'The account is deleted first.');
  const accountDocs = await documents(client, 'bank_account', `${COMPANY}/${HOUSE}/${ACCOUNT}`);
  assert.equal(accountDocs.filter((document) => document.changeType === 'DELETE').length, 1, 'And its deletion is documented.');

  const houseDelete = await openDialog(page, houseRow, 'Delete');
  await houseDelete.locator(`#house-bank-delete-reason-${COMPANY}-${HOUSE}`).fill(REASON);
  await houseDelete.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForFunction(
    (key) => ![...document.querySelectorAll('tbody tr')].some((row) => (row as HTMLElement).innerText.includes(key)),
    HOUSE,
  );
  const houseDocsAfter = await documents(client, 'house_bank', `${COMPANY}/${HOUSE}`);
  assert.equal(houseDocsAfter.filter((document) => document.changeType === 'DELETE').length, 1, 'The house bank deletion is documented.');
  console.log(`  ✓ account deleted, then the house bank, each with its document`);

  // ── 8. The master bank goes last, leaving the master empty ────────────────
  await page.goto(`${base}${BANK_ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const bankRow = page
    .locator('section[aria-labelledby="bank-grid-title"]')
    .locator('tbody tr')
    .filter({ hasText: BANK_KEY })
    .first();
  await bankRow.getByText('Delete', { exact: true }).first().click();
  const bankDelete = page.getByRole('dialog', { name: new RegExp(`^Delete ${BANK_KEY}`) });
  await bankDelete.waitFor();
  await bankDelete.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForFunction(
    (key) => ![...document.querySelectorAll('tbody tr')].some((row) => (row as HTMLElement).innerText.includes(key)),
    BANK_KEY,
  );
  assert.equal(await bankCount(client), 0, 'The shared master is empty again, as it shipped.');
  console.log('  ✓ the master bank deleted last, and the shared master left empty');

  console.log('SCR-037 FI12 passed: workbench route, master fixture, house bank, account, structural refusal and ordered deletion');
}

async function openDialog(page: Page, row: Locator, action: 'Change' | 'Delete'): Promise<Locator> {
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

async function storedBankAccount(client: string) {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql`
      select gl_account, iban from bank_account
      where company_code = ${COMPANY} and house_bank_key = ${HOUSE} and account_id = ${ACCOUNT}
    `),
  )) as unknown as Array<{ gl_account: string; iban: string | null }>;
  return rows[0] ?? null;
}

async function bankCount(client: string): Promise<number> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql`select count(*)::int as n from bank_master`),
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/** The documents a screen filed, under the key the service files on. */
async function documents(client: string, objectClass: string, objectKey: string) {
  const all = await withTenant(client, (tx) => changeHistory(tx, client, objectClass, objectKey));
  return all.filter((document) => document.transactionCode === ACTIVITY);
}
