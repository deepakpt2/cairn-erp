import { describe, expect, it } from 'vitest';
import {
  PARTNER_BANK_PROFILE_ACTIVATION_EVIDENCE,
  validatePartnerBankProfileActivationCommand,
} from '../src/platform/security/partner-bank-profile-activation';

const validInput = (overrides: Record<string, unknown> = {}) => ({
  country: 'KW',
  expectedPolicyRevision: 'D-062',
  expectedVersion: 1,
  evidenceCode: PARTNER_BANK_PROFILE_ACTIVATION_EVIDENCE,
  ...overrides,
});

describe('partner-bank profile activation command contract', () => {
  it('normalizes a current-revision command and fixes its target to READY', () => {
    expect(validatePartnerBankProfileActivationCommand(validInput({ country: ' kw ' }))).toEqual({
      valid: true,
      command: {
        country: 'KW',
        policyRevision: 'D-062',
        expectedVersion: 1,
        evidenceCode: 'PROFILE_VALIDATION_ACCEPTED',
        targetStatus: 'READY',
      },
    });
  });

  it('requires an approved country and the exact current policy revision', () => {
    expect(validatePartnerBankProfileActivationCommand(validInput({ country: ' ' }))).toEqual({
      valid: false,
      errors: ['COUNTRY_REQUIRED'],
    });
    expect(validatePartnerBankProfileActivationCommand(validInput({ country: 'CA' }))).toEqual({
      valid: false,
      errors: ['PROFILE_UNAVAILABLE'],
    });
    expect(validatePartnerBankProfileActivationCommand(validInput({ expectedPolicyRevision: '' }))).toEqual({
      valid: false,
      errors: ['POLICY_REVISION_REQUIRED'],
    });
    expect(validatePartnerBankProfileActivationCommand(validInput({ expectedPolicyRevision: 'D-061' }))).toEqual({
      valid: false,
      errors: ['POLICY_REVISION_MISMATCH'],
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, '1'])(
    'rejects invalid expected row version %s',
    (expectedVersion) => {
      expect(validatePartnerBankProfileActivationCommand(validInput({ expectedVersion }))).toEqual({
        valid: false,
        errors: ['VERSION_INVALID'],
      });
    },
  );

  it('accepts only the fixed evidence code and rejects free-text or unknown fields', () => {
    expect(validatePartnerBankProfileActivationCommand(validInput({ evidenceCode: 'OTHER' }))).toEqual({
      valid: false,
      errors: ['EVIDENCE_INVALID'],
    });
    expect(validatePartnerBankProfileActivationCommand({ ...validInput(), rationale: 'free text' })).toEqual({
      valid: false,
      errors: ['UNSUPPORTED_FIELDS'],
    });
  });

  it('rejects non-object payloads', () => {
    expect(validatePartnerBankProfileActivationCommand(null)).toEqual({ valid: false, errors: ['INPUT_INVALID'] });
    expect(validatePartnerBankProfileActivationCommand([])).toEqual({ valid: false, errors: ['INPUT_INVALID'] });
  });
});
