/**
 * SCR-028 / FS00 stage 3 — the Account Group registry, the field status matrix and the
 * G/L account lifecycle behind them.
 *
 * One tenant, one ad-hoc chart with a four-character account number so ranges stay short
 * enough to read, and the standard package's `CA01`/`GENL` alongside it: the seeded group
 * spans the whole number width, which makes it a ready-made overlap for a test that needs
 * one without inventing a fixture.
 *
 * Versions are read rather than counted. Every registry write bumps the group's version and
 * a matrix write bumps the same one, so a test that assumed "version 3 by now" would break
 * the moment another test was inserted above it — and a broken test teaches nobody whether
 * the product is right.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, withTenant } from '@/platform/db/client';
import { changeHistory } from '@/platform/change';
import { configActivityStatus } from '@/platform/tables/registry';
import { businessPartner, bpRole } from '@/modules/foundation/business-partner-schema';
import { customerCompany } from '@/modules/foundation/customer-company-schema';
import {
  saveChartOfAccounts,
  listChartOfAccounts,
  type ChartOfAccountsMaintenanceInput,
} from '@/modules/foundation/chart-of-accounts-maintenance';
import {
  ConfigError,
  deleteGlAccount,
  glAccountAuditVersion,
  listGlAccounts,
  setGlAccountBlocks,
  upsertGlAccount,
  type GlAccountInput,
} from '@/modules/foundation/services';
import { journalEntryLine } from '@/modules/finance/schema';
import { glAccountGroupFieldStatus } from '@/modules/finance/gl-account-group-schema';
import {
  accountGroupChoices,
  accountGroupFieldStatusMatrices,
  listAccountGroups,
  saveAccountGroup,
  saveAccountGroupFieldStatus,
  setAccountGroupActive,
  type AccountGroupFieldStatusInput,
  type AccountGroupMaintenanceInput,
} from '@/modules/finance/gl-account-group-maintenance';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const TEST_ACTOR = 'SCR028_STAGE3';
const CHART = 'FS01';
const STANDARD_CHART = 'CA01';
let tenant: TestTenant | undefined;

function fixture(): TestTenant {
  if (!tenant) throw new Error('SCR-028 stage 3 tenant fixture was not initialized.');
  return tenant;
}

function chartInput(
  chart: string,
  overrides: Partial<ChartOfAccountsMaintenanceInput> = {},
): ChartOfAccountsMaintenanceInput {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    mode: 'CREATE',
    expectedVersion: 0,
    chartOfAccounts: chart,
    name: `FS00 stage 3 chart ${chart}`,
    language: 'EN',
    accountNumberLength: 4,
    groupChart: '',
    costElementIntegration: 'NONE',
    isBlocked: false,
    reason: 'SCR-028 automated backend test',
    ...overrides,
  };
}

function groupInput(
  accountGroup: string,
  overrides: Partial<AccountGroupMaintenanceInput> = {},
): AccountGroupMaintenanceInput {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    mode: 'CREATE',
    expectedVersion: 0,
    chartOfAccounts: CHART,
    accountGroup,
    description: `Stage 3 group ${accountGroup}`,
    fromAccountNumber: '1000',
    toAccountNumber: '1999',
    reason: 'SCR-028 automated backend test',
    ...overrides,
  };
}

function accountInput(
  accountNumber: string,
  overrides: Partial<GlAccountInput> = {},
): GlAccountInput {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    chartOfAccounts: CHART,
    accountNumber,
    name: `Stage 3 account ${accountNumber}`,
    accountType: 'EXPENSE',
    accountGroup: 'GENA',
    isOpenItemManaged: false,
    requiresCostObject: false,
    isTaxRelevant: false,
    ...overrides,
  };
}

function matrixInput(
  accountGroup: string,
  statuses: Record<string, string>,
  overrides: Partial<AccountGroupFieldStatusInput> = {},
): AccountGroupFieldStatusInput {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    chartOfAccounts: CHART,
    accountGroup,
    expectedVersion: 0,
    statuses,
    reason: 'SCR-028 automated backend test',
    ...overrides,
  };
}

/** The group's version right now, so a test never has to count the writes before it. */
async function groupVersion(chart: string, accountGroup: string): Promise<number> {
  const rows = await listAccountGroups(fixture().client, { chartOfAccounts: chart });
  const row = rows.find((entry) => entry.accountGroup === accountGroup);
  if (!row) throw new Error(`Account Group ${accountGroup} was not created for ${chart}.`);
  return row.version;
}

async function storedMatrixRows(chart: string, accountGroup: string): Promise<number> {
  const { client } = fixture();
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select()
      .from(glAccountGroupFieldStatus)
      .where(and(
        eq(glAccountGroupFieldStatus.client, client),
        eq(glAccountGroupFieldStatus.chartOfAccounts, chart),
        eq(glAccountGroupFieldStatus.accountGroup, accountGroup),
      ));
    return rows.length;
  });
}

/**
 * The matrix the screen would have rendered from, loaded the way the server action loads
 * it. Passing it matters: the writer takes the matrix from its caller, so a test that
 * omitted it would be testing the baseline while claiming to test the group.
 */
async function matrixFor(accountGroup: string) {
  const matrices = await accountGroupFieldStatusMatrices(fixture().client, CHART);
  return matrices[accountGroup];
}

async function storedAccount(chart: string, accountNumber: string) {
  const { client } = fixture();
  const rows = await listGlAccounts(client, { chartOfAccounts: chart });
  return rows.find((row) => row.accountNumber === accountNumber);
}

async function history(objectClass: string, objectKey: string) {
  const { client } = fixture();
  return withTenant(client, (tx) => changeHistory(tx, client, objectClass, objectKey));
}

async function setChartBlocked(isBlocked: boolean) {
  const { client } = fixture();
  const charts = await listChartOfAccounts(client);
  const chart = charts.find((row) => row.chartOfAccounts === CHART);
  if (!chart) throw new Error(`Chart ${CHART} disappeared from the fixture.`);
  await saveChartOfAccounts(chartInput(CHART, {
    mode: 'CHANGE',
    expectedVersion: chart.version,
    isBlocked,
  }));
}

/**
 * OB13 refuses to define a chart before Company Code definition is complete, and this
 * suite needs a chart of its own with a four-character account number. Marking the
 * prerequisite is the same step the OB13 suite takes; the workbench would have done it by
 * way of defining a Company Code, which the standard package already provides.
 */
async function completeCompanyCodeDefinition() {
  const { client } = fixture();
  await withTenant(client, (tx) => tx.insert(configActivityStatus).values({
    client,
    activityCode: 'CFG.ORG.COMPANYCODE.DEFINE',
    status: 'COMPLETED',
    completedAt: new Date(),
    completedBy: TEST_ACTOR,
    createdBy: TEST_ACTOR,
  }).onConflictDoUpdate({
    target: [configActivityStatus.client, configActivityStatus.activityCode],
    set: { status: 'COMPLETED', completedAt: new Date(), completedBy: TEST_ACTOR },
  }));
}

beforeAll(async () => {
  tenant = await createTenant('scr028-fs00-stage3');
  await completeCompanyCodeDefinition();
  await saveChartOfAccounts(chartInput(CHART));
  // The first group is created through the service under test, so every later test writes
  // against a row that arrived the way a consultant's row arrives.
  await saveAccountGroup(groupInput('GENA'));
});

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
});

describe('Account Group registry', () => {
  it('creates a group at version 1 and records the creation with its reason', async () => {
    const result = await saveAccountGroup(groupInput('GENB', {
      fromAccountNumber: '2000',
      toAccountNumber: '2999',
    }));
    expect(result).toMatchObject({ created: true, changed: true, version: 1, isActive: true });

    const rows = await listAccountGroups(fixture().client, { chartOfAccounts: CHART });
    expect(rows.map((row) => row.accountGroup)).toEqual(['GENA', 'GENB']);
    expect(rows.find((row) => row.accountGroup === 'GENB')).toMatchObject({
      description: 'Stage 3 group GENB',
      fromAccountNumber: '2000',
      toAccountNumber: '2999',
      accountCount: 0,
      fieldStatus: {},
    });

    const entries = await history('gl_account_group', `${CHART}/GENB`);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.changeType).toBe('CREATE');
    expect(entries[0]?.reason).toBe('SCR-028 automated backend test');
    expect(entries[0]?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldName: 'fromAccountNumber', newValue: '2000' }),
      expect.objectContaining({ fieldName: 'toAccountNumber', newValue: '2999' }),
    ]));
  });

  it('offers only active groups of the chart as F4 choices', async () => {
    const choices = await accountGroupChoices(fixture().client, CHART);
    expect(choices).toEqual([
      { code: 'GENA', name: 'Stage 3 group GENA' },
      { code: 'GENB', name: 'Stage 3 group GENB' },
    ]);
  });

  it('refuses a range bound longer than the chart’s account-number length', async () => {
    await expect(saveAccountGroup(groupInput('GENC', {
      fromAccountNumber: '10000',
      toAccountNumber: '20000',
    }))).rejects.toThrow(/longer than the 4-character G\/L account number/);
  });

  it('refuses a range whose lower bound is above its upper bound', async () => {
    await expect(saveAccountGroup(groupInput('GENC', {
      fromAccountNumber: '3000',
      toAccountNumber: '2000',
    }))).rejects.toThrow(/From Account Number 3000 is greater than To Account Number 2000/);
  });

  it('refuses a range that overlaps a sibling group of the same chart', async () => {
    await expect(saveAccountGroup(groupInput('GENC', {
      fromAccountNumber: '1500',
      toAccountNumber: '2500',
    }))).rejects.toThrow(/overlaps Account Group GENA \(1000 to 1999\)/);
  });

  it('refuses a range that overlaps the group the standard package seeded', async () => {
    // GENL spans 0000000000–9999999999, so any range at all inside CA01 overlaps it. The
    // registry partitions a chart's number space rather than leaving two groups to claim
    // the same account.
    await expect(saveAccountGroup(groupInput('GENX', {
      chartOfAccounts: STANDARD_CHART,
      fromAccountNumber: '1000',
      toAccountNumber: '2000',
    }))).rejects.toThrow(/overlaps Account Group GENL/);
  });

  it('refuses a group for a chart the tenant does not have', async () => {
    await expect(saveAccountGroup(groupInput('GENC', { chartOfAccounts: 'ZZZZ' })))
      .rejects.toThrow(/Chart of Accounts ZZZZ is not defined in this tenant/);
  });

  it('refuses a stale version and accepts the version the row actually holds', async () => {
    await expect(saveAccountGroup(groupInput('GENB', {
      mode: 'CHANGE',
      expectedVersion: 0,
      description: 'A change against a stale version',
    }))).rejects.toThrow(/changed after it was opened/);

    const version = await groupVersion(CHART, 'GENB');
    const result = await saveAccountGroup(groupInput('GENB', {
      mode: 'CHANGE',
      expectedVersion: version,
      description: 'Liabilities and equity',
      fromAccountNumber: '2000',
      toAccountNumber: '2999',
    }));
    expect(result).toMatchObject({ created: false, changed: true, version: version + 1 });

    const entries = await history('gl_account_group', `${CHART}/GENB`);
    expect(entries[0]?.changeType).toBe('CHANGE');
    expect(entries[0]?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldName: 'description', oldValue: 'Stage 3 group GENB', newValue: 'Liabilities and equity' }),
    ]));
  });

  it('reports a save that changes nothing without writing a second history entry', async () => {
    const version = await groupVersion(CHART, 'GENB');
    const result = await saveAccountGroup(groupInput('GENB', {
      mode: 'CHANGE',
      expectedVersion: version,
      description: 'Liabilities and equity',
      fromAccountNumber: '2000',
      toAccountNumber: '2999',
    }));
    expect(result).toMatchObject({ created: false, changed: false, version });
    expect(await history('gl_account_group', `${CHART}/GENB`)).toHaveLength(2);
  });

  it('refuses a new group in a blocked chart but still changes an existing one', async () => {
    await setChartBlocked(true);
    try {
      await expect(saveAccountGroup(groupInput('GEND', {
        fromAccountNumber: '3000',
        toAccountNumber: '3999',
      }))).rejects.toThrow(/is blocked; new Account Groups cannot be created/);

      // Narrowing a range or deactivating a group stays possible while the chart is
      // blocked: the block stops new records, it does not freeze the ones that exist.
      const version = await groupVersion(CHART, 'GENB');
      await expect(saveAccountGroup(groupInput('GENB', {
        mode: 'CHANGE',
        expectedVersion: version,
        description: 'Liabilities, equity and clearing',
        fromAccountNumber: '2000',
        toAccountNumber: '2999',
      }))).resolves.toMatchObject({ changed: true });
    } finally {
      await setChartBlocked(false);
    }
  });

  it('refuses to narrow a range past the accounts already inside the group', async () => {
    await upsertGlAccount(accountInput('1500'));
    await expect(saveAccountGroup(groupInput('GENA', {
      mode: 'CHANGE',
      expectedVersion: await groupVersion(CHART, 'GENA'),
      description: 'Stage 3 group GENA',
      fromAccountNumber: '1000',
      toAccountNumber: '1400',
    }))).rejects.toThrow(/cannot be narrowed: 1 account \(1500\)/);

    // The refusal leaves the range as it was, so the account is still inside it.
    const rows = await listAccountGroups(fixture().client, { chartOfAccounts: CHART });
    expect(rows.find((row) => row.accountGroup === 'GENA')).toMatchObject({
      fromAccountNumber: '1000',
      toAccountNumber: '1999',
      accountCount: 1,
    });
  });
});

describe('Account Group lifecycle', () => {
  it('requires a reason to deactivate a group', async () => {
    await expect(setAccountGroupActive({
      client: fixture().client,
      changedBy: TEST_ACTOR,
      chartOfAccounts: CHART,
      accountGroup: 'GENB',
      isActive: false,
      expectedVersion: await groupVersion(CHART, 'GENB'),
    })).rejects.toThrow(/A reason is required to deactivate an Account Group/);
  });

  it('deactivates a group, takes it out of the F4 and keeps its history', async () => {
    const version = await groupVersion(CHART, 'GENB');
    const result = await setAccountGroupActive({
      client: fixture().client,
      changedBy: TEST_ACTOR,
      chartOfAccounts: CHART,
      accountGroup: 'GENB',
      isActive: false,
      expectedVersion: version,
      reason: 'Superseded by the clearing group',
    });
    expect(result).toMatchObject({ changed: true, isActive: false, version: version + 1, accountCount: 0 });

    const choices = await accountGroupChoices(fixture().client, CHART);
    expect(choices.map((choice) => choice.code)).toEqual(['GENA']);
    // Deactivated, not deleted: the row is still listed, still readable, still auditable.
    const rows = await listAccountGroups(fixture().client, { chartOfAccounts: CHART });
    expect(rows.find((row) => row.accountGroup === 'GENB')).toMatchObject({ isActive: false });

    const entries = await history('gl_account_group', `${CHART}/GENB`);
    expect(entries[0]?.reason).toBe('Superseded by the clearing group');
    expect(entries[0]?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldName: 'isActive', oldValue: 'true', newValue: 'false' }),
    ]));
  });

  it('reports an unchanged lifecycle request without writing', async () => {
    const version = await groupVersion(CHART, 'GENB');
    const result = await setAccountGroupActive({
      client: fixture().client,
      changedBy: TEST_ACTOR,
      chartOfAccounts: CHART,
      accountGroup: 'GENB',
      isActive: false,
      expectedVersion: version,
      reason: 'Already deactivated',
    });
    expect(result).toMatchObject({ changed: false, version });
  });

  it('refuses to change a deactivated group until it is reactivated', async () => {
    await expect(saveAccountGroup(groupInput('GENB', {
      mode: 'CHANGE',
      expectedVersion: await groupVersion(CHART, 'GENB'),
      description: 'Changed while deactivated',
    }))).rejects.toThrow(/is deactivated and cannot be changed/);
  });

  it('reactivates a group without demanding a reason and returns it to the F4', async () => {
    const result = await setAccountGroupActive({
      client: fixture().client,
      changedBy: TEST_ACTOR,
      chartOfAccounts: CHART,
      accountGroup: 'GENB',
      isActive: true,
      expectedVersion: await groupVersion(CHART, 'GENB'),
    });
    expect(result).toMatchObject({ changed: true, isActive: true });
    const choices = await accountGroupChoices(fixture().client, CHART);
    expect(choices.map((choice) => choice.code)).toEqual(['GENA', 'GENB']);
  });

  it('keeps the accounts of a deactivated group assigned to it', async () => {
    await setAccountGroupActive({
      client: fixture().client,
      changedBy: TEST_ACTOR,
      chartOfAccounts: CHART,
      accountGroup: 'GENA',
      isActive: false,
      expectedVersion: await groupVersion(CHART, 'GENA'),
      reason: 'Group under review',
    });
    const rows = await listAccountGroups(fixture().client, { chartOfAccounts: CHART });
    expect(rows.find((row) => row.accountGroup === 'GENA')).toMatchObject({
      isActive: false,
      accountCount: 1,
    });
    expect(await storedAccount(CHART, '1500')).toMatchObject({ accountGroup: 'GENA' });

    // A deactivated group still refuses new accounts, which is the point of deactivating it.
    await expect(upsertGlAccount(accountInput('1600'))).rejects.toThrow(/is deactivated/);

    await setAccountGroupActive({
      client: fixture().client,
      changedBy: TEST_ACTOR,
      chartOfAccounts: CHART,
      accountGroup: 'GENA',
      isActive: true,
      expectedVersion: await groupVersion(CHART, 'GENA'),
    });
  });
});

describe('Field status matrix', () => {
  it('stores only the fields that differ from the baseline and merges them over it', async () => {
    const version = await groupVersion(CHART, 'GENA');
    const result = await saveAccountGroupFieldStatus(matrixInput('GENA', {
      sortKey: 'MANDATORY',
      isOpenItemManaged: 'SUPPRESS',
      // Both are the baseline already, so neither earns a row.
      name: 'MANDATORY',
      reconciliationType: 'OPTIONAL',
    }, { expectedVersion: version }));

    expect(result).toMatchObject({ changed: true, version: version + 1 });
    expect(result.fieldStatus).toEqual({ sortKey: 'MANDATORY', isOpenItemManaged: 'SUPPRESS' });
    expect(await storedMatrixRows(CHART, 'GENA')).toBe(2);

    const rows = await listAccountGroups(fixture().client, { chartOfAccounts: CHART });
    expect(rows.find((row) => row.accountGroup === 'GENA')?.fieldStatus)
      .toEqual({ sortKey: 'MANDATORY', isOpenItemManaged: 'SUPPRESS' });
  });

  it('records the moved fields and only those in change history', async () => {
    const entries = await history('gl_account_group_field_status', `${CHART}/GENA`);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.changeType).toBe('CHANGE');
    expect(entries[0]?.items?.map((item) => item.fieldName).sort()).toEqual(['isOpenItemManaged', 'sortKey']);
  });

  it('refuses to relax a field the account cannot be stored without', async () => {
    const version = await groupVersion(CHART, 'GENA');
    await expect(saveAccountGroupFieldStatus(matrixInput('GENA', { name: 'SUPPRESS' }, { expectedVersion: version })))
      .rejects.toThrow(/Short Text \(TXT20\) cannot be suppressed/);
    await expect(saveAccountGroupFieldStatus(matrixInput('GENA', { accountType: 'OPTIONAL' }, { expectedVersion: version })))
      .rejects.toThrow(/Account Type cannot be optional/);
  });

  it('refuses a field no group controls and a status that does not exist', async () => {
    const version = await groupVersion(CHART, 'GENA');
    await expect(saveAccountGroupFieldStatus(matrixInput('GENA', { notAField: 'MANDATORY' }, { expectedVersion: version })))
      .rejects.toThrow(/Field notAField is not controlled by an Account Group/);
    await expect(saveAccountGroupFieldStatus(matrixInput('GENA', { sortKey: 'MAYBE' }, { expectedVersion: version })))
      .rejects.toThrow(/Field status MAYBE is not valid for sortKey/);
  });

  it('refuses a stale version for the matrix', async () => {
    await expect(saveAccountGroupFieldStatus(matrixInput('GENA', { sortKey: 'OPTIONAL' }, { expectedVersion: 0 })))
      .rejects.toThrow(/changed after it was opened/);
  });

  it('removes the row of a field returned to the baseline', async () => {
    const result = await saveAccountGroupFieldStatus(matrixInput('GENA', {
      sortKey: 'OPTIONAL',
      isOpenItemManaged: 'SUPPRESS',
    }, { expectedVersion: await groupVersion(CHART, 'GENA') }));
    expect(result).toMatchObject({ changed: true });
    expect(result.fieldStatus).toEqual({ isOpenItemManaged: 'SUPPRESS' });
    expect(await storedMatrixRows(CHART, 'GENA')).toBe(1);
  });
});

describe('G/L account writes under the matrix', () => {
  it('refuses CREATE for an account number that already exists and CHANGE for one that does not', async () => {
    await expect(upsertGlAccount(accountInput('1500', { mode: 'CREATE' })))
      .rejects.toThrow(/already exists in Chart of Accounts FS01/);
    await expect(upsertGlAccount(accountInput('1999', { mode: 'CHANGE' })))
      .rejects.toThrow(/does not exist in Chart of Accounts FS01/);
  });

  it('refuses a mandatory field the group demands and the post omits', async () => {
    // sortKey is MANDATORY for GENA at this point in the fixture's life.
    await saveAccountGroupFieldStatus(matrixInput('GENA', {
      sortKey: 'MANDATORY',
      isOpenItemManaged: 'SUPPRESS',
    }, { expectedVersion: await groupVersion(CHART, 'GENA') }));

    const matrix = await matrixFor('GENA');
    expect(matrix).toMatchObject({ sortKey: 'MANDATORY', isOpenItemManaged: 'SUPPRESS' });

    await expect(upsertGlAccount(accountInput('1600', { mode: 'CREATE', sortKey: '', fieldStatus: matrix })))
      .rejects.toThrow(/Account Group GENA makes Sort Key mandatory/);

    await expect(upsertGlAccount(accountInput('1600', { mode: 'CREATE', sortKey: '001', fieldStatus: matrix })))
      .resolves.toMatchObject({ created: true, version: 1 });
  });

  it('ignores a suppressed field on create and stores the contract default instead', async () => {
    // isOpenItemManaged is suppressed for GENA: the screen never renders it, so a posted
    // value is not a choice the user made and must not reach the row.
    const created = await upsertGlAccount(accountInput('1601', {
      mode: 'CREATE',
      sortKey: '001',
      isOpenItemManaged: true,
      fieldStatus: await matrixFor('GENA'),
    }));
    expect(created).toMatchObject({ created: true });
    expect(await storedAccount(CHART, '1601')).toMatchObject({ isOpenItemManaged: false });
  });

  it('keeps a suppressed field at its stored value on change', async () => {
    await saveAccountGroupFieldStatus(matrixInput('GENA', {
      sortKey: 'MANDATORY',
      isOpenItemManaged: 'SUPPRESS',
      groupAccountNumber: 'SUPPRESS',
    }, { expectedVersion: await groupVersion(CHART, 'GENA') }));

    const matrix = await matrixFor('GENA');
    expect(matrix).toMatchObject({ groupAccountNumber: 'SUPPRESS' });
    await upsertGlAccount(accountInput('1602', { mode: 'CREATE', sortKey: '002', fieldStatus: matrix }));
    await upsertGlAccount(accountInput('1602', {
      mode: 'CHANGE',
      sortKey: '002',
      groupAccountNumber: 'GR0001',
      fieldStatus: matrix,
      expectedVersion: await glAccountAuditVersion(fixture().client, CHART, '1602'),
    }));
    // The suppressed field stayed empty even though the post carried a value.
    expect(await storedAccount(CHART, '1602')).toMatchObject({ groupAccountNumber: null });
  });

  it('refuses a block change without a reason and records it as a block with one', async () => {
    const version = await glAccountAuditVersion(fixture().client, CHART, '1600');
    const matrix = await matrixFor('GENA');
    await expect(upsertGlAccount(accountInput('1600', {
      mode: 'CHANGE',
      sortKey: '001',
      isBlockedPosting: true,
      fieldStatus: matrix,
      expectedVersion: version,
    }))).rejects.toThrow(/A reason is required to change a G\/L account block/);

    await expect(upsertGlAccount(accountInput('1600', {
      mode: 'CHANGE',
      sortKey: '001',
      isBlockedPosting: true,
      fieldStatus: matrix,
      expectedVersion: version,
      reason: 'Awaiting the tax ruling on this account',
    }))).resolves.toMatchObject({ created: false, changed: true });

    const entries = await history('gl_account', `${CHART}/1600`);
    expect(entries[0]?.changeType).toBe('BLOCK');
    expect(entries[0]?.reason).toBe('Awaiting the tax ruling on this account');
  });

  it('refuses a stale account version', async () => {
    await expect(upsertGlAccount(accountInput('1600', {
      mode: 'CHANGE',
      sortKey: '001',
      expectedVersion: 99,
    }))).rejects.toThrow(/changed after it was opened/);
  });
});

describe('Block maintenance from the account list', () => {
  it('changes only the flags, needs a reason when they move and reports a no-op without one', async () => {
    const result = await setGlAccountBlocks({
      client: fixture().client,
      changedBy: TEST_ACTOR,
      chartOfAccounts: CHART,
      accountNumber: '1601',
      isBlockedPosting: false,
      isBlockedCreation: true,
      reason: 'Not yet extended to any Company Code',
    });
    expect(result).toMatchObject({ changed: true, blocked: true });
    expect(await storedAccount(CHART, '1601')).toMatchObject({
      isBlockedCreation: true,
      isBlockedPosting: false,
      // The rest of the row is untouched: a block change is not a re-save of the account.
      name: 'Stage 3 account 1601',
      sortKey: '001',
    });

    const entries = await history('gl_account', `${CHART}/1601`);
    expect(entries[0]?.changeType).toBe('BLOCK');

    await expect(setGlAccountBlocks({
      client: fixture().client,
      changedBy: TEST_ACTOR,
      chartOfAccounts: CHART,
      accountNumber: '1601',
      isBlockedPosting: false,
      isBlockedCreation: true,
    })).resolves.toMatchObject({ changed: false });
  });

  it('records the removal of every block as an unblock', async () => {
    await setGlAccountBlocks({
      client: fixture().client,
      changedBy: TEST_ACTOR,
      chartOfAccounts: CHART,
      accountNumber: '1601',
      isBlockedPosting: false,
      isBlockedCreation: false,
      reason: 'Company Code extension approved',
    });
    const entries = await history('gl_account', `${CHART}/1601`);
    expect(entries[0]?.changeType).toBe('UNBLOCK');
  });

  it('refuses a block change without a reason and for an account that does not exist', async () => {
    await expect(setGlAccountBlocks({
      client: fixture().client,
      changedBy: TEST_ACTOR,
      chartOfAccounts: CHART,
      accountNumber: '1602',
      isBlockedPosting: true,
      isBlockedCreation: false,
    })).rejects.toThrow(/A reason is required to change a G\/L account block/);

    await expect(setGlAccountBlocks({
      client: fixture().client,
      changedBy: TEST_ACTOR,
      chartOfAccounts: CHART,
      accountNumber: '1999',
      isBlockedPosting: true,
      isBlockedCreation: false,
      reason: 'Should not get this far',
    })).rejects.toThrow(/does not exist in Chart of Accounts FS01/);
  });
});

describe('Deletion', () => {
  it('refuses without a reason', async () => {
    await expect(deleteGlAccount({
      client: fixture().client,
      changedBy: TEST_ACTOR,
      chartOfAccounts: CHART,
      accountNumber: '1601',
      reason: '   ',
    })).rejects.toThrow(ConfigError);
    expect(await storedAccount(CHART, '1601')).toBeDefined();
  });

  it('deletes an account that was never used and keeps the reason after the row is gone', async () => {
    const result = await deleteGlAccount({
      client: fixture().client,
      changedBy: TEST_ACTOR,
      chartOfAccounts: CHART,
      accountNumber: '1601',
      reason: 'Created by mistake during the FS00 rollout',
    });
    expect(result).toMatchObject({ deleted: true, accountNumber: '1601' });
    expect(await storedAccount(CHART, '1601')).toBeUndefined();

    const entries = await history('gl_account', `${CHART}/1601`);
    expect(entries[0]?.changeType).toBe('DELETE');
    expect(entries[0]?.reason).toBe('Created by mistake during the FS00 rollout');
  });

  it('refuses while document lines exist, naming every fact in one refusal', async () => {
    const { client, companyCode } = fixture();
    // Company Code 1000 uses the standard chart, so the account under test lives there too:
    // the guard reaches document lines through the Company Code's chart.
    await upsertGlAccount(accountInput('9000000001', {
      chartOfAccounts: STANDARD_CHART,
      accountGroup: 'GENL',
      mode: 'CREATE',
    }));
    await upsertGlAccount(accountInput('9000000009', {
      chartOfAccounts: STANDARD_CHART,
      accountGroup: 'GENL',
      accountType: 'EQUITY',
      mode: 'CREATE',
    }));
    // Two lines, because the database refuses a document that does not balance — the
    // fixture obeys the same rule the product does, or it would be testing a state no
    // posting could ever produce.
    await withTenant(client, async (tx) => {
      await tx.insert(journalEntryLine).values([
        {
          client,
          documentNumber: 'FS00DEL01',
          fiscalYear: 2026,
          lineNumber: 1,
          glAccount: '9000000001',
          companyCode,
          debitCredit: 'S',
          amountLocal: '100.0000',
          amountDocument: '100.0000',
          currency: 'USD',
        },
        {
          client,
          documentNumber: 'FS00DEL01',
          fiscalYear: 2026,
          lineNumber: 2,
          glAccount: '9000000009',
          companyCode,
          debitCredit: 'H',
          amountLocal: '100.0000',
          amountDocument: '100.0000',
          currency: 'USD',
        },
      ]);
    });

    await expect(deleteGlAccount({
      client,
      changedBy: TEST_ACTOR,
      chartOfAccounts: STANDARD_CHART,
      accountNumber: '9000000001',
      reason: 'Trying to delete an account that carried a posting',
    })).rejects.toThrow(/1 document line, 1 open item, a balance of 100\.0000/);

    expect(await storedAccount(STANDARD_CHART, '9000000001')).toBeDefined();
  });

  it('refuses while a Customer company record uses the account as its reconciliation account', async () => {
    const { client, companyCode } = fixture();
    await upsertGlAccount(accountInput('9000000002', {
      chartOfAccounts: STANDARD_CHART,
      accountGroup: 'GENL',
      accountType: 'ASSET',
      reconciliationType: 'CUSTOMERS',
      mode: 'CREATE',
    }));
    await withTenant(client, async (tx) => {
      await tx.insert(businessPartner).values({
        client,
        partnerNumber: 'C900002',
        name: 'FS00 deletion reference customer',
        createdBy: 'TEST',
      }).onConflictDoNothing();
      await tx.insert(bpRole).values({
        client,
        partnerNumber: 'C900002',
        roleCode: 'CUSTOMER',
        createdBy: 'TEST',
      }).onConflictDoNothing();
      await tx.insert(customerCompany).values({
        client,
        partnerNumber: 'C900002',
        roleCode: 'CUSTOMER',
        companyCode,
        chartOfAccounts: STANDARD_CHART,
        reconciliationAccount: '9000000002',
        createdBy: 'TEST',
      }).onConflictDoNothing();
    });

    await expect(deleteGlAccount({
      client,
      changedBy: TEST_ACTOR,
      chartOfAccounts: STANDARD_CHART,
      accountNumber: '9000000002',
      reason: 'Trying to delete a reconciliation account',
    })).rejects.toThrow(/1 Customer company record using it as a reconciliation account/);
  });

  it('refuses an account that does not exist rather than reporting a silent success', async () => {
    await expect(deleteGlAccount({
      client: fixture().client,
      changedBy: TEST_ACTOR,
      chartOfAccounts: CHART,
      accountNumber: '1999',
      reason: 'Nothing to delete here',
    })).rejects.toThrow(/does not exist in Chart of Accounts FS01/);
  });

  it('leaves the seeded accounts of the standard chart editable', async () => {
    // FS00 replaces a read-only list, so the 74 accounts a tenant is delivered with must
    // still be changeable — that is the acceptance condition the owner set for the round.
    const accounts = await listGlAccounts(fixture().client, { chartOfAccounts: STANDARD_CHART });
    expect(accounts.length).toBeGreaterThanOrEqual(74);
    const seeded = accounts.find((row) => row.accountNumber === '0000100000') ?? accounts[0];
    await expect(upsertGlAccount(accountInput(seeded.accountNumber, {
      chartOfAccounts: STANDARD_CHART,
      accountGroup: seeded.accountGroup,
      accountType: seeded.accountType as GlAccountInput['accountType'],
      name: `${seeded.name} (renamed by FS00)`,
      isOpenItemManaged: seeded.isOpenItemManaged,
      requiresCostObject: seeded.requiresCostObject,
      isTaxRelevant: seeded.isTaxRelevant,
      reconciliationType: seeded.reconciliationType as GlAccountInput['reconciliationType'],
      mode: 'CHANGE',
      expectedVersion: await glAccountAuditVersion(fixture().client, STANDARD_CHART, seeded.accountNumber),
      reason: 'Proving the seeded chart stays editable',
    }))).resolves.toMatchObject({ created: false });
  });
});
