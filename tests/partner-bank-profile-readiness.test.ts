import { describe, expect, it } from 'vitest';
import { validatePartnerBankProfile } from '../src/platform/security/partner-bank-profile';
import {
  PARTNER_BANK_PROFILE_AUTHORING_COUNTRIES,
  resolvePartnerBankProfileReadiness,
} from '../src/platform/security/partner-bank-profile-readiness';

describe('partner-bank profile readiness resolver', () => {
  it.each(PARTNER_BANK_PROFILE_AUTHORING_COUNTRIES)(
    'keeps approved authoring country %s blocked when its registry row is missing',
    (country) => {
      expect(resolvePartnerBankProfileReadiness(country)).toEqual({
        status: 'PROFILE_NOT_READY',
        country,
        reason: 'REGISTRY_ROW_MISSING',
        ready: false,
      });
    },
  );

  it('normalizes country codes and reports ready only for the current policy revision', () => {
    expect(resolvePartnerBankProfileReadiness(' kw ', {
      policyRevision: 'D-062',
      readinessStatus: 'READY',
    })).toEqual({
      status: 'PROFILE_READY',
      country: 'KW',
      policyRevision: 'D-062',
      ready: true,
    });
  });

  it('fails closed for a stale policy revision or a non-ready registry state', () => {
    expect(resolvePartnerBankProfileReadiness('KW', {
      policyRevision: 'D-061',
      readinessStatus: 'READY',
    })).toMatchObject({ status: 'PROFILE_NOT_READY', reason: 'POLICY_REVISION_MISMATCH', ready: false });
    expect(resolvePartnerBankProfileReadiness('KW', {
      policyRevision: 'D-062',
      readinessStatus: 'NOT_READY',
    })).toMatchObject({ status: 'PROFILE_NOT_READY', reason: 'PROFILE_NOT_ACTIVATED', ready: false });
  });

  it('does not equate pure validator success with profile readiness', () => {
    const validation = validatePartnerBankProfile({
      accountHolder: 'Synthetic Holder',
      country: 'KW',
      iban: 'KW30TEST0000000000000000000000',
    });
    expect(validation).toMatchObject({ valid: true, data: { country: 'KW' } });
    expect(resolvePartnerBankProfileReadiness('KW')).toMatchObject({
      status: 'PROFILE_NOT_READY',
      ready: false,
    });
  });

  it('requires country and blocks countries outside the approved authoring set', () => {
    expect(resolvePartnerBankProfileReadiness(undefined)).toEqual({
      status: 'COUNTRY_REQUIRED',
      ready: false,
    });
    expect(resolvePartnerBankProfileReadiness('   ')).toEqual({
      status: 'COUNTRY_REQUIRED',
      ready: false,
    });
    expect(resolvePartnerBankProfileReadiness('CA')).toEqual({
      status: 'PROFILE_UNAVAILABLE',
      ready: false,
    });
  });
});
