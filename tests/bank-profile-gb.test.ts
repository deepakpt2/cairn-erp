import { describe, expect, it } from 'vitest';
import { validateGreatBritainBankProfile } from '../src/platform/security/bank-profile-gb';

const SYNTHETIC_GB_IBAN = 'GB05TEST00000000000000';

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    accountHolder: 'Synthetic Account Holder',
    country: 'GB',
    iban: SYNTHETIC_GB_IBAN,
    ...overrides,
  };
}

describe('pure Great Britain bank profile', () => {
  it('normalizes the IBAN/BIC and derives the bank code from the IBAN', () => {
    const result = validateGreatBritainBankProfile({
      accountHolder: '  Synthetic Account Holder  ',
      country: ' gb ',
      iban: ' gb05 test00000000000000 ',
      bankCode: ' test ',
      bic: ' testgb00 ',
    });

    expect(result).toEqual({
      valid: true,
      data: {
        accountHolder: 'Synthetic Account Holder',
        country: 'GB',
        iban: SYNTHETIC_GB_IBAN,
        bankCode: 'TEST',
        bic: 'TESTGB00',
      },
    });
  });

  it('allows an optional BIC and does not accept a separate local account', () => {
    expect(validateGreatBritainBankProfile(validInput({ bic: '' }))).toMatchObject({
      valid: true,
      data: { bankCode: 'TEST', bic: null },
    });
    expect(validateGreatBritainBankProfile(validInput({ localAccountNumber: '00123456' }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['LOCAL_ACCOUNT_NOT_ALLOWED']),
    });
  });

  it('requires holder, GB country and IBAN, and checks any supplied bank code', () => {
    expect(validateGreatBritainBankProfile({ accountHolder: '', country: 'GB', iban: '' })).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['ACCOUNT_HOLDER_REQUIRED', 'IBAN_REQUIRED']),
    });
    expect(validateGreatBritainBankProfile(validInput({ country: 'IN' }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['COUNTRY_NOT_GB']),
    });
    expect(validateGreatBritainBankProfile(validInput({ bankCode: 'WRONG' }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['BANK_CODE_MISMATCH']),
    });
  });

  it('enforces GB IBAN structure/checksum and syntax-checks optional BIC only', () => {
    expect(validateGreatBritainBankProfile(validInput({ iban: 'GB05TEST0000' }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['IBAN_FORMAT']),
    });
    expect(validateGreatBritainBankProfile(validInput({ iban: `GB06${SYNTHETIC_GB_IBAN.slice(4)}` }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['IBAN_CHECKSUM']),
    });
    expect(validateGreatBritainBankProfile(validInput({ bic: '12345678' }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['BIC_INVALID']),
    });
  });
});
