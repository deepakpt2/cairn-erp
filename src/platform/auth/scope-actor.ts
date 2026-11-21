/**
 * Company-scope judgement shared by the services that read or change a document of one company.
 *
 * A service calls `purchasingActor` first, inside its own transaction, then `requireCompanyInScope` for the
 * company the document belongs to. The recorded actor is the verified session user, never a caller-supplied name.
 * A service that exposes a document answers a company outside the scope exactly as it answers a document that
 * does not exist: it passes that message as `hidden`.
 */
import type { Tx } from '../db/client';
import {
  type CompanyAuthority, refuseCompaniesOutsideScopeInTx, verifyCompanyAuthorityAnyInTx,
} from './company-scope';
import type { ServiceAuthorityContext } from './service-authority';

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
