/**
 * Company-scope judgement shared by the services that read or change a document of one company.
 *
 * A service calls `purchasingActor` first, inside its own transaction, then `requireCompanyInScope` for the
 * company the document belongs to. The recorded actor is the verified session user, never a caller-supplied name.
 * A service that exposes a document answers a company outside the scope exactly as it answers a document that
 * does not exist: it passes that message as `hidden`.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  type CompanyAuthority, refuseCompaniesOutsideScopeInTx, verifyCompanyAuthorityAnyInTx,
} from './company-scope';
import type { ServiceAuthorityContext } from './service-authority';
import { hasOrgAccess } from './session';

export type ScopeFailure = (message: string, remedy?: string) => Error;

/** Session, live capability (any of those named) and an explicit Company Code scope. Judges no company yet. */
export async function purchasingActor(
  tx: Tx, client: string, authorization: ServiceAuthorityContext | undefined,
  capabilities: readonly string[], failure: ScopeFailure,
): Promise<CompanyAuthority> {
  const verdict = await verifyCompanyAuthorityAnyInTx(tx, client, authorization, capabilities);
  if (!verdict.ok) throw failure(verdict.refusal.message, verdict.refusal.remedy);
  return verdict;
}

/** True when the company is inside the actor's Company Code scope (a plant limit does not matter for one document). */
export async function companyInScope(
  tx: Tx, client: string, actor: CompanyAuthority, company: string, allowPlantLimited = true,
): Promise<boolean> {
  return (await refuseCompaniesOutsideScopeInTx(tx, client, actor, [company], { allowPlantLimited })) === null;
}

/** Refuse when the company is outside the scope; `hidden` replaces the refusal so existence is not disclosed. */
export async function requireCompanyInScope(
  tx: Tx, client: string, actor: CompanyAuthority, company: string, failure: ScopeFailure,
  options: { hidden?: string; allowPlantLimited?: boolean } = {},
): Promise<void> {
  const refusal = await refuseCompaniesOutsideScopeInTx(tx, client, actor, [company], {
    allowPlantLimited: options.allowPlantLimited ?? true,
  });
  if (refusal) throw failure(options.hidden ?? refusal.message, options.hidden ? undefined : refusal.remedy);
}

/**
 * The plants the actor may reach: the plant's company is inside the explicit Company Code scope and, when the actor
 * holds a Plant scope, the plant is named in it. A plant that names no company belongs to no company's scope, so it
 * is never reachable. The tenant's plant list is small; callers filter rows with `plant = any(...)`.
 */
export async function reachablePlantsInTx(tx: Tx, client: string, actor: CompanyAuthority): Promise<string[]> {
  const rows = (await tx.execute(sql`
    select plant, coalesce(company_code, '') as company_code from plant where client = ${client}
  `)) as unknown as Array<{ plant: string; company_code: string }>;
  const plantScopes = actor.restrictions.filter((r) => r.scopeType === 'PLANT');
  const out: string[] = [];
  for (const row of rows) {
    const company = row.company_code.trim();
    if (!company || !hasOrgAccess(actor.restrictions, 'COMPANY_CODE', company)) continue;
    if (plantScopes.length > 0 && !hasOrgAccess(plantScopes, 'PLANT', row.plant.trim())) continue;
    out.push(row.plant);
  }
  return out;
}

/** `and <column> in (reachable plants)`; with none reachable, `and false`. `column` is a trusted literal. */
export function plantReachFilter(column: string, reachable: readonly string[]) {
  return reachable.length > 0
    ? sql`and ${sql.raw(column)} in (${sql.join(reachable.map((p) => sql`${p}`), sql`, `)})`
    : sql`and false`;
}
