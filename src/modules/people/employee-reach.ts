/**
 * Which employees a caller may see or change: reach by company or by plant.
 *
 * The caller's reach is the Company Code and Plant scope rows an administrator granted (the same rows every
 * other module reads), so there is no second place to maintain it:
 *
 * - **Company level** (a senior HR officer): Company Code scope and no Plant scope (or Plant scope covering every
 *   plant of the company). Reaches every employee whose assignments sit in those companies, in any plant, and
 *   employees whose assignment names no plant.
 * - **Plant level** (an HR clerk of one plant): Company Code scope plus Plant scope(s) that leave some plant of
 *   the company uncovered. Reaches only employees whose assignment names one of those plants.
 *
 * An employee's company and plant come from their dated position assignments, never from anything the caller
 * typed. The assignment's company is its own, else its cost centre's, else its plant's. Fail closed:
 * - an assignment with no resolvable company is not reachable;
 * - for a plant-level caller, an assignment with no plant is not reachable;
 * - every assignment in the range has to be covered, so a person who works in two plants is reachable only to a
 *   caller who reaches both (or to a company-level caller).
 *
 * `null` restrictions is a trusted in-process caller (demo provisioner, service tests): no limit. A browser can
 * never obtain that form, because screens only build `{ authorization }`.
 */
import { sql } from 'drizzle-orm';

import type { OrgRestriction } from '../../platform/auth/session';
import { type ServiceAuthorityContext, verifyServiceAuthorityInTx } from '../../platform/auth/service-authority';
import type { Tx } from '../../platform/db/client';
import { isValidTimezone, localDate } from './leave-math';

export interface EmployeeAssignmentScope {
  company: string;
  plant: string | null;
  validFrom: string;
  validTo: string | null;
}

/** Plants of each company code, from the plant master. */
export type CompanyPlants = ReadonlyMap<string, readonly string[]>;

const plantCache = new WeakMap<object, CompanyPlants>();

/** The plant master, grouped by company. Memoised per `owner` (a grant), so a loop over employees asks once. */
export async function companyPlantsOf(tx: Tx, client: string, owner?: object): Promise<CompanyPlants> {
  const hit = owner ? plantCache.get(owner) : undefined;
  if (hit) return hit;
  const rows = (await tx.execute(sql`
    select company_code as company, plant from plant where client = ${client} and company_code is not null
  `)) as unknown as Array<{ company: string; plant: string }>;
  const map = new Map<string, string[]>();
  for (const r of rows) map.set(r.company, [...(map.get(r.company) ?? []), r.plant]);
  if (owner) plantCache.set(owner, map);
  return map;
}

/** Plant scopes the caller holds. Empty means the caller holds no Plant scope at all. */
export function plantScopes(restrictions: readonly OrgRestriction[]): string[] {
  return restrictions.filter((r) => r.scopeType === 'PLANT').map((r) => r.scopeValue);
}

/**
 * Is the caller limited to some plants of this company? Only when they hold Plant scope that leaves at least one
 * of the company's plants uncovered. A caller holding every plant of the company reaches it as a whole.
 */
function restrictedIn(plants: readonly string[], company: string, cp: CompanyPlants): boolean {
  if (plants.length === 0) return false;
  return (cp.get(company) ?? []).some((p) => !plants.includes(p));
}

/** Is the caller plant-level for any company they are scoped to (so cannot act for a whole company)? */
export function isPlantLevel(restrictions: readonly OrgRestriction[] | null, cp: CompanyPlants): boolean {
  if (restrictions === null) return false;
  const plants = plantScopes(restrictions);
  return restrictions.filter((r) => r.scopeType === 'COMPANY_CODE').some((r) => restrictedIn(plants, r.scopeValue, cp));
}

/** Does the scope cover one assignment? Company is always judged; plant only where the caller is plant-limited. */
export function scopeCoversAssignment(
  restrictions: readonly OrgRestriction[], a: { company: string; plant: string | null }, cp: CompanyPlants,
): boolean {
  if (!a.company) return false;
  const companies = restrictions.filter((r) => r.scopeType === 'COMPANY_CODE').map((r) => r.scopeValue);
  if (!companies.includes(a.company)) return false;
  const plants = plantScopes(restrictions);
  if (!restrictedIn(plants, a.company, cp)) return true;
  return a.plant !== null && a.plant !== '' && plants.includes(a.plant);
}

/**
 * Judge a set of assignments. With none, the employee is "unassigned": reachable only by a company-level caller
 * when `allowUnassigned` (the employee master, where a hire exists before the first assignment); never otherwise.
 */
export function scopeReaches(
  restrictions: readonly OrgRestriction[] | null,
  assignments: ReadonlyArray<{ company: string; plant: string | null }>,
  cp: CompanyPlants,
  allowUnassigned = false,
): boolean {
  if (restrictions === null) return true;
  if (assignments.length === 0) {
    return allowUnassigned && restrictions.some((r) => r.scopeType === 'COMPANY_CODE') && !isPlantLevel(restrictions, cp);
  }
  return assignments.every((a) => scopeCoversAssignment(restrictions, a, cp));
}

const COMPANY_OF = sql`coalesce(pa.company_code,
  (select cc.company_code from cost_center cc
     where cc.client = pa.client and cc.controlling_area = pa.controlling_area and cc.cost_center = pa.cost_center
       and cc.valid_from <= pa.valid_from and cc.valid_to >= pa.valid_from
     order by cc.valid_from desc limit 1),
  (select pl.company_code from plant pl where pl.client = pa.client and pl.plant = pa.plant), '')`;

/** Assignments of one employee that overlap [from, to], with company and plant resolved. */
export async function assignmentScopes(tx: Tx, client: string, personnelNumber: string, from: string, to: string): Promise<EmployeeAssignmentScope[]> {
  const rows = (await tx.execute(sql`
    select ${COMPANY_OF} as company, pa.plant as plant, pa.valid_from::text as "validFrom", pa.valid_to::text as "validTo"
      from position_assignment pa
     where pa.client = ${client} and pa.personnel_number = ${personnelNumber}
       and pa.valid_from <= ${to}::date and (pa.valid_to is null or pa.valid_to >= ${from}::date)
  `)) as unknown as EmployeeAssignmentScope[];
  return rows;
}

/** The tenant-local day. An invalid zone falls back to UTC here; leave accrual refuses it where it matters. */
export async function employeeToday(tx: Tx, client: string, at: Date = new Date()): Promise<string> {
  const rows = (await tx.execute(sql`select timezone from client where client = ${client}`)) as unknown as Array<{ timezone: string | null }>;
  const zone = rows[0]?.timezone ?? 'UTC';
  return localDate(at, isValidTimezone(zone) ? zone : 'UTC');
}

/**
 * The assignments that define where an employee is *now*: those in force today; failing that the most recent
 * ended ones (a leaver stays with the plant they left); failing that the earliest future ones.
 */
export function currentAssignments(rows: readonly EmployeeAssignmentScope[], today: string): EmployeeAssignmentScope[] {
  const inForce = rows.filter((r) => r.validFrom <= today && (r.validTo === null || r.validTo >= today));
  if (inForce.length > 0) return inForce;
  const ended = rows.filter((r) => r.validTo !== null && r.validTo < today);
  if (ended.length > 0) {
    const last = ended.reduce((m, r) => (r.validFrom > m ? r.validFrom : m), ended[0]!.validFrom);
    return ended.filter((r) => r.validFrom === last);
  }
  if (rows.length === 0) return [];
  const first = rows.reduce((m, r) => (r.validFrom < m ? r.validFrom : m), rows[0]!.validFrom);
  return rows.filter((r) => r.validFrom === first);
}

/** Current-assignment scopes for many employees at once (one query per 500 numbers). */
export async function currentScopesOf(tx: Tx, client: string, numbers: readonly string[], today: string): Promise<Map<string, EmployeeAssignmentScope[]>> {
  const grouped = new Map<string, EmployeeAssignmentScope[]>();
  for (let i = 0; i < numbers.length; i += 500) {
    const chunk = numbers.slice(i, i + 500);
    if (chunk.length === 0) continue;
    const rows = (await tx.execute(sql`
      select pa.personnel_number as pn, ${COMPANY_OF} as company, pa.plant as plant,
             pa.valid_from::text as "validFrom", pa.valid_to::text as "validTo"
        from position_assignment pa
       where pa.client = ${client} and pa.personnel_number in (${sql.join(chunk.map((n) => sql`${n}`), sql`, `)})
    `)) as unknown as Array<EmployeeAssignmentScope & { pn: string }>;
    for (const r of rows) {
      const list = grouped.get(r.pn) ?? [];
      list.push({ company: r.company, plant: r.plant, validFrom: r.validFrom, validTo: r.validTo });
      grouped.set(r.pn, list);
    }
  }
  for (const [pn, rows] of grouped) grouped.set(pn, currentAssignments(rows, today));
  return grouped;
}

/** A live caller judged for any one of `capabilities` (session, capability and scope re-read in `tx`). */
export async function judgeLiveScope(
  tx: Tx, client: string, authorization: ServiceAuthorityContext | undefined, capabilities: readonly string[],
): Promise<{ ok: true; username: string; restrictions: OrgRestriction[] } | { ok: false; message: string; remedy: string }> {
  let first: { message: string; remedy: string } | null = null;
  for (const capability of capabilities) {
    const verdict = await verifyServiceAuthorityInTx(tx, client, authorization, capability, { requirePlantScope: false });
    if (verdict.ok) return verdict;
    first ??= verdict.refusal;
  }
  return { ok: false, ...first! };
}
