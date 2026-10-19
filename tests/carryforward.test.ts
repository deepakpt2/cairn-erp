import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  executeCarryforward, listCarryforwardResults, listCarryforwardRuns,
} from '../src/modules/finance/carryforward';
import { postGlDocument } from '../src/modules/finance/gl-document';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'CF-TEST';
let client = '';
let company = '';

const selection = (testRun: boolean) => ({
  ledger: '0L', companyCodes: [company], targetFiscalYear: 2027, testRun,
});

async function journalCount(): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`);
    return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
  });
}

async function accountBalance(account: string, throughYear: number): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select coalesce(sum(case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end), 0)::text as bal
      from journal_entry_line l
      join journal_entry e on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
      where l.client = ${client} and l.gl_account = ${account} and e.fiscal_year <= ${throughYear} and e.status = 'POSTED'
    `);
    return Number((rows as unknown as Array<{ bal: string }>)[0]?.bal ?? 0);
  });
}

async function post(amount: string, debit: string, credit: string, key: string, date = '2026-06-15') {
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
  const fx = await createTenant('carryforward');
  client = fx.client;
  company = fx.companyCode;
  await defineTestRanges(fx, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values (${client}, 'CA01', 'RETAINED_EARNINGS', '', 'X', '290000', ${ACTOR})
      on conflict do nothing
    `);
    // SCR-121 (OB53): P&L accounts close per indicator; X is the standing one.
    await tx.execute(sql`
      update gl_account set retained_earnings_indicator = 'X'
      where client = ${client} and chart_of_accounts = 'CA01' and gl_account_type = 'PL_STATEMENT'
    `);
  });
  await post('5000', '101000', '300000', 'cf-seed-1'); // cash Dr / revenue Cr
  await post('1500', '400000', '101000', 'cf-seed-2'); // COGS Dr / cash Cr
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
}, 180_000);

describe('SCR-102 G/L balance carryforward F.16 (R-150)', () => {
  it('refuses unconfigured ledgers', async () => {
    await expect(executeCarryforward({
      client, changedBy: ACTOR,
      selection: { ledger: '9X', companyCodes: [company], targetFiscalYear: 2027, testRun: true },
    })).rejects.toThrow('is not configured');
  });

  it('tests without posting, then transfers P&L to retained earnings exactly once per delta', async () => {
    const journalsBefore = await journalCount();
    const test = await executeCarryforward({ client, changedBy: ACTOR, selection: selection(true) });
    expect(test.status).toBe('COMPLETED');
    expect(test.transferDocuments).toEqual([]);
    expect(await journalCount()).toBe(journalsBefore); // test posts nothing
    const testResults = await listCarryforwardResults(client, test.runId);
    const revenue = testResults.find((r) => r.accountNumber === '300000');
    expect(revenue?.sourceClosingBalance).toBe(-5000);
    expect(revenue?.targetOpeningBalance).toBe(0);
    const cash = testResults.find((r) => r.accountNumber === '101000');
    expect(cash?.status).toBe('CARRIED');
    expect(cash?.targetOpeningBalance).toBe(3500);

    const update = await executeCarryforward({ client, changedBy: ACTOR, selection: selection(false) });
    expect(update.status).toBe('COMPLETED');
    expect(update.transferDocuments).toHaveLength(1);
    expect(await journalCount()).toBe(journalsBefore + 1);
    expect(await accountBalance('300000', 2026)).toBe(0); // P&L closed inside the source year
    expect(await accountBalance('400000', 2026)).toBe(0);
    expect(await accountBalance('290000', 2026)).toBe(-3500); // retained earnings credited
    const updateResults = await listCarryforwardResults(client, update.runId);
    expect(updateResults.find((r) => r.accountNumber === '300000')?.status).toBe('TRANSFERRED');
    const retainedRow = updateResults.find((r) => r.accountNumber === '290000');
    expect(retainedRow?.targetOpeningBalance).toBe(-3500);

    const repeat = await executeCarryforward({ client, changedBy: ACTOR, selection: selection(false) });
    expect(repeat.status).toBe('COMPLETED');
    expect(repeat.transferDocuments).toEqual([]); // delta zero — nothing reposted
    expect(await journalCount()).toBe(journalsBefore + 1);

    // A late prior-year adjustment flows through as a delta-only transfer.
    await post('200', '400000', '101000', 'cf-late-1', '2026-11-30');
    const delta = await executeCarryforward({ client, changedBy: ACTOR, selection: selection(false) });
    expect(delta.transferDocuments).toHaveLength(1);
    expect(await journalCount()).toBe(journalsBefore + 3); // +update, +late posting, +delta
    expect(await accountBalance('400000', 2026)).toBe(0);
    expect(await accountBalance('290000', 2026)).toBe(-3300);

    const runs = await listCarryforwardRuns(client);
    expect(runs.length).toBeGreaterThanOrEqual(4); // full history preserved
  });

  it('flags the missing retained-earnings determination as an exception', async () => {
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        delete from account_determination
        where client = ${client} and chart_of_accounts = 'CA01' and event = 'RETAINED_EARNINGS'
      `);
    });
    // A fresh nonzero P&L balance is what an update run would have to close;
    // with no determination standing (SCR-121/OB53) the test run flags it.
    await post('100', '400000', '101000', 'cf-missing-1', '2026-11-30');
    const run = await executeCarryforward({ client, changedBy: ACTOR, selection: selection(true) });
    expect(run.status).toBe('FAILED');
    expect(run.errors).toBeGreaterThan(0);
    const results = await listCarryforwardResults(client, run.runId);
    expect(results.some((r) => r.status === 'EXCEPTION' && (r.detail ?? '').includes('OB53'))).toBe(true);
  });
});
