/**
 * SCR-119 / R-167 stage 5 — cash flow statement.
 *
 * Accounts classify from standing configuration (house-bank
 * cash, reconciliation types, BSX determination, asset-class
 * determination, account type); INDIRECT reads balance
 * movements with the depreciation add-back, DIRECT reads the
 * offsetting lines of cash-touching documents; the three
 * sections reconcile to the cash movement with the
 * unclassified account explaining the difference; the
 * report persists nothing.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  calculateCashflow, type CashflowSelection,
} from '../src/modules/finance/cash-flow';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'SCR119-TEST';
let tenant: TestTenant | undefined;
let client = '';
const A: Record<string, string> = {};

const selection = (overrides: Partial<CashflowSelection> = {}): CashflowSelection => ({
  companyCodes: ['1000'], fiscalYear: 2026, periodFrom: 1, periodTo: 12,
  method: 'INDIRECT', ledger: '0L', comparative: false, ...overrides,
});

async function journal(company: string, doc: string, fy: number, period: number, lines: Array<[string, 'S' | 'H', number]>) {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into journal_entry
        (client, document_number, fiscal_year, document_type, company_code, document_date,
         posting_date, posting_period, document_currency, local_currency, status, created_by)
      values (${client}, ${doc}, ${fy}, 'SA', ${company}, ${`${fy}-06-15`}, ${`${fy}-06-15`}, ${period}, 'USD', 'USD', 'POSTED', ${ACTOR})
      on conflict do nothing
    `);
    for (const [index, [account, dc, amount]] of lines.entries()) {
      await tx.execute(sql`
        insert into journal_entry_line
          (client, document_number, fiscal_year, line_number, gl_account, company_code,
           debit_credit, amount_local, amount_document, currency)
        values (${client}, ${doc}, ${fy}, ${index + 1}, ${account}, ${company}, ${dc}, ${amount}, ${amount}, 'USD')
        on conflict do nothing
      `);
    }
  });
}

beforeAll(async () => {
  tenant = await createTenant('scr119-cashflow');
  client = tenant.client;
  await withTenant(client, async (tx) => {
    const assets = await tx.execute(sql`
      select account_number from gl_account where client = ${client} and chart_of_accounts = 'CA01'
        and account_type = 'ASSET' order by account_number limit 8
    `) as unknown as Array<{ account_number: string }>;
    const byType = await tx.execute(sql`
      select distinct on (account_type) account_type, account_number
      from gl_account where client = ${client} and chart_of_accounts = 'CA01'
        and account_type in ('LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')
      order by account_type, account_number
    `) as unknown as Array<{ account_type: string; account_number: string }>;
    const picked: Record<string, string> = {};
    for (const row of byType) picked[row.account_type] = row.account_number;

    const det = await tx.execute(sql`
      select gl_account from account_determination
      where client = ${client} and chart_of_accounts = 'CA01' and event = 'INVENTORY' order by valuation_class limit 1
    `) as unknown as Array<{ gl_account: string }>;

    A.CASH = assets[0]!.account_number;
    A.RECV = assets[1]!.account_number;
    A.INV = det[0]?.gl_account ?? assets[2]!.account_number;
    A.FIXED = assets[3]!.account_number;
    A.ACCUM = assets[4]!.account_number;
    A.UNCLASS = assets[5]!.account_number;
    A.PAY = picked.LIABILITY!;
    A.EQUITY = picked.EQUITY!;
    A.REV = picked.REVENUE!;
    A.EXP = picked.EXPENSE!;
    if (!det[0]) {
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        values (${client}, 'CA01', 'INVENTORY', '', '', ${A.INV}, ${ACTOR}) on conflict do nothing
      `);
    }
    // The standing chart already classifies some accounts (e.g. a named
    // trade-receivables account carries CUSTOMERS), so every fixture
    // account has its reconciliation type set explicitly: the classes
    // the statement derives are exactly the ones configured here.
    await tx.execute(sql`update gl_account set reconciliation_type = 'CUSTOMERS' where client = ${client} and chart_of_accounts = 'CA01' and account_number = ${A.RECV}`);
    await tx.execute(sql`update gl_account set reconciliation_type = 'VENDORS' where client = ${client} and chart_of_accounts = 'CA01' and account_number = ${A.PAY}`);
    for (const accountNumber of [A.INV, A.FIXED, A.ACCUM, A.UNCLASS, assets[6]!.account_number, A.EQUITY, A.REV, A.EXP]) {
      await tx.execute(sql`update gl_account set reconciliation_type = null where client = ${client} and chart_of_accounts = 'CA01' and account_number = ${accountNumber}`);
    }
    await tx.execute(sql`
      insert into asset_class (client, asset_class, name, numbering, recon_account, accum_depr_account, depreciation_expense_account, created_by)
      values (${client}, 'CFT1', 'Cash flow fixture', 'INTERNAL', ${A.FIXED}, ${A.ACCUM}, ${A.EXP}, ${ACTOR})
      on conflict (client, asset_class) do update set recon_account = excluded.recon_account,
        accum_depr_account = excluded.accum_depr_account, depreciation_expense_account = excluded.depreciation_expense_account
    `);
    await tx.execute(sql`
      insert into bank_master (bank_country, bank_key, name, created_by)
      values ('KW', 'NBK001', 'Test National Bank', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into company_code (client, company_code, name, chart_of_accounts, fiscal_year_variant, currency, country, created_by)
      values (${client}, '2000', 'Euro company', 'CA01', 'K4', 'EUR', 'KW', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into company_code (client, company_code, name, chart_of_accounts, fiscal_year_variant, currency, country, created_by)
      values (${client}, '3000', 'Bankless company', 'CA01', 'K4', 'USD', 'KW', ${ACTOR}) on conflict do nothing
    `);
    for (const [company, gl] of [['1000', A.CASH], ['2000', assets[6]!.account_number]] as const) {
      await tx.execute(sql`
        insert into house_bank (client, company_code, house_bank_key, bank_country, bank_key, created_by)
        values (${client}, ${company}, 'HB01', 'KW', 'NBK001', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bank_account (client, company_code, house_bank_key, account_id, account_number, currency, gl_account, created_by)
        values (${client}, ${company}, 'HB01', 'MAIN', '12345678', 'USD', ${gl}, ${ACTOR}) on conflict do nothing
      `);
    }
    A.CASH2000 = assets[6]!.account_number;
  });

  await journal('1000', 'CF-2025-01', 2025, 6, [[A.CASH!, 'S', 2000], [A.REV!, 'H', 2000]]);
  await journal('1000', 'CF-2026-01', 2026, 1, [[A.CASH!, 'S', 10000], [A.EQUITY!, 'H', 10000]]);
  await journal('1000', 'CF-2026-02', 2026, 2, [[A.RECV!, 'S', 5000], [A.REV!, 'H', 5000]]);
  await journal('1000', 'CF-2026-03', 2026, 3, [[A.CASH!, 'S', 4000], [A.RECV!, 'H', 4000]]);
  await journal('1000', 'CF-2026-04', 2026, 4, [[A.INV!, 'S', 2000], [A.PAY!, 'H', 2000]]);
  await journal('1000', 'CF-2026-05', 2026, 5, [[A.PAY!, 'S', 1500], [A.CASH!, 'H', 1500]]);
  await journal('1000', 'CF-2026-06', 2026, 6, [[A.FIXED!, 'S', 3000], [A.CASH!, 'H', 3000]]);
  await journal('1000', 'CF-2026-07', 2026, 7, [[A.EXP!, 'S', 500], [A.ACCUM!, 'H', 500]]);
  await journal('1000', 'CF-2026-08', 2026, 8, [[A.EXP!, 'S', 800], [A.CASH!, 'H', 800]]);
  await journal('1000', 'CF-2026-09', 2026, 9, [[A.UNCLASS!, 'S', 600], [A.CASH!, 'H', 600]]);
  await journal('2000', 'CF-EUR-01', 2026, 3, [[A.CASH2000!, 'S', 100], [A.EQUITY!, 'H', 100]]);
}, 180_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
}, 180_000);

function line(result: Awaited<ReturnType<typeof calculateCashflow>>, key: string) {
  for (const section of result.sections) {
    const found = section.lines.find((row) => row.key === key);
    if (found) return found;
  }
  return undefined;
}

describe('SCR-119 cash flow statement (R-167)', () => {
  it('refuses a period the company fiscal-year variant does not define', async () => {
    await expect(calculateCashflow({ client, selection: selection({ periodTo: 17 }) }))
      .rejects.toThrow(/not defined by fiscal year variant/);
  });

  it('refuses a company with no house-bank G/L account, by name', async () => {
    await expect(calculateCashflow({ client, selection: selection({ companyCodes: ['3000'] }) }))
      .rejects.toThrow(/3000 has no house-bank G\/L account/);
  });

  it('refuses a non-leading ledger', async () => {
    await expect(calculateCashflow({ client, selection: selection({ ledger: 'ZL' }) }))
      .rejects.toThrow(/leading ledger 0L only/);
  });

  it('derives the indirect statement from balance movements with the depreciation add-back', async () => {
    const result = await calculateCashflow({ client, selection: selection({ comparative: true }) });
    expect(Number(line(result, 'NET_INCOME')?.amountsByCompany['1000'])).toBe(3700);
    expect(Number(line(result, 'ADD_DEPRECIATION')?.amountsByCompany['1000'])).toBe(500);
    expect(Number(line(result, 'CHANGE_RECEIVABLES')?.amountsByCompany['1000'])).toBe(-1000);
    expect(Number(line(result, 'CHANGE_PAYABLES')?.amountsByCompany['1000'])).toBe(500);
    expect(Number(line(result, 'CHANGE_INVENTORY')?.amountsByCompany['1000'])).toBe(-2000);
    expect(Number(line(result, 'NET_OPERATING')?.amountsByCompany['1000'])).toBe(1700);
    expect(Number(line(result, 'NET_INVESTING')?.amountsByCompany['1000'])).toBe(-3000);
    expect(Number(line(result, 'NET_FINANCING')?.amountsByCompany['1000'])).toBe(10000);
    expect(Number(line(result, 'NET_INCOME')?.comparativeTotal)).toBe(2000);
    expect(Number(result.openingCash)).toBe(2000);
    expect(Number(result.closingCash)).toBe(10100);
    expect(Number(result.netCashChange)).toBe(8100);
    expect(Number(result.reconciliationDifference)).toBe(-600);
    expect(result.unclassified).toEqual([{ companyCode: '1000', account: A.UNCLASS, amount: '600', lines: 1 }]);
    expect(result.warnings.join(' ')).toMatch(/stand as financing/);
  });

  it('derives the direct statement from offsetting lines of cash-touching documents', async () => {
    const result = await calculateCashflow({ client, selection: selection({ method: 'DIRECT' }) });
    expect(Number(line(result, 'DIRECT_RECEIVABLES')?.amountsByCompany['1000'])).toBe(4000);
    expect(Number(line(result, 'DIRECT_PAYABLES')?.amountsByCompany['1000'])).toBe(-1500);
    expect(Number(line(result, 'DIRECT_OPERATING')?.amountsByCompany['1000'])).toBe(-800);
    expect(Number(line(result, 'NET_OPERATING')?.amountsByCompany['1000'])).toBe(1700);
    expect(Number(line(result, 'NET_INVESTING')?.amountsByCompany['1000'])).toBe(-3000);
    expect(Number(line(result, 'NET_FINANCING')?.amountsByCompany['1000'])).toBe(10000);
    expect(Number(result.netCashChange)).toBe(8100);
    expect(Number(result.reconciliationDifference)).toBe(-600);
    expect(result.unclassified).toEqual([{ companyCode: '1000', account: A.UNCLASS, amount: '-600', lines: 1 }]);
  });

  it('stands per-company columns without totals across currencies, and persists nothing', async () => {
    const before = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
      return rows[0]!.n;
    });
    const result = await calculateCashflow({ client, selection: selection({ companyCodes: ['1000', '2000'] }) });
    expect(result.totalsComparable).toBe(false);
    expect(line(result, 'NET_FINANCING')?.total).toBeNull();
    expect(Number(line(result, 'NET_FINANCING')?.amountsByCompany['2000'])).toBe(100);
    expect(result.warnings.join(' ')).toMatch(/different local currencies/);
    const after = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
      return rows[0]!.n;
    });
    expect(after).toBe(before);
  });
});
