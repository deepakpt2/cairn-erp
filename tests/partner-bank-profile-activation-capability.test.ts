import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasCapability } from '../src/platform/auth/session';
import {
  PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY,
  PARTNER_BANK_PROFILE_ACTIVATION_EVIDENCE,
} from '../src/platform/security/partner-bank-profile-activation';

const seedSource = readFileSync('scripts/seed.ts', 'utf8');

describe('partner-bank profile activation capability catalogue entry', () => {
  it('registers the approved capability without granting it to tenant roles', () => {
    expect(PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY).toBe('CFG.FND.PARTNER.BANKPROFILE.ACTIVATE');
    expect(seedSource).toContain('code: PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY');
    expect(seedSource).toContain("module: 'FND', action: 'CONFIGURE', posting: false");
    expect(seedSource).not.toMatch(/insert\s+into\s+role_capability/i);
  });

  it('keeps the approval evidence code controlled and preserves wildcard semantics', () => {
    expect(PARTNER_BANK_PROFILE_ACTIVATION_EVIDENCE).toBe('PROFILE_VALIDATION_ACCEPTED');
    expect(hasCapability(['*'], PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY)).toBe(true);
    expect(hasCapability(['FND.*'], PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY)).toBe(false);
    expect(hasCapability([], PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY)).toBe(false);
  });
});
