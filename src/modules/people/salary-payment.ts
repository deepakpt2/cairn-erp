/**
 * Payroll phase 4 — pay the net pay a posted payroll run created.
 *
 * SAP reference: the payment step of the payroll posting (PCP0) / payment program (F111). The rule it
 * keeps: **pay what was posted, not what is calculated.** The debit account is the one the payroll
 * document credited (account determination PAYROLL_NET_PAY), and the amount is reconciled against
 * that document's uncleared net pay credit before anything posts — so a determination changed after
 * posting is refused rather than paid around.
 *
 * The entry: one debit per employee with positive net pay on the net pay payable (who was paid how
 * much), one credit to the chosen house-bank account's G/L account. No line carries a cost object or
 * a business partner — employees are not partners. The PR document's net pay credit and this PY
 * document's own debits are stamped cleared, as the vendor payment run clears both of its sides. The
 * document, the clearing and the `salary_payment` row stand or fall together in one transaction.
 *
 * One payment per run (unique index). No payment medium (no bank file, DME or cheque): the
 * accounting effect only.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { hasOrgAccess } from '../../platform/auth/session';
import { type ServiceAuthorityContext, verifyServiceAuthorityInTx } from '../../platform/auth/service-authority';
import { withTenant } from '../../platform/db/client';
import { NumberRangeError } from '../../platform/numbering';
import { PeriodError, checkPostingAllowed, derivePosition, getCompanyCode } from '../../platform/periods';
import { PostingError, computeTotals } from '../../platform/posting';
import { GlDocumentError, postGlDocument, type GlDocumentLineInput } from '../finance/gl-document';
import { accountingReversalLink, journalEntry, journalEntryLine } from '../finance/schema';
import { accountDetermination, bankAccount, houseBank } from '../foundation/schema';
import { PAYROLL_NET_PAY_EVENT } from './payroll-posting';
import { PAYROLL_RUN_ROUTE } from './payroll-run';
import { type PayrollAccess, assertCompanyScope, judgePayrollAccess } from './payroll-access';
import {
  SALARY_PAYMENT_CAPABILITY,
  SALARY_PAYMENT_DOCUMENT_TYPE,
  employee,
  payrollResult,
  payrollRun,
  salaryPayment,
} from './schema';

export { SALARY_PAYMENT_CAPABILITY, SALARY_PAYMENT_DOCUMENT_TYPE };
const HOUSE_BANK_ROUTE = '/config/house-banks';
const ACCOUNT_DETERMINATION_ROUTE = '/config/account-determination';

export class SalaryPaymentError extends Error {
  remedy?: string;
  /** A stable code a test or caller can branch on. The message is for people. */
  readonly code: string;
  constructor(message: string, remedy?: string, code = 'SALARY_PAYMENT') {
    super(message);
    this.name = 'SalaryPaymentError';
    this.remedy = remedy;
    this.code = code;
  }
}

function refuse(code: string, message: string, remedy?: string): never {
  throw new SalaryPaymentError(message, remedy, code);
}

export interface PaySalaryRunInput {
  client: string;
  changedBy: string;
  /** Who is paying. Passed to the G/L posting, which judges FIN.JOURNAL.POST itself. */
  authorization?: ServiceAuthorityContext;
  runId: string;
  /** The day the money leaves. Chosen by the user. */
  paymentDate: string;
  houseBankKey: string;
  bankAccountId: string;
}

export interface SalaryPaymentResult {
  paymentId: string;
  runId: string;
  documentNumber: string;
  displayNumber: string;
  fiscalYear: number;
  paymentDate: string;
  employeeCount: number;
  totalAmount: string;
  debitTotal: string;
  creditTotal: string;
}

export interface SalaryPaymentView {
  paymentId: string;
  runId: string;
  paymentDate: string;
  currency: string;
  houseBankKey: string;
  bankAccountId: string;
  bankGlAccount: string;
  netPayAccount: string;
  employeeCount: number;
  totalAmount: string;
  documentNumber: string;
  documentFiscalYear: number;
  displayNumber: string;
  paidBy: string;
  paidAt: string;
  /** The document that reversed the payment, if a person reversed it. The payment row stands. */
  reversalDocumentNumber: string | null;
}

// ── Money: exact, scale 4 ───────────────────────────────────────────────────

const SCALE = 4;
function toUnits(text: string): bigint {
  const t = String(text).trim();
  const negative = t.startsWith('-');
  const [whole, frac = ''] = (negative ? t.slice(1) : t).split('.');
  const units = BigInt(whole || '0') * 10n ** BigInt(SCALE) + BigInt((frac + '0000').slice(0, SCALE) || '0');
  return negative ? -units : units;
}
function fromUnits(units: bigint): string {
  const negative = units < 0n;
  const text = (negative ? -units : units).toString().padStart(SCALE + 1, '0');
  return `${negative ? '-' : ''}${text.slice(0, -SCALE)}.${text.slice(-SCALE)}`;
}

// ── The pure half ───────────────────────────────────────────────────────────

/**
 * Employees, the payable account and the bank account in, G/L lines out. No database.
 *
 * One debit per employee with positive net pay, in personnel-number order, then one credit to the bank
 * for the sum. No cost object, no business partner. Amounts are the stored scale-4 strings.
 */
export function buildSalaryPaymentJournal(input: {
  employees: Array<{ personnelNumber: string; fullName: string; netPay: string }>;
  netPayAccount: string;
  bankAccount: string;
  /** e.g. 'SAL-2026-3' — written to every line's assignment field. */
  label: string;
}): GlDocumentLineInput[] {
  const paid = input.employees
    .filter((e) => toUnits(e.netPay) > 0n)
    .sort((a, b) => a.personnelNumber.localeCompare(b.personnelNumber));
  const total = paid.reduce((sum, e) => sum + toUnits(e.netPay), 0n);
  if (paid.length === 0) return [];
  return [
    ...paid.map((e) => ({
      glAccount: input.netPayAccount,
      debitCredit: 'S' as const,
      amount: fromUnits(toUnits(e.netPay)),
      assignment: input.label.slice(0, 18),
      lineText: `${e.personnelNumber} ${e.fullName}`.slice(0, 50),
    })),
    {
      glAccount: input.bankAccount,
      debitCredit: 'H' as const,
      amount: fromUnits(total),
      assignment: input.label.slice(0, 18),
      lineText: `Salary payment ${input.label}`.slice(0, 50),
    },
  ];
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number) as unknown as [number, number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

// ── Paying ──────────────────────────────────────────────────────────────────

/**
 * Pay a POSTED run from one house-bank account on the date given, as one PY document, clearing the
 * payroll document's net pay credit. Needs `PEOPLE.PAYROLL.PAYMENT` (asked here) and
 * `FIN.JOURNAL.POST` (asked by the G/L posting), plus Company Code reach over the run's company.
 */
export async function paySalaryRun(input: PaySalaryRunInput): Promise<SalaryPaymentResult> {
  const runId = String(input.runId ?? '').trim();
  const paymentDate = String(input.paymentDate ?? '').trim();
  const houseBankKey = String(input.houseBankKey ?? '').trim().toUpperCase();
  const bankAccountId = String(input.bankAccountId ?? '').trim().toUpperCase();
  if (!runId) refuse('RUN_UNKNOWN', 'Name the payroll run to pay.', `Choose a posted run at ${PAYROLL_RUN_ROUTE}.`);
  const requestKey = `SALARY-PAY-${runId}`;
  try {
    return await withTenant(input.client, async (tx) => {
      // 1. Authority: the payroll half here; FIN.JOURNAL.POST is the G/L posting's own question.
      const authority = await verifyServiceAuthorityInTx(tx, input.client, input.authorization, SALARY_PAYMENT_CAPABILITY, { requirePlantScope: false });
      if (!authority.ok) {
        refuse('PAYMENT_AUTHORITY', authority.refusal.message.startsWith('You do not hold the authority')
          ? `You do not hold the authority to pay salaries (${SALARY_PAYMENT_CAPABILITY}).`
          : authority.refusal.message, authority.refusal.remedy);
      }

      // 2–5. The run: posted, with its document, and not paid yet.
      const [found] = await tx.select().from(payrollRun).where(and(eq(payrollRun.client, input.client), eq(payrollRun.runId, runId))).limit(1);
      if (!found) refuse('RUN_UNKNOWN', `Payroll run ${runId} does not exist.`, `Choose a posted run at ${PAYROLL_RUN_ROUTE}.`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`payroll-run:${input.client}:${found.companyCode}:${found.fiscalYear}:${found.period}`}, 0))`);
      const [run] = await tx.select().from(payrollRun).where(and(eq(payrollRun.client, input.client), eq(payrollRun.runId, runId))).limit(1);
      if (!hasOrgAccess(authority.restrictions, 'COMPANY_CODE', run!.companyCode)) {
        refuse('COMPANY_SCOPE', `Your Company Code scope does not cover company code ${run!.companyCode}.`, 'Ask an administrator to extend your Company Code scope, then pay again.');
      }
      if (run!.status !== 'POSTED') {
        refuse('RUN_NOT_POSTED', `Payroll run ${runId} is ${run!.status}. Post the run before paying it.`, `Release and post it at ${PAYROLL_RUN_ROUTE}?run=${runId}.`);
      }
      if (!run!.documentNumber || run!.documentFiscalYear === null) {
        refuse('RUN_BROKEN', `Payroll run ${runId} is POSTED but carries no payroll document; it cannot be paid.`, 'Report this run to an administrator.');
      }
      const documentNumber = run!.documentNumber;
      const documentFiscalYear = run!.documentFiscalYear;
      const [paid] = await tx.select().from(salaryPayment).where(and(eq(salaryPayment.client, input.client), eq(salaryPayment.runId, runId))).limit(1);
      if (paid) {
        refuse('ALREADY_PAID', `Payroll run ${runId} was already paid on ${paid.paymentDate} as document ${paid.documentNumber}.`, 'A run is paid once. A correction is a reversal of that document.');
      }

      // 6. The results to pay.
      const results = await tx
        .select({ personnelNumber: payrollResult.personnelNumber, netPay: payrollResult.netPay, fullName: employee.fullName })
        .from(payrollResult)
        .leftJoin(employee, and(eq(employee.client, payrollResult.client), eq(employee.personnelNumber, payrollResult.personnelNumber)))
        .where(and(eq(payrollResult.client, input.client), eq(payrollResult.runId, runId)));
      const negative = results.filter((r) => toUnits(String(r.netPay)) < 0n);
      if (negative.length > 0) {
        refuse('NEGATIVE_NET_PAY', `Net pay is negative for ${negative.map((r) => `${r.personnelNumber} (${r.netPay})`).join(', ')}.`, 'A run with negative net pay cannot be paid; reverse its posting and run a later period.');
      }
      const employees = results
        .filter((r) => toUnits(String(r.netPay)) > 0n)
        .map((r) => ({ personnelNumber: r.personnelNumber, fullName: r.fullName ?? r.personnelNumber, netPay: String(r.netPay) }));
      if (employees.length === 0) refuse('NOTHING_TO_PAY', `There is nothing to pay: no result of run ${runId} has a positive net pay.`, 'Nothing needs paying for this run.');
      const total = employees.reduce((sum, e) => sum + toUnits(e.netPay), 0n);

      // 7. The company.
      const company = await getCompanyCode(tx, input.client, run!.companyCode);
      if (!company) refuse('COMPANY_UNKNOWN', `Company code ${run!.companyCode} does not exist.`);
      if (!company.fiscalYearVariant || !company.postingPeriodVariant || !company.chartOfAccounts) {
        refuse('COMPANY_INCOMPLETE', `Company code ${run!.companyCode} is missing its chart of accounts, fiscal year variant or posting period variant.`, 'Complete it in Company Codes (CFG.ORG.COMPANYCODE.DEFINE).');
      }
      const companyCurrency = String(company.currency).trim();
      if (run!.currency !== companyCurrency) {
        refuse('CURRENCY_DIFFERS', `Run ${runId} is in ${run!.currency}; company code ${run!.companyCode} keeps its books in ${companyCurrency}.`);
      }

      // 8–10. The date and its period.
      if (!isCalendarDate(paymentDate)) refuse('PAYMENT_DATE', `Payment date ${paymentDate || '(none)'} is not a calendar date.`, 'Enter the date as YYYY-MM-DD.');
      if (paymentDate < run!.periodTo) {
        refuse('PAID_BEFORE_PERIOD_END', `Salaries for a period cannot be paid before it ends: payment date ${paymentDate} precedes ${run!.periodTo}, the last day of period ${run!.period}/${run!.fiscalYear}.`, `Choose a payment date on or after ${run!.periodTo}.`);
      }
      const position = await derivePosition(tx, input.client, company.fiscalYearVariant, paymentDate);
      const open = await checkPostingAllowed(tx, input.client, company.postingPeriodVariant, 'S', position);
      if (!open.allowed) {
        refuse('PERIOD_CLOSED', `Period ${position.period} of fiscal year ${position.fiscalYear} is closed for posting: ${open.reason}`, open.remedy ?? 'Open the period in Posting periods (FIN.CLOSE.PERIOD).');
      }

      // 11. The bank: it must stand for the paying company, in the run's currency.
      const [bank] = await tx.select().from(bankAccount).where(and(
        eq(bankAccount.client, input.client),
        eq(bankAccount.companyCode, run!.companyCode),
        eq(bankAccount.houseBankKey, houseBankKey),
        eq(bankAccount.accountId, bankAccountId),
      )).limit(1);
      if (!bank) {
        refuse('BANK_ACCOUNT_UNKNOWN', `House bank ${houseBankKey} account ${bankAccountId} does not stand for company ${run!.companyCode}.`, `Choose a standing house-bank account for the paying company, or define one at ${HOUSE_BANK_ROUTE}.`);
      }
      const bankCurrency = String(bank.currency).trim();
      if (bankCurrency !== run!.currency) {
        refuse('BANK_CURRENCY', `Bank account currency ${bankCurrency} does not agree with the payment currency ${run!.currency}.`, 'Choose a bank account in the payment currency.');
      }
      const [standingBank] = await tx.select().from(houseBank).where(and(
        eq(houseBank.client, input.client), eq(houseBank.companyCode, run!.companyCode), eq(houseBank.houseBankKey, houseBankKey),
      )).limit(1);
      if (!standingBank) refuse('HOUSE_BANK_UNKNOWN', `House bank ${houseBankKey} does not stand for company ${run!.companyCode}.`, `Define it at ${HOUSE_BANK_ROUTE}.`);

      // 12. The net pay payable, as Phase 3 posted it.
      const [determination] = await tx.select({ glAccount: accountDetermination.glAccount }).from(accountDetermination).where(and(
        eq(accountDetermination.client, input.client),
        eq(accountDetermination.chartOfAccounts, company.chartOfAccounts),
        eq(accountDetermination.event, PAYROLL_NET_PAY_EVENT),
        eq(accountDetermination.valuationClass, ''),
        eq(accountDetermination.generalModifier, ''),
      )).limit(1);
      if (!determination) {
        refuse('NO_NET_PAY_ACCOUNT', `No account is determined for posting event ${PAYROLL_NET_PAY_EVENT} in chart ${company.chartOfAccounts}.`, `Name the net pay payable account at ${ACCOUNT_DETERMINATION_ROUTE}.`);
      }
      const netPayAccount = determination.glAccount;

      // 13. Reconcile: pay what the payroll document left open on that account, not what is calculated.
      const [open13] = (await tx.execute(sql`
        select count(*)::int as lines, coalesce(sum(amount_document), 0)::text as amount
          from journal_entry_line
         where client = ${input.client} and company_code = ${run!.companyCode}
           and document_number = ${documentNumber} and fiscal_year = ${documentFiscalYear}
           and debit_credit = 'H' and gl_account = ${netPayAccount} and clearing_document is null
      `)) as unknown as Array<{ lines: number; amount: string }>;
      if (!open13 || Number(open13.lines) === 0) {
        refuse('NOTHING_OPEN', `Payroll document ${documentNumber} carries no unpaid net pay on account ${netPayAccount} (0.0000 open), but the run's results pay ${fromUnits(total)}.`, `Check the ${PAYROLL_NET_PAY_EVENT} determination at ${ACCOUNT_DETERMINATION_ROUTE} against the account the payroll document credited.`);
      }
      if (toUnits(open13.amount) !== total) {
        refuse('NET_PAY_MISMATCH', `Payroll document ${documentNumber} leaves ${fromUnits(toUnits(open13.amount))} open on account ${netPayAccount}, but the run's results pay ${fromUnits(total)}.`, 'Nothing was paid. Check that the net pay determination still names the account the payroll document credited.');
      }

      // 14–15. Build, then prove the balance.
      const label = `SAL-${run!.fiscalYear}-${run!.period}`;
      const lines = buildSalaryPaymentJournal({ employees, netPayAccount, bankAccount: bank.glAccount, label });
      const totals = computeTotals(lines);
      if (toUnits(totals.debit) !== toUnits(totals.credit)) {
        refuse('UNBALANCED', `The salary payment does not balance: debits ${totals.debit}, credits ${totals.credit}.`, 'Report this run to an administrator.');
      }

      // 16. Post; clear both sides and record the payment in the same transaction.
      const paymentId = randomUUID();
      const posted = await postGlDocument({
        client: input.client,
        changedBy: input.changedBy,
        requestKey,
        companyCode: run!.companyCode,
        documentDate: paymentDate,
        postingDate: paymentDate,
        documentType: SALARY_PAYMENT_DOCUMENT_TYPE,
        currency: run!.currency,
        reference: label.slice(0, 16),
        headerText: `Salary payment ${run!.fiscalYear}/${run!.period}`.slice(0, 25),
        lines,
        onPosted: async (inner, document) => {
          // The payable the payroll posting created, and this document's own debit side: a paid
          // salary must not stand open anywhere.
          await inner.update(journalEntryLine).set({ clearingDocument: document.documentNumber, clearingDate: paymentDate }).where(and(
            eq(journalEntryLine.client, input.client),
            eq(journalEntryLine.companyCode, run!.companyCode),
            eq(journalEntryLine.documentNumber, documentNumber),
            eq(journalEntryLine.fiscalYear, documentFiscalYear),
            eq(journalEntryLine.debitCredit, 'H'),
            eq(journalEntryLine.glAccount, netPayAccount),
            isNull(journalEntryLine.clearingDocument),
          ));
          await inner.update(journalEntryLine).set({ clearingDocument: document.documentNumber, clearingDate: paymentDate }).where(and(
            eq(journalEntryLine.client, input.client),
            eq(journalEntryLine.companyCode, run!.companyCode),
            eq(journalEntryLine.documentNumber, document.documentNumber),
            eq(journalEntryLine.fiscalYear, document.fiscalYear),
            eq(journalEntryLine.debitCredit, 'S'),
          ));
          const now = new Date();
          await inner.insert(salaryPayment).values({
            client: input.client, paymentId, runId,
            companyCode: run!.companyCode, fiscalYear: run!.fiscalYear, period: run!.period,
            paymentDate, currency: run!.currency, houseBankKey, bankAccountId,
            bankGlAccount: bank.glAccount, netPayAccount,
            employeeCount: employees.length, totalAmount: fromUnits(total),
            documentNumber: document.documentNumber, documentFiscalYear: document.fiscalYear,
            requestKey, paidBy: input.changedBy, paidAt: now, createdBy: input.changedBy,
          });
        },
      }, { tx, authorization: input.authorization });

      return {
        paymentId,
        runId,
        documentNumber: posted.documentNumber,
        displayNumber: posted.displayNumber,
        fiscalYear: posted.fiscalYear,
        paymentDate,
        employeeCount: employees.length,
        totalAmount: fromUnits(total),
        debitTotal: posted.debitTotal,
        creditTotal: posted.creditTotal,
      };
    });
  } catch (error) {
    if (error instanceof GlDocumentError) throw new SalaryPaymentError(error.message, error.remedy, 'GL_REFUSED');
    if (error instanceof PostingError) throw new SalaryPaymentError(error.message, error.remedy, 'GL_REFUSED');
    if (error instanceof NumberRangeError) throw new SalaryPaymentError(error.message, error.remedy, 'GL_REFUSED');
    if (error instanceof PeriodError) throw new SalaryPaymentError(error.message, error.remedy, 'PERIOD_UNRESOLVED');
    throw error;
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** What a run was paid with, or null. */
export async function getSalaryPayment(client: string, runIdInput: string, access?: PayrollAccess): Promise<SalaryPaymentView | null> {
  const runId = String(runIdInput ?? '').trim();
  if (!runId) return null;
  return withTenant(client, async (tx) => {
    const grant = await judgePayrollAccess(tx, client, access, ['PEOPLE.PAYROLLRUN.EXECUTE', 'PEOPLE.PAYROLL.RESULT', SALARY_PAYMENT_CAPABILITY], refuse);
    const [row] = await tx.select().from(salaryPayment).where(and(eq(salaryPayment.client, client), eq(salaryPayment.runId, runId))).limit(1);
    if (!row) return null;
    assertCompanyScope(grant, row.companyCode, refuse);
    const [entry] = await tx.select({ displayNumber: journalEntry.displayNumber }).from(journalEntry).where(and(
      eq(journalEntry.client, client), eq(journalEntry.companyCode, row.companyCode),
      eq(journalEntry.documentNumber, row.documentNumber), eq(journalEntry.fiscalYear, row.documentFiscalYear),
    )).limit(1);
    const [reversal] = await tx.select({ reversalDocumentNumber: accountingReversalLink.reversalDocumentNumber })
      .from(accountingReversalLink).where(and(
        eq(accountingReversalLink.client, client),
        eq(accountingReversalLink.originalCompanyCode, row.companyCode),
        eq(accountingReversalLink.originalDocumentNumber, row.documentNumber),
        eq(accountingReversalLink.originalFiscalYear, row.documentFiscalYear),
      )).limit(1);
    return {
      paymentId: row.paymentId,
      runId: row.runId,
      paymentDate: row.paymentDate,
      currency: row.currency,
      houseBankKey: row.houseBankKey,
      bankAccountId: row.bankAccountId,
      bankGlAccount: row.bankGlAccount,
      netPayAccount: row.netPayAccount,
      employeeCount: row.employeeCount,
      totalAmount: String(row.totalAmount),
      documentNumber: row.documentNumber,
      documentFiscalYear: row.documentFiscalYear,
      displayNumber: entry?.displayNumber || row.documentNumber,
      paidBy: row.paidBy,
      paidAt: row.paidAt instanceof Date ? row.paidAt.toISOString() : String(row.paidAt),
      reversalDocumentNumber: reversal?.reversalDocumentNumber ?? null,
    };
  });
}
