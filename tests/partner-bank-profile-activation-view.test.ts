import { describe, expect, it } from 'vitest';
import {
  PARTNER_BANK_PROFILE_POLICIES,
} from '../src/platform/security/partner-bank-profile-readiness';
import { resolvePartnerBankProfileActivationRows } from '../src/modules/foundation/partner-bank-profile-activation-view';

function snapshots(overrides: Record<string, Partial<{
  countryName: unknown;
  policyRevision: unknown;
  readinessStatus: unknown;
  version: unknown;
}>> = {}) {
  return PARTNER_BANK_PROFILE_POLICIES.map((policy) => ({
    countryCode: policy.country,
    countryName: policy.country,
    policyRevision: policy.policyRevision,
    readinessStatus: 'NOT_READY',
    version: 1,
    ...overrides[policy.country],
  }));
}

describe('partner-bank profile activation view model', () => {
  it('exposes exactly the approved profiles and enables only current NOT_READY rows', () => {
    const rows = resolvePartnerBankProfileActivationRows(snapshots({
      KW: { countryName: 'Kuwait' },
      GB: { readinessStatus: 'READY', version: 2 },
    }));
    expect(rows.map((row) => row.country)).toEqual(['IN', 'KW', 'GB', 'US', 'JP']);
    expect(rows.find((row) => row.country === 'KW')).toMatchObject({
      countryName: 'Kuwait',
      currentPolicyRevision: 'D-062',
      registryPolicyRevision: 'D-062',
      status: 'NOT_READY',
      version: 1,
      canActivate: true,
    });
    expect(rows.find((row) => row.country === 'GB')).toMatchObject({
      status: 'READY',
      version: 2,
      canActivate: false,
    });
  });

  it('fails closed for missing or stale registry rows', () => {
    const all = snapshots({ IN: { policyRevision: 'D-062' } });
    const rows = resolvePartnerBankProfileActivationRows(all.filter((row) => row.countryCode !== 'JP'));
    expect(rows.find((row) => row.country === 'IN')).toMatchObject({
      status: 'POLICY_REVISION_MISMATCH',
      canActivate: false,
    });
    expect(rows.find((row) => row.country === 'JP')).toMatchObject({
      status: 'REGISTRY_ROW_MISSING',
      version: null,
      canActivate: false,
    });
  });

  it('fails closed for invalid status or row version', () => {
    const rows = resolvePartnerBankProfileActivationRows(snapshots({
      US: { readinessStatus: 'UNKNOWN' },
      IN: { version: 0 },
    }));
    expect(rows.find((row) => row.country === 'US')).toMatchObject({
      status: 'REGISTRY_INVALID',
      canActivate: false,
    });
    expect(rows.find((row) => row.country === 'IN')).toMatchObject({
      status: 'REGISTRY_INVALID',
      canActivate: false,
    });
  });
});
