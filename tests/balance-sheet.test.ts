import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { calculateBalanceSheet, type BalanceSheetSelection } from '../src/modules/finance/balance-sheet';
import { postGlDocument } from '../src/modules/finance/gl-document';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'BS-TEST';
let client = '';
let company = '';

const selection = (overrides: Partial<BalanceSheetSelection> = {}): BalanceSheetSelection => ({
  companyCode: company, statementVersion: 'T01', fiscalYear: 2026,
  periodFrom: 1, periodTo: 12, includeSpecialPeriods: false,
  comparisonFiscalYear: 2025, ledger: '0L',
  calculationType: 'ACCUMULATED', summaryLevel: 9, ...overrides,
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
  const fx = await createTenant('balancesheet');
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
  await post('7000', '101000', '300000', 'bs-2025-1', '2025-05-10');
  await post('5000', '101000', '300000', 'bs-2026-1', '2026-04-10');
  await post('1500', '400000', '101000', 'bs-2026-2', '2026-04-11');
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
}, 180_000);

const account = (result: Awaited<ReturnType<typeof calculateBalanceSheet>>, node: string, accountNumber: string) =>
  result.nodes.find((n) => n.node === node)?.accounts.find((a) => a.accountNumber === accountNumber);

describe('SCR-107 balance sheet / P&L statement (R-155)', () => {
  it('ACCUMULATED: opening plus movements through the cutoff, with comparatives', async () => {
    const result = await calculateBalanceSheet({ client, selection: selection() });
    const cash = account(result, 'ASSETS', '101000');
    expect(cash?.openingBalance).toBe(7000);
    expect(cash?.debitTurnover).toBe(5000);
    expect(cash?.creditTurnover).toBe(1500);
    expect(cash?.balance).toBe(10500);
    expect(cash?.comparativeBalance).toBe(7000);
    const assets = result.nodes.find((n) => n.node === 'ASSETS');
    expect(assets?.openingBalance).toBe(7000);
    expect(assets?.balance).toBe(10500);
    expect(result.currentYearResult).toBeNull();
  });

  it('MOVEMENT: strictly inside the range, opening excluded', async () => {
    const result = await calculateBalanceSheet({ client, selection: selection({ calculationType: 'MOVEMENT' }) });
    const cash = account(result, 'ASSETS', '101000');
    expect(cash?.openingBalance).toBe(0);
    expect(cash?.balance).toBe(3500); // 5000 − 1500
    expect(cash?.comparativeBalance).toBe(7000); // 2025 range movement
    const revenue = account(result, 'REVENUE', '300000');
    expect(revenue?.balance).toBe(5000); // credit movement, presented inverted
    expect(revenue?.comparativeBalance).toBe(7000);
  });

  it('COMBINED: closing for balance sheet, movement for P&L, explicit current-year result', async () => {
    const result = await calculateBalanceSheet({ client, selection: selection({ calculationType: 'COMBINED' }) });
    const cash = account(result, 'ASSETS', '101000');
    expect(cash?.openingBalance).toBe(7000);
    expect(cash?.balance).toBe(10500);
    const revenue = account(result, 'REVENUE', '300000');
    expect(revenue?.openingBalance).toBe(0);
    expect(revenue?.balance).toBe(5000);
    const expenses = account(result, 'EXPENSES', '400000');
    expect(expenses?.balance).toBe(1500);
    expect(result.currentYearResult).toBe(3500); // 5000 revenue − 1500 expenses
  });

  it('summary level folds deeper nodes without changing a figure, and bad types are judged', async () => {
    const folded = await calculateBalanceSheet({ client, selection: selection({ summaryLevel: 1 }) });
    expect(folded.nodes.map((n) => n.node)).toEqual(['BS', 'PL']);
    const bs = folded.nodes.find((n) => n.node === 'BS');
    expect(bs?.balance).toBe(10500); // totals already include descendants
    expect(bs?.accounts.map((a) => a.accountNumber)).toContain('101000'); // accounts merged upward

    const full = await calculateBalanceSheet({ client, selection: selection({ summaryLevel: 9 }) });
    expect(full.nodes.map((n) => n.node)).toContain('ASSETS');

    await expect(calculateBalanceSheet({
      client, selection: selection({ calculationType: 'BOGUS' as BalanceSheetSelection['calculationType'] }),
    })).rejects.toThrow('not configured');
    await expect(calculateBalanceSheet({ client, selection: selection({ summaryLevel: 0 }) }))
      .rejects.toThrow('Summary report level');
    await expect(calculateBalanceSheet({
      client, selection: selection({ comparisonPeriodFrom: 10, comparisonPeriodTo: 4 }),
    })).rejects.toThrow('comparison range is invalid');
  });
});
