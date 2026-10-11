/**
 * Pure India bank-identifier profile — CAIRN.md D-060/D-063 (B-064).
 *
 * This validates/normalizes only. It performs no directory or account-existence
 * lookup, profile activation, encryption, persistence, audit write, or payment-rail check.
 */
export const INDIA_IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const BIC_PATTERN = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/;

export interface IndiaBankProfileInput {
  accountHolder?: unknown;
  country?: unknown;
  /** Opaque bank-specific account identifier; preserved exactly when non-empty. */
  localAccountNumber?: unknown;
  /** IFSC is stored in the existing partner-bank bankCode field. */
  bankCode?: unknown;
  /** IN has no IBAN profile; reject a supplied non-empty IBAN. */
  iban?: unknown;
  /** Optional BIC/SWIFT syntax check only. */
  bic?: unknown;
}

export type IndiaBankProfileErrorCode =
  | 'ACCOUNT_HOLDER_REQUIRED'
  | 'COUNTRY_REQUIRED'
  | 'COUNTRY_NOT_IN'
  | 'LOCAL_ACCOUNT_REQUIRED'
  | 'LOCAL_ACCOUNT_INVALID'
  | 'IFSC_REQUIRED'
  | 'IFSC_FORMAT'
  | 'IBAN_NOT_ALLOWED'
  | 'BIC_INVALID';

export type IndiaBankProfileResult =
  | {
      valid: true;
      data: {
        accountHolder: string;
        country: 'IN';
        localAccountNumber: string;
        bankCode: string;
        bic: string | null;
      };
    }
  | { valid: false; errors: IndiaBankProfileErrorCode[] };

/** Validate D-063 India capture rules and return an exact account-number projection. */
export function validateIndiaBankProfile(input: IndiaBankProfileInput): IndiaBankProfileResult {
  const errors: IndiaBankProfileErrorCode[] = [];

  const accountHolder = typeof input.accountHolder === 'string' ? input.accountHolder.trim() : '';
  if (!accountHolder) errors.push('ACCOUNT_HOLDER_REQUIRED');

  const countryText = typeof input.country === 'string' ? input.country.trim().toUpperCase() : '';
  if (!countryText) errors.push('COUNTRY_REQUIRED');
  else if (countryText !== 'IN') errors.push('COUNTRY_NOT_IN');

  const localAccountNumber = normalizeOpaqueAccountNumber(input.localAccountNumber);
  if (localAccountNumber.status === 'missing') errors.push('LOCAL_ACCOUNT_REQUIRED');
  else if (localAccountNumber.status === 'invalid') errors.push('LOCAL_ACCOUNT_INVALID');

  if (hasNonBlankValue(input.iban)) errors.push('IBAN_NOT_ALLOWED');

  let normalizedIfsc: string | null = null;
  if (input.bankCode === null || input.bankCode === undefined) {
    errors.push('IFSC_REQUIRED');
  } else if (typeof input.bankCode !== 'string') {
    errors.push('IFSC_FORMAT');
  } else {
    const candidate = input.bankCode.trim().toUpperCase();
    if (!candidate) errors.push('IFSC_REQUIRED');
    else if (!INDIA_IFSC_PATTERN.test(candidate)) errors.push('IFSC_FORMAT');
    else normalizedIfsc = candidate;
  }

  const bic = normalizeBic(input.bic);
  if (bic.invalid) errors.push('BIC_INVALID');

  if (
    errors.length > 0 ||
    localAccountNumber.status !== 'valid' ||
    !normalizedIfsc ||
    !bic.valid
  ) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    data: {
      accountHolder,
      country: 'IN',
      localAccountNumber: localAccountNumber.value,
      bankCode: normalizedIfsc,
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
