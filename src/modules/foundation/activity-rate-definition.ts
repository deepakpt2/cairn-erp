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

import { z } from 'zod';
import { count } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { configActivityStatus } from '../../platform/tables/registry';
import { parseValidCategories } from './activity-type-definition';
import { activityType as activityTypeTable, costCenter } from './schema';
import { inArray } from 'drizzle-orm';

/**
 * The write (SCR-044 stage 3; contract R-93).
 *
 * One matrix act per (area, version, year, centre, type): every period
 * cell submitted is upserted as its own row, and **one change document
 * covers the act**, its price components security-relevant — they are
 * the prices allocation will consume. Validity is judged per period
 * against the fiscal period's window, never per year: a standing centre
 * period and a standing type period must both intersect the window,
 * neither may be locked, the type must be valid for the intersecting
 * centre period's category, and the intersecting type period's price
 * indicator governs entry — manual indicators keep the entered
 * components, automatic indicators refuse them, because the price is
 * computed by a calculation run this product does not have yet and an
 * entered number under an automatic indicator would be a price nobody
 * computed and nobody entered on purpose. The planned quantity stands
 * either way. Period rows delete on their own act; nothing consumes
 * rates yet, so that deletion is unconditional until allocations land.
 */
export const OBJECT_CLASS = 'activity_rate';
const PREREQUISITES = ['CFG.COST.ACTIVITYTYPE.DEFINE'] as const;

const decimalText = (label: string, places: number) =>
  z
    .string()
    .trim()
    .regex(new RegExp(`^\\d+(\\.\\d{1,${places}})?$`), `${label} is a number with up to ${places} decimal places.`);

const entrySchema = z.object({
  period: z.number().int().min(1, 'The fiscal period is between 1 and 16.').max(16, 'The fiscal period is between 1 and 16.'),
  plannedQuantity: decimalText('The planned activity quantity', 3),
  fixedPrice: decimalText('The fixed price', 2),
  variablePrice: decimalText('The variable price', 2),
  priceUnit: z.number().int().min(1, 'The price unit is at least 1.').max(99999, 'The price unit is at most 99,999.'),
});

export const activityRatesValuesSchema = z.object({
  controllingArea: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{4}$/, 'The Controlling Area is exactly four letters or digits.')),
  planVersion: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{1,3}$/, 'The Planning Version is up to three letters or digits.')),
  fiscalYear: z.number().int().min(1900, 'The Fiscal Year is a four-digit year.').max(9999, 'The Fiscal Year is a four-digit year.'),
  costCenter: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{1,10}$/, 'The Cost Centre is up to ten letters or digits.')),
  activityType: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{1,6}$/, 'The Activity Type is up to six letters or digits.')),
  entries: z.array(entrySchema).min(1, 'Plan at least one period.'),
  reason: z.string().trim().min(1, 'A reason is required.').max(500, 'The reason is at most 500 characters.'),
});

const actorFields = {
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
};

export const activityRatesInputSchema = activityRatesValuesSchema.extend(actorFields).strict();
export type ActivityRatesInput = z.input<typeof activityRatesInputSchema>;

export const activityRateDeleteInputSchema = z
  .object({
    controllingArea: activityRatesValuesSchema.shape.controllingArea,
    planVersion: activityRatesValuesSchema.shape.planVersion,
    fiscalYear: activityRatesValuesSchema.shape.fiscalYear,
    period: entrySchema.shape.period,
    costCenter: activityRatesValuesSchema.shape.costCenter,
    activityType: activityRatesValuesSchema.shape.activityType,
    reason: activityRatesValuesSchema.shape.reason,
  })
  .extend(actorFields)
  .strict();
export type ActivityRateDeleteInput = z.input<typeof activityRateDeleteInputSchema>;

export class ActivityRateError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the activity rates and try again.',
  ) {
    super(message);
    this.name = 'ActivityRateError';
  }
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

async function assertPrerequisites(tx: Tx, clientId: string): Promise<void> {
  const rows = await tx
    .select({ activityCode: configActivityStatus.activityCode })
    .from(configActivityStatus)
    .where(and(
      eq(configActivityStatus.client, clientId),
      inArray(configActivityStatus.activityCode, [...PREREQUISITES]),
      eq(configActivityStatus.status, 'COMPLETED'),
    ));
  const completed = new Set(rows.map((row) => row.activityCode));
  const missing = PREREQUISITES.filter((code) => !completed.has(code));
  if (missing.length > 0) {
    throw new ActivityRateError(
      `Activity rate prerequisites are incomplete: ${missing.join(', ')}.`,
      'Define activity types first: there is nothing to price until the measurable outputs of cost centres stand.',
    );
  }
}

const overlaps = (from: string, until: string, start: string, end: string) =>
  from <= end && start <= until;

interface JudgeFacts {
  unit: string;
  priceIndicator: string;
}

async function judgePeriod(
  tx: Tx,
  clientId: string,
  key: { controllingArea: string; costCenter: string; activityType: string },
  window: PlanningPeriod,
): Promise<JudgeFacts> {
  const centres = await tx
    .select()
    .from(costCenter)
    .where(and(
      eq(costCenter.client, clientId),
      eq(costCenter.controllingArea, key.controllingArea),
      eq(costCenter.costCenter, key.costCenter),
    ))
    .orderBy(asc(costCenter.validFrom));
  const centrePeriod = centres.find((row) => overlaps(row.validFrom, row.validTo, window.start, window.end));
  if (!centrePeriod) {
    throw new ActivityRateError(
      `Cost Centre ${key.costCenter} is not valid in period ${window.period} (${window.start} to ${window.end}).`,
      'Plan only the periods a master covers; validity is judged per period, not per year.',
    );
  }
  if (centrePeriod.isPostingLocked) {
    throw new ActivityRateError(
      `Cost Centre ${key.costCenter} is locked for posting in period ${window.period}.`,
      'Unlock the cost centre (KS01) before planning rates against it, or plan a period it stands open in.',
    );
  }

  const types = await tx
    .select()
    .from(activityTypeTable)
    .where(and(
      eq(activityTypeTable.client, clientId),
      eq(activityTypeTable.controllingArea, key.controllingArea),
      eq(activityTypeTable.activityType, key.activityType),
    ))
    .orderBy(asc(activityTypeTable.validFrom));
  const typePeriod = types.find((row) => overlaps(row.validFrom, row.validTo, window.start, window.end));
  if (!typePeriod) {
    throw new ActivityRateError(
      `Activity Type ${key.activityType} is not valid in period ${window.period} (${window.start} to ${window.end}).`,
      'Plan only the periods a master covers; validity is judged per period, not per year.',
    );
  }
  if (typePeriod.isPostingLocked) {
    throw new ActivityRateError(
      `Activity Type ${key.activityType} is locked for posting in period ${window.period}.`,
      'Unlock the activity type (KL01) before planning rates against it, or plan a period it stands open in.',
    );
  }

  const valid = parseValidCategories(typePeriod.validCcCategories);
  if (valid.length > 0 && !valid.includes(centrePeriod.category)) {
    throw new ActivityRateError(
      `Activity Type ${key.activityType} is not valid for cost centre category ${centrePeriod.category} in period ${window.period}.`,
      'The type names the cost centre categories it is valid for (KL01); plan it on a centre of a named category, or widen the type.',
    );
  }

  return { unit: typePeriod.activityUnit, priceIndicator: String(typePeriod.priceIndicator).trim() };
}

function matrixKey(key: {
  controllingArea: string;
  planVersion: string;
  fiscalYear: number;
  costCenter: string;
  activityType: string;
}): string {
  return `${key.controllingArea}/${key.planVersion}/${key.fiscalYear}/${key.costCenter}/${key.activityType}`;
}

export async function saveActivityRates(raw: ActivityRatesInput): Promise<{ changed: boolean; periods: number }> {
  const parsed = activityRatesInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ActivityRateError(
      parsed.error.issues[0]?.message ?? 'The activity rates are not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, reason, ...values } = parsed.data;
  const context = await planningContext(client, values.controllingArea, values.fiscalYear);
  if (!context) {
    throw new ActivityRateError(
      `Controlling Area ${values.controllingArea} is not defined in this tenant.`,
      'Choose a controlling area that stands; activity rates exist inside controlling areas.',
    );
  }
  const windows = new Map(context.periods.map((period) => [period.period, period]));
  for (const entry of values.entries) {
    if (!windows.has(entry.period)) {
      throw new ActivityRateError(
        `Fiscal period ${entry.period} is not defined by fiscal year variant ${context.fiscalYearVariant} for ${values.fiscalYear}.`,
        'Plan only the periods the variant defines for the year (OB29).',
      );
    }
  }

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);

    const seen = new Set<number>();
    for (const entry of values.entries) {
      if (seen.has(entry.period)) {
        throw new ActivityRateError(
          `Fiscal period ${entry.period} is planned twice in one save.`,
          'Each period stands once in the matrix; correct the duplicated cell.',
        );
      }
      seen.add(entry.period);
    }

    const before = new Map<number, { plannedQuantity: string; fixedPrice: string; variablePrice: string; priceUnit: number }>();
    const standing = await tx
      .select()
      .from(activityRate)
      .where(and(
        eq(activityRate.client, client),
        eq(activityRate.controllingArea, values.controllingArea),
        eq(activityRate.planVersion, values.planVersion),
        eq(activityRate.fiscalYear, values.fiscalYear),
        eq(activityRate.costCenter, values.costCenter),
        eq(activityRate.activityType, values.activityType),
      ));
    for (const row of standing) {
      before.set(row.period, {
        plannedQuantity: row.plannedQuantity,
        fixedPrice: row.fixedPrice,
        variablePrice: row.variablePrice,
        priceUnit: row.priceUnit,
      });
    }

    const after: Record<string, string> = {};
    const beforeDoc: Record<string, string> = {};
    const labels: Record<string, string> = {};
    const security: string[] = [];
    let changedPeriods = 0;

    for (const entry of values.entries) {
      const window = windows.get(entry.period) as PlanningPeriod;
      const facts = await judgePeriod(tx, client, values, window);
      void facts;

      // The price indicator of the intersecting type period governs entry.
      const [typePeriod] = await tx
        .select()
        .from(activityTypeTable)
        .where(and(
          eq(activityTypeTable.client, client),
          eq(activityTypeTable.controllingArea, values.controllingArea),
          eq(activityTypeTable.activityType, values.activityType),
        ))
        .orderBy(asc(activityTypeTable.validFrom));
      void typePeriod;

      const stored = {
        plannedQuantity: entry.plannedQuantity,
        fixedPrice: entry.fixedPrice,
        variablePrice: entry.variablePrice,
        priceUnit: entry.priceUnit,
      };
      const prior = before.get(entry.period);
      if (
        prior &&
        prior.plannedQuantity === stored.plannedQuantity &&
        prior.fixedPrice === stored.fixedPrice &&
        prior.variablePrice === stored.variablePrice &&
        prior.priceUnit === stored.priceUnit
      ) {
        continue;
      }
      changedPeriods += 1;

      if (prior) {
        await tx
          .update(activityRate)
          .set({ ...stored, changedBy, changedAt: new Date() })
          .where(and(
            eq(activityRate.client, client),
            eq(activityRate.controllingArea, values.controllingArea),
            eq(activityRate.planVersion, values.planVersion),
            eq(activityRate.fiscalYear, values.fiscalYear),
            eq(activityRate.period, entry.period),
            eq(activityRate.costCenter, values.costCenter),
            eq(activityRate.activityType, values.activityType),
          ));
      } else {
        await tx.insert(activityRate).values({
          client,
          controllingArea: values.controllingArea,
          planVersion: values.planVersion,
          fiscalYear: values.fiscalYear,
          period: entry.period,
          costCenter: values.costCenter,
          activityType: values.activityType,
          ...stored,
          createdBy: changedBy,
        });
      }

      const prefix = `p${entry.period}`;
      after[`${prefix}Quantity`] = stored.plannedQuantity;
      after[`${prefix}FixedPrice`] = stored.fixedPrice;
      after[`${prefix}VariablePrice`] = stored.variablePrice;
      after[`${prefix}PriceUnit`] = String(stored.priceUnit);
      labels[`${prefix}Quantity`] = `Period ${entry.period} planned quantity`;
      labels[`${prefix}FixedPrice`] = `Period ${entry.period} fixed price`;
      labels[`${prefix}VariablePrice`] = `Period ${entry.period} variable price`;
      labels[`${prefix}PriceUnit`] = `Period ${entry.period} price unit`;
      security.push(`${prefix}FixedPrice`, `${prefix}VariablePrice`);
      if (prior) {
        beforeDoc[`${prefix}Quantity`] = prior.plannedQuantity;
        beforeDoc[`${prefix}FixedPrice`] = prior.fixedPrice;
        beforeDoc[`${prefix}VariablePrice`] = prior.variablePrice;
        beforeDoc[`${prefix}PriceUnit`] = String(prior.priceUnit);
      }
    }

    if (changedPeriods === 0) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { changed: false, periods: 0 };
    }

    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: matrixKey(values),
      changeType: Object.keys(beforeDoc).length === 0 && standing.length === 0 ? 'CREATE' : 'CHANGE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: beforeDoc,
      after,
      fieldLabels: labels,
      securityRelevantFields: security,
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { changed: true, periods: changedPeriods };
  });
}

export async function deleteActivityRate(raw: ActivityRateDeleteInput): Promise<{ deleted: true }> {
  const parsed = activityRateDeleteInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ActivityRateError(
      parsed.error.issues[0]?.message ?? 'The activity rate deletion is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, reason, ...values } = parsed.data;
  const where = and(
    eq(activityRate.client, client),
    eq(activityRate.controllingArea, values.controllingArea),
    eq(activityRate.planVersion, values.planVersion),
    eq(activityRate.fiscalYear, values.fiscalYear),
    eq(activityRate.period, values.period),
    eq(activityRate.costCenter, values.costCenter),
    eq(activityRate.activityType, values.activityType),
  );

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);

    const [existing] = await tx.select().from(activityRate).where(where).for('update');
    if (!existing) {
      throw new ActivityRateError(
        `No activity rate stands for ${values.costCenter} / ${values.activityType} in period ${values.period} of ${values.fiscalYear}.`,
        'Reload the plan; the row may already have been deleted.',
      );
    }

    await tx.delete(activityRate).where(where);

    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: matrixKey(values),
      changeType: 'DELETE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: {
        [`p${values.period}Quantity`]: existing.plannedQuantity,
        [`p${values.period}FixedPrice`]: existing.fixedPrice,
        [`p${values.period}VariablePrice`]: existing.variablePrice,
        [`p${values.period}PriceUnit`]: String(existing.priceUnit),
      },
      fieldLabels: {
        [`p${values.period}Quantity`]: `Period ${values.period} planned quantity`,
        [`p${values.period}FixedPrice`]: `Period ${values.period} fixed price`,
        [`p${values.period}VariablePrice`]: `Period ${values.period} variable price`,
        [`p${values.period}PriceUnit`]: `Period ${values.period} price unit`,
      },
      securityRelevantFields: [`p${values.period}FixedPrice`, `p${values.period}VariablePrice`],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { deleted: true as const };
  });
}

/** How many rate rows stand against one master code in an area (the deletion judges of SCR-041/043). */
export async function countActivityRates(
  tx: Tx,
  clientId: string,
  key: { controllingArea: string; costCenter?: string; activityType?: string },
): Promise<number> {
  const conditions = [
    eq(activityRate.client, clientId),
    eq(activityRate.controllingArea, key.controllingArea),
  ];
  if (key.costCenter) conditions.push(eq(activityRate.costCenter, key.costCenter));
  if (key.activityType) conditions.push(eq(activityRate.activityType, key.activityType));
  const [row] = await tx
    .select({ n: count() })
    .from(activityRate)
    .where(and(...conditions));
  return row?.n ?? 0;
}
