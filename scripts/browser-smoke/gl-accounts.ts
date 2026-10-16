import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
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
/**
 * Created for the deletion guard: an account that has carried a posting cannot go.
 * It sits inside the span GENL is narrowed to in part 3, because an account outside a
 * group's range is exactly what the narrowing guard refuses to leave behind.
 */
const USED_ACCOUNT = '6100000002';
const USED_DOCUMENT = 'FS00ACC01';
/** A second group, created through the panel in part 3, with its own matrix. */
const GROUP_B = 'GENB';
const GROUP_ACCOUNT = '6300000001';
/** GENL is seeded spanning the whole chart; part 3 narrows it to the accounts it holds. */
const GENL_NARROW_FROM = '1000000000';
const GENL_NARROW_TO = '6200000000';
const CHART = 'CA01';
const GROUP = 'GENL';
/**
 * A second usable chart, created in part 4 by copying the seeded one. The owner reported this
 * screen claiming no chart was defined in a tenant that held two, so two is the state the
 * assertions are written against.
 */
const SECOND_CHART = 'CA02';

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

  const initial = page.locator('section[aria-labelledby="gl-master-initial-title"]');
  const list = page.locator('section[aria-labelledby="gl-master-list-title"]');
  const groupList = page.locator('section[aria-labelledby="account-group-list-title"]');
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

  const fields = page.locator('section[aria-labelledby="gl-master-field-title"]');
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
  // Derived, never posted: the statement placement says Balance Sheet, so the indicator follows it.
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

  const displayFields = page.locator('section[aria-labelledby="gl-master-field-title"]');
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

  const edit = page.locator('section[aria-labelledby="gl-master-field-title"]');
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
  await rowFor(list, CREATED_ACCOUNT).locator('summary').filter({ hasText: 'Posting Block' }).click();

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

  // Unblock again, because a blocked account cannot be deleted and part 2 ends by deleting
  // it — from a freshly rendered dialog. Saving revalidates the hub, which remounts the row
  // and its dialog, so a second submit in the same dialog races the render that replaces it
  // and carries the version the form was opened with.
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await rowFor(list, CREATED_ACCOUNT).locator('summary').filter({ hasText: 'Posting Block' }).click();
  const unblockDialog = page.getByRole('dialog', { name: `Change blocks for ${CREATED_ACCOUNT}` });
  await unblockDialog.waitFor();
  assert.equal(await unblockDialog.locator('[name="isBlockedPosting"]').isChecked(), true, 'The block the last save stored is rendered back.');
  await unblockDialog.locator('[name="isBlockedPosting"]').uncheck();
  await unblockDialog.locator('[name="reason"]').fill('Year-end close reviewed; posting allowed again');
  await unblockDialog.getByRole('button', { name: 'Save block status', exact: true }).click();
  await unblockDialog
    .getByRole('status')
    .filter({ hasText: `Block status saved for G/L account ${CREATED_ACCOUNT}.` })
    .waitFor();
  // A refusal would leave the previous success message on screen, so the absence of an
  // alert is part of the assertion, not a courtesy.
  assert.equal(await unblockDialog.getByRole('alert').count(), 0, 'Unblocking was not refused.');
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
    await page.locator('section[aria-labelledby="gl-master-list-title"] tbody tr').filter({ hasText: CREATED_ACCOUNT }).count(),
    0,
    'The deleted account is off the list the redirect rendered.',
  );
  console.log('  ✓ an unused account is deleted, confirmed on the hub, and its reason survives the row');

  console.log('  ✓ part 2: Change mode, stale-version refusal, blocks and deletion guards');

  // ── 11. The Account Group registry is maintained inside FS00 ──────────────
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const groupCreate = page.locator('section[aria-labelledby="account-group-create-title"]');
  await groupCreate.waitFor();

  // The package seeds GENL spanning the whole chart width, and a range may not overlap a
  // sibling's, so a second group needs room: GENL is narrowed first, through its own
  // Change dialog, to the span its accounts actually occupy.
  await groupRow(groupList, GROUP).locator('summary').filter({ hasText: 'Change' }).click();
  const changeGroup = page.getByRole('dialog', { name: `Change Account Group ${GROUP}` });
  await changeGroup.waitFor();

  // Narrowing past the accounts already in the group is refused, and names them.
  await changeGroup.locator('[name="fromAccountNumber"]').fill(GENL_NARROW_FROM);
  await changeGroup.locator('[name="toAccountNumber"]').fill('1999999999');
  await changeGroup.getByRole('button', { name: 'Save changes', exact: true }).click();
  await changeGroup.getByRole('alert').filter({ hasText: /cannot be narrowed/ }).first().waitFor();
  assert.equal((await storedGroup(CLIENT, GROUP))?.to_account_number, '9999999999', 'A refused narrowing changes nothing.');

  await changeGroup.locator('[name="toAccountNumber"]').fill(GENL_NARROW_TO);
  await changeGroup.getByRole('button', { name: 'Save changes', exact: true }).click();
  await changeGroup
    .getByRole('status')
    .filter({ hasText: `Account Group ${GROUP} saved.` })
    .waitFor();
  const narrowed = await storedGroup(CLIENT, GROUP);
  assert.equal(narrowed?.from_account_number, GENL_NARROW_FROM);
  assert.equal(narrowed?.to_account_number, GENL_NARROW_TO);
  assert.ok((narrowed?.version ?? 0) >= 2, 'Changing a group bumps its version.');
  console.log(`  ✓ ${GROUP} was narrowed to the accounts it holds, after the same dialog refused to narrow past them`);

  // The narrowing save revalidated the hub; type into the rendered form, not the one that
  // is about to be replaced, or the client-side range check keeps the submit disabled.
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await groupCreate.locator('[name="chartOfAccounts"]').selectOption(CHART);
  await groupCreate.locator('[name="accountGroup"]').fill(GROUP_B);
  await groupCreate.locator('[name="description"]').fill('Browser acceptance liabilities');
  await groupCreate.locator('[name="fromAccountNumber"]').fill('6300000000');
  await groupCreate.locator('[name="toAccountNumber"]').fill('6999999999');
  await groupCreate.getByRole('button', { name: 'Create Account Group', exact: true }).click();
  await groupCreate.getByRole('status').filter({ hasText: `Account Group ${GROUP_B} created.` }).waitFor();

  const createdGroup = await storedGroup(CLIENT, GROUP_B);
  assert.equal(createdGroup?.is_active, true);
  assert.equal(createdGroup?.from_account_number, '6300000000');
  assert.equal(createdGroup?.to_account_number, '6999999999');
  assert.equal(createdGroup?.version, 1);
  await groupRow(groupList, GROUP_B).waitFor();
  console.log(`  ✓ Account Group ${GROUP_B} created through the panel and stored with its range`);

  // ── 12. A range may not overlap a sibling's, active or not ────────────────
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await groupCreate.locator('[name="chartOfAccounts"]').selectOption(CHART);
  await groupCreate.locator('[name="accountGroup"]').fill('GENC');
  await groupCreate.locator('[name="description"]').fill('Overlapping range, must be refused');
  await groupCreate.locator('[name="fromAccountNumber"]').fill('6500000000');
  await groupCreate.locator('[name="toAccountNumber"]').fill('7500000000');
  await groupCreate.getByRole('button', { name: 'Create Account Group', exact: true }).click();
  await groupCreate
    .getByRole('alert')
    .filter({ hasText: `overlaps Account Group ${GROUP_B}` })
    .first()
    .waitFor();
  assert.equal(await storedGroup(CLIENT, 'GENC'), undefined, 'The overlapping group was not stored.');
  console.log(`  ✓ an overlapping range is refused and names the group it overlaps`);

  // ── 13. The field status matrix stores only what differs from the baseline ─
  await groupRow(groupList, GROUP_B).locator('summary').filter({ hasText: 'Field status' }).click();
  const matrixDialog = page.getByRole('dialog', { name: `Field status matrix for ${GROUP_B}` });
  await matrixDialog.waitFor();
  // Twelve fields are offered; two are moved and the rest stay at the baseline.
  assert.equal(await matrixDialog.locator('select[name^="status_"]').count(), 12);
  await matrixDialog.locator('[name="status_sortKey"]').selectOption('MANDATORY');
  await matrixDialog.locator('[name="status_languageKey"]').selectOption('SUPPRESS');
  await matrixDialog.getByRole('button', { name: 'Save field status', exact: true }).click();
  await matrixDialog
    .getByRole('status')
    .filter({ hasText: `Field status saved for Account Group ${GROUP_B}.` })
    .waitFor();

  const storedRows = await storedMatrix(CLIENT, GROUP_B);
  assert.deepEqual(
    storedRows.map((row) => [row.field_key, row.status]),
    [['languageKey', 'SUPPRESS'], ['sortKey', 'MANDATORY']],
    'Only the two fields that differ from the baseline are stored.',
  );
  assert.equal((await storedGroup(CLIENT, GROUP_B))?.version, 2, 'A matrix write bumps the group version.');

  // Read the effective matrix the way a consultant does when they come back, not from the
  // dialog that just saved: its state is initialised once, so the revalidated tree can
  // briefly render it with the values it was opened with.
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await groupRow(groupList, GROUP_B).locator('summary').filter({ hasText: 'Field status' }).click();
  const reopened = page.getByRole('dialog', { name: `Field status matrix for ${GROUP_B}` });
  await reopened.waitFor();
  assert.equal(await reopened.locator('[name="status_sortKey"]').inputValue(), 'MANDATORY');
  assert.equal(await reopened.locator('[name="status_languageKey"]').inputValue(), 'SUPPRESS');
  // The two fields no group may relax, and an untouched field at its baseline.
  assert.equal(await reopened.locator('[name="status_name"]').inputValue(), 'MANDATORY');
  assert.equal(await reopened.locator('[name="status_isTaxRelevant"]').inputValue(), 'OPTIONAL');
  console.log('  ✓ the matrix stored two rows, bumped the version and reopens as the effective matrix');

  // ── 14. The group decides what an account write may carry ─────────────────
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const initialScreen = page.locator('section[aria-labelledby="gl-master-initial-title"]');
  await initialScreen.locator('[name="chart"]').fill(CHART);
  await initialScreen.getByRole('radio', { name: 'Create', exact: true }).check();
  await initialScreen.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForURL(`${BASE}${ROUTE}/new?chart=${CHART}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');

  const groupFields = page.locator('section[aria-labelledby="gl-master-field-title"]');
  await groupFields.waitFor();
  await groupFields.locator('[name="accountGroup"]').selectOption(GROUP_B);
  // A suppressed field is not rendered at all, so it cannot be posted.
  assert.equal(await groupFields.locator('[name="languageKey"]').count(), 0, 'The suppressed Language Key is not rendered.');
  await groupFields
    .getByText(`Field status matrix for ${GROUP_B}`, { exact: true })
    .waitFor();
  // A mandatory field is marked as one before the server has to refuse anything.
  assert.ok(
    await groupFields.locator('[name="sortKey"]').getAttribute('required') !== null,
    'The matrix makes Sort Key mandatory.',
  );

  await groupFields.locator('[name="accountNumber"]').fill(GROUP_ACCOUNT);
  await groupFields.locator('[name="name"]').fill('Browser acceptance group account');
  await groupFields.locator('[name="accountType"]').selectOption('LIABILITY');
  await groupFields.locator('[name="sortKey"]').fill('002');
  await groupFields.getByRole('button', { name: 'Create G/L Account', exact: true }).click();
  await page.getByText(`G/L account ${GROUP_ACCOUNT} created.`, { exact: true }).waitFor();

  const groupAccount = (await withTenant(CLIENT, (tx) =>
    tx.execute(
      sql`select account_group, sort_key, language_key
            from gl_account
           where chart_of_accounts = ${CHART} and account_number = ${GROUP_ACCOUNT}`,
    ),
  )) as unknown as Array<{ account_group: string; sort_key: string; language_key: string }>;
  assert.equal(groupAccount[0].account_group, GROUP_B);
  assert.equal(groupAccount[0].sort_key, '002');
  // Suppressed means the contract default, never whatever a post might have carried.
  assert.equal(groupAccount[0].language_key, 'EN');
  console.log(`  ✓ ${GROUP_ACCOUNT} was written under the ${GROUP_B} matrix: mandatory sort key kept, suppressed language key defaulted`);

  // ── 15. Deactivating a group needs a reason and leaves the F4 ─────────────
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await groupRow(groupList, GROUP_B).locator('summary').filter({ hasText: 'Deactivate' }).click();
  const lifecycle = page.getByRole('dialog', { name: `Deactivate ${GROUP_B}` });
  await lifecycle.waitFor();
  assert.ok(
    await lifecycle.locator('[name="reason"]').getAttribute('required') !== null,
    'Deactivating a group requires a reason.',
  );
  await lifecycle.locator('[name="reason"]').fill('Rollout of the liability groups is complete');
  await lifecycle.getByRole('button', { name: 'Deactivate', exact: true }).click();
  // Read the answer from the registry panel, not from the dialog addressed by its old
  // name: deactivating flips the row in place, so the dialog that answers is now the
  // Reactivate one and a locator pinned to "Deactivate GENB" finds nothing.
  const outcome = groupList.getByRole('status').or(groupList.getByRole('alert')).first();
  await outcome.waitFor();
  assert.equal(
    (await outcome.innerText()).trim(),
    `Account Group ${GROUP_B} deactivated. 1 account(s) keep it as their Account Group.`,
  );
  // The group stays in the registry — deactivation removes a choice, not a record — and
  // the same row now offers the way back.
  await groupRow(groupList, GROUP_B).getByText('Deactivated', { exact: true }).waitFor();
  await groupRow(groupList, GROUP_B).locator('summary').filter({ hasText: 'Reactivate' }).waitFor();

  assert.equal((await storedGroup(CLIENT, GROUP_B))?.is_active, false);
  // The account keeps the group it was created in: deactivation removes a choice, not a fact.
  const kept = (await withTenant(CLIENT, (tx) =>
    tx.execute(
      sql`select account_group from gl_account
           where chart_of_accounts = ${CHART} and account_number = ${GROUP_ACCOUNT}`,
    ),
  )) as unknown as Array<{ account_group: string }>;
  assert.equal(kept[0].account_group, GROUP_B);

  await page.goto(`${BASE}${ROUTE}/new?chart=${CHART}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const options = await page.locator('section[aria-labelledby="gl-master-field-title"] [name="accountGroup"] option').allInnerTexts();
  assert.equal(options.some((option) => option.includes(GROUP_B)), false, 'A deactivated group leaves the choice list.');
  assert.equal(options.some((option) => option.includes(GROUP)), true, 'The active group is still offered.');
  console.log(`  ✓ deactivation recorded its reason, kept the account's group and left the choice list`);

  // ── 16. A blocked chart keeps its display and refuses new work ────────────
  await setChartBlocked(CLIENT, CHART, true);
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');

  // The accounts of a blocked chart stay readable — a block stops writes, not sight.
  await list.locator('tbody tr').filter({ hasText: GROUP_ACCOUNT }).first().waitFor();
  // With no selectable chart the create panel says so and the initial screen's F4 is disabled.
  await groupCreate.getByRole('status').filter({ hasText: /No active Chart of Accounts/ }).waitFor();
  assert.equal(
    await initialScreen2(page).getByRole('button', { name: /Chart of Accounts lookup/ }).isDisabled(),
    true,
    'A blocked chart is not offered for new accounts.',
  );

  await setChartBlocked(CLIENT, CHART, false);
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  // An <option> inside a closed <select> is never "visible" to Playwright; count it.
  assert.equal(await groupCreate.locator('[name="chartOfAccounts"] option[value="CA01"]').count(), 1);
  console.log('  ✓ a blocked chart kept its accounts readable, offered nothing to create against, and recovered');

  console.log('SCR-028 FS00 part 3 passed: Account Group registry, field status matrix and the blocked-chart gate');

  // ── Part 4: which chart the mode screen is working in ────────────────────
  // The screen resolves its chart from the query string, and the workbench link that opens
  // Create carries no parameter. Three situations used to share one sentence — "No active
  // Chart of Accounts is defined yet" — so an operator holding two charts was told their
  // configuration did not exist and sent to define what they already had. Each situation now
  // says its own thing, and each is asserted against what the database holds.
  console.log('SCR-028 FS00 part 4: the chart the mode screen says it is working in');

  await defineChart(CLIENT, SECOND_CHART, 'Second chart for the chooser');

  // 4.1 No parameter, two usable charts: the screen offers them.
  await page.goto(`${BASE}${ROUTE}/new`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('status').filter({ hasText: /Choose the Chart of Accounts to work in/ }).waitFor();
  assert.equal(
    await page.getByText(/No active Chart of Accounts is defined yet/).count(),
    0,
    'A tenant with usable charts is not told that none is defined.',
  );
  const offered = await chartOffers(page);
  const usable = await storedUsableCharts(CLIENT);
  assert.deepEqual(
    offered.sort(),
    usable.sort(),
    'The chooser offers exactly the charts that are active and unblocked.',
  );
  assert.equal(offered.includes(CHART), true, 'The seeded chart is offered.');
  assert.equal(offered.includes(SECOND_CHART), true, 'The chart created for this part is offered.');
  await mkdir('.arena', { recursive: true });
  await page.screenshot({ path: '.arena/gl-accounts-chart-chooser-review.png', fullPage: true });
  console.log(`  ✓ no chart parameter offers the usable charts (${offered.join(', ')}) instead of claiming none exist`);

  // 4.2 A parameter naming a chart that does not exist is named, not folded into the same answer.
  await page.goto(`${BASE}${ROUTE}/new?chart=ZZZZ`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page
    .getByRole('status')
    .filter({ hasText: /Chart of Accounts ZZZZ is not defined in this tenant/ })
    .waitFor();
  assert.equal(await chartOffers(page).then((codes) => codes.length), 0, 'A refusal offers nothing to click.');
  console.log('  ✓ an unknown chart is named rather than reported as no chart at all');

  // 4.3 Change needs an account as well, so a list of charts would only ask a second question
  // with the first unanswered: it is sent to the hub that asks both.
  await page.goto(`${BASE}${ROUTE}/edit`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  // The chooser's status line is the first paragraph; the explanation that follows it carries
  // no role, so each is asserted as what it is rather than through one locator.
  await page.getByRole('status').filter({ hasText: /Choose the Chart of Accounts to work in/ }).waitFor();
  await page.getByText(/This screen needs an account as well as a chart/).waitFor();
  assert.equal(
    await page.locator(`a[href="${ROUTE}"]`).count() >= 1,
    true,
    'The hub that chooses both is linked.',
  );
  console.log('  ✓ change mode asks for the hub rather than offering a chart it cannot use alone');

  // 4.4 A blocked chart accepts no new accounts, so it leaves the chooser — and returns when
  // released. The offer list and the value help read the same set, or the screen disagrees
  // with itself.
  await setChartBlocked(CLIENT, SECOND_CHART, true);
  await page.goto(`${BASE}${ROUTE}/new`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const blocked = await chartOffers(page);
  assert.equal(blocked.includes(SECOND_CHART), false, 'A blocked chart is not offered for new accounts.');
  assert.equal(blocked.includes(CHART), true, 'The unblocked chart is still offered.');
  assert.deepEqual(blocked.sort(), (await storedUsableCharts(CLIENT)).sort(), 'The offer follows the stored state.');
  await setChartBlocked(CLIENT, SECOND_CHART, false);
  await page.goto(`${BASE}${ROUTE}/new`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  assert.equal(
    (await chartOffers(page)).includes(SECOND_CHART),
    true,
    'A released chart is offered again.',
  );
  console.log('  ✓ a blocked chart leaves the chooser and returns when it is released');

  console.log('SCR-028 FS00 part 4 passed: the mode screen says which chart it is working in');
}

function initialScreen2(page: Page) {
  return page.locator('section[aria-labelledby="gl-master-initial-title"]');
}

/** One row of the Account Group registry, addressed by its group code. */
function groupRow(groupList: ReturnType<Page['locator']>, group: string) {
  return groupList.locator('tbody tr').filter({ hasText: group }).first();
}

type StoredGroup = {
  description: string;
  from_account_number: string;
  to_account_number: string;
  is_active: boolean;
  version: number;
};

async function storedGroup(client: string, group: string): Promise<StoredGroup | undefined> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(
      sql`select description, from_account_number, to_account_number, is_active, version
            from gl_account_group
           where chart_of_accounts = ${CHART} and account_group = ${group}`,
    ),
  )) as unknown as StoredGroup[];
  return rows[0];
}

async function storedMatrix(client: string, group: string) {
  return (await withTenant(client, (tx) =>
    tx.execute(
      sql`select field_key, status
            from gl_account_group_field_status
           where chart_of_accounts = ${CHART} and account_group = ${group}
           order by field_key`,
    ),
  )) as unknown as Array<{ field_key: string; status: string }>;
}

/**
 * Block and unblock the chart behind the screen's back, because the point is what FS00
 * does when OB13 has blocked it — and OB13 is a different screen with its own acceptance.
 */
async function setChartBlocked(client: string, chart: string, blocked: boolean) {
  await withTenant(client, (tx) =>
    tx.execute(
      sql`update chart_of_accounts set is_blocked = ${blocked} where chart_of_accounts = ${chart}`,
    ),
  );
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
  const initial = page.locator('section[aria-labelledby="gl-master-initial-title"]');
  await initial.locator('[name="chart"]').fill(CHART);
  await initial.getByRole('radio', { name: 'Create', exact: true }).check();
  await initial.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForURL(`${BASE}${ROUTE}/new?chart=${CHART}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');

  const fields = page.locator('section[aria-labelledby="gl-master-field-title"]');
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

/** The chart codes the chooser offers, read from the links it renders. */
async function chartOffers(page: Page): Promise<string[]> {
  const hrefs = await page
    .locator(`a[href^="${ROUTE}/new?chart="]`)
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('href') ?? ''));
  return hrefs
    .map((href) => new URL(href, 'http://localhost').searchParams.get('chart') ?? '')
    .filter((code) => code.length > 0);
}

/** The charts this mode may work in: active and unblocked, which is the set the screen offers. */
async function storedUsableCharts(client: string): Promise<string[]> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(
      sql`select chart_of_accounts
            from chart_of_accounts
           where is_active and not is_blocked
           order by chart_of_accounts`,
    ),
  )) as unknown as Array<{ chart_of_accounts: string }>;
  return rows.map((row) => row.chart_of_accounts);
}

/**
 * Create the second chart by copying the seeded one, behind the screen's back, because the
 * point of this part is what FS00 renders when a tenant holds two usable charts — and
 * defining one is OB13's screen, with its own acceptance.
 */
async function defineChart(client: string, chart: string, name: string) {
  await withTenant(client, (tx) =>
    tx.execute(
      sql`insert into chart_of_accounts
            (client, chart_of_accounts, name, language, account_number_length, group_chart,
             cost_element_integration, is_blocked, is_active, created_by)
          select client, ${chart}, ${name}, language, account_number_length, group_chart,
                 cost_element_integration, false, true, 'BROWSER_FIXTURE'
            from chart_of_accounts
           where client = ${client} and chart_of_accounts = ${CHART}
          on conflict do nothing`,
    ),
  );
}
