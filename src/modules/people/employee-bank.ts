/**
 * Employee salary bank details, maintained on the employee screen.
 *
 * Sensitive data with three deliberately separate authorities:
 * - `PEOPLE.BANK.VIEW` — read a record MASKED (fixed mask + last four). Never returns the full value.
 * - `PEOPLE.BANK.MAINTAIN` — create and end effective-dated records.
 * - `PEOPLE.BANK.REVEAL` — read the full value, recorded in the audit log, in a separate transaction that
 *   commits before any plaintext is returned.
 * None is granted to a role by default.
 *
 * The rules this file keeps:
 * - **Encrypted at rest only.** The account number/IBAN is stored as an AES-256-GCM envelope from the
 *   deployment keyring (`bank-data-encryption.ts`), authenticated to tenant + employee + record id + field.
 *   No plaintext column, change-log value, audit value or log line carries it. An unavailable keyring fails
 *   closed.
 * - **One MAIN account at a time.** A gist exclusion constraint forbids two active main rows whose inclusive
 *   dates overlap — atomic against concurrent writers. A change ends the current record (`valid_to`, `is_active`)
 *   and adds a new one; history is never overwritten, so an effective date can be in the past, today or future.
 * - **Reach is judged server-side** on every call: the live session, the exact capability, and the employee's
 *   Company Code/Plant reach, using `ServiceAuthorityContext` — never a browser-supplied capability array.
 * - **Selection for payroll** is by a date (`accountAsOf`): the one active main account effective on that day.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import {
  type BankDataContext,
  type BankDataKeyring,
  decryptBankData,
  encryptBankData,
} from '../../platform/security/bank-data-encryption';
import { isBankRecordId } from '../../platform/security/bank-record-id';
import {
  type PayrollAccess,
  type PayrollGrant,
  judgePayrollAccess,
} from './payroll-access';
import { EMPLOYEE_ROUTE, assertEmployeeScope, PayrollStructureError } from './payroll-structure';
import { employeeBankDetail } from './schema';

export const BANK_VIEW_CAPABILITY = 'PEOPLE.BANK.VIEW';
export const BANK_MAINTAIN_CAPABILITY = 'PEOPLE.BANK.MAINTAIN';
export const BANK_REVEAL_CAPABILITY = 'PEOPLE.BANK.REVEAL';

/** The mask for a value that is not revealed: a fixed prefix and at most the last four characters. */
export const BANK_VIEW_MASK = '••••';

const VIEW = [BANK_VIEW_CAPABILITY, BANK_REVEAL_CAPABILITY] as const;
const MAINTAIN = [BANK_MAINTAIN_CAPABILITY] as const;
const REVEAL = [BANK_REVEAL_CAPABILITY] as const;

export type EmployeeBankAccess = PayrollAccess;

export class EmployeeBankError extends Error {
  remedy?: string;
  readonly code: string;
  constructor(message: string, remedy?: string, code = 'EMPLOYEE_BANK') {
    super(message);
    this.name = 'EmployeeBankError';
    this.remedy = remedy;
    this.code = code;
  }
}

function refuse(code: string, message: string, remedy?: string): never {
  throw new EmployeeBankError(message, remedy, code);
}

function isEmployeeBankError(error: unknown): error is EmployeeBankError {
  return error instanceof EmployeeBankError;
}
export { isEmployeeBankError };

// ── Input ───────────────────────────────────────────────────────────────────

const clientField = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,4}$/, 'A tenant is two to four capitals or digits.');
const personnelField = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,20}$/, 'A personnel number is one to twenty capitals or digits.');
const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.');
const optionalDate = z.union([z.literal(''), isoDate, z.null()]).optional().transform((v) => v ?? null);
const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v && v.length ? v : null));
const actor = z.string().trim().min(1).max(60);

const createInput = z.object({
  client: clientField,
  personnelNumber: personnelField,
  beneficiaryName: z.string().trim().min(1, 'A beneficiary name is required.').max(160),
  bankName: z.string().trim().min(1, 'A bank name is required.').max(160),
  bankCode: optionalText(40),
  accountKind: z.enum(['IBAN', 'ACCOUNT'], { message: 'Choose IBAN or account number.' }),
  accountValue: z.string().trim().min(1, 'An account number or IBAN is required.').max(64, 'An account number or IBAN is at most 64 characters.'),
  country: optionalText(2),
  validFrom: isoDate,
  validTo: optionalDate,
  requestKey: z.string().trim().max(64).optional(),
  changedBy: actor,
});
export type CreateEmployeeBankInput = z.input<typeof createInput>;

const endInput = z.object({
  client: clientField,
  bankRecordId: z.string().trim().min(1).max(36),
  validTo: isoDate,
  reason: z.string().trim().max(200).optional().transform((v) => (v && v.length ? v : null)),
  changedBy: actor,
});

function parseDate(name: string, value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) refuse('BANK_DATE', `${name} ${value || '(none)'} is not a calendar date.`, 'Enter the date as YYYY-MM-DD.');
  const [, y, m, d] = match!.map(Number) as unknown as [number, number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    refuse('BANK_DATE', `${name} ${value} is not a real calendar date.`, 'Correct the date.');
  }
  return value;
}

// ── Masking ─────────────────────────────────────────────────────────────────

/** A stable mask: never the value's length or content beyond the final four characters. */
export function maskIdentifier(value: string): string {
  const chars = Array.from(value);
  if (chars.length <= 4) return BANK_VIEW_MASK;
  return `${BANK_VIEW_MASK}${chars.slice(-4).join('')}`;
}

// ── Views ───────────────────────────────────────────────────────────────────

export interface EmployeeBankRecordView {
  bankRecordId: string;
  personnelNumber: string;
  beneficiaryName: string;
  bankName: string;
  bankCode: string | null;
  country: string | null;
  accountKind: 'IBAN' | 'ACCOUNT';
  /** Masked by default; the full value only from `revealEmployeeBank`, which is separately audited. */
  maskedAccount: string;
  validFrom: string;
  validTo: string | null;
  isMain: boolean;
  isActive: boolean;
  createdBy: string;
  createdAt: string;
  changedBy: string | null;
  changedAt: string | null;
}

function cipherContext(client: string, personnelNumber: string, bankRecordId: string): BankDataContext {
  return { client, partnerNumber: personnelNumber, bankRecordId: bankRecordId as never, field: 'employeeAccount' };
}

function maskOf(envelope: string, context: BankDataContext, keyring: BankDataKeyring): string {
  try {
    return maskIdentifier(decryptBankData(envelope, context, keyring));
  } catch {
    // Keyring unavailable or envelope tampered: show nothing rather than a wrong mask.
    return BANK_VIEW_MASK;
  }
}

function viewOf(row: typeof employeeBankDetail.$inferSelect, keyring: BankDataKeyring): EmployeeBankRecordView {
  return {
    bankRecordId: row.bankRecordId,
    personnelNumber: row.personnelNumber,
    beneficiaryName: row.beneficiaryName,
    bankName: row.bankName,
    bankCode: row.bankCode ?? null,
    country: row.country ?? null,
    accountKind: row.accountKind as 'IBAN' | 'ACCOUNT',
    maskedAccount: maskOf(row.accountCiphertext, cipherContext(row.client, row.personnelNumber, row.bankRecordId), keyring),
    validFrom: row.validFrom,
    validTo: row.validTo ?? null,
    isMain: row.isMain,
    isActive: row.isActive,
    createdBy: row.createdBy,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    changedBy: row.changedBy ?? null,
    changedAt: row.changedAt instanceof Date ? row.changedAt.toISOString() : row.changedAt ? String(row.changedAt) : null,
  };
}

// ── Reach and authority ─────────────────────────────────────────────────────

async function judgeForEmployee(
  tx: Tx,
  client: string,
  personnelNumber: string,
  onDate: string,
  access: EmployeeBankAccess | undefined,
  capabilities: readonly string[],
): Promise<PayrollGrant> {
  const grant = await judgePayrollAccess(tx, client, access, capabilities, refuse, 'BANK_AUTHORITY');
  try {
    await assertEmployeeScope(tx, client, grant, personnelNumber, onDate);
  } catch (error) {
    if (error instanceof PayrollStructureError) {
      // An out-of-reach employee reads like a missing one; the caller cannot probe for bank records.
      refuse('BANK_UNAVAILABLE', 'That employee does not exist, or is not available to you.', 'Open an employee you reach.');
    }
    throw error;
  }
  return grant;
}

// ── Reading (masked) ────────────────────────────────────────────────────────

/** The employee's bank records, newest first, masked. Needs VIEW (or REVEAL). */
export async function listEmployeeBank(
  client: string,
  personnelNumberInput: string,
  access: EmployeeBankAccess | undefined,
  keyring: BankDataKeyring,
): Promise<EmployeeBankRecordView[]> {
  const personnelNumber = String(personnelNumberInput ?? '').trim().toUpperCase();
  return withTenant(client, async (tx) => {
    await judgeForEmployee(tx, client, personnelNumber, new Date().toISOString().slice(0, 10), access, VIEW);
    const rows = await tx.select().from(employeeBankDetail)
      .where(and(eq(employeeBankDetail.client, client), eq(employeeBankDetail.personnelNumber, personnelNumber)))
      .orderBy(asc(employeeBankDetail.validFrom));
    return rows.map((r) => viewOf(r, keyring));
  });
}

/**
 * The one active main account in force on `asOf`, or null. Masked. This is the payroll selection rule: it
 * looks at the *date*, not at today, and it never guesses among overlapping rows (the constraint forbids them).
 */
export async function accountAsOf(
  tx: Tx,
  client: string,
  personnelNumber: string,
  asOf: string,
): Promise<(typeof employeeBankDetail.$inferSelect) | null> {
  const rows = await tx.select().from(employeeBankDetail)
    .where(and(
      eq(employeeBankDetail.client, client),
      eq(employeeBankDetail.personnelNumber, personnelNumber),
      eq(employeeBankDetail.isActive, true),
      eq(employeeBankDetail.isMain, true),
      sql`${employeeBankDetail.validFrom} <= ${asOf}::date`,
      sql`(${employeeBankDetail.validTo} is null or ${employeeBankDetail.validTo} >= ${asOf}::date)`,
    ))
    .orderBy(asc(employeeBankDetail.validFrom));
  if (rows.length > 1) {
    // The exclusion constraint makes this unreachable; if it ever happens, refuse rather than pick one.
    refuse('BANK_AMBIGUOUS', `Employee ${personnelNumber} has more than one active main account on ${asOf}.`, 'An administrator must resolve the overlapping records.');
  }
  return rows[0] ?? null;
}

// ── Writing ─────────────────────────────────────────────────────────────────

/** Create a new effective-dated bank record. Refuses an overlap with an existing active main account atomically. */
export async function createEmployeeBank(
  input: CreateEmployeeBankInput,
  access: EmployeeBankAccess | undefined,
  keyring: BankDataKeyring,
): Promise<EmployeeBankRecordView> {
  const parsed = createInput.parse(input);
  const validFrom = parseDate('Valid from', parsed.validFrom);
  const validTo = parsed.validTo ? parseDate('Valid to', parsed.validTo) : null;
  if (validTo && validTo < validFrom) refuse('BANK_DATE', `Valid to ${validTo} precedes valid from ${validFrom}.`, 'Correct the dates.');

  return withTenant(parsed.client, async (tx) => {
    await judgeForEmployee(tx, parsed.client, parsed.personnelNumber, validFrom, access, MAINTAIN);
    if (parsed.requestKey) {
      const [replay] = await tx.select().from(employeeBankDetail)
        .where(and(eq(employeeBankDetail.client, parsed.client), eq(employeeBankDetail.requestKey, parsed.requestKey))).limit(1);
      if (replay) return viewOf(replay, keyring);
    }
    // Serialise per employee so two concurrent inserts cannot both pass a pre-check; the gist constraint is the
    // final backstop and translates to a friendly message.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`employee-bank:${parsed.client}:${parsed.personnelNumber}`}, 0))`);

    const bankRecordId = randomUUID();
    const accountCiphertext = encryptBankData(
      parsed.accountValue,
      cipherContext(parsed.client, parsed.personnelNumber, bankRecordId),
      keyring,
    );
    try {
      await tx.insert(employeeBankDetail).values({
        client: parsed.client,
        bankRecordId,
        personnelNumber: parsed.personnelNumber,
        beneficiaryName: parsed.beneficiaryName,
        bankName: parsed.bankName,
        bankCode: parsed.bankCode,
        accountKind: parsed.accountKind,
        accountCiphertext,
        country: parsed.country ? parsed.country.toUpperCase() : null,
        validFrom,
        validTo,
        isMain: true,
        isActive: true,
        requestKey: parsed.requestKey ?? null,
        createdBy: parsed.changedBy,
      });
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === '23P01' || code === '23505') {
        refuse(
          'BANK_OVERLAP',
          `Employee ${parsed.personnelNumber} already has an active main account covering part of ${validFrom}${validTo ? ` to ${validTo}` : ' onward'}.`,
          'End the current account on the day before the new one starts, then add the new one. History is kept as a new record.',
        );
      }
      throw error;
    }
    const [row] = await tx.select().from(employeeBankDetail)
      .where(and(eq(employeeBankDetail.client, parsed.client), eq(employeeBankDetail.bankRecordId, bankRecordId))).limit(1);
    await recordChange(tx, {
      client: parsed.client,
      objectClass: 'employee_bank_detail',
      objectKey: bankRecordId,
      changeType: 'CREATE',
      changedBy: parsed.changedBy,
      transactionCode: BANK_MAINTAIN_CAPABILITY,
      // No account value, no masked value: only the non-sensitive shape of the record.
      after: { personnelNumber: parsed.personnelNumber, accountKind: parsed.accountKind, validFrom, validTo, bankName: parsed.bankName },
    });
    return viewOf(row!, keyring);
  });
}

/** End a bank record on a date (inclusive). It stays readable; history is not overwritten. */
export async function endEmployeeBank(
  input: z.input<typeof endInput>,
  access: EmployeeBankAccess | undefined,
  keyring: BankDataKeyring,
): Promise<EmployeeBankRecordView> {
  const parsed = endInput.parse(input);
  const validTo = parseDate('Valid to', parsed.validTo);
  return withTenant(parsed.client, async (tx) => {
    const [standing] = await tx.select().from(employeeBankDetail)
      .where(and(eq(employeeBankDetail.client, parsed.client), eq(employeeBankDetail.bankRecordId, parsed.bankRecordId))).limit(1);
    if (!standing) refuse('BANK_UNAVAILABLE', 'That bank record does not exist, or is not available to you.', 'Open an employee you reach.');
    await judgeForEmployee(tx, parsed.client, standing.personnelNumber, standing.validFrom, access, MAINTAIN);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`employee-bank:${parsed.client}:${standing.personnelNumber}`}, 0))`);
    if (!standing.isActive) refuse('BANK_ENDED', 'That bank record is already ended.', 'Add a new record for the dates you need.');
    if (validTo < standing.validFrom) refuse('BANK_DATE', `Valid to ${validTo} precedes the record's valid from ${standing.validFrom}.`, 'Choose a date on or after the start.');
    await tx.update(employeeBankDetail)
      .set({ validTo, isActive: false, changedBy: parsed.changedBy, changedAt: new Date() })
      .where(and(eq(employeeBankDetail.client, parsed.client), eq(employeeBankDetail.bankRecordId, parsed.bankRecordId)));
    const [row] = await tx.select().from(employeeBankDetail)
      .where(and(eq(employeeBankDetail.client, parsed.client), eq(employeeBankDetail.bankRecordId, parsed.bankRecordId))).limit(1);
    await recordChange(tx, {
      client: parsed.client,
      objectClass: 'employee_bank_detail',
      objectKey: parsed.bankRecordId,
      changeType: 'CHANGE',
      changedBy: parsed.changedBy,
      transactionCode: BANK_MAINTAIN_CAPABILITY,
      before: { isActive: true, validTo: null },
      after: { isActive: false, validTo, reason: parsed.reason },
    });
    return viewOf(row!, keyring);
  });
}

// ── Reveal (audited) ────────────────────────────────────────────────────────

/**
 * The full account value, for an explicit reveal. Requires REVEAL (separately audited) and the employee's
 * reach. The audit row is written in the same transaction and carries the actor, record reference, purpose
 * and timestamp — never the account number. The caller receives the plaintext only after this commits.
 */
export async function revealEmployeeBank(
  client: string,
  bankRecordId: string,
  options: { purpose: string; changedBy: string },
  access: EmployeeBankAccess | undefined,
  keyring: BankDataKeyring,
): Promise<{ accountKind: 'IBAN' | 'ACCOUNT'; accountValue: string }> {
  if (!isBankRecordId(bankRecordId)) refuse('BANK_UNAVAILABLE', 'That bank record does not exist, or is not available to you.', 'Open an employee you reach.');
  const purpose = String(options.purpose ?? '').trim().toUpperCase().slice(0, 40) || 'PAYROLL_SUPPORT';
  // First transaction: authorize, decrypt, and record the terminal audit outcome. It must COMMIT before any
  // plaintext leaves this function, so a failed reveal is still recorded rather than rolled back by a throw.
  const outcome = await withTenant(client, async (tx) => {
    const [row] = await tx.select().from(employeeBankDetail)
      .where(and(eq(employeeBankDetail.client, client), eq(employeeBankDetail.bankRecordId, bankRecordId))).limit(1);
    if (!row) refuse('BANK_UNAVAILABLE', 'That bank record does not exist, or is not available to you.', 'Open an employee you reach.');
    await judgeForEmployee(tx, client, row.personnelNumber, row.validFrom, access, REVEAL);
    let value: string | null = null;
    try {
      value = decryptBankData(row.accountCiphertext, cipherContext(client, row.personnelNumber, row.bankRecordId), keyring);
    } catch {
      value = null;
    }
    // Always record the outcome in this same (committing) transaction — success or denial.
    await auditReveal(tx, client, row, options.changedBy, purpose, access, value !== null ? 'SUCCESS' : 'DENIED');
    return { accountKind: row.accountKind as 'IBAN' | 'ACCOUNT', accountValue: value };
  });
  if (outcome.accountValue === null) {
    refuse('BANK_CRYPTO', 'The account value could not be decrypted; the bank-data keyring is unavailable or the record is unreadable.', 'Ask an administrator to check the bank-data keyring provisioning. Nothing was revealed.');
  }
  return { accountKind: outcome.accountKind, accountValue: outcome.accountValue };
}

async function auditReveal(
  tx: Tx,
  client: string,
  row: typeof employeeBankDetail.$inferSelect,
  changedBy: string,
  purpose: string,
  access: EmployeeBankAccess | undefined,
  outcome: 'SUCCESS' | 'DENIED',
): Promise<void> {
  const userId = access && !Array.isArray(access) ? (access as { authorization?: { userId?: string } }).authorization?.userId ?? null : null;
  await tx.execute(sql`
    insert into audit_access_log (id, client, user_id, username, event_type, transaction_code, object_type, object_key, detail)
    values (${randomUUID()}, ${client}, ${userId}, ${changedBy}, 'READ', ${BANK_REVEAL_CAPABILITY}, 'employee_bank_detail', ${row.bankRecordId},
      ${JSON.stringify({ action: 'REVEAL', outcome, personnelNumber: row.personnelNumber, accountKind: row.accountKind, purpose })})`);
}

// Re-exported so the screen and the payment-file service share one rule set.
export { EMPLOYEE_ROUTE };
