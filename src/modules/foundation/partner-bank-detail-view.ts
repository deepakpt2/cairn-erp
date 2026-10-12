/**
 * Scoped, server-only D-074 bank-identifier detail mask — no plaintext output.
 *
 * The caller must supply the deployment-loaded keyring. This service requires
 * actual partner-display authority, resolves the row under session tenant +
 * selected partner + requested UUIDv4, then uses the database row's values for
 * authenticated decryption. Only a fixed mask plus the final four characters is
 * returned; ciphertext, plaintext and row IDs never leave this module.
 */
import { and, eq } from 'drizzle-orm';
import { hasCapability, type SessionContext } from '../../platform/auth/session';
import { withTenant } from '../../platform/db/client';
import {
  decryptBankData,
  type BankDataKeyring,
} from '../../platform/security/bank-data-encryption';
import { isBankRecordId } from '../../platform/security/bank-record-id';
import {
  BANK_ACCOUNT_VIEW_MASK,
  projectPartnerBankNormalView,
} from '../../platform/security/partner-bank-view';
import {
  PARTNER_BANK_METADATA_DISPLAY_CAPABILITY,
  PartnerBankMetadataAccessError,
} from './partner-bank-reads';
import { partnerBank } from './partner-bank-schema';

const PARTNER_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9_.-]{0,39}$/;
const SESSION_CLIENT_PATTERN = /^[A-Za-z0-9]{4}$/;

const partnerBankDetailSelection = {
  client: partnerBank.client,
  bankRecordId: partnerBank.bankRecordId,
  partnerNumber: partnerBank.partnerNumber,
  accountHolder: partnerBank.accountHolder,
  country: partnerBank.country,
  bankName: partnerBank.bankName,
  bankCode: partnerBank.bankCode,
  ibanCiphertext: partnerBank.ibanCiphertext,
  localAccountNumberCiphertext: partnerBank.localAccountNumberCiphertext,
  bic: partnerBank.bic,
  validFrom: partnerBank.validFrom,
  validTo: partnerBank.validTo,
  isActive: partnerBank.isActive,
  version: partnerBank.version,
} as const;

export type PartnerBankMaskedIdentifierKind = 'IBAN' | 'LOCAL_ACCOUNT_NUMBER';

/** Safe DTO for a future read-only detail panel; contains no row ID or full value. */
export interface PartnerBankMaskedDetail {
  readonly accountHolder: string;
  readonly country: string;
  readonly bankName: string | null;
  readonly bankCode: string | null;
  readonly bic: string | null;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly isActive: boolean;
  readonly version: number;
  readonly identifierKind: PartnerBankMaskedIdentifierKind;
  readonly maskedIdentifier: string;
}

/**
 * Return one ordinary detail view, using only a matched database row as crypto
 * context. This is not the audited full-value reveal operation: it returns only
 * D-074's mask and does not accept a client-supplied plaintext or ciphertext.
 */
export async function getPartnerBankMaskedDetail(
  session: SessionContext,
  partnerNumber: unknown,
  bankRecordId: unknown,
  keyring: BankDataKeyring,
): Promise<PartnerBankMaskedDetail | null> {
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
      .select(partnerBankDetailSelection)
      .from(partnerBank)
      .where(and(
        eq(partnerBank.client, client),
        eq(partnerBank.partnerNumber, partnerNumber),
        eq(partnerBank.bankRecordId, bankRecordId),
      ))
      .limit(1),
  );

  if (
    !row ||
    row.client !== client ||
    row.partnerNumber !== partnerNumber ||
    row.bankRecordId !== bankRecordId ||
    !isBankRecordId(row.bankRecordId)
  ) {
    return null;
  }

  const hasIbanEnvelope = row.ibanCiphertext !== null;
  const hasLocalAccountEnvelope = row.localAccountNumberCiphertext !== null;
  if (hasIbanEnvelope === hasLocalAccountEnvelope) return null;

  const identifierField = hasIbanEnvelope ? 'iban' : 'localAccountNumber';
  const envelope = hasIbanEnvelope ? row.ibanCiphertext : row.localAccountNumberCiphertext;
  if (typeof envelope !== 'string' || envelope.length === 0) return null;

  // Use the matched row's tenant, partner and UUIDv4—not caller-provided values.
  const plaintext = decryptBankData(envelope, {
    client: row.client,
    partnerNumber: row.partnerNumber,
    bankRecordId: row.bankRecordId,
    field: identifierField,
  }, keyring);
  const projected = projectPartnerBankNormalView({ [identifierField]: plaintext }, 'detail');
  const maskedIdentifier = projected?.[identifierField];
  if (typeof maskedIdentifier !== 'string' || !maskedIdentifier.startsWith(BANK_ACCOUNT_VIEW_MASK)) {
    return null;
  }

  return {
    accountHolder: row.accountHolder,
    country: row.country,
    bankName: row.bankName,
    bankCode: row.bankCode,
    bic: row.bic,
    validFrom: row.validFrom,
    validTo: row.validTo,
    isActive: row.isActive,
    version: row.version,
    identifierKind: hasIbanEnvelope ? 'IBAN' : 'LOCAL_ACCOUNT_NUMBER',
    maskedIdentifier,
  };
}
