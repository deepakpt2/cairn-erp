import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { hashPassword } from '../../src/platform/auth/password';
import { withTenant } from '../../src/platform/db/client';
import { changeHistory } from '../../src/platform/change';
import { defineCompanyCode } from '../../src/modules/foundation/company-code-definition';
import { saveControllingArea } from '../../src/modules/foundation/controlling-area-maintenance';
import type { Route } from '@playwright/test';
import { upsertCompanyCode } from '../../src/modules/foundation/services';
import type { BrowserContext } from '../browser-smoke/checks';

const ASSIGNMENT_ACTIVITY = 'CFG.COST.CONTROLLINGAREA.ASSIGN_COMPANY';
const CONTROLLING_AREA_DEFINE = 'CFG.COST.CONTROLLINGAREA.DEFINE';
const COMPANY_CODE_DEFINE = 'CFG.ORG.COMPANYCODE.DEFINE';
const PERMISSION_REQUIRED = 'Changing assignments requires both Controlling Area configuration and Company Code configuration permissions.';
const PASSWORD = 'browser-check-2026';
const ROUTE = '/config/controlling-area/assign-company-code';

type CompanyFixture = {
  chart?: string;
  fiscalYearVariant?: string;
  currency?: string;
  active?: boolean;
};

async function createArea(client: string, code: string, scope: 'SINGLE' | 'MULTIPLE', name: string, active = true) {
  await saveControllingArea({
    client,
    changedBy: 'browser.admin',
    mode: 'CREATE',
    expectedVersion: 0,
    controllingArea: code,
    name,
    organizationName: 'Browser OX19 fixture',
    companyCodeScope: scope,
    currency: 'KWD',
    fiscalYearVariant: 'K4',
    reason: 'SCR-025 OX19 browser acceptance fixture',
  });
  if (!active) {
    await withTenant(client, (tx) => tx.execute(sql`
      update controlling_area set is_active = false, changed_by = 'BROWSER_FIXTURE', changed_at = now()
       where client = ${client} and controlling_area = ${code}
    `));
  }
}

async function createCompany(client: string, code: string, options: CompanyFixture = {}) {
  const chart = options.chart ?? 'CA01';
  const fiscalYearVariant = options.fiscalYearVariant ?? 'K4';
  const currency = options.currency ?? 'KWD';
  const name = `Browser OX19 ${code}`;
  await defineCompanyCode({
    client,
    changedBy: 'browser.admin',
    companyCode: code,
    name,
    country: 'KW',
    currency,
  });
  await upsertCompanyCode({
    client,
    changedBy: 'browser.admin',
    companyCode: code,
    name,
    chartOfAccounts: chart,
    fiscalYearVariant,
    postingPeriodVariant: 'C001',
    currency,
    country: 'KW',
  });
  if (options.active === false) {
    await withTenant(client, (tx) => tx.execute(sql`
      update company_code set is_active = false, changed_by = 'BROWSER_FIXTURE', changed_at = now()
       where client = ${client} and company_code = ${code}
    `));
  }
}

async function createAccessUsers(client: string) {
  const passwordHash = await hashPassword(PASSWORD);
  const users = [
    {
      username: 'ox19.area.only',
      fullName: 'OX19 Controlling Area Only',
      roleCode: 'OX19_AREA_ONLY',
      capabilities: [CONTROLLING_AREA_DEFINE],
    },
    {
      username: 'ox19.company.only',
      fullName: 'OX19 Company Code Only',
      roleCode: 'OX19_COMPANY_ONLY',
      capabilities: [COMPANY_CODE_DEFINE],
    },
    {
      username: 'ox19.both',
      fullName: 'OX19 Dual Capability',
      roleCode: 'OX19_BOTH',
      capabilities: [CONTROLLING_AREA_DEFINE, COMPANY_CODE_DEFINE],
    },
    {
      // A second capable session, so one of them can be told to display by the other's lock.
      username: 'ox19.both.other',
      fullName: 'OX19 Dual Capability Second Session',
      roleCode: 'OX19_BOTH_OTHER',
      capabilities: [CONTROLLING_AREA_DEFINE, COMPANY_CODE_DEFINE],
    },
  ];

  await withTenant(client, async (tx) => {
    for (const user of users) {
      await tx.execute(sql`
        insert into role (client, code, name, is_system_role, is_read_only, created_by)
        values (${client}, ${user.roleCode}, ${user.fullName}, false, false, 'BROWSER_FIXTURE')
        on conflict (client, code) do nothing
      `);
      for (const capability of user.capabilities) {
        await tx.execute(sql`
          insert into role_capability (client, role_code, capability_code, created_by)
          values (${client}, ${user.roleCode}, ${capability}, 'BROWSER_FIXTURE')
          on conflict (client, role_code, capability_code) do nothing
        `);
      }
      const userId = randomUUID();
      await tx.execute(sql`
        insert into app_user
          (id, client, username, full_name, password_hash, must_change_password, created_by)
        values (${userId}, ${client}, ${user.username}, ${user.fullName}, ${passwordHash}, false, 'BROWSER_FIXTURE')
      `);
      await tx.execute(sql`
        insert into user_role (client, user_id, role_code, created_by)
        values (${client}, ${userId}, ${user.roleCode}, 'BROWSER_FIXTURE')
      `);
    }
  });
}

export async function controllingAreaCompanyAssignment(ctx: BrowserContext) {
  const { page, base: BASE, target } = ctx;
  const CLIENT = target.client;
  const assignmentForm = page.locator('section[aria-labelledby="assign-company-code-form-title"] form');
  const areaInput = assignmentForm.locator('[name="controllingArea"]');
  const companyInput = assignmentForm.locator('[name="companyCode"]');

  console.log('SCR-025 OX19: verify workbench discovery, tenant-local F4, compatibility, audit lifecycle and dual-capability access');

  // Add isolated source fixtures while the test user remains on the workbench.
  // Opening OX19 afterwards ensures server-rendered F4 choices include them.
  // The Company Code screen has no Fiscal Year Variant assignment action yet,
  // so otherwise-valid financial tuples are established through its service.
  await withTenant(CLIENT, async (tx) => {
    await tx.execute(sql`
      insert into chart_of_accounts (client, chart_of_accounts, name, language, account_number_length, created_by)
      values (${CLIENT}, 'ALT1', 'Browser OX19 alternate chart', 'EN', 6, 'BROWSER_FIXTURE')
      on conflict (client, chart_of_accounts) do nothing
    `);
    await tx.execute(sql`
      insert into fiscal_year_variant
        (client, variant, name, regular_periods, special_periods, is_calendar_year, created_by)
      values (${CLIENT}, 'F2', 'Browser OX19 alternate year', 12, 4, false, 'BROWSER_FIXTURE')
      on conflict (client, variant) do nothing
    `);
  });
  await createArea(CLIENT, 'M210', 'MULTIPLE', 'Browser OX19 Multiple Area');
  await createArea(CLIENT, 'M211', 'MULTIPLE', 'Browser OX19 Reassignment Area');
  await createArea(CLIENT, 'S210', 'SINGLE', 'Browser OX19 Single Area');
  await createArea(CLIENT, 'I210', 'MULTIPLE', 'Browser OX19 Inactive Area', false);
  await createCompany(CLIENT, 'M201');
  await createCompany(CLIENT, 'M202');
  await createCompany(CLIENT, 'M203', { chart: 'ALT1' });
  await createCompany(CLIENT, 'M204', { fiscalYearVariant: 'F2' });
  await createCompany(CLIENT, 'M205', { currency: 'USD' });
  await createCompany(CLIENT, 'S201');
  await createCompany(CLIENT, 'S202');
  await createCompany(CLIENT, 'S203', { fiscalYearVariant: 'F2' });
  await createCompany(CLIENT, 'S204', { currency: 'USD' });
  await createCompany(CLIENT, 'I201', { active: false });
  await defineCompanyCode({
    client: CLIENT,
    changedBy: 'browser.admin',
    companyCode: 'LONGCODE',
    name: 'Browser OX19 legacy long key',
    country: 'KW',
    currency: 'KWD',
  });

  // The workbench must open the separate OX19 activity, not the OKKP definition page.
  const workbenchRow = page.locator('tr').filter({ hasText: ASSIGNMENT_ACTIVITY });
  assert.equal(await workbenchRow.count(), 1);
  const assignmentLink = workbenchRow.getByRole('link', { name: 'Open', exact: true });
  await assignmentLink.scrollIntoViewIfNeeded();
  // Let Next complete any viewport-triggered RSC prefetch before the click.
  await page.waitForLoadState('networkidle');
  await assignmentLink.click();
  await page.waitForURL((url) => url.pathname === ROUTE, { waitUntil: 'commit', timeout: 15_000 });
  await page.getByRole('heading', { level: 1, name: 'Company Code Assignments', exact: true }).waitFor();
  await page.getByText('Link existing Company Codes to existing Controlling Areas. Each Company Code can belong to only one Controlling Area.', { exact: true }).waitFor();

  const openAreaLookup = async () => {
    await page.getByRole('button', { name: 'Open Controlling Area lookup (F4)', exact: true }).click();
    return page.getByRole('dialog', { name: 'Controlling Area lookup', exact: true });
  };
  const openCompanyLookup = async () => {
    await page.getByRole('button', { name: 'Open Company Code lookup (F4)', exact: true }).click();
    return page.getByRole('dialog', { name: 'Company Code lookup', exact: true });
  };
  const chooseArea = async (code: string) => {
    const dialog = await openAreaLookup();
    await dialog.getByLabel('Search by code or name').fill(code);
    const choice = dialog.locator('li').filter({ hasText: code }).getByRole('button');
    await choice.waitFor();
    assert.ok((await choice.innerText()).startsWith(code));
    await choice.click();
  };
  const chooseCompany = async (code: string) => {
    const dialog = await openCompanyLookup();
    await dialog.getByLabel('Search by code or name').fill(code);
    const choice = dialog.locator('li').filter({ hasText: code }).getByRole('button');
    await choice.waitFor();
    assert.ok((await choice.innerText()).startsWith(code));
    await choice.click();
  };
  const selectPair = async (area: string, company: string, useF4 = false) => {
    if (useF4) {
      await chooseArea(area);
      await chooseCompany(company);
    } else {
      await areaInput.fill(area);
      await companyInput.fill(company);
    }
  };
  const addButton = assignmentForm.getByRole('button', { name: 'Add assignment', exact: true });
  const submitAndExpect = async (area: string, company: string, useF4 = false) => {
    await selectPair(area, company, useF4);
    await addButton.click();
    await page.getByRole('status').getByText(
      `Company Code ${company} assigned to Controlling Area ${area}; change history recorded.`,
      { exact: true },
    ).waitFor();
  };
  const submitAndExpectError = async (area: string, company: string, message: RegExp) => {
    await selectPair(area, company);
    await addButton.click();
    await page.getByRole('alert').getByText(message).waitFor();
  };
  const readLink = async (area: string, company: string) => withTenant(CLIENT, async (tx) => {
    const rows = await tx.execute(sql`
      select controlling_area, company_code from controlling_area_company
       where client = ${CLIENT} and controlling_area = ${area} and company_code = ${company}
    `);
    return (rows as unknown as unknown[]).length === 1;
  });
  const linkHistory = async (area: string, company: string) =>
    withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'controlling_area_company', `${area}/${company}`));
  const lockRow = async (area: string, company: string) => (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select owner_user from public.enqueue_entry
     where client = ${CLIENT} and lock_object = 'CONTROLLING_AREA_COMPANY' and argument = ${`${area}/${company}`}
  `))) as unknown as Array<{ owner_user: string }>;
  const waitForLock = async (area: string, company: string, expect = true) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const rows = await lockRow(area, company);
      if (rows.length > 0 === expect) return rows;
      await page.waitForTimeout(250);
    }
    return lockRow(area, company);
  };

  /**
   * The unassign a real operator performs: one press of the row's own button. The press opens the
   * change lock for that pair and the unassignment goes through when the opening is granted — the
   * row used to swallow that first press, because the gate asked for a lock the press had only just
   * started to claim, so the sequence is asserted end to end rather than retried.
   */
  const unassignRow = async (row: ReturnType<typeof page.locator>, area: string, company: string) => {
    const button = row.getByRole('button', { name: 'Unassign', exact: true });
    assert.equal(await button.isDisabled(), false, 'A row nobody has opened yet offers its control.');
    await button.click();
    await page.getByRole('status').getByText(
      `Company Code ${company} unassigned from Controlling Area ${area}; prior change history retained.`,
      { exact: true },
    ).waitFor();
    await row.waitFor({ state: 'detached' });
    assert.equal(await readLink(area, company), false, 'The link is gone from the table.');
    assert.ok((await linkHistory(area, company)).some((event) => event.changeType === 'DELETE'), 'The delete is in the audit history.');
    assert.equal(
      (await waitForLock(area, company, false)).length,
      0,
      'Leaving the row released the opening, so no stale lock stands behind the work.',
    );
  };


  // Both inactive masters remain visible and selectable; non-Char-4 legacy keys
  // stay visible for discovery but are disabled in value help.
  const areaDialog = await openAreaLookup();
  const inactiveAreaChoice = areaDialog.locator('li').filter({ hasText: 'I210' }).getByRole('button');
  await inactiveAreaChoice.waitFor();
  assert.match(await inactiveAreaChoice.innerText(), /Inactive/i);
  await areaDialog.getByRole('button', { name: 'Cancel', exact: true }).click();

  const companyDialog = await openCompanyLookup();
  const inactiveCompanyChoice = companyDialog.locator('li').filter({ hasText: 'I201' }).getByRole('button');
  await inactiveCompanyChoice.waitFor();
  assert.match(await inactiveCompanyChoice.innerText(), /Inactive/i);
  const legacyChoice = companyDialog.locator('li').filter({ hasText: 'LONGCODE' }).getByRole('button');
  await legacyChoice.waitFor();
  assert.equal(await legacyChoice.isDisabled(), true);
  assert.match(await legacyChoice.innerText(), /Not selectable/i);
  await companyDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  console.log('  ✓ F4 includes inactive tenant masters and disables, but still displays, non-Char-4 legacy keys');

  // The initial MULTIPLE assignment establishes the current CoA baseline.
  await submitAndExpect('M210', 'M201', true);
  assert.equal(await readLink('M210', 'M201'), true);
  const createHistory = await linkHistory('M210', 'M201');
  assert.equal(createHistory.length, 1);
  assert.equal(createHistory[0]?.changeType, 'CREATE');
  assert.equal(createHistory[0]?.changedBy, 'browser.admin');
  assert.equal(createHistory[0]?.transactionCode, ASSIGNMENT_ACTIVITY);
  await submitAndExpect('M210', 'M202');
  assert.equal((await withTenant(CLIENT, (tx) => tx.execute(sql`
    select count(*)::int as n from controlling_area_company
     where client = ${CLIENT} and controlling_area = 'M210'
  `)) as unknown as Array<{ n: number }>)[0]?.n, 2);
  console.log('  ✓ MULTIPLE permits a second compatible Company Code and records the first-assignment baseline');

  await selectPair('M210', 'M201');
  await addButton.click();
  await page.getByRole('status').getByText(
    'Company Code M201 is already assigned to Controlling Area M210. No mapping change was made; the duplicate request was recorded in history.',
    { exact: true },
  ).waitFor();
  let history = await linkHistory('M210', 'M201');
  assert.equal(history.length, 2);
  assert.ok(history.some((event) => event.items.some((item) => item.newValue === 'DUPLICATE_NO_OP')));
  assert.equal(await readLink('M210', 'M201'), true);
  console.log('  ✓ duplicate request is an audited state no-op with explicit feedback');

  await submitAndExpectError('M210', 'M203', /Operational Chart of Accounts ALT1 does not match the current assignment baseline CA01/);
  await submitAndExpectError('M210', 'M204', /Fiscal Year Variant F2 does not match Controlling Area M210 Fiscal Year Variant K4/);
  await submitAndExpectError('M210', 'M205', /local currency USD does not match Controlling Area M210 currency KWD/);
  console.log('  ✓ CoA baseline, Fiscal Year Variant and Currency Key mismatches are rejected in MULTIPLE scope');

  // In SINGLE scope, financial mismatches are reported before cardinality; one
  // compatible row is allowed and the next is refused.
  await submitAndExpectError('S210', 'S203', /Fiscal Year Variant F2 does not match Controlling Area S210 Fiscal Year Variant K4/);
  await submitAndExpectError('S210', 'S204', /local currency USD does not match Controlling Area S210 currency KWD/);
  await submitAndExpect('S210', 'S201');
  await submitAndExpectError('S210', 'S202', /configured for Same Company Code and already has a Company Code assignment/);
  assert.equal((await withTenant(CLIENT, (tx) => tx.execute(sql`
    select count(*)::int as n from controlling_area_company
     where client = ${CLIENT} and controlling_area = 'S210'
  `)) as unknown as Array<{ n: number }>)[0]?.n, 1);
  console.log('  ✓ SINGLE enforces exact Currency/Fiscal Year settings and a one-Company-Code maximum');

  // Inactive source rows remain valid for assignment and their state is visible in F4.
  await submitAndExpect('I210', 'I201', true);
  const inactiveRow = page.locator('tbody tr').filter({ hasText: 'I210' }).filter({ hasText: 'I201' });
  await inactiveRow.waitFor();
  assert.match(await inactiveRow.innerText(), /Inactive/i);
  console.log('  ✓ inactive Controlling Area and Company Code remain assignable with visible status');

  // No implicit reassignment: reject a second owner, then perform Unassign and Add.
  await submitAndExpectError('M211', 'M201', /already assigned to Controlling Area M210/);
  const firstRow = page.locator('tbody tr').filter({ hasText: 'M210' }).filter({ hasText: 'M201' });
  await unassignRow(firstRow, 'M210', 'M201');
  assert.equal(await readLink('M210', 'M201'), false);
  history = await linkHistory('M210', 'M201');
  assert.equal(history.length, 3);
  assert.ok(history.some((event) => event.changeType === 'CREATE'));
  assert.ok(history.some((event) => event.changeType === 'DELETE'));
  await submitAndExpect('M211', 'M201');
  assert.equal(await readLink('M211', 'M201'), true);
  assert.equal((await linkHistory('M211', 'M201')).length, 1);
  console.log('  ✓ reassignment requires separate Unassign then Add; delete audit history is retained');

  // Removing the last current link clears the derived CoA baseline; the next
  // first assignment may establish a different baseline.
  const secondRow = page.locator('tbody tr').filter({ hasText: 'M210' }).filter({ hasText: 'M202' });
  await unassignRow(secondRow, 'M210', 'M202');
  await submitAndExpect('M210', 'M203');
  await submitAndExpectError('M210', 'M202', /Operational Chart of Accounts CA01 does not match the current assignment baseline ALT1/);
  console.log('  ✓ an empty assignment set accepts a new first CoA baseline');

  await createAccessUsers(CLIENT);
  async function signInAs(username: string) {
    const signedOut = page.waitForURL((url) => url.pathname === '/signin', { waitUntil: 'commit', timeout: 30_000 });
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await signedOut;
    await page.locator('[name="client"]').fill(CLIENT);
    await page.locator('[name="username"]').fill(username);
    await page.locator('[name="password"]').fill(PASSWORD);
    const signedIn = page.waitForURL((url) => url.pathname === '/', { waitUntil: 'commit', timeout: 30_000 });
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await signedIn;
    await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
    await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { level: 1, name: 'Company Code Assignments', exact: true }).waitFor();
  }

  for (const username of ['ox19.area.only', 'ox19.company.only']) {
    await signInAs(username);
    await page.getByRole('status').getByText(PERMISSION_REQUIRED, { exact: true }).waitFor();
    assert.equal(await areaInput.isDisabled(), true, `${username} must not edit Controlling Area input.`);
    assert.equal(await companyInput.isDisabled(), true, `${username} must not edit Company Code input.`);
    assert.equal(await addButton.isDisabled(), true, `${username} must not add an assignment.`);
    assert.equal(await page.getByRole('button', { name: 'Open Controlling Area lookup (F4)', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Open Company Code lookup (F4)', exact: true }).isDisabled(), true);
    const existingRow = page.locator('tbody tr').filter({ hasText: 'A000' }).filter({ hasText: '1000' });
    assert.equal(await existingRow.getByRole('button', { name: 'Unassign', exact: true }).isDisabled(), true);
    console.log(`  ✓ ${username} cannot mutate OX19 with only one of the two required capabilities`);
  }

  await signInAs('ox19.both');
  assert.equal(await areaInput.isDisabled(), false);
  assert.equal(await companyInput.isDisabled(), false);
  assert.equal(await addButton.isDisabled(), false);
  const authorizedRow = page.locator('tbody tr').filter({ hasText: 'A000' }).filter({ hasText: '1000' });
  assert.equal(await authorizedRow.getByRole('button', { name: 'Unassign', exact: true }).isDisabled(), false);
  console.log('  ✓ a user holding both exact owner-approved capabilities receives OX19 mutation controls');

  // ── The change lock, on a pair this session has opened ──────────────────────────────
  // Focusing a row is what opens its lock here, exactly as tabbing to the control does for an
  // operator, so the opening is claimed without submitting and held while the row stands.
  const AREA = 'M211';
  const COMPANY = 'M201';
  const HOLDER = 'ox19.both';
  const VIEWER = 'ox19.both.other';
  const heldRow = page.locator('tbody tr').filter({ hasText: AREA }).filter({ hasText: COMPANY });
  await heldRow.getByRole('button', { name: 'Unassign', exact: true }).focus();
  assert.equal((await waitForLock(AREA, COMPANY))[0]?.owner_user, HOLDER);

  const browser = page.context().browser();
  assert.ok(browser, 'the browser is available for a second session');
  const second = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const other = await second.newPage();
  await other.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
  await other.locator('[name="client"]').fill(CLIENT);
  await other.locator('[name="username"]').fill(VIEWER);
  await other.locator('[name="password"]').fill(PASSWORD);
  const signedIn = other.waitForURL((url) => url.pathname === '/', { waitUntil: 'commit', timeout: 30_000 });
  await other.getByRole('button', { name: 'Sign in', exact: true }).click();
  await signedIn;
  await other.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await other.getByRole('heading', { level: 1, name: 'Company Code Assignments', exact: true }).waitFor();

  const otherRow = other.locator('tbody tr').filter({ hasText: AREA }).filter({ hasText: COMPANY });
  const otherButton = otherRow.getByRole('button', { name: 'Unassign', exact: true });
  const beforeRefusal = await readLink(AREA, COMPANY);
  const historyBeforeRefusal = (await linkHistory(AREA, COMPANY)).length;

  // The stale moment an operator actually meets: this page loaded before the pair was opened, so it
  // still offers the control. The press claims the opening, the opening answers display-only, and the
  // press is kept back rather than filed — the notice and the recovery sentence are what the operator
  // gets, and the control is taken away for as long as the refusal stands.
  assert.equal(await otherButton.isDisabled(), false, 'A session that never opened the row still sees the control it loaded.');
  await otherButton.click();
  await other.getByRole('status').getByText(
    new RegExp(`CONTROLLING_AREA_COMPANY ${AREA}/${COMPANY} is being changed by ${HOLDER} in ${CONTROLLING_AREA_DEFINE}\\. This opening is display only\\.`),
  ).waitFor();
  // The recovery sentence is part of the refusal, not an optional extra.
  await other.getByText(/a lock nobody answers is released about three minutes after its last answer/).waitFor();
  assert.equal(await otherButton.isDisabled(), true, 'A display-only opening must not offer the press.');
  await other.waitForTimeout(1500);
  // The refused press must never reach the action, so no refusal wording may appear on this page:
  // the block the action would answer through is the assignments alert, and it stays silent. A press
  // that had been filed and rejected server-side would have written "This session cannot change it."
  const viewerAlerts = (await other.getByRole('alert').allInnerTexts()).join('\n');
  assert.doesNotMatch(
    viewerAlerts,
    /cannot change it|not open for change|is being changed by/,
    `the refused press reached the action; the viewer was told: ${viewerAlerts}`,
  );
  assert.equal(await readLink(AREA, COMPANY), beforeRefusal, 'A refused unassign moved nothing.');
  assert.equal((await linkHistory(AREA, COMPANY)).length, historyBeforeRefusal, 'A refused unassign filed no audit record.');
  assert.equal((await lockRow(AREA, COMPANY))[0]?.owner_user, HOLDER,
    'The viewer neither took nor broke the lock it was refused.');
  console.log('  ✓ a press from a stale session is refused with the recovery sentence and files nothing');
  // The client gate is not the boundary: the action re-checks the same session lock, and
  // tests/session-change-lock.test.ts holds the platform rule that a second session reads and never
  // takes over. Forging a request past this button would meet that check, not a missing one.

  // The holder still owns the pair, so its own press completes the work and releases on leaving.
  await unassignRow(heldRow, AREA, COMPANY);
  await second.close();
  assert.equal((await lockRow(AREA, COMPANY)).length, 0, 'No lock stands after the holder finished.');
  console.log('  ✓ the holder completes the unassign in one press and no lock or assignment is left behind');

  // ── The claim the browser cannot reach ─────────────────────────────────────────────
  // A fresh opening of the page, a pair nobody has locked, and the action route cut for one
  // interaction. The press starts the claim, the claim never answers, and the row has to say so as a
  // failure: not as another session's refusal, not as a saved change, and with nothing filed. The
  // control stays pressable, because the operator's next press is the retry and the only way back.
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Company Code Assignments', exact: true }).waitFor();
  const FAIL_AREA = 'M210';
  const FAIL_COMPANY = 'M203';
  const failRow = page.locator('tbody tr').filter({ hasText: FAIL_AREA }).filter({ hasText: FAIL_COMPANY });
  await failRow.waitFor();
  const failButton = failRow.getByRole('button', { name: 'Unassign', exact: true });
  const actionUrl = new URL(page.url()).pathname;
  const samePage = (url: URL) => url.pathname === actionUrl;
  const cut = async (route: Route) => (route.request().method() === 'POST' ? route.abort('failed') : route.continue());
  await page.route(samePage, cut);
  const historyBeforeFailure = (await linkHistory(FAIL_AREA, FAIL_COMPANY)).length;
  assert.equal(await readLink(FAIL_AREA, FAIL_COMPANY), true);
  assert.equal(await failButton.isDisabled(), false, 'An unopened row offers its control to a session that has not claimed it.');

  await failButton.click();
  await page.getByRole('alert').filter({ hasText: /Error/i }).first().waitFor({ timeout: 20_000 });
  const failureAlerts = (await page.getByRole('alert').allInnerTexts()).join('\n');
  assert.doesNotMatch(
    failureAlerts,
    /cannot change it|not open for change|is being changed by|display only|lock monitor/i,
    `an unreachable claim was told as somebody else holding the row: ${failureAlerts}`,
  );
  assert.doesNotMatch(failureAlerts, /unassigned|saved|recorded/i, 'a failed claim may not report a change.');
  await page.waitForTimeout(1_500);
  assert.equal(await readLink(FAIL_AREA, FAIL_COMPANY), true, 'A failed claim files nothing, then or afterwards.');
  assert.equal(
    (await linkHistory(FAIL_AREA, FAIL_COMPANY)).length,
    historyBeforeFailure,
    'A failed claim leaves the audit history untouched.',
  );
  assert.equal((await waitForLock(FAIL_AREA, FAIL_COMPANY, false)).length, 0, 'A claim that never reached the server took no lock.');
  assert.equal(await failButton.isDisabled(), false, 'A failed claim leaves the row pressable, so the operator can ask again.');
  await page.unroute(samePage, cut);
  console.log(`  ✓ a claim that cannot be reached is told as a failure and files nothing (${failureAlerts.replace(/\s+/g, ' ').trim()})`);

  // The next press re-claims, and this time the answer is a grant: the unassignment goes through on
  // that single press, with its audit record and no opening left behind.
  await failButton.click();
  await page.getByRole('status').getByText(
    `Company Code ${FAIL_COMPANY} unassigned from Controlling Area ${FAIL_AREA}; prior change history retained.`,
    { exact: true },
  ).waitFor();
  await failRow.waitFor({ state: 'detached' });
  assert.equal(await readLink(FAIL_AREA, FAIL_COMPANY), false);
  assert.ok((await linkHistory(FAIL_AREA, FAIL_COMPANY)).some((event) => event.changeType === 'DELETE'));
  assert.equal((await waitForLock(FAIL_AREA, FAIL_COMPANY, false)).length, 0);
  console.log('  ✓ the press after a failed claim retries the opening and completes in one press');
}
