/**
 * SCR-118 / R-166 stage 5 — consolidated statements.
 *
 * FS items classify from mapped source account types; posted
 * journal lines aggregate per unit through the UCWB mappings
 * (YTD, period movement, previous-year comparison); unmapped
 * lines are named; the all-lines balance check stands; the
 * report persists nothing.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  activateArea, assignUnit, saveArea, saveDataBasis, saveGroup,
  saveGroupAccount, saveMapping, saveMethod, saveTask, saveUnit, saveVersion,
} from '../src/modules/finance/consolidation-workbench';
import {
  calculateConsolidatedStatements,
  type ConsolidatedStatementsSelection,
} from '../src/modules/finance/consolidated-statements';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = { changedBy: 'SCR118-TEST', reason: 'SCR-118 automated backend test' };
let tenant: TestTenant | undefined;
let client = '';
let variant = 'K4';
const accounts: Record<string, string> = {};

const selection = (overrides: Partial<ConsolidatedStatementsSelection> = {}): ConsolidatedStatementsSelection => ({
  area: 'C100', group: 'GRP1', version: '100', fiscalYear: 2026, period: 12,
  view: 'BALANCE_SHEET', unit: '', comparative: false, ...overrides,
});

async function journal(doc: string, fy: number, period: number, lines: Array<[string, 'S' | 'H', number]>) {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into journal_entry
        (client, document_number, fiscal_year, document_type, company_code, document_date,
         posting_date, posting_period, document_currency, local_currency, status, created_by)
      values (${client}, ${doc}, ${fy}, 'SA', '1000', ${`${fy}-06-15`}, ${`${fy}-06-15`}, ${period}, 'USD', 'USD', 'POSTED', ${ACTOR.changedBy})
    `);
    for (const [index, [account, dc, amount]] of lines.entries()) {
      await tx.execute(sql`
        insert into journal_entry_line
          (client, document_number, fiscal_year, line_number, gl_account, company_code,
           debit_credit, amount_local, amount_document, currency)
        values (${client}, ${doc}, ${fy}, ${index + 1}, ${account}, '1000', ${dc}, ${amount}, ${amount}, 'USD')
      `);
    }
  });
}

beforeAll(async () => {
  tenant = await createTenant('scr118-stmt');
  client = tenant.client;
  await withTenant(client, async (tx) => {
    const variantRows = await tx.execute(sql`
      select fiscal_year_variant from company_code where client = ${client} and company_code = '1000'
    `) as unknown as Array<{ fiscal_year_variant: string }>;
    variant = variantRows[0]?.fiscal_year_variant ?? 'K4';
    const rows = await tx.execute(sql`
      select distinct on (account_type) account_type, account_number
      from gl_account where client = ${client} and chart_of_accounts = 'CA01'
        and account_type in ('ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE')
      order by account_type, account_number
    `) as unknown as Array<{ account_type: string; account_number: string }>;
    for (const row of rows) accounts[row.account_type] = row.account_number;
    const unmapped = await tx.execute(sql`
      select account_number from gl_account where client = ${client} and chart_of_accounts = 'CA01'
        and account_type = 'ASSET' and account_number <> ${accounts.ASSET ?? ''}
      order by account_number limit 1
    `) as unknown as Array<{ account_number: string }>;
    accounts.UNMAPPED = unmapped[0]!.account_number;
  });

  await saveDataBasis({ client, ...ACTOR, basis: 'BASIS1', title: 'Journal basis', dimensions: [{ dimension: 'COMPANY_CODE' }] });
  await saveArea({ client, ...ACTOR, area: 'C100', title: 'Group consolidation', dataBasis: 'BASIS1', consChart: 'GC01', fiscalYearVariant: variant });
  await saveUnit({ client, ...ACTOR, area: 'C100', unit: 'U1000', title: 'Unit one', companyCode: '1000' });
  await saveGroup({ client, ...ACTOR, area: 'C100', group: 'GRP1', title: 'Group' });
  await assignUnit({ client, ...ACTOR, area: 'C100', group: 'GRP1', unit: 'U1000', validFrom: '2025-01-01', validTo: '2026-12-31' });
  await saveGroupAccount({ client, ...ACTOR, consChart: 'GC01', account: 'FS1000', title: 'Asset item' });
  await saveGroupAccount({ client, ...ACTOR, consChart: 'GC01', account: 'FS4000', title: 'Revenue item' });
  await saveGroupAccount({ client, ...ACTOR, consChart: 'GC01', account: 'FS5000', title: 'Expense item' });
  await saveMapping({ client, ...ACTOR, consChart: 'GC01', sourceChart: 'CA01', sourceFrom: accounts.ASSET!, sourceTo: accounts.ASSET!, groupAccount: 'FS1000' });
  await saveMapping({ client, ...ACTOR, consChart: 'GC01', sourceChart: 'CA01', sourceFrom: accounts.REVENUE!, sourceTo: accounts.REVENUE!, groupAccount: 'FS4000' });
  await saveMapping({ client, ...ACTOR, consChart: 'GC01', sourceChart: 'CA01', sourceFrom: accounts.EXPENSE!, sourceTo: accounts.EXPENSE!, groupAccount: 'FS5000' });
  await saveMethod({ client, ...ACTOR, area: 'C100', method: 'MVAL', kind: 'OTHER', title: 'Collect' });
  await saveVersion({ client, ...ACTOR, area: 'C100', version: '100', title: 'Actual' });
  await saveTask({ client, ...ACTOR, area: 'C100', version: '100', task: 'T100', sequence: 10, taskType: 'DATA_COLLECTION', method: 'MVAL', unit: 'U1000', group: 'GRP1', validFrom: '2025-01-01', validTo: '2026-12-31' });
  await activateArea({ client, ...ACTOR, area: 'C100' });

  await journal('STMT-2026-06', 2026, 6, [[accounts.ASSET!, 'S', 1000], [accounts.REVENUE!, 'H', 1000]]);
  await journal('STMT-2026-12', 2026, 12, [[accounts.EXPENSE!, 'S', 250], [accounts.ASSET!, 'H', 250]]);
  await journal('STMT-2026-UNMAPPED', 2026, 12, [[accounts.ASSET!, 'S', 100], [accounts.LIABILITY!, 'H', 100]]);
  await journal('STMT-2025-12', 2025, 12, [[accounts.ASSET!, 'S', 500], [accounts.REVENUE!, 'H', 500]]);
}, 180_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
}, 180_000);

describe('SCR-118 consolidated statements (R-166)', () => {
  it('rejects an undefined consolidation period', async () => {
    await expect(calculateConsolidatedStatements({ client, selection: selection({ period: 20 }) }))
      .rejects.toThrow(/not defined by fiscal year variant/);
  });

  it('classifies FS items and aggregates mapped journal data per unit', async () => {
    const result = await calculateConsolidatedStatements({ client, selection: selection({ comparative: true }) });
    const asset = result.rows.find((row) => row.groupAccount === 'FS1000');
    expect(asset?.section).toBe('ASSETS');
    expect(Number(asset?.groupTotal)).toBe(850); // 1000 - 250 + 100
    expect(Number(asset?.periodMovement)).toBe(-150); // -250 + 100 in period 12
    expect(Number(asset?.unitAmounts.U1000)).toBe(850);
    expect(Number(asset?.comparativeTotal)).toBe(500);
    expect(Number(result.balanceCheck)).toBe(0);
    expect(result.unmapped.lines).toBe(1); // the liability credit has no mapping
    expect(Number(result.unmapped.amount)).toBe(-100);
    expect(result.warnings.join(' ')).toMatch(/pre-elimination/);
    expect(result.warnings.join(' ')).toMatch(/no completed update-mode monitor run/);
  });

  it('shows the income statement sections and persists nothing', async () => {
    const before = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
      return rows[0]!.n;
    });
    const result = await calculateConsolidatedStatements({ client, selection: selection({ view: 'INCOME_STATEMENT' }) });
    expect(Number(result.rows.find((row) => row.groupAccount === 'FS4000')?.groupTotal)).toBe(-1000);
    expect(Number(result.rows.find((row) => row.groupAccount === 'FS5000')?.groupTotal)).toBe(250);
    expect(result.rows.some((row) => row.groupAccount === 'FS1000')).toBe(false);
    const after = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
      return rows[0]!.n;
    });
    expect(after).toBe(before);
  });
});
