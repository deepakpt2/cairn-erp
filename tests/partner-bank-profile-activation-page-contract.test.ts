import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const activationPage = readFileSync('src/app/foundation/partners/bank-profiles/page.tsx', 'utf8');
const partnersPage = readFileSync('src/app/foundation/partners/page.tsx', 'utf8');

describe('partner-bank profile activation page access contract', () => {
  it('requires a verified session and the dedicated activation capability before reading profiles', () => {
    expect(activationPage).toContain("requireSession('/foundation/partners/bank-profiles')");
    expect(activationPage).toContain('can(session, PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY)');
    expect(activationPage.indexOf('if (!can(session, PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY))'))
      .toBeLessThan(activationPage.indexOf('listPartnerBankProfileActivationRows()'));
    expect(activationPage).not.toContain('listPartnerBankMetadata');
    expect(activationPage).not.toContain('getPartnerBankMaskedDetail');
  });

  it('shows the profile-management link only to users holding its capability', () => {
    expect(partnersPage).toContain('can(session,PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY)&&<Link');
    expect(partnersPage).toContain('href="/foundation/partners/bank-profiles"');
  });
});
