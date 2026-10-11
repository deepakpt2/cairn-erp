import { describe, expect, it } from 'vitest';
import { validateUnitedStatesBankProfile } from '../src/platform/security/bank-profile-us';

const SYNTHETIC_ABA_ROUTING_NUMBER = '019876542';

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    accountHolder: 'Synthetic Account Holder',
    country: 'US',
    localAccountNumber: '0000012345',
    bankCode: SYNTHETIC_ABA_ROUTING_NUMBER,
    ...overrides,
  };
}

describe('pure United States bank profile', () => {
  it('normalizes country/BIC and preserves the opaque account and routing number', () => {
    const localAccountNumber = ' 0000-A/7 ';
    const result = validateUnitedStatesBankProfile({
      accountHolder: '  Synthetic Account Holder  ',
      country: ' us ',
      localAccountNumber,
      bankCode: ' 019876542 ',
      bic: ' testus00 ',
    });

    expect(result).toEqual({
      valid: true,
      data: {
        accountHolder: 'Synthetic Account Holder',
        country: 'US',
        localAccountNumber,
        bankCode: SYNTHETIC_ABA_ROUTING_NUMBER,
        bic: 'TESTUS00',
      },
    });
  });

  it('allows an optional BIC and imposes no nationwide account format or length rule', () => {
    const localAccountNumber = `00${'A-/'.repeat(20)}`;
    expect(validateUnitedStatesBankProfile(validInput({ localAccountNumber, bic: '' }))).toMatchObject({
      valid: true,
      data: { localAccountNumber, bic: null },
    });
  });

  it('requires holder, US country, local account and routing number, and rejects an IBAN', () => {
    expect(validateUnitedStatesBankProfile({ accountHolder: '', country: 'US' })).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        'ACCOUNT_HOLDER_REQUIRED',
        'LOCAL_ACCOUNT_REQUIRED',
        'BANK_CODE_REQUIRED',
      ]),
    });
    expect(validateUnitedStatesBankProfile(validInput({ country: 'JP' }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['COUNTRY_NOT_US']),
    });
    expect(validateUnitedStatesBankProfile(validInput({ iban: 'US00SYNTHETIC' }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['IBAN_NOT_ALLOWED']),
    });
  });

  it('enforces the ABA length, allowed symbol ranges and 3-7-1 check digit', () => {
    expect(validateUnitedStatesBankProfile(validInput({ bankCode: '219876546' }))).toMatchObject({
      valid: true,
      data: { bankCode: '219876546' },
    });
    expect(validateUnitedStatesBankProfile(validInput({ bankCode: '01987654' }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['BANK_CODE_FORMAT']),
    });
    expect(validateUnitedStatesBankProfile(validInput({ bankCode: '139876542' }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['BANK_CODE_RANGE']),
    });
    expect(validateUnitedStatesBankProfile(validInput({ bankCode: '019876543' }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['BANK_CODE_CHECKSUM']),
    });
    expect(validateUnitedStatesBankProfile(validInput({ bankCode: '339876549' }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['BANK_CODE_RANGE']),
    });
  });

  it('rejects invalid optional BIC and non-string account values without echoing them', () => {
    const badBic = validateUnitedStatesBankProfile(validInput({ bic: '12345678' }));
    expect(badBic).toMatchObject({ valid: false, errors: expect.arrayContaining(['BIC_INVALID']) });

    const invalidAccount = validateUnitedStatesBankProfile(validInput({ localAccountNumber: { secret: 'synthetic' } }));
    expect(invalidAccount).toEqual({ valid: false, errors: ['LOCAL_ACCOUNT_INVALID'] });
    expect(JSON.stringify(invalidAccount)).not.toContain('synthetic');
  });
});
