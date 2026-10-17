import { asc, eq } from 'drizzle-orm';

import { db } from '../../platform/db/client';
import { withTenant } from '../../platform/db/client';
import { unitOfMeasure } from '../../platform/tables/reference';
import { listCostCenterAreas, type CostCenterArea } from './cost-center-definition';
import { COST_CENTER_CATEGORIES } from './cost-center-definition';
import { activityType } from './schema';

export { listCostCenterAreas };
export type { CostCenterArea };
export { COST_CENTER_CATEGORIES };

/**
 * Activity type definition — the read side (SCR-043 stage 1).
 *
 * An activity type is the measurable output a cost centre performs —
 * labour hours, machine runs, setups — priced later per period (SCR-044)
 * and charged to whoever consumed it. The owner's package (KL01) keys
 * the master (area, type, valid-from) on validity rows with a separate
 * language-text table, two single-digit behaviour fields, and deletion
 * refused while planning or allocations stand.
 *
 * The four forks (R-92) shape this product's version: **SAP parity** on
 * the vocabularies (category 1–4 and price indicator 1–3 stored as the
 * reference's digits, their meanings displayed as words beside them);
 * **SAP parity** on the unit (any unit standing in the global
 * unit_of_measure table, judged on existence); **SAP parity** on
 * applicability (the type may name the KS01 cost-centre categories it is
 * valid for — canonical subset, blank meaning all); and the **KS01
 * lifecycle** (delete plus an independent posting lock). Validity is the
 * KS01 period shape — non-overlapping rows, valid to re-settable while
 * it overlaps none — and the name lives on the row.
 *
 * Nothing prices or allocates against these rows yet; this activity
 * defines the master SCR-044 will read.
 */
export const ACTIVITY = 'CFG.COST.ACTIVITYTYPE.DEFINE';

export interface ActivityCategoryOption {
  code: string;
  label: string;
}

export const ACTIVITY_CATEGORIES: ActivityCategoryOption[] = [
  { code: '1', label: 'Manual entry, manual allocation' },
  { code: '2', label: 'Indirect determination, indirect allocation' },
  { code: '3', label: 'Manual entry, indirect allocation' },
  { code: '4', label: 'Manual entry, no allocation' },
];

export const PRICE_INDICATORS: ActivityCategoryOption[] = [
  { code: '1', label: 'Automatic (based on activity)' },
  { code: '2', label: 'Automatic (based on capacity)' },
  { code: '3', label: 'Manual entry' },
];

export function activityCategoryLabel(code: string): string {
  return ACTIVITY_CATEGORIES.find((entry) => entry.code === code)?.label ?? code;
}

export function priceIndicatorLabel(code: string): string {
  return PRICE_INDICATORS.find((entry) => entry.code === code)?.label ?? code;
}

/** Split the stored canonical subset ('' = every category). */
export function parseValidCategories(stored: string): string[] {
  return stored === '' ? [] : stored.split(',').filter(Boolean);
}

/** Join chosen categories in the canonical KS01 catalogue order ('' = every category). */
export function canonicalValidCategories(chosen: string[]): string {
  const wanted = new Set(chosen);
  return COST_CENTER_CATEGORIES.map((entry) => entry.category)
    .filter((category) => wanted.has(category))
    .join(',');
}

export interface ActivityTypeRow {
  controllingArea: string;
  activityType: string;
  validFrom: string;
  validTo: string;
  name: string;
  activityUnit: string;
  category: string;
  priceIndicator: string;
  /** '' = valid for every cost centre category. */
  validCcCategories: string;
  isPostingLocked: boolean;
}

export interface ActivityUnitChoice {
  code: string;
  name: string;
  dimension: string;
}

export async function listActivityTypes(
  clientId: string,
  area: string,
): Promise<ActivityTypeRow[]> {
  if (area === '') return [];
  return withTenant(clientId, async (tx) =>
    tx
      .select({
        controllingArea: activityType.controllingArea,
        activityType: activityType.activityType,
        validFrom: activityType.validFrom,
        validTo: activityType.validTo,
        name: activityType.name,
        activityUnit: activityType.activityUnit,
        category: activityType.category,
        priceIndicator: activityType.priceIndicator,
        validCcCategories: activityType.validCcCategories,
        isPostingLocked: activityType.isPostingLocked,
      })
      .from(activityType)
      .where(eq(activityType.controllingArea, area))
      .orderBy(asc(activityType.activityType), asc(activityType.validFrom)),
  );
}

/** Every unit standing in the global unit of measure table, by dimension then code. */
export async function listActivityUnits(): Promise<ActivityUnitChoice[]> {
  const rows = await db()
    .select({
      code: unitOfMeasure.code,
      name: unitOfMeasure.name,
      dimension: unitOfMeasure.dimension,
    })
    .from(unitOfMeasure)
    .orderBy(asc(unitOfMeasure.dimension), asc(unitOfMeasure.code));
  return rows.map((row) => ({ ...row, code: row.code.trim(), dimension: row.dimension.trim() }));
}
