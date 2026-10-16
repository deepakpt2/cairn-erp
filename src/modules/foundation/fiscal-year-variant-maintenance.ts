/**
 * SCR-029 / OB29 — the Fiscal Year Variant registry and its periods.
 *
 * This is the read side. It exists before the writes because the screen has to render the
 * registry to be worth looking at, and because one question — where does a period start? —
 * must have a single answer: the posting engine derives it from the stored ends, so the
 * screen asks the engine rather than computing its own version of the rule.
 *
 * A period row stores only its end, its type and its year shift. The start shown here is
 * derived the same way `derivePosition` derives it: the day after the previous period ends,
 * and for period 1 the day after the last period of the fiscal year before it. Displaying it
 * matters because it is the half of the definition nobody stored, and a consultant reading
 * only the ends cannot see whether the year is covered.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { buildPeriodRows, periodWindows } from '../../platform/periods';
import { controllingArea, companyCode, fiscalYearPeriod, fiscalYearVariant } from './schema';

const ACTIVITY = 'CFG.FIN.FYV.DEFINE';
const OBJECT_CLASS = 'fiscal_year_variant';
const PERIOD_OBJECT_CLASS = 'fiscal_year_period';
/** How many referencing keys a refusal names before falling back to a count. */
const NAMED_LIMIT = 5;

const clientSchema = z.string().trim().regex(/^[A-Za-z0-9]{2,4}$/);
const variantCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{2}$/, 'The Fiscal Year Variant is exactly two letters or digits.'));
const descriptionSchema = z
  .string()
  .trim()
  .min(1, 'A description is required.')
  .max(30, 'The description is at most thirty characters.');
const regularPeriodsSchema = z.coerce
  .number()
  .int('Posting periods must be a whole number.')
  .min(1, 'A fiscal year has at least one posting period.')
  .max(16, 'A fiscal year has at most sixteen posting periods.');
const specialPeriodsSchema = z.coerce
  .number()
  .int('Special periods must be a whole number.')
  .min(0, 'Special periods cannot be negative.')
  .max(4, 'A fiscal year has at most four special periods.');
const reasonSchema = z
  .string()
  .trim()
  .min(1, 'A reason is required.')
  .max(500, 'The reason is at most 500 characters.');

export class FiscalYearVariantError extends Error {
  readonly code = 'CAIRN_CONFIG';
  constructor(
    message: string,
    readonly remedy = 'Review the Fiscal Year Variant definition and try again.',
  ) {
    super(message);
    this.name = 'FiscalYearVariantError';
  }
}

function invalid(error: z.ZodError): never {
  const issue = error.issues[0];
  throw new FiscalYearVariantError(
    issue?.message ?? 'The Fiscal Year Variant definition is not valid.',
    'Correct the field and try again.',
  );
}

function nameSome(values: readonly string[], label: string): string {
  const named = values.slice(0, NAMED_LIMIT).join(', ');
  const rest = values.length - NAMED_LIMIT;
  return rest > 0 ? `${named} and ${rest} more ${label}` : named;
}

export interface FiscalYearPeriodRow {
  /** Calendar year the row belongs to; 0 means it holds for every year. */
  calendarYear: number;
  period: number;
  periodType: 'REGULAR' | 'SPECIAL';
  /** Month and day the period ends; day 31 means the last day of the month. */
  month: number;
  day: number;
  yearShift: number;
  /** Derived, not stored: ISO dates for the year this row set is read against. */
  derivedStart: string | null;
  derivedEnd: string | null;
}

export interface FiscalYearVariantRow {
  variant: string;
  name: string;
  isCalendarYear: boolean;
  regularPeriods: number;
  specialPeriods: number;
  isYearDependent: boolean;
  isActive: boolean;
  version: number;
  /** Calendar years maintained for a year-dependent variant; 0 for every other variant. */
  years: number[];
  periods: FiscalYearPeriodRow[];
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Every variant in the tenant with its period rows, ordered by key.
 *
 * Periods are read for the years that are actually maintained: a year-dependent variant may
 * hold several row sets, and a screen that showed only the first would hide the years a
 * consultant maintains by hand.
 */
export async function listFiscalYearVariants(client: string): Promise<FiscalYearVariantRow[]> {
  const parsed = clientSchema.safeParse(client);
  if (!parsed.success) {
    throw new Error('The tenant key is not valid.');
  }
  const tenant = parsed.data;

  return withTenant(tenant, async (tx) => {
    const [variants, periods] = await Promise.all([
      tx.select().from(fiscalYearVariant)
        .where(eq(fiscalYearVariant.client, tenant))
        .orderBy(asc(fiscalYearVariant.variant)),
      tx.select().from(fiscalYearPeriod)
        .where(eq(fiscalYearPeriod.client, tenant))
        .orderBy(
          asc(fiscalYearPeriod.variant),
          asc(fiscalYearPeriod.calendarYear),
          asc(fiscalYearPeriod.period),
        ),
    ]);

    const thisYear = new Date().getUTCFullYear();

    return variants.map((variant) => {
      const rows = periods.filter((row) => row.variant === variant.variant);
      const years = [...new Set(rows.map((row) => row.calendarYear))].sort((a, b) => a - b);

      // The derived start depends on the year the row set is read against, so each year is
      // windowed on its own. Year 0 rows are read against the current year: they hold for
      // every year, and a date is more useful on a screen than a rule.
      const enriched = rows.map((row) => {
        const year = row.calendarYear === 0 ? thisYear : row.calendarYear;
        const regular = rows
          .filter((entry) => entry.calendarYear === row.calendarYear && entry.periodType === 'REGULAR')
          .sort((a, b) => a.period - b.period);
        const window = periodWindows(regular, year).find((entry) => entry.period === row.period);
        return {
          calendarYear: row.calendarYear,
          period: row.period,
          periodType: row.periodType as 'REGULAR' | 'SPECIAL',
          month: row.month,
          day: row.day,
          yearShift: row.yearShift,
          // Special periods share the last ordinary period's window and are not derived here:
          // they are not a date range postings fall into, they are a place adjustments go.
          derivedStart: row.periodType === 'REGULAR' && window ? iso(window.start) : null,
          derivedEnd: row.periodType === 'REGULAR' && window ? iso(window.end) : null,
        };
      });

      return {
        variant: variant.variant,
        name: variant.name,
        isCalendarYear: variant.isCalendarYear,
        regularPeriods: variant.regularPeriods,
        specialPeriods: variant.specialPeriods,
        isYearDependent: variant.isYearDependent,
        isActive: variant.isActive,
        version: variant.version,
        years,
        periods: enriched,
      };
    });
  });
}

/** The variants a Company Code or Controlling Area may be assigned: active ones only. */
export async function fiscalYearVariantChoices(client: string) {
  const variants = await listFiscalYearVariants(client);
  return variants
    .filter((variant) => variant.isActive)
    .map((variant) => ({ code: variant.variant, name: variant.name }));
}

/* ── Writes ─────────────────────────────────────────────────────────────────── */

const variantInputSchema = z.object({
  client: clientSchema,
  changedBy: z.string().trim().min(1),
  mode: z.enum(['CREATE', 'CHANGE']),
  expectedVersion: z.number().int().nonnegative(),
  variant: variantCodeSchema,
  name: descriptionSchema,
  isCalendarYear: z.boolean(),
  regularPeriods: regularPeriodsSchema,
  specialPeriods: specialPeriodsSchema,
  isYearDependent: z.boolean(),
  reason: reasonSchema,
}).strict();

export type FiscalYearVariantMaintenanceInput = z.input<typeof variantInputSchema>;

const lifecycleInputSchema = z.object({
  client: clientSchema,
  changedBy: z.string().trim().min(1),
  variant: variantCodeSchema,
  isActive: z.boolean(),
  expectedVersion: z.number().int().nonnegative(),
  reason: reasonSchema,
}).strict();

export type FiscalYearVariantLifecycleInput = z.input<typeof lifecycleInputSchema>;

const periodRowSchema = z.object({
  period: z.coerce.number().int().min(1).max(20),
  month: z.coerce.number().int().min(1, 'A period ends in a month from 1 to 12.').max(12, 'A period ends in a month from 1 to 12.'),
  day: z.coerce.number().int().min(1, 'A period ends on a day from 1 to 31, where 31 means the last day of the month.').max(31, 'A period ends on a day from 1 to 31, where 31 means the last day of the month.'),
  yearShift: z.coerce.number().int().min(-1, 'The year shift is -1, 0 or 1.').max(1, 'The year shift is -1, 0 or 1.'),
}).strict();

const periodsInputSchema = z.object({
  client: clientSchema,
  changedBy: z.string().trim().min(1),
  variant: variantCodeSchema,
  /** 0 for a variant whose periods hold for every year; the calendar year otherwise. */
  calendarYear: z.coerce.number().int().min(0).max(9999).default(0),
  periods: z.array(periodRowSchema).min(1, 'At least one period is required.').max(20, 'A fiscal year has at most twenty periods.'),
  expectedVersion: z.number().int().nonnegative(),
  reason: reasonSchema,
}).strict();

export type FiscalYearPeriodMaintenanceInput = z.input<typeof periodsInputSchema>;

const FIELD_LABELS: Record<string, string> = {
  variant: 'Fiscal Year Variant',
  name: 'Description',
  isCalendarYear: 'Calendar year',
  regularPeriods: 'Posting periods',
  specialPeriods: 'Special periods',
  isYearDependent: 'Year dependent',
  isActive: 'Active',
  periodCount: 'Periods maintained',
  periodEnds: 'Period ends',
};

/**
 * Define or change a Fiscal Year Variant.
 *
 * A calendar-year variant carries no period list of its own: its periods are derived from the
 * two counts, so changing a count rewrites the derived rows in the same transaction and the
 * variant can never disagree with the list the posting engine reads. Any other variant's
 * periods are maintained by hand, which is why changing a count there is refused until the
 * maintained lists match — a variant asking for thirteen periods over a list of twelve would
 * otherwise leave a hole that surfaces months later as "no period found for 15 March".
 */
export async function saveFiscalYearVariant(raw: FiscalYearVariantMaintenanceInput) {
  const parsed = variantInputSchema.safeParse(raw);
  if (!parsed.success) invalid(parsed.error);
  const {
    client, changedBy, mode, expectedVersion, variant, name,
    isCalendarYear, regularPeriods, specialPeriods, isYearDependent, reason,
  } = parsed.data;

  return withTenant(client, async (tx) => {
    const existing = await tx
      .select()
      .from(fiscalYearVariant)
      .where(and(eq(fiscalYearVariant.client, client), eq(fiscalYearVariant.variant, variant)))
      .for('update');

    if (mode === 'CREATE') {
      if (existing.length > 0) {
        throw new FiscalYearVariantError(
          `Fiscal Year Variant ${variant} is already defined.`,
          'Choose another key, or change the existing variant.',
        );
      }

      await tx.insert(fiscalYearVariant).values({
        client,
        variant,
        name,
        isCalendarYear,
        regularPeriods,
        specialPeriods,
        isYearDependent,
        isActive: true,
        version: 1,
        createdBy: changedBy,
        changedBy,
        changedAt: new Date(),
      });
      const periodsWritten = isCalendarYear
        ? await writeDerivedPeriods(tx, client, variant, regularPeriods, specialPeriods, changedBy)
        : 0;

      await recordVariantChange(tx, {
        client, changedBy, variant, reason, changeType: 'CREATE',
        after: { variant, name, isCalendarYear, regularPeriods, specialPeriods, isYearDependent, isActive: true },
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { variant, mode: 'CREATED' as const, version: 1, periodsWritten };
    }

    const before = existing[0];
    if (!before) {
      throw new FiscalYearVariantError(
        `Fiscal Year Variant ${variant} does not exist in this tenant.`,
        'Create the variant first.',
      );
    }
    if (before.version !== expectedVersion) {
      throw new FiscalYearVariantError(
        `Fiscal Year Variant ${variant} changed after it was opened.`,
        'Reload the registry before changing it.',
      );
    }
    if (!before.isActive) {
      throw new FiscalYearVariantError(
        `Fiscal Year Variant ${variant} is deactivated.`,
        'Reactivate the variant before changing it.',
      );
    }

    const unchanged =
      before.name === name &&
      before.isCalendarYear === isCalendarYear &&
      before.regularPeriods === regularPeriods &&
      before.specialPeriods === specialPeriods &&
      before.isYearDependent === isYearDependent;
    if (unchanged) {
      return { variant, mode: 'UNCHANGED' as const, version: before.version, periodsWritten: 0 };
    }

    let periodsWritten = 0;
    if (isCalendarYear) {
      // Derived from the counts, so the list follows the definition rather than the other
      // way round. Turning the flag on replaces a hand-maintained list with the derived one.
      periodsWritten = await writeDerivedPeriods(tx, client, variant, regularPeriods, specialPeriods, changedBy);
    } else {
      await checkMaintainedPeriodsStillFit(tx, client, variant, regularPeriods, specialPeriods);
    }

    if (before.isYearDependent && !isYearDependent) {
      // Per-year lists are meaningless once the variant holds for every year, and leaving
      // them behind would let a reader find a list the engine no longer consults.
      await tx
        .delete(fiscalYearPeriod)
        .where(and(
          eq(fiscalYearPeriod.client, client),
          eq(fiscalYearPeriod.variant, variant),
          sql`${fiscalYearPeriod.calendarYear} <> 0`,
        ));
    }

    const version = before.version + 1;
    await tx
      .update(fiscalYearVariant)
      .set({ name, isCalendarYear, regularPeriods, specialPeriods, isYearDependent, version, changedBy, changedAt: new Date() })
      .where(and(eq(fiscalYearVariant.client, client), eq(fiscalYearVariant.variant, variant)));

    await recordVariantChange(tx, {
      client, changedBy, variant, reason, changeType: 'CHANGE',
      before: {
        variant: before.variant, name: before.name, isCalendarYear: before.isCalendarYear,
        regularPeriods: before.regularPeriods, specialPeriods: before.specialPeriods,
        isYearDependent: before.isYearDependent, isActive: before.isActive,
      },
      after: { variant, name, isCalendarYear, regularPeriods, specialPeriods, isYearDependent, isActive: before.isActive },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { variant, mode: 'CHANGED' as const, version, periodsWritten };
  });
}

/**
 * Deactivate or reactivate a variant. There is no delete: a variant a Company Code or a
 * Controlling Area points at is part of how those books are read, so it is retired rather than
 * removed, and retirement is refused while anything still points at it.
 */
export async function setFiscalYearVariantActive(raw: FiscalYearVariantLifecycleInput) {
  const parsed = lifecycleInputSchema.safeParse(raw);
  if (!parsed.success) invalid(parsed.error);
  const { client, changedBy, variant, isActive, expectedVersion, reason } = parsed.data;

  return withTenant(client, async (tx) => {
    const rows = await tx
      .select()
      .from(fiscalYearVariant)
      .where(and(eq(fiscalYearVariant.client, client), eq(fiscalYearVariant.variant, variant)))
      .for('update');
    const before = rows[0];
    if (!before) {
      throw new FiscalYearVariantError(
        `Fiscal Year Variant ${variant} does not exist in this tenant.`,
        'Create the variant first.',
      );
    }
    if (before.version !== expectedVersion) {
      throw new FiscalYearVariantError(
        `Fiscal Year Variant ${variant} changed after it was opened.`,
        'Reload the registry before changing its status.',
      );
    }
    if (before.isActive === isActive) {
      return { variant, isActive, changed: false, version: before.version, references: 0 };
    }

    let references = 0;
    if (!isActive) {
      const [companies, areas] = await Promise.all([
        tx.select({ key: companyCode.companyCode }).from(companyCode)
          .where(and(eq(companyCode.client, client), eq(companyCode.fiscalYearVariant, variant))),
        tx.select({ key: controllingArea.controllingArea }).from(controllingArea)
          .where(and(eq(controllingArea.client, client), eq(controllingArea.fiscalYearVariant, variant))),
      ]);
      references = companies.length + areas.length;
      if (references > 0) {
        const named = [
          ...companies.map((row) => `Company Code ${row.key}`),
          ...areas.map((row) => `Controlling Area ${row.key}`),
        ];
        throw new FiscalYearVariantError(
          `Fiscal Year Variant ${variant} is still used by ${nameSome(named, 'assignments')} (${references} in all).`,
          'Assign a different Fiscal Year Variant to those Company Codes and Controlling Areas first; a variant in use is never retired.',
        );
      }
    }

    const version = before.version + 1;
    await tx
      .update(fiscalYearVariant)
      .set({ isActive, version, changedBy, changedAt: new Date() })
      .where(and(eq(fiscalYearVariant.client, client), eq(fiscalYearVariant.variant, variant)));

    await recordVariantChange(tx, {
      client, changedBy, variant, reason, changeType: 'CHANGE',
      before: { variant, isActive: before.isActive },
      after: { variant, isActive },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { variant, isActive, changed: true, version, references };
  });
}

/**
 * Maintain one year's period list by hand.
 *
 * Only a variant whose year is not the calendar year has a list to maintain, and a
 * year-dependent variant maintains one list per calendar year while every other variant's list
 * holds for all years — which `calendar_year` 0 records.
 *
 * The list is replaced whole, and it has to cover the year: period numbers run from 1 to the
 * variant's total without gaps, the first of them ordinary and the rest special, and the ends
 * advance from one period to the next around a single wrap into the following calendar year.
 * A list with a hole in it is refused here rather than discovered by a posting that cannot find
 * its period.
 */
export async function saveFiscalYearPeriods(raw: FiscalYearPeriodMaintenanceInput) {
  const parsed = periodsInputSchema.safeParse(raw);
  if (!parsed.success) invalid(parsed.error);
  const { client, changedBy, variant, calendarYear, periods, expectedVersion, reason } = parsed.data;

  return withTenant(client, async (tx) => {
    const rows = await tx
      .select()
      .from(fiscalYearVariant)
      .where(and(eq(fiscalYearVariant.client, client), eq(fiscalYearVariant.variant, variant)))
      .for('update');
    const definition = rows[0];
    if (!definition) {
      throw new FiscalYearVariantError(
        `Fiscal Year Variant ${variant} does not exist in this tenant.`,
        'Create the variant first.',
      );
    }
    if (definition.version !== expectedVersion) {
      throw new FiscalYearVariantError(
        `Fiscal Year Variant ${variant} changed after it was opened.`,
        'Reload the registry before maintaining its periods.',
      );
    }
    if (!definition.isActive) {
      throw new FiscalYearVariantError(
        `Fiscal Year Variant ${variant} is deactivated.`,
        'Reactivate the variant before maintaining its periods.',
      );
    }
    if (definition.isCalendarYear) {
      throw new FiscalYearVariantError(
        `Fiscal Year Variant ${variant} follows the calendar year, so its ${definition.regularPeriods} posting periods and ${definition.specialPeriods} special periods are derived from its own definition.`,
        'Change the counts on the variant, or switch off Calendar year to maintain the periods by hand.',
      );
    }
    if (definition.isYearDependent && calendarYear === 0) {
      throw new FiscalYearVariantError(
        `Fiscal Year Variant ${variant} is year dependent, so its periods are maintained one calendar year at a time.`,
        'Choose the calendar year the list belongs to.',
      );
    }
    if (!definition.isYearDependent && calendarYear !== 0) {
      throw new FiscalYearVariantError(
        `Fiscal Year Variant ${variant} holds for every year, so its periods are not maintained per year.`,
        'Maintain the list that applies to every year, or switch on Year dependent.',
      );
    }

    const total = definition.regularPeriods + definition.specialPeriods;
    if (periods.length !== total) {
      throw new FiscalYearVariantError(
        `Fiscal Year Variant ${variant} asks for ${total} periods (${definition.regularPeriods} ordinary and ${definition.specialPeriods} special) and the list holds ${periods.length}.`,
        'Maintain every period the variant defines, and no others.',
      );
    }

    const sorted = [...periods].sort((a, b) => a.period - b.period);
    const numbers = sorted.map((row) => row.period);
    if (numbers.some((period, index) => period !== index + 1)) {
      throw new FiscalYearVariantError(
        'Period numbers must run from 1 without a gap or a repeat.',
        'Number the periods 1 to ' + String(total) + ' in the order the year runs.',
      );
    }

    // Ends must advance, and the list must span exactly one year: the last period ends eleven
    // months after the first, which is what makes the first period of the next year start the
    // day after it.
    const monthIndex = (row: { yearShift: number; month: number }) => row.yearShift * 12 + row.month;
    for (let i = 1; i < sorted.length; i++) {
      const previous = sorted[i - 1]!;
      const current = sorted[i]!;
      if (monthIndex(current) < monthIndex(previous) ||
          (monthIndex(current) === monthIndex(previous) && current.day < previous.day)) {
        throw new FiscalYearVariantError(
          `Period ${current.period} ends before period ${previous.period} does.`,
          'Periods run in order through the year; a later period cannot end earlier.',
        );
      }
    }
    if (monthIndex(sorted[sorted.length - 1]!) - monthIndex(sorted[0]!) !== 11) {
      throw new FiscalYearVariantError(
        `The periods of ${variant} do not cover one whole year.`,
        'The last period must end eleven months after the first, so the year has no gap and no overlap.',
      );
    }

    const before = await tx
      .select()
      .from(fiscalYearPeriod)
      .where(and(
        eq(fiscalYearPeriod.client, client),
        eq(fiscalYearPeriod.variant, variant),
        eq(fiscalYearPeriod.calendarYear, calendarYear),
      ))
      .orderBy(asc(fiscalYearPeriod.period));

    await tx
      .delete(fiscalYearPeriod)
      .where(and(
        eq(fiscalYearPeriod.client, client),
        eq(fiscalYearPeriod.variant, variant),
        eq(fiscalYearPeriod.calendarYear, calendarYear),
      ));

    const now = new Date();
    for (const row of sorted) {
      await tx.insert(fiscalYearPeriod).values({
        client,
        variant,
        calendarYear,
        period: row.period,
        // Ordinary periods first, then the special ones: the type follows the position, so a
        // list cannot claim a special period where a posting would land.
        periodType: row.period <= definition.regularPeriods ? 'REGULAR' : 'SPECIAL',
        month: row.month,
        day: row.day,
        yearShift: row.yearShift,
        createdBy: changedBy,
        createdAt: now,
        changedBy,
        changedAt: now,
      });
    }

    const version = definition.version + 1;
    await tx
      .update(fiscalYearVariant)
      .set({ version, changedBy, changedAt: now })
      .where(and(eq(fiscalYearVariant.client, client), eq(fiscalYearVariant.variant, variant)));

    await recordVariantChange(tx, {
      client,
      changedBy,
      variant,
      reason,
      changeType: 'CHANGE',
      objectClass: PERIOD_OBJECT_CLASS,
      objectKey: `${variant}/${calendarYear === 0 ? 'every-year' : String(calendarYear)}`,
      before: { periodCount: before.length, periodEnds: describeEnds(before) },
      after: { periodCount: sorted.length, periodEnds: describeEnds(sorted) },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { variant, calendarYear, periods: sorted.length, version };
  });
}

/* ── Internals ──────────────────────────────────────────────────────────────── */

async function writeDerivedPeriods(
  tx: Tx,
  client: string,
  variant: string,
  regularPeriods: number,
  specialPeriods: number,
  changedBy: string,
): Promise<number> {
  // A calendar-year variant starts in January by definition, which is what makes its periods
  // derivable from the two counts alone.
  const rows = buildPeriodRows({ regularPeriods, specialPeriods, startMonth: 1 });
  await tx
    .delete(fiscalYearPeriod)
    .where(and(
      eq(fiscalYearPeriod.client, client),
      eq(fiscalYearPeriod.variant, variant),
      eq(fiscalYearPeriod.calendarYear, 0),
    ));
  const now = new Date();
  for (const row of rows) {
    await tx.insert(fiscalYearPeriod).values({
      client,
      variant,
      calendarYear: 0,
      period: row.period,
      periodType: row.periodType,
      month: row.month,
      day: row.day,
      yearShift: row.yearShift,
      createdBy: changedBy,
      createdAt: now,
      changedBy,
      changedAt: now,
    });
  }
  return rows.length;
}

/** A hand-maintained list has to match the counts the variant now asks for. */
async function checkMaintainedPeriodsStillFit(
  tx: Tx,
  client: string,
  variant: string,
  regularPeriods: number,
  specialPeriods: number,
) {
  const rows = await tx
    .select({
      calendarYear: fiscalYearPeriod.calendarYear,
      ordinary: sql<number>`count(*) filter (where ${fiscalYearPeriod.periodType} = 'REGULAR')::int`,
      special: sql<number>`count(*) filter (where ${fiscalYearPeriod.periodType} = 'SPECIAL')::int`,
    })
    .from(fiscalYearPeriod)
    .where(and(eq(fiscalYearPeriod.client, client), eq(fiscalYearPeriod.variant, variant)))
    .groupBy(fiscalYearPeriod.calendarYear);

  const mismatched = rows
    .filter((row) => row.ordinary !== regularPeriods || row.special !== specialPeriods)
    .map((row) => (row.calendarYear === 0 ? 'every year' : String(row.calendarYear)));
  if (mismatched.length > 0) {
    throw new FiscalYearVariantError(
      `The period list for ${nameSome(mismatched, 'years')} holds ${rows[0]?.ordinary ?? 0} ordinary and ${rows[0]?.special ?? 0} special periods, and the variant now asks for ${regularPeriods} and ${specialPeriods}.`,
      'Maintain the period list to match the new counts, or keep the counts the list already covers.',
    );
  }
}

function describeEnds(rows: ReadonlyArray<{ period: number; month: number; day: number; yearShift?: number }>): string {
  return rows.map((row) => `${row.period}:${row.month}/${row.day}`).join(' ') || 'none';
}

async function recordVariantChange(
  tx: Tx,
  input: {
    client: string;
    changedBy: string;
    variant: string;
    reason: string;
    changeType: 'CREATE' | 'CHANGE';
    objectClass?: string;
    objectKey?: string;
    before?: Record<string, unknown>;
    after: Record<string, unknown>;
  },
) {
  const changeId = await recordChange(tx, {
    client: input.client,
    objectClass: input.objectClass ?? OBJECT_CLASS,
    objectKey: input.objectKey ?? input.variant,
    changeType: input.changeType,
    changedBy: input.changedBy,
    transactionCode: ACTIVITY,
    reason: input.reason,
    before: input.before,
    after: input.after,
    fieldLabels: FIELD_LABELS,
  });
  if (!changeId) {
    throw new FiscalYearVariantError(
      'The Fiscal Year Variant change could not be recorded in change history.',
      'Retry the change. If the problem continues, contact an administrator.',
    );
  }
  return changeId;
}
