import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PartnerBankProfileActivationViewRow } from '../src/modules/foundation/partner-bank-profile-activation-view';
import { PartnerBankProfileActivationPanel } from '../src/app/foundation/partners/PartnerBankProfileActivationPanel';

const rows: PartnerBankProfileActivationViewRow[] = [
  {
    country: 'KW',
    countryName: 'Kuwait',
    currentPolicyRevision: 'D-062',
    registryPolicyRevision: 'D-062',
    status: 'NOT_READY',
    version: 4,
    canActivate: true,
  },
  {
    country: 'GB',
    countryName: 'United Kingdom',
    currentPolicyRevision: 'D-064',
    registryPolicyRevision: 'D-064',
    status: 'READY',
    version: 2,
    canActivate: false,
  },
  {
    country: 'US',
    countryName: 'United States',
    currentPolicyRevision: 'D-065',
    registryPolicyRevision: 'D-064',
    status: 'POLICY_REVISION_MISMATCH',
    version: 1,
    canActivate: false,
  },
];

describe('partner-bank profile activation panel', () => {
  it('renders readiness and a single one-way form with revision/version guards', () => {
    const markup = renderToStaticMarkup(<PartnerBankProfileActivationPanel rows={rows} />);

    expect(markup).toContain('Global profile readiness');
    expect(markup).toContain('Activation is one-way.');
    expect(markup).toContain('Kuwait');
    expect(markup).toContain('United Kingdom');
    expect(markup).toContain('Policy revision mismatch');
    expect(markup).toContain('name="country" value="KW"');
    expect(markup).toContain('name="expectedPolicyRevision" value="D-062"');
    expect(markup).toContain('name="expectedVersion" value="4"');
    expect(markup).toContain('Activate profile');
    expect((markup.match(/name="expectedVersion"/g) ?? []).length).toBe(1);
    expect((markup.match(/Activate profile/g) ?? []).length).toBe(1);
  });

  it('does not render bank-record save/reveal controls or account identifiers', () => {
    const markup = renderToStaticMarkup(<PartnerBankProfileActivationPanel rows={rows} />);
    expect(markup).not.toMatch(/<button[^>]*>(?:Save|Reveal)/i);
    expect(markup).not.toContain('name="bankRecordId"');
    expect(markup).not.toContain('name="evidenceCode"');
    expect(markup).not.toContain('name="reason"');
    expect(markup).not.toContain('name="rationale"');
    expect(markup).not.toContain('IBAN');
    expect(markup).not.toContain('localAccountNumber');
  });
});
