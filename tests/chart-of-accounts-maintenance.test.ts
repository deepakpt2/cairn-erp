import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTenant, closeDb } from '@/platform/db/client';
import { changeHistory } from '@/platform/change';
import { indexDocument } from '@/platform/document';
import { configActivityStatus } from '@/platform/tables/registry';
import { chartOfAccounts, companyCode } from '@/modules/foundation/schema';
import { upsertGlAccount } from '@/modules/foundation/services';
import { assignCompanyCodeCoa, CompanyCodeCoaAssignmentError } from '@/modules/foundation/company-code-coa-assignment';
import { defineCompanyCode } from '@/modules/foundation/company-code-definition';
import {
  chartOfAccountsF4Choices,
  chartOfAccountsHasAccountsOrTransactions,
  ChartOfAccountsMaintenanceError,
  listChartOfAccounts,
  saveChartOfAccounts,
  type ChartOfAccountsMaintenanceInput,
} from '@/modules/foundation/chart-of-accounts-maintenance';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const TEST_ACTOR = 'SCR026_TEST';
const DEFINE_ACTIVITY = 'CFG.ORG.COMPANYCODE.DEFINE';
const COA_ACTIVITY = 'CFG.FIN.COA.DEFINE';
const ASSIGN_ACTIVITY = 'CFG.ORG.COMPANYCODE.ASSIGN_COA';
let tenant: TestTenant | undefined;

function currentTenant(): TestTenant {
  if (!tenant) throw new Error('SCR-026 tenant fixture was not initialized.');
  return tenant;
}

function input(
  chart: string,
  overrides: Partial<ChartOfAccountsMaintenanceInput> = {},
): ChartOfAccountsMaintenanceInput {
  const fixture = currentTenant();
  return {
    client: fixture.client,
    changedBy: TEST_ACTOR,
    mode: 'CREATE',
    expectedVersion: 0,
    chartOfAccounts: chart,
    name: `SCR-026 Chart ${chart}`,
    language: 'EN',
    accountNumberLength: 10,
    groupChart: '',
    costElementIntegration: 'AUTOMATIC',
    isBlocked: false,
    reason: 'SCR-026 automated maintenance test',
    ...overrides,
  };
}

async function setPrerequisites() {
  const fixture = currentTenant();
  const now = new Date();
  await withTenant(fixture.client, (tx) => tx.insert(configActivityStatus).values([
    {
      client: fixture.client,
      activityCode: DEFINE_ACTIVITY,
      status: 'COMPLETED',
      completedAt: now,
      completedBy: TEST_ACTOR,
      createdBy: TEST_ACTOR,
    },
    {
      client: fixture.client,
      activityCode: COA_ACTIVITY,
      status: 'COMPLETED',
      completedAt: now,
      completedBy: TEST_ACTOR,
      createdBy: TEST_ACTOR,
    },
    {
      client: fixture.client,
      activityCode: ASSIGN_ACTIVITY,
      status: 'NOT_STARTED',
      createdBy: TEST_ACTOR,
    },
  ]).onConflictDoNothing());
}

beforeAll(async () => {
  tenant = await createTenant('scr026-chart-of-accounts');
  await setPrerequisites();
});

afterAll(async () => {
  try {
    if (tenant) await destroyTenant(tenant.client);
  } finally {
    await closeDb();
  }
});

describe('SCR-026 / OB13 Chart of Accounts definition', () => {
  it('migrated/default standard chart uses CA01 and the new-definition defaults', async () => {
    const fixture = currentTenant();
    const rows = await listChartOfAccounts(fixture.client);
    expect(rows.find((row) => row.chartOfAccounts === 'CA01')).toMatchObject({
      accountNumberLength: 10,
      language: 'EN',
      costElementIntegration: 'AUTOMATIC',
      isBlocked: false,
      accountNumberLengthLocked: true,
    });

    const choices = await chartOfAccountsF4Choices(fixture.client);
    expect(choices.languages).toEqual([{ code: 'EN', name: 'English' }]);
    expect(choices.groupCharts).toContainEqual(expect.objectContaining({ code: 'CA01' }));
  });

  it('creates a tenant-unique four-character chart, validates Group CoA, and records field-level history', async () => {
    const fixture = currentTenant();
    const created = await saveChartOfAccounts(input('A001', {
      name: 'International Chart of Accounts',
      groupChart: 'CA01',
      costElementIntegration: 'MANUAL',
    }));
    expect(created).toMatchObject({ created: true, changed: true, version: 1, chartOfAccounts: 'A001' });

    const history = await withTenant(fixture.client, (tx) =>
      changeHistory(tx, fixture.client, 'chart_of_accounts', 'A001'),
    );
    expect(history).toHaveLength(1);
    expect(history[0]?.changeType).toBe('CREATE');
    expect(history[0]?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldName: 'chartOfAccounts', newValue: 'A001' }),
      expect.objectContaining({ fieldName: 'groupChart', newValue: 'CA01' }),
      expect.objectContaining({ fieldName: 'costElementIntegration', newValue: 'MANUAL' }),
    ]));

    await expect(saveChartOfAccounts(input('B001', { groupChart: 'ZZZZ' })))
      .rejects.toThrow(/Active Group CoA ZZZZ is not defined/);
    await expect(saveChartOfAccounts(input('S001', { groupChart: 'S001' })))
      .rejects.toThrow(/cannot be its own Group CoA/);
    await expect(saveChartOfAccounts(input('TOOL', { name: 'x'.repeat(51) })))
      .rejects.toBeInstanceOf(ChartOfAccountsMaintenanceError);
  });

  it('treats duplicate create as a no-op and rejects stale change versions', async () => {
    const fixture = currentTenant();
    const duplicate = await saveChartOfAccounts(input('A001', { name: 'Ignored duplicate create' }));
    expect(duplicate).toMatchObject({ created: false, changed: false, chartOfAccounts: 'A001', version: 1 });

    await expect(saveChartOfAccounts(input('A001', {
      ...input('A001'),
      mode: 'CHANGE',
      expectedVersion: 0,
      name: 'Stale edit',
    }))).rejects.toBeInstanceOf(ChartOfAccountsMaintenanceError);
    const [row] = await withTenant(fixture.client, (tx) => tx.select().from(chartOfAccounts).where(
      and(eq(chartOfAccounts.client, fixture.client), eq(chartOfAccounts.chartOfAccounts, 'A001')),
    ));
    expect(row?.name).toBe('International Chart of Accounts');
  });

  it('locks account-number length after either a G/L account or transaction data exists', async () => {
    const fixture = currentTenant();
    await saveChartOfAccounts(input('L001', { accountNumberLength: 4 }));
    await expect(upsertGlAccount({
      client: fixture.client,
      chartOfAccounts: 'L001',
      accountNumber: '12345',
      name: 'Too long for chart',
      accountType: 'EXPENSE',
      isBalanceSheet: false,
      isOpenItemManaged: false,
      requiresCostObject: false,
      isTaxRelevant: false,
      changedBy: TEST_ACTOR,
    })).rejects.toThrow(/exceeds the 4-character limit/);

    await upsertGlAccount({
      client: fixture.client,
      chartOfAccounts: 'L001',
      accountNumber: '1234',
      name: 'Length boundary account',
      accountType: 'EXPENSE',
      isBalanceSheet: false,
      isOpenItemManaged: false,
      requiresCostObject: false,
      isTaxRelevant: false,
      changedBy: TEST_ACTOR,
    });
    expect(await chartOfAccountsHasAccountsOrTransactions(fixture.client, 'L001')).toBe(true);
    await expect(saveChartOfAccounts(input('L001', {
      mode: 'CHANGE', expectedVersion: 1, accountNumberLength: 5,
    }))).rejects.toThrow(/length.*locked/i);

    await saveChartOfAccounts(input('T001', { accountNumberLength: 5 }));
    await withTenant(fixture.client, async (tx) => {
      await tx.insert(companyCode).values({
        client: fixture.client,
        companyCode: '2099',
        name: 'SCR-026 transaction-only fixture',
        chartOfAccounts: 'T001',
        fiscalYearVariant: null,
        postingPeriodVariant: null,
        currency: 'KWD',
        country: 'KW',
        createdBy: TEST_ACTOR,
      });
      await indexDocument(tx, {
        client: fixture.client,
        document: { documentClass: 'scr026_test', documentKey: 'length-lock-1' },
        displayNumber: 'SCR026-LOCK-1',
        companyCode: '2099',
        summary: 'transaction-only account-length lock fixture',
      });
    });
    expect(await chartOfAccountsHasAccountsOrTransactions(fixture.client, 'T001')).toBe(true);
    const txCharts = await listChartOfAccounts(fixture.client);
    expect(txCharts.find((row) => row.chartOfAccounts === 'T001')).toMatchObject({
      glAccountCount: 0,
      hasTransactions: true,
      accountNumberLengthLocked: true,
    });
    await expect(saveChartOfAccounts(input('T001', {
      mode: 'CHANGE', expectedVersion: 1, accountNumberLength: 6,
    }))).rejects.toThrow(/length.*locked/i);
  });

  it('blocks new G/L accounts and Company Code CoA assignment without affecting existing records', async () => {
    const fixture = currentTenant();
    await saveChartOfAccounts(input('B001', { isBlocked: true }));
    await expect(upsertGlAccount({
      client: fixture.client,
      chartOfAccounts: 'B001',
      accountNumber: '7000',
      name: 'Blocked chart account',
      accountType: 'EXPENSE',
      isBalanceSheet: false,
      isOpenItemManaged: false,
      requiresCostObject: false,
      isTaxRelevant: false,
      changedBy: TEST_ACTOR,
    })).rejects.toThrow(/new G\/L accounts cannot be created/);

    await defineCompanyCode({
      client: fixture.client,
      changedBy: TEST_ACTOR,
      companyCode: '2088',
      name: 'SCR-026 blocked assignment fixture',
      country: 'KW',
      currency: 'KWD',
    });
    await expect(assignCompanyCodeCoa({
      client: fixture.client,
      changedBy: TEST_ACTOR,
      companyCode: '2088',
      chartOfAccounts: 'B001',
    })).rejects.toBeInstanceOf(CompanyCodeCoaAssignmentError);

    const rows = await listChartOfAccounts(fixture.client);
    expect(rows.find((row) => row.chartOfAccounts === 'B001')).toMatchObject({ isBlocked: true });
  });
});
