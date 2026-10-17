import { and, asc, eq } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { periodWindows } from '../../platform/periods/windows';
import { listActivityTypes, type ActivityTypeRow } from './activity-type-definition';
import { listCostCenterAreas, listCostCenters, type CostCenterArea, type CostCenterRow } from './cost-center-definition';
import { activityRate, controllingArea, fiscalYearPeriod } from './schema';

export { listActivityTypes, listCostCenterAreas, listCostCenters };
export type { ActivityTypeRow, CostCenterArea, CostCenterRow };

/**
 * Activity rate planning — the read side (SCR-044 stage 1).
 *
 * The prices of activity types are planned per cost centre, version,
 * fiscal year and fiscal period: the reference (KP26) plans a planned
 * quantity with a fixed and a variable price component per price unit,
 * judged against the masters' validity on the actual dates of each
 * planned period. The owner's four forks all took SAP parity (R-93):
 * versions as a free key of at most three characters with any number
 * standing side by side and no administration screen; fiscal periods
 * taken from the controlling area's fiscal year variant (OB29) —
 * regular periods windowed from their stored ends, special periods
 * sharing the last regular period's window as everywhere else here;
 * master validity judged per period against the period's window, never
 * per year; and prices governed by the activity type's price indicator
 * (manual entry stands, automatic leaves the price to a calculation
 * that does not exist yet and refuses entered components).
 *
 * This activity discharges two standing promises: rates give SCR-043's
 * deletion judge its count (an activity type period refuses deletion
 * while rates stand against it), and SCR-041's likewise. Nothing
 * calculates or allocates against these rows yet.
 */
export const ACTIVITY = 'CFG.COST.ACTIVITYRATE.CONFIRM';

export interface PlanningPeriod {
  period: number;
  periodType: 'REGULAR' | 'SPECIAL';
  /** ISO dates of the fiscal period window (specials share the last regular's). */
  start: string;
  end: string;
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface PlanningContext {
  controllingArea: string;
  name: string;
  currency: string;
  fiscalYearVariant: string;
  periods: PlanningPeriod[];
}

/**
 * The controlling area's planning context for one fiscal year: its
 * currency and variant, and the periods the variant defines for that
 * year with their windows. Year-dependent variants read the year's own
 * row set, falling back to the standing set — the period engine's rule.
 */
export async function planningContext(
  clientId: string,
  area: string,
  fiscalYear: number,
): Promise<PlanningContext | null> {
  if (area === '') return null;
  return withTenant(clientId, async (tx) => {
    const [head] = await tx
      .select()
      .from(controllingArea)
      .where(and(eq(controllingArea.client, clientId), eq(controllingArea.controllingArea, area)))
      .limit(1);
    if (!head) return null;

    const variant = head.fiscalYearVariant.trim();
    const rows = await tx
      .select()
      .from(fiscalYearPeriod)
      .where(and(eq(fiscalYearPeriod.client, clientId), eq(fiscalYearPeriod.variant, variant)))
      .orderBy(asc(fiscalYearPeriod.calendarYear), asc(fiscalYearPeriod.period));

    const yearRows = rows.filter((row) => row.calendarYear === fiscalYear);
    const standing = rows.filter((row) => row.calendarYear === 0);
    const chosen = yearRows.length > 0 ? yearRows : standing;
    const regular = chosen
      .filter((row) => row.periodType === 'REGULAR')
      .sort((a, b) => a.period - b.period);
    const specials = chosen
      .filter((row) => row.periodType === 'SPECIAL')
      .sort((a, b) => a.period - b.period);

    const windows = periodWindows(regular, fiscalYear);
    const periods: PlanningPeriod[] = windows.map((window) => ({
      period: window.period,
      periodType: 'REGULAR' as const,
      start: iso(window.start),
      end: iso(window.end),
    }));
    const last = periods[periods.length - 1];
    for (const special of specials) {
      if (!last) break;
      periods.push({
        period: special.period,
        periodType: 'SPECIAL',
        start: last.start,
        end: last.end,
      });
    }

    return {
      controllingArea: head.controllingArea,
      name: head.name,
      currency: head.currency.trim(),
      fiscalYearVariant: variant,
      periods,
    };
  });
}

export interface ActivityRateRow {
  controllingArea: string;
  planVersion: string;
  fiscalYear: number;
  period: number;
  costCenter: string;
  activityType: string;
  plannedQuantity: string;
  fixedPrice: string;
  variablePrice: string;
  priceUnit: number;
}

export async function listActivityRates(
  clientId: string,
  filter: {
    controllingArea: string;
    planVersion: string;
    fiscalYear: number;
    costCenter?: string;
    activityType?: string;
  },
): Promise<ActivityRateRow[]> {
  if (filter.controllingArea === '' || filter.planVersion === '') return [];
  return withTenant(clientId, async (tx) => {
    const conditions = [
      eq(activityRate.controllingArea, filter.controllingArea),
      eq(activityRate.planVersion, filter.planVersion),
      eq(activityRate.fiscalYear, filter.fiscalYear),
    ];
    if (filter.costCenter) conditions.push(eq(activityRate.costCenter, filter.costCenter));
    if (filter.activityType) conditions.push(eq(activityRate.activityType, filter.activityType));
    return tx
      .select({
        controllingArea: activityRate.controllingArea,
        planVersion: activityRate.planVersion,
        fiscalYear: activityRate.fiscalYear,
        period: activityRate.period,
        costCenter: activityRate.costCenter,
        activityType: activityRate.activityType,
        plannedQuantity: activityRate.plannedQuantity,
        fixedPrice: activityRate.fixedPrice,
        variablePrice: activityRate.variablePrice,
        priceUnit: activityRate.priceUnit,
      })
      .from(activityRate)
      .where(and(...conditions))
      .orderBy(asc(activityRate.costCenter), asc(activityRate.activityType), asc(activityRate.period));
  });
}

/** Distinct cost centre codes standing in an area (any period). */
export function distinctCenters(rows: CostCenterRow[]): string[] {
  return [...new Set(rows.map((row) => row.costCenter))].sort();
}

/** Distinct activity type codes standing in an area (any period). */
export function distinctTypes(rows: ActivityTypeRow[]): string[] {
  return [...new Set(rows.map((row) => row.activityType))].sort();
}
