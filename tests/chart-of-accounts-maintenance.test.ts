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
  listGroupChartsOfAccounts,
  saveChartOfAccounts,
  saveGroupChartOfAccounts,
  setChartOfAccountsActive,
  setGroupChartOfAccountsActive,
  type ChartOfAccountsMaintenanceInput,
  type GroupChartOfAccountsMaintenanceInput,
} from '@/modules/foundation/chart-of-accounts-maintenance';
import { STANDARD_ACCOUNT_GROUP } from '@/modules/foundation/standard-config';
import { createTenant, destroyTenant, ensureAccountGroup, type TestTenant } from './helpers';

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

function groupInput(
  code: string,
  overrides: Partial<GroupChartOfAccountsMaintenanceInput> = {},
): GroupChartOfAccountsMaintenanceInput {
  const fixture = currentTenant();
  return {
    client: fixture.client,
    changedBy: TEST_ACTOR,
    mode: 'CREATE',
    expectedVersion: 0,
    groupChartOfAccounts: code,
    name: `SCR-026 Group CoA ${code}`,
    language: 'EN',
    reason: 'SCR-026 automated registry test',
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
    // Group CoA F4 reads the separate registry: a fresh tenant has no entries, and an
    // operational chart such as CA01 is never offered as a Group CoA.
    expect(choices.groupCharts).toEqual([]);
  });

  it('creates a tenant-unique four-character chart, validates Group CoA, and records field-level history', async () => {
    const fixture = currentTenant();
    // Group CoA resolves to the registry, so the referenced key is created there first.
    await saveGroupChartOfAccounts(groupInput('GR01', { name: 'Cairn Group Consolidation' }));
    const created = await saveChartOfAccounts(input('A001', {
      name: 'International Chart of Accounts',
      groupChart: 'GR01',
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
      expect.objectContaining({ fieldName: 'groupChart', newValue: 'GR01' }),
      expect.objectContaining({ fieldName: 'costElementIntegration', newValue: 'MANUAL' }),
    ]));

    await expect(saveChartOfAccounts(input('B001', { groupChart: 'ZZZZ' })))
      .rejects.toThrow(/Active Group CoA ZZZZ is not defined in this tenant's Group Chart of Accounts registry/);
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
    await ensureAccountGroup(fixture, 'L001');
    await expect(upsertGlAccount({
      client: fixture.client,
      chartOfAccounts: 'L001',
      accountNumber: '12345',
      name: 'Too long for chart',
      accountType: 'EXPENSE',
      accountGroup: STANDARD_ACCOUNT_GROUP,
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
      accountGroup: STANDARD_ACCOUNT_GROUP,
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
    // No Account Group on purpose: a blocked chart refuses a new account before the
    // group is ever consulted, which is the order this assertion pins.
    await saveChartOfAccounts(input('B001', { isBlocked: true }));
    await expect(upsertGlAccount({
      client: fixture.client,
      chartOfAccounts: 'B001',
      accountNumber: '7000',
      name: 'Blocked chart account',
      accountType: 'EXPENSE',
      accountGroup: STANDARD_ACCOUNT_GROUP,
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

  it('maintains the Group CoA registry separately and reserves four-character keys tenant-wide', async () => {
    const fixture = currentTenant();
    const created = await saveGroupChartOfAccounts(groupInput('GR02', { name: 'Regional Consolidation' }));
    expect(created).toMatchObject({
      created: true, changed: true, version: 1, groupChartOfAccounts: 'GR02', isActive: true,
    });

    // A key may be an operational Chart of Accounts or a Group CoA, never both.
    await expect(saveGroupChartOfAccounts(groupInput('A001')))
      .rejects.toThrow(/reserved as an operational Chart of Accounts/);
    await expect(saveChartOfAccounts(input('GR02')))
      .rejects.toThrow(/reserved as a Group CoA/);

    const changed = await saveGroupChartOfAccounts(groupInput('GR02', {
      mode: 'CHANGE', expectedVersion: 1, name: 'Regional Consolidation Group',
    }));
    expect(changed).toMatchObject({ created: false, changed: true, version: 2, name: 'Regional Consolidation Group' });

    const unchanged = await saveGroupChartOfAccounts(groupInput('GR02', {
      mode: 'CHANGE', expectedVersion: 2, name: 'Regional Consolidation Group',
    }));
    expect(unchanged).toMatchObject({ changed: false, version: 2 });

    await expect(saveGroupChartOfAccounts(groupInput('GR02', {
      mode: 'CHANGE', expectedVersion: 1, name: 'Stale registry edit',
    }))).rejects.toBeInstanceOf(ChartOfAccountsMaintenanceError);

    const history = await withTenant(fixture.client, (tx) =>
      changeHistory(tx, fixture.client, 'group_chart_of_accounts', 'GR02'),
    );
    expect(history).toHaveLength(2);
    const rename = history.find((entry) => entry.changeType === 'CHANGE');
    expect(rename?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fieldName: 'name',
        oldValue: 'Regional Consolidation',
        newValue: 'Regional Consolidation Group',
      }),
    ]));

    const entries = await listGroupChartsOfAccounts(fixture.client);
    expect(entries.find((row) => row.groupChartOfAccounts === 'GR01')).toMatchObject({ referencedBy: 1, isActive: true });
    expect(entries.find((row) => row.groupChartOfAccounts === 'GR02')).toMatchObject({ referencedBy: 0, isActive: true });
  });

  it('offers only active registry entries in Group CoA F4 and never strands an existing reference', async () => {
    const fixture = currentTenant();
    const choices = await chartOfAccountsF4Choices(fixture.client);
    expect(choices.groupCharts.map((row) => row.code)).toEqual(expect.arrayContaining(['GR01', 'GR02']));

    await setGroupChartOfAccountsActive({
      client: fixture.client,
      changedBy: TEST_ACTOR,
      groupChartOfAccounts: 'GR02',
      isActive: false,
      expectedVersion: 2,
      reason: 'SCR-026 retire the unused Group CoA',
    });
    const afterDeactivation = await chartOfAccountsF4Choices(fixture.client);
    expect(afterDeactivation.groupCharts.map((row) => row.code)).not.toContain('GR02');

    // A new reference to a deactivated entry is refused.
    await expect(saveChartOfAccounts(input('C001', { groupChart: 'GR02' })))
      .rejects.toThrow(/Active Group CoA GR02 is not defined/);

    // Deactivating the entry an existing chart already uses must not strand that chart:
    // an unchanged reference is not re-validated, so unrelated edits still save.
    await setGroupChartOfAccountsActive({
      client: fixture.client,
      changedBy: TEST_ACTOR,
      groupChartOfAccounts: 'GR01',
      isActive: false,
      expectedVersion: 1,
      reason: 'SCR-026 deactivate a referenced Group CoA',
    });
    const retained = await saveChartOfAccounts(input('A001', {
      mode: 'CHANGE',
      expectedVersion: 1,
      groupChart: 'GR01',
      name: 'International Chart of Accounts (renamed)',
    }));
    expect(retained).toMatchObject({ changed: true, groupChart: 'GR01', version: 2 });

    const entries = await listGroupChartsOfAccounts(fixture.client);
    expect(entries.find((row) => row.groupChartOfAccounts === 'GR01'))
      .toMatchObject({ isActive: false, referencedBy: 1 });

    await setGroupChartOfAccountsActive({
      client: fixture.client,
      changedBy: TEST_ACTOR,
      groupChartOfAccounts: 'GR01',
      isActive: true,
      expectedVersion: 2,
      reason: 'SCR-026 reactivate the referenced Group CoA',
    });
    expect((await listGroupChartsOfAccounts(fixture.client))
      .find((row) => row.groupChartOfAccounts === 'GR01')).toMatchObject({ isActive: true, referencedBy: 1 });
  });

  it('deactivates and reactivates a chart only with a reason, retaining accounts, assignments and history', async () => {
    const fixture = currentTenant();
    await saveChartOfAccounts(input('D001', { name: 'Lifecycle fixture chart' }));
    await ensureAccountGroup(fixture, 'D001');
    await upsertGlAccount({
      client: fixture.client,
      chartOfAccounts: 'D001',
      accountNumber: '4000',
      name: 'Existing account before deactivation',
      accountType: 'EXPENSE',
      accountGroup: STANDARD_ACCOUNT_GROUP,
      isOpenItemManaged: false,
      requiresCostObject: false,
      isTaxRelevant: false,
      changedBy: TEST_ACTOR,
    });
    await defineCompanyCode({
      client: fixture.client,
      changedBy: TEST_ACTOR,
      companyCode: '2077',
      name: 'SCR-026 lifecycle assignment fixture',
      country: 'KW',
      currency: 'KWD',
    });
    await assignCompanyCodeCoa({
      client: fixture.client,
      changedBy: TEST_ACTOR,
      companyCode: '2077',
      chartOfAccounts: 'D001',
    });

    // A lifecycle change without an explanation is not an audit record.
    await expect(setChartOfAccountsActive({
      client: fixture.client,
      changedBy: TEST_ACTOR,
      chartOfAccounts: 'D001',
      isActive: false,
      expectedVersion: 1,
      reason: '   ',
    })).rejects.toThrow(/reason is required/i);

    const deactivated = await setChartOfAccountsActive({
      client: fixture.client,
      changedBy: TEST_ACTOR,
      chartOfAccounts: 'D001',
      isActive: false,
      expectedVersion: 1,
      reason: 'SCR-026 decommission the fixture chart',
    });
    expect(deactivated).toMatchObject({ changed: true, isActive: false, version: 2 });

    // Existing records stay readable and keep their reference; only new use stops.
    const rows = await listChartOfAccounts(fixture.client);
    expect(rows.find((row) => row.chartOfAccounts === 'D001'))
      .toMatchObject({ isActive: false, glAccountCount: 1, accountNumberLengthLocked: true });
    const [assigned] = await withTenant(fixture.client, (tx) => tx.select().from(companyCode).where(
      and(eq(companyCode.client, fixture.client), eq(companyCode.companyCode, '2077')),
    ));
    expect(assigned?.chartOfAccounts).toBe('D001');

    await expect(upsertGlAccount({
      client: fixture.client,
      chartOfAccounts: 'D001',
      accountNumber: '4001',
      name: 'Account attempted after deactivation',
      accountType: 'EXPENSE',
      accountGroup: STANDARD_ACCOUNT_GROUP,
      isOpenItemManaged: false,
      requiresCostObject: false,
      isTaxRelevant: false,
      changedBy: TEST_ACTOR,
    })).rejects.toThrow(/Active Chart of Accounts D001 is not defined/);

    await defineCompanyCode({
      client: fixture.client,
      changedBy: TEST_ACTOR,
      companyCode: '2066',
      name: 'SCR-026 deactivated assignment attempt',
      country: 'KW',
      currency: 'KWD',
    });
    await expect(assignCompanyCodeCoa({
      client: fixture.client,
      changedBy: TEST_ACTOR,
      companyCode: '2066',
      chartOfAccounts: 'D001',
    })).rejects.toBeInstanceOf(CompanyCodeCoaAssignmentError);

    // A deactivated chart cannot be changed until it is reactivated.
    await expect(saveChartOfAccounts(input('D001', {
      mode: 'CHANGE',
      expectedVersion: 2,
      groupChart: '',
      name: 'Changed while deactivated',
    }))).rejects.toThrow(/cannot be changed/i);

    // Repeating the current lifecycle state writes nothing at all.
    const repeated = await setChartOfAccountsActive({
      client: fixture.client,
      changedBy: TEST_ACTOR,
      chartOfAccounts: 'D001',
      isActive: false,
      expectedVersion: 2,
      reason: 'SCR-026 repeat deactivation',
    });
    expect(repeated).toMatchObject({ changed: false, isActive: false, version: 2 });

    const reactivated = await setChartOfAccountsActive({
      client: fixture.client,
      changedBy: TEST_ACTOR,
      chartOfAccounts: 'D001',
      isActive: true,
      expectedVersion: 2,
      reason: 'SCR-026 bring the fixture chart back',
    });
    expect(reactivated).toMatchObject({ changed: true, isActive: true, version: 3 });

    await upsertGlAccount({
      client: fixture.client,
      chartOfAccounts: 'D001',
      accountNumber: '4001',
      name: 'Account created after reactivation',
      accountType: 'EXPENSE',
      accountGroup: STANDARD_ACCOUNT_GROUP,
      isOpenItemManaged: false,
      requiresCostObject: false,
      isTaxRelevant: false,
      changedBy: TEST_ACTOR,
    });

    const history = await withTenant(fixture.client, (tx) =>
      changeHistory(tx, fixture.client, 'chart_of_accounts', 'D001'),
    );
    expect(history).toHaveLength(3);
    const off = history.find((entry) => entry.items.some((item) => item.fieldName === 'isActive' && item.newValue === 'false'));
    const on = history.find((entry) => entry.items.some((item) => item.fieldName === 'isActive' && item.newValue === 'true'));
    expect(off?.reason).toBe('SCR-026 decommission the fixture chart');
    expect(on?.reason).toBe('SCR-026 bring the fixture chart back');
    expect(off?.items).toEqual([expect.objectContaining({
      fieldName: 'isActive',
      oldValue: 'true',
      newValue: 'false',
      isSecurityRelevant: 'true',
    })]);
    // The repeat no-op left no document behind.
    expect(history.filter((entry) => entry.reason === 'SCR-026 repeat deactivation')).toHaveLength(0);
  });

});
