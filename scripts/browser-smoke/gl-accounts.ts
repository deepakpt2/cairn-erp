import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

function scope(ctx: Context) {
  return { page: ctx.page, BASE: ctx.base, CLIENT: ctx.target.client };
}

const ROUTE = '/config/gl-accounts';
/** Created through the UI in this run; the fixture tenant is disposable. */
const CREATED_ACCOUNT = '9990001111';
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

  console.log('SCR-028 FS00 part 1 passed: hub, registry aliases, Create mode and Display mode');
}
