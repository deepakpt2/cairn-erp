/**
 * Controlled replacement of a generic salary payment file — all or selected employees.
 *
 * A controlled replacement payment run, implemented as generic manual-file processing: it never reproduces a
 * vendor-specific localization, never recalculates wages, never posts or reverses accounting and
 * never claims the bank paid anyone. It produces a new CSV instruction for manual conversion and upload.
 *
 * The process this file keeps:
 * 1. **Attestation, not bank truth.** For each selected employee the requester records the *actual original
 *    instruction outcome* as a user attestation — NOT_UPLOADED, BANK_REJECTED, CANCELLED_BEFORE_EXECUTION or
 *    RETURNED — with a reason, a verification date and evidence reference. NOT_UPLOADED additionally requires
 *    an explicit confirmation that no copy was submitted. Unknown, pending, accepted/paid or merely
 *    "cancellation requested" is refused. The ERP cannot revoke an uploaded file.
 * 2. **Frozen instruction, only selected employees.** The replacement carries each selected employee's
 *    original frozen net amount and currency from the source file — never a recalculation, never an arbitrary
 *    edit. Bank details are re-selected as of the replacement's intended payment date; missing/ambiguous/out
 *    of reach refuse. The rows are stored with encrypted account identifiers in a new immutable snapshot.
 * 3. **Separate approver.** A DRAFT is released only by a different authorized approver, who re-checks the
 *    eligibility, the exact frozen snapshot and live scope. Only then may it be downloaded.
 * 4. **Safety and history.** Original files and their snapshots are never changed. Each replacement links to
 *    its source and to the per-employee predecessor attempt. One active DRAFT per employee obligation.
 *    A file whose instructions are superseded is blocked from ordinary re-download; it stays readable as
 *    protected historical evidence, clearly marked do-not-upload.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { type ServiceAuthorityContext } from '../../platform/auth/service-authority';
import { withTenant, type Tx } from '../../platform/db/client';
import { MoneyError, moneyOf, refusing, type Money } from '../../platform/posting/money';
import { type BankDataKeyring, decryptBankData, encryptBankData } from '../../platform/security/bank-data-encryption';
import { loadBankDataKeyring } from '../../platform/security/bank-data-keyring';
import { accountingReversalLink } from '../finance/schema';
import { judgePayrollAccess, reachesCompany, type PayrollGrant } from './payroll-access';
import { accountAsOf } from './employee-bank';
import { currencyDecimals } from './payroll-run';
import { assertEmployeeScope, PayrollStructureError } from './payroll-structure';
import { lockEmployeeBank, lockRequestKey, lockReissueState } from './payment-file-locks';
import { reissueInputSignature } from './payment-reissue-inputs';
import { ArtifactError, artifactOf, ownerRequiresArtifact, readArtifact, retainArtifact } from './payment-file-artifacts';
import {
  PAYROLL_RUN_CAPABILITY,
  employee,
  payrollPaymentFile,
  payrollPaymentReissue,
  payrollPaymentReissueLine,
  payrollRun,
  salaryPayment,
  type PaymentFileBankRow,
  type ReissueAttestationOutcome,
} from './schema';
import {
  type PaymentFileRow,
  buildPaymentCsv,
  paymentRowsFromSnapshot,
  selectPayableResults,
} from './payroll-payment-file';

export const REISSUE_REQUEST_CAPABILITY = 'PEOPLE.PAYROLL.REISSUE.REQUEST';
export const REISSUE_APPROVE_CAPABILITY = 'PEOPLE.PAYROLL.REISSUE.APPROVE';
export const REISSUE_DOWNLOAD_CAPABILITY = 'PEOPLE.PAYROLL.REISSUE.DOWNLOAD';
export const FILE_HISTORICAL_CAPABILITY = 'PEOPLE.PAYROLL.FILE.HISTORICAL';
export const REISSUE_ROUTE = '/people/payroll-runs/payment-file/reissue';

export const REISSUE_WARNING =
  'A replacement is a new generic working file, not a bank format. Review and convert it to your bank’s '
  + 'required format before uploading it. The ERP does not send it to the bank; downloading is not sending and '
  + 'is not proof of payment. Uploading it again can pay employees twice — control every copy.';

export const HISTORICAL_WARNING =
  'HISTORICAL — DO NOT UPLOAD. This file contains instructions that have been superseded by a replacement '
  + 'and is kept as protected evidence only.';

export class ReissueError extends Error {
  remedy?: string;
  readonly code: string;
  constructor(message: string, remedy?: string, code = 'REISSUE') {
    super(message);
    this.name = 'ReissueError';
    this.remedy = remedy;
    this.code = code;
  }
}

export function isReissueError(error: unknown): error is ReissueError {
  return error instanceof ReissueError;
}

function refuse(code: string, message: string, remedy?: string): never {
  throw new ReissueError(message, remedy, code);
}

export interface ReissueAccess {
  authorization: ServiceAuthorityContext | undefined;
}

const REQUEST = [REISSUE_REQUEST_CAPABILITY] as const;
const APPROVE = [REISSUE_APPROVE_CAPABILITY] as const;
const DOWNLOAD = [REISSUE_DOWNLOAD_CAPABILITY] as const;
const VIEW = [REISSUE_REQUEST_CAPABILITY, REISSUE_APPROVE_CAPABILITY, REISSUE_DOWNLOAD_CAPABILITY, FILE_HISTORICAL_CAPABILITY] as const;
/** A full-identifier download also needs the live bank-reveal authority, exactly as the original file does. */
const BANK_REVEAL = ['PEOPLE.BANK.REVEAL'] as const;

const ATTESTATION_OUTCOMES: readonly ReissueAttestationOutcome[] = ['NOT_UPLOADED', 'BANK_REJECTED', 'CANCELLED_BEFORE_EXECUTION', 'RETURNED'];

// ── Input ───────────────────────────────────────────────────────────────────

const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.');
const text = (max: number, message: string) => z.string().trim().min(1, message).max(max);

const attestationInput = z.object({
  personnelNumber: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,20}$/, 'A personnel number is one to twenty capitals or digits.'),
  outcome: z.string().trim().min(1, 'Record the actual original outcome.'),
  reason: text(200, 'A reason is required.'),
  verificationDate: isoDate,
  evidenceReference: text(200, 'A bank/external reference or an explanation is required.'),
  /** Required true for NOT_UPLOADED: the requester confirms no copy was submitted. */
  confirmedNoSubmission: z.boolean().optional().default(false),
});
export type AttestationInput = z.input<typeof attestationInput>;

const requestInput = z.object({
  client: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,4}$/, 'A tenant is two to four capitals or digits.'),
  sourcePreparationId: z.string().trim().min(1).max(36),
  selection: z.enum(['ALL', 'SELECTED'], { message: 'Choose all employees of the file, or individual employees.' }),
  /** Present when selection = SELECTED. */
  personnelNumbers: z.array(z.string().trim().toUpperCase()).optional(),
  intendedPaymentDate: isoDate,
  reason: text(200, 'A reason for the replacement is required.'),
  attestations: z.array(attestationInput).min(1, 'At least one employee attestation is required.'),
  requestKey: z.string().trim().max(64).optional(),
  changedBy: z.string().trim().min(1).max(60),
});
export type RequestReissueInput = z.input<typeof requestInput>;

// ── Views ───────────────────────────────────────────────────────────────────

export interface ReissueLineView {
  lineNo: number;
  personnelNumber: string;
  /** The frozen beneficiary name (from the effective bank record at draft time). */
  beneficiaryName: string;
  /** Masked bank identifier (last four only). */
  maskedAccount: string;
  bankName: string;
  amount: string;
  currency: string;
  attestationOutcome: ReissueAttestationOutcome;
  attestationReason: string;
  verificationDate: string;
  evidenceReference: string;
  predecessorKind: 'FILE' | 'REISSUE';
  predecessorId: string;
}

export interface ReissueView {
  reissueId: string;
  sourcePreparationId: string;
  runId: string;
  companyCode: string;
  fiscalYear: number;
  period: number;
  version: number;
  reissueReference: string;
  filename: string;
  intendedPaymentDate: string;
  selection: 'ALL' | 'SELECTED';
  employeeCount: number;
  totalAmount: string;
  currency: string;
  status: 'DRAFT' | 'APPROVED' | 'CANCELLED';
  reason: string;
  requestedBy: string;
  requestedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  /** True when every line is still the latest approved attempt, so an ordinary download is offered. */
  downloadable: boolean;
  /** True when at least one line has been superseded by a later approved replacement. */
  superseded: boolean;
  /** The frozen snapshot digest the approver must acknowledge (equals the stored checksum). */
  snapshotDigest: string;
  lines: ReissueLineView[];
}

export interface ReissuePreview {
  sourcePreparationId: string;
  /** The normalized input signature the screen compares before submitting (source/mode/selection/date). */
  inputSignature: string;
  sourceFileReference: string;
  runId: string;
  selection: 'ALL' | 'SELECTED';
  intendedPaymentDate: string;
  employeeCount: number;
  totalAmount: string;
  currency: string;
  employees: Array<{
    personnelNumber: string;
    beneficiaryName: string;
    amount: string;
    /** Masked bank identifier chosen for the replacement. */
    maskedAccount: string;
    bankName: string;
    /** The attempt this replacement would replace. */
    predecessorKind: 'FILE' | 'REISSUE';
    predecessorId: string;
    eligible: boolean;
    blocker: string | null;
  }>;
  /** Employees of the source file that are ineligible and would be excluded — empty for a clean ALL preview. */
  ineligible: Array<{ personnelNumber: string; blocker: string }>;
  warning: string;
}

export interface ReissueDownload {
  filename: string;
  body: Buffer;
  reissueReference: string;
  employeeCount: number;
  totalAmount: string;
  reused: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

type FileRow = typeof payrollPaymentFile.$inferSelect;
type ReissueRow = typeof payrollPaymentReissue.$inferSelect;
type RunRow = typeof payrollRun.$inferSelect;

const mask = (value: string) => {
  const chars = Array.from(value);
  return chars.length <= 4 ? '••••' : `••••${chars.slice(-4).join('')}`;
};

function keyringOrRefuse(context: string): BankDataKeyring {
  try {
    return loadBankDataKeyring();
  } catch {
    refuse('REISSUE_KEYRING', `The bank-data keyring is not provisioned, so ${context} cannot be prepared.`, 'Ask a deployment administrator to provision the bank-data keyring, then try again.');
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const reissueCipherContext = (client: string, personnelNumber: string, reissueId: string) =>
  ({ client, partnerNumber: personnelNumber, bankRecordId: reissueId as never, field: 'paymentFileAccount' });

/** The frozen account value of one replacement row, or null if it cannot be decrypted (keyring unavailable). */
function frozenSnapshotAccount(frozen: PaymentFileBankRow, client: string, reissueId: string): string | null {
  try {
    return decryptBankData(frozen.accountCiphertext, reissueCipherContext(client, frozen.personnelNumber, reissueId), keyringOrRefuse(`employee ${frozen.personnelNumber}`));
  } catch {
    return null;
  }
}

/**
 * The payment-relevant destination of one employee on one date, decrypted in full, for an approval re-check.
 * Returns null when the destination cannot be read (no account, ambiguous, or unreadable) — a caller must treat
 * null as "fail closed", never as "unchanged".
 */
interface Destination {
  beneficiaryName: string;
  bankName: string;
  bankCode: string | null;
  accountKind: 'IBAN' | 'ACCOUNT';
  accountValue: string;
}
async function effectiveDestination(
  tx: Tx, client: string, personnelNumber: string, onDate: string,
): Promise<Destination | null> {
  let account;
  try {
    account = await accountAsOf(tx, client, personnelNumber, onDate);
  } catch (error) {
    if (isBankAmbiguous(error)) return null;
    throw error;
  }
  if (!account) return null;
  let accountValue: string;
  try {
    accountValue = decryptBankData(account.accountCiphertext, { client, partnerNumber: personnelNumber, bankRecordId: account.bankRecordId as never, field: 'employeeAccount' }, keyringOrRefuse(`employee ${personnelNumber}`));
  } catch {
    return null; // unreadable is not "unchanged"
  }
  return { beneficiaryName: account.beneficiaryName, bankName: account.bankName, bankCode: account.bankCode ?? null, accountKind: account.accountKind as 'IBAN' | 'ACCOUNT', accountValue };
}

/** The frozen destination of one replacement row, decrypted in full, or null if unreadable. */
function frozenDestination(frozen: PaymentFileBankRow, client: string, reissueId: string): Destination | null {
  const accountValue = frozenSnapshotAccount(frozen, client, reissueId);
  if (accountValue === null) return null;
  return { beneficiaryName: frozen.beneficiaryName, bankName: frozen.bankName, bankCode: frozen.bankCode ?? null, accountKind: frozen.accountKind, accountValue };
}

/** Are two destinations the same for payment purposes? Exact on every field that reaches the CSV. */
function sameDestination(a: Destination, b: Destination): boolean {
  return a.beneficiaryName === b.beneficiaryName
    && a.bankName === b.bankName
    && (a.bankCode ?? '') === (b.bankCode ?? '')
    && a.accountKind === b.accountKind
    && a.accountValue === b.accountValue;
}

/** The retained approved-replacement bytes, or a fail-closed refusal when the artifact is missing/unreadable. */
async function retainedReissueBytes(tx: Tx, client: string, row: ReissueRow, keyring: BankDataKeyring): Promise<Buffer> {
  const artifact = await artifactOf(tx, client, 'REISSUE', row.reissueId);
  if (!artifact) {
    refuse('REISSUE_ARTIFACT_UNAVAILABLE', `The retained file for replacement ${row.reissueReference} is missing from private storage.`, 'Ask a deployment administrator to restore CAIRN_PAYMENT_FILE_DIR; do not upload a substitute.');
  }
  const bytes = readArtifact(artifact, client, keyring);
  if (!bytes) {
    refuse('REISSUE_ARTIFACT_UNAVAILABLE', `The retained file for replacement ${row.reissueReference} is missing or unreadable in private storage.`, 'Ask a deployment administrator to restore the storage volume or keyring; do not upload a substitute.');
  }
  return bytes;
}

/**
 * Compatibility path for a replacement approved before host storage existed (no artifact row): rebuild exactly
 * from the immutable encrypted snapshot, byte-identical to the original generated file because nothing recalculates.
 */
function deterministicReissueBytes(tx: Tx, client: string, row: ReissueRow, snapshot: PaymentFileBankRow[], keyring: BankDataKeyring): Buffer {
  void tx;
  let rows: PaymentFileRow[];
  try {
    rows = paymentRowsFromSnapshot(snapshot, (r) => ({ client, partnerNumber: r.personnelNumber, bankRecordId: row.reissueId }), keyring);
  } catch {
    refuse('REISSUE_KEYRING', `The bank details of replacement ${row.reissueReference} cannot be decrypted; the bank-data keyring is unavailable.`, 'Ask a deployment administrator to provision the keyring. Nothing was downloaded.');
  }
  return Buffer.from(buildPaymentCsv({ fileReference: row.reissueReference, runReference: runRefOf(row) }, rows), 'utf8');
}

/** Prefer the exact retained bytes; fall back to a deterministic legacy rebuild when no artifact row exists. */
async function reissueBodyBytes(tx: Tx, client: string, row: ReissueRow, snapshot: PaymentFileBankRow[], keyring: BankDataKeyring): Promise<Buffer> {
  const artifact = await artifactOf(tx, client, 'REISSUE', row.reissueId);
  if (artifact) return retainedReissueBytes(tx, client, row, keyring);
  // NEW-format row without its artifact: fail closed, never rebuild a substitute.
  if (await ownerRequiresArtifact(tx, client, 'REISSUE', row.reissueId)) {
    refuse('REISSUE_ARTIFACT_UNAVAILABLE', `The retained file for replacement ${row.reissueReference} is missing from private storage.`, 'Ask a deployment administrator to restore CAIRN_PAYMENT_FILE_DIR; do not upload a substitute.');
  }
  return deterministicReissueBytes(tx, client, row, snapshot, keyring);
}

async function judge(tx: Tx, client: string, access: ReissueAccess | undefined, capabilities: readonly string[], code = 'REISSUE_AUTHORITY'): Promise<PayrollGrant> {
  return judgePayrollAccess(tx, client, access, capabilities, refuse, code);
}

/** A full-identifier download: the named reissue/historical authority AND the live bank-reveal authority. */
async function judgeFullDownload(tx: Tx, client: string, access: ReissueAccess | undefined, capabilities: readonly string[]): Promise<PayrollGrant> {
  const grant = await judge(tx, client, access, capabilities);
  await judge(tx, client, access, BANK_REVEAL, 'REISSUE_BANK_AUTHORITY');
  return grant;
}

/** Does the grant reach every one of these employees? Used to avoid disclosing out-of-reach data. */
async function allReachable(tx: Tx, client: string, grant: PayrollGrant, personnelNumbers: readonly string[], onDate: string): Promise<boolean> {
  for (const pn of personnelNumbers) {
    try {
      await assertEmployeeScope(tx, client, grant, pn, onDate);
    } catch (error) {
      if (error instanceof PayrollStructureError) return false;
      throw error;
    }
  }
  return true;
}

async function assertReachable(tx: Tx, client: string, grant: PayrollGrant, personnelNumbers: readonly string[], onDate: string, code = 'EMPLOYEE_SCOPE'): Promise<void> {
  for (const pn of personnelNumbers) {
    try {
      await assertEmployeeScope(tx, client, grant, pn, onDate);
    } catch (error) {
      if (error instanceof PayrollStructureError) {
        refuse(code, 'One or more selected employees are outside your Company Code or Plant scope.', 'Ask an administrator to extend your scope. Nothing was produced.');
      }
      throw error;
    }
  }
}

async function assertNotReversed(tx: Tx, client: string, run: RunRow): Promise<void> {
  if (run.documentNumber && run.documentFiscalYear !== null) {
    const [reversal] = await tx.select({ reversalDocumentNumber: accountingReversalLink.reversalDocumentNumber })
      .from(accountingReversalLink).where(and(
        eq(accountingReversalLink.client, client),
        eq(accountingReversalLink.originalCompanyCode, run.companyCode),
        eq(accountingReversalLink.originalDocumentNumber, run.documentNumber),
        eq(accountingReversalLink.originalFiscalYear, run.documentFiscalYear),
      )).limit(1);
    if (reversal) refuse('RUN_REVERSED', `Payroll run ${run.runId} was reversed (document ${reversal.reversalDocumentNumber}); no replacement file is produced after a reversal.`, 'An administrator must resolve the reversal first.');
  }
  // The salary payment (PY) is a second accounting document this instruction stands beside: a reversed salary
  // payment refuses a replacement too, exactly as the ordinary file service does.
  const [payment] = await tx.select().from(salaryPayment)
    .where(and(eq(salaryPayment.client, client), eq(salaryPayment.runId, run.runId))).limit(1);
  if (payment) {
    const [paymentReversal] = await tx.select({ reversalDocumentNumber: accountingReversalLink.reversalDocumentNumber })
      .from(accountingReversalLink).where(and(
        eq(accountingReversalLink.client, client),
        eq(accountingReversalLink.originalCompanyCode, payment.companyCode),
        eq(accountingReversalLink.originalDocumentNumber, payment.documentNumber),
        eq(accountingReversalLink.originalFiscalYear, payment.documentFiscalYear),
      )).limit(1);
    if (paymentReversal) {
      refuse('PAYMENT_REVERSED', `The salary payment of run ${run.runId} was reversed (document ${paymentReversal.reversalDocumentNumber}); no replacement file is produced after a reversal.`, 'An administrator must resolve the reversal first.');
    }
  }
}

/** Is this employee's instruction in the source file superseded by an approved/live replacement? */
async function supersedingReissue(tx: Tx, client: string, runId: string, personnelNumber: string): Promise<string | null> {
  const rows = (await tx.execute(sql`
    select l.reissue_id from payroll_payment_reissue_line l
      join payroll_payment_reissue r on r.client = l.client and r.reissue_id = l.reissue_id
     where l.client = ${client} and l.run_id = ${runId} and l.personnel_number = ${personnelNumber}
       and l.state = 'APPROVED' and r.status = 'APPROVED'
     order by r.approved_at desc limit 1
  `)) as unknown as Array<{ reissue_id: string }>;
  return rows[0]?.reissue_id ?? null;
}

/** A different replacement approved for this employee AFTER the given instant — a genuine stale conflict. */
async function supersededAfter(tx: Tx, client: string, runId: string, personnelNumber: string, after: Date | string, exceptId: string): Promise<string | null> {
  const rows = (await tx.execute(sql`
    select l.reissue_id from payroll_payment_reissue_line l
      join payroll_payment_reissue r on r.client = l.client and r.reissue_id = l.reissue_id
     where l.client = ${client} and l.run_id = ${runId} and l.personnel_number = ${personnelNumber}
       and l.state = 'APPROVED' and r.status = 'APPROVED' and r.reissue_id <> ${exceptId}
       and r.approved_at > ${after instanceof Date ? after.toISOString() : after}::timestamptz
     order by r.approved_at desc limit 1
  `)) as unknown as Array<{ reissue_id: string }>;
  return rows[0]?.reissue_id ?? null;
}

/** The latest APPROVED replacement per employee in a run: personnel number → reissue id. */
async function latestApprovedByEmployee(tx: Tx, client: string, runId: string): Promise<Map<string, string>> {
  const rows = (await tx.execute(sql`
    select distinct on (l.personnel_number) l.personnel_number, r.reissue_id
      from payroll_payment_reissue_line l
      join payroll_payment_reissue r on r.client = l.client and r.reissue_id = l.reissue_id
     where l.client = ${client} and l.run_id = ${runId} and l.state = 'APPROVED' and r.status = 'APPROVED'
     order by l.personnel_number, r.approved_at desc, r.version desc
  `)) as unknown as Array<{ personnel_number: string; reissue_id: string }>;
  return new Map(rows.map((r) => [r.personnel_number, r.reissue_id]));
}

/**
 * Refuse to release or download an old replacement if ANY of its employees is now superseded by a later
 * approved attempt. Returns the first offending employee so the caller can explain without leaking data
 * beyond the caller's reach (the caller already has the reissue's own snapshot).
 */
async function assertNotSuperseded(tx: Tx, client: string, row: ReissueRow, verb: string): Promise<void> {
  const latest = await latestApprovedByEmployee(tx, client, row.runId);
  const tail = verb === 'download' ? 'This file must not be uploaded; use the current replacement.' : 'Cancel this draft; a stale attempt is never released.';
  for (const line of await linesOf(tx, client, row.reissueId)) {
    const newest = latest.get(line.personnelNumber);
    if (newest && newest !== row.reissueId) {
      refuse(
        'REISSUE_SUPERSEDED',
        `Employee ${line.personnelNumber} in ${row.reissueReference} has a later approved replacement; this ${verb === 'download' ? 'file' : 'draft'} is superseded.`,
        `${verb === 'download' ? 'Download the current replacement, or read this one as historical evidence (do not upload).' : tail}`,
      );
    }
  }
}

/**
 * Every employee in a frozen file. A file with bank data carries `bankSnapshot`; a legacy file (pre-bank)
 * carries only a plaintext CSV `body`, which is parsed back into rows so it stays eligible for replacement
 * once account data is complete. Parsing never changes the stored file.
 */
function snapshotRowsOf(file: FileRow): PaymentFileBankRow[] {
  if (file.bankDataIncluded) return (file.bankSnapshot ?? []) as PaymentFileBankRow[];
  if (!file.body) return [];
  return parseLegacyBody(Buffer.from(file.body).toString('utf8'));
}

/** Recover frozen rows from a legacy generic CSV body (same column order as `buildPaymentCsv`). */
function parseLegacyBody(csv: string): PaymentFileBankRow[] {
  const lines = csv.split(/\r\n|\n/).filter((l) => l.length > 0);
  if (lines.length <= 1) return [];
  const rows: PaymentFileBankRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    if (cols.length < 12) continue;
    const personnelNumber = cols[2]!;
    const kind = cols[9] && cols[9].length > 0 ? 'ACCOUNT' : 'IBAN';
    rows.push({
      personnelNumber,
      beneficiaryName: cols[3] ?? personnelNumber,
      amount: cols[4] ?? '0',
      currency: cols[5] ?? '',
      intendedPaymentDate: cols[6] ?? '',
      bankName: cols[7] ?? '',
      bankCode: cols[8] || null,
      accountKind: kind,
      accountCiphertext: '', // legacy rows carried no identifier; a replacement re-selects current details
    });
  }
  return rows;
}

/** A minimal RFC 4180 line reader, enough to recover a frozen legacy row. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** The one approved/live instruction attempt for an employee: a reissue if one supersedes, else the source. */
async function predecessorOf(tx: Tx, client: string, file: FileRow, personnelNumber: string): Promise<{ kind: 'FILE' | 'REISSUE'; id: string }> {
  const sup = await supersedingReissue(tx, client, file.runId, personnelNumber);
  return sup ? { kind: 'REISSUE', id: sup } : { kind: 'FILE', id: file.preparationId };
}

/**
 * Resolve each employee's original frozen amount from a source attempt: the source file's snapshot, or one of
 * its approved reissues. Amount/currency come from the frozen snapshot — never recalculated.
 */
async function frozenAmountOf(
  tx: Tx, client: string, file: FileRow, kind: 'FILE' | 'REISSUE', id: string, personnelNumber: string, money: Money,
): Promise<{ amount: string; currency: string; beneficiaryName: string }> {
  if (kind === 'FILE') {
    const row = snapshotRowsOf(file).find((r) => r.personnelNumber === personnelNumber);
    if (!row) refuse('REISSUE_SOURCE', `Employee ${personnelNumber} is not in the source file.`, 'Choose employees from the file you are replacing.');
    return { amount: money.text(row.amount), currency: row.currency, beneficiaryName: row.beneficiaryName };
  }
  const [prior] = await tx.select().from(payrollPaymentReissue)
    .where(and(eq(payrollPaymentReissue.client, client), eq(payrollPaymentReissue.reissueId, id))).limit(1);
  if (!prior) refuse('REISSUE_STALE', `The prior replacement for ${personnelNumber} no longer exists.`, 'Reload the file history and choose again.');
  const row = snapshotRowsOf({ ...file, bankSnapshot: prior.bankSnapshot }).find((r) => r.personnelNumber === personnelNumber);
  if (!row) refuse('REISSUE_STALE', `Employee ${personnelNumber} is not in the prior replacement.`, 'Reload the file history and choose again.');
  return { amount: money.text(row.amount), currency: row.currency, beneficiaryName: row.beneficiaryName };
}

// ── Preview ─────────────────────────────────────────────────────────────────

/**
 * Preview a replacement for all or selected employees. Reads only; every eligibility rule is applied so the
 * screen can explain, per employee, why they cannot be replaced yet. No file is created here.
 */
export async function previewReissue(
  client: string,
  input: { sourcePreparationId: string; selection: 'ALL' | 'SELECTED'; personnelNumbers?: string[]; intendedPaymentDate: string },
  access: ReissueAccess | undefined,
): Promise<ReissuePreview> {
  return withTenant(client, async (tx) => {
    const grant = await judge(tx, client, access, REQUEST);
    const file = await loadSourceFile(tx, client, input.sourcePreparationId, grant);
    const run = await loadRun(tx, client, file.runId);
    await assertNotReversed(tx, client, run);
    if (!isCalendarDate(input.intendedPaymentDate)) refuse('PAYMENT_DATE', `Intended payment date ${input.intendedPaymentDate} is not a calendar date.`, 'Enter the date as YYYY-MM-DD.');
    const money = await moneyForRun(tx, run);

    const all = snapshotRowsOf(file);
    const wanted = input.selection === 'ALL' ? all.map((r) => r.personnelNumber) : normaliseSelection(input.personnelNumbers);

    // Scope before disclosure. A whole-file (ALL) preview fails closed if any employee is outside reach; a
    // selected preview checks EVERY requested number for reach FIRST — including numbers that may not be in the
    // file — so neither membership nor an out-of-scope employee is revealed. Missing and out-of-reach answer the
    // same way.
    const toCheck = input.selection === 'ALL' ? all.map((r) => r.personnelNumber) : wanted;
    if (!(await allReachable(tx, client, grant, toCheck, input.intendedPaymentDate))) {
      refuse('FILE_UNAVAILABLE', 'That file does not exist, or is not available to you.', 'Open a file whose employees are all within your Company Code or Plant scope.');
    }

    const employees: ReissuePreview['employees'] = [];
    const ineligible: ReissuePreview['ineligible'] = [];

    for (const pn of wanted) {
      const inFile = all.find((r) => r.personnelNumber === pn);
      if (!inFile) {
        ineligible.push({ personnelNumber: pn, blocker: 'Not in this file' });
        continue;
      }
      const eligibility = await employeeEligibility(tx, client, grant, file, pn, input.intendedPaymentDate, money);
      // A DRAFT already standing for this obligation blocks another.
      const activeDraft = await activeDraftFor(tx, client, file.runId, pn);
      let blocker = eligibility.blocker;
      if (!blocker && activeDraft) blocker = `A replacement draft ${activeDraft} already exists for this employee; approve or cancel it first.`;
      const predecessor = await predecessorOf(tx, client, file, pn);
      employees.push({
        personnelNumber: pn,
        beneficiaryName: inFile.beneficiaryName,
        amount: eligibility.amount,
        maskedAccount: eligibility.maskedAccount,
        bankName: eligibility.bankName,
        predecessorKind: predecessor.kind,
        predecessorId: predecessor.id,
        eligible: !blocker,
        blocker,
      });
      if (blocker) ineligible.push({ personnelNumber: pn, blocker });
    }

    const totalUnits = employees.filter((e) => e.eligible).reduce((sum, e) => sum + money.units(e.amount), 0n);
    return {
      sourcePreparationId: file.preparationId,
      inputSignature: reissueInputSignature({ source: file.preparationId, selection: input.selection, selected: wanted, date: input.intendedPaymentDate }),
      sourceFileReference: file.fileReference,
      runId: file.runId,
      selection: input.selection,
      intendedPaymentDate: input.intendedPaymentDate,
      employeeCount: employees.filter((e) => e.eligible).length,
      totalAmount: money.fromUnits(totalUnits),
      currency: String(file.currency).trim(),
      employees,
      ineligible,
      warning: REISSUE_WARNING,
    };
  });
}

async function employeeEligibility(
  tx: Tx, client: string, grant: PayrollGrant, file: FileRow, personnelNumber: string, intendedPaymentDate: string, money: Money,
): Promise<{ amount: string; maskedAccount: string; bankName: string; blocker: string | null; accountValue: string; accountKind: 'IBAN' | 'ACCOUNT'; bankCode: string | null; beneficiaryName: string | null }> {
  const source = snapshotRowsOf(file).find((r) => r.personnelNumber === personnelNumber);
  const amount = source ? money.text(source.amount) : '';
  const blank = { accountValue: '', accountKind: 'ACCOUNT' as const, bankCode: null, beneficiaryName: null };
  if (!source) return { amount, maskedAccount: '••••', bankName: '', blocker: 'Not in this file', ...blank };
  // Reach is required for every selected employee (fail closed).
  try {
    await assertEmployeeScope(tx, client, grant, personnelNumber, intendedPaymentDate);
  } catch (error) {
    if (error instanceof PayrollStructureError) return { amount, maskedAccount: '••••', bankName: '', blocker: 'Outside your Company Code or Plant scope', ...blank };
    throw error;
  }
  let account;
  try {
    account = await accountAsOf(tx, client, personnelNumber, intendedPaymentDate);
  } catch (error) {
    if (isBankAmbiguous(error)) return { amount, maskedAccount: '••••', bankName: '', blocker: `More than one active main account on ${intendedPaymentDate}`, ...blank };
    throw error;
  }
  if (!account) return { amount, maskedAccount: '••••', bankName: '', blocker: `No bank account is effective on ${intendedPaymentDate}`, ...blank };
  let accountValue: string;
  try {
    accountValue = decryptBankData(account.accountCiphertext, { client, partnerNumber: personnelNumber, bankRecordId: account.bankRecordId as never, field: 'employeeAccount' }, keyringOrRefuse(`employee ${personnelNumber}`));
  } catch (error) {
    if (isReissueError(error)) throw error;
    return { amount, maskedAccount: '••••', bankName: account.bankName, blocker: 'Bank details could not be decrypted (keyring unavailable or record unreadable)', ...blank };
  }
  return { amount, maskedAccount: mask(accountValue), bankName: account.bankName, blocker: null, accountValue, accountKind: account.accountKind as 'IBAN' | 'ACCOUNT', bankCode: account.bankCode ?? null, beneficiaryName: account.beneficiaryName };
}

function isBankAmbiguous(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'BANK_AMBIGUOUS';
}

// ── Request (create a DRAFT) ─────────────────────────────────────────────────

/** Create a frozen, encrypted replacement draft for all or selected employees. An approver releases it. */
export async function requestReissue(rawInput: RequestReissueInput, access: ReissueAccess | undefined): Promise<ReissueView> {
  const input = requestInput.parse(rawInput);
  return withTenant(input.client, async (tx) => {
    const grant = await judge(tx, input.client, access, REQUEST);
    const file = await loadSourceFile(tx, input.client, input.sourcePreparationId, grant);
    const run = await loadRun(tx, input.client, file.runId);
    await assertNotReversed(tx, input.client, run);
    const money = await moneyForRun(tx, run);
    if (!isCalendarDate(input.intendedPaymentDate)) refuse('PAYMENT_DATE', `Intended payment date ${input.intendedPaymentDate} is not a calendar date.`, 'Enter the date as YYYY-MM-DD.');

    // Idempotency: a repeated key replays only an IDENTICAL normalized request. The fingerprint covers the
    // source, the all/selected set, the intended date, the reason and every attestation field. It is computed
    // BEFORE any disclosure, so the replay path never returns employee data outside the caller's reach.
    const sourceId = file.preparationId;
    const selectionSet = (input.selection === 'ALL'
      ? snapshotRowsOf(file).map((r) => r.personnelNumber)
      : normaliseSelection(input.personnelNumbers));
    const attestationsNormalized = [...input.attestations]
      .map((a) => ({ personnelNumber: a.personnelNumber.toUpperCase(), outcome: a.outcome, reason: a.reason, verificationDate: a.verificationDate, evidenceReference: a.evidenceReference, confirmedNoSubmission: a.confirmedNoSubmission ?? false }))
      .sort((a, b) => a.personnelNumber.localeCompare(b.personnelNumber));
    const fingerprint = createHash('sha256').update(canonicalJson({
      source: sourceId, selection: input.selection, employees: [...selectionSet].sort(), intendedPaymentDate: input.intendedPaymentDate,
      reason: input.reason, attestations: attestationsNormalized,
    }), 'utf8').digest('hex');
    if (input.requestKey) {
      // Serialise on the KEY (not just the run) so two identical concurrent submissions — even across runs —
      // wait here; the second then finds the first's draft and replays it. The DB unique index on
      // (client, request_key) remains the backstop.
      await lockRequestKey(tx, input.client, input.requestKey);
      const [replay] = await tx.select().from(payrollPaymentReissue)
        .where(and(eq(payrollPaymentReissue.client, input.client), eq(payrollPaymentReissue.requestKey, input.requestKey))).limit(1);
      if (replay) {
        // A legacy draft has no fingerprint: never guess — refuse rather than risk returning the wrong draft.
        if (!replay.requestFingerprint) {
          refuse('REISSUE_KEY_REUSED', 'This request key belongs to an older draft that cannot be verified as identical.', 'Reload the screen to get a fresh request key.');
        }
        if (replay.requestFingerprint !== fingerprint) {
          refuse('REISSUE_KEY_REUSED', 'This request key was already used for a different replacement request.', 'Reload the screen to get a fresh request key.');
        }
        // Recheck live scope before any replay leaves the service.
        await assertReachable(tx, input.client, grant, (replay.bankSnapshot as PaymentFileBankRow[]).map((r) => r.personnelNumber), replay.intendedPaymentDate);
        return viewOf(tx, input.client, replay, money);
      }
    }

    const all = snapshotRowsOf(file);
    const selected = input.selection === 'ALL' ? all.map((r) => r.personnelNumber) : normaliseSelection(input.personnelNumbers);
    if (selected.length === 0) refuse('NO_SELECTION', 'No employee was selected.', 'Choose all employees of the file, or select at least one employee.');
    // Reach BEFORE membership: an out-of-scope number and a number missing from the file answer the same way, so
    // neither the employee's existence nor file membership is disclosed.
    if (!(await allReachable(tx, input.client, grant, selected, input.intendedPaymentDate))) {
      refuse('FILE_UNAVAILABLE', 'That file does not exist, or is not available to you.', 'Open a file whose employees are all within your Company Code or Plant scope.');
    }
    for (const pn of selected) {
      if (!all.some((r) => r.personnelNumber === pn)) refuse('NOT_IN_FILE', `Employee ${pn} is not in this file.`, 'Select employees from the file you are replacing.');
    }

    // Attestations must cover exactly the selected employees, each a valid terminal outcome.
    const attestByPn = new Map(input.attestations.map((a) => [a.personnelNumber, a]));
    const missingAttest = selected.filter((pn) => !attestByPn.has(pn));
    if (missingAttest.length > 0) {
      refuse('ATTESTATION_REQUIRED', `Record the actual original outcome for: ${missingAttest.join(', ')}.`, 'Every selected employee needs an attested outcome, a reason, a verification date and an evidence reference.');
    }
    for (const a of input.attestations) {
      if (!(ATTESTATION_OUTCOMES as readonly string[]).includes(a.outcome)) refuse('ATTESTATION_INVALID', `Outcome ${a.outcome} is not an accepted original outcome.`, 'Accepted: not uploaded, bank rejected, cancelled before execution, returned.');
      if (!isCalendarDate(a.verificationDate)) refuse('ATTESTATION_DATE', `Verification date ${a.verificationDate} is not a calendar date.`, 'Enter the date as YYYY-MM-DD.');
      if (a.outcome === 'NOT_UPLOADED' && !a.confirmedNoSubmission) {
        refuse('NO_SUBMISSION_UNCONFIRMED', `Employee ${a.personnelNumber}: "not uploaded" needs an explicit confirmation that no copy was submitted.`, 'Confirm that no copy of the file was uploaded to the bank. If any copy may exist, choose a different outcome.');
      }
    }

    // An existing DRAFT for any selected employee is a conflict, checked first (before eligibility).
    const conflicting: string[] = [];
    for (const pn of selected) {
      const draft = await activeDraftFor(tx, input.client, file.runId, pn);
      if (draft) conflicting.push(`${pn} (${draft})`);
    }
    if (conflicting.length > 0) {
      refuse('REISSUE_CONFLICT', `Another replacement draft already exists for: ${conflicting.join(', ')}.`, 'Approve or cancel the existing draft first. Nothing was created.');
    }

    // Eligibility (reach and a valid effective account) for every selected employee; refuse the WHOLE request.
    const inaccessible: string[] = [];
    for (const pn of selected) {
      const eligibility = await employeeEligibility(tx, input.client, grant, file, pn, input.intendedPaymentDate, money);
      if (eligibility.blocker) inaccessible.push(`${pn} (${eligibility.blocker})`);
    }
    if (inaccessible.length > 0) {
      refuse('REISSUE_INELIGIBLE', `No replacement was created; these employees are not eligible: ${inaccessible.join('; ')}.`, 'Resolve each (bank details or scope), then request again. No partial file is produced.');
    }

    // Serialise per run so a concurrent request cannot form a second draft set for the same employees.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`payment-reissue:${input.client}:${file.runId}`}, 0))`);
    const again = [];
    for (const pn of selected) {
      const draft = await activeDraftFor(tx, input.client, file.runId, pn);
      if (draft) again.push(`${pn} (${draft})`);
    }
    if (again.length > 0) {
      refuse('REISSUE_CONFLICT', `Another replacement draft already exists for: ${again.join(', ')}.`, 'Approve or cancel the existing draft first. Nothing was created.');
    }

    const version = await nextVersion(tx, input.client, file.runId);
    const reissueId = randomUUID();
    const reissueReference = `${file.fileReference}-R${version}`.slice(0, 60);
    const filename = `salary-payment-reissue-${file.companyCode}-${file.fiscalYear}-${String(file.period).padStart(2, '0')}-v${version}.csv`;

    // Freeze rows with the replacement's effective bank details, encrypted to this reissue's id.
    const snapshot: PaymentFileBankRow[] = [];
    const lines: Array<typeof payrollPaymentReissueLine.$inferInsert> = [];
    let totalUnits = 0n;
    for (let i = 0; i < selected.length; i++) {
      const pn = selected[i]!;
      const elig = await employeeEligibility(tx, input.client, grant, file, pn, input.intendedPaymentDate, money);
      const att = attestByPn.get(pn)!;
      const predecessor = await predecessorOf(tx, input.client, file, pn);
      const sourceRow = snapshotRowsOf(file).find((r) => r.personnelNumber === pn)!;
      totalUnits += money.units(elig.amount);
      snapshot.push({
        personnelNumber: pn,
        // The effective bank record's beneficiary name for the intended date, not the employee master.
        beneficiaryName: elig.beneficiaryName ?? sourceRow.beneficiaryName,
        amount: elig.amount,
        currency: String(file.currency).trim(),
        intendedPaymentDate: input.intendedPaymentDate,
        bankName: elig.bankName,
        bankCode: elig.bankCode,
        accountKind: elig.accountKind,
        accountCiphertext: encryptBankData(elig.accountValue, reissueCipherContext(input.client, pn, reissueId), keyringOrRefuse(`employee ${pn}`)),
      });
      lines.push({
        client: input.client, reissueId, lineNo: i + 1, runId: file.runId, personnelNumber: pn,
        amount: elig.amount, currency: String(file.currency).trim(),
        predecessorKind: predecessor.kind, predecessorId: predecessor.id,
        attestationOutcome: att.outcome, attestationReason: att.reason, verificationDate: att.verificationDate,
        evidenceReference: att.evidenceReference, confirmedNoSubmission: att.confirmedNoSubmission ?? false,
        state: 'DRAFT', createdBy: input.changedBy,
      });
    }
    const totalAmount = money.fromUnits(totalUnits);
    const checksum = createHash('sha256').update(canonicalJson(snapshot), 'utf8').digest('hex');

    await tx.insert(payrollPaymentReissue).values({
      client: input.client, reissueId, sourcePreparationId: file.preparationId, runId: file.runId,
      companyCode: file.companyCode, fiscalYear: file.fiscalYear, period: file.period, currency: file.currency,
      version, reissueReference, filename, intendedPaymentDate: input.intendedPaymentDate, selection: input.selection,
      employeeCount: selected.length, totalAmount, status: 'DRAFT', reason: input.reason,
      bankSnapshot: snapshot, checksum, requestKey: input.requestKey ?? null, requestFingerprint: fingerprint,
      requestedBy: input.changedBy, createdBy: input.changedBy,
    });
    await tx.insert(payrollPaymentReissueLine).values(lines);
    await recordChange(tx, {
      client: input.client, objectClass: 'payroll_payment_reissue', objectKey: reissueId, changeType: 'CREATE',
      changedBy: input.changedBy, transactionCode: REISSUE_REQUEST_CAPABILITY,
      after: { reissueReference, version, selection: input.selection, employeeCount: selected.length, totalAmount, runId: file.runId },
    });
    await auditReissue(tx, input.client, access, reissueId, 'Requested', { reissueReference, version, employeeCount: selected.length, totalAmount });

    const [row] = await tx.select().from(payrollPaymentReissue).where(and(eq(payrollPaymentReissue.client, input.client), eq(payrollPaymentReissue.reissueId, reissueId))).limit(1);
    return viewOf(tx, input.client, row!, money);
  });
}

// ── Approve / cancel ─────────────────────────────────────────────────────────

/**
 * Approve (release) a draft. A different authorized approver re-checks: not the requester, the frozen snapshot
 * unchanged, every employee still eligible and in reach on the intended date, and no superseding attempt.
 */
export async function approveReissue(
  client: string,
  reissueId: string,
  approver: string,
  access: ReissueAccess | undefined,
  options: { confirmDigest?: string; reviewedAssertion?: boolean } = {},
): Promise<ReissueView> {
  const approverName = String(approver ?? '').trim();
  if (!approverName) refuse('FOUR_EYES', 'An approver is required.', 'Sign in as a different, authorized approver.');
  return withTenant(client, async (tx) => {
    const grant = await judge(tx, client, access, APPROVE);
    const row = await loadReissue(tx, client, reissueId);
    if (!row) refuse('REISSUE_UNAVAILABLE', 'That replacement does not exist, or is not available to you.', 'Open a file you reach.');
    // Lock order: every employee bank lock (sorted) BEFORE the run state lock; no path takes them the other way.
    const draftPns = (row.bankSnapshot as PaymentFileBankRow[]).map((r) => r.personnelNumber);
    await lockEmployeeBank(tx, client, draftPns);
    await lockReissueState(tx, client, row.runId);
    // Re-read under both locks so a racing action that already moved the state or the bank data is observed.
    const locked = await loadReissue(tx, client, reissueId);
    if (!locked) refuse('REISSUE_UNAVAILABLE', 'That replacement does not exist, or is not available to you.', 'Open a file you reach.');
    // Scope BEFORE disclosing reference, status, holder or four-eyes: establish the original run's company and
    // live reach for every included employee first. An out-of-scope target and a missing one answer identically.
    const run = await loadRun(tx, client, locked.runId);
    const lockedPns = (locked.bankSnapshot as PaymentFileBankRow[]).map((r) => r.personnelNumber);
    if (!reachesCompany(grant, run.companyCode)
      || !(await allReachable(tx, client, grant, lockedPns, locked.intendedPaymentDate))) {
      refuse('REISSUE_UNAVAILABLE', 'That replacement does not exist, or is not available to you.', 'Open a file you reach.');
    }
    if (locked.status !== 'DRAFT') refuse('REISSUE_STATE', `Replacement ${locked.reissueReference} is ${locked.status.toLowerCase()}; only a draft can be approved.`, 'Reload the file history.');
    if (approverName.toLowerCase() === locked.requestedBy.toLowerCase()) {
      refuse('FOUR_EYES', 'You requested this replacement; a different person must approve it.', 'Ask another authorized approver.');
    }
    await assertNotReversed(tx, client, run);
    const money = await moneyForRun(tx, run);
    const lines = await linesOf(tx, client, locked.reissueId);
    // Re-check the exact frozen snapshot and eligibility for every line.
    const snapshot = (locked.bankSnapshot ?? []) as PaymentFileBankRow[];
    const expected = createHash('sha256').update(canonicalJson(snapshot), 'utf8').digest('hex');
    if (expected !== locked.checksum) refuse('REISSUE_TAMPERED', `Replacement ${locked.reissueReference} failed its integrity check.`, 'Do not release it; report it to an administrator.');
    if (snapshot.length !== lines.length) refuse('REISSUE_TAMPERED', `Replacement ${locked.reissueReference} does not match its lines.`, 'Do not release it; report it to an administrator.');
    await assertReachable(tx, client, grant, lines.map((l) => l.personnelNumber), locked.intendedPaymentDate);
    // A deliberate review needs TWO things: an explicit assertion (in the SERVICE, not only the HTTP route) and
    // the complete review digest. The assertion is evidence of what the approver submitted, not proof of reading.
    if (options.reviewedAssertion !== true) {
      refuse('REISSUE_CONFIRMATION_REQUIRED', 'Approve only after reviewing the frozen instruction; the review assertion is missing.', 'Open Review on the draft, check the employees, amounts and destination, tick the acknowledgment, then approve.');
    }
    const confirmed = String(options.confirmDigest ?? '').trim();
    if (!confirmed) {
      refuse('REISSUE_CONFIRMATION_REQUIRED', 'Approve only after reviewing the frozen instruction; the confirmation digest is missing or stale.', 'Open Review on the draft, check the employees and destination, then approve.');
    }
    if (confirmed !== reviewDigest(locked, lines)) {
      refuse('REISSUE_CONFIRMATION_STALE', 'The reviewed instruction no longer matches this draft (a line, reason, attestation or destination may have changed, or it was superseded).', 'Reload the file history and review the draft again.');
    }
    for (const l of lines) {
      // Stale means a DIFFERENT replacement was approved for this employee AFTER this draft was requested.
      // An older approved attempt is the predecessor this draft supersedes, not a blocker.
      const sup = await supersededAfter(tx, client, locked.runId, l.personnelNumber, locked.requestedAt, locked.reissueId);
      if (sup) refuse('REISSUE_STALE', `Employee ${l.personnelNumber} has been replaced by a newer approved attempt (${sup}).`, 'Cancel this draft; a stale attempt is never released.');
      // Compare the WHOLE payment destination, not only the account number. Missing, ambiguous, unreadable or
      // changed data all fail closed — never "unchanged" by omission. Bank maintenance holds the same
      // per-employee lock, so nothing can change between this check and the commit below.
      const frozen = snapshot.find((s) => s.personnelNumber === l.personnelNumber);
      const frozenDest = frozen ? frozenDestination(frozen, client, locked.reissueId) : null;
      if (!frozenDest) refuse('REISSUE_BANK_UNREADABLE', `The frozen bank destination for employee ${l.personnelNumber} cannot be read; this draft cannot be released.`, 'Cancel it and request a new replacement once the keyring is available.');
      const currentDest = await effectiveDestination(tx, client, l.personnelNumber, locked.intendedPaymentDate);
      if (!currentDest) refuse('REISSUE_INELIGIBLE', `Employee ${l.personnelNumber} has no readable main bank account effective on ${locked.intendedPaymentDate}.`, 'This draft can no longer be released; cancel it and request a fresh replacement.');
      if (!sameDestination(frozenDest, currentDest)) {
        refuse('REISSUE_BANK_CHANGED', `The bank destination for employee ${l.personnelNumber} changed after this draft was prepared.`, 'Cancel this draft and request a new replacement so the destination can be reviewed again.');
      }
    }

    const now = new Date();
    // Conditional transition: only a still-DRAFT row moves. A losing concurrent action changes no row.
    const moved = await tx.update(payrollPaymentReissue)
      .set({ status: 'APPROVED', approvedBy: approverName, approvedAt: now, changedBy: approverName, changedAt: now })
      .where(and(eq(payrollPaymentReissue.client, client), eq(payrollPaymentReissue.reissueId, locked.reissueId), eq(payrollPaymentReissue.status, 'DRAFT')))
      .returning({ id: payrollPaymentReissue.reissueId });
    if (moved.length === 0) refuse('REISSUE_CONFLICT', `Replacement ${locked.reissueReference} changed while you were approving it.`, 'Reload the file history and try again.');
    // Retain the exact approved bytes in private host storage in this transaction, so an APPROVED row always
    // has an artifact. A storage/encryption failure rolls the approval back.
    try {
      const keyring = keyringOrRefuse(`replacement ${locked.reissueReference}`);
      const rows = paymentRowsFromSnapshot(snapshot, (r) => ({ client, partnerNumber: r.personnelNumber, bankRecordId: locked.reissueId }), keyring);
      const bytes = Buffer.from(buildPaymentCsv({ fileReference: locked.reissueReference, runReference: runRefOf(locked) }, rows), 'utf8');
      await retainArtifact(tx, { client, ownerKind: 'REISSUE', ownerId: locked.reissueId, fileReference: locked.reissueReference, bytes, keyring, changedBy: approverName });
    } catch (error) {
      if (error instanceof ArtifactError || isReissueError(error)) {
        refuse('REISSUE_STORAGE', 'The approved replacement could not be retained in private storage, so it was not released.', 'Ask a deployment administrator to configure CAIRN_PAYMENT_FILE_DIR, then approve again.');
      }
      throw error;
    }
    await tx.update(payrollPaymentReissueLine).set({ state: 'APPROVED', changedBy: approverName, changedAt: now })
      .where(and(eq(payrollPaymentReissueLine.client, client), eq(payrollPaymentReissueLine.reissueId, locked.reissueId), eq(payrollPaymentReissueLine.state, 'DRAFT')));
    await recordChange(tx, {
      client, objectClass: 'payroll_payment_reissue', objectKey: locked.reissueId, changeType: 'CHANGE',
      changedBy: approverName, transactionCode: REISSUE_APPROVE_CAPABILITY,
      before: { status: 'DRAFT' }, after: { status: 'APPROVED' },
    });
    await auditReissue(tx, client, access, locked.reissueId, 'Approved', { reissueReference: locked.reissueReference, employeeCount: locked.employeeCount, totalAmount: String(locked.totalAmount), reviewedAssertion: true, confirmedReviewDigest: confirmed });

    const updated = await loadReissue(tx, client, locked.reissueId);
    return viewOf(tx, client, updated!, money);
  });
}

/** Cancel an unapproved draft, with a reason and an audit entry. Released snapshots are immutable. */
export async function cancelReissue(
  client: string,
  reissueId: string,
  input: { reason: string; changedBy: string },
  access: ReissueAccess | undefined,
): Promise<ReissueView> {
  const reason = String(input.reason ?? '').trim();
  if (!reason) refuse('CANCEL_REASON', 'A reason for cancelling is required.', 'Enter a reason.');
  return withTenant(client, async (tx) => {
    // Either the requester or an approver may cancel a draft.
    const grant = await judge(tx, client, access, [...REQUEST, ...APPROVE]);
    const row = await loadReissue(tx, client, reissueId);
    if (!row) refuse('REISSUE_UNAVAILABLE', 'That replacement does not exist, or is not available to you.', 'Open a file you reach.');
    // Serialise with approval: an approve/cancel race cannot both succeed from the same DRAFT.
    await lockReissueState(tx, client, row.runId);
    const locked = await loadReissue(tx, client, reissueId);
    if (!locked) refuse('REISSUE_UNAVAILABLE', 'That replacement does not exist, or is not available to you.', 'Open a file you reach.');
    // Reach: the replacement's company and every included employee, judged live.
    const run = await loadRun(tx, client, locked.runId);
    if (!reachesCompany(grant, run.companyCode)
      || !(await allReachable(tx, client, grant, (locked.bankSnapshot as PaymentFileBankRow[]).map((r) => r.personnelNumber), locked.intendedPaymentDate))) {
      refuse('REISSUE_UNAVAILABLE', 'That replacement does not exist, or is not available to you.', 'Open a file you reach.');
    }
    if (locked.status !== 'DRAFT') refuse('REISSUE_STATE', `Replacement ${locked.reissueReference} is ${locked.status.toLowerCase()}; a released or cancelled replacement is immutable.`, 'A released snapshot cannot be cancelled.');
    const now = new Date();
    // Conditional transition: only a still-DRAFT row moves. A racing approve/cancel leaves this one untouched.
    const moved = await tx.update(payrollPaymentReissue)
      .set({ status: 'CANCELLED', cancelledBy: input.changedBy, cancelledAt: now, cancelReason: reason, changedBy: input.changedBy, changedAt: now })
      .where(and(eq(payrollPaymentReissue.client, client), eq(payrollPaymentReissue.reissueId, locked.reissueId), eq(payrollPaymentReissue.status, 'DRAFT')))
      .returning({ id: payrollPaymentReissue.reissueId });
    if (moved.length === 0) refuse('REISSUE_CONFLICT', `Replacement ${locked.reissueReference} changed while you were cancelling it.`, 'Reload the file history.');
    await tx.update(payrollPaymentReissueLine).set({ state: 'CANCELLED', changedBy: input.changedBy, changedAt: now })
      .where(and(eq(payrollPaymentReissueLine.client, client), eq(payrollPaymentReissueLine.reissueId, locked.reissueId), eq(payrollPaymentReissueLine.state, 'DRAFT')));
    await recordChange(tx, {
      client, objectClass: 'payroll_payment_reissue', objectKey: locked.reissueId, changeType: 'CHANGE',
      changedBy: input.changedBy, transactionCode: REISSUE_REQUEST_CAPABILITY,
      before: { status: 'DRAFT' }, after: { status: 'CANCELLED', reason },
    });
    await auditReissue(tx, client, access, locked.reissueId, 'Cancelled', { reissueReference: locked.reissueReference, reason });
    const updated = await loadReissue(tx, client, locked.reissueId);
    const money = await moneyForRun(tx, await loadRun(tx, client, locked.runId));
    return viewOf(tx, client, updated!, money);
  });
}

// ── Download ─────────────────────────────────────────────────────────────────

/** Download an APPROVED replacement. Re-download is allowed but flagged; bytes are identical. */
export async function downloadReissue(
  client: string,
  reissueId: string,
  options: { requestedBy?: string | null } = {},
  access: ReissueAccess | undefined = { authorization: undefined },
): Promise<ReissueDownload> {
  return withTenant(client, async (tx) => {
    // Full-identifier download: its own authority AND the live bank-reveal authority.
    const grant = await judgeFullDownload(tx, client, access, DOWNLOAD);
    const row = await loadReissue(tx, client, reissueId);
    if (!row) refuse('REISSUE_UNAVAILABLE', 'That replacement does not exist, or is not available to you.', 'Open a file you reach.');
    // Serialise with approval so a concurrent approval cannot bypass the supersession guard.
    await lockReissueState(tx, client, row.runId);
    const run = await loadRun(tx, client, row.runId);
    // Reach BEFORE status: a company-reachable but employee-out-of-scope caller must not learn the reference,
    // status or existence. Missing and out-of-scope answer identically.
    if (!reachesCompany(grant, run.companyCode)
      || !(await allReachable(tx, client, grant, (row.bankSnapshot as PaymentFileBankRow[]).map((r) => r.personnelNumber), row.intendedPaymentDate))) {
      refuse('REISSUE_UNAVAILABLE', 'That replacement does not exist, or is not available to you.', 'Open a file you reach.');
    }
    await assertNotReversed(tx, client, run);
    if (row.status !== 'APPROVED') refuse('REISSUE_NOT_APPROVED', `Replacement ${row.reissueReference} is ${row.status.toLowerCase()}; only an approved replacement downloads.`, 'An approver must release it first, or it was cancelled.');
    // A later approved replacement of ANY of these employees makes this whole file unsafe to upload.
    await assertNotSuperseded(tx, client, row, 'download');
    const keyring = keyringOrRefuse(`replacement ${row.reissueReference}`);
    const snapshot = (row.bankSnapshot ?? []) as PaymentFileBankRow[];
    const expected = createHash('sha256').update(canonicalJson(snapshot), 'utf8').digest('hex');
    if (expected !== row.checksum) refuse('REISSUE_TAMPERED', `Replacement ${row.reissueReference} failed its integrity check.`, 'Do not upload it; report it to an administrator.');
    const bodyBytes = await reissueBodyBytes(tx, client, row, snapshot, keyring);
    // Count prior downloads BEFORE writing this one, so the first download is not reported as a re-download.
    const reused = (await downloadCount(tx, client, row.reissueId)) > 0;
    await auditReissue(tx, client, access, row.reissueId, 'Downloaded', { reissueReference: row.reissueReference, employeeCount: row.employeeCount, totalAmount: String(row.totalAmount) });
    return {
      filename: row.filename,
      body: bodyBytes,
      reissueReference: row.reissueReference,
      employeeCount: row.employeeCount,
      totalAmount: (await moneyForRun(tx, run)).text(String(row.totalAmount)),
      reused,
    };
  });
}

/**
 * Protected historical download of a superseded source file. Available to FILE_HISTORICAL holders only, and
 * clearly marked do-not-upload. It never regenerates the file; it returns the frozen bytes unchanged.
 */
export async function downloadHistoricalFile(
  client: string,
  preparationId: string,
  access: ReissueAccess | undefined,
): Promise<{ filename: string; body: Buffer; fileReference: string; historical: true; warning: string }> {
  return withTenant(client, async (tx) => {
    // Full-identifier historical download: FILE_HISTORICAL AND the live bank-reveal authority.
    const grant = await judgeFullDownload(tx, client, access, [FILE_HISTORICAL_CAPABILITY]);
    const [file] = await tx.select().from(payrollPaymentFile)
      .where(and(eq(payrollPaymentFile.client, client), eq(payrollPaymentFile.preparationId, preparationId))).limit(1);
    if (!file || !reachesCompany(grant, file.companyCode)
      || !(await allReachable(tx, client, grant, (file.beneficiaries as string[]) ?? [], file.intendedPaymentDate))) {
      refuse('FILE_UNAVAILABLE', 'That file does not exist, or is not available to you.', 'Open a file you reach.');
    }
    // Prefer the exact retained original artifact. A NEW-format row with no artifact fails closed; only a
    // genuinely legacy row (no marker) rebuilds from its snapshot or returns its stored body.
    const fileArtifact = await artifactOf(tx, client, 'FILE', file.preparationId);
    if (!fileArtifact && await ownerRequiresArtifact(tx, client, 'FILE', file.preparationId)) {
      refuse('FILE_ARTIFACT_UNAVAILABLE', `The retained file ${file.fileReference} is missing from private storage.`, 'Ask a deployment administrator to restore CAIRN_PAYMENT_FILE_DIR.');
    }
    let body: Buffer;
    if (fileArtifact) {
      const retained = readArtifact(fileArtifact, client, keyringOrRefuse(`file ${file.fileReference}`));
      if (!retained) refuse('FILE_ARTIFACT_UNAVAILABLE', `The retained file ${file.fileReference} is missing or unreadable in private storage.`, 'Ask a deployment administrator to restore CAIRN_PAYMENT_FILE_DIR or the keyring.');
      body = retained;
    } else if (file.bankDataIncluded) {
      const snapshot = snapshotRowsOf(file);
      const keyring = keyringOrRefuse(`file ${file.fileReference}`);
      let rows: PaymentFileRow[];
      try {
        rows = paymentRowsFromSnapshot(snapshot, (r) => ({ client, partnerNumber: r.personnelNumber, bankRecordId: file.preparationId }), keyring);
      } catch {
        refuse('FILE_KEYRING', `The bank details of file ${file.fileReference} cannot be decrypted.`, 'Ask a deployment administrator to provision the keyring.');
      }
      body = Buffer.from(buildPaymentCsv({ fileReference: file.fileReference, runReference: runRefOf(file) }, rows), 'utf8');
    } else {
      if (!file.body) refuse('FILE_BROKEN', `File ${file.fileReference} has no stored body.`, 'Report it to an administrator.');
      body = Buffer.from(file.body);
    }
    await auditReissue(tx, client, access, file.preparationId, 'Historical download', { fileReference: file.fileReference, historical: true });
    return { filename: `HISTORICAL-DO-NOT-UPLOAD-${file.filename}`, body, fileReference: file.fileReference, historical: true, warning: HISTORICAL_WARNING };
  });
}

/**
 * Protected historical evidence of a SUPERSEDED replacement. Rebuilds exactly the frozen CSV from the immutable
 * encrypted snapshot (same integrity checks as the ordinary download) and returns it unchanged — the file body
 * is never modified to carry the label. Requires FILE_HISTORICAL and live bank-reveal, the run's company and every
 * included employee's reach. Marked do-not-upload in the filename and warning only; labels cannot stop a manual
 * upload, and already-downloaded copies cannot be recalled.
 */
export async function downloadHistoricalReissue(
  client: string,
  reissueId: string,
  access: ReissueAccess | undefined,
): Promise<{ filename: string; body: Buffer; reissueReference: string; historical: true; warning: string }> {
  return withTenant(client, async (tx) => {
    const grant = await judgeFullDownload(tx, client, access, [FILE_HISTORICAL_CAPABILITY]);
    const row = await loadReissue(tx, client, reissueId);
    if (!row) refuse('REISSUE_UNAVAILABLE', 'That replacement does not exist, or is not available to you.', 'Open a file you reach.');
    const run = await loadRun(tx, client, row.runId);
    if (!reachesCompany(grant, run.companyCode)
      || !(await allReachable(tx, client, grant, (row.bankSnapshot as PaymentFileBankRow[]).map((r) => r.personnelNumber), row.intendedPaymentDate))) {
      refuse('REISSUE_UNAVAILABLE', 'That replacement does not exist, or is not available to you.', 'Open a file you reach.');
    }
    if (row.status !== 'APPROVED') refuse('REISSUE_STATE', `Replacement ${row.reissueReference} is ${row.status.toLowerCase()}; only an approved replacement has frozen evidence.`, 'A draft or cancelled replacement is not evidence.');
    const snapshot = (row.bankSnapshot ?? []) as PaymentFileBankRow[];
    const expected = createHash('sha256').update(canonicalJson(snapshot), 'utf8').digest('hex');
    if (expected !== row.checksum) refuse('REISSUE_TAMPERED', `Replacement ${row.reissueReference} failed its integrity check.`, 'Do not rely on it; report it to an administrator.');
    const keyring = keyringOrRefuse(`replacement ${row.reissueReference}`);
    // Exact retained bytes preferred (byte-identical to the earlier issued file); legacy rows rebuild from the
    // immutable snapshot. The CONTENT is unchanged — only the filename marks it historical.
    const body = await reissueBodyBytes(tx, client, row, snapshot, keyring);
    await auditReissue(tx, client, access, row.reissueId, 'Historical download', { reissueReference: row.reissueReference, historical: true });
    return { filename: `HISTORICAL-DO-NOT-UPLOAD-${row.filename}`, body, reissueReference: row.reissueReference, historical: true, warning: HISTORICAL_WARNING };
  });
}

// ── Reading history ─────────────────────────────────────────────────────────

/** The employees of a source file (personnel number + frozen beneficiary name), for the selection UI. */
export async function listReissueSourceEmployees(
  client: string,
  preparationId: string,
  access: ReissueAccess | undefined,
): Promise<Array<{ personnelNumber: string; beneficiaryName: string }>> {
  return withTenant(client, async (tx) => {
    const grant = await judge(tx, client, access, VIEW);
    const file = await loadSourceFile(tx, client, preparationId, grant);
    const all = snapshotRowsOf(file);
    // Whole-file view: fail closed if any included employee is outside the caller's reach (no partial list).
    if (!(await allReachable(tx, client, grant, all.map((r) => r.personnelNumber), file.intendedPaymentDate))) {
      refuse('FILE_UNAVAILABLE', 'That file does not exist, or is not available to you.', 'Open a file whose employees are all within your Company Code or Plant scope.');
    }
    return all.map((r) => ({ personnelNumber: r.personnelNumber, beneficiaryName: r.beneficiaryName }));
  });
}

/** Every replacement of a run, newest version first, with its lines (masked). */
export async function listReissues(client: string, runId: string, access: ReissueAccess | undefined): Promise<ReissueView[]> {
  return withTenant(client, async (tx) => {
    const grant = await judge(tx, client, access, VIEW);
    const run = await loadRun(tx, client, runId);
    if (!reachesCompany(grant, run.companyCode)) refuse('REISSUE_UNAVAILABLE', 'That payroll run does not exist, or is not available to you.', 'Open a run you reach.');
    const money = await moneyForRun(tx, run);
    const rows = await tx.select().from(payrollPaymentReissue)
      .where(and(eq(payrollPaymentReissue.client, client), eq(payrollPaymentReissue.runId, runId)))
      .orderBy(asc(payrollPaymentReissue.version));
    // Whole-file history: fail closed if any replacement includes an employee outside the caller's reach,
    // so the list never discloses names, amounts, masks or attestations the caller may not see.
    for (const r of rows) {
      const pns = ((r.bankSnapshot ?? []) as PaymentFileBankRow[]).map((x) => x.personnelNumber);
      if (pns.length > 0 && !(await allReachable(tx, client, grant, pns, r.intendedPaymentDate))) {
        refuse('REISSUE_UNAVAILABLE', 'That payroll run does not exist, or is not available to you.', 'Open a run whose replacements are all within your Company Code or Plant scope.');
      }
    }
    const out: ReissueView[] = [];
    for (const r of rows) out.push(await viewOf(tx, client, r, money));
    return out.reverse();
  });
}

/** Whether an ordinary re-download of the source file must be blocked because an instruction is superseded. */
export async function isSupersededFile(client: string, preparationId: string): Promise<boolean> {
  return withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select 1 from payroll_payment_reissue_line l
        join payroll_payment_reissue r on r.client = l.client and r.reissue_id = l.reissue_id
        join payroll_payment_file f on f.client = r.client and f.preparation_id = r.source_preparation_id
       where f.client = ${client} and f.preparation_id = ${preparationId} and r.status = 'APPROVED' limit 1
    `)) as unknown as unknown[];
    return rows.length > 0;
  });
}

// ── Internals ───────────────────────────────────────────────────────────────

async function loadSourceFile(tx: Tx, client: string, preparationId: string, grant: PayrollGrant): Promise<FileRow> {
  const id = String(preparationId ?? '').trim();
  if (!id || id.length > 36) refuse('FILE_UNAVAILABLE', 'That file does not exist, or is not available to you.', 'Open a file you reach.');
  const [file] = await tx.select().from(payrollPaymentFile)
    .where(and(eq(payrollPaymentFile.client, client), eq(payrollPaymentFile.preparationId, id))).limit(1);
  if (!file || !reachesCompany(grant, file.companyCode)) refuse('FILE_UNAVAILABLE', 'That file does not exist, or is not available to you.', 'Open a file you reach.');
  return file;
}

async function loadRun(tx: Tx, client: string, runId: string): Promise<RunRow> {
  const [run] = await tx.select().from(payrollRun).where(and(eq(payrollRun.client, client), eq(payrollRun.runId, runId))).limit(1);
  if (!run) refuse('REISSUE_UNAVAILABLE', 'That payroll run does not exist, or is not available to you.', 'Open a run you reach.');
  return run;
}

async function loadReissue(tx: Tx, client: string, reissueId: string): Promise<ReissueRow | null> {
  const id = String(reissueId ?? '').trim();
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const [row] = await tx.select().from(payrollPaymentReissue)
    .where(and(eq(payrollPaymentReissue.client, client), eq(payrollPaymentReissue.reissueId, id))).limit(1);
  return row ?? null;
}

async function moneyForRun(tx: Tx, run: RunRow): Promise<Money> {
  const decimals = await currencyDecimals(tx, run.currency);
  return refusing(moneyOf(run.currency, decimals), (e: MoneyError) => new ReissueError(e.message, e.remedy, 'AMOUNT_PRECISION'));
}

async function nextVersion(tx: Tx, client: string, runId: string): Promise<number> {
  const rows = (await tx.execute(sql`select coalesce(max(version), 0)::int as v from payroll_payment_reissue where client = ${client} and run_id = ${runId}`)) as unknown as Array<{ v: number }>;
  return Number(rows[0]?.v ?? 0) + 1;
}

async function activeDraftFor(tx: Tx, client: string, runId: string, personnelNumber: string): Promise<string | null> {
  const rows = (await tx.execute(sql`
    select r.reissue_reference from payroll_payment_reissue_line l
      join payroll_payment_reissue r on r.client = l.client and r.reissue_id = l.reissue_id
     where l.client = ${client} and l.run_id = ${runId} and l.personnel_number = ${personnelNumber}
       and l.state = 'DRAFT' and r.status = 'DRAFT' limit 1
  `)) as unknown as Array<{ reissue_reference: string }>;
  return rows[0]?.reissue_reference ?? null;
}

async function linesOf(tx: Tx, client: string, reissueId: string): Promise<Array<typeof payrollPaymentReissueLine.$inferSelect>> {
  return tx.select().from(payrollPaymentReissueLine)
    .where(and(eq(payrollPaymentReissueLine.client, client), eq(payrollPaymentReissueLine.reissueId, reissueId)))
    .orderBy(asc(payrollPaymentReissueLine.lineNo));
}

async function downloadCount(tx: Tx, client: string, reissueId: string): Promise<number> {
  const rows = (await tx.execute(sql`select count(*)::int as n from audit_access_log where client = ${client} and object_type = 'payroll_payment_reissue' and object_key = ${reissueId} and detail like '%"verb":"Downloaded"%'`)) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

function normaliseSelection(list: readonly string[] | undefined): string[] {
  return [...new Set((list ?? []).map((n) => String(n).trim().toUpperCase()).filter(Boolean))].sort();
}

function runRefOf(row: { companyCode: string; fiscalYear: number; period: number; runId: string }): string {
  return `RUN-${row.companyCode}-${row.fiscalYear}-${String(row.period).padStart(2, '0')}-${row.runId.slice(0, 8)}`;
}


function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number) as unknown as [number, number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/**
 * The opaque review digest the approver acknowledges: a canonical hash of the immutable reviewed header AND every
 * line (frozen destination, amount, predecessor and full attestation — reason, date, evidence, no-submission).
 * It incorporates the encrypted-snapshot checksum rather than exposing any account data. It is recomputed at
 * approval from the stored row and must equal the submitted value exactly.
 */
function reviewDigest(row: ReissueRow, lines: ReadonlyArray<typeof payrollPaymentReissueLine.$inferSelect>): string {
  const header = {
    checksum: row.checksum,
    sourcePreparationId: row.sourcePreparationId,
    runId: row.runId,
    selection: row.selection,
    intendedPaymentDate: row.intendedPaymentDate,
    employeeCount: row.employeeCount,
    totalAmount: String(row.totalAmount),
    currency: String(row.currency).trim(),
    reason: row.reason,
  };
  const linesCanonical = [...lines]
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((l) => ({
      lineNo: l.lineNo, personnelNumber: l.personnelNumber, amount: String(l.amount), currency: String(l.currency).trim(),
      predecessorKind: l.predecessorKind, predecessorId: l.predecessorId, attestationOutcome: l.attestationOutcome,
      attestationReason: l.attestationReason, verificationDate: l.verificationDate, evidenceReference: l.evidenceReference,
      confirmedNoSubmission: l.confirmedNoSubmission,
    }));
  return createHash('sha256').update(canonicalJson({ header, lines: linesCanonical }), 'utf8').digest('hex');
}

async function viewOf(tx: Tx, client: string, row: ReissueRow, money: Money): Promise<ReissueView> {
  const keyring = (() => { try { return loadBankDataKeyring(); } catch { return null; } })();
  const snapshot = (row.bankSnapshot ?? []) as PaymentFileBankRow[];
  const lines = await linesOf(tx, client, row.reissueId);
  const lineViews: ReissueLineView[] = lines.map((l) => {
    const snap = snapshot.find((s) => s.personnelNumber === l.personnelNumber);
    let masked = '••••';
    if (snap && keyring) {
      try {
        masked = mask(decryptBankData(snap.accountCiphertext, reissueCipherContext(client, l.personnelNumber, row.reissueId), keyring));
      } catch { masked = '••••'; }
    }
    return {
      lineNo: l.lineNo, personnelNumber: l.personnelNumber, beneficiaryName: snap?.beneficiaryName ?? '', maskedAccount: masked, bankName: snap?.bankName ?? '',
      amount: money.text(String(l.amount)), currency: String(l.currency).trim(),
      attestationOutcome: l.attestationOutcome as ReissueAttestationOutcome, attestationReason: l.attestationReason,
      verificationDate: l.verificationDate, evidenceReference: l.evidenceReference,
      predecessorKind: l.predecessorKind as 'FILE' | 'REISSUE', predecessorId: l.predecessorId,
    };
  });
  // A replacement is superseded (as a whole) if ANY line has a later approved attempt. Computed here so the
  // screen shows true current/historical status; the server still rechecks on every download.
  const superseded = row.status === 'APPROVED' ? await isSuperseded(tx, client, row) : false;
  return {
    reissueId: row.reissueId, sourcePreparationId: row.sourcePreparationId, runId: row.runId, companyCode: row.companyCode,
    fiscalYear: row.fiscalYear, period: row.period, version: row.version, reissueReference: row.reissueReference,
    filename: row.filename, intendedPaymentDate: row.intendedPaymentDate, selection: row.selection as 'ALL' | 'SELECTED',
    employeeCount: row.employeeCount, totalAmount: money.text(String(row.totalAmount)), currency: String(row.currency).trim(),
    status: row.status as 'DRAFT' | 'APPROVED' | 'CANCELLED', reason: row.reason, requestedBy: row.requestedBy,
    requestedAt: row.requestedAt instanceof Date ? row.requestedAt.toISOString() : String(row.requestedAt),
    approvedBy: row.approvedBy ?? null, approvedAt: row.approvedAt instanceof Date ? row.approvedAt.toISOString() : (row.approvedAt as string | null) ?? null,
    cancelledBy: row.cancelledBy ?? null, cancelledAt: row.cancelledAt instanceof Date ? row.cancelledAt.toISOString() : (row.cancelledAt as string | null) ?? null,
    cancelReason: row.cancelReason ?? null,
    downloadable: row.status === 'APPROVED' && !superseded,
    superseded,
    snapshotDigest: reviewDigest(row, lines),
    lines: lineViews,
  };
}

/** Has any line of this approved replacement been superseded by a later approved attempt? */
async function isSuperseded(tx: Tx, client: string, row: ReissueRow): Promise<boolean> {
  const latest = await latestApprovedByEmployee(tx, client, row.runId);
  for (const line of await linesOf(tx, client, row.reissueId)) {
    const newest = latest.get(line.personnelNumber);
    if (newest && newest !== row.reissueId) return true;
  }
  return false;
}

async function auditReissue(tx: Tx, client: string, access: ReissueAccess | undefined, objectKey: string, verb: string, detail: Record<string, unknown>): Promise<void> {
  const userId = access && 'authorization' in (access as object) ? (access as { authorization?: { userId?: string } }).authorization?.userId ?? null : null;
  // The audit transaction code names the authority the act actually exercised, not always REQUEST.
  const code = verb === 'Approved' ? REISSUE_APPROVE_CAPABILITY
    : verb === 'Downloaded' ? REISSUE_DOWNLOAD_CAPABILITY
      : verb === 'Historical download' ? FILE_HISTORICAL_CAPABILITY
        : REISSUE_REQUEST_CAPABILITY;
  await tx.execute(sql`
    insert into audit_access_log (id, client, user_id, username, event_type, transaction_code, object_type, object_key, detail)
    values (${randomUUID()}, ${client}, ${userId}, ${null}, 'EXPORT', ${code}, 'payroll_payment_reissue', ${objectKey},
      ${JSON.stringify({ verb, ...detail })})`);
}

export type { ReissueAttestationOutcome };
export { ATTESTATION_OUTCOMES };
