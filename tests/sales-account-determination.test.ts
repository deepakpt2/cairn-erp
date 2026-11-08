/**
 * DI-018 (§2.3) — revenue is determined, not chosen.
 *
 * The engine, its refusals and its maintenance. Three properties carry the section:
 *
 * Blank is a value. A customer or material maintained with no account assignment group is matched by the
 * rows that name no group, never by a row invented for them.
 *
 * The most specific row that fits answers, in one fixed order, so two maintainers reading the same table
 * reach the same account.
 *
 * Where nothing stands, the document is refused and the refusal names the screen. An invoice in the
 * ledger with no rule behind it is worse than an invoice that was never raised.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  ACCOUNT_DETERMINATION_ROUTE,
  DELIVERED_ACCOUNT_DETERMINATION,
  SalesAccountDeterminationError,
  determineSalesAccount,
} from '../src/modules/sales/account-determination';
import {
  AccountDeterminationMaintenanceError,
  changeAccountDeterminationStatus,
  defineAccountDetermination,
  listAccountDetermination,
} from '../src/modules/sales/account-determination-maintenance';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'SD9241_DETERMINATION';

describe('revenue account determination', () => {
  let tenant: TestTenant;
  let chart = '';

  beforeAll(async () => {
    tenant = await createTenant('sd9241-determination');
    const rows = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select chart_of_accounts from company_code where client = ${tenant.client} and company_code = '1000'
    `) as unknown as Promise<Array<{ chart_of_accounts: string }>>);
    chart = rows[0]?.chart_of_accounts ?? 'CA01';
  });

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
  });

  it('delivers the four keys the standard procedure can produce, and no more', async () => {
    const configuration = await listAccountDetermination(tenant.client);
    expect(configuration.rows.map((row) => row.accountKey).sort())
      .toEqual(DELIVERED_ACCOUNT_DETERMINATION.map((row) => row.accountKey).sort());
    // Every delivered key is one the package determines, and every one points at an account the chart
    // actually holds: a determination naming an account in another chart could never answer.
    for (const row of configuration.rows) {
      expect(row.accountStands).toBe(true);
      expect(configuration.keys.some((key) => key.key === row.accountKey)).toBe(true);
    }
    // The rebate accrual is a key the package understands and no delivered condition type produces, so
    // it stands undetermined rather than maintained against an account nothing has ever earned.
    expect(configuration.keys.map((key) => key.key)).toContain('ERU');
    expect(configuration.rows.some((row) => row.accountKey === 'ERU')).toBe(false);
  });

  it('answers with the most specific row that fits, in one order', async () => {
    const determined = await withTenant(tenant.client, (tx) => determineSalesAccount(tx, tenant.client, {
      chartOfAccounts: chart, salesOrg: '1000',
      customerAccountAssignmentGroup: '', materialAccountAssignmentGroup: '', accountKey: 'ERL',
    }));
    expect(determined.glAccount).toBe('300000');

    // A row for this sales organisation stands over the one that names none.
    await defineAccountDetermination({
      client: tenant.client, changedBy: ACTOR, chartOfAccounts: chart, salesOrg: '1000',
      accountKey: 'ERL', glAccount: '300100',
    });
    const byOrg = await withTenant(tenant.client, (tx) => determineSalesAccount(tx, tenant.client, {
      chartOfAccounts: chart, salesOrg: '1000',
      customerAccountAssignmentGroup: 'HOME', materialAccountAssignmentGroup: 'GOOD', accountKey: 'ERL',
    }));
    expect(byOrg.glAccount).toBe('300100');

    // A row naming the customer's group as well stands over the one that names only the organisation.
    await defineAccountDetermination({
      client: tenant.client, changedBy: ACTOR, chartOfAccounts: chart, salesOrg: '1000',
      customerAccountAssignmentGroup: 'HOME', accountKey: 'ERL', glAccount: '300200',
    });
    const byCustomer = await withTenant(tenant.client, (tx) => determineSalesAccount(tx, tenant.client, {
      chartOfAccounts: chart, salesOrg: '1000',
      customerAccountAssignmentGroup: 'HOME', materialAccountAssignmentGroup: 'GOOD', accountKey: 'ERL',
    }));
    expect(byCustomer.glAccount).toBe('300200');

    // And a customer in another group falls back to the row that names none, because blank is the group
    // this customer carries and not a value nobody set.
    const other = await withTenant(tenant.client, (tx) => determineSalesAccount(tx, tenant.client, {
      chartOfAccounts: chart, salesOrg: '1000',
      customerAccountAssignmentGroup: 'AWAY', materialAccountAssignmentGroup: 'GOOD', accountKey: 'ERL',
    }));
    expect(other.glAccount).toBe('300100');
  });

  it('refuses where nothing stands, naming the key and the screen', async () => {
    let refusal: SalesAccountDeterminationError | undefined;
    try {
      await withTenant(tenant.client, (tx) => determineSalesAccount(tx, tenant.client, {
        chartOfAccounts: chart, salesOrg: '9000',
        customerAccountAssignmentGroup: '', materialAccountAssignmentGroup: '', accountKey: 'MWS',
      }));
    } catch (error) {
      refusal = error as SalesAccountDeterminationError;
    }
    // A sales organisation with no row of its own is answered by the rows that name none — so making this
    // miss takes a key with no row at all anywhere in the chart.
    expect(refusal).toBeUndefined();

    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update sales_account_determination set is_active = false, changed_by = ${ACTOR}
        where client = ${tenant.client} and account_key = 'ERF'
      `);
    });
    let withdrawn: SalesAccountDeterminationError | undefined;
    try {
      await withTenant(tenant.client, (tx) => determineSalesAccount(tx, tenant.client, {
        chartOfAccounts: chart, salesOrg: '1000',
        customerAccountAssignmentGroup: '', materialAccountAssignmentGroup: '', accountKey: 'ERF',
      }));
    } catch (error) {
      withdrawn = error as SalesAccountDeterminationError;
    }
    expect(withdrawn?.message).toMatch(/No G\/L account is determined for ERF/);
    expect(withdrawn?.remedy).toContain(ACCOUNT_DETERMINATION_ROUTE);
  });

  it('refuses a determination naming an account the chart does not hold, or one combination twice', async () => {
    await expect(defineAccountDetermination({
      client: tenant.client, changedBy: ACTOR, chartOfAccounts: chart, salesOrg: '1000',
      accountKey: 'ERL', glAccount: '999999',
    })).rejects.toThrow(/does not stand in chart/);

    await expect(defineAccountDetermination({
      client: tenant.client, changedBy: ACTOR, chartOfAccounts: chart, salesOrg: '1000',
      customerAccountAssignmentGroup: 'HOME', accountKey: 'ERL', glAccount: '300100',
    })).rejects.toThrow(/already stands/);

    await expect(defineAccountDetermination({
      client: tenant.client, changedBy: ACTOR, chartOfAccounts: chart, salesOrg: '1000',
      accountKey: 'ZZZZ', glAccount: '300000',
    })).rejects.toThrow(/is not one this package determines/);
  });

  it('withdraws a row rather than deleting it, and lets it answer again', async () => {
    const before = await listAccountDetermination(tenant.client);
    const row = before.rows.find((candidate) => candidate.accountKey === 'MWS')!;
    await changeAccountDeterminationStatus({
      client: tenant.client, changedBy: ACTOR, chartOfAccounts: row.chartOfAccounts,
      salesOrg: row.salesOrg, customerAccountAssignmentGroup: row.customerAccountAssignmentGroup,
      materialAccountAssignmentGroup: row.materialAccountAssignmentGroup,
      accountKey: row.accountKey, isActive: false,
    });
    const withdrawn = await listAccountDetermination(tenant.client);
    expect(withdrawn.rows.find((candidate) => candidate.accountKey === 'MWS')?.isActive).toBe(false);
    // The row still stands: it is what tells a reader that output tax was never determined, and it is
    // what an auditor reads to see that the tax account was changed and not invented.
    expect(withdrawn.rows).toHaveLength(before.rows.length);

    await expect(changeAccountDeterminationStatus({
      client: tenant.client, changedBy: ACTOR, chartOfAccounts: row.chartOfAccounts,
      salesOrg: row.salesOrg, customerAccountAssignmentGroup: row.customerAccountAssignmentGroup,
      materialAccountAssignmentGroup: row.materialAccountAssignmentGroup,
      accountKey: 'ZZZZ', isActive: true,
    })).rejects.toThrow(AccountDeterminationMaintenanceError);

    await changeAccountDeterminationStatus({
      client: tenant.client, changedBy: ACTOR, chartOfAccounts: row.chartOfAccounts,
      salesOrg: row.salesOrg, customerAccountAssignmentGroup: row.customerAccountAssignmentGroup,
      materialAccountAssignmentGroup: row.materialAccountAssignmentGroup,
      accountKey: row.accountKey, isActive: true,
    });
    const restored = await listAccountDetermination(tenant.client);
    expect(restored.rows.find((candidate) => candidate.accountKey === 'MWS')?.isActive).toBe(true);
  });
});
