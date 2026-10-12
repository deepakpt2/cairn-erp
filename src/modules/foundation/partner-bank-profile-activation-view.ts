/** Read-only country-profile registry view for the capability-gated activation page. */
import { asc, eq, inArray } from 'drizzle-orm';
import { assertApplicationRole, db } from '../../platform/db/client';
import { country } from '../../platform/tables/reference';
import { PARTNER_BANK_PROFILE_POLICIES } from '../../platform/security/partner-bank-profile-readiness';
import { partnerBankCountryProfile } from './partner-bank-country-profile-schema';

export type PartnerBankProfileActivationViewStatus =
  | 'READY'
  | 'NOT_READY'
  | 'REGISTRY_ROW_MISSING'
  | 'POLICY_REVISION_MISMATCH'
  | 'REGISTRY_INVALID';

export interface PartnerBankProfileActivationRegistrySnapshot {
  countryCode: unknown;
  countryName: unknown;
  policyRevision: unknown;
  readinessStatus: unknown;
  version: unknown;
}

export interface PartnerBankProfileActivationViewRow {
  country: (typeof PARTNER_BANK_PROFILE_POLICIES)[number]['country'];
  countryName: string;
  currentPolicyRevision: string;
  registryPolicyRevision: string | null;
  status: PartnerBankProfileActivationViewStatus;
  version: number | null;
  canActivate: boolean;
}

/** Map untrusted query rows to a closed, fail-closed five-country view model. */
export function resolvePartnerBankProfileActivationRows(
  snapshots: readonly PartnerBankProfileActivationRegistrySnapshot[],
): PartnerBankProfileActivationViewRow[] {
  const byCountry = new Map<string, PartnerBankProfileActivationRegistrySnapshot>();
  for (const snapshot of snapshots) {
    if (typeof snapshot.countryCode === 'string') {
      byCountry.set(snapshot.countryCode.trim().toUpperCase(), snapshot);
    }
  }

  return PARTNER_BANK_PROFILE_POLICIES.map((policy) => {
    const row = byCountry.get(policy.country);
    const countryName = typeof row?.countryName === 'string' && row.countryName.trim()
      ? row.countryName.trim()
      : policy.country;
    if (!row || row.policyRevision === null || row.policyRevision === undefined) {
      return {
        country: policy.country,
        countryName,
        currentPolicyRevision: policy.policyRevision,
        registryPolicyRevision: null,
        status: 'REGISTRY_ROW_MISSING',
        version: null,
        canActivate: false,
      };
    }

    const registryPolicyRevision = typeof row.policyRevision === 'string' ? row.policyRevision : null;
    const version = typeof row.version === 'number' && Number.isSafeInteger(row.version) && row.version > 0
      ? row.version
      : null;
    if (
      registryPolicyRevision !== policy.policyRevision
    ) {
      return {
        country: policy.country,
        countryName,
        currentPolicyRevision: policy.policyRevision,
        registryPolicyRevision,
        status: 'POLICY_REVISION_MISMATCH',
        version,
        canActivate: false,
      };
    }

    if (!version || (row.readinessStatus !== 'NOT_READY' && row.readinessStatus !== 'READY')) {
      return {
        country: policy.country,
        countryName,
        currentPolicyRevision: policy.policyRevision,
        registryPolicyRevision,
        status: 'REGISTRY_INVALID',
        version,
        canActivate: false,
      };
    }

    const status = row.readinessStatus;
    return {
      country: policy.country,
      countryName,
      currentPolicyRevision: policy.policyRevision,
      registryPolicyRevision,
      status,
      version,
      canActivate: status === 'NOT_READY',
    };
  });
}

/** Query only the five approved global profiles; this view never reads bank records or audit detail. */
export async function listPartnerBankProfileActivationRows(): Promise<PartnerBankProfileActivationViewRow[]> {
  await assertApplicationRole();
  const snapshots = await db()
    .select({
      countryCode: country.code,
      countryName: country.name,
      policyRevision: partnerBankCountryProfile.policyRevision,
      readinessStatus: partnerBankCountryProfile.readinessStatus,
      version: partnerBankCountryProfile.version,
    })
    .from(country)
    .leftJoin(partnerBankCountryProfile, eq(partnerBankCountryProfile.countryCode, country.code))
    .where(inArray(country.code, PARTNER_BANK_PROFILE_POLICIES.map(({ country: code }) => code)))
    .orderBy(asc(country.code));
  return resolvePartnerBankProfileActivationRows(snapshots);
}
