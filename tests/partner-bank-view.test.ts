import { describe, expect, it } from 'vitest';
import {
  BANK_ACCOUNT_VIEW_MASK,
  projectPartnerBankNormalView,
} from '../src/platform/security/partner-bank-view';

describe('partner-bank normal-view projection', () => {
  it('fully masks identifiers in list views and drops ciphertext, unknown, and nested fields', () => {
    const iban = 'GB82WEST12345698765432';
    const localAccountNumber = '0000123456';
    const ciphertext = 'cbd1.synthetic-ciphertext-value';
    const projected = projectPartnerBankNormalView(
      {
        accountHolder: 'Synthetic Holder',
        country: 'GB',
        bankName: 'Synthetic Bank',
        bankCode: 'WEST',
        bic: 'SYNTHGB2L',
        iban,
        localAccountNumber,
        ibanCiphertext: ciphertext,
        localAccountNumberCiphertext: ciphertext,
        internalNotes: 'Synthetic private note',
        nested: { iban },
      },
      'list',
    );

    expect(projected).toMatchObject({
      accountHolder: 'Synthetic Holder',
      country: 'GB',
      bankName: 'Synthetic Bank',
      bankCode: 'WEST',
      bic: 'SYNTHGB2L',
      iban: BANK_ACCOUNT_VIEW_MASK,
      localAccountNumber: BANK_ACCOUNT_VIEW_MASK,
    });
    expect(projected).not.toHaveProperty('ibanCiphertext');
    expect(projected).not.toHaveProperty('localAccountNumberCiphertext');
    expect(projected).not.toHaveProperty('internalNotes');
    expect(projected).not.toHaveProperty('nested');
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain(iban);
    expect(serialized).not.toContain(localAccountNumber);
    expect(serialized).not.toContain(ciphertext);
  });

  it('shows only a fixed mask and final four characters in detail views', () => {
    const projected = projectPartnerBankNormalView(
      {
        country: 'GB',
        iban: 'GB82WEST12345698765432',
        localAccountNumber: '0000123456',
        accountNumber: '1234567890',
      },
      'detail',
    );

    expect(projected).toEqual({
      country: 'GB',
      iban: `${BANK_ACCOUNT_VIEW_MASK}5432`,
      localAccountNumber: `${BANK_ACCOUNT_VIEW_MASK}3456`,
      accountNumber: `${BANK_ACCOUNT_VIEW_MASK}7890`,
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('GB82');
    expect(serialized).not.toContain('WEST');
    expect(serialized).not.toContain('0000123456');
    expect(serialized).not.toContain('1234567890');
  });

  it('fully masks identifiers of four or fewer characters and preserves empty values', () => {
    const projected = projectPartnerBankNormalView(
      {
        iban: 'KW12',
        localAccountNumber: '1234',
        accountIdentifier: { raw: 'SYNTHETIC-NESTED-ACCOUNT' },
        accountNumber: '',
        swift: null,
      },
      'detail',
    );

    expect(projected).toEqual({
      iban: BANK_ACCOUNT_VIEW_MASK,
      localAccountNumber: BANK_ACCOUNT_VIEW_MASK,
      accountIdentifier: BANK_ACCOUNT_VIEW_MASK,
      accountNumber: '',
      swift: null,
    });
    expect(JSON.stringify(projected)).not.toContain('SYNTHETIC-NESTED-ACCOUNT');
    expect(projectPartnerBankNormalView(undefined, 'detail')).toBeUndefined();
  });
});
