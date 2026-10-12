/**
 * Pure readiness resolver for the owner-approved partner-bank profile set.
 *
 * D-061 identifies countries to author; it does not imply readiness. A profile
 * is ready only when the shared registry row matches the current policy revision
 * and is explicitly READY. This is profile readiness only, not save authority.
 */
export const PARTNER_BANK_PROFILE_POLICIES = [
  { country: 'IN', policyRevision: 'D-063' },
  { country: 'KW', policyRevision: 'D-062' },
  { country: 'GB', policyRevision: 'D-064' },
  { country: 'US', policyRevision: 'D-065' },
  { country: 'JP', policyRevision: 'D-066' },
] as const;

export const PARTNER_BANK_PROFILE_AUTHORING_COUNTRIES = PARTNER_BANK_PROFILE_POLICIES.map(
  ({ country }) => country,
);

export type PartnerBankProfileAuthoringCountry =
  (typeof PARTNER_BANK_PROFILE_POLICIES)[number]['country'];

export interface PartnerBankProfileRegistryRow {
  policyRevision: unknown;
  readinessStatus: unknown;
}

export type PartnerBankProfileReadiness =
  | { status: 'COUNTRY_REQUIRED'; ready: false }
  | { status: 'PROFILE_UNAVAILABLE'; ready: false }
  | {
      status: 'PROFILE_NOT_READY';
      country: PartnerBankProfileAuthoringCountry;
      reason: 'REGISTRY_ROW_MISSING' | 'POLICY_REVISION_MISMATCH' | 'PROFILE_NOT_ACTIVATED';
      ready: false;
    }
  | {
      status: 'PROFILE_READY';
      country: PartnerBankProfileAuthoringCountry;
      policyRevision: string;
      ready: true;
    };

const POLICY_BY_COUNTRY = new Map<string, (typeof PARTNER_BANK_PROFILE_POLICIES)[number]>(
  PARTNER_BANK_PROFILE_POLICIES.map((policy) => [policy.country, policy]),
);

/** Resolve readiness without I/O. Missing, stale, or non-ready registry state denies. */
export function resolvePartnerBankProfileReadiness(
  countryInput: unknown,
  registryRow: PartnerBankProfileRegistryRow | null = null,
): PartnerBankProfileReadiness {
  const country = typeof countryInput === 'string' ? countryInput.trim().toUpperCase() : '';
  if (!country) return { status: 'COUNTRY_REQUIRED', ready: false };

  const policy = POLICY_BY_COUNTRY.get(country);
  if (!policy) return { status: 'PROFILE_UNAVAILABLE', ready: false };
  if (!registryRow) {
    return { status: 'PROFILE_NOT_READY', country: policy.country, reason: 'REGISTRY_ROW_MISSING', ready: false };
  }
  if (registryRow.policyRevision !== policy.policyRevision) {
    return { status: 'PROFILE_NOT_READY', country: policy.country, reason: 'POLICY_REVISION_MISMATCH', ready: false };
  }
  if (registryRow.readinessStatus !== 'READY') {
    return { status: 'PROFILE_NOT_READY', country: policy.country, reason: 'PROFILE_NOT_ACTIVATED', ready: false };
  }

  return {
    status: 'PROFILE_READY',
    country: policy.country,
    policyRevision: policy.policyRevision,
    ready: true,
  };
}
