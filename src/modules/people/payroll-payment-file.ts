/**
 * Generic salary payment file — a working CSV, never a bank format.
 *
 * An authorised payroll user prepares one file for one POSTED run from its frozen results, downloads it,
 * converts it to whatever their bank requires, and uploads it manually in the bank's portal. The ERP does
 * NOT send it anywhere, does not know whether a bank accepted it, and preparing or downloading it posts
 * nothing, clears nothing and marks no salary paid. The salary accounting payment (`salary-payment.ts`, a
 * PY document) is a separate, existing process; its wording is clarified on the screen, not here.
 *
 * The rules this file keeps:
 * - **POSTED only, from the frozen results.** Amounts are `payroll_result.net_pay` as stored, written at
 *   `currency.decimal_places`. Nothing is recalculated and no floating point touches an amount.
 * - **One prepared batch per run.** A unique `(client, run_id)` makes a retry, a refresh and a concurrent
 *   second call return the same frozen snapshot. The CSV body is stored so a re-download is byte-identical
 *   and a later master-data change cannot silently rewrite it.
 * - **Bank details, frozen and encrypted.** At preparation it selects each payable employee's ONE active main
 *   account effective on the intended payment date (never "today"), and snapshots the beneficiary and account
 *   with the file. The identifier is stored ENCRYPTED (AES-256-GCM envelope bound to tenant + employee + file
 *   id); the CSV is rebuilt deterministically from that snapshot on every download. A missing account, an
 *   ambiguous record, or an unavailable keyring fails the whole preparation — never a partial or guessed file.
 *   A file prepared before bank integration (plaintext `body`, no snapshot) is downloaded byte-for-byte and
 *   is never silently changed.
 * - **Fail closed on reach.** Every included employee must be within the caller's Company Code/Plant scope;
 *   otherwise the whole file is refused rather than returning a partial instruction.
 * - **Reversal is terminal here.** A reversed payroll posting or a reversed salary payment refuses both
 *   preparation and download; nothing is reissued automatically.
 * - **Audit without pay data.** Who prepared/downloaded, when, the file reference, run, count and total are
 *   logged; the CSV, the account fields and the salary line items are never logged.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';

import { type ServiceAuthorityContext } from '../../platform/auth/service-authority';
import { withTenant, type Tx } from '../../platform/db/client';
import { MoneyError, moneyOf, refusing, type Money } from '../../platform/posting/money';
import { type BankDataKeyring, decryptBankData, encryptBankData } from '../../platform/security/bank-data-encryption';
import { loadBankDataKeyring } from '../../platform/security/bank-data-keyring';
import { accountingReversalLink } from '../finance/schema';
import { judgePayrollAccess, reachesCompany, type PayrollGrant } from './payroll-access';
import { accountAsOf } from './employee-bank';
import { lockReissueState } from './payment-file-locks';
import { currencyDecimals } from './payroll-run';
import { assertEmployeeScope, PAYROLL_RESULT_CAPABILITY, PayrollStructureError } from './payroll-structure';
import { PAYROLL_RUN_CAPABILITY, employee, payrollPaymentFile, payrollResult, payrollRun, salaryPayment, type PaymentFileBankRow } from './schema';

/** A dedicated export capability, granted to no ordinary role by default (migration 9320). */
export const PAYMENT_FILE_CAPABILITY = 'PEOPLE.PAYROLL.FILE.EXPORT';
/** The download endpoint. A route handler linked from the run, not a navigation screen. */
export const PAYMENT_FILE_ROUTE = '/people/payroll-runs/payment-file';

/** The warning the screen, the documentation and every response repeat. */
export const PAYMENT_FILE_WARNING =
  'You must review, complete and convert this file to your bank’s required format before uploading it. '
  + 'The ERP does not send it to the bank. No bank or country is asserted to accept this CSV.';

export const PAYMENT_FILE_REUSE_WARNING =
  'This file was downloaded before. Uploading a second copy may pay employees twice. '
  + 'Confirm with your bank dashboard that the previous upload did not go through before re-downloading, '
  + 'and remember the ERP cannot prevent a second upload to an external bank.';

export class PaymentFileError extends Error {
  remedy?: string;
  /** A stable code a test or caller can branch on. The message is for people. */
  readonly code: string;
  constructor(message: string, remedy?: string, code = 'PAYMENT_FILE') {
    super(message);
    this.name = 'PaymentFileError';
    this.remedy = remedy;
    this.code = code;
  }
}

export function isPaymentFileError(error: unknown): error is PaymentFileError {
  return error instanceof PaymentFileError;
}

function refuse(code: string, message: string, remedy?: string): never {
  throw new PaymentFileError(message, remedy, code);
}

/** The session form of payroll authority. The session is re-judged in every call, never trusted here. */
export interface PaymentFileAccess {
  authorization: ServiceAuthorityContext | undefined;
}

const READ = [PAYMENT_FILE_CAPABILITY] as const;
/** The file embeds full account identifiers, so preparing or downloading it is a full-value bank operation. */
const BANK_FOR_FILE = ['PEOPLE.BANK.REVEAL'] as const;

/**
 * Require the bank reveal authority in addition to file export: the CSV carries each employee's full IBAN or
 * account number, so producing it must not be possible with the file capability alone. Two separate any-of
 * judgements, because `judgePayrollAccess` is any-of — file export AND reveal are both needed.
 */
async function judgeFileAndBank(tx: Tx, client: string, access: PaymentFileAccess | undefined): Promise<PayrollGrant> {
  const grant = await judgePayrollAccess(tx, client, access, READ, refuse, 'FILE_AUTHORITY');
  await judgePayrollAccess(tx, client, access, BANK_FOR_FILE, refuse, 'FILE_BANK_AUTHORITY');
  return grant;
}

export interface PaymentFileView {
  preparationId: string;
  runId: string;
  companyCode: string;
  fiscalYear: number;
  period: number;
  currency: string;
  intendedPaymentDate: string;
  fileReference: string;
  runReference: string;
  filename: string;
  rowCount: number;
  /** Written at the currency's configured decimals. */
  totalAmount: string;
  preparedBy: string;
  preparedAt: string;
  downloadCount: number;
  lastDownloadedBy: string | null;
  lastDownloadedAt: string | null;
  downloadPath: string;
  /** True when employee bank details are part of this frozen file. */
  bankDataIncluded: boolean;
}

export interface PaymentFileDownload {
  filename: string;
  body: Buffer;
  fileReference: string;
  rowCount: number;
  totalAmount: string;
  /** True when this was a repeat download; the caller has confirmed the duplicate-upload warning. */
  reused: boolean;
  downloadCount: number;
}

// ── The CSV (pure) ──────────────────────────────────────────────────────────

export interface PayableResult {
  personnelNumber: string;
  netPay: string;
  fullName: string | null;
}

/**
 * Split the frozen results into the payable rows and any negative net pay, in personnel-number order.
 * Zero net pay is not payable and is dropped; a negative net pay is refused by the caller. Exact at the
 * currency's scale — no floating point. Pure so the rule is testable without mutating stored results.
 */
export function selectPayableResults(
  results: readonly PayableResult[],
  money: Money,
): { payable: PayableResult[]; negative: PayableResult[]; totalUnits: bigint } {
  const ordered = [...results].sort((a, b) => a.personnelNumber.localeCompare(b.personnelNumber));
  const negative = ordered.filter((r) => money.units(String(r.netPay)) < 0n);
  const payable = ordered.filter((r) => money.units(String(r.netPay)) > 0n);
  const totalUnits = payable.reduce((sum, r) => sum + money.units(String(r.netPay)), 0n);
  return { payable, negative, totalUnits };
}

export interface PaymentFileRow {
  personnelNumber: string;
  beneficiaryName: string;
  /** Exact amount at the currency's decimals, e.g. '1234.567'. */
  amount: string;
  currency: string;
  intendedPaymentDate: string;
  beneficiaryBankName: string;
  beneficiaryBankCode: string;
  beneficiaryAccount: string;
  beneficiaryIban: string;
}

/**
 * Turn a frozen, encrypted snapshot into CSV rows, decrypting each identifier with the context the file
 * stored (tenant + employee + file id). Missing keyring or an unreadable envelope throws — the caller
 * refuses the whole download rather than emitting a blank or partial instruction. Only frozen fields are used.
 */
export function paymentRowsFromSnapshot(
  snapshot: readonly PaymentFileBankRow[],
  context: (row: PaymentFileBankRow) => { client: string; partnerNumber: string; bankRecordId: string },
  keyring: BankDataKeyring,
): PaymentFileRow[] {
  return snapshot.map((r) => {
    const ctx = context(r);
    const accountValue = decryptBankData(
      r.accountCiphertext,
      { client: ctx.client, partnerNumber: ctx.partnerNumber, bankRecordId: ctx.bankRecordId as never, field: 'paymentFileAccount' },
      keyring,
    );
    return {
      personnelNumber: r.personnelNumber,
      beneficiaryName: r.beneficiaryName,
      amount: r.amount,
      currency: r.currency,
      intendedPaymentDate: r.intendedPaymentDate,
      beneficiaryBankName: r.bankName,
      beneficiaryBankCode: r.bankCode ?? '',
      beneficiaryAccount: r.accountKind === 'ACCOUNT' ? accountValue : '',
      beneficiaryIban: r.accountKind === 'IBAN' ? accountValue : '',
    };
  });
}

export const PAYMENT_FILE_COLUMNS = [
  'file_reference', 'run_reference', 'personnel_number', 'beneficiary_name', 'amount', 'currency',
  'intended_payment_date', 'beneficiary_bank_name', 'beneficiary_bank_code', 'beneficiary_account',
  'beneficiary_iban', 'remittance_information',
] as const;

/**
 * One CSV cell. RFC 4180 quoting, and a leading apostrophe on anything a spreadsheet would evaluate as a
 * formula (`= + - @`, tab, CR), so a name like `=cmd` is data, not a formula. The apostrophe is inside the
 * quotes when the cell is also quoted, which is what both a spreadsheet and a bank's importer read as text.
 */
export function csvCell(value: string): string {
  let v = value ?? '';
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  if (/[",\r\n]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  return v;
}

/**
 * The whole file: a header row then one row per employee, in the order given (callers sort by personnel
 * number). UTF-8, CRLF line endings. Pure: no database, no clock, no formatting decisions beyond the cells.
 */
export function buildPaymentCsv(
  meta: { fileReference: string; runReference: string },
  rows: readonly PaymentFileRow[],
): string {
  const lines = [PAYMENT_FILE_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push([
      meta.fileReference,
      meta.runReference,
      r.personnelNumber,
      r.beneficiaryName,
      r.amount,
      r.currency,
      r.intendedPaymentDate,
      r.beneficiaryBankName,
      r.beneficiaryBankCode,
      r.beneficiaryAccount,
      r.beneficiaryIban,
      `Salary ${meta.runReference}`,
    ].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

// ── Identifiers ─────────────────────────────────────────────────────────────

export function runReferenceOf(run: { companyCode: string; fiscalYear: number; period: number; runId: string }): string {
  return `RUN-${run.companyCode}-${run.fiscalYear}-${String(run.period).padStart(2, '0')}-${run.runId.slice(0, 8)}`;
}

export function fileReferenceOf(run: { companyCode: string; fiscalYear: number; period: number; runId: string }): string {
  return `SALPAY-${run.companyCode}-${run.fiscalYear}-${String(run.period).padStart(2, '0')}-${run.runId.slice(0, 8)}`.slice(0, 60);
}

function filenameOf(run: { companyCode: string; fiscalYear: number; period: number; runId: string }): string {
  return `salary-payment-${run.companyCode}-${run.fiscalYear}-${String(run.period).padStart(2, '0')}-${run.runId.slice(0, 8)}.csv`;
}

function checksumOf(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number) as unknown as [number, number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

// ── Reading and judging ─────────────────────────────────────────────────────

const UNAVAILABLE = 'That payroll run does not exist, or is not available to you.';
const UNAVAILABLE_REMEDY = 'Open a run you reach at the payroll runs screen.';

type RunRow = typeof payrollRun.$inferSelect;
type PreparedRow = typeof payrollPaymentFile.$inferSelect;

interface Loaded {
  run: RunRow;
  grant: PayrollGrant;
  money: Money;
  decimals: number;
}

/** Load the run and prove the caller reaches its company. A run outside reach reads like a missing one. */
async function loadRunForFile(tx: Tx, client: string, runIdInput: string, grant: PayrollGrant): Promise<Loaded> {
  const runId = String(runIdInput ?? '').trim();
  if (!runId || runId.length > 36) refuse('FILE_UNAVAILABLE', UNAVAILABLE, UNAVAILABLE_REMEDY);
  const [run] = await tx.select().from(payrollRun).where(and(eq(payrollRun.client, client), eq(payrollRun.runId, runId))).limit(1);
  if (!run || !reachesCompany(grant, run.companyCode)) refuse('FILE_UNAVAILABLE', UNAVAILABLE, UNAVAILABLE_REMEDY);
  const decimals = await currencyDecimals(tx, run.currency);
  return { run, grant, decimals, money: refusing(moneyOf(run.currency, decimals), (e: MoneyError) => new PaymentFileError(e.message, e.remedy, 'AMOUNT_PRECISION')) };
}

/** A reversed payroll posting or a reversed salary payment refuses both preparation and download. */
async function assertNotReversed(tx: Tx, client: string, run: RunRow): Promise<void> {
  if (run.documentNumber && run.documentFiscalYear !== null) {
    const [postingReversal] = await tx.select({ reversalDocumentNumber: accountingReversalLink.reversalDocumentNumber })
      .from(accountingReversalLink).where(and(
        eq(accountingReversalLink.client, client),
        eq(accountingReversalLink.originalCompanyCode, run.companyCode),
        eq(accountingReversalLink.originalDocumentNumber, run.documentNumber),
        eq(accountingReversalLink.originalFiscalYear, run.documentFiscalYear),
      )).limit(1);
    if (postingReversal) {
      refuse(
        'RUN_REVERSED',
        `Payroll run ${run.runId} has been reversed (document ${postingReversal.reversalDocumentNumber}); a payment file is not reissued automatically after a reversal.`,
        'An administrator must resolve the reversal and any bank submission first. This file is not created or downloaded.',
      );
    }
  }
  const [payment] = await tx.select().from(salaryPayment).where(and(eq(salaryPayment.client, client), eq(salaryPayment.runId, run.runId))).limit(1);
  if (payment) {
    const [paymentReversal] = await tx.select({ reversalDocumentNumber: accountingReversalLink.reversalDocumentNumber })
      .from(accountingReversalLink).where(and(
        eq(accountingReversalLink.client, client),
        eq(accountingReversalLink.originalCompanyCode, payment.companyCode),
        eq(accountingReversalLink.originalDocumentNumber, payment.documentNumber),
        eq(accountingReversalLink.originalFiscalYear, payment.documentFiscalYear),
      )).limit(1);
    if (paymentReversal) {
      refuse(
        'PAYMENT_REVERSED',
        `The salary payment of run ${run.runId} has been reversed (document ${paymentReversal.reversalDocumentNumber}); a payment file is not reissued automatically after a reversal.`,
        'An administrator must resolve the reversal and any bank submission first. This file is not created or downloaded.',
      );
    }
  }
}

/** Every included employee must be within the caller's scope. Fail closed: never a partial file. */
async function assertAllReachable(tx: Tx, client: string, grant: PayrollGrant, personnelNumbers: readonly string[], onDate: string): Promise<void> {
  for (const pn of personnelNumbers) {
    try {
      await assertEmployeeScope(tx, client, grant, pn, onDate);
    } catch (error) {
      if (error instanceof PayrollStructureError) {
        refuse(
          'EMPLOYEE_SCOPE',
          `One or more employees paid by this run are outside your Company Code or Plant scope, so no file was produced.`,
          'Ask an administrator to extend your scope, or ask a payroll officer who reaches every included employee.',
        );
      }
      throw error;
    }
  }
}

function viewOf(row: PreparedRow, money: Money): PaymentFileView {
  return {
    preparationId: row.preparationId,
    runId: row.runId,
    companyCode: row.companyCode,
    fiscalYear: row.fiscalYear,
    period: row.period,
    currency: String(row.currency).trim(),
    intendedPaymentDate: row.intendedPaymentDate,
    fileReference: row.fileReference,
    runReference: runReferenceOf(row),
    filename: row.filename,
    rowCount: row.rowCount,
    totalAmount: money.text(String(row.totalAmount)),
    preparedBy: row.preparedBy,
    preparedAt: row.preparedAt instanceof Date ? row.preparedAt.toISOString() : String(row.preparedAt),
    downloadCount: row.downloadCount,
    lastDownloadedBy: row.lastDownloadedBy ?? null,
    lastDownloadedAt: row.lastDownloadedAt
      ? (row.lastDownloadedAt instanceof Date ? row.lastDownloadedAt.toISOString() : String(row.lastDownloadedAt))
      : null,
    downloadPath: `${PAYMENT_FILE_ROUTE}?run=${encodeURIComponent(row.runId)}`,
    bankDataIncluded: row.bankDataIncluded,
  };
}

async function preparedOf(tx: Tx, client: string, runId: string): Promise<PreparedRow | null> {
  const [row] = await tx.select().from(payrollPaymentFile)
    .where(and(eq(payrollPaymentFile.client, client), eq(payrollPaymentFile.runId, runId))).limit(1);
  return row ?? null;
}

/** The prepared file for a run, for the screen. Judged like every other call. */
export async function getPaymentFile(client: string, runIdInput: string, access: PaymentFileAccess): Promise<PaymentFileView | null> {
  return withTenant(client, async (tx) => {
    const grant = await judgePayrollAccess(tx, client, access, READ, refuse, 'FILE_AUTHORITY');
    const { run, money } = await loadRunForFile(tx, client, runIdInput, grant);
    const row = await preparedOf(tx, client, run.runId);
    return row ? viewOf(row, money) : null;
  });
}

// ── Preparing ───────────────────────────────────────────────────────────────

export interface PreparePaymentFileInput {
  client: string;
  runId: string;
  /** The instruction date; when absent the existing salary-payment date is used. */
  intendedPaymentDate?: string;
  /** The acting person's name, written to `prepared_by` and the audit row. */
  changedBy: string;
}

async function resolveDate(tx: Tx, client: string, run: RunRow, supplied: string | undefined): Promise<string> {
  const given = String(supplied ?? '').trim();
  if (given) {
    if (!isCalendarDate(given)) refuse('PAYMENT_DATE', `Intended payment date ${given} is not a calendar date.`, 'Enter the date as YYYY-MM-DD.');
    return given;
  }
  const [payment] = await tx.select({ paymentDate: salaryPayment.paymentDate }).from(salaryPayment)
    .where(and(eq(salaryPayment.client, client), eq(salaryPayment.runId, run.runId))).limit(1);
  if (payment) return payment.paymentDate;
  refuse(
    'PAYMENT_DATE_REQUIRED',
    `An intended payment date is needed for run ${run.runId}.`,
    'Enter the date you intend the bank to pay, or pay the run first so its payment date can be used as the instruction date.',
  );
}

/**
 * Prepare (or return) the one frozen payment file of a POSTED run. Idempotent under a run lock and a unique
 * `(client, run_id)`: a retry or a concurrent call returns the same snapshot. A different intended date for
 * an existing batch is refused rather than silently rewritten.
 */
export async function preparePaymentFile(input: PreparePaymentFileInput, access: PaymentFileAccess): Promise<PaymentFileView> {
  return withTenant(input.client, async (tx) => {
    const grant = await judgeFileAndBank(tx, input.client, access);
    const { run, money } = await loadRunForFile(tx, input.client, input.runId, grant);
    if (run.status !== 'POSTED') {
      refuse(
        'RUN_NOT_POSTED',
        `Payroll run ${run.runId} is ${run.status}; a payment file is produced only for a posted run.`,
        'Release and post the run first. A prepared file is an instruction, never a calculation.',
      );
    }
    await assertNotReversed(tx, input.client, run);

    // One writer per run: a concurrent second call waits here, then finds the row this one inserted.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`payment-file:${input.client}:${run.runId}`}, 0))`);

    const existing = await preparedOf(tx, input.client, run.runId);
    if (existing) {
      await assertAllReachable(tx, input.client, grant, (existing.beneficiaries as string[]) ?? [], run.periodTo);
      const wanted = String(input.intendedPaymentDate ?? '').trim();
      if (wanted && wanted !== existing.intendedPaymentDate) {
        refuse(
          'FILE_EXISTS',
          `A payment file for run ${run.runId} already exists with intended date ${existing.intendedPaymentDate}; it is frozen and is not silently changed to ${wanted}.`,
          'An administrator must resolve the existing batch and any bank submission first. This file is not reissued.',
        );
      }
      return viewOf(existing, money);
    }

    const intendedPaymentDate = await resolveDate(tx, input.client, run, input.intendedPaymentDate);

    // The frozen results: exactly one row per positive net-pay employee, in personnel-number order.
    const results = await tx
      .select({ personnelNumber: payrollResult.personnelNumber, netPay: payrollResult.netPay, fullName: employee.fullName })
      .from(payrollResult)
      .leftJoin(employee, and(eq(employee.client, payrollResult.client), eq(employee.personnelNumber, payrollResult.personnelNumber)))
      .where(and(eq(payrollResult.client, input.client), eq(payrollResult.runId, run.runId)))
      .orderBy(asc(payrollResult.personnelNumber));

    const { payable, negative, totalUnits } = selectPayableResults(results, money);
    if (negative.length > 0) {
      refuse(
        'NEGATIVE_NET',
        `Net pay is negative for ${negative.map((r) => r.personnelNumber).join(', ')}; a payment file cannot carry a negative instruction.`,
        'A run with negative net pay cannot be paid by file; reverse its posting and run a later period.',
      );
    }
    if (payable.length === 0) {
      refuse('NOTHING_TO_PAY', `No result of run ${run.runId} has a positive net pay, so there is nothing to put in a payment file.`, 'Nothing needs paying for this run.');
    }
    await assertAllReachable(tx, input.client, grant, payable.map((r) => r.personnelNumber), run.periodTo);

    // Each payable employee's ONE active main account effective on the INTENDED PAYMENT DATE, not today.
    // Missing or ambiguous details refuse the whole file with an employee-level list — never a partial file.
    const missing: string[] = [];
    const ambiguous: string[] = [];
    const selected = new Map<string, { bankName: string; bankCode: string | null; accountKind: 'IBAN' | 'ACCOUNT'; accountValue: string; beneficiaryName: string }>();
    for (const r of payable) {
      try {
        const account = await accountAsOf(tx, input.client, r.personnelNumber, intendedPaymentDate);
        if (!account) {
          missing.push(r.personnelNumber);
          continue;
        }
        selected.set(r.personnelNumber, {
          bankName: account.bankName,
          bankCode: account.bankCode ?? null,
          accountKind: account.accountKind as 'IBAN' | 'ACCOUNT',
          accountValue: decryptAccount(account.accountCiphertext, input.client, r.personnelNumber, account.bankRecordId),
          beneficiaryName: account.beneficiaryName,
        });
      } catch (error) {
        if (isPaymentFileError(error) && error.code === 'BANK_AMBIGUOUS') ambiguous.push(r.personnelNumber);
        else if (isPaymentFileError(error) && error.code === 'FILE_KEYRING') throw error;
        else throw error;
      }
    }
    if (ambiguous.length > 0) {
      refuse(
        'BANK_AMBIGUOUS',
        `An employee has more than one active main bank account on the intended payment date ${intendedPaymentDate}: ${ambiguous.join(', ')}. No payment file was produced.`,
        'An administrator must resolve the overlapping records on the employee screen, then prepare the file again.',
      );
    }
    if (missing.length > 0) {
      refuse(
        'BANK_DETAILS_MISSING',
        `No valid bank account is effective on the intended payment date ${intendedPaymentDate} for: ${missing.join(', ')}. No payment file was produced.`,
        'Add an effective-dated main bank account for each employee on the employee screen, then prepare the file again. No employee is silently left out.',
      );
    }

    const totalAmount = money.fromUnits(totalUnits);
    // Reconcile against the salary payment when the run was paid: count and exact total must agree.
    const [payment] = await tx.select({ employeeCount: salaryPayment.employeeCount, totalAmount: salaryPayment.totalAmount })
      .from(salaryPayment).where(and(eq(salaryPayment.client, input.client), eq(salaryPayment.runId, run.runId))).limit(1);
    if (payment) {
      if (Number(payment.employeeCount) !== payable.length || money.entered(String(payment.totalAmount)) !== totalUnits) {
        refuse(
          'FILE_MISMATCH',
          `The run's frozen results (${payable.length} employees, ${totalAmount}) do not agree with its salary payment (${payment.employeeCount} employees, ${String(payment.totalAmount)}).`,
          'Report this run to an administrator; no payment file was produced.',
        );
      }
    }

    const runReference = runReferenceOf(run);
    const fileReference = fileReferenceOf(run);
    const preparationId = randomUUID();
    const personnelNumbers = payable.map((r) => r.personnelNumber);

    // Freeze the payment rows: clear metadata + the account identifier as an envelope bound to this file id.
    const snapshot: PaymentFileBankRow[] = payable.map((r) => {
      const bank = selected.get(r.personnelNumber)!;
      return {
        personnelNumber: r.personnelNumber,
        // The effective bank record's beneficiary name for the intended date, not the employee master.
        beneficiaryName: bank.beneficiaryName || r.fullName || r.personnelNumber,
        amount: money.text(String(r.netPay)),
        currency: run.currency,
        intendedPaymentDate,
        bankName: bank.bankName,
        bankCode: bank.bankCode,
        accountKind: bank.accountKind,
        accountCiphertext: encryptBankData(
          bank.accountValue,
          fileCipherContext(input.client, r.personnelNumber, preparationId),
          keyringFor(input.client),
        ),
      };
    });
    // The stored checksum covers the frozen snapshot deterministically (an integrity guard for the metadata).
    const checksum = checksumOf(Buffer.from(JSON.stringify(snapshot), 'utf8'));

    // Insert-or-return under the unique key: a second caller gets the snapshot the first one froze.
    await tx.execute(sql`
      insert into payroll_payment_file
        (client, preparation_id, run_id, company_code, fiscal_year, period, currency, intended_payment_date,
         file_reference, filename, row_count, total_amount, body, checksum, beneficiaries,
         bank_snapshot, bank_data_included, prepared_by, created_by)
      values
        (${input.client}, ${preparationId}, ${run.runId}, ${run.companyCode}, ${run.fiscalYear}, ${run.period}, ${run.currency},
         ${intendedPaymentDate}, ${fileReference}, ${filenameOf(run)}, ${snapshot.length}, ${totalAmount}, ${null}, ${checksum},
         ${JSON.stringify(personnelNumbers)}::jsonb, ${JSON.stringify(snapshot)}::jsonb, true, ${input.changedBy}, ${input.changedBy})
      on conflict (client, run_id) do nothing
    `);
    const row = await preparedOf(tx, input.client, run.runId);
    if (!row) refuse('FILE_WRITE', `The payment file for run ${run.runId} could not be stored.`, 'Try again; if it persists, report it to an administrator.');

    await audit(tx, input.client, access, row, row.preparationId === preparationId ? 'Prepared' : 'Concurrent prepare returned existing file');
    return viewOf(row, money);
  });
}

/** The keyring, or a fail-closed refusal. Loaded on demand; never a development fallback. */
function keyringFor(context: string): BankDataKeyring {
  try {
    return loadBankDataKeyring();
  } catch {
    refuse('FILE_KEYRING', `The bank-data keyring is not provisioned, so ${context} cannot include employee bank details.`, 'Ask a deployment administrator to provision the bank-data keyring, then prepare the file again.');
  }
}

/** The crypto context of a snapshotted identifier: tenant + employee + this file's id + field. */
function fileCipherContext(client: string, personnelNumber: string, preparationId: string) {
  return { client, partnerNumber: personnelNumber, bankRecordId: preparationId as never, field: 'paymentFileAccount' };
}

function decryptAccount(envelope: string, client: string, personnelNumber: string, bankRecordId: string): string {
  try {
    return decryptBankData(envelope, { client, partnerNumber: personnelNumber, bankRecordId: bankRecordId as never, field: 'employeeAccount' }, keyringFor(`employee ${personnelNumber}`));
  } catch (error) {
    if (isPaymentFileError(error)) throw error;
    refuse('FILE_KEYRING', `The bank account of employee ${personnelNumber} cannot be decrypted; the bank-data keyring is unavailable or the record is unreadable.`, 'Ask a deployment administrator to check the keyring. No payment file was produced.');
  }
}

// ── Downloading ─────────────────────────────────────────────────────────────

/**
 * The frozen file. Re-download is refused unless the caller confirms the duplicate-upload warning. Every
 * call re-judges the session, the capability, the run's company, every included employee's reach and the
 * reversal state, so a withdrawn authority or a reversal stops a repeat download too.
 */
export async function downloadPaymentFile(
  client: string,
  runIdInput: string,
  options: { confirmReuse?: boolean; requestedBy?: string | null } = {},
  access: PaymentFileAccess = { authorization: undefined },
): Promise<PaymentFileDownload> {
  return withTenant(client, async (tx) => {
    const grant = await judgeFileAndBank(tx, client, access);
    const { run, money } = await loadRunForFile(tx, client, runIdInput, grant);
    await assertNotReversed(tx, client, run);
    const row = await preparedOf(tx, client, run.runId);
    if (!row) {
      refuse(
        'FILE_NOT_PREPARED',
        `No payment file has been prepared for run ${run.runId}.`,
        'Prepare the file on the run screen first; preparing and downloading are separate steps.',
      );
    }
    await assertAllReachable(tx, client, grant, (row.beneficiaries as string[]) ?? [], run.periodTo);
    // Take the same per-run state lock as replacement approval/download so the supersession check and this
    // download are serialised with them: an approval that wins the lock first makes this refuse.
    await lockReissueState(tx, client, run.runId);
    // An old file with a superseded instruction is dangerous even if other employees remain active: block its
    // ordinary payment-ready re-download. It stays readable as protected historical evidence (9323).
    const superseded = (await tx.execute(sql`
      select 1 from payroll_payment_reissue_line l
        join payroll_payment_reissue r on r.client = l.client and r.reissue_id = l.reissue_id
       where l.client = ${client} and r.source_preparation_id = ${row.preparationId} and r.status = 'APPROVED' limit 1
    `)) as unknown as unknown[];
    if (superseded.length > 0) {
      refuse(
        'FILE_SUPERSEDED',
        `Payment file ${row.fileReference} contains instructions superseded by a replacement; it must not be uploaded again.`,
        'Use the approved replacement, or ask an authorized auditor to download this file as historical evidence (do not upload).',
      );
    }
    if (row.downloadCount > 0 && !options.confirmReuse) {
      refuse('FILE_REUSE', PAYMENT_FILE_REUSE_WARNING, 'Confirm the duplicate-upload warning to download the same file again.');
    }

    // A file with bank data has no stored plaintext body: rebuild it only from the frozen encrypted snapshot.
    // A legacy file (pre-9322) has its plaintext body and is returned byte-for-byte, unchanged.
    let body: Buffer;
    if (row.bankDataIncluded) {
      const snapshot = (row.bankSnapshot ?? []) as PaymentFileBankRow[];
      if (snapshot.length === 0) {
        refuse('FILE_BROKEN', `The payment file for run ${run.runId} carries bank data but no frozen snapshot.`, 'Report this run to an administrator; do not upload it.');
      }
      const keyring = keyringFor(`run ${run.runId}`);
      let rows: PaymentFileRow[];
      try {
        rows = paymentRowsFromSnapshot(
          snapshot,
          (r) => ({ client, partnerNumber: r.personnelNumber, bankRecordId: row.preparationId }),
          keyring,
        );
      } catch {
        refuse('FILE_KEYRING', `The bank details of run ${run.runId} cannot be decrypted; the bank-data keyring is unavailable.`, 'Ask a deployment administrator to provision the bank-data keyring. Nothing was downloaded.');
      }
      const rebuilt = buildPaymentCsv({ fileReference: row.fileReference, runReference: runReferenceOf(row) }, rows);
      body = Buffer.from(rebuilt, 'utf8');
    } else {
      if (!row.body || checksumOf(Buffer.from(row.body)) !== row.checksum) {
        refuse('FILE_CORRUPT', `The stored payment file for run ${run.runId} failed its integrity check.`, 'Report this run to an administrator; do not upload it.');
      }
      body = Buffer.from(row.body);
    }

    const now = new Date();
    await tx.update(payrollPaymentFile)
      .set({ downloadCount: row.downloadCount + 1, lastDownloadedBy: options.requestedBy ?? null, lastDownloadedAt: now, changedBy: options.requestedBy ?? 'SYSTEM', changedAt: now })
      .where(and(eq(payrollPaymentFile.client, client), eq(payrollPaymentFile.preparationId, row.preparationId)));
    await audit(tx, client, access, row, row.downloadCount > 0 ? 'Re-downloaded' : 'Downloaded');

    return {
      filename: row.filename,
      body,
      fileReference: row.fileReference,
      rowCount: row.rowCount,
      totalAmount: money.text(String(row.totalAmount)),
      reused: row.downloadCount > 0,
      downloadCount: row.downloadCount + 1,
    };
  });
}

/**
 * The audit row: who, when, the file reference, run, count and total. Never the CSV, a bank field or a
 * salary line item — those are pay data and do not belong in an access log.
 */
async function audit(tx: Tx, client: string, access: PaymentFileAccess, row: PreparedRow, verb: string): Promise<void> {
  const authorization = access.authorization;
  await tx.execute(sql`
    insert into audit_access_log (id, client, user_id, username, event_type, transaction_code, object_type, object_key, detail)
    values (
      ${randomUUID()}, ${client}, ${authorization?.userId ?? null}, ${null}, 'EXPORT', ${PAYMENT_FILE_CAPABILITY},
      'payroll_payment_file', ${row.preparationId},
      ${JSON.stringify({ verb, fileReference: row.fileReference, runId: row.runId, employeeCount: row.rowCount, totalAmount: String(row.totalAmount), currency: String(row.currency).trim() })}
    )
  `);
}

// Re-exported so callers and the screen share one pair of capability names for the read side.
export { PAYROLL_RESULT_CAPABILITY, PAYROLL_RUN_CAPABILITY };
