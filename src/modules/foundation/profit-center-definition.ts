import { asc, eq } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { appUser } from '../../platform/tables/security';
import { listCostCenterAreas, type CostCenterArea } from './cost-center-definition';
import { profitCenter } from './schema';

export { listCostCenterAreas };
export type { CostCenterArea };

/**
 * Profit centre definition — the read side (SCR-045 stage 1).
 *
 * A profit centre is the unit profitability is reported on, defined as
 * validity periods inside a controlling area. The owner's package
 * (KE51) keys the master (area, centre, valid-to) with texts in a
 * separate language table, a mandatory hierarchy area naming a node of
 * the standard profit centre hierarchy, an optional segment, and
 * deletion guarded by postings and dependent objects.
 *
 * The forks (R-94) shape this product's version: SAP parity on the
 * names — the short name (at most 20) required, the long text (at most
 * 40) optional, both on the row as every master here keeps its name —
 * and on the lifecycle (hard delete refused while journal documents
 * dated inside the period carry the centre, plus the posting lock);
 * the segment kept at parity width, entered freely until a segment
 * master stands; and the **hierarchy deferred exactly as KS01's was** —
 * no hierarchy field is carried or judged here, the profit centre
 * hierarchy is its own following SCR, and this screen gains its
 * read-only placement afterward as the cost centre screen did.
 *
 * Journal lines already carry a profit centre code as text, so the
 * deletion judge has something real to count from the first day.
 */
export const ACTIVITY = 'CFG.COST.PROFITCENTER.DEFINE';

export interface ProfitCenterRow {
  controllingArea: string;
  profitCenter: string;
  validFrom: string;
  validTo: string;
  name: string;
  longText: string | null;
  personResponsible: string;
  responsibleUser: string | null;
  segment: string | null;
  isPostingLocked: boolean;
}

export async function listProfitCenters(
  clientId: string,
  area: string,
): Promise<ProfitCenterRow[]> {
  if (area === '') return [];
  return withTenant(clientId, async (tx) =>
    tx
      .select({
        controllingArea: profitCenter.controllingArea,
        profitCenter: profitCenter.profitCenter,
        validFrom: profitCenter.validFrom,
        validTo: profitCenter.validTo,
        name: profitCenter.name,
        longText: profitCenter.longText,
        personResponsible: profitCenter.personResponsible,
        responsibleUser: profitCenter.responsibleUser,
        segment: profitCenter.segment,
        isPostingLocked: profitCenter.isPostingLocked,
      })
      .from(profitCenter)
      .where(eq(profitCenter.controllingArea, area))
      .orderBy(asc(profitCenter.profitCenter), asc(profitCenter.validFrom)),
  );
}

export interface ResponsibleUserChoice {
  username: string;
  fullName: string;
}

/** The tenant's active users, for the responsible-user value help. */
export async function listResponsibleUsers(clientId: string): Promise<ResponsibleUserChoice[]> {
  return withTenant(clientId, async (tx) => {
    const rows = await tx
      .select({ username: appUser.username, fullName: appUser.fullName })
      .from(appUser)
      .where(eq(appUser.isActive, true))
      .orderBy(asc(appUser.username));
    return rows.map((row) => ({ username: row.username.trim(), fullName: row.fullName }));
  });
}
