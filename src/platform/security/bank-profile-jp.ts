/**
 * Pure Japan bank-identifier profile — CAIRN.md D-060/D-066 (B-065).
 *
 * This validates/normalizes only; it performs no directory/account lookup,
 * account-format conversion, profile activation, persistence, or payment-rail check.
 */
const BIC_PATTERN = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/;
const JAPAN_BANK_CODE_PATTERN = /^[0-9]{7}$/;

export interface JapanBankProfileInput {
  accountHolder?: unknown;
  country?: unknown;
  /** Opaque bank-specific account identifier; preserved exactly when non-empty. */
  localAccountNumber?: unknown;
  /** Seven-digit institution-plus-branch composite in the existing bankCode field. */
  bankCode?: unknown;
  /** JP has no IBAN profile; reject a supplied non-empty IBAN. */
  iban?: unknown;
  /** Optional BIC/SWIFT syntax check only. */
  bic?: unknown;
}

export type JapanBankProfileErrorCode =
  | 'ACCOUNT_HOLDER_REQUIRED'
  | 'COUNTRY_REQUIRED'
  | 'COUNTRY_NOT_JP'
  | 'LOCAL_ACCOUNT_REQUIRED'
  | 'LOCAL_ACCOUNT_INVALID'
  | 'BANK_CODE_REQUIRED'
  | 'BANK_CODE_FORMAT'
  | 'IBAN_NOT_ALLOWED'
  | 'BIC_INVALID';

export type JapanBankProfileResult =
  | {
      valid: true;
      data: {
        accountHolder: string;
        country: 'JP';
        localAccountNumber: string;
        bankCode: string;
        bic: string | null;
      };
    }
  | { valid: false; errors: JapanBankProfileErrorCode[] };

/** Validate D-066 JP capture rules; preserve leading zeros in both identifiers. */
export function validateJapanBankProfile(input: JapanBankProfileInput): JapanBankProfileResult {
  const errors: JapanBankProfileErrorCode[] = [];

  const accountHolder = typeof input.accountHolder === 'string' ? input.accountHolder.trim() : '';
  if (!accountHolder) errors.push('ACCOUNT_HOLDER_REQUIRED');

  const countryText = typeof input.country === 'string' ? input.country.trim().toUpperCase() : '';
  if (!countryText) errors.push('COUNTRY_REQUIRED');
  else if (countryText !== 'JP') errors.push('COUNTRY_NOT_JP');

  const localAccountNumber = normalizeOpaqueAccountNumber(input.localAccountNumber);
  if (localAccountNumber.status === 'missing') errors.push('LOCAL_ACCOUNT_REQUIRED');
  else if (localAccountNumber.status === 'invalid') errors.push('LOCAL_ACCOUNT_INVALID');

  if (hasNonBlankValue(input.iban)) errors.push('IBAN_NOT_ALLOWED');

  let normalizedBankCode: string | null = null;
  if (input.bankCode === null || input.bankCode === undefined) {
    errors.push('BANK_CODE_REQUIRED');
  } else if (typeof input.bankCode !== 'string') {
    errors.push('BANK_CODE_FORMAT');
  } else {
    const candidate = input.bankCode.trim();
    if (!candidate) errors.push('BANK_CODE_REQUIRED');
    else if (!JAPAN_BANK_CODE_PATTERN.test(candidate)) errors.push('BANK_CODE_FORMAT');
    else normalizedBankCode = candidate;
  }

  const bic = normalizeBic(input.bic);
  if (bic.invalid) errors.push('BIC_INVALID');

  if (
    errors.length > 0 ||
    localAccountNumber.status !== 'valid' ||
    !normalizedBankCode ||
    !bic.valid
  ) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    data: {
      accountHolder,
      country: 'JP',
      localAccountNumber: localAccountNumber.value,
      bankCode: normalizedBankCode,
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

function normalizeBic(value: unknown): { valid: boolean; invalid: boolean; value: string | null } {
  if (value === null || value === undefined) return { valid: true, invalid: false, value: null };
  if (typeof value !== 'string') return { valid: false, invalid: true, value: null };
  const normalized = value.trim().toUpperCase();
  if (!normalized) return { valid: true, invalid: false, value: null };
  if (!BIC_PATTERN.test(normalized)) return { valid: false, invalid: true, value: null };
  return { valid: true, invalid: false, value: normalized };
}
