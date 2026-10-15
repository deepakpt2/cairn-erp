import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import { assignCompanyCodeCoa } from '../../src/modules/foundation/company-code-coa-assignment';
import { defineCompanyCode } from '../../src/modules/foundation/company-code-definition';
import {
  chartOfAccountsHasAccountsOrTransactions,
  listChartOfAccounts,
  listGroupChartsOfAccounts,
  saveChartOfAccounts,
} from '../../src/modules/foundation/chart-of-accounts-maintenance';
import { upsertGlAccount } from '../../src/modules/foundation/services';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

function scope(ctx: Context) {
  return { page: ctx.page, BASE: ctx.base, CLIENT: ctx.target.client };
}

/**
 * SCR-026 / OB13 browser acceptance.
 *
 * Covers the definition fields, both F4 value helps, change history, the account-number
 * length lock, the block gate, and the two owner-confirmed amendments: the separate
 * Group CoA registry (tenant-wide key reservation) and the deactivate/reactivate
 * lifecycle with its mandatory audited reason.
 */
export async function chartOfAccountsDefinition(ctx: Context) {
  const { page, BASE, CLIENT } = scope(ctx);
  const route = `${BASE}/config/chart-of-accounts`;
  console.log('SCR-026 OB13: verify Chart of Accounts definition, Group CoA registry, lifecycle, F4, audit and lock/block gates');

  await page.goto(route, { waitUntil: 'domcontentloaded' });
  // Client-side dialogs and forms attach their handlers during hydration; wait for assets first.
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Chart of Accounts', exact: true }).waitFor();

  const createPanel = page.locator('section[aria-labelledby="ob13-create-title"]');
  const chartList = page.locator('section[aria-labelledby="chart-of-accounts-list-title"]');
  const groupPanel = page.locator('section[aria-labelledby="ob13-group-panel-title"]');
  const groupList = page.locator('section[aria-labelledby="ob13-group-list-title"]');
  const groupF4 = createPanel.getByRole('button', { name: /Open Group Chart of Accounts lookup/ });
  await createPanel.waitFor();
  await groupPanel.waitFor();

  assert.equal(await createPanel.locator('[name="language"]').inputValue(), 'EN');
  assert.equal(await createPanel.locator('[name="accountNumberLength"]').inputValue(), '10');
  assert.equal(await createPanel.locator('[name="costElementIntegration"]').inputValue(), 'AUTOMATIC');
  assert.equal(await createPanel.locator('[name="isBlocked"]').isChecked(), false);

  const standardRow = chartList.locator('tbody tr').filter({ hasText: 'CA01' });
  await standardRow.waitFor();
  assert.match(await standardRow.innerText(), /10[\s\S]*Locked[\s\S]*74 G\/L accounts/i);
  const baseline = await listChartOfAccounts(CLIENT);
  assert.equal(baseline.find((row) => row.chartOfAccounts === 'CA01')?.accountNumberLengthLocked, true);

  // The only supported locale is English; the Group CoA registry starts empty, so its F4
  // has nothing to offer — in particular it never offers the operational chart CA01.
  assert.equal((await listGroupChartsOfAccounts(CLIENT)).length, 0);
  assert.equal(await groupF4.isDisabled(), true, 'Group CoA F4 is disabled while the registry has no active entry.');
  await createPanel.getByRole('button', { name: /Open Language Key lookup/ }).click();
  const languageDialog = page.getByRole('dialog').filter({ hasText: 'Language Key lookup' });
  await languageDialog.getByRole('button').filter({ hasText: 'English' }).click();

  // The Group CoA registry is maintained on the same protected OB13 screen.
  await groupPanel.locator('[name="groupChartOfAccounts"]').fill('GR01');
  await groupPanel.locator('[name="name"]').fill('Cairn Group Consolidation');
  assert.equal(await groupPanel.locator('[name="language"]').inputValue(), 'EN');
  await groupPanel.locator('[name="reason"]').fill('SCR-026 browser Group CoA create');
  await groupPanel.getByRole('button', { name: 'Create Group CoA', exact: true }).click();
  await groupPanel.getByRole('status').getByText(
    'Group CoA GR01 created and change history recorded.',
    { exact: true },
  ).waitFor();

  // A four-character key is reserved tenant-wide across both registries.
  await groupPanel.locator('[name="groupChartOfAccounts"]').fill('CA01');
  await groupPanel.locator('[name="name"]').fill('Reserved key attempt');
  await groupPanel.getByRole('button', { name: 'Create Group CoA', exact: true }).click();
  await groupPanel.getByRole('alert').filter({ hasText: 'reserved as an operational Chart of Accounts' }).waitFor();

  await createPanel.locator('[name="chartOfAccounts"]').fill('GR01');
  await createPanel.locator('[name="name"]').fill('Reserved key attempt');
  await createPanel.getByRole('button', { name: 'Create Chart of Accounts', exact: true }).click();
  await createPanel.getByRole('alert').filter({ hasText: 'reserved as a Group CoA' }).waitFor();

  assert.equal((await listChartOfAccounts(CLIENT)).some((row) => row.chartOfAccounts === 'GR01'), false);
  assert.deepEqual(
    (await listGroupChartsOfAccounts(CLIENT)).map((row) => [row.groupChartOfAccounts, row.isActive, row.referencedBy]),
    [['GR01', true, 0]],
  );
  console.log('  ✓ Group CoA registry create and tenant-wide key reservation in both directions');

  // Group CoA F4 now offers the registry entry, and only the registry entry.
  assert.equal(await groupF4.isDisabled(), false);
  await groupF4.click();
  const groupDialog = page.getByRole('dialog').filter({ hasText: 'Group Chart of Accounts lookup' });
  await groupDialog.waitFor();
  await groupDialog.getByRole('button').filter({ hasText: 'GR01' }).click();

  await createPanel.locator('[name="chartOfAccounts"]').fill('B001');
  await createPanel.locator('[name="name"]').fill('International Chart of Accounts');
  await createPanel.locator('[name="accountNumberLength"]').fill('8');
  await createPanel.locator('[name="costElementIntegration"]').selectOption('MANUAL');
  assert.equal(await createPanel.locator('[name="groupChart"]').inputValue(), 'GR01');
  await createPanel.locator('[name="reason"]').fill('SCR-026 browser create');
  await createPanel.getByRole('button', { name: 'Create Chart of Accounts', exact: true }).click();
  await createPanel.getByRole('status').getByText(
    'Chart of Accounts B001 created and change history recorded.',
    { exact: true },
  ).waitFor();

  let records = await listChartOfAccounts(CLIENT);
  let chart = records.find((row) => row.chartOfAccounts === 'B001');
  assert.ok(chart);
  assert.deepEqual({
    name: chart.name,
    language: chart.language,
    accountNumberLength: chart.accountNumberLength,
    groupChart: chart.groupChart,
    costElementIntegration: chart.costElementIntegration,
    isBlocked: chart.isBlocked,
    accountNumberLengthLocked: chart.accountNumberLengthLocked,
  }, {
    name: 'International Chart of Accounts',
    language: 'EN',
    accountNumberLength: 8,
    groupChart: 'GR01',
    costElementIntegration: 'MANUAL',
    isBlocked: false,
    accountNumberLengthLocked: false,
  });
  let history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'chart_of_accounts', 'B001'));
  assert.equal(history.length, 1);
  assert.ok(history[0]?.items.some((item) => item.fieldName === 'groupChart' && item.newValue === 'GR01'));
  assert.ok(history[0]?.items.some((item) => item.fieldName === 'costElementIntegration' && item.newValue === 'MANUAL'));
  console.log('  ✓ OB13 create defaults, four-character key, Language/Group CoA F4 and CREATE history');

  // An unused chart may change its configured account-number limit.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  let chartRow = chartList.locator('tbody tr').filter({ hasText: 'B001' });
  await chartRow.getByText('Change settings', { exact: true }).click();
  let changeDialog = page.getByRole('dialog', { name: 'Change Chart of Accounts B001' });
  await changeDialog.waitFor();
  await changeDialog.locator('[name="accountNumberLength"]').fill('7');
  await changeDialog.locator('[name="costElementIntegration"]').selectOption('NONE');
  await changeDialog.locator('[name="reason"]').fill('SCR-026 browser change before use');
  await changeDialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await changeDialog.getByRole('status').getByText(
    'Chart of Accounts B001 saved and change history recorded.',
    { exact: true },
  ).waitFor();
  await changeDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');

  await upsertGlAccount({
    client: CLIENT,
    chartOfAccounts: 'B001',
    accountNumber: '1234567',
    name: 'SCR-026 account-length fixture',
    accountType: 'EXPENSE',
    isBalanceSheet: false,
    isOpenItemManaged: false,
    requiresCostObject: false,
    isTaxRelevant: false,
    changedBy: 'browser.admin',
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  assert.equal(await chartOfAccountsHasAccountsOrTransactions(CLIENT, 'B001'), true);
  records = await listChartOfAccounts(CLIENT);
  chart = records.find((row) => row.chartOfAccounts === 'B001');
  assert.ok(chart);
  assert.deepEqual({ accountNumberLength: chart.accountNumberLength, glAccountCount: chart.glAccountCount, accountNumberLengthLocked: chart.accountNumberLengthLocked }, {
    accountNumberLength: 7,
    glAccountCount: 1,
    accountNumberLengthLocked: true,
  });

  // The UI renders the field read-only after use, and the service also fails closed on a forged edit.
  chartRow = chartList.locator('tbody tr').filter({ hasText: 'B001' });
  await chartRow.getByText('Change settings', { exact: true }).click();
  changeDialog = page.getByRole('dialog', { name: 'Change Chart of Accounts B001' });
  await changeDialog.waitFor();
  assert.notEqual(await changeDialog.locator('[name="accountNumberLength"]').getAttribute('readonly'), null);
  await changeDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await assert.rejects(saveChartOfAccounts({
    client: CLIENT,
    changedBy: 'browser.admin',
    mode: 'CHANGE',
    expectedVersion: 2,
    chartOfAccounts: 'B001',
    name: 'International Chart of Accounts',
    language: 'EN',
    accountNumberLength: 6,
    groupChart: 'GR01',
    costElementIntegration: 'NONE',
    isBlocked: false,
    reason: 'Forged length change after account creation',
  }), /length.*locked/i);

  // A single block flag gates both new G/L master creation and Company Code assignment.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  chartRow = chartList.locator('tbody tr').filter({ hasText: 'B001' });
  await chartRow.getByText('Change settings', { exact: true }).click();
  changeDialog = page.getByRole('dialog', { name: 'Change Chart of Accounts B001' });
  await changeDialog.waitFor();
  await changeDialog.locator('[name="isBlocked"]').check();
  await changeDialog.locator('[name="reason"]').fill('SCR-026 browser block');
  await changeDialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await changeDialog.getByRole('status').getByText(
    'Chart of Accounts B001 saved and change history recorded.',
    { exact: true },
  ).waitFor();
  await changeDialog.getByRole('button', { name: 'Close', exact: true }).click();

  await assert.rejects(upsertGlAccount({
    client: CLIENT,
    chartOfAccounts: 'B001',
    accountNumber: '7654321',
    name: 'Blocked account creation attempt',
    accountType: 'EXPENSE',
    isBalanceSheet: false,
    isOpenItemManaged: false,
    requiresCostObject: false,
    isTaxRelevant: false,
    changedBy: 'browser.admin',
  }), /new G\/L accounts cannot be created/);

  await defineCompanyCode({
    client: CLIENT,
    changedBy: 'browser.admin',
    companyCode: '2088',
    name: 'SCR-026 blocked Company Code segment fixture',
    country: 'KW',
    currency: 'KWD',
  });
  await assert.rejects(assignCompanyCodeCoa({
    client: CLIENT,
    changedBy: 'browser.admin',
    companyCode: '2088',
    chartOfAccounts: 'B001',
  }), /is blocked and cannot be assigned/);

  await page.goto(`${BASE}/config/company-codes`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Company codes', exact: true }).waitFor();
  const companyChoices = await page.locator('[name="chartOfAccounts"] option').evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value),
  );
  assert.ok(companyChoices.includes('CA01'));
  assert.equal(companyChoices.includes('B001'), false, 'Blocked Chart of Accounts is excluded from Company Code segment F4.');

  records = await listChartOfAccounts(CLIENT);
  chart = records.find((row) => row.chartOfAccounts === 'B001');
  assert.equal(chart?.isBlocked, true);
  history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'chart_of_accounts', 'B001'));
  assert.equal(history.length, 3);
  assert.ok(history[0]?.items.some((item) => item.fieldName === 'isBlocked' && item.newValue === 'true'));
  console.log('  ✓ account length locks after G/L use; one block flag prevents new G/L and Company Code segments');

  // ── Lifecycle: deactivate and reactivate with a mandatory, audited reason ────────
  await page.goto(route, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await createPanel.locator('[name="chartOfAccounts"]').fill('D001');
  await createPanel.locator('[name="name"]').fill('Lifecycle fixture chart');
  await createPanel.locator('[name="accountNumberLength"]').fill('6');
  await createPanel.locator('[name="groupChart"]').fill('');
  await createPanel.locator('[name="reason"]').fill('SCR-026 browser lifecycle fixture');
  await createPanel.getByRole('button', { name: 'Create Chart of Accounts', exact: true }).click();
  await createPanel.getByRole('status').getByText(
    'Chart of Accounts D001 created and change history recorded.',
    { exact: true },
  ).waitFor();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  let lifecycleRow = chartList.locator('tbody tr').filter({ hasText: 'D001' });
  await lifecycleRow.getByText('Deactivate', { exact: true }).click();
  let lifecycleDialog = page.getByRole('dialog', { name: 'Deactivate D001' });
  await lifecycleDialog.waitFor();

  // Without an explanation nothing is written and the dialog stays put.
  const reasonField = lifecycleDialog.locator('[name="reason"]');
  assert.notEqual(await reasonField.getAttribute('required'), null);
  const documentsBefore = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'chart_of_accounts', 'D001'));
  await lifecycleDialog.getByRole('button', { name: 'Deactivate Chart of Accounts', exact: true }).click();
  await page.waitForTimeout(750);
  assert.equal(
    (await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'chart_of_accounts', 'D001'))).length,
    documentsBefore.length,
    'A lifecycle change without a reason writes no change document.',
  );
  assert.equal(await lifecycleDialog.isVisible(), true);

  await reasonField.fill('SCR-026 browser decommission');
  await lifecycleDialog.getByRole('button', { name: 'Deactivate Chart of Accounts', exact: true }).click();
  await lifecycleRow.getByRole('status').getByText(
    'Chart of Accounts D001 deactivated and change history recorded.',
    { exact: true },
  ).waitFor();

  // The row is retained and readable, but no longer offers maintenance.
  assert.match(await lifecycleRow.innerText(), /Deactivated/);
  assert.equal(await lifecycleRow.getByText('Change settings', { exact: true }).count(), 0);
  assert.equal(await lifecycleRow.getByText('Reactivate', { exact: true }).count(), 1);
  assert.equal((await listChartOfAccounts(CLIENT)).find((row) => row.chartOfAccounts === 'D001')?.isActive, false);

  await assert.rejects(upsertGlAccount({
    client: CLIENT,
    chartOfAccounts: 'D001',
    accountNumber: '4000',
    name: 'Account attempted while deactivated',
    accountType: 'EXPENSE',
    isBalanceSheet: false,
    isOpenItemManaged: false,
    requiresCostObject: false,
    isTaxRelevant: false,
    changedBy: 'browser.admin',
  }), /Active Chart of Accounts D001 is not defined/);

  await defineCompanyCode({
    client: CLIENT,
    changedBy: 'browser.admin',
    companyCode: '2055',
    name: 'SCR-026 deactivated assignment fixture',
    country: 'KW',
    currency: 'KWD',
  });
  await assert.rejects(assignCompanyCodeCoa({
    client: CLIENT,
    changedBy: 'browser.admin',
    companyCode: '2055',
    chartOfAccounts: 'D001',
  }), /is not defined in this tenant/);

  await assert.rejects(saveChartOfAccounts({
    client: CLIENT,
    changedBy: 'browser.admin',
    mode: 'CHANGE',
    expectedVersion: 1,
    chartOfAccounts: 'D001',
    name: 'Changed while deactivated',
    language: 'EN',
    accountNumberLength: 6,
    groupChart: '',
    costElementIntegration: 'AUTOMATIC',
    isBlocked: false,
    reason: 'SCR-026 forged edit while deactivated',
  }), /cannot be changed/i);

  await page.goto(`${BASE}/config/company-codes`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Company codes', exact: true }).waitFor();
  const choicesAfterDeactivation = await page.locator('[name="chartOfAccounts"] option').evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value),
  );
  assert.ok(choicesAfterDeactivation.includes('CA01'));
  assert.equal(choicesAfterDeactivation.includes('D001'), false, 'Deactivated chart is excluded from Company Code segment F4.');

  await page.goto(route, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  lifecycleRow = chartList.locator('tbody tr').filter({ hasText: 'D001' });
  await lifecycleRow.getByText('Reactivate', { exact: true }).click();
  lifecycleDialog = page.getByRole('dialog', { name: 'Reactivate D001' });
  await lifecycleDialog.waitFor();
  await lifecycleDialog.locator('[name="reason"]').fill('SCR-026 browser recommission');
  await lifecycleDialog.getByRole('button', { name: 'Reactivate Chart of Accounts', exact: true }).click();
  await lifecycleRow.getByRole('status').getByText(
    'Chart of Accounts D001 reactivated and change history recorded.',
    { exact: true },
  ).waitFor();

  await upsertGlAccount({
    client: CLIENT,
    chartOfAccounts: 'D001',
    accountNumber: '4000',
    name: 'Account created after reactivation',
    accountType: 'EXPENSE',
    isBalanceSheet: false,
    isOpenItemManaged: false,
    requiresCostObject: false,
    isTaxRelevant: false,
    changedBy: 'browser.admin',
  });

  const lifecycleHistory = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'chart_of_accounts', 'D001'));
  assert.equal(lifecycleHistory.length, 3);
  const deactivation = lifecycleHistory.find((entry) => entry.items.some((item) => item.fieldName === 'isActive' && item.newValue === 'false'));
  const reactivation = lifecycleHistory.find((entry) => entry.items.some((item) => item.fieldName === 'isActive' && item.newValue === 'true'));
  assert.equal(deactivation?.reason, 'SCR-026 browser decommission');
  assert.equal(reactivation?.reason, 'SCR-026 browser recommission');
  assert.deepEqual(deactivation?.items.map((item) => item.fieldName), ['isActive']);
  assert.equal(deactivation?.items[0]?.isSecurityRelevant, 'true');
  console.log('  ✓ deactivate/reactivate need an audited reason, retain records, and gate new use');

  // ── Group CoA lifecycle: references are retained and never strand a chart ────────
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  let groupRow = groupList.locator('tbody tr').filter({ hasText: 'GR01' });
  await groupRow.waitFor();
  assert.match(await groupRow.innerText(), /1 operational charts reference this Group CoA/i);

  await groupRow.getByText('Deactivate', { exact: true }).click();
  let groupLifecycleDialog = page.getByRole('dialog', { name: 'Deactivate GR01' });
  await groupLifecycleDialog.waitFor();
  await groupLifecycleDialog.locator('[name="reason"]').fill('SCR-026 browser retire Group CoA');
  await groupLifecycleDialog.getByRole('button', { name: 'Deactivate Group CoA', exact: true }).click();
  await groupRow.getByRole('status').getByText(
    'Group CoA GR01 deactivated and change history recorded.',
    { exact: true },
  ).waitFor();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  // Removed from F4, but the existing reference on B001 is retained and still editable.
  assert.equal(await groupF4.isDisabled(), true, 'Deactivated Group CoA entries are removed from the F4 list.');
  const b001Row = chartList.locator('tbody tr').filter({ hasText: 'B001' });
  assert.match(await b001Row.innerText(), /GR01/);
  await b001Row.getByText('Change settings', { exact: true }).click();
  const b001Dialog = page.getByRole('dialog', { name: 'Change Chart of Accounts B001' });
  await b001Dialog.waitFor();
  assert.equal(await b001Dialog.locator('[name="groupChart"]').inputValue(), 'GR01');
  await b001Dialog.locator('[name="name"]').fill('International Chart of Accounts (retained Group CoA)');
  await b001Dialog.locator('[name="reason"]').fill('SCR-026 unrelated edit with a deactivated Group CoA reference');
  await b001Dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await b001Dialog.getByRole('status').getByText(
    'Chart of Accounts B001 saved and change history recorded.',
    { exact: true },
  ).waitFor();
  await b001Dialog.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(
    (await listChartOfAccounts(CLIENT)).find((row) => row.chartOfAccounts === 'B001')?.groupChart,
    'GR01',
    'An unchanged Group CoA reference survives deactivation of the registry entry.',
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  groupRow = groupList.locator('tbody tr').filter({ hasText: 'GR01' });
  await groupRow.getByText('Reactivate', { exact: true }).click();
  groupLifecycleDialog = page.getByRole('dialog', { name: 'Reactivate GR01' });
  await groupLifecycleDialog.waitFor();
  await groupLifecycleDialog.locator('[name="reason"]').fill('SCR-026 browser restore Group CoA');
  await groupLifecycleDialog.getByRole('button', { name: 'Reactivate Group CoA', exact: true }).click();
  await groupRow.getByRole('status').getByText(
    'Group CoA GR01 reactivated and change history recorded.',
    { exact: true },
  ).waitFor();
  assert.equal(await groupF4.isDisabled(), false, 'A reactivated Group CoA is offered by F4 again.');

  const groupHistory = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'group_chart_of_accounts', 'GR01'));
  assert.equal(groupHistory.length, 3);
  assert.ok(groupHistory.some((entry) => entry.changeType === 'CREATE'
    && entry.items.some((item) => item.fieldName === 'groupChartOfAccounts' && item.newValue === 'GR01')));
  assert.equal(
    groupHistory.find((entry) => entry.items.some((item) => item.fieldName === 'isActive' && item.newValue === 'false'))?.reason,
    'SCR-026 browser retire Group CoA',
  );
  assert.equal(
    groupHistory.find((entry) => entry.items.some((item) => item.fieldName === 'isActive' && item.newValue === 'true'))?.reason,
    'SCR-026 browser restore Group CoA',
  );
  assert.deepEqual(
    (await listGroupChartsOfAccounts(CLIENT)).map((row) => [row.groupChartOfAccounts, row.isActive, row.referencedBy]),
    [['GR01', true, 1]],
  );
  console.log('  ✓ Group CoA lifecycle: F4 exclusion, retained references and audited reactivation');
}
