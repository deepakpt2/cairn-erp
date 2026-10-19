import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sql } from 'drizzle-orm';

import { closeDb, withTenant } from '@/platform/db/client';
import { ConfigError, upsertGlAccount, type GlAccountInput } from '@/modules/foundation/services';
import {
  RetainedEarningsError,
  deleteRetainedEarnings,
  listRetainedEarnings,
  maintainRetainedEarnings,
} from '@/modules/foundation/retained-earnings';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'SCR121_STAGE3';
let tenant: TestTenant | undefined;

function fixture(): TestTenant {
  if (!tenant) throw new Error('SCR-121 stage 3 tenant fixture was not initialized.');
  return tenant;
}

const maintain = (overrides: Partial<Parameters<typeof maintainRetainedEarnings>[0]> = {}) =>
  maintainRetainedEarnings({
    client: fixture().client,
    changedBy: ACTOR,
    chartOfAccounts: 'CA01',
    indicator: 'X',
    glAccount: '290000',
    reason: 'SCR-121 automated stage 3 test',
    ...overrides,
  });

function accountInput(
  accountNumber: string,
  overrides: Partial<GlAccountInput> = {},
): GlAccountInput {
  return {
    client: fixture().client,
    changedBy: ACTOR,
    chartOfAccounts: 'CA01',
    accountNumber,
    name: `SCR-121 account ${accountNumber}`,
    accountType: 'REVENUE',
    accountGroup: 'GENL',
    glAccountType: 'PL_STATEMENT',
    isOpenItemManaged: false,
    requiresCostObject: false,
    isTaxRelevant: false,
    reason: 'SCR-121 automated stage 3 test',
    ...overrides,
  };
}

beforeAll(async () => {
  tenant = await createTenant('scr121-retained-earnings', { withConfiguration: true });
}, 180_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
});

describe('SCR-121 retained earnings definition OB53 (R-168)', () => {
  it('maintains a determination, changes it, and refuses invalid input', async () => {
    await expect(maintain({ reason: undefined })).rejects.toBeInstanceOf(RetainedEarningsError);
    await expect(maintain({ indicator: 'XY' })).rejects.toThrow(/exactly one character/);
    await expect(maintain({ chartOfAccounts: 'ZZZZ' })).rejects.toThrow(/does not stand/);
    // 300000 is a P&L revenue account — never a retained earnings account.
    await expect(maintain({ glAccount: '300000' })).rejects.toThrow(/EQUITY balance-sheet account/);

    const created = await maintain();
    expect(created).toMatchObject({ chartOfAccounts: 'CA01', indicator: 'X', glAccount: '290000' });
    const rows = await listRetainedEarnings(fixture().client);
    expect(rows).toEqual([expect.objectContaining({ indicator: 'X', glAccount: '290000' })]);

    const unchanged = await maintain();
    expect(unchanged.indicator).toBe('X');
    const changed = await maintain({ glAccount: '291000' });
    expect(changed.glAccount).toBe('291000');
  });

  it('refuses to save a P&L account whose indicator stands undefined at OB53', async () => {
    await maintain(); // back to 290000
    await expect(upsertGlAccount(accountInput('390000', {
      mode: 'CREATE', retainedEarningsIndicator: 'Y',
    }))).rejects.toThrow(/OB53/);
    await expect(upsertGlAccount(accountInput('390000', {
      mode: 'CREATE', retainedEarningsIndicator: null,
    }))).rejects.toThrow(/must carry a one-character retained earnings indicator/);

    await expect(upsertGlAccount(accountInput('391000', {
      mode: 'CREATE', retainedEarningsIndicator: 'X',
    }))).resolves.toMatchObject({ created: true });
  });

  it('refuses deletion while a P&L account carries the indicator, then deletes cleanly', async () => {
    // Stage 4: the package seeds indicator X on every delivered P&L account,
    // so more than the one test account carries it and X refuses deletion.
    const carriers = await withTenant(fixture().client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as n from gl_account
        where client = ${fixture().client} and chart_of_accounts = 'CA01'
          and gl_account_type = 'PL_STATEMENT' and retained_earnings_indicator = 'X'
      `);
      return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
    });
    expect(carriers).toBeGreaterThan(1);
    await expect(deleteRetainedEarnings({
      client: fixture().client, changedBy: ACTOR,
      chartOfAccounts: 'CA01', indicator: 'X',
      reason: 'SCR-121 automated stage 3 test',
    })).rejects.toThrow(/cannot be deleted/);

    // A fresh indicator Z: defined, carried by the one test account, refused,
    // then released by moving the account back to X and deleted cleanly.
    await maintain({ indicator: 'Z' });
    await upsertGlAccount(accountInput('391000', {
      mode: 'CHANGE', name: 'SCR-121 account 391000', retainedEarningsIndicator: 'Z',
    }));
    await expect(deleteRetainedEarnings({
      client: fixture().client, changedBy: ACTOR,
      chartOfAccounts: 'CA01', indicator: 'Z',
      reason: 'SCR-121 automated stage 3 test',
    })).rejects.toThrow(/cannot be deleted/);
    await upsertGlAccount(accountInput('391000', {
      mode: 'CHANGE', name: 'SCR-121 account 391000', retainedEarningsIndicator: 'X',
    }));
    await deleteRetainedEarnings({
      client: fixture().client, changedBy: ACTOR,
      chartOfAccounts: 'CA01', indicator: 'Z',
      reason: 'SCR-121 automated stage 3 test',
    });
    const rows = await listRetainedEarnings(fixture().client);
    expect(rows.map((r) => r.indicator)).toEqual(['X']);
    expect(ConfigError).toBeDefined();
  });
});
