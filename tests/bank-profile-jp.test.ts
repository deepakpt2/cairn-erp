import { describe, expect, it } from 'vitest';
import { validateJapanBankProfile } from '../src/platform/security/bank-profile-jp';

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    accountHolder: 'Synthetic Account Holder',
    country: 'JP',
    localAccountNumber: '0000012345',
    bankCode: '0000000',
    ...overrides,
  };
}

describe('pure Japan bank profile', () => {
  it('normalizes country/BIC and preserves leading zeros in the account and bank code', () => {
    const localAccountNumber = ' 0000-A/7 ';
    const result = validateJapanBankProfile({
      accountHolder: '  Synthetic Account Holder  ',
      country: ' jp ',
      localAccountNumber,
      bankCode: ' 0012345 ',
      bic: ' testjp00 ',
    });

    expect(result).toEqual({
      valid: true,
      data: {
        accountHolder: 'Synthetic Account Holder',
        country: 'JP',
        localAccountNumber,
        bankCode: '0012345',
        bic: 'TESTJP00',
      },
    });
  });

  it('allows an optional BIC and treats the local account number as opaque', () => {
    const localAccountNumber = `00${'A-/'.repeat(20)}`;
    expect(validateJapanBankProfile(validInput({ localAccountNumber, bic: '' }))).toMatchObject({
      valid: true,
      data: { localAccountNumber, bankCode: '0000000', bic: null },
    });
  });

  it('requires holder, JP country, local account and seven-digit bank code, and rejects IBAN', () => {
    expect(validateJapanBankProfile({ accountHolder: '', country: 'JP' })).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        'ACCOUNT_HOLDER_REQUIRED',
        'LOCAL_ACCOUNT_REQUIRED',
        'BANK_CODE_REQUIRED',
      ]),
    });
    expect(validateJapanBankProfile(validInput({ country: 'US' }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['COUNTRY_NOT_JP']),
    });
    expect(validateJapanBankProfile(validInput({ iban: 'JP00SYNTHETIC' }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['IBAN_NOT_ALLOWED']),
    });
  });

  it('requires exactly seven ASCII digits for the institution-plus-branch composite', () => {
    for (const bankCode of ['123456', '12345678', '1234A67']) {
      expect(validateJapanBankProfile(validInput({ bankCode }))).toMatchObject({
        valid: false,
        errors: expect.arrayContaining(['BANK_CODE_FORMAT']),
      });
    }
  });

  it('rejects non-string account input without echoing submitted values', () => {
    const result = validateJapanBankProfile(validInput({ localAccountNumber: { secret: 'synthetic' } }));

    expect(result).toEqual({ valid: false, errors: ['LOCAL_ACCOUNT_INVALID'] });
    expect(JSON.stringify(result)).not.toContain('synthetic');
  });
});
