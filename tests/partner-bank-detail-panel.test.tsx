import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PartnerBankMaskedDetail } from '../src/modules/foundation/partner-bank-detail-view';
import { PartnerBankDetailPanel } from '../src/app/foundation/partners/PartnerBankDetailPanel';

const detail: PartnerBankMaskedDetail = {
  accountHolder: 'Synthetic Holder',
  country: 'KW',
  bankName: 'Synthetic Bank',
  bankCode: 'SYN',
  bic: null,
  validFrom: '2026-01-01',
  validTo: null,
  isActive: true,
  version: 1,
  identifierKind: 'IBAN',
  maskedIdentifier: '••••4321',
};

describe('partner bank masked detail panel', () => {
  it('renders the D-074 suffix mask and safe metadata only', () => {
    const markup = renderToStaticMarkup(
      <PartnerBankDetailPanel partnerNumber="BP.100" detail={detail} />,
    );

    expect(markup).toContain('Bank record details');
    expect(markup).toContain('Synthetic Holder');
    expect(markup).toContain('Synthetic Bank');
    expect(markup).toContain('IBAN');
    expect(markup).toContain('••••4321');
    expect(markup).toContain('Back to bank records');
    expect(markup).not.toContain('SYNTHETIC-IBAN-4321');
    expect(markup).not.toContain('cbd1.');
    expect(markup).not.toContain('SEC.PARTNER.BANK.REVEAL');
    expect(markup).not.toMatch(/\b(save|reveal)\b/i);
  });

  it('renders a generic unavailable state without bank fields', () => {
    const markup = renderToStaticMarkup(
      <PartnerBankDetailPanel partnerNumber="BP.100" detail={null} />,
    );

    expect(markup).toContain('Bank details are unavailable for this record.');
    expect(markup).toContain('Back to bank records');
    expect(markup).not.toContain('Synthetic Holder');
    expect(markup).not.toContain('••••4321');
  });
});
