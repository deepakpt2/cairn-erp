/**
 * Company-scope judgement shared by the services that read or change a document of one company.
 *
 * A service calls `purchasingActor` first, inside its own transaction, then `requireCompanyInScope` for the
 * company the document belongs to. The recorded actor is the verified session user, never a caller-supplied name.
 * A service that exposes a document answers a company outside the scope exactly as it answers a document that
 * does not exist: it passes that message as `hidden`.
 */
import { type AnyColumn, type SQL, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  type CompanyAuthority, refuseCompaniesOutsideScopeInTx, verifyCompanyAuthorityAnyInTx,
} from './company-scope';
import type { ServiceAuthorityContext } from './service-authority';
import { hasOrgAccess, type OrgRestriction } from './session';

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

/** True when one plant is reachable (see `reachablePlantsInTx`). */
export async function plantReachableInTx(tx: Tx, client: string, actor: CompanyAuthority, plant: string): Promise<boolean> {
  return (await reachablePlantsInTx(tx, client, actor)).includes(plant);
}

/**
 * A secondary organisational level (Sales Org, Distribution Channel, Division, Purchasing Org…): when the actor holds
 * any restriction of a level, the document's value for it must be one of them, and a document that names no value is
 * outside it. A level the actor holds no restriction for does not narrow the reach. Company Code stays the mandatory,
 * explicit gate: `purchasingActor` already refused an actor with none.
 */
export function orgLevelsAllow(
  actor: CompanyAuthority,
  levels: Partial<Record<OrgRestriction['scopeType'], string | null | undefined>>,
): boolean {
  for (const [type, value] of Object.entries(levels) as Array<[OrgRestriction['scopeType'], string | null | undefined]>) {
    const held = actor.restrictions.filter((r) => r.scopeType === type);
    if (held.length === 0) continue;
    const named = (value ?? '').trim();
    if (!named || !held.some((r) => r.scopeValue.trim() === named)) return false;
  }
  return true;
}

/** Every plant named is inside the actor's Plant scope (no Plant scope held: the Company Code gate decides). */
export function plantsAllow(actor: CompanyAuthority, plants: readonly string[]): boolean {
  const held = actor.restrictions.filter((r) => r.scopeType === 'PLANT');
  if (held.length === 0) return true;
  return plants.every((plant) => held.some((r) => r.scopeValue.trim() === plant.trim()));
}

/** Purchasing Org and Purchasing Group: each narrows only when the actor holds a restriction of that level. */
export function purchasingLevelsAllow(
  actor: CompanyAuthority, doc: { purchasingOrg?: string | null; purchasingGroup?: string | null },
): boolean {
  // `undefined` means the document has no such level (not judged); null or blank is a value outside any held level.
  const levels: Parameters<typeof orgLevelsAllow>[1] = {};
  if (doc.purchasingOrg !== undefined) levels.PURCHASING_ORG = doc.purchasingOrg;
  if (doc.purchasingGroup !== undefined) levels.PURCHASING_GROUP = doc.purchasingGroup;
  return orgLevelsAllow(actor, levels);
}

/** The same judgement as a SQL predicate over a document table's columns; `true` when the actor holds neither level. */
export function purchasingLevelsSql(
  actor: CompanyAuthority, columns: { purchasingOrg?: SQL | AnyColumn; purchasingGroup?: SQL | AnyColumn },
): SQL {
  const parts: SQL[] = [];
  for (const [type, column] of [['PURCHASING_ORG', columns.purchasingOrg], ['PURCHASING_GROUP', columns.purchasingGroup]] as const) {
    if (!column) continue;
    const held = actor.restrictions.filter((r) => r.scopeType === type).map((r) => r.scopeValue.trim());
    if (held.length === 0) continue;
    parts.push(sql`trim(${column}) in (${sql.join(held.map((v) => sql`${v}`), sql`, `)})`);
  }
  return parts.length ? sql`(${sql.join(parts, sql` and `)})` : sql`true`;
}

/** A document of one company, purchasing org and purchasing group: company scope and the held levels together. */
export async function purchasingDocumentInReach(
  tx: Tx, client: string, actor: CompanyAuthority,
  doc: { companyCode: string; purchasingOrg?: string | null; purchasingGroup?: string | null },
): Promise<boolean> {
  return (await companyInScope(tx, client, actor, doc.companyCode)) && purchasingLevelsAllow(actor, doc);
}

/**
 * A plant-carried document (an RFQ event, a quotation request, an info record…): it has no company column, so its
 * companies are those of the plants it names. Every plant must exist, belong to a company inside the actor's scope and
 * be inside a held Plant scope; the held Purchasing Org / Group levels must allow it. A document naming no plant
 * has no company and is never reachable.
 */
export async function plantDocumentInReach(
  tx: Tx, client: string, actor: CompanyAuthority,
  doc: { plants: readonly string[]; purchasingOrg?: string | null; purchasingGroup?: string | null },
): Promise<boolean> {
  const plants = [...new Set(doc.plants.map((p) => p.trim()).filter(Boolean))];
  if (plants.length === 0) return false;
  if (!plantsAllow(actor, plants) || !purchasingLevelsAllow(actor, doc)) return false;
  const rows = (await tx.execute(sql`
    select plant, coalesce(company_code, '') as company_code from plant where client = ${client}
  `)) as unknown as Array<{ plant: string; company_code: string }>;
  const known = new Map(rows.map((r) => [r.plant.trim(), r.company_code.trim()]));
  for (const plant of plants) {
    const company = known.get(plant);
    if (!company || !(await companyInScope(tx, client, actor, company))) return false;
  }
  return true;
}
