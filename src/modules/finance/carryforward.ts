/**
 * G/L balance carryforward (SCR-102 / FIN.CLOSE.CARRYFORWARD,
 * F.16/FAGLGVTR).
 *
 * Balances derive from the posted journal at read time, so the
 * carryforward records balance-sheet openings in its result rows
 * (no duplicate balance table) and closes P&L accounts with a
 * real judged transfer document into the source year against the
 * determined retained earnings account. Because the transfer
 * lands inside the source-year totals, repeat runs post only the
 * still-untransferred delta — late adjustments included — and a
 * test run changes nothing. The carryforward never closes the
 * prior year and never locks a period.
 */

export const CARRYFORWARD_CAPABILITY = 'FIN.CLOSE.CARRYFORWARD';

/** The delivered ledger vocabulary; multi-ledger is deferred. */
export const CLOSE_LEDGERS = ['0L'] as const;
export const DEFAULT_LEDGER = '0L';

export const RUN_STATUSES = ['RUNNING', 'COMPLETED', 'FAILED'] as const;
export type CarryforwardRunStatus = (typeof RUN_STATUSES)[number];

export const RESULT_STATUSES = ['CARRIED', 'TRANSFERRED', 'EXCEPTION'] as const;
export type CarryforwardResultStatus = (typeof RESULT_STATUSES)[number];

export interface CarryforwardSelection {
  ledger: string;
  companyCodes: string[];
  targetFiscalYear: number;
  testRun: boolean;
}

export interface CarryforwardRunView {
  runId: string;
  ledger: string;
  sourceFiscalYear: number;
  targetFiscalYear: number;
  companyCodes: string[];
  testRun: boolean;
  status: CarryforwardRunStatus;
  accountsProcessed: number;
  balancesCarried: number;
  plTransferred: number;
  errors: number;
  transferDocuments: string[];
  executedBy: string;
  startedAt: string;
  endedAt: string | null;
}

export interface CarryforwardResultView {
  companyCode: string;
  accountNumber: string;
  accountCategory: 'BALANCE_SHEET' | 'PL_STATEMENT';
  profitCenter: string | null;
  currency: string;
  sourceClosingBalance: number;
  targetOpeningBalance: number;
  retainedEarningsAccount: string | null;
  transferDocumentNumber: string | null;
  status: CarryforwardResultStatus;
  detail: string | null;
}

export class CarryforwardError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CarryforwardError';
    this.remedy = remedy;
  }
}

import { sql } from 'drizzle-orm';
import { and, eq } from 'drizzle-orm';
import { withTenant } from '@/platform/db/client';
import { fromScaled, toScaled } from '@/platform/posting/decimal';
import { getCompanyCode } from '@/platform/periods';
import { accountDetermination } from '@/modules/foundation/schema';
import { postGlDocument } from './gl-document';

function newRunId(): string {
  return `CF${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0')}`.slice(0, 24);
}

function fail(message: string, remedy?: string): never {
  throw new CarryforwardError(message, remedy);
}

interface BalanceRow {
  account: string; profitCenter: string; balance: bigint; category: string | null;
  indicator: string;
}

async function companyBalances(client: string, companyCode: string, chart: string, sourceYear: number): Promise<BalanceRow[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select l.gl_account as account, coalesce(l.profit_center, '') as profit_center,
             sum(case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end)::text as balance,
             a.gl_account_type as category,
             coalesce(a.retained_earnings_indicator, '') as indicator
      from journal_entry_line l
      join journal_entry e
        on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
      left join gl_account a
        on a.client = l.client and a.chart_of_accounts = ${chart} and a.account_number = l.gl_account
      where l.client = ${client} and e.company_code = ${companyCode}
        and e.fiscal_year <= ${sourceYear} and e.status = 'POSTED'
      group by l.gl_account, coalesce(l.profit_center, ''), a.gl_account_type, coalesce(a.retained_earnings_indicator, '')
      order by l.gl_account, profit_center
    `);
    return (rows as unknown as Array<{ account: string; profit_center: string; balance: string; category: string | null; indicator: string }>).map((r) => ({
      account: r.account, profitCenter: r.profit_center,
      balance: toScaled(r.balance ?? '0'), category: r.category,
      indicator: r.indicator ?? '',
    }));
  });
}

/**
 * Retained earnings determinations of one chart (SCR-121 / OB53):
 * indicator → retained earnings account. The indicator stands in the
 * determination's general-modifier slot; the valuation class stays blank.
 */
async function retainedEarningsDeterminations(client: string, chart: string): Promise<Map<string, string>> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(accountDetermination).where(and(
      eq(accountDetermination.client, client),
      eq(accountDetermination.chartOfAccounts, chart),
      eq(accountDetermination.event, 'RETAINED_EARNINGS'),
      eq(accountDetermination.valuationClass, ''),
    ));
    const map = new Map<string, string>();
    for (const row of rows) {
      const indicator = (row.generalModifier ?? '').trim().toUpperCase();
      if (indicator) map.set(indicator, row.glAccount);
    }
    return map;
  });
}

export async function executeCarryforward(input: {
  client: string; changedBy: string; selection: CarryforwardSelection;
}): Promise<CarryforwardRunView> {
  const { client, changedBy } = input;
  const s = { ...input.selection, companyCodes: [...new Set(input.selection.companyCodes.map((c) => c.trim()).filter(Boolean))] };
  if (!CLOSE_LEDGERS.includes(s.ledger as (typeof CLOSE_LEDGERS)[number])) {
    fail(`Ledger ${s.ledger || '(blank)'} is not configured.`, `Configured ledgers: ${CLOSE_LEDGERS.join(', ')}.`);
  }
  if (s.companyCodes.length === 0) fail('Select at least one company code.');
  if (!Number.isInteger(s.targetFiscalYear) || s.targetFiscalYear < 1901 || s.targetFiscalYear > 2199) {
    fail('A valid target fiscal year following the source year is required.');
  }
  const sourceYear = s.targetFiscalYear - 1;
  const runId = newRunId();

  await withTenant(client, async (tx) => {
    if (!s.testRun) {
      const running = await tx.execute(sql`
        select run_id, company_codes from carryforward_run
        where client = ${client} and ledger = ${s.ledger} and target_fiscal_year = ${s.targetFiscalYear}
          and is_test_run = false and status = 'RUNNING'
      `);
      for (const row of running as unknown as Array<{ run_id: string; company_codes: string }>) {
        const overlap = row.company_codes.split(',').filter((c) => s.companyCodes.includes(c));
        if (overlap.length > 0) {
          fail(`Carryforward run ${row.run_id} already stands RUNNING for ${overlap.join(', ')}.`,
            'Wait for it to finish; test runs never block.');
        }
      }
    }
    await tx.execute(sql`
      insert into carryforward_run
        (client, run_id, ledger, source_fiscal_year, target_fiscal_year, company_codes, is_test_run, status, executed_by)
      values (${client}, ${runId}, ${s.ledger}, ${sourceYear}, ${s.targetFiscalYear},
              ${s.companyCodes.join(',')}, ${s.testRun}, 'RUNNING', ${changedBy})
    `);
  });

  const results: CarryforwardResultView[] = [];
  const transferDocuments: string[] = [];
  let runFailed = false;

  for (const companyCode of s.companyCodes) {
    try {
      const company = await withTenant(client, (tx) => getCompanyCode(tx, client, companyCode));
      if (!company) { fail(`Company code ${companyCode} does not stand.`); }
      const chart = company.chartOfAccounts ?? '';
      const currency = company.currency ?? 'USD';
      const balances = await companyBalances(client, companyCode, chart, sourceYear);
      const determinations = await retainedEarningsDeterminations(client, chart);
      const byAccount = new Map<string, BalanceRow[]>();
      for (const row of balances) byAccount.set(row.account, [...(byAccount.get(row.account) ?? []), row]);

      const plRows0 = balances.filter((r) => r.category === 'PL_STATEMENT');
      // Each retained earnings account earns its opening from the transfer
      // even when nothing stood on it before.
      if (plRows0.length > 0) {
        for (const retainedAccount of new Set(determinations.values())) {
          if (!balances.some((r) => r.account === retainedAccount)) {
            balances.push({ account: retainedAccount, profitCenter: '', balance: 0n, category: 'BALANCE_SHEET', indicator: '' });
          }
        }
      }
      const plRows = balances.filter((r) => r.category === 'PL_STATEMENT');
      const plNet = plRows.reduce((sum, r) => sum + r.balance, 0n);
      // SCR-121: P&L accounts close per indicator (OB53). A nonzero balance
      // whose indicator lacks a determination refuses, naming the accounts.
      const retainedFor = (row: BalanceRow): string | null =>
        row.indicator ? (determinations.get(row.indicator) ?? null) : null;
      const missing = plRows.filter((r) => r.balance !== 0n && !retainedFor(r));
      const plNetByRetained = new Map<string, bigint>();
      for (const row of plRows) {
        if (row.balance === 0n) continue;
        const retainedAccount = retainedFor(row);
        if (retainedAccount) plNetByRetained.set(retainedAccount, (plNetByRetained.get(retainedAccount) ?? 0n) + row.balance);
      }
      let transferDocument: string | null = null;

      if (!s.testRun && plRows.length > 0 && plNet !== 0n || (!s.testRun && plRows.some((r) => r.balance !== 0n))) {
        if (missing.length > 0) {
          const names = missing.map((r) => `${r.account}${r.indicator ? ` (indicator ${r.indicator})` : ' (no indicator)'}`);
          fail(`No retained earnings account stands defined for P&L account(s) ${names.slice(0, 10).join(', ')}${names.length > 10 ? ` and ${names.length - 10} more` : ''}.`,
            'Define the retained earnings account for each indicator used by these accounts (OB53 — Retained Earnings Account definition), set the indicator on the accounts without one, then rerun — reruns post only the delta.');
        }
        const lines: Array<{ glAccount: string; debitCredit: 'S' | 'H'; amount: string; profitCenter?: string; lineText: string }> = [];
        for (const row of plRows) {
          if (row.balance === 0n) continue;
          lines.push({
            glAccount: row.account,
            debitCredit: row.balance > 0n ? 'H' : 'S',
            amount: fromScaled(row.balance > 0n ? row.balance : -row.balance),
            profitCenter: row.profitCenter || undefined,
            lineText: `Carryforward ${sourceYear}→${s.targetFiscalYear}`,
          });
        }
        for (const [retainedAccount, net] of plNetByRetained) {
          if (net === 0n) continue;
          lines.push({
            glAccount: retainedAccount,
            debitCredit: net > 0n ? 'S' : 'H',
            amount: fromScaled(net > 0n ? net : -net),
            lineText: `P&L closing ${sourceYear}`,
          });
        }
        const posted = await postGlDocument({
          client, changedBy, requestKey: `cf-${runId}-${companyCode}`,
          companyCode, documentDate: `${sourceYear}-12-31`, postingDate: `${sourceYear}-12-31`,
          documentType: 'SA', currency, headerText: `Balance carryforward ${s.targetFiscalYear}`,
          lines: lines.map((l) => ({
            glAccount: l.glAccount, debitCredit: l.debitCredit, amount: l.amount,
            profitCenter: l.profitCenter, lineText: l.lineText,
          })),
        });
        transferDocument = posted.displayNumber || posted.documentNumber;
        transferDocuments.push(transferDocument);
      }

      for (const row of balances) {
        const isPl = row.category === 'PL_STATEMENT';
        if (row.category === null) {
          results.push({
            companyCode, accountNumber: row.account, accountCategory: 'BALANCE_SHEET',
            profitCenter: row.profitCenter || null, currency,
            sourceClosingBalance: Number(fromScaled(row.balance)), targetOpeningBalance: 0,
            retainedEarningsAccount: null, transferDocumentNumber: null,
            status: 'EXCEPTION', detail: `Account ${row.account} does not stand in chart ${chart}.`,
          });
          continue;
        }
        if (!isPl) {
          const isRetained = plNetByRetained.has(row.account);
          results.push({
            companyCode, accountNumber: row.account, accountCategory: 'BALANCE_SHEET',
            profitCenter: row.profitCenter || null, currency,
            sourceClosingBalance: Number(fromScaled(row.balance)),
            targetOpeningBalance: Number(fromScaled(row.balance + (plNetByRetained.get(row.account) ?? 0n))),
            retainedEarningsAccount: isRetained ? row.account : null,
            transferDocumentNumber: isRetained ? transferDocument : null,
            status: 'CARRIED',
            detail: isRetained
              ? (s.testRun ? 'Opening includes the P&L result that an update run would transfer.' : 'Opening includes the transferred P&L result.')
              : null,
          });
        } else {
          const retainedAccount = retainedFor(row);
          results.push({
            companyCode, accountNumber: row.account, accountCategory: 'PL_STATEMENT',
            profitCenter: row.profitCenter || null, currency,
            sourceClosingBalance: Number(fromScaled(row.balance)), targetOpeningBalance: 0,
            retainedEarningsAccount: retainedAccount, transferDocumentNumber: transferDocument,
            status: s.testRun ? 'CARRIED' : 'TRANSFERRED',
            detail: s.testRun
              ? `Test run: an update run would close this balance to retained earnings${retainedAccount ? ` ${retainedAccount}` : ' (determination missing)'}.`
              : (retainedAccount ? null : 'Retained earnings determination missing.'),
          });
        }
      }
      // A nonzero P&L balance whose indicator lacks a determination (OB53)
      // is an exception in a test run; an update run already refused above.
      for (const row of missing) {
        const existing = results.find((r) => r.companyCode === companyCode && r.accountNumber === row.account && (r.profitCenter ?? '') === row.profitCenter);
        if (existing) {
          existing.status = 'EXCEPTION';
          existing.detail = row.indicator
            ? `No retained earnings account stands defined for indicator ${row.indicator} in chart ${chart} (OB53).`
            : `Account ${row.account} carries no retained earnings indicator (OB53).`;
        }
      }
    } catch (error) {
      runFailed = true;
      const message = error instanceof Error ? error.message : 'Company processing failed.';
      results.push({
        companyCode, accountNumber: '—', accountCategory: 'BALANCE_SHEET', profitCenter: null,
        currency: '—', sourceClosingBalance: 0, targetOpeningBalance: 0,
        retainedEarningsAccount: null, transferDocumentNumber: null,
        status: 'EXCEPTION', detail: message.slice(0, 240),
      });
    }
  }

  const exceptions = results.filter((r) => r.status === 'EXCEPTION').length;
  const carriedAmount = results.filter((r) => r.status !== 'EXCEPTION')
    .reduce((sum, r) => sum + (r.accountCategory === 'BALANCE_SHEET' ? Math.abs(r.targetOpeningBalance) : 0), 0);
  const plAmount = results.filter((r) => r.accountCategory === 'PL_STATEMENT')
    .reduce((sum, r) => sum + Math.abs(r.sourceClosingBalance), 0);

  await withTenant(client, async (tx) => {
    for (const r of results) {
      await tx.execute(sql`
        insert into carryforward_result
          (client, run_id, company_code, account_number, account_category, profit_center, currency,
           source_closing_balance, target_opening_balance, retained_earnings_account, transfer_document_number, status, detail)
        values (${client}, ${runId}, ${r.companyCode}, ${r.accountNumber}, ${r.accountCategory},
                ${r.profitCenter ?? ''}, ${r.currency}, ${r.sourceClosingBalance.toFixed(4)}, ${r.targetOpeningBalance.toFixed(4)},
                ${r.retainedEarningsAccount}, ${r.transferDocumentNumber}, ${r.status}, ${r.detail})
        on conflict do nothing
      `);
    }
    await tx.execute(sql`
      update carryforward_run set
        status = ${runFailed || exceptions > 0 ? 'FAILED' : 'COMPLETED'},
        accounts_processed = ${new Set(results.map((r) => `${r.companyCode}|${r.accountNumber}`)).size},
        carried_amount = ${carriedAmount.toFixed(4)}, pl_transfer_amount = ${plAmount.toFixed(4)},
        error_count = ${exceptions},
        transfer_documents = ${transferDocuments.length > 0 ? transferDocuments.join(',') : null},
        ended_at = now()
      where client = ${client} and run_id = ${runId}
    `);
  });

  return getCarryforwardRun(client, runId);
}

export async function getCarryforwardRun(client: string, runId: string): Promise<CarryforwardRunView> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select * from carryforward_run where client = ${client} and run_id = ${runId}`);
    const r = (rows as unknown as Array<Record<string, unknown>>)[0];
    if (!r) fail(`Carryforward run ${runId} does not stand.`);
    return {
      runId: String(r.run_id), ledger: String(r.ledger),
      sourceFiscalYear: Number(r.source_fiscal_year), targetFiscalYear: Number(r.target_fiscal_year),
      companyCodes: String(r.company_codes).split(',').filter(Boolean), testRun: Boolean(r.is_test_run),
      status: r.status as CarryforwardRunStatus, accountsProcessed: Number(r.accounts_processed),
      balancesCarried: Number(r.carried_amount), plTransferred: Number(r.pl_transfer_amount),
      errors: Number(r.error_count),
      transferDocuments: r.transfer_documents ? String(r.transfer_documents).split(',') : [],
      executedBy: String(r.executed_by),
      startedAt: new Date(r.started_at as string).toISOString(),
      endedAt: r.ended_at ? new Date(r.ended_at as string).toISOString() : null,
    };
  });
}

export async function listCarryforwardRuns(client: string, limit = 50): Promise<CarryforwardRunView[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select run_id from carryforward_run where client = ${client} order by started_at desc limit ${limit}
    `);
    const views: CarryforwardRunView[] = [];
    for (const r of rows as unknown as Array<{ run_id: string }>) views.push(await getCarryforwardRun(client, r.run_id));
    return views;
  });
}

export async function listCarryforwardResults(client: string, runId: string): Promise<CarryforwardResultView[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select * from carryforward_result where client = ${client} and run_id = ${runId}
      order by company_code, account_number, profit_center
    `);
    return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
      companyCode: String(r.company_code), accountNumber: String(r.account_number),
      accountCategory: r.account_category as 'BALANCE_SHEET' | 'PL_STATEMENT',
      profitCenter: r.profit_center ? String(r.profit_center) : null, currency: String(r.currency),
      sourceClosingBalance: Number(r.source_closing_balance), targetOpeningBalance: Number(r.target_opening_balance),
      retainedEarningsAccount: (r.retained_earnings_account as string) ?? null,
      transferDocumentNumber: (r.transfer_document_number as string) ?? null,
      status: r.status as CarryforwardResultStatus, detail: (r.detail as string) ?? null,
    }));
  });
}
