import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import { assignCompanyCodeCoa } from '../../src/modules/foundation/company-code-coa-assignment';
import { defineCompanyCode } from '../../src/modules/foundation/company-code-definition';
import {
  chartOfAccountsHasAccountsOrTransactions,
  listChartOfAccounts,
} from '../../src/modules/foundation/chart-of-accounts-maintenance';
import { upsertGlAccount } from '../../src/modules/foundation/services';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

function scope(ctx: Context) {
  return { page: ctx.page, BASE: ctx.base, CLIENT: ctx.target.client };
}

/** SCR-026 / OB13 browser acceptance: fields, F4, history, length lock and block behavior. */
export async function chartOfAccountsDefinition(ctx: Context) {
  const { page, BASE, CLIENT } = scope(ctx);
  const route = `${BASE}/config/chart-of-accounts`;
  console.log('SCR-026 OB13: verify tenant-local Chart of Accounts definition, F4, audit, length lock and block gates');

  await page.goto(route, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Chart of Accounts', exact: true }).waitFor();
  const createPanel = page.locator('section[aria-labelledby="ob13-create-title"]');
  await createPanel.waitFor();

  assert.equal(await createPanel.locator('[name="language"]').inputValue(), 'EN');
  assert.equal(await createPanel.locator('[name="accountNumberLength"]').inputValue(), '10');
  assert.equal(await createPanel.locator('[name="costElementIntegration"]').inputValue(), 'AUTOMATIC');
  assert.equal(await createPanel.locator('[name="isBlocked"]').isChecked(), false);

  const standardRow = page.locator('tbody tr').filter({ hasText: 'CA01' });
  await standardRow.waitFor();
  assert.match(await standardRow.innerText(), /10[\s\S]*Locked[\s\S]*74 G\/L accounts/i);
  const baseline = await listChartOfAccounts(CLIENT);
  assert.equal(baseline.find((row) => row.chartOfAccounts === 'CA01')?.accountNumberLengthLocked, true);

  // Both supported value-help flows are tenant-scoped; the only supported locale is English.
  await createPanel.getByRole('button', { name: /Open Language Key lookup/ }).click();
  const languageDialog = page.getByRole('dialog').filter({ hasText: 'Language Key lookup' });
  await languageDialog.getByRole('button').filter({ hasText: 'English' }).click();
  await createPanel.getByRole('button', { name: /Open Group Chart of Accounts lookup/ }).click();
  const groupDialog = page.getByRole('dialog').filter({ hasText: 'Group Chart of Accounts lookup' });
  await groupDialog.getByRole('button').filter({ hasText: 'CA01' }).click();

  await createPanel.locator('[name="chartOfAccounts"]').fill('B001');
  await createPanel.locator('[name="name"]').fill('International Chart of Accounts');
  await createPanel.locator('[name="accountNumberLength"]').fill('8');
  await createPanel.locator('[name="costElementIntegration"]').selectOption('MANUAL');
  assert.equal(await createPanel.locator('[name="groupChart"]').inputValue(), 'CA01');
  await createPanel.locator('[name="reason"]').fill('SCR-026 browser create');
  await createPanel.getByRole('button', { name: 'Create Chart of Accounts', exact: true }).click();
  await page.getByRole('status').getByText(
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
    groupChart: 'CA01',
    costElementIntegration: 'MANUAL',
    isBlocked: false,
    accountNumberLengthLocked: false,
  });
  let history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'chart_of_accounts', 'B001'));
  assert.equal(history.length, 1);
  assert.ok(history[0]?.items.some((item) => item.fieldName === 'groupChart' && item.newValue === 'CA01'));
  assert.ok(history[0]?.items.some((item) => item.fieldName === 'costElementIntegration' && item.newValue === 'MANUAL'));
  console.log('  ✓ OB13 create defaults, four-character key, Language/Group CoA F4 and CREATE history');

  // An unused chart may change its configured account-number limit.
  let chartRow = page.locator('tbody tr').filter({ hasText: 'B001' });
  await chartRow.locator('summary').click();
  let changeDialog = page.getByRole('dialog', { name: 'Change Chart of Accounts B001' });
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
  chartRow = page.locator('tbody tr').filter({ hasText: 'B001' });
  await chartRow.locator('summary').click();
  changeDialog = page.getByRole('dialog', { name: 'Change Chart of Accounts B001' });
  assert.notEqual(await changeDialog.locator('[name="accountNumberLength"]').getAttribute('readonly'), null);
  await changeDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await assert.rejects(
    () => import('../../src/modules/foundation/chart-of-accounts-maintenance').then(({ saveChartOfAccounts }) => saveChartOfAccounts({
      client: CLIENT,
      changedBy: 'browser.admin',
      mode: 'CHANGE',
      expectedVersion: 2,
      chartOfAccounts: 'B001',
      name: 'International Chart of Accounts',
      language: 'EN',
      accountNumberLength: 6,
      groupChart: 'CA01',
      costElementIntegration: 'NONE',
      isBlocked: false,
      reason: 'Forged length change after account creation',
    })),
    /length.*locked/i,
  );

  // A single block flag gates both new G/L master creation and Company Code assignment.
  await page.reload({ waitUntil: 'domcontentloaded' });
  chartRow = page.locator('tbody tr').filter({ hasText: 'B001' });
  await chartRow.locator('summary').click();
  changeDialog = page.getByRole('dialog', { name: 'Change Chart of Accounts B001' });
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
}
