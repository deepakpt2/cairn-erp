/**
 * Payroll phase 3 — post a released payroll run to the general ledger.
 *
 * SAP reference: the payroll posting run (PCP0) turns the frozen payroll results into one summarised
 * accounting document per payroll area and period; the derived amounts with no wage type behind them
 * — net pay — reach the ledger through symbolic accounts (T52EK). Here that is account determination
 * event `PAYROLL_NET_PAY`.
 *
 * The rules this file keeps:
 * - **Post from the snapshot.** Accounts, cost receivers and amounts come from `payroll_result_line`
 *   as calculated; `pay_component_config` is never re-read. The net pay account is the one derived
 *   amount, and it comes from account determination — never a constant in this file.
 * - **One document per run**, document type `PR`, dated the last day of the period. Debits (EARNING,
 *   EMPLOYER_CONTRIBUTION) carry the snapshotted cost centre; credits (DEDUCTION, EMPLOYER_CONTRIBUTION,
 *   net pay) carry none. Lines are grouped by account, cost centre and component.
 * - **It balances by construction** (net = gross − deductions is a check on `payroll_result`), and the
 *   balance is asserted anyway before anything is posted.
 * - **The run and the document stand or fall together:** the run becomes POSTED inside the posting
 *   hook, in the journal's own transaction.
 * - **Posted once.** No reposting, no recalculation (DV-001); a correction is a reversal of the
 *   document and a new run in a later period.
 *
 * Phase 3 pays nobody: it stops at the payable. Paying it is phase 4.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import { hasOrgAccess } from '../../platform/auth/session';
import { type ServiceAuthorityContext, verifyServiceAuthorityInTx } from '../../platform/auth/service-authority';
import { type Tx, withTenant } from '../../platform/db/client';
import { PeriodError, checkPostingAllowed, derivePosition, getCompanyCode } from '../../platform/periods';
import { NumberRangeError } from '../../platform/numbering';
import { PostingError, computeTotals } from '../../platform/posting';
import { GlDocumentError, postGlDocument, type GlDocumentLineInput } from '../finance/gl-document';
import { accountingReversalLink, glAccount, journalEntry } from '../finance/schema';
import { accountDetermination } from '../foundation/schema';
import { PAYROLL_RUN_ROUTE, activeOperation } from './payroll-run';
import { type PayrollAccess, assertCompanyScope, judgePayrollAccess } from './payroll-access';
import { payComponent, payrollResult, payrollResultLine, payrollRun } from './schema';

export const PAYROLL_POST_CAPABILITY = 'PEOPLE.PAYROLL.POST';
export const PAYROLL_POSTING_DOCUMENT_TYPE = 'PR';
export const PAYROLL_NET_PAY_EVENT = 'PAYROLL_NET_PAY';
const ACCOUNT_DETERMINATION_ROUTE = '/config/account-determination';
const PAY_COMPONENT_ROUTE = '/config/pay-components';
const NET_PAY_GROUP = 'NET_PAY';

export class PayrollPostingError extends Error {
  remedy?: string;
  /** A stable code a test or caller can branch on. The message is for people. */
  readonly code: string;
  constructor(message: string, remedy?: string, code = 'PAYROLL_POSTING') {
    super(message);
    this.name = 'PayrollPostingError';
    this.remedy = remedy;
    this.code = code;
  }
}

function refuse(code: string, message: string, remedy?: string): never {
  throw new PayrollPostingError(message, remedy, code);
}

export interface PostPayrollRunInput {
  client: string;
  changedBy: string;
  /** The background posting operation that is itself the active one, so it does not block itself. */
  exceptOperationId?: string;
  /** Who is posting. Passed to the G/L posting, which judges `FIN.JOURNAL.POST` itself. */
  authorization?: ServiceAuthorityContext;
  runId: string;
}

export interface PayrollPostingResult {
  runId: string;
  status: 'POSTED';
  documentNumber: string;
  displayNumber: string;
  fiscalYear: number;
  postingDate: string;
  lineCount: number;
  debitTotal: string;
  creditTotal: string;
}

export interface PayrollPostingView {
  runId: string;
  status: string;
  documentNumber: string;
  displayNumber: string;
  documentFiscalYear: number;
  postingDate: string;
  postedBy: string | null;
  postedAt: string | null;
  lineCount: number;
  debitTotal: string;
  creditTotal: string;
  /** The document that reversed this one, if a person reversed it. The run stays POSTED. */
  reversalDocumentNumber: string | null;
}

export interface PayrollJournalLineSource {
  componentCode: string;
  componentName: string | null;
  debitAccount: string | null;
  creditAccount: string | null;
  costCenter: string | null;
  /** numeric(23,4) as stored, e.g. '2500.0000'. */
  amount: string;
}

// ── The pure half ───────────────────────────────────────────────────────────

const SCALE = 4;
function toUnits(text: string): bigint {
  const [whole, frac = ''] = String(text).trim().split('.');
  return BigInt(whole || '0') * 10n ** BigInt(SCALE) + BigInt((frac + '0000').slice(0, SCALE) || '0');
}
function fromUnits(units: bigint): string {
  const text = units.toString().padStart(SCALE + 1, '0');
  return `${text.slice(0, -SCALE)}.${text.slice(-SCALE)}`;
}

/**
 * Result lines and a net pay account in, G/L document lines out. No database.
 *
 * Grouped by (account, cost centre, component): debits keep the line's cost centre, credits carry
 * none. Net pay is one credit line to `netPayAccount`. Zero groups are dropped. Debit groups come
 * first, then credit groups, each sorted by account then component, so the document reads the same
 * every time.
 */
export function buildPayrollJournal(input: {
  lines: PayrollJournalLineSource[];
  netPayAccount: string;
  netPayTotal: string;
  /** e.g. '2026-03' — written to every line's assignment field. */
  label: string;
}): GlDocumentLineInput[] {
  type Group = { side: 'S' | 'H'; account: string; costCenter: string; component: string; text: string; units: bigint };
  const groups = new Map<string, Group>();
  const add = (side: 'S' | 'H', account: string, costCenter: string, component: string, text: string, units: bigint) => {
    const key = `${side}|${account}|${costCenter}|${component}`;
    const group = groups.get(key) ?? { side, account, costCenter, component, text, units: 0n };
    group.units += units;
    groups.set(key, group);
  };
  for (const line of input.lines) {
    const units = toUnits(line.amount);
    if (units <= 0n) continue;
    const text = line.componentName ?? line.componentCode;
    if (line.debitAccount) add('S', line.debitAccount, line.costCenter ?? '', line.componentCode, text, units);
    if (line.creditAccount) add('H', line.creditAccount, '', line.componentCode, text, units);
  }
  const net = toUnits(input.netPayTotal);
  if (net > 0n) add('H', input.netPayAccount, '', NET_PAY_GROUP, 'Net pay', net);

  const order = (a: Group, b: Group) =>
    (a.side === b.side ? 0 : a.side === 'S' ? -1 : 1)
    || a.account.localeCompare(b.account)
    || a.component.localeCompare(b.component)
    || a.costCenter.localeCompare(b.costCenter);
  return [...groups.values()]
    .filter((g) => g.units > 0n)
    .sort(order)
    .map((g) => ({
      glAccount: g.account,
      debitCredit: g.side,
      amount: fromUnits(g.units),
      ...(g.costCenter ? { costCenter: g.costCenter } : {}),
      assignment: input.label.slice(0, 18),
      lineText: g.text.slice(0, 50),
    }));
}

// ── Posting ─────────────────────────────────────────────────────────────────

async function loadRun(tx: Tx, client: string, runId: string) {
  const [run] = await tx.select().from(payrollRun).where(and(eq(payrollRun.client, client), eq(payrollRun.runId, runId))).limit(1);
  return run ?? null;
}

/**
 * Post a RELEASED run as one `PR` document dated the last day of its period, and mark it POSTED with
 * the document number in the same transaction. Needs `PEOPLE.PAYROLL.POST` (asked here) and
 * `FIN.JOURNAL.POST` (asked by the G/L posting), plus Company Code reach over the run's company.
 */
export async function postPayrollRun(input: PostPayrollRunInput): Promise<PayrollPostingResult> {
  const runId = String(input.runId ?? '').trim();
  if (!runId) refuse('RUN_UNKNOWN', 'Name the payroll run to post.', `Choose a released run at ${PAYROLL_RUN_ROUTE}.`);
  const requestKey = `PAYROLL-POST-${runId}`;
  try {
    return await withTenant(input.client, async (tx) => {
      // 1. Authority: the payroll half here; the journal half is the G/L posting's own question.
      const authority = await verifyServiceAuthorityInTx(tx, input.client, input.authorization, PAYROLL_POST_CAPABILITY, { requirePlantScope: false });
      if (!authority.ok) {
        // A missing capability is said in payroll's words; every other refusal (no session, no
        // Company Code scope, an audit grant) keeps the authority check's own.
        refuse('PAYROLL_AUTHORITY', authority.refusal.message.startsWith('You do not hold the authority')
          ? `You do not hold the authority to post payroll (${PAYROLL_POST_CAPABILITY}).`
          : authority.refusal.message, authority.refusal.remedy);
      }

      // 2–4. The run: it must exist, be released, and carry no document yet.
      const run = await loadRun(tx, input.client, runId);
      if (!run) refuse('RUN_UNKNOWN', `Payroll run ${runId} does not exist.`, `Choose a released run at ${PAYROLL_RUN_ROUTE}.`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`payroll-run:${input.client}:${run.companyCode}:${run.fiscalYear}:${run.period}`}, 0))`);
      const locked = (await loadRun(tx, input.client, runId))!;
      if (!hasOrgAccess(authority.restrictions, 'COMPANY_CODE', locked.companyCode)) {
        refuse('COMPANY_SCOPE', `Your Company Code scope does not cover company code ${locked.companyCode}.`, 'Ask an administrator to extend your Company Code scope, then post again.');
      }
      const active = await activeOperation(tx, input.client, runId);
      if (active && active.operationId !== input.exceptOperationId) {
        refuse('OPERATION_ACTIVE', `Run ${runId} cannot be posted while a background ${active.kind.toLowerCase()} is ${active.status.toLowerCase()}.`, `Wait for it to finish, or cancel it at ${PAYROLL_RUN_ROUTE}?run=${runId}.`);
      }
      if (locked.documentNumber || locked.status === 'POSTED') {
        refuse('RUN_POSTED', `Payroll run ${runId} is already posted as document ${locked.documentNumber} (fiscal year ${locked.documentFiscalYear}).`, 'A run is posted once. A correction is a reversal of that document and a new run in a later period.');
      }
      if (locked.status === 'CANCELLED') refuse('RUN_CANCELLED', `A cancelled run cannot be posted (run ${runId}).`, `Propose a new run at ${PAYROLL_RUN_ROUTE}.`);
      if (locked.status !== 'RELEASED') {
        refuse('RUN_NOT_RELEASED', `This run has not been released (run ${runId} is ${locked.status}).`, `Review and release it at ${PAYROLL_RUN_ROUTE}?run=${runId}, then post.`);
      }

      // 5–7. The frozen results and their lines.
      const results = await tx.select().from(payrollResult)
        .where(and(eq(payrollResult.client, input.client), eq(payrollResult.runId, runId)));
      if (results.length === 0) refuse('NOTHING_TO_POST', `There is nothing to post: run ${runId} has no results.`, 'Cancel the run.');
      const negative = results.filter((r) => toUnitsSigned(String(r.netPay)) < 0n);
      if (negative.length > 0) {
        refuse('NEGATIVE_NET_PAY', `Net pay is negative for ${negative.map((r) => `${r.personnelNumber} (${r.netPay})`).join(', ')}; deductions exceed gross pay and nothing carries the arrears.`, 'Correct the deductions on the employee\'s structure; a released run cannot be recalculated, so cancel it and propose a new one.');
      }
      const lines = await tx
        .select({
          componentCode: payrollResultLine.componentCode,
          componentName: payComponent.name,
          debitAccount: payrollResultLine.debitAccount,
          creditAccount: payrollResultLine.creditAccount,
          costCenter: payrollResultLine.costCenter,
          amount: payrollResultLine.amount,
        })
        .from(payrollResultLine)
        .leftJoin(payComponent, and(eq(payComponent.client, payrollResultLine.client), eq(payComponent.code, payrollResultLine.componentCode)))
        .where(and(eq(payrollResultLine.client, input.client), inArray(payrollResultLine.resultId, results.map((r) => r.resultId))));

      // 8–13. Company, date, period.
      const company = await getCompanyCode(tx, input.client, locked.companyCode);
      if (!company) refuse('COMPANY_UNKNOWN', `Company code ${locked.companyCode} does not exist.`, 'Choose a run of a standing company.');
      if (!company.fiscalYearVariant || !company.postingPeriodVariant || !company.chartOfAccounts) {
        const missing = [!company.chartOfAccounts && 'chart of accounts', !company.fiscalYearVariant && 'fiscal year variant', !company.postingPeriodVariant && 'posting period variant'].filter(Boolean).join(', ');
        refuse('COMPANY_INCOMPLETE', `Company code ${locked.companyCode} has no ${missing}.`, 'Complete it in Company Codes (CFG.ORG.COMPANYCODE.DEFINE).');
      }
      const postingDate = locked.periodTo;
      const position = await derivePosition(tx, input.client, company.fiscalYearVariant, postingDate);
      if (position.fiscalYear !== locked.fiscalYear || position.period !== locked.period) {
        refuse('PERIOD_MISMATCH', `Run ${runId} pays period ${locked.period}/${locked.fiscalYear}, but its last day ${postingDate} falls in period ${position.period}/${position.fiscalYear} of variant ${company.fiscalYearVariant}.`, 'The fiscal year variant changed since the run was proposed. Cancel the run and propose it again.');
      }
      const open = await checkPostingAllowed(tx, input.client, company.postingPeriodVariant, 'S', position);
      if (!open.allowed) {
        refuse('PERIOD_CLOSED', `Period ${position.period} of fiscal year ${position.fiscalYear} is closed for posting: ${open.reason}`, open.remedy ?? 'Open the period in Posting periods (FIN.CLOSE.PERIOD).');
      }
      const companyCurrency = String(company.currency).trim();
      if (locked.currency !== companyCurrency) {
        refuse('CURRENCY_DIFFERS', `Run ${runId} is in ${locked.currency}; company code ${locked.companyCode} keeps its books in ${companyCurrency}.`, 'A run is posted in the company\'s currency. Cancel it and propose a new one.');
      }

      // 14. The net pay payable, from account determination.
      const [determination] = await tx.select({ glAccount: accountDetermination.glAccount }).from(accountDetermination).where(and(
        eq(accountDetermination.client, input.client),
        eq(accountDetermination.chartOfAccounts, company.chartOfAccounts),
        eq(accountDetermination.event, PAYROLL_NET_PAY_EVENT),
        eq(accountDetermination.valuationClass, ''),
        eq(accountDetermination.generalModifier, ''),
      )).limit(1);
      if (!determination) {
        refuse('NO_NET_PAY_ACCOUNT', `No account is determined for posting event ${PAYROLL_NET_PAY_EVENT} in chart ${company.chartOfAccounts}.`, `Name the net pay payable account for event ${PAYROLL_NET_PAY_EVENT} at ${ACCOUNT_DETERMINATION_ROUTE}.`);
      }

      // 15. A debit that needs a cost object and has none: name the component mapped wrong.
      const debitAccounts = [...new Set(lines.filter((l) => l.debitAccount && toUnits(String(l.amount)) > 0n).map((l) => l.debitAccount!))];
      if (debitAccounts.length > 0) {
        const needing = new Set((await tx.select({ account: glAccount.accountNumber }).from(glAccount).where(and(
          eq(glAccount.client, input.client),
          eq(glAccount.chartOfAccounts, company.chartOfAccounts),
          inArray(glAccount.accountNumber, debitAccounts),
          eq(glAccount.requiresCostObject, true),
        ))).map((r) => r.account));
        const bare = [...new Set(lines.filter((l) => l.debitAccount && needing.has(l.debitAccount) && !l.costCenter && toUnits(String(l.amount)) > 0n)
          .map((l) => `${l.componentCode} (account ${l.debitAccount})`))];
        if (bare.length > 0) {
          refuse('NO_COST_OBJECT', `Component${bare.length > 1 ? 's' : ''} ${bare.join(', ')} debit${bare.length > 1 ? '' : 's'} an account that requires a cost object, and the result carries no cost centre for it.`, `Give the component a cost receiver at ${PAY_COMPONENT_ROUTE}; a released run keeps its snapshot, so cancel it and propose a new one.`);
        }
      }

      // 16–18. Build, then prove the balance.
      const netPayTotal = fromUnits(results.reduce((sum, r) => {
        const units = toUnitsSigned(String(r.netPay));
        return units > 0n ? sum + units : sum;
      }, 0n));
      const label = `${locked.periodTo.slice(0, 7)}`;
      const journal = buildPayrollJournal({
        lines: lines.map((l) => ({ ...l, componentName: l.componentName ?? null, amount: String(l.amount) })),
        netPayAccount: determination.glAccount,
        netPayTotal,
        label,
      });
      const totals = computeTotals(journal);
      if (journal.length === 0 || toUnits(totals.debit) === 0n) {
        refuse('NOTHING_TO_POST', `There is nothing to post for this run (${runId}): every amount is zero.`, 'Cancel the run.');
      }
      if (toUnits(totals.debit) !== toUnits(totals.credit)) {
        refuse('UNBALANCED', `Payroll run ${runId} does not balance: debits ${totals.debit}, credits ${totals.credit}. Nothing was posted.`, 'The result snapshot is inconsistent; report this run to an administrator.');
      }

      // 19. Post, and mark the run in the same transaction.
      const posted = await postGlDocument({
        client: input.client,
        changedBy: input.changedBy,
        requestKey,
        companyCode: locked.companyCode,
        documentDate: postingDate,
        postingDate,
        documentType: PAYROLL_POSTING_DOCUMENT_TYPE,
        currency: locked.currency,
        reference: `PAYROLL-${locked.fiscalYear}-${locked.period}`.slice(0, 16),
        headerText: `Payroll ${locked.fiscalYear} period ${locked.period}`.slice(0, 25),
        lines: journal,
        onPosted: async (inner, document) => {
          const now = new Date();
          await inner.update(payrollRun).set({
            status: 'POSTED',
            documentNumber: document.documentNumber,
            documentFiscalYear: document.fiscalYear,
            postedBy: input.changedBy,
            postedAt: now,
            postingRequestKey: requestKey,
            changedBy: input.changedBy,
            changedAt: now,
          }).where(and(eq(payrollRun.client, input.client), eq(payrollRun.runId, runId)));
        },
      }, { tx, authorization: input.authorization });

      return {
        runId,
        status: 'POSTED' as const,
        documentNumber: posted.documentNumber,
        displayNumber: posted.displayNumber,
        fiscalYear: posted.fiscalYear,
        postingDate,
        lineCount: posted.lineCount,
        debitTotal: posted.debitTotal,
        creditTotal: posted.creditTotal,
      };
    });
  } catch (error) {
    // 20. The ledger's refusals keep their words.
    if (error instanceof GlDocumentError) throw new PayrollPostingError(error.message, error.remedy, 'GL_REFUSED');
    if (error instanceof PostingError) throw new PayrollPostingError(error.message, error.remedy, 'GL_REFUSED');
    if (error instanceof PeriodError) throw new PayrollPostingError(error.message, error.remedy, 'PERIOD_UNRESOLVED');
    if (error instanceof NumberRangeError) throw new PayrollPostingError(error.message, error.remedy, 'GL_REFUSED');
    throw error;
  }
}

function toUnitsSigned(text: string): bigint {
  const t = text.trim();
  return t.startsWith('-') ? -toUnits(t.slice(1)) : toUnits(t);
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** What a run posted, or null when it carries no document. */
export async function getPayrollPosting(client: string, runIdInput: string, access?: PayrollAccess): Promise<PayrollPostingView | null> {
  const runId = String(runIdInput ?? '').trim();
  if (!runId) return null;
  return withTenant(client, async (tx) => {
    const grant = await judgePayrollAccess(tx, client, access, ['PEOPLE.PAYROLLRUN.EXECUTE', 'PEOPLE.PAYROLL.RESULT', PAYROLL_POST_CAPABILITY], refuse);
    const run = await loadRun(tx, client, runId);
    if (run) assertCompanyScope(grant, run.companyCode, refuse);
    if (!run?.documentNumber || run.documentFiscalYear === null) return null;
    const [entry] = await tx.select({
      displayNumber: journalEntry.displayNumber,
      postingDate: journalEntry.postingDate,
    }).from(journalEntry).where(and(
      eq(journalEntry.client, client), eq(journalEntry.companyCode, run.companyCode),
      eq(journalEntry.documentNumber, run.documentNumber), eq(journalEntry.fiscalYear, run.documentFiscalYear),
    )).limit(1);
    const totals = (await tx.execute(sql`
      select count(*)::int as line_count,
             coalesce(sum(case when l.debit_credit = 'S' then l.amount_document else 0 end), 0)::text as debit_total,
             coalesce(sum(case when l.debit_credit = 'H' then l.amount_document else 0 end), 0)::text as credit_total
        from journal_entry_line l
       where l.client = ${client} and l.company_code = ${run.companyCode}
         and l.document_number = ${run.documentNumber} and l.fiscal_year = ${run.documentFiscalYear}
    `)) as unknown as Array<{ line_count: number; debit_total: string; credit_total: string }>;
    const [reversal] = await tx.select({ reversalDocumentNumber: accountingReversalLink.reversalDocumentNumber })
      .from(accountingReversalLink).where(and(
        eq(accountingReversalLink.client, client),
        eq(accountingReversalLink.originalCompanyCode, run.companyCode),
        eq(accountingReversalLink.originalDocumentNumber, run.documentNumber),
        eq(accountingReversalLink.originalFiscalYear, run.documentFiscalYear),
      )).limit(1);
    const posted = run.postedAt instanceof Date ? run.postedAt.toISOString() : run.postedAt ? String(run.postedAt) : null;
    return {
      runId,
      status: run.status,
      documentNumber: run.documentNumber,
      displayNumber: entry?.displayNumber || run.documentNumber,
      documentFiscalYear: run.documentFiscalYear,
      postingDate: entry?.postingDate ? String(entry.postingDate).slice(0, 10) : run.periodTo,
      postedBy: run.postedBy ?? null,
      postedAt: posted,
      lineCount: Number(totals[0]?.line_count ?? 0),
      debitTotal: String(totals[0]?.debit_total ?? '0'),
      creditTotal: String(totals[0]?.credit_total ?? '0'),
      reversalDocumentNumber: reversal?.reversalDocumentNumber ?? null,
    };
  });
}
