/**
 * SCR-040 / OBYC stage 5 — defining account determination.
 *
 * The fixture chart arrives with the standard package; three G/L accounts
 * are added to it so the catalogue's account-kind rule can be judged per
 * failure — two balance-sheet, one profit-and-loss — because a test that
 * only checks "refused" would pass against the wrong refusal (the FI12
 * lesson). The valuation-class rule is judged the same way: an active
 * product class stands, an inactive one and an invented one each refuse.
 *
 * What this stage asserts is the judge (R-89): chart standing, event in
 * the catalogue, modifiers refused for events that do not use them, the
 * account not-in-chart against the wrong-kind. Nothing posts through
 * these rows yet, and deletion is therefore asserted as a clean,
 * documented removal — its cost is a future posting's, stated on screen.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, withTenant } from '@/platform/db/client';
import { changeHistory } from '@/platform/change';
import { configActivityStatus } from '@/platform/tables/registry';
import { accountDetermination } from '@/modules/foundation/schema';
import { glAccount } from '@/modules/finance/schema';
import { valuationClass } from '@/modules/inventory/schema';
import {
  ACTIVITY,
  AccountDeterminationError,
  deleteAccountDetermination,
  listAccountDeterminations,
  listDeterminationCharts,
  listDeterminationValuationClasses,
  listGlAccountChoices,
  saveAccountDetermination,
  type DeterminationDeleteInput,
  type DeterminationInput,
} from '@/modules/foundation/account-determination';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const TEST_ACTOR = 'SCR040_STAGE5';
const REASON = 'SCR-040 automated backend test';

const GL_BS = '915100';
const GL_BS_ALT = '915300';
const GL_PL = '915200';
const INACTIVE_CLASS = 'INACTIVE_TEST_CLASS';

let tenant: TestTenant | undefined;
let prerequisiteTenant: TestTenant | undefined;
let chart = '';

function fixture(): TestTenant {
  if (!tenant) throw new Error('SCR-040 stage 5 tenant fixture was not initialized.');
  return tenant;
}

beforeAll(async () => {
  tenant = await createTenant('scr040-obyc-stage5');
  const { client } = fixture();

  await completePrerequisite(client);
  await startActivity(client);
  chart = await discoverChart(client);
  await seedGlAccounts(client, chart);
  await seedValuationClasses(client);
});

afterAll(async () => {
  if (prerequisiteTenant) await destroyTenant(prerequisiteTenant.client);
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
});

/* ── Fixtures ───────────────────────────────────────────────────────────────── */

async function completePrerequisite(client: string) {
  await withTenant(client, (tx) => tx.insert(configActivityStatus).values({
    client,
    activityCode: 'CFG.FIN.COA.DEFINE',
    status: 'COMPLETED',
    completedAt: new Date(),
    completedBy: TEST_ACTOR,
    createdBy: TEST_ACTOR,
  }).onConflictDoUpdate({
    target: [configActivityStatus.client, configActivityStatus.activityCode],
    set: { status: 'COMPLETED', completedAt: new Date(), completedBy: TEST_ACTOR },
  }));
}

/**
 * The workbench row for the activity itself. Completing an activity updates a row rather
 * than inventing one, and a fixture tenant is created after the seed runs, so without
 * this the service would have nothing to mark and the assertion below would prove nothing.
 */
async function startActivity(client: string) {
  await withTenant(client, (tx) => tx.insert(configActivityStatus).values({
    client,
    activityCode: ACTIVITY,
    status: 'NOT_STARTED',
    createdBy: TEST_ACTOR,
  }).onConflictDoUpdate({
    target: [configActivityStatus.client, configActivityStatus.activityCode],
    set: { status: 'NOT_STARTED' },
  }));
}

async function discoverChart(client: string): Promise<string> {
  const charts = await listDeterminationCharts(client);
  const first = charts[0]?.chartOfAccounts;
  if (!first) throw new Error('The fixture tenant holds no chart of accounts; the judge has nothing to judge against.');
  return first;
}

async function seedGlAccounts(client: string, chartOfAccounts: string) {
  // The chart's account groups are the package's; take one that stands rather
  // than inventing a group the account foreign key would refuse (the FI12 fixture).
  const group = await withTenant(client, async (tx) => {
    const [row] = await tx
      .select({ accountGroup: glAccount.accountGroup })
      .from(glAccount)
      .where(and(eq(glAccount.client, client), eq(glAccount.chartOfAccounts, chartOfAccounts)))
      .limit(1);
    return row?.accountGroup;
  });
  if (!group) throw new Error('The fixture chart holds no accounts; the kind rule has nothing to judge.');

  await withTenant(client, async (tx) => {
    const base = {
      client,
      chartOfAccounts,
      accountGroup: group,
      languageKey: 'EN',
      sortKey: '000',
      createdBy: TEST_ACTOR,
    };
    await tx.insert(glAccount).values([
      { ...base, accountNumber: GL_BS, name: 'Fixture inventory account', accountType: 'ASSET', glAccountType: 'BALANCE_SHEET', isBalanceSheet: true },
      { ...base, accountNumber: GL_BS_ALT, name: 'Fixture second inventory account', accountType: 'ASSET', glAccountType: 'BALANCE_SHEET', isBalanceSheet: true },
      { ...base, accountNumber: GL_PL, name: 'Fixture consumption expense', accountType: 'EXPENSE', glAccountType: 'PL_STATEMENT', isBalanceSheet: false },
    ]).onConflictDoNothing();
  });
}

async function seedValuationClasses(client: string) {
  await withTenant(client, (tx) => tx.insert(valuationClass).values({
    client,
    valuationClass: INACTIVE_CLASS,
    name: 'Fixture inactive class',
    allowedMaterialTypes: 'RAW',
    isActive: false,
    createdBy: TEST_ACTOR,
  }).onConflictDoNothing());
}

/* ── Inputs ─────────────────────────────────────────────────────────────────── */

function creation(overrides: Partial<DeterminationInput> = {}): DeterminationInput {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    mode: 'CREATE',
    chartOfAccounts: chart,
    event: 'INVENTORY',
    valuationClass: 'RAW_INVENTORY',
    generalModifier: '',
    glAccount: GL_BS,
    reason: REASON,
    ...overrides,
  };
}

async function storedRow(overrides: Partial<DeterminationInput> = {}) {
  const input = creation(overrides);
  const { client } = fixture();
  return withTenant(client, async (tx) => {
    const [row] = await tx
      .select()
      .from(accountDetermination)
      .where(and(
        eq(accountDetermination.client, client),
        eq(accountDetermination.chartOfAccounts, input.chartOfAccounts),
        eq(accountDetermination.event, input.event),
        eq(accountDetermination.valuationClass, input.valuationClass),
        eq(accountDetermination.generalModifier, input.generalModifier),
      ));
    return row;
  });
}

function objectKey(input: DeterminationInput): string {
  return `${input.chartOfAccounts}/${input.event}/${input.valuationClass === '' ? 'ANY' : input.valuationClass}/${input.generalModifier === '' ? 'NONE' : input.generalModifier}`;
}

async function rowHistory(input = creation()) {
  const { client } = fixture();
  const documents = await withTenant(client, (tx) =>
    changeHistory(tx, client, 'account_determination', objectKey(input)));
  return documents.filter((document) => document.transactionCode === ACTIVITY);
}

/* ── Create, judge, change, delete ──────────────────────────────────────────── */

describe('OBYC define account determination', () => {
  it('lists the furniture the judge reads: charts, active classes, accounts', async () => {
    // The standard package seeds exactly one determination (SCR-121): retained
    // earnings indicator X, which this screen and OB53 read from one source.
    expect(await listAccountDeterminations(fixture().client)).toEqual([
      expect.objectContaining({
        chartOfAccounts: 'CA01',
        event: 'RETAINED_EARNINGS',
        valuationClass: '',
        generalModifier: 'X',
        glAccount: '290000',
      }),
    ]);
    expect((await listDeterminationCharts(fixture().client)).map((choice) => choice.chartOfAccounts)).toContain(chart);
    const classes = await listDeterminationValuationClasses(fixture().client);
    expect(classes.map((choice) => choice.valuationClass)).toContain('RAW_INVENTORY');
    expect(classes.map((choice) => choice.valuationClass)).not.toContain(INACTIVE_CLASS);
    const accounts = await listGlAccountChoices(fixture().client);
    expect(accounts.find((choice) => choice.accountNumber === GL_PL)).toMatchObject({ glAccountType: 'PL_STATEMENT' });
  });

  it('creates a determination and completes the activity', async () => {
    const result = await saveAccountDetermination(creation());
    expect(result).toMatchObject({ changed: true, glAccount: GL_BS });

    expect(await storedRow()).toMatchObject({ glAccount: GL_BS, createdBy: TEST_ACTOR });

    const { client } = fixture();
    const status = await withTenant(client, (tx) => tx
      .select()
      .from(configActivityStatus)
      .where(and(
        eq(configActivityStatus.client, client),
        eq(configActivityStatus.activityCode, ACTIVITY),
      )));
    expect(status[0]).toMatchObject({ status: 'COMPLETED', completedBy: TEST_ACTOR });
  });

  it('files one change document, the account security-relevant', async () => {
    const documents = await rowHistory();
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ changeType: 'CREATE', transactionCode: ACTIVITY, reason: REASON });
    expect(documents[0].items.find((item) => item.fieldName === 'glAccount'))
      .toMatchObject({ newValue: GL_BS, isSecurityRelevant: 'true' });
  });

  it('refuses to create over a standing key, and to change a missing one', async () => {
    await expect(saveAccountDetermination(creation())).rejects.toThrow(/already stands with these modifiers/);
    await expect(saveAccountDetermination(creation({ mode: 'CHANGE', valuationClass: 'SEMI_INVENTORY' })))
      .rejects.toThrow(/stands with these modifiers/);
    expect(await rowHistory()).toHaveLength(1);
  });

  /* ── The judge, per failure ───────────────────────────────────────────────── */

  it('refuses an event outside the catalogue, naming the four that stand', async () => {
    const error = await saveAccountDetermination(creation({ event: 'FOO', valuationClass: '' }))
      .then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(AccountDeterminationError);
    expect((error as AccountDeterminationError).message).toMatch(/Posting Event FOO is not defined/);
    expect((error as AccountDeterminationError).remedy).toContain('INVENTORY');
  });

  it('refuses a chart the tenant does not hold', async () => {
    await expect(saveAccountDetermination(creation({ chartOfAccounts: 'ZZZZ' })))
      .rejects.toThrow(/Chart of Accounts ZZZZ is not defined in this tenant/);
  });

  it('refuses modifiers for events that do not use them, each by name', async () => {
    await expect(saveAccountDetermination(creation({ event: 'GR_IR_CLEARING', valuationClass: 'RAW_INVENTORY' })))
      .rejects.toThrow(/GR_IR_CLEARING does not use a valuation class/);
    await expect(saveAccountDetermination(creation({ event: 'GR_IR_CLEARING', valuationClass: '', generalModifier: 'VBR' })))
      .rejects.toThrow(/GR_IR_CLEARING does not use a general modifier/);
    await expect(saveAccountDetermination(creation({ event: 'INVENTORY', generalModifier: 'VBR' })))
      .rejects.toThrow(/INVENTORY does not use a general modifier/);
  });

  it('refuses a class that is invented, and one that stands inactive', async () => {
    await expect(saveAccountDetermination(creation({ valuationClass: 'NOPE_CLASS' })))
      .rejects.toThrow(/is not defined as an active class in this tenant/);
    await expect(saveAccountDetermination(creation({ valuationClass: INACTIVE_CLASS })))
      .rejects.toThrow(/is not defined as an active class in this tenant/);
  });

  it('names the account failures separately: not in the chart, then the wrong kind', async () => {
    await expect(saveAccountDetermination(creation({ valuationClass: '', glAccount: '999999' })))
      .rejects.toThrow(new RegExp(`G/L Account 999999 is not defined in chart ${chart}`));
    await expect(saveAccountDetermination(creation({ valuationClass: '', glAccount: GL_PL })))
      .rejects.toThrow(/is a profit-and-loss account; Posting Event INVENTORY expects a balance-sheet account/);
    await expect(saveAccountDetermination(creation({
      event: 'OFFSETTING_INVENTORY', valuationClass: 'RAW_INVENTORY', generalModifier: 'VBR', glAccount: GL_BS,
    }))).rejects.toThrow(/is a balance-sheet account; Posting Event OFFSETTING_INVENTORY expects a profit-and-loss account/);
  });

  it('accepts the offsetting row with its class and modifier, and the clearing row bare', async () => {
    await saveAccountDetermination(creation({
      event: 'OFFSETTING_INVENTORY', valuationClass: 'RAW_INVENTORY', generalModifier: 'VBR', glAccount: GL_PL,
    }));
    await saveAccountDetermination(creation({ event: 'GR_IR_CLEARING', valuationClass: '', glAccount: GL_BS }));

    const rows = await listAccountDeterminations(fixture().client);
    expect(rows.map((row) => `${row.event}|${row.valuationClass}|${row.generalModifier}`)).toEqual([
      'GR_IR_CLEARING||',
      'INVENTORY|RAW_INVENTORY|',
      'OFFSETTING_INVENTORY|RAW_INVENTORY|VBR',
      'RETAINED_EARNINGS||X',
    ]);
  });

  /* ── Change and delete ────────────────────────────────────────────────────── */

  it('redirects the account by change, and repeats as a no-op', async () => {
    const changed = await saveAccountDetermination(creation({ mode: 'CHANGE', glAccount: GL_BS_ALT }));
    expect(changed.changed).toBe(true);
    expect(await storedRow()).toMatchObject({ glAccount: GL_BS_ALT });

    const repeated = await saveAccountDetermination(creation({ mode: 'CHANGE', glAccount: GL_BS_ALT }));
    expect(repeated.changed).toBe(false);

    const documents = await rowHistory();
    expect(documents).toHaveLength(2);
    expect(documents.find((document) => document.changeType === 'CHANGE')
      ?.items.find((item) => item.fieldName === 'glAccount'))
      .toMatchObject({ oldValue: GL_BS, newValue: GL_BS_ALT, isSecurityRelevant: 'true' });
  });

  it('needs a reason, and the prerequisite complete', async () => {
    await expect(saveAccountDetermination(creation({ valuationClass: 'SEMI_INVENTORY', reason: '  ' })))
      .rejects.toThrow(/A reason is required/);

    prerequisiteTenant = await createTenant('scr040-obyc-prerequisites');
    const error = await saveAccountDetermination(creation({ client: prerequisiteTenant.client }))
      .then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(AccountDeterminationError);
    expect((error as AccountDeterminationError).message).toMatch(/prerequisites are incomplete/);
    expect((error as AccountDeterminationError).message).toContain('CFG.FIN.COA.DEFINE');
  });

  it('deletes a row, files what stood, and refuses a second deletion', async () => {
    const request: DeterminationDeleteInput = {
      client: fixture().client,
      changedBy: TEST_ACTOR,
      chartOfAccounts: chart,
      event: 'GR_IR_CLEARING',
      valuationClass: '',
      generalModifier: '',
      reason: REASON,
    };

    await expect(deleteAccountDetermination(request)).resolves.toEqual({ deleted: true });
    expect(await storedRow({ event: 'GR_IR_CLEARING', valuationClass: '' })).toBeUndefined();

    const documents = await rowHistory(creation({ event: 'GR_IR_CLEARING', valuationClass: '' }));
    expect(documents).toHaveLength(2);
    expect(documents.find((document) => document.changeType === 'DELETE')
      ?.items.find((item) => item.fieldName === 'glAccount'))
      .toMatchObject({ oldValue: GL_BS, newValue: null });

    await expect(deleteAccountDetermination(request)).rejects.toThrow(/No determination/);
  });
});
