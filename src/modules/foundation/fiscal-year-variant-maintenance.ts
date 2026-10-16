/**
 * SCR-029 / OB29 — Fiscal Year Variant registry (`PERIV`, T009) and its periods (T009B).
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
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '../../platform/db/client';
import { periodWindows } from '../../platform/periods';
import { fiscalYearPeriod, fiscalYearVariant } from './schema';

const clientSchema = z.string().trim().regex(/^[A-Za-z0-9]{2,4}$/);

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
