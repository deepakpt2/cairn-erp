import type { Page } from '@playwright/test'; // eslint-disable-line @typescript-eslint/no-unused-vars
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/finance/cash-flow';
const ACTOR = 'browser.admin';

/**
 * SCR-119 browser acceptance: cash flow statement.
 *
 * The journey: house-bank cash, reconciliation, BSX and
 * asset-class configuration stand with posted journals; the
 * indirect statement shows net income, the depreciation
 * add-back and the section nets reconciled to the cash
 * movement with the unclassified account named; the direct
 * statement reads the offsetting cash lines; the report
 * persists nothing.
 */
export async function cashFlow(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-119: display the cash flow statement, indirect and direct');

  const A = await withTenant(client, async (tx) => {
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
    const accounts: Record<string, string> = {
      CASH: assets[0]!.account_number, RECV: assets[1]!.account_number,
      INV: det[0]?.gl_account ?? assets[2]!.account_number,
      FIXED: assets[3]!.account_number, ACCUM: assets[4]!.account_number,
      UNCLASS: assets[5]!.account_number,
      PAY: picked.LIABILITY!, EQUITY: picked.EQUITY!, REV: picked.REVENUE!, EXP: picked.EXPENSE!,
    };
    if (!det[0]) {
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        values (${client}, 'CA01', 'INVENTORY', '', '', ${accounts.INV}, ${ACTOR}) on conflict do nothing
      `);
    }
    await tx.execute(sql`update gl_account set reconciliation_type = 'CUSTOMERS' where client = ${client} and chart_of_accounts = 'CA01' and account_number = ${accounts.RECV}`);
    await tx.execute(sql`update gl_account set reconciliation_type = 'VENDORS' where client = ${client} and chart_of_accounts = 'CA01' and account_number = ${accounts.PAY}`);
    for (const accountNumber of [accounts.INV, accounts.FIXED, accounts.ACCUM, accounts.UNCLASS, accounts.EQUITY, accounts.REV, accounts.EXP]) {
      await tx.execute(sql`update gl_account set reconciliation_type = null where client = ${client} and chart_of_accounts = 'CA01' and account_number = ${accountNumber}`);
    }
    await tx.execute(sql`
      insert into asset_class (client, asset_class, name, numbering, recon_account, accum_depr_account, depreciation_expense_account, created_by)
      values (${client}, 'CFT1', 'Cash flow fixture', 'INTERNAL', ${accounts.FIXED}, ${accounts.ACCUM}, ${accounts.EXP}, ${ACTOR})
      on conflict (client, asset_class) do update set recon_account = excluded.recon_account,
        accum_depr_account = excluded.accum_depr_account, depreciation_expense_account = excluded.depreciation_expense_account
    `);
    await tx.execute(sql`
      insert into bank_master (bank_country, bank_key, name, created_by)
      values ('KW', 'NBK001', 'Test National Bank', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into house_bank (client, company_code, house_bank_key, bank_country, bank_key, created_by)
      values (${client}, '1000', 'HB01', 'KW', 'NBK001', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bank_account (client, company_code, house_bank_key, account_id, account_number, currency, gl_account, created_by)
      values (${client}, '1000', 'HB01', 'MAIN', '12345678', 'USD', ${accounts.CASH}, ${ACTOR}) on conflict do nothing
    `);
    const journals: Array<[string, number, number, Array<[string, 'S' | 'H', number]>]> = [
      ['CF-2025-01', 2025, 6, [[accounts.CASH, 'S', 2000], [accounts.REV, 'H', 2000]]],
      ['CF-2026-01', 2026, 1, [[accounts.CASH, 'S', 10000], [accounts.EQUITY, 'H', 10000]]],
      ['CF-2026-02', 2026, 2, [[accounts.RECV, 'S', 5000], [accounts.REV, 'H', 5000]]],
      ['CF-2026-03', 2026, 3, [[accounts.CASH, 'S', 4000], [accounts.RECV, 'H', 4000]]],
      ['CF-2026-04', 2026, 4, [[accounts.INV, 'S', 2000], [accounts.PAY, 'H', 2000]]],
      ['CF-2026-05', 2026, 5, [[accounts.PAY, 'S', 1500], [accounts.CASH, 'H', 1500]]],
      ['CF-2026-06', 2026, 6, [[accounts.FIXED, 'S', 3000], [accounts.CASH, 'H', 3000]]],
      ['CF-2026-07', 2026, 7, [[accounts.EXP, 'S', 500], [accounts.ACCUM, 'H', 500]]],
      ['CF-2026-08', 2026, 8, [[accounts.EXP, 'S', 800], [accounts.CASH, 'H', 800]]],
      ['CF-2026-09', 2026, 9, [[accounts.UNCLASS, 'S', 600], [accounts.CASH, 'H', 600]]],
    ];
    for (const [doc, fy, period, lines] of journals) {
      await tx.execute(sql`
        insert into journal_entry
          (client, document_number, fiscal_year, document_type, company_code, document_date,
           posting_date, posting_period, document_currency, local_currency, status, created_by)
        values (${client}, ${doc}, ${fy}, 'SA', '1000', ${`${fy}-06-15`}, ${`${fy}-06-15`}, ${period}, 'USD', 'USD', 'POSTED', ${ACTOR})
        on conflict do nothing
      `);
      for (const [index, [account, dc, amount]] of lines.entries()) {
        await tx.execute(sql`
          insert into journal_entry_line
            (client, document_number, fiscal_year, line_number, gl_account, company_code,
             debit_credit, amount_local, amount_document, currency)
          values (${client}, ${doc}, ${fy}, ${index + 1}, ${account}, '1000', ${dc}, ${amount}, ${amount}, 'USD')
          on conflict do nothing
        `);
      }
    }
    return accounts;
  });

  await page.goto(`${base}${ROUTE}?companies=1000&fiscalYear=2026&periodFrom=1&periodTo=12&method=INDIRECT&comparative=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { name: 'Cash Flow Statement' }).waitFor();
  await page.locator('tr', { hasText: 'Net income for the period' }).first().getByText('3,700.00').first().waitFor();
  await page.locator('tr', { hasText: 'Add back: depreciation' }).first().getByText('500.00').first().waitFor();
  await page.locator('tr', { hasText: 'Net cash from operating activities' }).first().getByText('1,700.00').first().waitFor();
  await page.locator('tr', { hasText: 'Net cash from financing activities' }).first().getByText('10,000.00').first().waitFor();
  await page.getByText(/Opening cash:/).getByText('2,000.00').waitFor();
  await page.getByText(/Reconciliation difference/).getByText('-600.00').waitFor();
  await page.locator('tr', { hasText: A.UNCLASS }).first().getByText('600.00').first().waitFor();
  console.log('  ✓ the indirect statement derives, reconciles and names the unclassified account');

  await page.goto(`${base}${ROUTE}?companies=1000&fiscalYear=2026&periodFrom=1&periodTo=12&method=DIRECT`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.locator('tr', { hasText: 'Receipts from customers' }).first().getByText('4,000.00').first().waitFor();
  await page.locator('tr', { hasText: 'Payments to suppliers' }).first().getByText('-1,500.00').first().waitFor();
  await page.locator('tr', { hasText: 'Net cash from operating activities' }).first().getByText('1,700.00').first().waitFor();
  console.log('  ✓ the direct statement reads the offsetting lines of cash documents');

  const journals = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  });
  assert.equal(journals, 10);
  console.log('  ✓ the statement persisted nothing');
}
