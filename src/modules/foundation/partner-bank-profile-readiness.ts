/** Read-only runtime lookup for the shared partner-bank profile registry. */
import { eq } from 'drizzle-orm';
import { assertApplicationRole, db } from '../../platform/db/client';
import {
  resolvePartnerBankProfileReadiness,
  type PartnerBankProfileAuthoringCountry,
  type PartnerBankProfileReadiness,
  type PartnerBankProfileRegistryRow,
} from '../../platform/security/partner-bank-profile-readiness';
import { partnerBankCountryProfile } from './partner-bank-country-profile-schema';

export type PartnerBankProfileRegistryLookup = (
  country: PartnerBankProfileAuthoringCountry,
) => Promise<PartnerBankProfileRegistryRow | null>;

/**
 * Build a read-only readiness reader. The injected lookup makes the policy
 * decision independently testable; lookup failures propagate so callers fail closed.
 */
export function createPartnerBankProfileReadinessReader(lookup: PartnerBankProfileRegistryLookup) {
  return async (countryInput: unknown): Promise<PartnerBankProfileReadiness> => {
    const preflight = resolvePartnerBankProfileReadiness(countryInput);
    if (preflight.status !== 'PROFILE_NOT_READY' || preflight.reason !== 'REGISTRY_ROW_MISSING') {
      return preflight;
    }

    const row = await lookup(preflight.country);
    return resolvePartnerBankProfileReadiness(countryInput, row);
  };
}

async function lookupSharedProfile(country: PartnerBankProfileAuthoringCountry) {
  await assertApplicationRole();
  const [row] = await db()
    .select({
      policyRevision: partnerBankCountryProfile.policyRevision,
      readinessStatus: partnerBankCountryProfile.readinessStatus,
    })
    .from(partnerBankCountryProfile)
    .where(eq(partnerBankCountryProfile.countryCode, country))
    .limit(1);
  return row ?? null;
}

/**
 * Read global profile readiness by country. `PROFILE_READY` indicates only that
 * the policy is configured and revision-matched; it is not bank-save authority.
 */
export const readPartnerBankProfileReadiness =
  createPartnerBankProfileReadinessReader(lookupSharedProfile);
