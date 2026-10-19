import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { calculateProfitLoss, type ProfitLossSelection } from '../src/modules/finance/profit-loss';
import { postGlDocument } from '../src/modules/finance/gl-document';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'PL-TEST';
let client = '';
let company = '';

const selection = (overrides: Partial<ProfitLossSelection> = {}): ProfitLossSelection => ({
  companyCode: company, statementVersion: 'T01', fiscalYear: 2026,
  periodFrom: 4, periodTo: 12, includeSpecialPeriods: false,
  comparisonFiscalYear: 2025, ledger: '0L',
  calculationType: 'COMBINED', summaryLevel: 9, ...overrides,
});

async function post(amount: string, debit: string, credit: string, key: string, date: string) {
  await postGlDocument({
    client, changedBy: ACTOR, requestKey: key, companyCode: company,
    documentDate: date, postingDate: date, documentType: 'SA', currency: 'USD',
    lines: [
      { glAccount: debit, debitCredit: 'S', amount },
      { glAccount: credit, debitCredit: 'H', amount },
    ],
  });
}

beforeAll(async () => {
  const fx = await createTenant('profitloss');
  client = fx.client;
  company = fx.companyCode;
  await defineTestRanges(fx, { fiscalYear: 2025 });
  await defineTestRanges(fx, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into financial_statement_version (client, version, name, chart_of_accounts, created_by)
      values (${client}, 'T01', 'Test statement', 'CA01', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into financial_statement_node (client, version, node, description, parent_node, sequence, created_by)
      values
        (${client}, 'T01', 'BS', 'Balance sheet', null, 10, ${ACTOR}),
        (${client}, 'T01', 'ASSETS', 'Assets', 'BS', 10, ${ACTOR}),
        (${client}, 'T01', 'PL', 'Profit and loss', null, 20, ${ACTOR}),
        (${client}, 'T01', 'REVENUE', 'Revenue', 'PL', 10, ${ACTOR}),
        (${client}, 'T01', 'EXPENSES', 'Expenses', 'PL', 20, ${ACTOR})
    `);
    await tx.execute(sql`
      insert into financial_statement_assignment (client, version, node, account_from, account_to, presentation_sign, created_by)
      values
        (${client}, 'T01', 'ASSETS', '100000', '199999', 'NORMAL', ${ACTOR}),
        (${client}, 'T01', 'REVENUE', '300000', '399999', 'INVERTED', ${ACTOR}),
        (${client}, 'T01', 'EXPENSES', '400000', '499999', 'NORMAL', ${ACTOR})
    `);
  });
  await post('7000', '101000', '300000', 'pl-2025-1', '2025-05-10');
  await post('2000', '101000', '300000', 'pl-2026-0', '2026-02-10');
  await post('5000', '101000', '300000', 'pl-2026-1', '2026-04-10');
  await post('1500', '400000', '101000', 'pl-2026-2', '2026-04-11');
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
}, 180_000);

describe('SCR-111 profit and loss statement (R-159)', () => {
  it('presents P&L only, with range movement beside year-to-date movement', async () => {
    const result = await calculateProfitLoss({ client, selection: selection() });
    expect(result.nodes.map((n) => n.node)).toEqual(['PL', 'REVENUE', 'EXPENSES']);
    const revenue = result.nodes.find((n) => n.node === 'REVENUE');
    const account = revenue?.accounts.find((a) => a.accountNumber === '300000');
    expect(account?.periodMovement).toBe(5000); // April only (range 4–12)
    expect(account?.yearToDateMovement).toBe(7000); // February + April
    expect(account?.comparativeMovement).toBe(7000); // 2025 range 4–12
    expect(account?.comparativeYearToDate).toBe(7000);
    const expenses = result.nodes.find((n) => n.node === 'EXPENSES');
    expect(expenses?.periodMovement).toBe(1500);
    const pl = result.nodes.find((n) => n.node === 'PL');
    expect(pl?.yearToDateMovement).toBe(8500); // 7000 revenue + 1500 expenses, as presented
    expect(result.currentYearResult).toBe(3500); // net P&L movement in range
  });

  it('drops balance-sheet accounts entirely and names unassigned P&L accounts', async () => {
    const result = await calculateProfitLoss({ client, selection: selection() });
    const accounts = result.nodes.flatMap((n) => n.accounts.map((a) => a.accountNumber));
    expect(accounts).not.toContain('101000');
    expect(result.unassigned).toEqual([]);
    // An active range over periods with no P&L postings zeroes, never errors.
    const empty = await calculateProfitLoss({ client, selection: selection({ periodFrom: 8, periodTo: 9 }) });
    const revenue = empty.nodes.find((n) => n.node === 'REVENUE');
    expect(revenue?.periodMovement).toBe(0);
    expect(revenue?.yearToDateMovement).toBe(7000); // YTD still through the cutoff
  });
});
