import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { calculateBalanceSheet } from '../src/modules/finance/balance-sheet';
import { ledgerJournalStatus } from '../src/modules/finance/ledger-journal';
import { calculateProfitLoss } from '../src/modules/finance/profit-loss';
import { postGlDocument } from '../src/modules/finance/gl-document';
import {
  TRIAL_BALANCE_CAPABILITY, calculateTrialBalance, listStatementVersions,
  type TrialBalanceSelection,
} from '../src/modules/finance/trial-balance';
import { STANDARD_PACKAGE_VERSION, STANDARD_STATEMENT_VERSION, applyStandardPackage } from '../src/modules/foundation/standard-config';

import { createTenant, defineTestRanges, destroyTenant } from './helpers';

/**
 * SCR-106 stage 3 — the standard financial statement version is stood by the
 * configuration package, so a tenant can read its own ledger without anyone running
 * the installation seed afterwards.
 *
 * These tests deliberately do not insert a statement version of their own. A fixture
 * that wrote the rows it is testing would pass for the wrong reason: the point is that
 * `applyStandardPackage` — the thing tenant creation and every configured test tenant
 * already call — stands them.
 */

const ACTOR = 'FSV-ONBOARD-TEST';
const FY = 2026;

let client = '';
let company = '';
let bareClient = '';
let bareCompany = '';

const selection = (overrides: Partial<TrialBalanceSelection> = {}): TrialBalanceSelection => ({
  companyCode: company,
  statementVersion: STANDARD_STATEMENT_VERSION.version,
  fiscalYear: FY,
  periodFrom: 1, periodTo: 12, includeSpecialPeriods: false,
  ledger: '0L',
  ...overrides,
});

/** The same aggregation the trial balance performs, read straight off the journal. */
async function ledgerTurnover(): Promise<{ debit: number; credit: number }> {
  return withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select
        coalesce(sum(case when l.debit_credit = 'S' then l.amount_local end), 0)::float as debit,
        coalesce(sum(case when l.debit_credit = 'H' then l.amount_local end), 0)::float as credit
      from journal_entry_line l
      join journal_entry e
        on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
      where l.client = ${client} and e.company_code = ${company}
        and e.fiscal_year = ${FY} and e.posting_period between 1 and 12
        and ${ledgerJournalStatus('e')}
    `)) as unknown as Array<{ debit: number; credit: number }>;
    return { debit: rows[0]?.debit ?? 0, credit: rows[0]?.credit ?? 0 };
  });
}

async function statementShape(tenant: string): Promise<{ versions: number; nodes: number; assignments: number }> {
  return withTenant(tenant, async (tx) => {
    const one = async (query: ReturnType<typeof sql>) => {
      const rows = (await tx.execute(query)) as unknown as Array<{ n: number }>;
      return rows[0]?.n ?? 0;
    };
    const version = STANDARD_STATEMENT_VERSION.version;
    return {
      versions: await one(sql`select count(*)::int as n from financial_statement_version where client = ${tenant} and version = ${version}`),
      nodes: await one(sql`select count(*)::int as n from financial_statement_node where client = ${tenant} and version = ${version}`),
      assignments: await one(sql`select count(*)::int as n from financial_statement_assignment where client = ${tenant} and version = ${version}`),
    };
  });
}

beforeAll(async () => {
  const fx = await createTenant('fsv-onboarding');
  client = fx.client;
  company = fx.companyCode;
  await defineTestRanges(fx, { fiscalYear: FY });

  // A tenant created without the package: the negative half of the isolation claim.
  const bare = await createTenant('fsv-onboarding-bare', { withConfiguration: false });
  bareClient = bare.client;
  bareCompany = bare.companyCode;

  await postGlDocument({
    client, changedBy: ACTOR, requestKey: 'fsv-onboard-1', companyCode: company,
    documentDate: '2026-04-10', postingDate: '2026-04-10', documentType: 'SA', currency: 'USD',
    headerText: 'FSV onboarding proof',
    lines: [
      { glAccount: '101000', debitCredit: 'S', amount: '4200.00', lineText: 'Bank in' },
      { glAccount: '300000', debitCredit: 'H', amount: '4200.00', lineText: 'Revenue' },
    ],
  });
  await postGlDocument({
    client, changedBy: ACTOR, requestKey: 'fsv-onboard-2', companyCode: company,
    documentDate: '2026-04-11', postingDate: '2026-04-11', documentType: 'SA', currency: 'USD',
    headerText: 'Onboarding expense proof',
    lines: [
      { glAccount: '560000', debitCredit: 'S', amount: '1200.00', lineText: 'Bank charges' },
      { glAccount: '101000', debitCredit: 'H', amount: '1200.00', lineText: 'Bank out' },
    ],
  });
}, 240_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
  if (bareClient) await destroyTenant(bareClient);
}, 240_000);

describe('standard configuration package — the financial statement version it stands', () => {
  it('gives a newly onboarded tenant the standard version, its nodes and its ranges', async () => {
    const versions = await listStatementVersions(client);
    expect(versions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        version: STANDARD_STATEMENT_VERSION.version,
        name: STANDARD_STATEMENT_VERSION.name,
        chartOfAccounts: 'CA01',
      }),
    ]));

    const shape = await statementShape(client);
    expect(shape).toEqual({
      versions: 1,
      nodes: STANDARD_STATEMENT_VERSION.nodes.length,
      assignments: STANDARD_STATEMENT_VERSION.assignments.length,
    });
    expect(versions.length).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent: a second activation neither doubles nor removes a row', async () => {
    await withTenant(client, async (tx) => {
      await applyStandardPackage(tx, {
        client, currency: 'USD', fiscalYearVariant: 'K4', activatedBy: ACTOR,
      });
    });
    const after = await statementShape(client);
    expect(after).toEqual(await statementShape(client));
    expect(after.versions).toBe(1);
    expect(after.nodes).toBe(STANDARD_STATEMENT_VERSION.nodes.length);
    expect(after.assignments).toBe(STANDARD_STATEMENT_VERSION.assignments.length);
  });

  it('keeps the parent nodes ahead of their children, which the self-foreign-key demands', async () => {
    const seen = new Set<string>();
    for (const node of STANDARD_STATEMENT_VERSION.nodes) {
      if (node.parentNode !== null) expect(seen.has(node.parentNode)).toBe(true);
      seen.add(node.node);
    }
    // And the ranges never name a node the hierarchy does not carry.
    const nodes = new Set(STANDARD_STATEMENT_VERSION.nodes.map((n) => n.node));
    for (const assignment of STANDARD_STATEMENT_VERSION.assignments) {
      expect(nodes.has(assignment.node)).toBe(true);
      expect(assignment.accountFrom <= assignment.accountTo).toBe(true);
    }
  });

  it('runs all three closing reports on that version, with turnover that equals the ledger', async () => {
    const trial = await calculateTrialBalance({ client, selection: selection() });
    const ledger = await ledgerTurnover();

    expect(trial.statementVersion).toBe(STANDARD_STATEMENT_VERSION.version);
    expect(trial.chartOfAccounts).toBe('CA01');
    expect(trial.nodes).toHaveLength(STANDARD_STATEMENT_VERSION.nodes.length);
    expect(trial.totalDebitTurnover).toBeCloseTo(trial.totalCreditTurnover, 2);
    expect(trial.totalDebitTurnover).toBeCloseTo(ledger.debit, 2);
    expect(trial.totalCreditTurnover).toBeCloseTo(ledger.credit, 2);

    const assets = trial.nodes.find((n) => n.node === 'ASSETS');
    expect(assets?.accounts.some((a) => a.accountNumber === '101000')).toBe(true);
    expect(assets?.balance).toBeCloseTo(4200 - 1200, 2);
    const revenue = trial.nodes.find((n) => n.node === 'REVENUE');
    expect(revenue?.accounts.some((a) => a.accountNumber === '300000')).toBe(true);
    expect(revenue?.balance).toBeCloseTo(4200, 2); // the credit side, presented inverted
    const expenses = trial.nodes.find((n) => n.node === 'EXPENSES');
    expect(expenses?.balance).toBeCloseTo(1200, 2);

    const sheet = await calculateBalanceSheet({
      client, selection: { ...selection(), calculationType: 'ACCUMULATED', summaryLevel: 1 },
    });
    expect(sheet.statementVersion).toBe(STANDARD_STATEMENT_VERSION.version);
    expect(sheet.nodes.length).toBeGreaterThan(0);
    expect(sheet.currentYearResult).toBeNull(); // the result is a COMBINED figure, not an accumulated one
    const combined = await calculateBalanceSheet({
      client, selection: { ...selection(), calculationType: 'COMBINED', summaryLevel: 1 },
    });
    expect(combined.currentYearResult).not.toBeNull();
    expect(combined.currentYearResult).toBeCloseTo(4200 - 1200, 2); // revenue less expense for the year

    const profit = await calculateProfitLoss({
      client, selection: { ...selection(), calculationType: 'MOVEMENT', summaryLevel: 1 },
    });
    expect(profit.nodes.length).toBeGreaterThan(0);
    // The P&L statement keeps the accounts the chart marks profit and loss, and only those.
    for (const node of profit.nodes) {
      for (const account of node.accounts) {
        expect(['300000', '560000']).toContain(account.accountNumber);
      }
    }
  });

  it('refuses a version that does not stand, and names the remedy — for a tenant or out of one', async () => {
    await expect(calculateTrialBalance({ client, selection: selection({ statementVersion: 'NOPE' }) }))
      .rejects.toThrow(/does not stand/);
    const error = await calculateTrialBalance({ client, selection: selection({ statementVersion: 'NOPE' }) })
      .then(() => null, (caught: unknown) => caught as { remedy?: string });
    expect(error?.remedy).toBe('Configure the FSV first.');

    // A tenant created without the package stands nothing, which is what makes the
    // first assertion above a statement about onboarding rather than about shared state.
    await expect(calculateTrialBalance({
      client: bareClient,
      selection: selection({ companyCode: bareCompany }),
    })).rejects.toThrow(/does not stand/);
    expect((await listStatementVersions(bareClient))).toHaveLength(0);
    expect(await statementShape(bareClient)).toEqual({ versions: 0, nodes: 0, assignments: 0 });
  });

  it('leaves the allocation accounts outside the standard ranges on purpose, so they surface as unassigned', async () => {
    const widest = STANDARD_STATEMENT_VERSION.assignments
      .map((a) => a.accountTo)
      .sort()
      .at(-1);
    expect(widest).toBe('599999');
    // The chart does deliver allocation accounts above that bound, and the report is
    // expected to say so rather than fold them into a line that does not own them.
    const allocation = await withTenant(client, async (tx) => (
      await tx.execute(sql`
        select count(*)::int as n from gl_account
        where client = ${client} and chart_of_accounts = 'CA01'
          and account_number >= '600000' and account_number <= '699999'
      `)
    ) as unknown as Array<{ n: number }>);
    expect(allocation[0]?.n ?? 0).toBeGreaterThan(0);
    expect(TRIAL_BALANCE_CAPABILITY).toBe('FIN.RPT.TRIALBALANCE');
    expect(STANDARD_PACKAGE_VERSION).toBe('INTL-STD-4');
  });
});
