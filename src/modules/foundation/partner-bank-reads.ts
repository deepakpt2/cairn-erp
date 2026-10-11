/**
 * Read-only partner-bank metadata reads — CAIRN.md §§26.91–26.92.
 *
 * Reads derive the tenant from the verified session and bind the selected
 * partner; the detail lookup also binds the bank-row ID. Neither selects account-
 * identifier plaintext or ciphertext, nor implements or authorizes audited reveal.
 */
import { and, asc, desc, eq } from 'drizzle-orm';
import { hasCapability, type SessionContext } from '../../platform/auth/session';
import { withTenant } from '../../platform/db/client';
import { isBankRecordId, type BankRecordId } from '../../platform/security/bank-record-id';
import { partnerBank } from './partner-bank-schema';

export const PARTNER_BANK_METADATA_DISPLAY_CAPABILITY = 'FND.PARTNER.DISPLAY';

const PARTNER_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9_.-]{0,39}$/;
const SESSION_CLIENT_PATTERN = /^[A-Za-z0-9]{4}$/;

const partnerBankMetadataSelection = {
  bankRecordId: partnerBank.bankRecordId,
  partnerNumber: partnerBank.partnerNumber,
  accountHolder: partnerBank.accountHolder,
  country: partnerBank.country,
  bankName: partnerBank.bankName,
  bankCode: partnerBank.bankCode,
  bic: partnerBank.bic,
  validFrom: partnerBank.validFrom,
  validTo: partnerBank.validTo,
  isActive: partnerBank.isActive,
  version: partnerBank.version,
} as const;

export interface PartnerBankMetadata {
  readonly bankRecordId: BankRecordId;
  readonly partnerNumber: string;
  readonly accountHolder: string;
  readonly country: string;
  readonly bankName: string | null;
  readonly bankCode: string | null;
  readonly bic: string | null;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly isActive: boolean;
  readonly version: number;
}

export class PartnerBankMetadataAccessError extends Error {
  readonly code = 'PARTNER_DISPLAY_REQUIRED';

  constructor() {
    super('Partner display access is required.');
    this.name = 'PartnerBankMetadataAccessError';
  }
}

/**
 * Resolve one bank row for an ordinary metadata display. The tenant is taken only
 * from the verified session; the database predicate also requires the selected
 * partner and canonical UUIDv4. Invalid/missing keys and absent rows are
 * indistinguishable. The ID returned is the matched database row's ID, not a
 * caller-provided value.
 */
export async function lookupPartnerBankMetadata(
  session: SessionContext,
  partnerNumber: unknown,
  bankRecordId: unknown,
): Promise<PartnerBankMetadata | null> {
  if (
    !session?.user ||
    !Array.isArray(session.user.capabilities) ||
    !hasCapability(session.user.capabilities, PARTNER_BANK_METADATA_DISPLAY_CAPABILITY)
  ) {
    throw new PartnerBankMetadataAccessError();
  }

  const client = session.user.client;
  if (
    typeof client !== 'string' ||
    !SESSION_CLIENT_PATTERN.test(client) ||
    typeof partnerNumber !== 'string' ||
    !PARTNER_NUMBER_PATTERN.test(partnerNumber) ||
    !isBankRecordId(bankRecordId)
  ) {
    return null;
  }

  const [row] = await withTenant(client, (tx) =>
    tx
      .select(partnerBankMetadataSelection)
      .from(partnerBank)
      .where(and(
        eq(partnerBank.client, client),
        eq(partnerBank.partnerNumber, partnerNumber),
        eq(partnerBank.bankRecordId, bankRecordId),
      ))
      .limit(1),
  );

  if (!row || !isBankRecordId(row.bankRecordId)) return null;

  return {
    bankRecordId: row.bankRecordId,
    partnerNumber: row.partnerNumber,
    accountHolder: row.accountHolder,
    country: row.country,
    bankName: row.bankName,
    bankCode: row.bankCode,
    bic: row.bic,
    validFrom: row.validFrom,
    validTo: row.validTo,
    isActive: row.isActive,
    version: row.version,
  };
}

/**
 * List all bank metadata for one selected partner. The tenant comes only from
 * the verified session; inactive rows remain visible so history is not hidden.
 * The projection excludes account-identifier ciphertext and plaintext.
 */
export async function listPartnerBankMetadata(
  session: SessionContext,
  partnerNumber: unknown,
): Promise<PartnerBankMetadata[] | null> {
  if (
    !session?.user ||
    !Array.isArray(session.user.capabilities) ||
    !hasCapability(session.user.capabilities, PARTNER_BANK_METADATA_DISPLAY_CAPABILITY)
  ) {
    throw new PartnerBankMetadataAccessError();
  }

  const client = session.user.client;
  if (
    typeof client !== 'string' ||
    !SESSION_CLIENT_PATTERN.test(client) ||
    typeof partnerNumber !== 'string' ||
    !PARTNER_NUMBER_PATTERN.test(partnerNumber)
  ) {
    return null;
  }

  const rows = await withTenant(client, (tx) =>
    tx
      .select(partnerBankMetadataSelection)
      .from(partnerBank)
      .where(and(
        eq(partnerBank.client, client),
        eq(partnerBank.partnerNumber, partnerNumber),
      ))
      .orderBy(desc(partnerBank.validFrom), asc(partnerBank.bankRecordId)),
  );

  const metadata: PartnerBankMetadata[] = [];
  for (const row of rows) {
    if (!isBankRecordId(row.bankRecordId)) return null;
    metadata.push({
      bankRecordId: row.bankRecordId,
      partnerNumber: row.partnerNumber,
      accountHolder: row.accountHolder,
      country: row.country,
      bankName: row.bankName,
      bankCode: row.bankCode,
      bic: row.bic,
      validFrom: row.validFrom,
      validTo: row.validTo,
      isActive: row.isActive,
      version: row.version,
    });
  }

  return metadata;
}
