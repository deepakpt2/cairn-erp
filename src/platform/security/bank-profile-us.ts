/**
 * Pure United States bank-identifier profile — CAIRN.md D-060/D-065 (B-065).
 *
 * This validates/normalizes only; it performs no directory, account-existence,
 * payment-rail, profile activation, encryption, persistence, or audit operation.
 */
const BIC_PATTERN = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/;
const ABA_ROUTING_PATTERN = /^[0-9]{9}$/;

export interface UnitedStatesBankProfileInput {
  accountHolder?: unknown;
  country?: unknown;
  /** Opaque bank-specific account identifier; preserved exactly when non-empty. */
  localAccountNumber?: unknown;
  /** Required 9-digit ABA routing transit number in the existing bankCode field. */
  bankCode?: unknown;
  /** US has no IBAN profile; reject a supplied non-empty IBAN. */
  iban?: unknown;
  /** Optional BIC/SWIFT syntax check only. */
  bic?: unknown;
}

export type UnitedStatesBankProfileErrorCode =
  | 'ACCOUNT_HOLDER_REQUIRED'
  | 'COUNTRY_REQUIRED'
  | 'COUNTRY_NOT_US'
  | 'LOCAL_ACCOUNT_REQUIRED'
  | 'LOCAL_ACCOUNT_INVALID'
  | 'BANK_CODE_REQUIRED'
  | 'BANK_CODE_FORMAT'
  | 'BANK_CODE_RANGE'
  | 'BANK_CODE_CHECKSUM'
  | 'IBAN_NOT_ALLOWED'
  | 'BIC_INVALID';

export type UnitedStatesBankProfileResult =
  | {
      valid: true;
      data: {
        accountHolder: string;
        country: 'US';
        localAccountNumber: string;
        bankCode: string;
        bic: string | null;
      };
    }
  | { valid: false; errors: UnitedStatesBankProfileErrorCode[] };

/** Validate D-065 US capture rules without asserting that an RTN is assigned or usable. */
export function validateUnitedStatesBankProfile(
  input: UnitedStatesBankProfileInput,
): UnitedStatesBankProfileResult {
  const errors: UnitedStatesBankProfileErrorCode[] = [];

  const accountHolder = typeof input.accountHolder === 'string' ? input.accountHolder.trim() : '';
  if (!accountHolder) errors.push('ACCOUNT_HOLDER_REQUIRED');

  const countryText = typeof input.country === 'string' ? input.country.trim().toUpperCase() : '';
  if (!countryText) errors.push('COUNTRY_REQUIRED');
  else if (countryText !== 'US') errors.push('COUNTRY_NOT_US');

  const localAccountNumber = normalizeOpaqueAccountNumber(input.localAccountNumber);
  if (localAccountNumber.status === 'missing') errors.push('LOCAL_ACCOUNT_REQUIRED');
  else if (localAccountNumber.status === 'invalid') errors.push('LOCAL_ACCOUNT_INVALID');

  if (hasNonBlankValue(input.iban)) errors.push('IBAN_NOT_ALLOWED');

  let normalizedRoutingNumber: string | null = null;
  if (input.bankCode === null || input.bankCode === undefined) {
    errors.push('BANK_CODE_REQUIRED');
  } else if (typeof input.bankCode !== 'string') {
    errors.push('BANK_CODE_FORMAT');
  } else {
    const candidate = input.bankCode.trim();
    if (!candidate) {
      errors.push('BANK_CODE_REQUIRED');
    } else if (!ABA_ROUTING_PATTERN.test(candidate)) {
      errors.push('BANK_CODE_FORMAT');
    } else {
      normalizedRoutingNumber = candidate;
      if (!hasAllowedAbaRoutingSymbol(candidate)) errors.push('BANK_CODE_RANGE');
      if (!hasValidAbaChecksum(candidate)) errors.push('BANK_CODE_CHECKSUM');
    }
  }

  const bic = normalizeBic(input.bic);
  if (bic.invalid) errors.push('BIC_INVALID');

  if (
    errors.length > 0 ||
    localAccountNumber.status !== 'valid' ||
    !normalizedRoutingNumber ||
    !bic.valid
  ) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    data: {
      accountHolder,
      country: 'US',
      localAccountNumber: localAccountNumber.value,
      bankCode: normalizedRoutingNumber,
      bic: bic.value,
    },
  };
}

function normalizeOpaqueAccountNumber(
  value: unknown,
): { status: 'valid'; value: string } | { status: 'missing' | 'invalid' } {
  if (value === null || value === undefined) return { status: 'missing' };
  if (typeof value !== 'string') return { status: 'invalid' };
  if (!value.trim()) return { status: 'missing' };
  return { status: 'valid', value };
}

function hasNonBlankValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return typeof value === 'string' ? value.trim().length > 0 : true;
}

function hasAllowedAbaRoutingSymbol(routingNumber: string): boolean {
  const symbol = routingNumber.slice(0, 2);
  return (symbol >= '01' && symbol <= '12') || (symbol >= '21' && symbol <= '32');
}

/** ABA 3-7-1 mod-10 check digit over all nine digits. */
function hasValidAbaChecksum(routingNumber: string): boolean {
  const digits = Array.from(routingNumber, (character) => Number(character));
  const weightedSum =
    3 * (digits[0] + digits[3] + digits[6]) +
    7 * (digits[1] + digits[4] + digits[7]) +
    digits[2] + digits[5] + digits[8];
  return weightedSum % 10 === 0;
}

function normalizeBic(value: unknown): { valid: boolean; invalid: boolean; value: string | null } {
  if (value === null || value === undefined) return { valid: true, invalid: false, value: null };
  if (typeof value !== 'string') return { valid: false, invalid: true, value: null };
  const normalized = value.trim().toUpperCase();
  if (!normalized) return { valid: true, invalid: false, value: null };
  if (!BIC_PATTERN.test(normalized)) return { valid: false, invalid: true, value: null };
  return { valid: true, invalid: false, value: normalized };
}
