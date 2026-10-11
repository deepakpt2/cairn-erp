import { describe, expect, it } from 'vitest';
import { validateKuwaitBankProfile } from '../src/platform/security/bank-profile-kw';

const SYNTHETIC_KW_IBAN = 'KW30TEST0000000000000000000000';

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    accountHolder: 'Synthetic Account Holder',
    country: 'KW',
    iban: SYNTHETIC_KW_IBAN,
    ...overrides,
  };
}

describe('pure Kuwait bank profile', () => {
  it('normalizes IBAN/BIC and derives the bank code without accepting a local account', () => {
    const request = {
      accountHolder: '  Synthetic Account Holder  ',
      country: ' kw ',
      iban: ' kw30 test0000000000000000000000 ',
      localAccountNumber: '   ',
      bankCode: ' test ',
      bic: ' testkw2l ',
      ignoredField: 'not returned',
    };
    const result = validateKuwaitBankProfile(request);

    expect(result).toEqual({
      valid: true,
      data: {
        accountHolder: 'Synthetic Account Holder',
        country: 'KW',
        iban: SYNTHETIC_KW_IBAN,
        bankCode: 'TEST',
        bic: 'TESTKW2L',
      },
    });
    expect(JSON.stringify(result)).not.toContain('ignoredField');
  });

  it('allows an optional BIC and returns the IBAN-derived bank code', () => {
    const result = validateKuwaitBankProfile(validInput({ bankCode: undefined, bic: '' }));
    expect(result).toEqual({
      valid: true,
      data: {
        accountHolder: 'Synthetic Account Holder',
        country: 'KW',
        iban: SYNTHETIC_KW_IBAN,
        bankCode: 'TEST',
        bic: null,
      },
    });
  });

  it('rejects missing holder/IBAN, non-KW country, and separate local account input', () => {
    expect(validateKuwaitBankProfile({ accountHolder: ' ', country: 'KW', iban: '' })).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['ACCOUNT_HOLDER_REQUIRED', 'IBAN_REQUIRED']),
    });
    expect(validateKuwaitBankProfile(validInput({ country: 'US' }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['COUNTRY_NOT_KW']),
    });
    expect(validateKuwaitBankProfile(validInput({ localAccountNumber: '000123' }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['LOCAL_ACCOUNT_NOT_ALLOWED']),
    });
  });

  it('enforces Kuwait IBAN structure/checksum and optional BIC syntax only', () => {
    expect(validateKuwaitBankProfile(validInput({ iban: 'KW30TEST0000' }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['IBAN_FORMAT']),
    });
    expect(validateKuwaitBankProfile(validInput({ iban: `KW31${SYNTHETIC_KW_IBAN.slice(4)}` }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['IBAN_CHECKSUM']),
    });
    expect(validateKuwaitBankProfile(validInput({ bic: '12345678' }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['BIC_INVALID']),
    });
    expect(validateKuwaitBankProfile(validInput({ bankCode: 'WRONG' }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['BANK_CODE_MISMATCH']),
    });
  });
});
