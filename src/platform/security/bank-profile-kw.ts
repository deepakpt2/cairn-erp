/**
 * Pure Kuwait bank-identifier profile — CAIRN.md D-060/D-062 (B-063).
 *
 * This validates/normalizes only. It performs no directory or account-existence
 * lookup, activation, encryption, persistence, audit write, or payment-rail check.
 */
export const KUWAIT_IBAN_PATTERN = /^KW[0-9]{2}[A-Z]{4}[A-Z0-9]{22}$/;
const BIC_PATTERN = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/;

export interface KuwaitBankProfileInput {
  accountHolder?: unknown;
  country?: unknown;
  iban?: unknown;
  /** KW is IBAN-only; any non-empty value is rejected. */
  localAccountNumber?: unknown;
  /** Optional consistency input; the returned bank code is always derived from the IBAN. */
  bankCode?: unknown;
  /** Optional BIC/SWIFT syntax check only. */
  bic?: unknown;
}

export type KuwaitBankProfileErrorCode =
  | 'ACCOUNT_HOLDER_REQUIRED'
  | 'COUNTRY_REQUIRED'
  | 'COUNTRY_NOT_KW'
  | 'IBAN_REQUIRED'
  | 'IBAN_FORMAT'
  | 'IBAN_CHECKSUM'
  | 'LOCAL_ACCOUNT_NOT_ALLOWED'
  | 'BANK_CODE_MISMATCH'
  | 'BIC_INVALID';

export type KuwaitBankProfileResult =
  | {
      valid: true;
      data: {
        accountHolder: string;
        country: 'KW';
        iban: string;
        bankCode: string;
        bic: string | null;
      };
    }
  | { valid: false; errors: KuwaitBankProfileErrorCode[] };

/** Validate D-062 Kuwait capture rules and return a normalized, derived projection. */
export function validateKuwaitBankProfile(input: KuwaitBankProfileInput): KuwaitBankProfileResult {
  const errors: KuwaitBankProfileErrorCode[] = [];

  const accountHolder = typeof input.accountHolder === 'string' ? input.accountHolder.trim() : '';
  if (!accountHolder) errors.push('ACCOUNT_HOLDER_REQUIRED');

  const countryText = typeof input.country === 'string' ? input.country.trim().toUpperCase() : '';
  if (!countryText) errors.push('COUNTRY_REQUIRED');
  else if (countryText !== 'KW') errors.push('COUNTRY_NOT_KW');

  if (hasNonBlankValue(input.localAccountNumber)) errors.push('LOCAL_ACCOUNT_NOT_ALLOWED');

  const iban = typeof input.iban === 'string'
    ? input.iban.replace(/ /g, '').toUpperCase()
    : '';
  let derivedBankCode: string | null = null;
  let ibanValid = false;
  if (!iban) {
    errors.push('IBAN_REQUIRED');
  } else if (!KUWAIT_IBAN_PATTERN.test(iban)) {
    errors.push('IBAN_FORMAT');
  } else {
    derivedBankCode = iban.slice(4, 8);
    if (!hasValidMod97(iban)) errors.push('IBAN_CHECKSUM');
    else ibanValid = true;
  }

  if (derivedBankCode && input.bankCode !== undefined && input.bankCode !== null) {
    const suppliedBankCode = typeof input.bankCode === 'string'
      ? input.bankCode.trim().toUpperCase()
      : null;
    if (suppliedBankCode !== '' && suppliedBankCode !== derivedBankCode) {
      errors.push('BANK_CODE_MISMATCH');
    }
  }

  const bic = normalizeBic(input.bic);
  if (bic.invalid) errors.push('BIC_INVALID');

  if (errors.length > 0 || !ibanValid || !derivedBankCode || !bic.valid) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    data: {
      accountHolder,
      country: 'KW',
      iban,
      bankCode: derivedBankCode,
      bic: bic.value,
    },
  };
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

/** IBAN MOD-97 check using a streaming remainder; no large integer or lookup is needed. */
function hasValidMod97(iban: string): boolean {
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  let remainder = 0;

  for (const character of rearranged) {
    const code = character.charCodeAt(0);
    if (code >= 48 && code <= 57) {
      remainder = (remainder * 10 + code - 48) % 97;
      continue;
    }

    const numericValue = code - 55; // A=10 … Z=35
    remainder = (remainder * 10 + Math.floor(numericValue / 10)) % 97;
    remainder = (remainder * 10 + (numericValue % 10)) % 97;
  }

  return remainder === 1;
}
