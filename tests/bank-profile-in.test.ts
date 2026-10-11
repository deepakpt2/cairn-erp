import { describe, expect, it } from 'vitest';
import { validateIndiaBankProfile } from '../src/platform/security/bank-profile-in';

const SYNTHETIC_IFSC = 'TEST0123X45';

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    accountHolder: 'Synthetic Account Holder',
    country: 'IN',
    localAccountNumber: '0000012345',
    bankCode: SYNTHETIC_IFSC,
    ...overrides,
  };
}

describe('pure India bank profile', () => {
  it('normalizes country, IFSC and optional BIC while preserving the opaque account exactly', () => {
    const localAccountNumber = ' 0000-AB/7 ';
    const request = {
      accountHolder: '  Synthetic Account Holder  ',
      country: ' in ',
      localAccountNumber,
      bankCode: ' test0123x45 ',
      bic: ' testin00 ',
      iban: ' ',
      ignoredField: 'not returned',
    };
    const result = validateIndiaBankProfile(request);

    expect(result).toEqual({
      valid: true,
      data: {
        accountHolder: 'Synthetic Account Holder',
        country: 'IN',
        localAccountNumber,
        bankCode: SYNTHETIC_IFSC,
        bic: 'TESTIN00',
      },
    });
    expect(JSON.stringify(result)).not.toContain('ignoredField');
  });

  it('allows an omitted BIC and applies no India-wide account-number format or length rule', () => {
    const localAccountNumber = `00${'A-/'.repeat(20)}`;
    const result = validateIndiaBankProfile(validInput({ localAccountNumber, bic: '' }));

    expect(result).toEqual({
      valid: true,
      data: {
        accountHolder: 'Synthetic Account Holder',
        country: 'IN',
        localAccountNumber,
        bankCode: SYNTHETIC_IFSC,
        bic: null,
      },
    });
  });

  it('requires holder, IN country, local account and IFSC, and rejects an IBAN', () => {
    const missing = validateIndiaBankProfile({
      accountHolder: ' ',
      country: 'IN',
      localAccountNumber: '   ',
      bankCode: '',
    });
    expect(missing).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        'ACCOUNT_HOLDER_REQUIRED',
        'LOCAL_ACCOUNT_REQUIRED',
        'IFSC_REQUIRED',
      ]),
    });

    expect(validateIndiaBankProfile(validInput({ country: 'KW' }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['COUNTRY_NOT_IN']),
    });
    expect(validateIndiaBankProfile(validInput({ iban: 'IN00SYNTHETIC' }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['IBAN_NOT_ALLOWED']),
    });
  });

  it('enforces IFSC syntax and optional BIC syntax only', () => {
    for (const bankCode of ['TEST1123X45', 'TEST0123X4', '1EST0123X45']) {
      expect(validateIndiaBankProfile(validInput({ bankCode }))).toMatchObject({
        valid: false,
        errors: expect.arrayContaining(['IFSC_FORMAT']),
      });
    }

    expect(validateIndiaBankProfile(validInput({ bic: '12345678' }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['BIC_INVALID']),
    });
  });

  it('rejects non-string account input without echoing submitted values', () => {
    const result = validateIndiaBankProfile(validInput({ localAccountNumber: { secret: 'not-a-bank-value' } }));

    expect(result).toEqual({ valid: false, errors: ['LOCAL_ACCOUNT_INVALID'] });
    expect(JSON.stringify(result)).not.toContain('not-a-bank-value');
  });
});
