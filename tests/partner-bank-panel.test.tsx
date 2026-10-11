import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BankRecordId } from '../src/platform/security/bank-record-id';
import type { PartnerBankMetadata } from '../src/modules/foundation/partner-bank-reads';
import { PartnerBankMetadataPanel } from '../src/app/foundation/partners/PartnerBankMetadataPanel';

const row: PartnerBankMetadata = {
  bankRecordId: 'f0c49b11-9ab2-4ca8-91d6-ef6a0c9f5f21' as BankRecordId,
  partnerNumber: 'BP.100',
  accountHolder: 'Synthetic Holder',
  country: 'KW',
  bankName: 'Synthetic Bank',
  bankCode: 'TEST',
  bic: null,
  validFrom: '2026-01-01',
  validTo: null,
  isActive: true,
  version: 1,
};

describe('partner bank metadata panel', () => {
  it('renders allowlisted metadata and only the fixed list mask', () => {
    const markup = renderToStaticMarkup(<PartnerBankMetadataPanel records={[row]} />);

    expect(markup).toContain('Partner-wide bank records');
    expect(markup).toContain('Synthetic Holder');
    expect(markup).toContain('Synthetic Bank');
    expect(markup).toContain('KW');
    expect(markup).toContain('••••');
    expect(markup).toContain('Account identifier masked');
    expect(markup).toContain('Active');
    expect(markup).not.toContain(row.bankRecordId);
    expect(markup).not.toContain('ibanCiphertext');
    expect(markup).not.toContain('localAccountNumberCiphertext');
    expect(markup).not.toContain('SEC.PARTNER.BANK.REVEAL');
  });

  it('renders distinct empty and unavailable states', () => {
    const empty = renderToStaticMarkup(<PartnerBankMetadataPanel records={[]} />);
    const unavailable = renderToStaticMarkup(<PartnerBankMetadataPanel records={null} />);

    expect(empty).toContain('No bank records are available for this partner.');
    expect(empty).not.toContain('<table');
    expect(unavailable).toContain('Bank metadata is unavailable.');
    expect(unavailable).not.toContain('<table');
  });
});
