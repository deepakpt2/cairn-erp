/**
 * Company-scope authority for company-wide reads and cross-company postings.
 *
 * Capability alone never reaches a company: a report or posting names the companies it actually reads
 * or writes (supplied, or derived from a plant, tax group, consolidation unit or stored document), and
 * every one of them must lie inside the caller's CURRENT Company Code scope, judged inside the
 * service's own transaction with the live-session / job-lease verification of `service-authority`.
 *
 * Policy (the existing one, stated once):
 * - Missing authorization, a dead session or a missing capability refuse. A user with no explicit
 *   Company Code scope refuses; an empty restriction list is NEVER unrestricted here
 *   (`verifyServiceAuthorityInTx` demands an explicit Company Code grant). Administrators are no
 *   exception: they carry explicit grants like everyone else.
 * - A company-wide aggregate (statement, balance, tax return, posting) is also refused for a
 *   plant-limited user: if the caller holds Plant scope that leaves any plant of the company
 *   uncovered, they are plant-level and may not read figures that mix every plant's journal lines.
 *   No Plant scope, or every plant of the company covered, is company level.
 * - An unauthorized company in a group/multi-company request refuses the whole request; the result is
 *   never silently trimmed to the authorized part. Derived companies are not named in the refusal.
 */
import { sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { hasOrgAccess, type OrgRestriction } from './session';
import { type ServiceAuthorityContext, type ServiceAuthorityRefusal, verifyServiceAuthorityInTx } from './service-authority';

export interface CompanyAuthority {
  username: string;
  restrictions: OrgRestriction[];
}

export type CompanyAuthorityVerdict =
  | ({ ok: true } & CompanyAuthority)
  | { ok: false; refusal: ServiceAuthorityRefusal };

/** Session/job, live capability and explicit Company Code scope. Does not yet judge any company. */
export async function verifyCompanyAuthorityInTx(
  tx: Tx,
  client: string,
  authorization: ServiceAuthorityContext | undefined,
  capability: string,
): Promise<CompanyAuthorityVerdict> {
  const verdict = await verifyServiceAuthorityInTx(tx, client, authorization, capability, { requirePlantScope: false });
  if (!verdict.ok) return verdict;
  return { ok: true, username: verdict.username, restrictions: verdict.restrictions };
}

/**
 * Does the authority cover every company? `derived` names where the company set came from when the caller did
 * not type it (group, unit, tax group): the refusal then does not name the company. Returns null when covered.
 */
export async function refuseCompaniesOutsideScopeInTx(
  tx: Tx,
  client: string,
  authority: CompanyAuthority,
  companyCodes: readonly string[],
  options: { derivedFrom?: string; allowPlantLimited?: boolean } = {},
): Promise<ServiceAuthorityRefusal | null> {
  const companies = [...new Set(companyCodes.map((c) => c.trim()).filter(Boolean))];
  if (companies.length === 0) {
    return { message: 'No company is selected.', remedy: 'Select a company code you are authorised for.' };
  }
  for (const company of companies) {
    if (!hasOrgAccess(authority.restrictions, 'COMPANY_CODE', company)) {
      return options.derivedFrom
        ? {
            message: `${options.derivedFrom} includes a company code outside your Company Code scope, so it cannot be run as a whole.`,
            remedy: 'Ask an administrator to extend your Company Code scope to every company it includes, or run a selection of companies you are authorised for.',
          }
        : {
            message: `Your Company Code scope does not cover company code ${company}.`,
            remedy: 'Ask an administrator to extend your Company Code scope, then repeat the action.',
          };
    }
  }
  const plantScopes = authority.restrictions.filter((r) => r.scopeType === 'PLANT');
  if (plantScopes.length > 0 && !options.allowPlantLimited) {
    const rows = (await tx.execute(sql`
      select plant, company_code from plant where client = ${client} and company_code in ${companies}
    `)) as unknown as Array<{ plant: string; company_code: string }>;
    const uncovered = rows.find((p) => !hasOrgAccess(authority.restrictions, 'PLANT', p.plant));
    if (uncovered) {
      return {
        message: 'Your Plant scope covers only some plants of a company in this request. A company-wide figure mixes every plant, so it is not shown to a plant-limited user.',
        remedy: 'Ask an administrator for company-wide scope (no Plant limit, or every plant of the company), or use a plant-level report.',
      };
    }
  }
  return null;
}

/** Verify authority and every company in one step. */
export async function authorizeCompaniesInTx(
  tx: Tx,
  client: string,
  authorization: ServiceAuthorityContext | undefined,
  capability: string,
  companyCodes: readonly string[],
  options: { derivedFrom?: string; allowPlantLimited?: boolean } = {},
): Promise<CompanyAuthorityVerdict> {
  const verdict = await verifyCompanyAuthorityInTx(tx, client, authorization, capability);
  if (!verdict.ok) return verdict;
  const refusal = await refuseCompaniesOutsideScopeInTx(tx, client, verdict, companyCodes, options);
  return refusal ? { ok: false, refusal } : verdict;
}

/**
 * The company codes a selector may offer: those inside the caller's current Company Code scope, when the caller
 * holds the capability. A refusal (no session, no capability, no scope) yields an empty list — never the tenant's
 * first company. Defence in depth only: the report service re-judges whatever is submitted.
 */
export async function authorizedCompanyCodes(
  client: string,
  authorization: ServiceAuthorityContext | undefined,
  capability: string | readonly string[],
): Promise<string[]> {
  const { withTenant } = await import('../db/client');
  return withTenant(client, async (tx) => {
    const verdict = await verifyCompanyAuthorityAnyInTx(tx, client, authorization, typeof capability === 'string' ? [capability] : capability);
    if (!verdict.ok) return [];
    const rows = (await tx.execute(sql`select company_code from company_code where client = ${client} order by company_code`)) as unknown as Array<{ company_code: string }>;
    return rows.map((r) => r.company_code).filter((c) => hasOrgAccess(verdict.restrictions, 'COMPANY_CODE', c));
  });
}

/** The first of several acceptable capabilities (e.g. a report's full and `.read` forms) the caller holds. */
export async function verifyCompanyAuthorityAnyInTx(
  tx: Tx,
  client: string,
  authorization: ServiceAuthorityContext | undefined,
  capabilities: readonly string[],
): Promise<CompanyAuthorityVerdict> {
  let first: CompanyAuthorityVerdict | null = null;
  for (const capability of capabilities) {
    const verdict = await verifyCompanyAuthorityInTx(tx, client, authorization, capability);
    if (verdict.ok) return verdict;
    first ??= verdict;
  }
  return first!;
}
