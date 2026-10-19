import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { calculateTrialBalance, type TrialBalanceSelection } from '../src/modules/finance/trial-balance';
import { postGlDocument } from '../src/modules/finance/gl-document';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'TB-TEST';
let client = '';
let company = '';

const selection = (overrides: Partial<TrialBalanceSelection> = {}): TrialBalanceSelection => ({
  companyCode: company, statementVersion: 'T01', fiscalYear: 2026,
  periodFrom: 1, periodTo: 12, includeSpecialPeriods: false,
  comparisonFiscalYear: 2025, ledger: '0L', ...overrides,
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
  const fx = await createTenant('trialbalance');
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
        (${client}, 'T01', 'REVENUE', 'Revenue', 'PL', 10, ${ACTOR})
    `);
    await tx.execute(sql`
      insert into financial_statement_assignment (client, version, node, account_from, account_to, presentation_sign, created_by)
      values
        (${client}, 'T01', 'ASSETS', '100000', '199999', 'NORMAL', ${ACTOR}),
        (${client}, 'T01', 'REVENUE', '300000', '399999', 'INVERTED', ${ACTOR})
    `);
    // A special-period (13) adjustment, seeded directly.
    await tx.execute(sql`
      insert into journal_entry
        (client, document_number, fiscal_year, document_type, company_code, document_date,
         posting_date, posting_period, document_currency, local_currency, status, created_by)
      values (${client}, 'TB-SPECIAL-13', 2026, 'SA', ${company}, '2026-12-31', '2026-12-31', 13, 'USD', 'USD', 'POSTED', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into journal_entry_line
        (client, document_number, fiscal_year, line_number, gl_account, company_code,
         debit_credit, amount_local, amount_document, currency)
      values
        (${client}, 'TB-SPECIAL-13', 2026, 1, '101000', ${company}, 'S', 100, 100, 'USD'),
        (${client}, 'TB-SPECIAL-13', 2026, 2, '300000', ${company}, 'H', 100, 100, 'USD')
    `);
  });
  await post('7000', '101000', '300000', 'tb-2025-1', '2025-05-10');
  await post('5000', '101000', '300000', 'tb-2026-1', '2026-04-10');
  await post('1500', '400000', '101000', 'tb-2026-2', '2026-04-11');
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
}, 180_000);

describe('SCR-106 trial balance / F.01 statement (R-154)', () => {
  it('derives opening, turnover and cutoff balances with signs and comparatives', async () => {
    const result = await calculateTrialBalance({ client, selection: selection() });
    const assets = result.nodes.find((n) => n.node === 'ASSETS');
    const cash = assets?.accounts.find((a) => a.accountNumber === '101000');
    expect(cash?.balance).toBe(10500); // 7000 opening + 5000 − 1500
    expect(cash?.debitTurnover).toBe(5000);
    expect(cash?.creditTurnover).toBe(1500);
    expect(cash?.comparativeBalance).toBe(7000);
    expect(assets?.balance).toBe(10500);

    const revenueNode = result.nodes.find((n) => n.node === 'REVENUE');
    const revenue = revenueNode?.accounts.find((a) => a.accountNumber === '300000');
    expect(revenue?.balance).toBe(12000); // credit balance, presented inverted
    expect(revenue?.comparativeBalance).toBe(7000);
    expect(revenueNode?.variance).toBe(5000);
    expect(revenueNode?.variancePercent).toBeCloseTo(71.43, 1);

    expect(result.totalDebitTurnover).toBe(6500);
    expect(result.totalCreditTurnover).toBe(6500); // journal stays balanced

    const bs = result.nodes.find((n) => n.node === 'BS');
    expect(bs?.balance).toBe(10500); // hierarchy rolls up
  });

  it('names unassigned accounts instead of dropping them', async () => {
    const result = await calculateTrialBalance({ client, selection: selection() });
    expect(result.unassigned.map((a) => a.accountNumber)).toEqual(['400000']);
    expect(result.unassigned[0]?.balance).toBe(1500);
    expect(result.warnings.some((w) => w.includes('outside every FSV assignment'))).toBe(true);
  });

  it('includes special periods only when explicitly selected', async () => {
    const excluded = await calculateTrialBalance({ client, selection: selection({ periodTo: 16 }) });
    const cashOut = excluded.nodes.find((n) => n.node === 'ASSETS')?.accounts[0];
    expect(cashOut?.balance).toBe(10500); // period-13 debit of 100 excluded
    expect(excluded.warnings.some((w) => w.includes('special period'))).toBe(true);

    const included = await calculateTrialBalance({
      client, selection: selection({ periodTo: 16, includeSpecialPeriods: true }),
    });
    const cashIn = included.nodes.find((n) => n.node === 'ASSETS')?.accounts[0];
    expect(cashIn?.balance).toBe(10600);
  });

  it('judges the version and chart, and handles a missing comparative gracefully', async () => {
    await expect(calculateTrialBalance({ client, selection: selection({ statementVersion: 'NOPE' }) }))
      .rejects.toThrow('does not stand');
    const noComparison = await calculateTrialBalance({
      client, selection: selection({ comparisonFiscalYear: undefined }),
    });
    const assets = noComparison.nodes.find((n) => n.node === 'ASSETS');
    expect(assets?.comparativeBalance).toBeNull();
    expect(assets?.variancePercent).toBeNull();
  });
});
