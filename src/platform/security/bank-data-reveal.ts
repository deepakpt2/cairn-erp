/**
 * Bank-identifier reveal authorization/audit boundary — CAIRN.md §26.75 (D-071).
 *
 * Call only after obtaining a verified SessionContext. This module never reads bank
 * data, decrypts ciphertext, or returns plaintext. `AUTHORIZED` is only a gate result;
 * a future caller must record the terminal outcome in the same transaction, commit,
 * and only then return plaintext. Do not throw inside the transaction after a denial,
 * or its audit row will roll back.
 */
import { randomUUID } from 'node:crypto';
import { hasCapability, type SessionContext } from '../auth/session';
import type { Tx } from '../db/client';
import { auditAccessLog } from '../tables/security';
import { isBankRecordId, type BankRecordId } from './bank-record-id';

export const PARTNER_DISPLAY_CAPABILITY = 'FND.PARTNER.DISPLAY';
export const PARTNER_BANK_REVEAL_CAPABILITY = 'SEC.PARTNER.BANK.REVEAL';

export const BANK_REVEAL_FIELDS = ['iban', 'localAccountNumber'] as const;
export type BankRevealField = (typeof BANK_REVEAL_FIELDS)[number];

export const BANK_REVEAL_PURPOSES = [
  'PARTNER_SUPPORT',
  'DATA_CORRECTION',
  'AUDIT_REVIEW',
  'LEGAL_REGULATORY',
] as const;
export type BankRevealPurpose = (typeof BANK_REVEAL_PURPOSES)[number];

export type BankRevealDenialCode =
  | 'MISSING_PARTNER_DISPLAY'
  | 'MISSING_REVEAL_CAPABILITY'
  | 'INVALID_FIELDS'
  | 'INVALID_PURPOSE'
  | 'INVALID_OBJECT_KEY';

export type BankRevealCompletionDenialCode = 'RECORD_UNAVAILABLE' | 'CRYPTO_FAILURE';

export interface BankRevealAttemptRequest {
  /** Safe partner business key; never an account identifier. */
  partnerKey: unknown;
  /**
   * Canonical UUIDv4 from a server-side row lookup constrained by session tenant
   * and partner; never accept a raw query/body ID as proof of provenance.
   */
  bankRecordId: unknown;
  /** One or more names from BANK_REVEAL_FIELDS. */
  requestedFields: unknown;
  /** One value from BANK_REVEAL_PURPOSES; free text is never accepted. */
  purposeCode: unknown;
}

export type AuthorizedBankRevealAttempt = {
  partnerKey: string;
  bankRecordId: BankRecordId;
  fields: readonly BankRevealField[];
  purposeCode: BankRevealPurpose;
};

export type BankRevealAttemptResult =
  | ({ allowed: true } & AuthorizedBankRevealAttempt)
  | {
      allowed: false;
      denialCode: BankRevealDenialCode;
      missingCapability?: typeof PARTNER_DISPLAY_CAPABILITY | typeof PARTNER_BANK_REVEAL_CAPABILITY;
    };

export type BankRevealCompletion =
  | { outcome: 'SUCCESS' }
  | { outcome: 'DENIED'; denialCode: BankRevealCompletionDenialCode };

const fieldSet = new Set<string>(BANK_REVEAL_FIELDS);
const purposeSet = new Set<string>(BANK_REVEAL_PURPOSES);
const safePartnerKey = /^[A-Z0-9][A-Z0-9_.-]{0,39}$/;

function projectFields(value: unknown): { fields: BankRevealField[]; valid: boolean } {
  if (!Array.isArray(value) || value.length === 0) return { fields: [], valid: false };
  const fields = [...new Set(value.filter((field): field is BankRevealField =>
    typeof field === 'string' && fieldSet.has(field),
  ))];
  return { fields, valid: fields.length > 0 && fields.length === value.length };
}

function projectPurpose(value: unknown): BankRevealPurpose | null {
  return typeof value === 'string' && purposeSet.has(value)
    ? (value as BankRevealPurpose)
    : null;
}

async function writeAuditEvent(
  tx: Tx,
  session: SessionContext,
  input: {
    partnerKey: string | null;
    bankRecordId: string | null;
    fields: readonly BankRevealField[];
    purposeCode: BankRevealPurpose | null;
    outcome: 'AUTHORIZED' | 'SUCCESS' | 'DENIED';
    denialCode: string | null;
    eventType: 'READ' | 'CAPABILITY_DENIED';
  },
): Promise<void> {
  const detail = JSON.stringify({
    partnerKey: input.partnerKey,
    fieldNames: input.fields,
    outcome: input.outcome,
    purposeCode: input.purposeCode,
    denialCode: input.denialCode,
  });

  try {
    await tx.insert(auditAccessLog).values({
      id: randomUUID(),
      client: session.user.client,
      userId: session.user.userId,
      username: session.user.username,
      eventType: input.eventType,
      transactionCode: PARTNER_BANK_REVEAL_CAPABILITY,
      objectType: 'partner_bank',
      objectKey: input.bankRecordId,
      detail,
    });
  } catch {
    throw new Error('The bank-data reveal attempt could not be recorded; the operation was denied.');
  }
}

/**
 * Validate and audit a reveal authorization attempt using only session-derived
 * actor/tenant data. This never reads a record or returns plaintext. On an allowed
 * result, the caller must later record SUCCESS or DENIED with
 * recordBankRevealOutcome before the transaction commits.
 */
export async function authorizeAndRecordBankRevealAttempt(
  tx: Tx,
  session: SessionContext,
  request: BankRevealAttemptRequest,
): Promise<BankRevealAttemptResult> {
  const fields = projectFields(request.requestedFields);
  const purposeCode = projectPurpose(request.purposeCode);
  const partnerKey =
    typeof request.partnerKey === 'string' && safePartnerKey.test(request.partnerKey)
      ? request.partnerKey
      : null;
  // UUID validation is only a shape check; future callers must supply the ID from a tenant/partner-scoped row lookup.
  const bankRecordId = isBankRecordId(request.bankRecordId) ? request.bankRecordId : null;

  let denialCode: BankRevealDenialCode | null = null;
  let missingCapability:
    | typeof PARTNER_DISPLAY_CAPABILITY
    | typeof PARTNER_BANK_REVEAL_CAPABILITY
    | undefined;

  if (!hasCapability(session.user.capabilities, PARTNER_DISPLAY_CAPABILITY)) {
    denialCode = 'MISSING_PARTNER_DISPLAY';
    missingCapability = PARTNER_DISPLAY_CAPABILITY;
  } else if (!hasCapability(session.user.capabilities, PARTNER_BANK_REVEAL_CAPABILITY)) {
    denialCode = 'MISSING_REVEAL_CAPABILITY';
    missingCapability = PARTNER_BANK_REVEAL_CAPABILITY;
  } else if (!partnerKey || !bankRecordId) {
    denialCode = 'INVALID_OBJECT_KEY';
  } else if (!fields.valid) {
    denialCode = 'INVALID_FIELDS';
  } else if (!purposeCode) {
    denialCode = 'INVALID_PURPOSE';
  }

  await writeAuditEvent(tx, session, {
    partnerKey,
    bankRecordId,
    fields: fields.fields,
    purposeCode,
    outcome: denialCode ? 'DENIED' : 'AUTHORIZED',
    denialCode,
    eventType: missingCapability ? 'CAPABILITY_DENIED' : 'READ',
  });

  if (denialCode) {
    return {
      allowed: false,
      denialCode,
      ...(missingCapability ? { missingCapability } : {}),
    };
  }

  return {
    allowed: true,
    partnerKey: partnerKey!,
    bankRecordId: bankRecordId!,
    fields: fields.fields,
    purposeCode: purposeCode!,
  };
}

/**
 * Record the terminal result after the future data service has completed its read
 * or decryption. On success this event must be committed before any value is sent.
 */
export async function recordBankRevealOutcome(
  tx: Tx,
  session: SessionContext,
  attempt: AuthorizedBankRevealAttempt,
  completion: BankRevealCompletion,
): Promise<void> {
  await writeAuditEvent(tx, session, {
    partnerKey: attempt.partnerKey,
    bankRecordId: attempt.bankRecordId,
    fields: attempt.fields,
    purposeCode: attempt.purposeCode,
    outcome: completion.outcome,
    denialCode: completion.outcome === 'DENIED' ? completion.denialCode : null,
    eventType: 'READ',
  });
}
