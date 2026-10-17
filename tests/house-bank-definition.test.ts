/**
 * SCR-037 / FI12 stage 5 — defining house banks and their accounts.
 *
 * Two levels, two fixtures the service can be refused by: two banks in the
 * global master (SCR-036's table, deleted again at the end, because global
 * rows outlive the tenants that wrote them) and, in the tenant's own chart,
 * three G/L accounts built to fail the asset balance-sheet rule one property
 * at a time — valid, not balance-sheet, not an asset — because the rule names
 * each failure separately (R-86) and a test that only checks "refused" would
 * pass against the wrong refusal. A second company code with no chart
 * assigned stands for the fourth named failure.
 *
 * The stage also asserts the previous SCR's teeth: while a house bank names
 * a bank, the bank master's own deletion refuses with the count, across the
 * tenant boundary the master does not have.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, withTenant } from '@/platform/db/client';
import { changeHistory } from '@/platform/change';
import { configActivityStatus } from '@/platform/tables/registry';
import { bankMaster } from '@/platform/tables/reference';
import { companyCode } from '@/modules/foundation/schema';
import { glAccount } from '@/modules/finance/schema';
import { deleteBank, saveBank } from '@/modules/foundation/bank-master';
import {
  ACTIVITY,
  HouseBankError,
  deleteBankAccount,
  deleteHouseBank,
  listHouseBankCompanies,
  listHouseBanks,
  saveBankAccount,
  saveHouseBank,
  type BankAccountInput,
  type HouseBankInput,
} from '@/modules/foundation/house-bank-definition';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const TEST_ACTOR = 'SCR037_STAGE5';
const REASON = 'SCR-037 automated backend test';
const COMPANY = '1000';
const NO_CHART_COMPANY = '2000';
const HOUSE = 'NBK01';
const ACCOUNT = 'ACC01';
const BANK_ONE = 'F37B1';
const BANK_TWO = 'F37B2';
const GL_VALID = '913100';
const GL_NOT_BALANCE_SHEET = '913200';
const GL_NOT_ASSET = '914100';
const IBAN = 'KW81CBKU1234567890123456789012';

let tenant: TestTenant | undefined;
let prerequisiteTenant: TestTenant | undefined;
let chart = '';

function fixture(): TestTenant {
  if (!tenant) throw new Error('SCR-037 stage 5 tenant fixture was not initialized.');
  return tenant;
}

beforeAll(async () => {
  tenant = await createTenant('scr037-fi12-stage5');
  const { client } = fixture();

  await completePrerequisite(client);
  await startActivity(client);
  await seedBanks(client);
  chart = await discoverChart(client);
  await seedGlAccounts(client, chart);
  await seedNoChartCompany(client);
});

afterAll(async () => {
  // The tenants cascade away; the global banks do not. Delete them through the
  // master's own service once no house bank names them.
  if (tenant) {
    for (const bankKey of [BANK_ONE, BANK_TWO]) {
      await deleteBank({
        client: tenant.client, changedBy: TEST_ACTOR, bankCountry: 'KW', bankKey,
      }).catch(() => undefined);
    }
    await destroyTenant(tenant.client);
  }
  if (prerequisiteTenant) await destroyTenant(prerequisiteTenant.client);
  await closeDb();
});

/* ── Fixtures ───────────────────────────────────────────────────────────────── */

async function completePrerequisite(client: string) {
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

async function seedBanks(client: string) {
  for (const [bankKey, name] of [[BANK_ONE, 'Fixture Bank One'], [BANK_TWO, 'Fixture Bank Two']] as const) {
    await saveBank({
      client, changedBy: TEST_ACTOR, mode: 'CREATE',
      bankCountry: 'KW', bankKey, name, city: 'Kuwait City', swift: '',
    });
  }
}

async function discoverChart(client: string): Promise<string> {
  const companies = await listHouseBankCompanies(client);
  const assigned = companies.find((entry) => entry.companyCode === COMPANY)?.chartOfAccounts;
  if (!assigned) throw new Error('The fixture company code has no chart assigned; the G/L rule has nothing to judge.');
  return assigned;
}

async function seedGlAccounts(client: string, chartOfAccounts: string) {
  // The chart's account groups are the package's; take one that stands rather
  // than inventing a group the account foreign key would refuse.
  const group = await withTenant(client, async (tx) => {
    const [row] = await tx
      .select({ accountGroup: glAccount.accountGroup })
      .from(glAccount)
      .where(and(eq(glAccount.client, client), eq(glAccount.chartOfAccounts, chartOfAccounts)))
      .limit(1);
    return row?.accountGroup;
  });
  if (!group) throw new Error('The fixture chart holds no accounts; the G/L rule has nothing to judge.');

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
      { ...base, accountNumber: GL_VALID, name: 'Fixture bank clearing', accountType: 'ASSET', glAccountType: 'BALANCE_SHEET', isBalanceSheet: true },
      { ...base, accountNumber: GL_NOT_BALANCE_SHEET, name: 'Fixture asset in profit and loss', accountType: 'ASSET', glAccountType: 'PL_STATEMENT', isBalanceSheet: false },
      { ...base, accountNumber: GL_NOT_ASSET, name: 'Fixture revenue', accountType: 'REVENUE', glAccountType: 'PL_STATEMENT', isBalanceSheet: false },
    ]);
  });
}

async function seedNoChartCompany(client: string) {
  await withTenant(client, (tx) => tx.insert(companyCode).values({
    client,
    companyCode: NO_CHART_COMPANY,
    name: 'Fixture company without a chart',
    currency: 'KWD',
    country: 'KW',
    createdBy: TEST_ACTOR,
  }));
}

/* ── Inputs ─────────────────────────────────────────────────────────────────── */

function houseCreation(overrides: Partial<HouseBankInput> = {}): HouseBankInput {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    mode: 'CREATE',
    companyCode: COMPANY,
    houseBankKey: HOUSE,
    bankCountry: 'KW',
    bankKey: BANK_ONE,
    reason: REASON,
    ...overrides,
  };
}

function accountCreation(overrides: Partial<BankAccountInput> = {}): BankAccountInput {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    mode: 'CREATE',
    companyCode: COMPANY,
    houseBankKey: HOUSE,
    accountId: ACCOUNT,
    accountNumber: '000123456789',
    iban: IBAN,
    currency: 'KWD',
    glAccount: GL_VALID,
    reason: REASON,
    ...overrides,
  };
}

async function houseHistory() {
  const { client } = fixture();
  const documents = await withTenant(client, (tx) =>
    changeHistory(tx, client, 'house_bank', `${COMPANY}/${HOUSE}`));
  return documents.filter((document) => document.transactionCode === ACTIVITY);
}

async function accountHistory() {
  const { client } = fixture();
  const documents = await withTenant(client, (tx) =>
    changeHistory(tx, client, 'bank_account', `${COMPANY}/${HOUSE}/${ACCOUNT}`));
  return documents.filter((document) => document.transactionCode === ACTIVITY);
}

/* ── House banks ────────────────────────────────────────────────────────────── */

describe('FI12 define house banks and accounts', () => {
  it('creates a house bank against the master and completes the activity', async () => {
    const result = await saveHouseBank(houseCreation());
    expect(result).toMatchObject({ changed: true, accounts: 0 });

    const rows = await listHouseBanks(fixture().client);
    expect(rows.find((row) => row.houseBankKey === HOUSE)).toMatchObject({
      companyCode: COMPANY, bankKey: BANK_ONE, bankName: 'Fixture Bank One', accounts: [],
    });

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

  it('files one document on the composite key, the bank reference security-relevant', async () => {
    const documents = await houseHistory();
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ changeType: 'CREATE', reason: REASON });
    expect(documents[0].items.find((item) => item.fieldName === 'bankKey'))
      .toMatchObject({ newValue: BANK_ONE, isSecurityRelevant: 'true' });
  });

  it('refuses a duplicate key naming the change, and a change naming the creation', async () => {
    await expect(saveHouseBank(houseCreation())).rejects.toThrow(/is already defined for/);
    await expect(saveHouseBank(houseCreation({ mode: 'CHANGE', houseBankKey: 'NOPE1' })))
      .rejects.toThrow(/is not defined for/);
    expect(await houseHistory()).toHaveLength(1);
  });

  it('refuses a bank the master does not hold and a company code the tenant does not', async () => {
    await expect(saveHouseBank(houseCreation({ houseBankKey: 'NOPE1', bankKey: 'NOSUCH' })))
      .rejects.toThrow(/is not defined in the bank master/);
    await expect(saveHouseBank(houseCreation({ houseBankKey: 'NOPE1', companyCode: '9999' })))
      .rejects.toThrow(/is not defined in this tenant/);
  });

  it('changes the bank reference, files the account count, and repeats as a no-op', async () => {
    const changed = await saveHouseBank(houseCreation({ mode: 'CHANGE', bankKey: BANK_TWO }));
    expect(changed.changed).toBe(true);

    const repeated = await saveHouseBank(houseCreation({ mode: 'CHANGE', bankKey: BANK_TWO }));
    expect(repeated.changed).toBe(false);
    expect(await houseHistory()).toHaveLength(2);

    // Back to the first bank: the account-count assertions below name it.
    await saveHouseBank(houseCreation({ mode: 'CHANGE', bankKey: BANK_ONE }));
    expect(await houseHistory()).toHaveLength(3);
  });

  /* ── Bank accounts ──────────────────────────────────────────────────────── */

  it('creates an account with its IBAN and files the G/L mapping security-relevant', async () => {
    const result = await saveBankAccount(accountCreation());
    expect(result.changed).toBe(true);

    const rows = await listHouseBanks(fixture().client);
    expect(rows.find((row) => row.houseBankKey === HOUSE)?.accounts).toMatchObject([{
      accountId: ACCOUNT, accountNumber: '000123456789', iban: IBAN, currency: 'KWD', glAccount: GL_VALID,
    }]);

    const documents = await accountHistory();
    expect(documents).toHaveLength(1);
    expect(documents[0].items.find((item) => item.fieldName === 'glAccount'))
      .toMatchObject({ newValue: GL_VALID, isSecurityRelevant: 'true' });
  });

  it('refuses a duplicate account and a change to a missing one', async () => {
    await expect(saveBankAccount(accountCreation())).rejects.toThrow(/is already defined under/);
    await expect(saveBankAccount(accountCreation({ mode: 'CHANGE', accountId: 'NOPE2' })))
      .rejects.toThrow(/is not defined under/);
  });

  it('names each G/L failure on its own: missing, revenue, not balance-sheet', async () => {
    await expect(saveBankAccount(accountCreation({ accountId: 'F1', glAccount: '999999' })))
      .rejects.toThrow(new RegExp(`is not defined in chart ${chart}`));
    await expect(saveBankAccount(accountCreation({ accountId: 'F2', glAccount: GL_NOT_ASSET })))
      .rejects.toThrow(/not an asset account/);
    await expect(saveBankAccount(accountCreation({ accountId: 'F3', glAccount: GL_NOT_BALANCE_SHEET })))
      .rejects.toThrow(/is not a balance-sheet account/);
    expect(await accountHistory()).toHaveLength(1);
  });

  it('refuses a currency the master does not hold, an IBAN out of shape, and a long number', async () => {
    await expect(saveBankAccount(accountCreation({ accountId: 'F4', currency: 'ZZZ' })))
      .rejects.toThrow(/is not defined in the currency master/);
    await expect(saveBankAccount(accountCreation({ accountId: 'F5', iban: 'KW81SHORT' })))
      .rejects.toThrow(/fifteen to thirty-four characters/);
    await expect(saveBankAccount(accountCreation({ accountId: 'F6', accountNumber: '1'.repeat(19) })))
      .rejects.toThrow(/at most eighteen characters/);
  });

  it('refuses the account where the company code has no chart to judge it against', async () => {
    await saveHouseBank(houseCreation({ companyCode: NO_CHART_COMPANY, houseBankKey: 'NC01' }));
    await expect(saveBankAccount(accountCreation({ companyCode: NO_CHART_COMPANY, houseBankKey: 'NC01' })))
      .rejects.toThrow(/has no chart of accounts assigned/);
    await deleteHouseBank({
      client: fixture().client, changedBy: TEST_ACTOR,
      companyCode: NO_CHART_COMPANY, houseBankKey: 'NC01', reason: REASON,
    });
  });

  it('needs a reason and the prerequisite, at either level', async () => {
    await expect(saveHouseBank(houseCreation({ houseBankKey: 'NOPE1', reason: '  ' })))
      .rejects.toThrow(/A reason is required/);

    prerequisiteTenant = await createTenant('scr037-fi12-prerequisites');
    const error = await saveHouseBank(houseCreation({ client: prerequisiteTenant.client }))
      .then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(HouseBankError);
    expect((error as HouseBankError).message).toMatch(/prerequisites are incomplete/);
  });

  /* ── Deletion, in the order the structure demands ───────────────────────── */

  it('refuses to delete the house bank while its account stands', async () => {
    const error = await deleteHouseBank({
      client: fixture().client, changedBy: TEST_ACTOR,
      companyCode: COMPANY, houseBankKey: HOUSE, reason: REASON,
    }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(HouseBankError);
    expect((error as HouseBankError).message).toMatch(/has 1 bank account\(s\) and cannot be deleted/);
  });

  it('refuses to delete the master bank while the house bank names it', async () => {
    const error = await deleteBank({
      client: fixture().client, changedBy: TEST_ACTOR, bankCountry: 'KW', bankKey: BANK_ONE,
    }).then(() => null, (caught: unknown) => caught);
    expect((error as Error).message).toMatch(/named by 1 house bank\(s\) and cannot be deleted/);

    const { client } = fixture();
    const standing = await withTenant(client, (tx) => tx
      .select()
      .from(bankMaster)
      .where(and(eq(bankMaster.bankCountry, 'KW'), eq(bankMaster.bankKey, BANK_ONE))));
    expect(standing).toHaveLength(1);
  });

  it('deletes the account, files what was removed, then the house bank, then refuses repeats', async () => {
    await expect(deleteBankAccount({
      client: fixture().client, changedBy: TEST_ACTOR,
      companyCode: COMPANY, houseBankKey: HOUSE, accountId: ACCOUNT, reason: REASON,
    })).resolves.toEqual({ deleted: true });

    const accountDocs = await accountHistory();
    expect(accountDocs).toHaveLength(2);
    expect(accountDocs.find((document) => document.changeType === 'DELETE')
      ?.items.find((item) => item.fieldName === 'accountNumber'))
      .toMatchObject({ oldValue: '000123456789', newValue: null });

    await expect(deleteHouseBank({
      client: fixture().client, changedBy: TEST_ACTOR,
      companyCode: COMPANY, houseBankKey: HOUSE, reason: REASON,
    })).resolves.toEqual({ deleted: true });

    const houseDocs = await houseHistory();
    expect(houseDocs.find((document) => document.changeType === 'DELETE')).toBeDefined();

    await expect(deleteHouseBank({
      client: fixture().client, changedBy: TEST_ACTOR,
      companyCode: COMPANY, houseBankKey: HOUSE, reason: REASON,
    })).rejects.toThrow(/is not defined for/);
  });
});
