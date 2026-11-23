/**
 * Manual bank statement reconciliation — finance.
 *
 * A statement is entered by hand for one house-bank account and compared with the posted bank G/L
 * history. A confirmed match is reconciliation evidence only: it creates no journal, clears no AR/AP
 * item and marks no payment as bank-executed. Bank fees and missing receipts are posted through the
 * ordinary posting services first; the resulting bank line is then matched.
 *
 * Sign convention: the stored statement amount and every reported "signed" figure are debit-to-bank
 * positive. Money into the bank account (a deposit) is positive; money out (a withdrawal or bank fee)
 * is negative. The ledger side uses the same sign: a debit to the bank asset is positive and a credit
 * is negative. Overdrawn balances are therefore ordinary negative numbers.
 *
 * Reconciliation happens in the bank account's own currency. A posted bank line is comparable when
 * the line itself is in that currency, or when it is in the company local currency (the document's
 * local amount is then the carrying amount). A line in any other currency — a legacy entry with no
 * trustworthy account-currency evidence — is a blocking issue and is never converted at today's
 * rate. Local-currency carrying amounts are preserved beside the account-currency movement.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import {
  authorizeCompaniesAnyInTx,
  verifyCompanyAuthorityAnyInTx,
  type CompanyAuthority,
} from '../../platform/auth/company-scope';
import { hasOrgAccess } from '../../platform/auth/session';
import type { ServiceAuthorityContext } from '../../platform/auth/service-authority';
import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { getCompanyCode } from '../../platform/periods';
import { divideRound } from '../../platform/posting/decimal';
import { type Money, MoneyError, moneyFor } from '../../platform/posting/money';
import { bankAccount } from '../foundation/schema';
import {
  bankReconciliationMatch,
  bankReconciliationSnapshot,
  bankStatement,
  bankStatementLine,
} from './schema';

export const BANK_STATEMENT_DISPLAY_CAPABILITY = 'FIN.BANK.STATEMENT.DISPLAY';
export const BANK_STATEMENT_ENTER_CAPABILITY = 'FIN.BANK.STATEMENT.ENTER';
export const BANK_STATEMENT_MATCH_CAPABILITY = 'FIN.BANK.STATEMENT.MATCH';
export const BANK_STATEMENT_FINALIZE_CAPABILITY = 'FIN.BANK.STATEMENT.FINALIZE';

const READ_CAPABILITIES = [
  BANK_STATEMENT_DISPLAY_CAPABILITY,
  BANK_STATEMENT_ENTER_CAPABILITY,
  BANK_STATEMENT_MATCH_CAPABILITY,
  BANK_STATEMENT_FINALIZE_CAPABILITY,
] as const;

const STATEMENT_CLASS = 'bank_statement';
const MATCH_CLASS = 'bank_statement_match';

export class BankReconciliationError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'BankReconciliationError';
    this.remedy = remedy;
  }
}

export interface BankAccountChoice {
  companyCode: string;
  houseBankKey: string;
  accountId: string;
  accountNumber: string;
  iban: string | null;
  currency: string;
  glAccount: string;
  companyName: string;
  companyCurrency: string;
}

export interface BankStatementLineInput {
  lineId?: string;
  /** IN = money into the bank account; OUT = money out. */
  direction: 'IN' | 'OUT';
  amount: string;
  valueDate: string;
  transactionDate?: string;
  bankReference?: string;
  description?: string;
}

export interface SaveBankStatementInput {
  client: string;
  statementId?: string;
  companyCode: string;
  houseBankKey: string;
  accountId: string;
  statementReference: string;
  fromDate: string;
  toDate: string;
  currency: string;
  openingBalance: string;
  closingBalance: string;
  baseline?: boolean;
  baselineAmount?: string;
  baselineReason?: string;
  lines: BankStatementLineInput[];
  requestKey?: string;
}

export interface MatchInput {
  client: string;
  statementId: string;
  allocations: Array<{
    statementLineId: string;
    ledgerDocumentNumber: string;
    ledgerFiscalYear: number;
    ledgerLineNumber: number;
    amount: string;
  }>;
  requestKey?: string;
}

export interface BankMatchView {
  matchId: string;
  statementLineId: string;
  ledgerDocumentNumber: string;
  ledgerFiscalYear: number;
  ledgerLineNumber: number;
  /** The allocation in the bank account currency. */
  amount: string;
  /** The same allocation as a local-currency carrying amount. */
  localAmount: string;
  isActive: boolean;
  matchedBy: string;
  matchedAt: string;
  unmatchedBy: string | null;
  unmatchedAt: string | null;
  unmatchReason: string | null;
}

export interface BankStatementLineView {
  lineId: string;
  lineNumber: number;
  valueDate: string;
  transactionDate: string;
  direction: 'IN' | 'OUT';
  amount: string;
  signedAmount: string;
  bankReference: string;
  description: string;
  matchedAmount: string;
  remainingAmount: string;
  matches: BankMatchView[];
}

export interface BankLedgerLineView {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  documentType: string;
  reference: string;
  assignment: string;
  originClass: string | null;
  originKey: string | null;
  businessPartner: string | null;
  /** 'IN'/'OUT' and amounts are in the bank account currency. */
  direction: 'IN' | 'OUT';
  amount: string;
  signedAmount: string;
  matchedAmount: string;
  remainingAmount: string;
  /** Remaining amount when only matches up to the statement's as-of date count. */
  asOfRemainingAmount: string;
  /** The movement's local-currency carrying amount, preserved separately. */
  localCurrency: string;
  localAmount: string;
  /**
   * BANK: a real movement in the account currency, matchable to a statement line.
   * FX_VALUATION: a proven period-end valuation adjustment in local currency only. It changes the
   * bank G/L's local carrying amount but never the account-currency balance, so it is not matchable.
   */
  kind: 'BANK' | 'FX_VALUATION';
  matchable: boolean;
  matches: BankMatchView[];
}

export interface PriorStatementLineView extends BankStatementLineView {
  statementId: string;
  statementReference: string;
  toDate: string;
}

export interface BankReconciliationIssue {
  code: string;
  message: string;
  /** A blocking issue prevents finalization; a displayed issue is informative. */
  blocking: boolean;
}

export interface BankBridgeView {
  currency: string;
  statementOpening: string;
  statementClosing: string;
  ledgerOpening: string;
  ledgerClosing: string;
  closingDifference: string;
  matchedStatementAmount: string;
  matchedLedgerAmount: string;
  unmatchedStatementAmount: string;
  unmatchedLedgerAmount: string;
  baselineAmount: string;
  unexplainedDifference: string;
  /** statement opening − ledger opening; explains a cutover baseline without hiding it. */
  openingDifference: string;
}

export interface BankStatementSummary {
  statementId: string;
  statementReference: string;
  fromDate: string;
  toDate: string;
  currency: string;
  openingBalance: string;
  closingBalance: string;
  status: string;
  baseline: boolean;
  baselineAmount: string;
  finalizedBy: string | null;
  finalizedAt: string | null;
  reopenedBy: string | null;
  reopenedAt: string | null;
}

export interface BankSnapshotView {
  snapshotId: string;
  sequence: number;
  finalizedBy: string;
  finalizedAt: string;
  ledgerOpeningBalance: string;
  ledgerClosingBalance: string;
  unmatchedStatementAmount: string;
  unmatchedLedgerAmount: string;
  baselineAmount: string;
  unexplainedDifference: string;
  matchCount: number;
  outstandingCount: number;
}

export interface BankReconciliationView {
  companyCode: string;
  houseBankKey: string;
  accountId: string;
  accountNumber: string;
  iban: string | null;
  currency: string;
  glAccount: string;
  companyCurrency: string;
  statements: BankStatementSummary[];
  statement: (BankStatementSummary & {
    lines: BankStatementLineView[];
    arithmeticValid: boolean;
    arithmeticDifference: string;
  }) | null;
  bridge: BankBridgeView | null;
  ledgerLines: BankLedgerLineView[];
  priorStatementLines: PriorStatementLineView[];
  snapshots: BankSnapshotView[];
  issues: BankReconciliationIssue[];
  /** True when a finalized statement no longer agrees with the current ledger/match history. */
  changedSinceSnapshot: boolean;
  changeReasons: string[];
}

interface LoadedAccount {
  companyCode: string;
  houseBankKey: string;
  accountId: string;
  accountNumber: string;
  iban: string | null;
  currency: string;
  glAccount: string;
  companyCurrency: string;
  companyName: string;
}

interface LedgerRow {
  document_number: string;
  fiscal_year: number;
  line_number: number;
  posting_date: string;
  document_type: string;
  reference: string | null;
  assignment: string | null;
  currency: string;
  local_currency: string;
  debit_credit: string;
  amount_document: string;
  amount_local: string;
  origin_class: string | null;
  origin_key: string | null;
  business_partner: string | null;
  line_text: string | null;
  is_fx_valuation: boolean;
  /** Actual-bank-amount evidence from the payment/run record that posted this line, if any. */
  incoming_bank_source: string | null;
  outgoing_bank_source: string | null;
  run_bank_source: string | null;
}

interface MatchRow {
  match_id: string;
  statement_id: string;
  statement_line_id: string;
  ledger_document_number: string;
  ledger_fiscal_year: number;
  ledger_line_number: number;
  allocated_amount: string;
  allocated_local_amount: string;
  currency: string;
  is_active: boolean;
  matched_by: string;
  matched_at: Date;
  unmatched_by: string | null;
  unmatched_at: Date | null;
  unmatch_reason: string | null;
  statement_to_date: string;
  statement_status: string;
}

function fail(message: string, remedy?: string): never {
  throw new BankReconciliationError(message, remedy);
}

function assertCalendarDate(label: string, value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) fail(`${label} ${value || '(none)'} is not a calendar date.`, 'Enter the date as YYYY-MM-DD.');
  const [, y, m, d] = match.map(Number) as unknown as [number, number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    fail(`${label} ${value} is not a real calendar date.`, 'Enter the date as YYYY-MM-DD.');
  }
}

async function moneyOrThrow(tx: Tx, currency: string): Promise<Money> {
  try {
    return await moneyFor(tx, currency);
  } catch (error) {
    if (error instanceof MoneyError) fail(error.message, error.remedy);
    throw error;
  }
}

function entered(money: Money, value: string, label: string): bigint {
  try {
    return money.entered(value, label);
  } catch (error) {
    if (error instanceof MoneyError) fail(error.message, error.remedy);
    throw error;
  }
}

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const candidate = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const code = candidate.code ?? candidate.cause?.code;
  const name = candidate.constraint ?? candidate.cause?.constraint;
  if (constraint) return code === '23505' && (name ?? '').includes(constraint);
  return code === '23505';
}

async function authorityFor(
  tx: Tx,
  client: string,
  authorization: ServiceAuthorityContext | undefined,
  capabilities: readonly string[],
  companyCode: string,
): Promise<CompanyAuthority> {
  const verdict = await authorizeCompaniesAnyInTx(tx, client, authorization, capabilities, [companyCode]);
  if (!verdict.ok) fail(verdict.refusal.message, verdict.refusal.remedy);
  return { username: verdict.username, restrictions: verdict.restrictions };
}

async function loadCompanyAndAccount(
  tx: Tx,
  client: string,
  companyCode: string,
  houseBankKey: string,
  accountId: string,
): Promise<LoadedAccount> {
  const company = await getCompanyCode(tx, client, companyCode);
  if (!company?.isActive) {
    fail(`Company code ${companyCode} is not active or does not exist.`, 'Choose an active company code in this tenant.');
  }
  const [account] = await tx.select().from(bankAccount).where(and(
    eq(bankAccount.client, client),
    eq(bankAccount.companyCode, companyCode),
    eq(bankAccount.houseBankKey, houseBankKey),
    eq(bankAccount.accountId, accountId),
  ));
  if (!account) {
    fail(
      `Bank account ${houseBankKey}/${accountId} does not stand for company ${companyCode}.`,
      'Choose a house-bank account configured for this company in house bank maintenance.',
    );
  }
  const currency = account.currency.trim().toUpperCase();
  const companyCurrency = company.currency.trim().toUpperCase();
  const shared = (await tx.execute(sql`
    select count(*)::int as n
      from bank_account
     where client = ${client} and company_code = ${companyCode} and gl_account = ${account.glAccount}
  `)) as unknown as Array<{ n: number }>;
  if ((shared[0]?.n ?? 0) > 1) {
    fail(
      `G/L account ${account.glAccount} is shared by ${shared[0]!.n} bank accounts in company ${companyCode}, so a posted line cannot be attributed to ${houseBankKey}/${accountId}.`,
      'Give each bank account its own bank G/L account in house bank maintenance. Reconciliation refuses an ambiguous account rather than guessing ownership from amounts or references.',
    );
  }
  return {
    companyCode,
    houseBankKey: account.houseBankKey,
    accountId: account.accountId,
    accountNumber: account.accountNumber,
    iban: account.iban,
    currency,
    glAccount: account.glAccount,
    companyCurrency,
    companyName: company.name,
  };
}

/** The bank accounts the caller may reconcile: inside the live Company Code and bank capacity. */
export async function listReconcilableBankAccounts(input: {
  client: string;
  authorization?: ServiceAuthorityContext;
}): Promise<BankAccountChoice[]> {
  return withTenant(input.client, async (tx) => {
    const verdict = await verifyCompanyAuthorityAnyInTx(tx, input.client, input.authorization, READ_CAPABILITIES);
    if (!verdict.ok) fail(verdict.refusal.message, verdict.refusal.remedy);
    const rows = (await tx.execute(sql`
      select a.company_code, a.house_bank_key, a.account_id, a.account_number, a.iban,
             a.currency, a.gl_account, c.name as company_name, c.currency as company_currency
        from bank_account a
        join company_code c on c.client = a.client and c.company_code = a.company_code
       where a.client = ${input.client}
       order by a.company_code, a.house_bank_key, a.account_id
    `)) as unknown as Array<{
      company_code: string; house_bank_key: string; account_id: string; account_number: string;
      iban: string | null; currency: string; gl_account: string; company_name: string; company_currency: string;
    }>;
    return rows
      .filter((row) => hasOrgAccess(verdict.restrictions, 'COMPANY_CODE', row.company_code.trim()))
      .map((row) => ({
        companyCode: row.company_code.trim(),
        houseBankKey: row.house_bank_key.trim(),
        accountId: row.account_id.trim(),
        accountNumber: row.account_number,
        iban: row.iban,
        currency: row.currency.trim(),
        glAccount: row.gl_account,
        companyName: row.company_name,
        companyCurrency: row.company_currency.trim(),
      }));
  });
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function matchView(row: MatchRow): BankMatchView {
  return {
    matchId: row.match_id,
    statementLineId: row.statement_line_id,
    ledgerDocumentNumber: row.ledger_document_number,
    ledgerFiscalYear: row.ledger_fiscal_year,
    ledgerLineNumber: row.ledger_line_number,
    amount: row.allocated_amount,
    localAmount: row.allocated_local_amount,
    isActive: row.is_active,
    matchedBy: row.matched_by,
    matchedAt: toIso(row.matched_at)!,
    unmatchedBy: row.unmatched_by,
    unmatchedAt: toIso(row.unmatched_at),
    unmatchReason: row.unmatch_reason,
  };
}

function signedUnits(money: Money, signed: string): bigint {
  return entered(money, signed, 'The amount');
}

interface Calculation {
  view: BankReconciliationView;
  statementRow: typeof bankStatement.$inferSelect | null;
  account: LoadedAccount;
  money: Money;
  bridgeUnits: {
    statementOpening: bigint;
    statementClosing: bigint;
    ledgerOpening: bigint;
    ledgerClosing: bigint;
    matchedStatement: bigint;
    matchedLedger: bigint;
    unmatchedStatement: bigint;
    unmatchedLedger: bigint;
    baseline: bigint;
    unexplained: bigint;
  };
  issues: BankReconciliationIssue[];
  blocking: boolean;
}

async function calculate(
  tx: Tx,
  client: string,
  account: LoadedAccount,
  statementRow: typeof bankStatement.$inferSelect | null,
): Promise<Calculation> {
  const money = await moneyOrThrow(tx, account.currency);
  const localMoney = await moneyOrThrow(tx, account.companyCurrency);
  const issues: BankReconciliationIssue[] = [];
  const changeReasons: string[] = [];

  const statements = (await tx.execute(sql`
    select statement_id, statement_reference, from_date::text, to_date::text, currency,
           opening_balance::text, closing_balance::text, status, baseline, baseline_amount::text,
           finalized_by, finalized_at, reopened_by, reopened_at
      from bank_statement
     where client = ${client} and company_code = ${account.companyCode}
       and house_bank_key = ${account.houseBankKey} and account_id = ${account.accountId}
     order by to_date desc, statement_reference desc
  `)) as unknown as Array<{
    statement_id: string; statement_reference: string; from_date: string; to_date: string; currency: string;
    opening_balance: string; closing_balance: string; status: string; baseline: boolean;
    baseline_amount: string; finalized_by: string | null; finalized_at: Date | null;
    reopened_by: string | null; reopened_at: Date | null;
  }>;

  const statementSummaries: BankStatementSummary[] = statements.map((row) => ({
    statementId: row.statement_id,
    statementReference: row.statement_reference,
    fromDate: row.from_date,
    toDate: row.to_date,
    currency: row.currency.trim(),
    openingBalance: row.opening_balance,
    closingBalance: row.closing_balance,
    status: row.status,
    baseline: row.baseline,
    baselineAmount: row.baseline_amount,
    finalizedBy: row.finalized_by,
    finalizedAt: toIso(row.finalized_at),
    reopenedBy: row.reopened_by,
    reopenedAt: toIso(row.reopened_at),
  }));

  if (!statementRow) {
    return {
      view: {
        ...account,
        statements: statementSummaries,
        statement: null,
        bridge: null,
        ledgerLines: [],
        priorStatementLines: [],
        snapshots: [],
        issues,
        changedSinceSnapshot: false,
        changeReasons,
      },
      statementRow: null,
      account,
      money,
      bridgeUnits: {
        statementOpening: 0n, statementClosing: 0n, ledgerOpening: 0n, ledgerClosing: 0n,
        matchedStatement: 0n, matchedLedger: 0n, unmatchedStatement: 0n, unmatchedLedger: 0n,
        baseline: 0n, unexplained: 0n,
      },
      issues,
      blocking: false,
    };
  }

  const asOf = statementRow.toDate;
  const fromDate = statementRow.fromDate;
  const currency = statementRow.currency.trim().toUpperCase();
  if (currency !== account.currency) {
    fail(
      `Statement ${statementRow.statementReference} stands in ${currency}, but account ${account.houseBankKey}/${account.accountId} stands in ${account.currency}.`,
      'Enter the statement in the bank account currency.',
    );
  }

  // Ledger lines by their actual posting dates. An original counts until its reversal is effective:
  // a journal reversed on 1 February contributes to a 31 January as-of balance and cancels itself
  // afterwards. The mirror document is never counted on its own (the pair nets to zero), so the
  // series is neither double counted nor lost. Parked documents never contribute.
  const ledgerRows = (await tx.execute(sql`
    select l.document_number, l.fiscal_year, l.line_number, e.posting_date::text as posting_date,
           e.document_type, e.reference, l.assignment, l.currency, e.local_currency, l.debit_credit,
           l.amount_document::text as amount_document, l.amount_local::text as amount_local,
           e.origin_class, e.origin_key, l.business_partner, l.line_text, e.is_fx_valuation,
           (select ip.bank_amount_source from incoming_payment ip
             where ip.client = l.client and ip.journal_document_number = l.document_number limit 1) as incoming_bank_source,
           (select op.bank_amount_source from outgoing_payment op
             where op.client = l.client and op.journal_document_number = l.document_number limit 1) as outgoing_bank_source,
           (select pd.bank_amount_source from payment_document pd
             where pd.client = l.client and pd.journal_document_number = l.document_number limit 1) as run_bank_source
      from journal_entry_line l
      join journal_entry e
        on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
     where l.client = ${client} and l.company_code = ${account.companyCode}
       and l.gl_account = ${account.glAccount}
       and e.reversal_of is null
       and e.posting_date <= ${asOf}
       and (
         e.status = 'POSTED'
         or (
           e.status = 'REVERSED'
           and not exists (
             select 1 from journal_entry rev
              where rev.client = e.client and rev.document_number = e.reversed_by
                and rev.reversal_of = e.document_number
                and rev.status = 'POSTED' and rev.posting_date <= ${asOf}
           )
         )
       )
     order by e.posting_date, l.document_number, l.line_number
  `)) as unknown as LedgerRow[];

  // A reversed bank journal must name its mirror. Without it the as-of balance cannot be proved, so
  // the reconciliation refuses rather than guessing which side of the reversal date applies.
  const brokenReversals = (await tx.execute(sql`
    select distinct e.document_number, e.fiscal_year
      from journal_entry e
      join journal_entry_line l
        on l.client = e.client and l.document_number = e.document_number and l.fiscal_year = e.fiscal_year
     where e.client = ${client} and e.company_code = ${account.companyCode}
       and l.gl_account = ${account.glAccount}
       and e.status = 'REVERSED' and e.reversal_of is null
       and not exists (
         select 1 from journal_entry rev
          where rev.client = e.client and rev.reversal_of = e.document_number
       )
     order by e.document_number
  `)) as unknown as Array<{ document_number: string; fiscal_year: number }>;
  for (const row of brokenReversals) {
    issues.push({
      code: 'REVERSAL_EVIDENCE',
      message: `Bank journal ${row.document_number}/${row.fiscal_year} stands REVERSED but has no mirror document, so its as-of balance cannot be proved.`,
      blocking: true,
    });
  }

  const matchRows = (await tx.execute(sql`
    select m.match_id, m.statement_id, m.statement_line_id,
           m.ledger_document_number, m.ledger_fiscal_year, m.ledger_line_number,
           m.allocated_amount::text as allocated_amount,
           m.allocated_local_amount::text as allocated_local_amount, m.currency, m.is_active,
           m.matched_by, m.matched_at, m.unmatched_by, m.unmatched_at, m.unmatch_reason,
           s.to_date::text as statement_to_date, s.status as statement_status
      from bank_reconciliation_match m
      join bank_statement s on s.client = m.client and s.statement_id = m.statement_id
     where m.client = ${client} and m.company_code = ${account.companyCode}
       and m.house_bank_key = ${account.houseBankKey} and m.account_id = ${account.accountId}
     order by m.matched_at, m.match_id
  `)) as unknown as MatchRow[];

  const allAllocationsByLine = new Map<string, MatchRow[]>();
  const asOfAllocationsByLine = new Map<string, MatchRow[]>();
  const allocationsByLedger = new Map<string, MatchRow[]>();
  const asOfAllocationsByLedger = new Map<string, MatchRow[]>();
  const allocationsByStatement = new Map<string, MatchRow[]>();
  const historyByLine = new Map<string, MatchRow[]>();
  const historyByLedger = new Map<string, MatchRow[]>();
  for (const row of matchRows) {
    const lineHistory = historyByLine.get(row.statement_line_id) ?? [];
    lineHistory.push(row);
    historyByLine.set(row.statement_line_id, lineHistory);

    const ledgerHistoryKey = `${row.ledger_document_number}|${row.ledger_fiscal_year}|${row.ledger_line_number}`;
    const ledgerHistory = historyByLedger.get(ledgerHistoryKey) ?? [];
    ledgerHistory.push(row);
    historyByLedger.set(ledgerHistoryKey, ledgerHistory);

    if (!row.is_active) continue;
    const lineList = allAllocationsByLine.get(row.statement_line_id) ?? [];
    lineList.push(row);
    allAllocationsByLine.set(row.statement_line_id, lineList);

    const statementList = allocationsByStatement.get(row.statement_id) ?? [];
    statementList.push(row);
    allocationsByStatement.set(row.statement_id, statementList);

    const ledgerKey = `${row.ledger_document_number}|${row.ledger_fiscal_year}|${row.ledger_line_number}`;
    const ledgerList = allocationsByLedger.get(ledgerKey) ?? [];
    ledgerList.push(row);
    allocationsByLedger.set(ledgerKey, ledgerList);

    // The as-of calculation counts a match only when the statement it belongs to is dated on or
    // before this statement's date. A later statement cannot retroactively change an earlier view.
    if (row.statement_to_date <= asOf) {
      const asOfLineList = asOfAllocationsByLine.get(row.statement_line_id) ?? [];
      asOfLineList.push(row);
      asOfAllocationsByLine.set(row.statement_line_id, asOfLineList);
      const asOfLedgerList = asOfAllocationsByLedger.get(ledgerKey) ?? [];
      asOfLedgerList.push(row);
      asOfAllocationsByLedger.set(ledgerKey, asOfLedgerList);
    }
  }

  function allocationTotal(rows: readonly MatchRow[] | undefined): bigint {
    let total = 0n;
    for (const row of rows ?? []) total += entered(money, row.allocated_amount, 'An allocated amount');
    return total;
  }

  const ledgerLines: BankLedgerLineView[] = [];
  let ledgerOpening = 0n;
  let ledgerClosing = 0n;
  for (const row of ledgerRows) {
    const lineCurrency = row.currency.trim().toUpperCase();
    const rowLocalCurrency = row.local_currency.trim().toUpperCase();
    const localUnits = entered(localMoney, row.amount_local, `Ledger line ${row.document_number}/${row.line_number}`);
    const direction = row.debit_credit === 'S' ? 1n : -1n;
    const signedLocal = localUnits * direction;
    const key = `${row.document_number}|${row.fiscal_year}|${row.line_number}`;
    // A period-end FX valuation is proven by its persisted provenance, not by its text. It changes
    // only the local carrying amount; it is never an account-currency bank movement and is never
    // matchable. A valuation line that is not local-only is an accounting error, so it blocks.
    if (row.is_fx_valuation) {
      if (lineCurrency !== rowLocalCurrency) {
        issues.push({
          code: 'VALUATION_CURRENCY',
          message: `FX valuation line ${row.document_number}/${row.line_number} is not local-only (line ${row.currency}, local ${row.local_currency}); its account-currency effect cannot be established.`,
          blocking: true,
        });
      }
      ledgerLines.push({
        documentNumber: row.document_number,
        fiscalYear: row.fiscal_year,
        lineNumber: row.line_number,
        postingDate: row.posting_date,
        documentType: row.document_type,
        reference: row.reference ?? '',
        assignment: row.assignment ?? '',
        originClass: row.origin_class,
        originKey: row.origin_key,
        businessPartner: row.business_partner,
        direction: direction > 0n ? 'IN' : 'OUT',
        amount: money.fromUnits(0n),
        signedAmount: money.fromUnits(0n),
        matchedAmount: money.fromUnits(0n),
        remainingAmount: money.fromUnits(0n),
        asOfRemainingAmount: money.fromUnits(0n),
        localCurrency: account.companyCurrency,
        localAmount: localMoney.fromUnits(signedLocal < 0n ? -signedLocal : signedLocal),
        kind: 'FX_VALUATION',
        matchable: false,
        matches: (historyByLedger.get(key) ?? []).map(matchView),
      });
      continue;
    }
    // A foreign document on a local-currency bank G/L has a local amount, but that amount may be a
    // master-rate conversion rather than what the bank moved. Only a payment record that says the
    // actual amount was user-stated proves the movement; a historical or manual line is flagged.
    const bankEvidenceSource = row.incoming_bank_source ?? row.outgoing_bank_source ?? row.run_bank_source;
    if (rowLocalCurrency === account.currency && lineCurrency !== account.currency
      && bankEvidenceSource !== 'USER_ACTUAL') {
      issues.push({
        code: 'BANK_EVIDENCE',
        message: `Ledger line ${row.document_number}/${row.line_number} is a ${lineCurrency} document on local-currency bank G/L ${account.glAccount}, but no actual ${account.currency} bank movement was recorded (source ${bankEvidenceSource ?? 'none'}). The local amount is not proof of what the bank moved.`,
        blocking: true,
      });
      ledgerLines.push({
        documentNumber: row.document_number,
        fiscalYear: row.fiscal_year,
        lineNumber: row.line_number,
        postingDate: row.posting_date,
        documentType: row.document_type,
        reference: row.reference ?? '',
        assignment: row.assignment ?? '',
        originClass: row.origin_class,
        originKey: row.origin_key,
        businessPartner: row.business_partner,
        direction: direction > 0n ? 'IN' : 'OUT',
        amount: money.fromUnits(0n),
        signedAmount: money.fromUnits(0n),
        matchedAmount: money.fromUnits(0n),
        remainingAmount: money.fromUnits(0n),
        asOfRemainingAmount: money.fromUnits(0n),
        localCurrency: account.companyCurrency,
        localAmount: localMoney.fromUnits(signedLocal < 0n ? -signedLocal : signedLocal),
        kind: 'BANK',
        matchable: false,
        matches: (historyByLedger.get(key) ?? []).map(matchView),
      });
      continue;
    }
    // The account-currency movement is authoritative only when the line itself or the document's
    // local currency is the account currency. A third currency has no comparable amount: it is
    // flagged, never converted at today's rate.
    let amountUnits: bigint;
    if (lineCurrency === account.currency) {
      amountUnits = entered(money, row.amount_document, `Ledger line ${row.document_number}/${row.line_number}`);
    } else if (rowLocalCurrency === account.currency) {
      amountUnits = entered(money, row.amount_local, `Ledger line ${row.document_number}/${row.line_number}`);
    } else {
      issues.push({
        code: 'LEDGER_CURRENCY',
        message: `Ledger line ${row.document_number}/${row.line_number} carries no amount in the account currency ${account.currency} (line ${row.currency}, local ${row.local_currency}). It cannot be matched or signed off without fabricating a rate.`,
        blocking: true,
      });
      amountUnits = 0n;
    }
    const signed = amountUnits * direction;
    const globalAllocations = allocationTotal(allocationsByLedger.get(key));
    const asOfAllocations = allocationTotal(asOfAllocationsByLedger.get(key));
    const matched = direction * asOfAllocations;
    const remaining = signed - matched;
    const globalRemaining = signed - direction * globalAllocations;
    ledgerClosing += signed;
    if (row.posting_date < fromDate) ledgerOpening += signed;
    ledgerLines.push({
      documentNumber: row.document_number,
      fiscalYear: row.fiscal_year,
      lineNumber: row.line_number,
      postingDate: row.posting_date,
      documentType: row.document_type,
      reference: row.reference ?? '',
      assignment: row.assignment ?? '',
      originClass: row.origin_class,
      originKey: row.origin_key,
      businessPartner: row.business_partner,
      direction: direction > 0n ? 'IN' : 'OUT',
      amount: money.fromUnits(amountUnits),
      signedAmount: money.fromUnits(signed),
      matchedAmount: money.fromUnits(asOfAllocations),
      remainingAmount: money.fromUnits(remaining),
      asOfRemainingAmount: money.fromUnits(remaining),
      localCurrency: account.companyCurrency,
      localAmount: localMoney.fromUnits(signedLocal < 0n ? -signedLocal : signedLocal),
      kind: 'BANK',
      matchable: true,
      matches: (historyByLedger.get(key) ?? []).map(matchView),
    });
    // Global remaining is only used by matching validation; report it through a side field later if
    // needed. Over-allocation is refused at match time under row locks.
    void globalRemaining;
  }

  // Current statement lines.
  const lineRows = (await tx.execute(sql`
    select line_id, line_number, value_date::text, transaction_date::text, amount::text,
           bank_reference, description
      from bank_statement_line
     where client = ${client} and statement_id = ${statementRow.statementId}
     order by line_number
  `)) as unknown as Array<{
    line_id: string; line_number: number; value_date: string; transaction_date: string;
    amount: string; bank_reference: string | null; description: string | null;
  }>;

  let statementLineSum = 0n;
  const statementLines: BankStatementLineView[] = lineRows.map((row) => {
    const signed = signedUnits(money, row.amount);
    statementLineSum += signed;
    const allocations = allAllocationsByLine.get(row.line_id) ?? [];
    const matched = allocationTotal(allocations);
    const remaining = signed > 0n ? signed - matched : signed + matched;
    return {
      lineId: row.line_id,
      lineNumber: row.line_number,
      valueDate: row.value_date,
      transactionDate: row.transaction_date,
      direction: signed > 0n ? 'IN' : 'OUT',
      amount: money.fromUnits(signed < 0n ? -signed : signed),
      signedAmount: money.fromUnits(signed),
      bankReference: row.bank_reference ?? '',
      description: row.description ?? '',
      matchedAmount: money.fromUnits(matched),
      remainingAmount: money.fromUnits(remaining),
      matches: (historyByLine.get(row.line_id) ?? []).map(matchView),
    };
  });

  const opening = signedUnits(money, statementRow.openingBalance);
  const closing = signedUnits(money, statementRow.closingBalance);
  const arithmeticDifference = opening + statementLineSum - closing;

  // Prior finalized statements contribute their still-unmatched lines to the statement side of the
  // bridge and are shown as carry-forward items. A prior statement that is open (draft/reopened) is
  // an unresolved predecessor and blocks finalization.
  const priorLineRows = (await tx.execute(sql`
    select l.line_id, l.line_number, l.value_date::text, l.transaction_date::text, l.amount::text,
           l.bank_reference, l.description, s.statement_id, s.statement_reference, s.to_date::text as to_date
      from bank_statement_line l
      join bank_statement s on s.client = l.client and s.statement_id = l.statement_id
     where l.client = ${client} and s.company_code = ${account.companyCode}
       and s.house_bank_key = ${account.houseBankKey} and s.account_id = ${account.accountId}
       and s.status = 'FINALIZED' and s.to_date <= ${asOf} and s.statement_id <> ${statementRow.statementId}
     order by s.to_date, s.statement_reference, l.line_number
  `)) as unknown as Array<{
    line_id: string; line_number: number; value_date: string; transaction_date: string; amount: string;
    bank_reference: string | null; description: string | null;
    statement_id: string; statement_reference: string; to_date: string;
  }>;

  let unmatchedStatement = 0n;
  const priorStatementLines: PriorStatementLineView[] = [];
  for (const row of priorLineRows) {
    const signed = signedUnits(money, row.amount);
    const allocations = asOfAllocationsByLine.get(row.line_id) ?? [];
    const matched = allocationTotal(allocations);
    const remaining = signed > 0n ? signed - matched : signed + matched;
    unmatchedStatement += remaining;
    if (remaining === 0n) continue;
    priorStatementLines.push({
      statementId: row.statement_id,
      statementReference: row.statement_reference,
      toDate: row.to_date,
      lineId: row.line_id,
      lineNumber: row.line_number,
      valueDate: row.value_date,
      transactionDate: row.transaction_date,
      direction: signed > 0n ? 'IN' : 'OUT',
      amount: money.fromUnits(signed < 0n ? -signed : signed),
      signedAmount: money.fromUnits(signed),
      bankReference: row.bank_reference ?? '',
      description: row.description ?? '',
      matchedAmount: money.fromUnits(matched),
      remainingAmount: money.fromUnits(remaining),
      matches: (historyByLine.get(row.line_id) ?? []).map(matchView),
    });
  }

  let unmatchedLedger = 0n;
  for (const line of ledgerLines) {
    unmatchedLedger += signedUnits(money, line.remainingAmount);
  }
  for (const line of statementLines) unmatchedStatement += signedUnits(money, line.remainingAmount);

  let matchedStatement = 0n;
  let matchedLedger = 0n;
  for (const row of allocationsByStatement.get(statementRow.statementId) ?? []) {
    if (!row.is_active || row.statement_to_date > asOf) continue;
    const amount = entered(money, row.allocated_amount, 'An allocated amount');
    matchedStatement += amount;
    matchedLedger += amount;
  }

  const ownBaseline = statementRow.baseline ? entered(money, statementRow.baselineAmount, 'The baseline amount') : 0n;
  // A cutover baseline is a permanent opening difference for the account. Later statements carry the
  // first finalized baseline so the same explicit difference is explained, never silently dropped.
  const carriedBaseline = ownBaseline === 0n
    ? statements.find((row) => row.status === 'FINALIZED' && row.baseline && row.to_date < statementRow.toDate)
    : undefined;
  const baseline = carriedBaseline ? entered(money, carriedBaseline.baseline_amount, 'The carried baseline amount') : ownBaseline;
  const closingDifference = closing - ledgerClosing;
  const explained = unmatchedStatement - unmatchedLedger;
  const unexplained = closingDifference - explained - baseline;

  const priorOpen = (await tx.execute(sql`
    select statement_reference, status
      from bank_statement
     where client = ${client} and company_code = ${account.companyCode}
       and house_bank_key = ${account.houseBankKey} and account_id = ${account.accountId}
       and status in ('DRAFT', 'REOPENED') and to_date <= ${asOf}
       and statement_id <> ${statementRow.statementId}
     order by to_date
  `)) as unknown as Array<{ statement_reference: string; status: string }>;
  for (const row of priorOpen) {
    issues.push({
      code: 'PRIOR_OPEN_STATEMENT',
      message: `Earlier statement ${row.statement_reference} stands ${row.status}; the reconciliation cannot be finalized while an earlier statement is open.`,
      blocking: true,
    });
  }

  const previous = statements.find((row) => row.to_date < statementRow.toDate && row.status === 'FINALIZED');
  if (previous) {
    const previousClosing = entered(money, previous.closing_balance, 'The previous statement closing balance');
    if (previousClosing !== opening) {
      issues.push({
        code: 'CONTINUITY_BREAK',
        message: `Statement ${statementRow.statementReference} opens at ${money.fromUnits(opening)} ${account.currency}, but the previous finalized statement ${previous.statement_reference} closes at ${money.fromUnits(previousClosing)} ${account.currency}.`,
        blocking: false,
      });
    }
  }

  // A match whose ledger line was reversed (or otherwise no longer POSTED) is invalid evidence.
  const invalidMatches = (await tx.execute(sql`
    select m.match_id, m.ledger_document_number, m.ledger_fiscal_year, m.ledger_line_number,
           e.status, e.reversal_of, e.is_fx_valuation
      from bank_reconciliation_match m
      join journal_entry_line l
        on l.client = m.client and l.document_number = m.ledger_document_number
       and l.fiscal_year = m.ledger_fiscal_year and l.line_number = m.ledger_line_number
      join journal_entry e
        on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
     where m.client = ${client} and m.statement_id = ${statementRow.statementId} and m.is_active
       and (e.status <> 'POSTED' or e.reversal_of is not null or e.is_fx_valuation = true)
     order by m.ledger_document_number, m.ledger_line_number
  `)) as unknown as Array<{
    match_id: string; ledger_document_number: string; ledger_fiscal_year: number;
    ledger_line_number: number; status: string; reversal_of: string | null; is_fx_valuation: boolean;
  }>;
  for (const row of invalidMatches) {
    const why = row.is_fx_valuation
      ? 'a period-end FX valuation adjustment, not a bank movement'
      : row.reversal_of
        ? `a reversal of ${row.reversal_of}, not an independent movement`
        : `a journal standing ${row.status}`;
    issues.push({
      code: 'INVALID_MATCH',
      message: `Match ${row.match_id} refers to ledger line ${row.ledger_document_number}/${row.ledger_line_number}, which is ${why}. Reopen the statement and unmatch it.`,
      blocking: true,
    });
  }

  const baselineReason = (statementRow.baselineReason ?? '').trim();
  if ((statementRow.baseline || ownBaseline !== 0n) && !baselineReason) {
    issues.push({
      code: 'BASELINE_REASON',
      message: 'A cutover baseline requires an explanatory reason.',
      blocking: true,
    });
  }
  if (ownBaseline !== 0n && statements.some((row) => row.statement_id !== statementRow.statementId && row.status === 'FINALIZED')) {
    issues.push({
      code: 'BASELINE_NOT_FIRST',
      message: 'A cutover baseline is allowed only on the first statement for this bank account, before any statement has been finalized.',
      blocking: true,
    });
  }
  if (ownBaseline !== 0n && ownBaseline !== opening - ledgerOpening) {
    issues.push({
      code: 'BASELINE_MISMATCH',
      message: `The cutover baseline ${money.fromUnits(ownBaseline)} ${account.currency} does not equal the opening difference ${money.fromUnits(opening - ledgerOpening)} ${account.currency} (statement opening minus ledger opening).`,
      blocking: true,
    });
  }

  if (arithmeticDifference !== 0n) {
    issues.push({
      code: 'ARITHMETIC',
      message: `Opening balance plus the signed statement lines does not equal the closing balance: difference ${money.fromUnits(arithmeticDifference)} ${account.currency}.`,
      blocking: true,
    });
  }
  if (unexplained !== 0n) {
    issues.push({
      code: 'UNEXPLAINED',
      message: `An unexplained difference of ${money.fromUnits(unexplained)} ${account.currency} remains after the identified outstanding items and any baseline.`,
      blocking: true,
    });
  }

  const snapshots = (await tx.execute(sql`
    select snapshot_id, sequence, finalized_by, finalized_at, ledger_opening_balance::text,
           ledger_closing_balance::text, unmatched_statement_amount::text, unmatched_ledger_amount::text,
           baseline_amount::text, unexplained_difference::text, match_count, outstanding_count
      from bank_reconciliation_snapshot
     where client = ${client} and statement_id = ${statementRow.statementId}
     order by sequence
  `)) as unknown as Array<{
    snapshot_id: string; sequence: number; finalized_by: string; finalized_at: Date;
    ledger_opening_balance: string; ledger_closing_balance: string;
    unmatched_statement_amount: string; unmatched_ledger_amount: string;
    baseline_amount: string; unexplained_difference: string; match_count: number; outstanding_count: number;
  }>;

  const bridge: BankBridgeView = {
    currency: account.currency,
    statementOpening: money.fromUnits(opening),
    statementClosing: money.fromUnits(closing),
    ledgerOpening: money.fromUnits(ledgerOpening),
    ledgerClosing: money.fromUnits(ledgerClosing),
    closingDifference: money.fromUnits(closingDifference),
    matchedStatementAmount: money.fromUnits(matchedStatement),
    matchedLedgerAmount: money.fromUnits(matchedLedger),
    unmatchedStatementAmount: money.fromUnits(unmatchedStatement),
    unmatchedLedgerAmount: money.fromUnits(unmatchedLedger),
    baselineAmount: money.fromUnits(baseline),
    unexplainedDifference: money.fromUnits(unexplained),
    openingDifference: money.fromUnits(opening - ledgerOpening),
  };

  const statementView: BankReconciliationView['statement'] = {
    ...statementSummaries.find((row) => row.statementId === statementRow.statementId)!,
    lines: statementLines,
    arithmeticValid: arithmeticDifference === 0n,
    arithmeticDifference: money.fromUnits(arithmeticDifference),
  };

  // Changed since the latest signature: recompute the frozen totals against the current data and
  // detect late ledger entries and later allocations touching what was signed.
  let changedSinceSnapshot = false;
  const latest = snapshots[snapshots.length - 1];
  if (statementRow.status === 'FINALIZED' && latest) {
    const storedLedgerClosing = entered(money, latest.ledger_closing_balance, 'The signed ledger closing');
    const storedUnmatchedStatement = entered(money, latest.unmatched_statement_amount, 'The signed unmatched statement amount');
    const storedUnmatchedLedger = entered(money, latest.unmatched_ledger_amount, 'The signed unmatched ledger amount');
    const storedBaseline = entered(money, latest.baseline_amount, 'The signed baseline');
    const storedUnexplained = entered(money, latest.unexplained_difference, 'The signed unexplained difference');
    if (storedLedgerClosing !== ledgerClosing) changeReasons.push('The ledger balance at the statement date has changed.');
    if (storedUnmatchedStatement !== unmatchedStatement) changeReasons.push('The unmatched statement-side items have changed.');
    if (storedUnmatchedLedger !== unmatchedLedger) changeReasons.push('The unmatched ledger-side items have changed.');
    if (storedBaseline !== baseline) changeReasons.push('The recorded baseline has changed.');
    if (storedUnexplained !== unexplained) changeReasons.push('The explained difference has changed.');
    const late = (await tx.execute(sql`
      select count(*)::int as n
        from journal_entry_line l
        join journal_entry e on e.client = l.client and e.document_number = l.document_number
                            and e.fiscal_year = l.fiscal_year
       where l.client = ${client} and l.company_code = ${account.companyCode}
         and l.gl_account = ${account.glAccount} and e.status = 'POSTED'
         and e.posting_date <= ${asOf} and e.posted_at > ${latest.finalized_at}
    `)) as unknown as Array<{ n: number }>;
    if ((late[0]?.n ?? 0) > 0) changeReasons.push('A ledger entry dated inside the signed statement was posted after it was finalized.');
    const laterMatches = (await tx.execute(sql`
      select count(*)::int as n
        from bank_reconciliation_match m
       where m.client = ${client} and m.is_active and m.matched_at > ${latest.finalized_at}
         and m.company_code = ${account.companyCode} and m.house_bank_key = ${account.houseBankKey}
         and m.account_id = ${account.accountId}
    `)) as unknown as Array<{ n: number }>;
    if ((laterMatches[0]?.n ?? 0) > 0) changeReasons.push('A later allocation was recorded against this account.');
    changedSinceSnapshot = changeReasons.length > 0;
  } else if (statementRow.status === 'REOPENED') {
    changedSinceSnapshot = true;
    changeReasons.push('The statement has been reopened for correction.');
  }

  const blocking = issues.some((issue) => issue.blocking) || arithmeticDifference !== 0n || unexplained !== 0n;

  const view: BankReconciliationView = {
    ...account,
    statements: statementSummaries,
    statement: statementView,
    bridge,
    ledgerLines,
    priorStatementLines,
    snapshots: snapshots.map((row) => ({
      snapshotId: row.snapshot_id,
      sequence: row.sequence,
      finalizedBy: row.finalized_by,
      finalizedAt: toIso(row.finalized_at)!,
      ledgerOpeningBalance: row.ledger_opening_balance,
      ledgerClosingBalance: row.ledger_closing_balance,
      unmatchedStatementAmount: row.unmatched_statement_amount,
      unmatchedLedgerAmount: row.unmatched_ledger_amount,
      baselineAmount: row.baseline_amount,
      unexplainedDifference: row.unexplained_difference,
      matchCount: row.match_count,
      outstandingCount: row.outstanding_count,
    })),
    issues,
    changedSinceSnapshot,
    changeReasons,
  };

  return {
    view,
    statementRow,
    account,
    money,
    bridgeUnits: {
      statementOpening: opening,
      statementClosing: closing,
      ledgerOpening,
      ledgerClosing,
      matchedStatement,
      matchedLedger,
      unmatchedStatement,
      unmatchedLedger,
      baseline,
      unexplained,
    },
    issues,
    blocking,
  };
}

async function lockStatement(tx: Tx, client: string, statementId: string): Promise<void> {
  await tx.execute(sql`select statement_id from bank_statement where client = ${client} and statement_id = ${statementId} for update`);
}

async function loadStatementRow(
  tx: Tx, client: string, statementId: string,
): Promise<typeof bankStatement.$inferSelect> {
  const [row] = await tx.select().from(bankStatement).where(and(
    eq(bankStatement.client, client),
    eq(bankStatement.statementId, statementId),
  ));
  if (!row) fail('The bank statement does not exist.', 'Reload the account and choose a standing statement.');
  return row;
}

/** Read one account's statements, or one selected statement with its reconciliation evidence. */
export async function getBankReconciliation(input: {
  client: string;
  companyCode: string;
  houseBankKey: string;
  accountId: string;
  statementId?: string;
}, options: { authorization?: ServiceAuthorityContext } = {}): Promise<BankReconciliationView> {
  return withTenant(input.client, async (tx) => {
    await authorityFor(tx, input.client, options.authorization, READ_CAPABILITIES, input.companyCode);
    const account = await loadCompanyAndAccount(
      tx, input.client, input.companyCode, input.houseBankKey, input.accountId,
    );
    let statementRow = input.statementId
      ? await loadStatementRow(tx, input.client, input.statementId)
      : null;
    if (!statementRow) {
      const [latest] = await tx.select({ statementId: bankStatement.statementId }).from(bankStatement).where(and(
        eq(bankStatement.client, input.client),
        eq(bankStatement.companyCode, account.companyCode),
        eq(bankStatement.houseBankKey, account.houseBankKey),
        eq(bankStatement.accountId, account.accountId),
      )).orderBy(sql`${bankStatement.toDate} desc, ${bankStatement.statementReference} desc`).limit(1);
      if (latest) statementRow = await loadStatementRow(tx, input.client, latest.statementId);
    }
    if (statementRow) {
      if (statementRow.companyCode !== account.companyCode
        || statementRow.houseBankKey !== account.houseBankKey
        || statementRow.accountId !== account.accountId) {
        fail('The selected statement does not belong to this bank account.', 'Reload the account and choose one of its statements.');
      }
    }
    return (await calculate(tx, input.client, account, statementRow)).view;
  });
}

async function activeMatchCounts(
  tx: Tx, client: string, statementId: string,
): Promise<Map<string, number>> {
  const rows = (await tx.execute(sql`
    select statement_line_id, count(*)::int as n
      from bank_reconciliation_match
     where client = ${client} and statement_id = ${statementId} and is_active
     group by statement_line_id
  `)) as unknown as Array<{ statement_line_id: string; n: number }>;
  return new Map(rows.map((row) => [row.statement_line_id, row.n]));
}

/** Create or edit a draft/reopened statement. Finalized lines are never edited in place. */
export async function saveBankStatement(
  input: SaveBankStatementInput,
  options: { authorization?: ServiceAuthorityContext } = {},
): Promise<{ statementId: string; arithmeticValid: boolean; arithmeticDifference: string }> {
  assertCalendarDate('From date', input.fromDate);
  assertCalendarDate('To date', input.toDate);
  if (input.fromDate > input.toDate) fail('The statement period starts after it ends.', 'Correct the from and to dates.');
  const reference = input.statementReference.trim();
  if (!reference) fail('A statement reference is required.', 'Enter the bank statement number or reference.');
  if (reference.length > 40) fail('The statement reference may be at most 40 characters.');
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) fail(`Currency ${input.currency} is not a three-letter currency.`);

  return withTenant(input.client, async (tx) => {
    const authority = await authorityFor(
      tx, input.client, options.authorization, [BANK_STATEMENT_ENTER_CAPABILITY], input.companyCode,
    );
    const account = await loadCompanyAndAccount(
      tx, input.client, input.companyCode, input.houseBankKey, input.accountId,
    );
    if (currency !== account.currency) {
      fail(
        `Statement currency ${currency} does not match bank account ${account.houseBankKey}/${account.accountId}, which stands in ${account.currency}.`,
        'Enter the statement in the bank account currency.',
      );
    }
    const money = await moneyOrThrow(tx, currency);
    const opening = entered(money, input.openingBalance, 'The opening balance');
    const closing = entered(money, input.closingBalance, 'The closing balance');
    const baselineAmount = entered(money, input.baselineAmount || '0', 'The baseline amount');
    const baseline = input.baseline === true || baselineAmount !== 0n;
    const baselineReason = (input.baselineReason ?? '').trim();
    if ((baseline || baselineAmount !== 0n) && !baselineReason) {
      fail('A cutover baseline requires an explanatory reason.', 'Explain why the opening statement balance differs from the ledger.');
    }

    const parsedLines: Array<{
      lineId?: string; lineNumber?: number; signed: bigint; valueDate: string; transactionDate: string;
      bankReference: string | null; description: string | null;
    }> = [];
    for (const [index, line] of input.lines.entries()) {
      if (line.direction !== 'IN' && line.direction !== 'OUT') {
        fail(`Statement line ${index + 1} has no valid direction.`, 'Choose money in or money out.');
      }
      const magnitude = entered(money, line.amount, `Statement line ${index + 1} amount`);
      if (magnitude <= 0n) fail(`Statement line ${index + 1} must have a positive amount.`, 'Enter a positive amount and choose the direction.');
      assertCalendarDate(`Statement line ${index + 1} value date`, line.valueDate);
      const transactionDate = line.transactionDate || line.valueDate;
      assertCalendarDate(`Statement line ${index + 1} transaction date`, transactionDate);
      if ((line.bankReference ?? '').length > 60) fail(`Statement line ${index + 1}: the bank reference may be at most 60 characters.`);
      if ((line.description ?? '').length > 200) fail(`Statement line ${index + 1}: the description may be at most 200 characters.`);
      parsedLines.push({
        lineId: line.lineId,
        signed: line.direction === 'IN' ? magnitude : -magnitude,
        valueDate: line.valueDate,
        transactionDate,
        bankReference: line.bankReference?.trim() || null,
        description: line.description?.trim() || null,
      });
    }

    const statementId = input.statementId ?? randomUUID();
    let existing: typeof bankStatement.$inferSelect | null = null;
    if (input.statementId) {
      await lockStatement(tx, input.client, input.statementId);
      existing = await loadStatementRow(tx, input.client, input.statementId);
      if (existing.companyCode !== input.companyCode || existing.houseBankKey !== input.houseBankKey
        || existing.accountId !== input.accountId) {
        fail('The statement does not belong to this bank account.', 'Reload the account and choose its statement.');
      }
      if (existing.status === 'FINALIZED') {
        fail(
          `Statement ${existing.statementReference} is finalized and cannot be edited.`,
          'Reopen it with a reason, then correct the draft; the finalized snapshot is preserved.',
        );
      }
      const [duplicate] = await tx.select({ statementId: bankStatement.statementId }).from(bankStatement).where(and(
        eq(bankStatement.client, input.client),
        eq(bankStatement.companyCode, input.companyCode),
        eq(bankStatement.houseBankKey, input.houseBankKey),
        eq(bankStatement.accountId, input.accountId),
        eq(bankStatement.statementReference, reference),
        sql`${bankStatement.status} <> 'SUPERSEDED'`,
        sql`${bankStatement.statementId} <> ${statementId}`,
      ));
      if (duplicate) {
        fail(
          `Statement reference ${reference} already stands for this bank account.`,
          'Open the standing statement to correct it, or choose a different reference.',
        );
      }
    } else {
      if (input.requestKey) {
        const [replay] = await tx.select().from(bankStatement).where(and(
          eq(bankStatement.client, input.client), eq(bankStatement.requestKey, input.requestKey),
        ));
        if (replay) {
          const calc = await calculate(tx, input.client, account, replay);
          return {
            statementId: replay.statementId,
            arithmeticValid: calc.view.statement?.arithmeticValid ?? false,
            arithmeticDifference: calc.view.statement?.arithmeticDifference ?? '0',
          };
        }
      }
      const [duplicate] = await tx.select({ statementId: bankStatement.statementId }).from(bankStatement).where(and(
        eq(bankStatement.client, input.client),
        eq(bankStatement.companyCode, input.companyCode),
        eq(bankStatement.houseBankKey, input.houseBankKey),
        eq(bankStatement.accountId, input.accountId),
        eq(bankStatement.statementReference, reference),
        sql`${bankStatement.status} <> 'SUPERSEDED'`,
      ));
      if (duplicate) {
        fail(
          `Statement reference ${reference} already stands for this bank account.`,
          'Open the standing statement to correct it, or choose a different reference.',
        );
      }
      const finalized = (await tx.execute(sql`
        select 1 from bank_statement
         where client = ${input.client} and company_code = ${input.companyCode}
           and house_bank_key = ${input.houseBankKey} and account_id = ${input.accountId}
           and status = 'FINALIZED'
         limit 1
      `)) as unknown as Array<{ '?column?': number }>;
      if (finalized.length > 0 && (baseline || baselineAmount !== 0n)) {
        fail(
          'A cutover baseline is allowed only on the first statement for this bank account.',
          'Reconcile against the standing ledger; do not invent an opening difference after a statement has been signed.',
        );
      }
    }

    const arithmeticDifference = opening + parsedLines.reduce((sum, line) => sum + line.signed, 0n) - closing;

    if (!existing) {
      try {
        await tx.insert(bankStatement).values({
          client: input.client,
          statementId,
          companyCode: input.companyCode,
          houseBankKey: input.houseBankKey,
          accountId: input.accountId,
          statementReference: reference,
          fromDate: input.fromDate,
          toDate: input.toDate,
          currency,
          openingBalance: money.fromUnits(opening),
          closingBalance: money.fromUnits(closing),
          status: 'DRAFT',
          baseline,
          baselineAmount: money.fromUnits(baselineAmount),
          baselineReason: baselineReason || null,
          requestKey: input.requestKey || null,
          createdBy: authority.username,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'bank_statement_identity_uq')) {
          fail(
            `Statement reference ${reference} already stands for this bank account.`,
            'Open the standing statement to correct it, or choose a different reference.',
          );
        }
        throw error;
      }
      let nextNumber = 1;
      for (const line of parsedLines) {
        await tx.insert(bankStatementLine).values({
          client: input.client,
          statementId,
          lineId: randomUUID(),
          lineNumber: nextNumber++,
          valueDate: line.valueDate,
          transactionDate: line.transactionDate,
          amount: money.fromUnits(line.signed),
          bankReference: line.bankReference,
          description: line.description,
          createdBy: authority.username,
        });
      }
      await recordChange(tx, {
        client: input.client,
        objectClass: STATEMENT_CLASS,
        objectKey: statementId,
        changeType: 'CREATE',
        changedBy: authority.username,
        transactionCode: BANK_STATEMENT_ENTER_CAPABILITY,
        after: {
          companyCode: input.companyCode, houseBankKey: input.houseBankKey, accountId: input.accountId,
          statementReference: reference, fromDate: input.fromDate, toDate: input.toDate, currency,
          openingBalance: money.fromUnits(opening), closingBalance: money.fromUnits(closing),
          baseline, baselineAmount: money.fromUnits(baselineAmount), lines: parsedLines.length,
        },
      });
      return { statementId, arithmeticValid: arithmeticDifference === 0n, arithmeticDifference: money.fromUnits(arithmeticDifference) };
    }

    const existingLines = (await tx.execute(sql`
      select line_id, line_number, amount::text, value_date::text, transaction_date::text,
             bank_reference, description
        from bank_statement_line
       where client = ${input.client} and statement_id = ${statementId}
       order by line_number
    `)) as unknown as Array<{
      line_id: string; line_number: number; amount: string; value_date: string;
      transaction_date: string; bank_reference: string | null; description: string | null;
    }>;
    const active = await activeMatchCounts(tx, input.client, statementId);
    const seen = new Set<string>();
    let nextNumber = Math.max(0, ...existingLines.map((row) => row.line_number)) + 1;
    for (const line of parsedLines) {
      if (line.lineId) {
        const found = existingLines.find((row) => row.line_id === line.lineId);
        if (!found) fail('A statement line no longer stands on this statement.', 'Reload the statement and correct it again.');
        if (seen.has(line.lineId)) fail('A statement line is listed twice.', 'Correct the duplicated line.');
        seen.add(line.lineId);
        const stored = signedUnits(money, found.amount);
        if ((active.get(line.lineId) ?? 0) > 0 && stored !== line.signed) {
          fail(
            `Statement line ${found.line_number} is matched; its amount and direction cannot change.`,
            'Unmatch the line first, then correct it.',
          );
        }
        await tx.update(bankStatementLine).set({
          valueDate: line.valueDate,
          transactionDate: line.transactionDate,
          amount: money.fromUnits(line.signed),
          bankReference: line.bankReference,
          description: line.description,
          changedBy: authority.username,
          changedAt: new Date(),
        }).where(and(
          eq(bankStatementLine.client, input.client),
          eq(bankStatementLine.statementId, statementId),
          eq(bankStatementLine.lineId, line.lineId),
        ));
      } else {
        await tx.insert(bankStatementLine).values({
          client: input.client,
          statementId,
          lineId: randomUUID(),
          lineNumber: nextNumber++,
          valueDate: line.valueDate,
          transactionDate: line.transactionDate,
          amount: money.fromUnits(line.signed),
          bankReference: line.bankReference,
          description: line.description,
          createdBy: authority.username,
        });
      }
    }
    for (const found of existingLines) {
      if (seen.has(found.line_id)) continue;
      if ((active.get(found.line_id) ?? 0) > 0) {
        fail(
          `Statement line ${found.line_number} is matched and cannot be removed.`,
          'Unmatch the line first, then remove it.',
        );
      }
      await tx.delete(bankStatementLine).where(and(
        eq(bankStatementLine.client, input.client),
        eq(bankStatementLine.statementId, statementId),
        eq(bankStatementLine.lineId, found.line_id),
      ));
    }

    await tx.update(bankStatement).set({
      statementReference: reference,
      fromDate: input.fromDate,
      toDate: input.toDate,
      currency,
      openingBalance: money.fromUnits(opening),
      closingBalance: money.fromUnits(closing),
      baseline,
      baselineAmount: money.fromUnits(baselineAmount),
      baselineReason: baselineReason || null,
      changedBy: authority.username,
      changedAt: new Date(),
    }).where(and(eq(bankStatement.client, input.client), eq(bankStatement.statementId, statementId)));

    await recordChange(tx, {
      client: input.client,
      objectClass: STATEMENT_CLASS,
      objectKey: statementId,
      changeType: 'CHANGE',
      changedBy: authority.username,
      transactionCode: BANK_STATEMENT_ENTER_CAPABILITY,
      before: {
        statementReference: existing.statementReference, fromDate: existing.fromDate, toDate: existing.toDate,
        openingBalance: existing.openingBalance, closingBalance: existing.closingBalance,
        baseline: existing.baseline, baselineAmount: existing.baselineAmount,
      },
      after: {
        statementReference: reference, fromDate: input.fromDate, toDate: input.toDate,
        openingBalance: money.fromUnits(opening), closingBalance: money.fromUnits(closing),
        baseline, baselineAmount: money.fromUnits(baselineAmount),
      },
    });
    return { statementId, arithmeticValid: arithmeticDifference === 0n, arithmeticDifference: money.fromUnits(arithmeticDifference) };
  });
}

interface LedgerLineForMatch {
  document_number: string;
  fiscal_year: number;
  line_number: number;
  company_code: string;
  gl_account: string;
  currency: string;
  local_currency: string;
  debit_credit: string;
  amount_document: string;
  amount_local: string;
  status: string;
  reversal_of: string | null;
  is_fx_valuation: boolean;
}

/** Confirm one or more allocations. Evidence only: no journal is posted and no AR/AP item is cleared. */
export async function matchBankStatement(
  input: MatchInput,
  options: { authorization?: ServiceAuthorityContext } = {},
): Promise<{ statementId: string; matchIds: string[] }> {
  if (input.allocations.length === 0) fail('Select at least one ledger line to match.', 'Choose a statement line and one or more posted bank lines.');
  return withTenant(input.client, async (tx) => {
    await lockStatement(tx, input.client, input.statementId);
    const statement = await loadStatementRow(tx, input.client, input.statementId);
    const authority = await authorityFor(
      tx, input.client, options.authorization, [BANK_STATEMENT_MATCH_CAPABILITY], statement.companyCode,
    );
    if (statement.status === 'FINALIZED') {
      fail(
        `Statement ${statement.statementReference} is finalized.`,
        'Reopen the statement with a reason before matching or unmatching.',
      );
    }
    const account = await loadCompanyAndAccount(
      tx, input.client, statement.companyCode, statement.houseBankKey, statement.accountId,
    );
    const money = await moneyOrThrow(tx, account.currency);
    const localMoney = await moneyOrThrow(tx, account.companyCurrency);

    if (input.requestKey) {
      const replay = (await tx.execute(sql`
        select match_id from bank_reconciliation_match
         where client = ${input.client} and request_key = ${input.requestKey}
         order by match_id
      `)) as unknown as Array<{ match_id: string }>;
      if (replay.length > 0) return { statementId: statement.statementId, matchIds: replay.map((row) => row.match_id) };
    }

    // The statement's lines are fixed evidence for this call; a concurrent edit is serialized by the
    // statement lock above.
    const lineRows = (await tx.execute(sql`
      select line_id, line_number, amount::text
        from bank_statement_line
       where client = ${input.client} and statement_id = ${input.statementId}
    `)) as unknown as Array<{ line_id: string; line_number: number; amount: string }>;
    const lineById = new Map(lineRows.map((row) => [row.line_id, row]));

    // All active allocations, including those from other statements, consume a ledger line. They are
    // read under the statement lock; concurrent matching from another statement is serialized by the
    // ledger row lock below.
    const activeLedger = (await tx.execute(sql`
      select ledger_document_number, ledger_fiscal_year, ledger_line_number,
             coalesce(sum(allocated_amount), 0)::text as allocated
        from bank_reconciliation_match
       where client = ${input.client} and is_active
         and company_code = ${statement.companyCode} and house_bank_key = ${statement.houseBankKey}
         and account_id = ${statement.accountId}
       group by ledger_document_number, ledger_fiscal_year, ledger_line_number
    `)) as unknown as Array<{
      ledger_document_number: string; ledger_fiscal_year: number; ledger_line_number: number; allocated: string;
    }>;
    const usedByLedger = new Map(activeLedger.map((row) => [
      `${row.ledger_document_number}|${row.ledger_fiscal_year}|${row.ledger_line_number}`,
      entered(money, row.allocated, 'A standing allocation'),
    ]));
    const activeLineTotals = (await tx.execute(sql`
      select statement_line_id, coalesce(sum(allocated_amount), 0)::text as allocated
        from bank_reconciliation_match
       where client = ${input.client} and statement_id = ${input.statementId} and is_active
       group by statement_line_id
    `)) as unknown as Array<{ statement_line_id: string; allocated: string }>;
    const usedByStatementLine = new Map(activeLineTotals.map((row) => [
      row.statement_line_id, entered(money, row.allocated, 'A standing allocation'),
    ]));

    const newByLine = new Map<string, bigint>();
    const newByLedger = new Map<string, bigint>();
    const prepared: Array<{
      statementLineId: string; ledger: LedgerLineForMatch; ledgerKey: string; amount: bigint;
      signed: bigint; allocatedLocal: bigint;
    }> = [];

    for (const [index, allocation] of input.allocations.entries()) {
      const statementLine = lineById.get(allocation.statementLineId);
      if (!statementLine) fail(`Allocation ${index + 1} names a statement line that does not stand on this statement.`, 'Reload the statement.');
      if (!Number.isInteger(allocation.ledgerFiscalYear) || !Number.isInteger(allocation.ledgerLineNumber)) {
        fail(`Allocation ${index + 1} has an invalid ledger line identity.`);
      }
      const ledgerKey = `${allocation.ledgerDocumentNumber}|${allocation.ledgerFiscalYear}|${allocation.ledgerLineNumber}`;
      // Row lock: a competing match, from this or another statement, cannot read the same remaining amount.
      const locked = (await tx.execute(sql`
        select l.document_number, l.fiscal_year, l.line_number, l.company_code, l.gl_account,
               l.currency, e.local_currency, l.debit_credit,
               l.amount_document::text as amount_document, l.amount_local::text as amount_local,
               e.status, e.reversal_of, e.is_fx_valuation
          from journal_entry_line l
          join journal_entry e
            on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
         where l.client = ${input.client} and l.document_number = ${allocation.ledgerDocumentNumber}
           and l.fiscal_year = ${allocation.ledgerFiscalYear} and l.line_number = ${allocation.ledgerLineNumber}
         for update of l
      `)) as unknown as LedgerLineForMatch[];
      const ledger = locked[0];
      if (!ledger) fail(`Ledger line ${allocation.ledgerDocumentNumber}/${allocation.ledgerLineNumber} does not exist.`, 'Reload the posted bank lines.');
      if (ledger.company_code !== statement.companyCode || ledger.gl_account !== account.glAccount) {
        fail(
          `Ledger line ${allocation.ledgerDocumentNumber}/${allocation.ledgerLineNumber} does not stand on bank G/L ${account.glAccount} in company ${statement.companyCode}.`,
          'Choose a posted line of the account being reconciled.',
        );
      }
      if (ledger.status !== 'POSTED') {
        fail(
          `Ledger line ${allocation.ledgerDocumentNumber}/${allocation.ledgerLineNumber} belongs to a journal that stands ${ledger.status}.`,
          'A reversed or parked journal cannot be matched.',
        );
      }
      if (ledger.reversal_of) {
        fail(
          `Ledger line ${allocation.ledgerDocumentNumber}/${allocation.ledgerLineNumber} is a reversal of ${ledger.reversal_of}, not an independent bank movement.`,
          'Match the original movement; a reversal is evidence that it no longer stands, not a second statement item.',
        );
      }
      if (ledger.is_fx_valuation) {
        fail(
          `Ledger line ${allocation.ledgerDocumentNumber}/${allocation.ledgerLineNumber} is a period-end FX valuation adjustment on the bank G/L, not a bank movement.`,
          'It changes local carrying only. Match an actual account-currency receipt or payment instead.',
        );
      }
      // The comparable amount is the line's own amount when it is in the account currency, or the
      // document's local amount when the account is held in the company local currency. Anything
      // else has no authoritative account-currency amount and is refused rather than converted.
      const lineCurrency = ledger.currency.trim().toUpperCase();
      const ledgerLocalCurrency = ledger.local_currency.trim().toUpperCase();
      let ledgerAmount: bigint;
      if (lineCurrency === account.currency) {
        ledgerAmount = entered(money, ledger.amount_document, 'The ledger amount');
      } else if (ledgerLocalCurrency === account.currency) {
        ledgerAmount = entered(money, ledger.amount_local, 'The ledger local amount');
      } else {
        fail(
          `Ledger line ${allocation.ledgerDocumentNumber}/${allocation.ledgerLineNumber} carries no amount in ${account.currency} (line ${ledger.currency}, local ${ledger.local_currency}).`,
          'Match only a line whose own or local amount is in the bank account currency. A rate is never invented to make it comparable.',
        );
      }
      const amount = entered(money, allocation.amount, `Allocation ${index + 1} amount`);
      if (amount <= 0n) fail(`Allocation ${index + 1} must be a positive amount.`);
      const ledgerSigned = ledgerAmount * (ledger.debit_credit === 'S' ? 1n : -1n);
      const statementSigned = signedUnits(money, statementLine.amount);
      if ((ledgerSigned > 0n) !== (statementSigned > 0n)) {
        fail(
          `Allocation ${index + 1} pairs a ${statementSigned > 0n ? 'money-in' : 'money-out'} statement line with a ${ledgerSigned > 0n ? 'debit' : 'credit'} bank line.`,
          'Match a deposit to a debit and a withdrawal to a credit.',
        );
      }
      const statementRemaining = (statementSigned > 0n ? statementSigned : -statementSigned)
        - (usedByStatementLine.get(allocation.statementLineId) ?? 0n)
        - (newByLine.get(allocation.statementLineId) ?? 0n);
      const ledgerRemaining = (ledgerSigned > 0n ? ledgerSigned : -ledgerSigned)
        - (usedByLedger.get(ledgerKey) ?? 0n)
        - (newByLedger.get(ledgerKey) ?? 0n);
      if (amount > statementRemaining) {
        fail(
          `Allocation ${index + 1} of ${money.fromUnits(amount)} exceeds the statement line's remaining ${money.fromUnits(statementRemaining)} ${account.currency}.`,
          'Reduce the allocation or match another statement line.',
        );
      }
      if (amount > ledgerRemaining) {
        fail(
          `Allocation ${index + 1} of ${money.fromUnits(amount)} exceeds the ledger line's remaining ${money.fromUnits(ledgerRemaining)} ${account.currency}.`,
          'Reduce the allocation or choose another posted line.',
        );
      }
      newByLine.set(allocation.statementLineId, (newByLine.get(allocation.statementLineId) ?? 0n) + amount);
      newByLedger.set(ledgerKey, (newByLedger.get(ledgerKey) ?? 0n) + amount);
      // Preserve the local carrying amount this allocation relieves, proportionally to the
      // account-currency movement. Both stay on the evidence row.
      const ledgerLocalUnits = entered(localMoney, ledger.amount_local, 'The ledger local amount');
      const allocatedLocal = ledgerAmount === 0n
        ? 0n
        : divideRound(ledgerLocalUnits * amount, ledgerAmount);
      prepared.push({
        statementLineId: allocation.statementLineId, ledger, ledgerKey, amount,
        signed: statementSigned > 0n ? amount : -amount,
        allocatedLocal,
      });
    }

    const matchIds: string[] = [];
    for (const item of prepared) {
      const matchId = randomUUID();
      await tx.insert(bankReconciliationMatch).values({
        client: input.client,
        matchId,
        companyCode: statement.companyCode,
        houseBankKey: statement.houseBankKey,
        accountId: statement.accountId,
        statementId: statement.statementId,
        statementLineId: item.statementLineId,
        glAccount: account.glAccount,
        ledgerDocumentNumber: item.ledger.document_number,
        ledgerFiscalYear: item.ledger.fiscal_year,
        ledgerLineNumber: item.ledger.line_number,
        allocatedAmount: money.fromUnits(item.amount),
        allocatedLocalAmount: localMoney.fromUnits(item.allocatedLocal),
        currency: account.currency,
        isActive: true,
        matchedBy: authority.username,
        requestKey: input.requestKey || null,
        createdBy: authority.username,
      });
      matchIds.push(matchId);
      await recordChange(tx, {
        client: input.client,
        objectClass: MATCH_CLASS,
        objectKey: matchId,
        changeType: 'CREATE',
        changedBy: authority.username,
        transactionCode: BANK_STATEMENT_MATCH_CAPABILITY,
        after: {
          statementId: statement.statementId,
          statementReference: statement.statementReference,
          statementLineId: item.statementLineId,
          ledgerDocumentNumber: item.ledger.document_number,
          ledgerFiscalYear: item.ledger.fiscal_year,
          ledgerLineNumber: item.ledger.line_number,
          allocatedAmount: money.fromUnits(item.amount),
          allocatedLocalAmount: localMoney.fromUnits(item.allocatedLocal),
          currency: account.currency,
          signedAmount: money.fromUnits(item.signed),
        },
      });
    }
    await tx.update(bankStatement).set({ changedBy: authority.username, changedAt: new Date() })
      .where(and(eq(bankStatement.client, input.client), eq(bankStatement.statementId, statement.statementId)));
    return { statementId: statement.statementId, matchIds };
  });
}

/** Deactivate a match with a reason. The row stays as history; nothing is deleted. */
export async function unmatchBankStatement(input: {
  client: string;
  matchId: string;
  reason: string;
}, options: { authorization?: ServiceAuthorityContext } = {}): Promise<{ statementId: string }> {
  const reason = input.reason.trim();
  if (!reason) fail('A reason is required to unmatch.', 'Explain why the allocation no longer stands.');
  return withTenant(input.client, async (tx) => {
    const [row] = await tx.select().from(bankReconciliationMatch).where(and(
      eq(bankReconciliationMatch.client, input.client),
      eq(bankReconciliationMatch.matchId, input.matchId),
    ));
    if (!row) fail('The match does not exist.', 'Reload the statement.');
    await lockStatement(tx, input.client, row.statementId);
    const statement = await loadStatementRow(tx, input.client, row.statementId);
    const authority = await authorityFor(
      tx, input.client, options.authorization, [BANK_STATEMENT_MATCH_CAPABILITY], statement.companyCode,
    );
    if (statement.status === 'FINALIZED') {
      fail(
        `Statement ${statement.statementReference} is finalized.`,
        'Reopen the statement with a reason before unmatching.',
      );
    }
    const [current] = await tx.select().from(bankReconciliationMatch).where(and(
      eq(bankReconciliationMatch.client, input.client),
      eq(bankReconciliationMatch.matchId, input.matchId),
    ));
    if (!current?.isActive) return { statementId: statement.statementId };
    await tx.update(bankReconciliationMatch).set({
      isActive: false,
      unmatchedBy: authority.username,
      unmatchedAt: new Date(),
      unmatchReason: reason,
      changedBy: authority.username,
      changedAt: new Date(),
    }).where(and(
      eq(bankReconciliationMatch.client, input.client),
      eq(bankReconciliationMatch.matchId, input.matchId),
    ));
    await recordChange(tx, {
      client: input.client,
      objectClass: MATCH_CLASS,
      objectKey: input.matchId,
      changeType: 'CHANGE',
      changedBy: authority.username,
      transactionCode: BANK_STATEMENT_MATCH_CAPABILITY,
      reason,
      before: { isActive: true },
      after: { isActive: false },
    });
    return { statementId: statement.statementId };
  });
}

/** Finalize the as-of reconciliation after an explicit reviewer confirmation. Posts nothing. */
export async function finalizeBankStatement(input: {
  client: string;
  statementId: string;
  confirmed: boolean;
}, options: { authorization?: ServiceAuthorityContext } = {}): Promise<{ statementId: string; snapshotId: string | null }> {
  return withTenant(input.client, async (tx) => {
    await lockStatement(tx, input.client, input.statementId);
    const statement = await loadStatementRow(tx, input.client, input.statementId);
    const authority = await authorityFor(
      tx, input.client, options.authorization, [BANK_STATEMENT_FINALIZE_CAPABILITY], statement.companyCode,
    );
    if (statement.status === 'FINALIZED') {
      return { statementId: statement.statementId, snapshotId: statement.finalizedSnapshotId };
    }
    if (!input.confirmed) {
      fail('The reconciliation stands unconfirmed.', 'Confirm the reconciliation explicitly before finalizing it.');
    }
    if (statement.status !== 'DRAFT' && statement.status !== 'REOPENED') {
      fail(`Statement ${statement.statementReference} stands ${statement.status} and cannot be finalized.`);
    }
    const account = await loadCompanyAndAccount(
      tx, input.client, statement.companyCode, statement.houseBankKey, statement.accountId,
    );
    const calc = await calculate(tx, input.client, account, statement);
    if (!calc.view.statement?.arithmeticValid) {
      fail(
        `Opening balance plus the signed statement lines does not equal the closing balance (difference ${calc.view.statement?.arithmeticDifference} ${account.currency}).`,
        'Correct the statement lines or balances; a draft may be saved, a reconciliation may not be signed.',
      );
    }
    if (calc.bridgeUnits.unexplained !== 0n) {
      fail(
        `An unexplained difference of ${calc.view.bridge!.unexplainedDifference} ${account.currency} remains.`,
        'Match the items the bridge identifies, or post the missing bank entry through the ordinary posting service, then reload.',
      );
    }
    const blocking = calc.issues.filter((issue) => issue.blocking);
    if (blocking.length > 0) {
      fail(blocking[0]!.message, 'Resolve every blocking issue before finalizing.');
    }
    const { money } = calc;
    const evidence = {
      capturedAt: new Date().toISOString(),
      basis: 'Debit-to-bank positive; statement and ledger in the account currency.',
      statement: calc.view.statement,
      bridge: calc.view.bridge,
      ledgerLines: calc.view.ledgerLines,
      priorStatementLines: calc.view.priorStatementLines,
      issues: calc.view.issues,
      continuity: calc.view.issues.find((issue) => issue.code === 'CONTINUITY_BREAK') ?? null,
    };
    const [sequenceRow] = (await tx.execute(sql`
      select coalesce(max(sequence), 0)::int as last
        from bank_reconciliation_snapshot
       where client = ${input.client} and statement_id = ${statement.statementId}
    `)) as unknown as Array<{ last: number }>;
    const sequence = (sequenceRow?.last ?? 0) + 1;
    const snapshotId = randomUUID();
    const bridge = calc.view.bridge!;
    await tx.insert(bankReconciliationSnapshot).values({
      client: input.client,
      snapshotId,
      statementId: statement.statementId,
      sequence,
      statementReference: statement.statementReference,
      companyCode: statement.companyCode,
      houseBankKey: statement.houseBankKey,
      accountId: statement.accountId,
      fromDate: statement.fromDate,
      toDate: statement.toDate,
      currency: account.currency,
      openingBalance: bridge.statementOpening,
      closingBalance: bridge.statementClosing,
      ledgerOpeningBalance: bridge.ledgerOpening,
      ledgerClosingBalance: bridge.ledgerClosing,
      matchedStatementAmount: bridge.matchedStatementAmount,
      matchedLedgerAmount: bridge.matchedLedgerAmount,
      unmatchedStatementAmount: bridge.unmatchedStatementAmount,
      unmatchedLedgerAmount: bridge.unmatchedLedgerAmount,
      baselineAmount: bridge.baselineAmount,
      unexplainedDifference: bridge.unexplainedDifference,
      ledgerLineCount: calc.view.ledgerLines.length,
      matchCount: calc.view.statement!.lines.reduce((sum, line) => sum + line.matches.filter((m) => m.isActive).length, 0),
      outstandingCount: calc.view.statement!.lines.filter((line) => signedUnits(money, line.remainingAmount) !== 0n).length
        + calc.view.ledgerLines.filter((line) => signedUnits(money, line.remainingAmount) !== 0n).length,
      evidence,
      finalizedBy: authority.username,
      createdBy: authority.username,
    });
    await tx.update(bankStatement).set({
      status: 'FINALIZED',
      finalizedSnapshotId: snapshotId,
      finalizedBy: authority.username,
      finalizedAt: new Date(),
      changedBy: authority.username,
      changedAt: new Date(),
    }).where(and(eq(bankStatement.client, input.client), eq(bankStatement.statementId, statement.statementId)));
    await recordChange(tx, {
      client: input.client,
      objectClass: STATEMENT_CLASS,
      objectKey: statement.statementId,
      changeType: 'CHANGE',
      changedBy: authority.username,
      transactionCode: BANK_STATEMENT_FINALIZE_CAPABILITY,
      before: { status: statement.status },
      after: {
        status: 'FINALIZED', snapshotId, sequence,
        statementClosing: bridge.statementClosing, ledgerClosing: bridge.ledgerClosing,
        unexplainedDifference: bridge.unexplainedDifference,
      },
    });
    return { statementId: statement.statementId, snapshotId };
  });
}

/** Reopen a finalized statement for correction. The snapshot is preserved; a reason is required. */
export async function reopenBankStatement(input: {
  client: string;
  statementId: string;
  reason: string;
}, options: { authorization?: ServiceAuthorityContext } = {}): Promise<{ statementId: string }> {
  const reason = input.reason.trim();
  if (!reason) fail('A reason is required to reopen.', 'Explain why the signed reconciliation must be corrected.');
  return withTenant(input.client, async (tx) => {
    await lockStatement(tx, input.client, input.statementId);
    const statement = await loadStatementRow(tx, input.client, input.statementId);
    const authority = await authorityFor(
      tx, input.client, options.authorization, [BANK_STATEMENT_FINALIZE_CAPABILITY], statement.companyCode,
    );
    if (statement.status === 'REOPENED') return { statementId: statement.statementId };
    if (statement.status !== 'FINALIZED') {
      fail(`Statement ${statement.statementReference} stands ${statement.status}; only a finalized reconciliation can be reopened.`);
    }
    await tx.update(bankStatement).set({
      status: 'REOPENED',
      reopenedBy: authority.username,
      reopenedAt: new Date(),
      reopenReason: reason,
      changedBy: authority.username,
      changedAt: new Date(),
    }).where(and(eq(bankStatement.client, input.client), eq(bankStatement.statementId, statement.statementId)));
    await recordChange(tx, {
      client: input.client,
      objectClass: STATEMENT_CLASS,
      objectKey: statement.statementId,
      changeType: 'CHANGE',
      changedBy: authority.username,
      transactionCode: BANK_STATEMENT_FINALIZE_CAPABILITY,
      reason,
      before: { status: 'FINALIZED' },
      after: { status: 'REOPENED' },
    });
    return { statementId: statement.statementId };
  });
}

/** Refuse a journal reversal while any of its lines stands in an active bank reconciliation match. */
export async function activeBankMatchForJournal(
  tx: Tx, client: string, documentNumber: string, fiscalYear: number,
): Promise<{ matchId: string; statementReference: string; lineNumber: number } | null> {
  const rows = (await tx.execute(sql`
    select m.match_id, s.statement_reference, m.ledger_line_number
      from bank_reconciliation_match m
      join bank_statement s on s.client = m.client and s.statement_id = m.statement_id
     where m.client = ${client} and m.is_active
       and m.ledger_document_number = ${documentNumber} and m.ledger_fiscal_year = ${fiscalYear}
     order by m.ledger_line_number
     limit 1
  `)) as unknown as Array<{ match_id: string; statement_reference: string; ledger_line_number: number }>;
  const row = rows[0];
  return row ? { matchId: row.match_id, statementReference: row.statement_reference, lineNumber: row.ledger_line_number } : null;
}

function csvCell(value: string): string {
  const text = value ?? '';
  const guarded = /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text;
  return `"${guarded.replaceAll('"', '""')}"`;
}

/** CSV evidence for the selected statement, computed through the same authorized read. */
export async function bankReconciliationCsv(
  input: {
    client: string; companyCode: string; houseBankKey: string; accountId: string; statementId: string;
  },
  options: { authorization?: ServiceAuthorityContext } = {},
): Promise<string> {
  const view = await getBankReconciliation(input, options);
  if (!view.statement || !view.bridge) fail('The selected statement does not exist.', 'Choose a standing statement.');
  const rows: string[] = [];
  const push = (...cells: string[]) => rows.push(cells.map(csvCell).join(','));
  push('Bank reconciliation', view.statement.statementReference);
  push('Company', view.companyCode, 'House bank', view.houseBankKey, 'Account', view.accountId);
  push('Statement currency', view.currency, 'Ledger basis', `bank G/L ${view.glAccount}, debit to bank positive`);
  push('Period', view.statement.fromDate, view.statement.toDate, 'Status', view.statement.status);
  push('');
  push('Bridge');
  push('Statement opening', view.bridge.statementOpening);
  push('Statement closing', view.bridge.statementClosing);
  push('Ledger opening', view.bridge.ledgerOpening);
  push('Ledger closing', view.bridge.ledgerClosing);
  push('Statement closing minus ledger closing', view.bridge.closingDifference);
  push('Unmatched statement-side signed amount', view.bridge.unmatchedStatementAmount);
  push('Unmatched ledger-side signed amount', view.bridge.unmatchedLedgerAmount);
  push('Cutover baseline', view.bridge.baselineAmount);
  push('Unexplained difference', view.bridge.unexplainedDifference);
  push('');
  push('Statement lines');
  push('Line', 'Value date', 'Transaction date', 'Reference', 'Description', 'Direction', 'Amount', 'Matched', 'Remaining');
  for (const line of view.statement.lines) {
    push(String(line.lineNumber), line.valueDate, line.transactionDate, line.bankReference, line.description,
      line.direction, line.amount, line.matchedAmount, line.remainingAmount);
  }
  push('');
  push('Bank G/L lines');
  push('Document', 'Year', 'Line', 'Posting date', 'Document type', 'Reference', 'Kind', 'Direction', 'Amount',
    'Matched', 'Remaining', 'Local currency', 'Local amount');
  for (const line of view.ledgerLines) {
    push(line.documentNumber, String(line.fiscalYear), String(line.lineNumber), line.postingDate, line.documentType,
      line.reference, line.kind, line.direction, line.amount, line.matchedAmount, line.remainingAmount,
      line.localCurrency, line.localAmount);
  }
  push('');
  push('Matches');
  push('Statement line', 'Ledger document', 'Year', 'Ledger line', 'Amount', 'Local amount', 'Matched by', 'Matched at', 'Active');
  for (const line of view.statement.lines) {
    for (const match of line.matches) {
      push(String(line.lineNumber), match.ledgerDocumentNumber, String(match.ledgerFiscalYear), String(match.ledgerLineNumber),
        match.amount, match.localAmount, match.matchedBy, match.matchedAt, match.isActive ? 'yes' : 'no');
    }
  }
  return rows.join('\r\n');
}

/** Explicitly exported for callers that need the capability set in one place (screens, seeds, tests). */
export const BANK_RECONCILIATION_CAPABILITIES = READ_CAPABILITIES;
