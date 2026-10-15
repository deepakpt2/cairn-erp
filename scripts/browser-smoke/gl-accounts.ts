import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import { journalEntryLine } from '../../src/modules/finance/schema';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

function scope(ctx: Context) {
  return { page: ctx.page, BASE: ctx.base, CLIENT: ctx.target.client };
}

const ROUTE = '/config/gl-accounts';
/** Created through the UI in this run; the fixture tenant is disposable. */
const CREATED_ACCOUNT = '9990001111';
/** Created for the deletion guard: an account that has carried a posting cannot go. */
const USED_ACCOUNT = '9990002222';
const USED_DOCUMENT = 'FS00ACC01';
const CHART = 'CA01';
const GROUP = 'GENL';

/**
 * SCR-028 / FS00 browser acceptance, part 1 of 2: the hub, the Term Registry
 * aliases that stage 4 moved, Create mode end to end, and Display mode.
 *
 * Part 2 covers Change mode, the block flags with their mandatory reason, the
 * deletion refusals and the Account Group panel with its field status matrix.
 *
 * Everything asserted here is asserted twice: once in the browser, because the
 * screen is the product, and once in the database, because a form that renders
 * a value is not a form that stored it.
 */
export async function glAccountMasterFs00(ctx: Context) {
  const { page, BASE, CLIENT } = scope(ctx);
  console.log('SCR-028 FS00: verify the hub, the moved registry aliases, Create mode and Display mode');

  // ── 1. The hub renders all three panels ───────────────────────────────────
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  // Client-side dialogs and forms attach their handlers during hydration.
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'G/L Account Master Record', exact: true }).waitFor();

  const initial = page.locator('section[aria-labelledby="fs00-initial-title"]');
  const list = page.locator('section[aria-labelledby="fs00-list-title"]');
  const groupList = page.locator('section[aria-labelledby="fs00-group-list-title"]');
  await initial.waitFor();
  await list.waitFor();
  await groupList.waitFor();
  console.log('  ✓ hub shows the initial screen, the account list and the Account Group registry');

  // ── 2. The seeded chart is editable: FS00 replaced a read-only list ───────
  const seeded = (await withTenant(CLIENT, (tx) =>
    tx.execute(
      sql`select count(*)::int as accounts
            from gl_account
           where chart_of_accounts = ${CHART}`,
    ),
  )) as unknown as Array<{ accounts: number }>;
  assert.equal(seeded[0].accounts, 74, 'The onboarding package provisions 74 accounts in CA01.');

  const firstSeeded = (await withTenant(CLIENT, (tx) =>
    tx.execute(
      sql`select account_number, name
            from gl_account
           where chart_of_accounts = ${CHART}
           order by rpad(account_number, 10, '0')
           limit 1`,
    ),
  )) as unknown as Array<{ account_number: string; name: string }>;
  const seededRow = list.locator('tbody tr').filter({ hasText: firstSeeded[0].account_number }).first();
  await seededRow.waitFor();
  // A Change link on a seeded row is the point of stage 3: the 74 accounts that the
  // read-only list used to show are maintained here now, not merely displayed.
  await seededRow.getByRole('link', { name: 'Change', exact: true }).waitFor();
  assert.match(await seededRow.innerText(), new RegExp(GROUP));
  console.log(`  ✓ seeded account ${firstSeeded[0].account_number} is listed in group ${GROUP} with a Change action`);

  await groupList.locator('tbody tr').filter({ hasText: GROUP }).first().waitFor();
  assert.match(await groupList.innerText(), /0000000000[\s\S]*9999999999/);
  console.log('  ✓ the Account Group registry shows GENL spanning the chart number width');

  // ── 3. Stage 4: the aliases moved onto their own activities ───────────────
  await page.goto(`${BASE}/registry?q=FS00`, { waitUntil: 'domcontentloaded' });
  const createHit = page.locator('tbody tr').filter({ hasText: 'CFG.FIN.GLACCOUNT.CREATE' }).first();
  await createHit.waitFor();
  assert.equal(await createHit.locator('a[href="/config/gl-accounts/new"]').count(), 1);
  assert.match(await createHit.innerText(), /FS00/);

  await page.goto(`${BASE}/registry?q=FSS0`, { waitUntil: 'domcontentloaded' });
  const displayHit = page.locator('tbody tr').filter({ hasText: 'CFG.FIN.GLACCOUNT.DISPLAY' }).first();
  await displayHit.waitFor();
  // Display keeps the hub route: it is the one G/L route that means something
  // without query parameters, and it is what a search should land on.
  assert.equal(await displayHit.locator('a[href="/config/gl-accounts"]').count(), 1);

  await page.goto(`${BASE}/registry?q=FSP0`, { waitUntil: 'domcontentloaded' });
  await page.locator('tbody tr').filter({ hasText: 'CFG.FIN.GLACCOUNT.CHANGE' }).first().waitFor();

  // The retired entry is gone from search, not merely superseded.
  await page.goto(`${BASE}/registry?q=FIN.GL.MASTER.LIST`, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('tbody tr').count(), 0, 'FIN.GL.MASTER.LIST is retired.');
  console.log('  ✓ FS00/FSP0/FSS0 resolve to their own activities and the legacy entry is retired');

  // ── 4. Create mode, driven from the initial screen ────────────────────────
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  // The chart is chosen through its F4, which may only offer active, unblocked charts.
  await initial.getByRole('button', { name: /Chart of Accounts lookup/ }).click();
  const chartDialog = page.getByRole('dialog');
  await chartDialog.waitFor();
  await chartDialog.getByRole('button', { name: new RegExp(CHART) }).first().click();
  await chartDialog.waitFor({ state: 'detached' });
  assert.equal(await initial.locator('[name="chart"]').inputValue(), CHART);
  await initial.getByRole('radio', { name: 'Create', exact: true }).check();
  await initial.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForURL(`${BASE}${ROUTE}/new?chart=${CHART}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');

  const fields = page.locator('section[aria-labelledby="fs00-field-title"]');
  await fields.waitFor();
  await fields.locator('[name="accountNumber"]').fill(CREATED_ACCOUNT);
  await fields.locator('[name="name"]').fill('Browser acceptance clearing account');
  await fields.locator('[name="accountType"]').selectOption('LIABILITY');

  // The Account Group is a select, not a value help, and that is deliberate: it is a
  // key field, mandatory by contract, and no group may suppress the field that decides
  // its own field status. Choosing it reports the group's matrix on the screen.
  await fields.locator('[name="accountGroup"]').selectOption(GROUP);
  assert.equal(await fields.locator('[name="accountGroup"]').inputValue(), GROUP);
  await fields.getByText(`Field status matrix for ${GROUP}`, { exact: true }).waitFor();

  // Contract defaults the screen must carry without being told.
  assert.equal(await fields.locator('[name="glAccountType"]').inputValue(), 'BALANCE_SHEET');
  assert.equal(await fields.locator('[name="sortKey"]').inputValue(), '000');
  assert.equal(await fields.locator('[name="languageKey"]').inputValue(), 'EN');

  await fields.getByRole('button', { name: 'Create G/L Account', exact: true }).click();
  await page.getByText(`G/L account ${CREATED_ACCOUNT} created.`, { exact: true }).waitFor();
  console.log(`  ✓ created ${CREATED_ACCOUNT} through Create mode, the chart F4 and the Account Group select`);

  const stored = (await withTenant(CLIENT, (tx) =>
    tx.execute(
      sql`select account_number, name, account_type, account_group, gl_account_type,
                 is_balance_sheet, sort_key, language_key, is_blocked_posting, is_blocked_creation
            from gl_account
           where chart_of_accounts = ${CHART} and account_number = ${CREATED_ACCOUNT}`,
    ),
  )) as unknown as Array<Record<string, unknown>>;
  assert.equal(stored.length, 1, 'The account reached the database.');
  assert.equal(stored[0].name, 'Browser acceptance clearing account');
  assert.equal(stored[0].account_type, 'LIABILITY');
  assert.equal(stored[0].account_group, GROUP);
  assert.equal(stored[0].gl_account_type, 'BALANCE_SHEET');
  // Derived, never posted: XBILK says Balance Sheet, so the indicator follows it.
  assert.equal(stored[0].is_balance_sheet, true);
  assert.equal(stored[0].sort_key, '000');
  assert.equal(stored[0].language_key, 'EN');
  assert.equal(stored[0].is_blocked_posting, false);
  assert.equal(stored[0].is_blocked_creation, false);

  const history = await withTenant(CLIENT, (tx) =>
    changeHistory(tx, CLIENT, 'gl_account', `${CHART}/${CREATED_ACCOUNT}`),
  );
  assert.ok(history.length >= 1, 'Creating an account writes change evidence.');
  console.log(`  ✓ stored values match the contract defaults and ${history.length} change document(s) were written`);

  // ── 5. Display mode is read-only and shows what was stored ────────────────
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const createdRow = list.locator('tbody tr').filter({ hasText: CREATED_ACCOUNT }).first();
  await createdRow.waitFor();
  await createdRow.getByRole('link', { name: 'Display', exact: true }).click();
  await page.waitForURL(`${BASE}${ROUTE}/view?**`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');

  const displayFields = page.locator('section[aria-labelledby="fs00-field-title"]');
  await displayFields.waitFor();
  assert.equal(await displayFields.locator('[name="accountNumber"]').inputValue(), CREATED_ACCOUNT);
  assert.equal(await displayFields.locator('[name="name"]').inputValue(), 'Browser acceptance clearing account');
  assert.equal(await displayFields.locator('[name="accountGroup"]').inputValue(), GROUP);
  // Display mode offers no way to write the record. Scoped to the field panel: the
  // page chrome legitimately carries its own submit buttons (sign-out, command palette).
  assert.equal(await displayFields.locator('button[type="submit"]').count(), 0, 'The field panel renders no submit button in Display mode.');
  assert.equal(await page.getByRole('button', { name: 'Create G/L Account', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).count(), 0);
  // Text fields go read-only (their value stays selectable and in the DOM) and the
  // selects go disabled: either way Display mode cannot produce a write.
  assert.ok(await displayFields.locator('[name="name"]').getAttribute('readonly') !== null, 'Short Text is read-only.');
  assert.ok(await displayFields.locator('[name="accountNumber"]').getAttribute('readonly') !== null, 'The account number stays read-only.');
  assert.equal(await displayFields.locator('[name="accountType"]').isDisabled(), true, 'Account Type is disabled.');
  assert.equal(await displayFields.locator('[name="accountGroup"]').isDisabled(), true, 'Account Group is disabled.');
  assert.equal(await displayFields.locator('[name="isBlockedPosting"]').isDisabled(), true, 'The posting block cannot be flipped in Display mode.');
  console.log('  ✓ Display mode shows the stored record with no way to write it');

  console.log('  ✓ part 1: hub, registry aliases, Create mode and Display mode');

  // ── 6. Change mode keeps the key immutable and writes what was typed ──────
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await rowFor(list, CREATED_ACCOUNT).getByRole('link', { name: 'Change', exact: true }).click();
  await page.waitForURL(`${BASE}${ROUTE}/edit?**`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');

  const edit = page.locator('section[aria-labelledby="fs00-field-title"]');
  await edit.waitFor();
  assert.ok(
    await edit.locator('[name="accountNumber"]').getAttribute('readonly') !== null,
    'Change mode shows the account number read-only.',
  );
  await edit
    .getByText('The account number is immutable; changing it requires a new account.', { exact: true })
    .waitFor();

  await edit.locator('[name="name"]').fill('Browser acceptance clearing account, renamed');
  await edit.locator('[name="sortKey"]').fill('001');
  await edit.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText(`G/L account ${CREATED_ACCOUNT} saved.`, { exact: true }).waitFor();

  const renamed = await storedAccount(CLIENT, CREATED_ACCOUNT);
  assert.equal(renamed?.name, 'Browser acceptance clearing account, renamed');
  assert.equal(renamed?.sort_key, '001');
  const afterChange = await historyFor(CLIENT, CREATED_ACCOUNT);
  assert.equal(afterChange.length, 2, 'Create and change each wrote one change document.');
  console.log('  ✓ Change mode renamed the account, moved the sort key and wrote a second change document');

  // ── 7. A stale form is refused, not merged ────────────────────────────────
  // The version the form carries is the version it was rendered with; posting a stale
  // one is what two consultants changing the same account produce.
  // Typed first, then the version is forced stale: expectedVersion is a React-controlled
  // hidden input, so any re-render — filling a field is one — restores the rendered value.
  await edit.locator('[name="name"]').fill('This write must be refused');
  await edit.locator('[name="expectedVersion"]').evaluate((element) => {
    (element as HTMLInputElement).value = '99';
  });
  await edit.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: /changed after it was opened/i }).first().waitFor();
  assert.equal((await storedAccount(CLIENT, CREATED_ACCOUNT))?.name, 'Browser acceptance clearing account, renamed');
  assert.equal(await historyFor(CLIENT, CREATED_ACCOUNT).then((rows) => rows.length), 2, 'A refused write leaves no evidence behind.');
  console.log('  ✓ a stale version is refused and writes nothing');

  // ── 8. Block flags need a reason, in both directions ──────────────────────
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  // The label appears twice in a row — on the <summary> that opens the dialog and on the
  // checkbox inside it — so address the summary, not the text.
  await rowFor(list, CREATED_ACCOUNT).locator('summary').filter({ hasText: 'Posting Block (XSPEB)' }).click();

  const blockDialog = page.getByRole('dialog', { name: `Change blocks for ${CREATED_ACCOUNT}` });
  await blockDialog.waitFor();
  assert.ok(
    await blockDialog.locator('[name="reason"]').getAttribute('required') !== null,
    'The block dialog marks its reason required.',
  );
  await blockDialog.locator('[name="isBlockedPosting"]').check();
  await blockDialog.locator('[name="reason"]').fill('Blocked while the year-end close is reviewed');
  await blockDialog.getByRole('button', { name: 'Save block status', exact: true }).click();
  await blockDialog
    .getByRole('status')
    .filter({ hasText: `Block status saved for G/L account ${CREATED_ACCOUNT}.` })
    .waitFor();

  assert.equal((await storedAccount(CLIENT, CREATED_ACCOUNT))?.is_blocked_posting, true);
  const blockHistory = await historyFor(CLIENT, CREATED_ACCOUNT);
  assert.equal(blockHistory[0].changeType, 'BLOCK');
  assert.equal(blockHistory[0].reason, 'Blocked while the year-end close is reviewed');
  console.log('  ✓ the posting block was set with its reason recorded as a BLOCK change');

  // Unblock again, because a blocked account cannot be deleted and part 2 ends by deleting it.
  await blockDialog.locator('[name="isBlockedPosting"]').uncheck();
  await blockDialog.locator('[name="reason"]').fill('Year-end close reviewed; posting allowed again');
  await blockDialog.getByRole('button', { name: 'Save block status', exact: true }).click();
  await blockDialog
    .getByRole('status')
    .filter({ hasText: `Block status saved for G/L account ${CREATED_ACCOUNT}.` })
    .waitFor();
  assert.equal((await storedAccount(CLIENT, CREATED_ACCOUNT))?.is_blocked_posting, false);
  assert.equal((await historyFor(CLIENT, CREATED_ACCOUNT))[0].changeType, 'UNBLOCK');

  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await rowFor(list, CREATED_ACCOUNT).getByText('Active', { exact: true }).waitFor();
  console.log('  ✓ unblocking is a change of its own and the list shows the account active again');

  // ── 9. An account that carried a posting cannot be deleted ────────────────
  await createThroughUi(page, BASE, USED_ACCOUNT, 'Browser acceptance posted account', 'ASSET');
  await postAgainst(CLIENT, USED_ACCOUNT);

  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await rowFor(list, USED_ACCOUNT).locator('summary').filter({ hasText: 'Delete' }).click();
  const usedDelete = page.getByRole('dialog', { name: `Delete ${USED_ACCOUNT}` });
  await usedDelete.waitFor();
  await usedDelete.locator('[name="reason"]').fill('Trying to delete an account that carried a posting');
  await usedDelete.getByRole('button', { name: 'Delete G/L Account', exact: true }).click();

  // One refusal naming every fact, rather than three guards racing to refuse first.
  const refusal = page.getByRole('alert').filter({ hasText: /document line/i }).first();
  await refusal.waitFor();
  assert.match(await refusal.innerText(), /document line/i);
  assert.match(await refusal.innerText(), /open item/i);
  assert.match(await refusal.innerText(), /balance of/i);
  assert.ok(await storedAccount(CLIENT, USED_ACCOUNT), 'The refused account is still there.');
  console.log('  ✓ deletion of a posted account is refused, naming lines, open items and the balance');

  // ── 10. An unused account is deleted, and its evidence outlives it ────────
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await rowFor(list, CREATED_ACCOUNT).locator('summary').filter({ hasText: 'Delete' }).click();
  const deleteDialog = page.getByRole('dialog', { name: `Delete ${CREATED_ACCOUNT}` });
  await deleteDialog.waitFor();
  await deleteDialog.locator('[name="reason"]').fill('Created for browser acceptance and no longer needed');
  await deleteDialog.getByRole('button', { name: 'Delete G/L Account', exact: true }).click();
  // The dialog cannot confirm its own success: revalidating the hub removes the row the
  // dialog lives in, so the action redirects and the hub renders the confirmation.
  await page.waitForURL(`${BASE}${ROUTE}?deleted=${CREATED_ACCOUNT}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('status').filter({ hasText: `G/L account ${CREATED_ACCOUNT} deleted.` }).first().waitFor();

  assert.equal(await storedAccount(CLIENT, CREATED_ACCOUNT), undefined, 'The account row is gone.');
  const deletionHistory = await historyFor(CLIENT, CREATED_ACCOUNT);
  assert.equal(deletionHistory[0].changeType, 'DELETE');
  assert.equal(deletionHistory[0].reason, 'Created for browser acceptance and no longer needed');
  assert.equal(
    await page.locator('section[aria-labelledby="fs00-list-title"] tbody tr').filter({ hasText: CREATED_ACCOUNT }).count(),
    0,
    'The deleted account is off the list the redirect rendered.',
  );
  console.log('  ✓ an unused account is deleted, confirmed on the hub, and its reason survives the row');

  console.log('SCR-028 FS00 part 2 passed: Change mode, stale-version refusal, blocks and deletion guards');
}

/** One row of the account list, addressed by its account number. */
function rowFor(list: ReturnType<Page['locator']>, account: string) {
  return list.locator('tbody tr').filter({ hasText: account }).first();
}

type StoredAccount = {
  name: string;
  sort_key: string | null;
  is_blocked_posting: boolean;
  is_blocked_creation: boolean;
};

async function storedAccount(client: string, account: string): Promise<StoredAccount | undefined> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(
      sql`select name, sort_key, is_blocked_posting, is_blocked_creation
            from gl_account
           where chart_of_accounts = ${CHART} and account_number = ${account}`,
    ),
  )) as unknown as StoredAccount[];
  return rows[0];
}

type HistoryRow = { changeType: string; reason: string | null };

/** Newest first, and still readable after the account row itself is gone. */
async function historyFor(client: string, account: string): Promise<HistoryRow[]> {
  return withTenant(client, (tx) => changeHistory(tx, client, 'gl_account', `${CHART}/${account}`)) as unknown as HistoryRow[];
}

/** Create an account through Create mode, the way part 1 does, for use as a fixture. */
async function createThroughUi(page: Page, BASE: string, account: string, name: string, accountType: string) {
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const initial = page.locator('section[aria-labelledby="fs00-initial-title"]');
  await initial.locator('[name="chart"]').fill(CHART);
  await initial.getByRole('radio', { name: 'Create', exact: true }).check();
  await initial.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForURL(`${BASE}${ROUTE}/new?chart=${CHART}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');

  const fields = page.locator('section[aria-labelledby="fs00-field-title"]');
  await fields.waitFor();
  await fields.locator('[name="accountNumber"]').fill(account);
  await fields.locator('[name="name"]').fill(name);
  await fields.locator('[name="accountType"]').selectOption(accountType);
  await fields.locator('[name="accountGroup"]').selectOption(GROUP);
  await fields.getByRole('button', { name: 'Create G/L Account', exact: true }).click();
  await page.getByText(`G/L account ${account} created.`, { exact: true }).waitFor();
}

/**
 * Give an account a posting, so the deletion guard has something to refuse.
 *
 * Two lines, because the database refuses a document that does not balance: a fixture
 * that breaks a product rule tests a state no posting could ever produce.
 */
async function postAgainst(client: string, account: string) {
  const company = (await withTenant(client, (tx) =>
    tx.execute(sql`select company_code from company_code where client = ${client} order by company_code limit 1`),
  )) as unknown as Array<{ company_code: string }>;
  assert.ok(company[0], 'The fixture tenant has a Company Code.');
  const offsetting = (await withTenant(client, (tx) =>
    tx.execute(
      sql`select account_number from gl_account
           where chart_of_accounts = ${CHART} and account_number <> ${account}
           order by rpad(account_number, 10, '0') limit 1`,
    ),
  )) as unknown as Array<{ account_number: string }>;
  assert.ok(offsetting[0], 'The chart has another account to balance against.');

  const year = new Date().getFullYear();
  await withTenant(client, async (tx) => {
    await tx.insert(journalEntryLine).values([
      {
        client,
        documentNumber: USED_DOCUMENT,
        fiscalYear: year,
        lineNumber: 1,
        glAccount: account,
        companyCode: company[0].company_code,
        debitCredit: 'S',
        amountLocal: '100.0000',
        amountDocument: '100.0000',
        currency: 'KWD',
      },
      {
        client,
        documentNumber: USED_DOCUMENT,
        fiscalYear: year,
        lineNumber: 2,
        glAccount: offsetting[0].account_number,
        companyCode: company[0].company_code,
        debitCredit: 'H',
        amountLocal: '100.0000',
        amountDocument: '100.0000',
        currency: 'KWD',
      },
    ]);
  });
}
