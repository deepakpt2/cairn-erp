import { describe, expect, it } from 'vitest';
import { validatePartnerBankProfile } from '../src/platform/security/partner-bank-profile';

describe('pure partner-bank profile dispatcher', () => {
  it('dispatches each implemented initial country to its specific validator', () => {
    const cases = [
      {
        country: 'KW',
        accountHolder: 'Synthetic Holder',
        iban: 'KW30TEST0000000000000000000000',
        expected: { country: 'KW', bankCode: 'TEST' },
      },
      {
        country: 'IN',
        accountHolder: 'Synthetic Holder',
        localAccountNumber: '0000012345',
        bankCode: 'TEST0123X45',
        expected: { country: 'IN', bankCode: 'TEST0123X45' },
      },
      {
        country: 'GB',
        accountHolder: 'Synthetic Holder',
        iban: 'GB05TEST00000000000000',
        expected: { country: 'GB', bankCode: 'TEST' },
      },
      {
        country: 'US',
        accountHolder: 'Synthetic Holder',
        localAccountNumber: '0000012345',
        bankCode: '019876542',
        expected: { country: 'US', bankCode: '019876542' },
      },
      {
        country: 'JP',
        accountHolder: 'Synthetic Holder',
        localAccountNumber: '0000012345',
        bankCode: '0000000',
        expected: { country: 'JP', bankCode: '0000000' },
      },
    ];

    for (const input of cases) {
      expect(validatePartnerBankProfile(input)).toMatchObject({ valid: true, data: input.expected });
    }
  });

  it('normalizes country code before dispatch', () => {
    expect(validatePartnerBankProfile({
      accountHolder: 'Synthetic Holder',
      country: ' kw ',
      iban: 'kw30test0000000000000000000000',
    })).toMatchObject({ valid: true, data: { country: 'KW', iban: 'KW30TEST0000000000000000000000' } });
  });

  it('rejects missing and unsupported country codes without falling back to a profile', () => {
    expect(validatePartnerBankProfile({
      accountHolder: 'Synthetic Holder',
      localAccountNumber: '0000012345',
      bankCode: 'TEST0123X45',
    })).toEqual({ valid: false, errors: ['COUNTRY_REQUIRED'] });

    expect(validatePartnerBankProfile({
      accountHolder: 'Synthetic Holder',
      country: 'DE',
      localAccountNumber: '0000012345',
      bankCode: 'TEST0123X45',
    })).toEqual({ valid: false, errors: ['PROFILE_UNAVAILABLE'] });
  });
});
