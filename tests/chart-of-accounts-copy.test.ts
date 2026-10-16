/**
 * SCR-027 / OBY7 stage 5 — the chart copy service and its eight refusals.
 *
 * One tenant and a small family of four-character charts, each built to provoke exactly one
 * guard: a narrower target, a wider one, one with no Account Group registry, one whose group
 * is deactivated, one whose group range does not cover the copied numbers, one whose group
 * suppresses fields, and one that already holds the accounts. A refusal is only worth
 * testing if it can be told apart from the others, so each chart has one thing wrong with it.
 *
 * Versions are read rather than counted, and every test states what was *not* written as
 * well as what was: a copy that refuses halfway would leave a chart half populated, which is
 * the one failure this transaction exists to prevent.
 *
 * Not covered here: the overwrite guard for an account carrying postings, open items or a
 * balance. It needs a posted journal fixture, and the browser round already builds one, so
 * the guard is accepted there rather than duplicated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, withTenant } from '@/platform/db/client';
import { changeHistory } from '@/platform/change';
import { configActivityStatus } from '@/platform/tables/registry';
import {
  listChartOfAccounts,
  saveChartOfAccounts,
  type ChartOfAccountsMaintenanceInput,
} from '@/modules/foundation/chart-of-accounts-maintenance';
import { ConfigError, listGlAccounts, upsertGlAccount, type GlAccountInput } from '@/modules/foundation/services';
import { glAccount } from '@/modules/finance/schema';
import {
  listAccountGroups,
  saveAccountGroup,
  saveAccountGroupFieldStatus,
  setAccountGroupActive,
  type AccountGroupFieldStatusInput,
  type AccountGroupMaintenanceInput,
} from '@/modules/finance/gl-account-group-maintenance';
import { GL_ACCOUNT_FIELD_LABELS } from '@/modules/finance/gl-account-vocabulary';
import { copyChartOfAccounts } from '@/modules/finance/chart-of-accounts-copy';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const TEST_ACTOR = 'SCR027_STAGE5';
const SOURCE = 'SRC1';
const TARGET = 'TGT1';
const NARROW = 'TGT3';
const WIDE = 'TGT6';
const NO_GROUPS = 'TGTG';
const DEAD_GROUP = 'TGTD';
const SHORT_RANGE = 'TGTR';
const SUPPRESSED = 'TGT4';
const DUPLICATE = 'TGT2';
const DESCRIPTIONS = 'TGT5';
const EMPTY_SOURCE = 'SRC0';
const CONSOLIDATION_SOURCE = 'SRCC';
const GROUP = 'GENA';

let tenant: TestTenant | undefined;

function fixture(): TestTenant {
  if (!tenant) throw new Error('SCR-027 stage 5 tenant fixture was not initialized.');
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
    name: `OBY7 stage 5 chart ${chart}`,
    language: 'EN',
    accountNumberLength: 4,
    groupChart: '',
    costElementIntegration: 'NONE',
    isBlocked: false,
    reason: 'SCR-027 automated backend test',
    ...overrides,
  };
}

function groupInput(
  chart: string,
  accountGroup: string,
  overrides: Partial<AccountGroupMaintenanceInput> = {},
): AccountGroupMaintenanceInput {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    mode: 'CREATE',
    expectedVersion: 0,
    chartOfAccounts: chart,
    accountGroup,
    description: `OBY7 group ${accountGroup} in ${chart}`,
    fromAccountNumber: '1000',
    toAccountNumber: '1999',
    reason: 'SCR-027 automated backend test',
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
    chartOfAccounts: SOURCE,
    accountNumber,
    name: `OBY7 source account ${accountNumber}`,
    accountType: 'EXPENSE',
    accountGroup: GROUP,
    isOpenItemManaged: false,
    requiresCostObject: false,
    isTaxRelevant: false,
    ...overrides,
  };
}

function matrixInput(
  chart: string,
  accountGroup: string,
  statuses: Record<string, string>,
  expectedVersion: number,
): AccountGroupFieldStatusInput {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    chartOfAccounts: chart,
    accountGroup,
    expectedVersion,
    statuses,
    reason: 'SCR-027 automated backend test',
  };
}

function copyInput(overrides: Partial<Parameters<typeof copyChartOfAccounts>[0]> = {}) {
  return {
    client: fixture().client,
    sourceChartOfAccounts: SOURCE,
    targetChartOfAccounts: TARGET,
    copyLongTexts: true,
    overwriteExisting: false,
    padLeadingZeros: false,
    reason: 'SCR-027 automated backend test',
    changedBy: TEST_ACTOR,
    ...overrides,
  };
}

async function groupVersion(chart: string, accountGroup: string): Promise<number> {
  const groups = await listAccountGroups(fixture().client, { chartOfAccounts: chart });
  const row = groups.find((entry) => entry.accountGroup === accountGroup);
  if (!row) throw new Error(`Account Group ${accountGroup} was not created for ${chart}.`);
  return row.version;
}

async function storedAccounts(chart: string) {
  return listGlAccounts(fixture().client, { chartOfAccounts: chart });
}

async function history(objectClass: string, objectKey: string) {
  const { client } = fixture();
  return withTenant(client, (tx) => changeHistory(tx, client, objectClass, objectKey));
}

/** The chart's version right now, so a test never counts the writes before it. */
async function setChartBlocked(chart: string, isBlocked: boolean) {
  const { client } = fixture();
  const charts = await listChartOfAccounts(client);
  const row = charts.find((entry) => entry.chartOfAccounts === chart);
  if (!row) throw new Error(`Chart ${chart} disappeared from the fixture.`);
  await saveChartOfAccounts(chartInput(chart, { mode: 'CHANGE', expectedVersion: row.version, isBlocked }));
}

/** OB13 refuses to define a chart before Company Code definition is complete. */
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
  tenant = await createTenant('scr027-oby7-stage5');
  await completeCompanyCodeDefinition();

  for (const chart of [SOURCE, TARGET, NARROW, WIDE, NO_GROUPS, DEAD_GROUP, SHORT_RANGE, SUPPRESSED, DUPLICATE, DESCRIPTIONS, EMPTY_SOURCE, CONSOLIDATION_SOURCE]) {
    await saveChartOfAccounts(chartInput(chart, {
      accountNumberLength: chart === NARROW ? 3 : chart === WIDE ? 6 : 4,
    }));
  }

  // The source registry and three accounts, one of which carries values worth losing.
  await saveAccountGroup(groupInput(SOURCE, GROUP));
  await upsertGlAccount(accountInput('1000', { sortKey: '002', isTaxRelevant: true }));
  await upsertGlAccount(accountInput('1001'));
  await upsertGlAccount(accountInput('1002', { isOpenItemManaged: true }));

  // Targets that are ready to take the copy.
  await saveAccountGroup(groupInput(TARGET, GROUP));
  await saveAccountGroup(groupInput(DUPLICATE, GROUP));
  await saveAccountGroup(groupInput(DESCRIPTIONS, GROUP));
  await saveAccountGroup(groupInput(WIDE, GROUP, { fromAccountNumber: '001000', toAccountNumber: '001999' }));
  await saveAccountGroup(groupInput(SHORT_RANGE, GROUP, { toAccountNumber: '1000' }));
  await saveAccountGroup(groupInput(SUPPRESSED, GROUP));
  await saveAccountGroupFieldStatus(matrixInput(SUPPRESSED, GROUP, {
    sortKey: 'SUPPRESS',
    isTaxRelevant: 'SUPPRESS',
  }, await groupVersion(SUPPRESSED, GROUP)));

  // A group that exists but is deactivated: the registry keeps the row, the copy may not use it.
  await saveAccountGroup(groupInput(DEAD_GROUP, GROUP));
  await setAccountGroupActive({
    client: fixture().client,
    changedBy: TEST_ACTOR,
    chartOfAccounts: DEAD_GROUP,
    accountGroup: GROUP,
    expectedVersion: await groupVersion(DEAD_GROUP, GROUP),
    isActive: false,
    reason: 'SCR-027 automated backend test',
  });

  // A source account pointing at a group-side number. Written directly, because FS00 would
  // refuse it while the chart has no Group Chart of Accounts — which is precisely the state
  // the copy guard has to catch rather than inherit.
  await saveAccountGroup(groupInput(CONSOLIDATION_SOURCE, GROUP));
  await withTenant(fixture().client, (tx) => tx.insert(glAccount).values({
    client: fixture().client,
    chartOfAccounts: CONSOLIDATION_SOURCE,
    accountNumber: '1000',
    name: 'OBY7 consolidation source',
    accountType: 'EXPENSE',
    accountGroup: GROUP,
    glAccountType: 'PL_STATEMENT',
    isBalanceSheet: false,
    groupAccountNumber: '9000',
    createdBy: TEST_ACTOR,
    changedBy: TEST_ACTOR,
  }));
}, 180_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
});

describe('SCR-027 / OBY7 copy chart of accounts', () => {
  it('copies every account into an empty chart and records one summary document', async () => {
    const result = await copyChartOfAccounts(copyInput());

    expect(result).toMatchObject({
      sourceChartOfAccounts: SOURCE,
      targetChartOfAccounts: TARGET,
      created: 3,
      overwritten: 0,
      unchanged: 0,
      padded: false,
      droppedFields: [],
    });
    expect(result.changeDocumentId).toBeTruthy();

    const copied = await storedAccounts(TARGET);
    expect(copied.map((row) => row.accountNumber)).toEqual(['1000', '1001', '1002']);
    // The values travel, including the ones a consultant would notice missing.
    expect(copied.find((row) => row.accountNumber === '1000')).toMatchObject({
      name: 'OBY7 source account 1000',
      accountType: 'EXPENSE',
      accountGroup: GROUP,
      sortKey: '002',
      isTaxRelevant: true,
    });
    expect(copied.find((row) => row.accountNumber === '1002')).toMatchObject({ isOpenItemManaged: true });

    // One document for the copy, and none for the accounts it wrote: the ruling made visible.
    const documents = await history('chart_of_accounts_copy', `${SOURCE}->${TARGET}`);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ changeType: 'CREATE', reason: 'SCR-027 automated backend test' });
    expect(await history('gl_account', `${TARGET}/1000`)).toHaveLength(0);
  });

  it('refuses to copy a chart onto itself', async () => {
    await expect(copyChartOfAccounts(copyInput({ targetChartOfAccounts: SOURCE })))
      .rejects.toThrow(ConfigError);
  });

  it('refuses a target chart that does not exist or is blocked', async () => {
    await expect(copyChartOfAccounts(copyInput({ targetChartOfAccounts: 'ZZZZ' })))
      .rejects.toThrow(/does not exist/);

    await setChartBlocked(TARGET, true);
    await expect(copyChartOfAccounts(copyInput()))
      .rejects.toThrow(/is blocked and cannot be copied into/);
    await setChartBlocked(TARGET, false);

    // Unblocked again, and now refused for the honest reason: the accounts are already there.
    await expect(copyChartOfAccounts(copyInput())).rejects.toThrow(/already holds/);
  });

  it('refuses when the source chart holds no accounts', async () => {
    await expect(copyChartOfAccounts(copyInput({ sourceChartOfAccounts: EMPTY_SOURCE, targetChartOfAccounts: DUPLICATE })))
      .rejects.toThrow(/holds no G\/L accounts/);
  });

  it('refuses a narrower target chart and writes nothing', async () => {
    await expect(copyChartOfAccounts(copyInput({ targetChartOfAccounts: NARROW, padLeadingZeros: true })))
      .rejects.toThrow(/cannot take the 4-character account numbers/);
    expect(await storedAccounts(NARROW)).toHaveLength(0);
  });

  it('refuses a wider target unless padding is asked for, then left-pads', async () => {
    await expect(copyChartOfAccounts(copyInput({ targetChartOfAccounts: WIDE })))
      .rejects.toThrow(/grow from 4 to 6 characters/);
    expect(await storedAccounts(WIDE)).toHaveLength(0);

    const result = await copyChartOfAccounts(copyInput({ targetChartOfAccounts: WIDE, padLeadingZeros: true }));
    expect(result).toMatchObject({ created: 3, padded: true });
    expect((await storedAccounts(WIDE)).map((row) => row.accountNumber)).toEqual(['001000', '001001', '001002']);
  });

  it('refuses when the Account Group is missing or deactivated in the target registry', async () => {
    await expect(copyChartOfAccounts(copyInput({ targetChartOfAccounts: NO_GROUPS })))
      .rejects.toThrow(/Account Group GENA used by chart SRC1 does not exist in chart TGTG/);
    expect(await storedAccounts(NO_GROUPS)).toHaveLength(0);

    await expect(copyChartOfAccounts(copyInput({ targetChartOfAccounts: DEAD_GROUP })))
      .rejects.toThrow(/is deactivated in chart TGTD/);
    expect(await storedAccounts(DEAD_GROUP)).toHaveLength(0);
  });

  it('refuses a copied number that falls outside the range its group owns in the target', async () => {
    await expect(copyChartOfAccounts(copyInput({ targetChartOfAccounts: SHORT_RANGE })))
      .rejects.toThrow(/fall outside the range 1000–1000/);
    expect(await storedAccounts(SHORT_RANGE)).toHaveLength(0);
  });

  it('refuses a group account number the target chart has nowhere to point', async () => {
    await expect(copyChartOfAccounts(copyInput({
      sourceChartOfAccounts: CONSOLIDATION_SOURCE,
      targetChartOfAccounts: DUPLICATE,
    }))).rejects.toThrow(/has no Group Chart of Accounts/);
  });

  it('lets the target matrix govern: suppressed fields take the contract default', async () => {
    const result = await copyChartOfAccounts(copyInput({ targetChartOfAccounts: SUPPRESSED }));

    expect(result.droppedFields.sort()).toEqual([
      GL_ACCOUNT_FIELD_LABELS.sortKey,
      GL_ACCOUNT_FIELD_LABELS.isTaxRelevant,
    ].sort());
    const copied = await storedAccounts(SUPPRESSED);
    // The source carried 002 and a tax flag; the target group suppresses both.
    expect(copied.find((row) => row.accountNumber === '1000')).toMatchObject({
      sortKey: '000',
      isTaxRelevant: false,
    });
    // A field the matrix leaves alone still travels.
    expect(copied.find((row) => row.accountNumber === '1002')).toMatchObject({ isOpenItemManaged: true });
  });

  it('refuses duplicates without overwrite, replaces them with it, and counts a repeat as unchanged', async () => {
    const first = await copyChartOfAccounts(copyInput({ targetChartOfAccounts: DUPLICATE }));
    expect(first.created).toBe(3);

    await expect(copyChartOfAccounts(copyInput({ targetChartOfAccounts: DUPLICATE })))
      .rejects.toThrow(/already holds 1000, 1001, 1002 \(3 of 3\)/);

    const second = await copyChartOfAccounts(copyInput({ targetChartOfAccounts: DUPLICATE, overwriteExisting: true }));
    // Nothing differs, so nothing is written and the repeat is legible rather than a churn.
    expect(second).toMatchObject({ created: 0, overwritten: 0, unchanged: 3 });
  });

  it('carries the description on an overwrite only when the flag says so', async () => {
    await copyChartOfAccounts(copyInput({ targetChartOfAccounts: DESCRIPTIONS }));

    // Rename the target account the way FS00 would, then copy over it twice.
    await upsertGlAccount(accountInput('1000', {
      chartOfAccounts: DESCRIPTIONS,
      name: 'Renamed in the target chart',
      sortKey: '002',
      isTaxRelevant: true,
    }));

    await copyChartOfAccounts(copyInput({
      targetChartOfAccounts: DESCRIPTIONS,
      overwriteExisting: true,
      copyLongTexts: false,
    }));
    expect((await storedAccounts(DESCRIPTIONS)).find((row) => row.accountNumber === '1000')?.name)
      .toBe('Renamed in the target chart');

    await copyChartOfAccounts(copyInput({
      targetChartOfAccounts: DESCRIPTIONS,
      overwriteExisting: true,
      copyLongTexts: true,
    }));
    expect((await storedAccounts(DESCRIPTIONS)).find((row) => row.accountNumber === '1000')?.name)
      .toBe('OBY7 source account 1000');
  });

  it('needs a reason and a real tenant key', async () => {
    await expect(copyChartOfAccounts(copyInput({ reason: '   ' }))).rejects.toThrow(ConfigError);
    await expect(copyChartOfAccounts(copyInput({ client: '!!' }))).rejects.toThrow(ConfigError);
  });
});
