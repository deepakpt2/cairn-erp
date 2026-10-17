import { asc, eq } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { controllingArea, controllingAreaCompany, costCenter } from './schema';

/**
 * Cost centre definition — the read side (SCR-041 stage 1).
 *
 * A cost centre is where cost accounting collects overhead. In the
 * reference layout (the KS01 package) master data rests on validity rows
 * keyed (area, centre, valid-from) with a separate language-text table,
 * and deletion is refused while postings stand against the centre in the
 * window, a posting lock being the standing alternative.
 *
 * The owner's four forks (R-90) shape this product's version: **true
 * validity periods** (SAP parity — non-overlapping rows per centre, valid
 * to re-settable while it overlaps none); **delete-when-unused plus the
 * posting lock** (journal lines already carry centre codes as text, so the
 * deletion refusal counts journal documents dated inside the period);
 * **product category words** — the single letters live as search
 * aliases only; **hierarchy placement deferred to SCR-042**, so this
 * screen carries no hierarchy field. Two package elements settle without
 * a fork in this product's pattern: the currency displays from the
 * controlling area rather than being stored twice, and the name lives on
 * the row (no language-text table), as every master here does.
 *
 * Postings carry centre codes as text today and do not validate them
 * against these rows yet; this activity defines the master they will read.
 */
export const ACTIVITY = 'CFG.COST.COSTCENTER.DEFINE';

export interface CostCenterCategory {
  category: string;
  /** The reference single letter, for search and display only — never stored. */
  referenceAlias: string;
}

export const COST_CENTER_CATEGORIES: CostCenterCategory[] = [
  { category: 'PRODUCTION', referenceAlias: 'F' },
  { category: 'ADMINISTRATION', referenceAlias: 'V' },
  { category: 'SERVICE', referenceAlias: 'S' },
  { category: 'SALES', referenceAlias: 'V (sales)' },
  { category: 'SUPPORT', referenceAlias: 'H' },
];

export function isCostCenterCategory(value: string): boolean {
  return COST_CENTER_CATEGORIES.some((entry) => entry.category === value);
}

export interface CostCenterArea {
  controllingArea: string;
  name: string;
  currency: string;
}

export interface CostCenterRow {
  controllingArea: string;
  costCenter: string;
  validFrom: string;
  validTo: string;
  name: string;
  personResponsible: string | null;
  category: string;
  companyCode: string;
  isPostingLocked: boolean;
  currency: string;
}

export async function listCostCenterAreas(clientId: string): Promise<CostCenterArea[]> {
  return withTenant(clientId, async (tx) =>
    tx
      .select({
        controllingArea: controllingArea.controllingArea,
        name: controllingArea.name,
        currency: controllingArea.currency,
      })
      .from(controllingArea)
      .orderBy(asc(controllingArea.controllingArea)),
  );
}

export async function listCostCenters(clientId: string, area: string): Promise<CostCenterRow[]> {
  if (area === '') return [];
  return withTenant(clientId, async (tx) => {
    const rows = await tx
      .select({
        controllingArea: costCenter.controllingArea,
        costCenter: costCenter.costCenter,
        validFrom: costCenter.validFrom,
        validTo: costCenter.validTo,
        name: costCenter.name,
        personResponsible: costCenter.personResponsible,
        category: costCenter.category,
        companyCode: costCenter.companyCode,
        isPostingLocked: costCenter.isPostingLocked,
        currency: controllingArea.currency,
      })
      .from(costCenter)
      .innerJoin(
        controllingArea,
        eq(costCenter.controllingArea, controllingArea.controllingArea),
      )
      .where(eq(costCenter.controllingArea, area))
      .orderBy(asc(costCenter.costCenter), asc(costCenter.validFrom));
    return rows.map((row) => ({ ...row, currency: row.currency.trim() }));
  });
}

/** The company codes assigned to an area (SCR-025), the KS01 value help. */
export async function listAreaCompanyCodes(clientId: string, area: string): Promise<string[]> {
  if (area === '') return [];
  return withTenant(clientId, async (tx) => {
    const rows = await tx
      .select({ companyCode: controllingAreaCompany.companyCode })
      .from(controllingAreaCompany)
      .where(eq(controllingAreaCompany.controllingArea, area))
      .orderBy(asc(controllingAreaCompany.companyCode));
    return rows.map((row) => row.companyCode);
  });
}
