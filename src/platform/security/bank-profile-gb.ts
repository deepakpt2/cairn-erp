/**
 * Pure United Kingdom bank-identifier profile — CAIRN.md D-060/D-064 (B-065).
 *
 * This validates/normalizes only; it performs no directory/account lookup, profile
 * activation, encryption, persistence, audit write, or payment-rail check.
 */
export const GB_IBAN_PATTERN = /^GB[0-9]{2}[A-Z]{4}[0-9]{14}$/;
const BIC_PATTERN = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/;

export interface GreatBritainBankProfileInput {
  accountHolder?: unknown;
  country?: unknown;
  iban?: unknown;
  /** GB is IBAN-only; any non-empty separate local account input is rejected. */
  localAccountNumber?: unknown;
  /** Optional consistency input; returned bank code is derived from IBAN positions 5–8. */
  bankCode?: unknown;
  /** Optional BIC/SWIFT syntax check only. */
  bic?: unknown;
}

export type GreatBritainBankProfileErrorCode =
  | 'ACCOUNT_HOLDER_REQUIRED'
  | 'COUNTRY_REQUIRED'
  | 'COUNTRY_NOT_GB'
  | 'IBAN_REQUIRED'
  | 'IBAN_FORMAT'
  | 'IBAN_CHECKSUM'
  | 'LOCAL_ACCOUNT_NOT_ALLOWED'
  | 'BANK_CODE_MISMATCH'
  | 'BIC_INVALID';

export type GreatBritainBankProfileResult =
  | {
      valid: true;
      data: {
        accountHolder: string;
        country: 'GB';
        iban: string;
        bankCode: string;
        bic: string | null;
      };
    }
  | { valid: false; errors: GreatBritainBankProfileErrorCode[] };

/** Validate D-064 GB capture rules and derive the bank code from the IBAN. */
export function validateGreatBritainBankProfile(
  input: GreatBritainBankProfileInput,
): GreatBritainBankProfileResult {
  const errors: GreatBritainBankProfileErrorCode[] = [];

  const accountHolder = typeof input.accountHolder === 'string' ? input.accountHolder.trim() : '';
  if (!accountHolder) errors.push('ACCOUNT_HOLDER_REQUIRED');

  const countryText = typeof input.country === 'string' ? input.country.trim().toUpperCase() : '';
  if (!countryText) errors.push('COUNTRY_REQUIRED');
  else if (countryText !== 'GB') errors.push('COUNTRY_NOT_GB');

  if (hasNonBlankValue(input.localAccountNumber)) errors.push('LOCAL_ACCOUNT_NOT_ALLOWED');

  const iban = typeof input.iban === 'string' ? input.iban.replace(/ /g, '').toUpperCase() : '';
  let derivedBankCode: string | null = null;
  let ibanValid = false;
  if (!iban) {
    errors.push('IBAN_REQUIRED');
  } else if (!GB_IBAN_PATTERN.test(iban)) {
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
      country: 'GB',
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

/** IBAN MOD-97 check using a streaming remainder. */
function hasValidMod97(iban: string): boolean {
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  let remainder = 0;

  for (const character of rearranged) {
    const code = character.charCodeAt(0);
    if (code >= 48 && code <= 57) {
      remainder = (remainder * 10 + code - 48) % 97;
      continue;
    }

    const numericValue = code - 55;
    remainder = (remainder * 10 + Math.floor(numericValue / 10)) % 97;
    remainder = (remainder * 10 + (numericValue % 10)) % 97;
  }

  return remainder === 1;
}
