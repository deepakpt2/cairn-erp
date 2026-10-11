/**
 * Pure fail-closed dispatcher for the implemented partner-bank country profiles.
 *
 * This only selects a validator by normalized country code. It does not persist,
 * activate, or connect profiles to a save path.
 */
import {
  validateGreatBritainBankProfile,
  type GreatBritainBankProfileResult,
} from './bank-profile-gb';
import { validateIndiaBankProfile, type IndiaBankProfileResult } from './bank-profile-in';
import { validateJapanBankProfile, type JapanBankProfileResult } from './bank-profile-jp';
import { validateKuwaitBankProfile, type KuwaitBankProfileResult } from './bank-profile-kw';
import {
  validateUnitedStatesBankProfile,
  type UnitedStatesBankProfileResult,
} from './bank-profile-us';

export interface PartnerBankProfileInput {
  accountHolder?: unknown;
  country?: unknown;
  iban?: unknown;
  localAccountNumber?: unknown;
  bankCode?: unknown;
  bic?: unknown;
}

export type PartnerBankProfileResult =
  | KuwaitBankProfileResult
  | IndiaBankProfileResult
  | GreatBritainBankProfileResult
  | UnitedStatesBankProfileResult
  | JapanBankProfileResult
  | { valid: false; errors: ['COUNTRY_REQUIRED' | 'PROFILE_UNAVAILABLE'] };

/** Normalize country and dispatch to its implemented validator; all other countries fail closed. */
export function validatePartnerBankProfile(input: PartnerBankProfileInput): PartnerBankProfileResult {
  const country = typeof input.country === 'string' ? input.country.trim().toUpperCase() : '';
  if (!country) return { valid: false, errors: ['COUNTRY_REQUIRED'] };

  switch (country) {
    case 'KW':
      return validateKuwaitBankProfile({ ...input, country });
    case 'IN':
      return validateIndiaBankProfile({ ...input, country });
    case 'GB':
      return validateGreatBritainBankProfile({ ...input, country });
    case 'US':
      return validateUnitedStatesBankProfile({ ...input, country });
    case 'JP':
      return validateJapanBankProfile({ ...input, country });
    default:
      return { valid: false, errors: ['PROFILE_UNAVAILABLE'] };
  }
}
