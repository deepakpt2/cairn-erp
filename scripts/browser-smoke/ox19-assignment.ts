import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { hashPassword } from '../../src/platform/auth/password';
import { withTenant } from '../../src/platform/db/client';
import { changeHistory } from '../../src/platform/change';
import { defineCompanyCode } from '../../src/modules/foundation/company-code-definition';
import { saveControllingArea } from '../../src/modules/foundation/controlling-area-maintenance';
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
  await firstRow.getByRole('button', { name: 'Unassign', exact: true }).click();
  await page.getByRole('status').getByText(
    'Company Code M201 unassigned from Controlling Area M210; prior change history retained.',
    { exact: true },
  ).waitFor();
  await firstRow.waitFor({ state: 'detached' });
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
  await secondRow.getByRole('button', { name: 'Unassign', exact: true }).click();
  await page.getByRole('status').getByText(
    'Company Code M202 unassigned from Controlling Area M210; prior change history retained.',
    { exact: true },
  ).waitFor();
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
}
