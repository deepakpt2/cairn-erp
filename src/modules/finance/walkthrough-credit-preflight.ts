import { and, eq } from 'drizzle-orm';
import { companyCode, creditControlArea } from '@/modules/foundation/schema';
import { withTenant } from '@/platform/db/client';

export interface WalkthroughCreditCompanySnapshot {
  isActive: boolean;
  currency: string;
  creditControlArea: string | null;
}

export interface WalkthroughCreditAreaSnapshot {
  isActive: boolean;
  currency: string;
}

/** Supported tenant-scoped read of the seed's credit prerequisites; it performs no writes. */
export async function readWalkthroughCreditPrerequisiteSnapshot(
  client: string,
  companyCodeValue: string,
  areaCode: string,
): Promise<{ company: WalkthroughCreditCompanySnapshot | null; area: WalkthroughCreditAreaSnapshot | null }> {
  return withTenant(client, async (tx) => {
    const companies = await tx.select({
      isActive: companyCode.isActive,
      currency: companyCode.currency,
      creditControlArea: companyCode.creditControlArea,
    }).from(companyCode).where(and(
      eq(companyCode.client, client), eq(companyCode.companyCode, companyCodeValue),
    ));
    const areas = await tx.select({
      isActive: creditControlArea.isActive,
      currency: creditControlArea.currency,
    }).from(creditControlArea).where(and(
      eq(creditControlArea.client, client), eq(creditControlArea.creditControlArea, areaCode),
    ));
    return { company: companies[0] ?? null, area: areas[0] ?? null };
  });
}

/**
 * Read-only walkthrough preflight for the credit configuration used by the seed. If company code 1000 is
 * absent, the documented standard-structure builder will create it together with CCA 0001; an existing
 * company code is never silently repaired or assigned a financial configuration by the seed.
 */
export function walkthroughCreditPrerequisiteError(input: {
  company: WalkthroughCreditCompanySnapshot | null;
  area: WalkthroughCreditAreaSnapshot | null;
  companyCode: string;
  areaCode: string;
  expectedCurrency: string;
}): string | null {
  const { company, area, companyCode, areaCode, expectedCurrency } = input;

  if (area && !area.isActive) {
    return `Walkthrough credit preflight: credit control area ${areaCode} exists but is inactive. The supported maintenance workflow is initial-setup-only and does not reactivate existing areas; do not change it through SQL. A separately reviewed recovery path is required.`;
  }
  if (area && area.currency !== expectedCurrency) {
    return `Walkthrough credit preflight: credit control area ${areaCode} uses ${area.currency}, but the walkthrough credit record is defined in ${expectedCurrency}. The supported maintenance workflow never changes an existing area's currency; owner review and a separately approved change path are required.`;
  }

  // For a genuinely new company code, applyStandardStructure creates the standard area and mapping in
  // the same supported setup path. Any pre-existing area was checked above before allowing that call.
  if (!company) return null;

  if (!company.isActive) {
    return `Walkthrough credit preflight: company code ${companyCode} exists but is inactive. The seed will not change it.`;
  }
  if (company.currency !== expectedCurrency) {
    return `Walkthrough credit preflight: company code ${companyCode} uses ${company.currency}, but the walkthrough expects ${expectedCurrency}. The seed will not change it.`;
  }
  if (!area) {
    return `Walkthrough credit preflight: active credit control area ${areaCode} is missing for existing company code ${companyCode}. The standard-structure helper does not repair an existing company code. A capability-protected initial-setup workflow now exists, but its exact-grant-only authority remains unassigned by default; Do not create it through SQL. Obtain a separate explicit role-grant approval before using the workflow.`;
  }
  if (company.creditControlArea !== areaCode) {
    return `Walkthrough credit preflight: company code ${companyCode} is mapped to ${company.creditControlArea ?? 'no credit control area'}, not ${areaCode}. The supported setup workflow only makes an initial assignment and never replaces a mapping. Do not change it through SQL; a separately reviewed recovery path is required.`;
  }
  return null;
}
