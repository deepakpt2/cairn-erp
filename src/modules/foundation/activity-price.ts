/**
 * Activity price calculation from the plan (KSPI), CO.PLAN.ACTIVITYPRICE.EXECUTE.
 *
 * The planning screen (`/config/activity-rates`, KP26) refuses entered prices for activity types on
 * an automatic price indicator, because "its prices are calculated, not entered". This is that
 * calculation, for **price indicator 1** (automatic on activity):
 *
 *   price = planned cost of the cost centre ÷ planned activity quantity × price unit
 *
 * written as the fixed price of every `activity_rate` row the run prices; the variable price is set
 * to zero, because nothing in this product marks a cost element fixed or variable and a guessed split
 * would be a number nobody could explain.
 *
 * The boundaries, each refused by name rather than approximated:
 * - indicator 2 (automatic on capacity) needs a cost centre on the work centre master, which does not
 *   stand — there is no path to the capacity that would be the denominator;
 * - indicator 3 (manual) is never touched: such pairs are listed as skipped;
 * - a cost centre that plans more than one activity type has no rule to split its cost between them
 *   (SAP uses equivalence numbers, not built here) and is refused as ambiguous;
 * - a pair with no planned output, or a centre with no or negative planned cost, is refused: a price
 *   of zero would make the activity silently free.
 *
 * One pass, `iterations: 1`. SAP iterates because cost centres exchange activity; nothing here moves
 * cost between centres yet (assessment and distribution are unbuilt), so a second pass could only
 * repeat the first. `computePrices` is the pass, kept pure so a loop can call it when they land.
 *
 * Prices are numeric(11,2): two decimals. The amount rounding leaves behind is reported as the
 * residual, per pair and in total, never hidden. Plan only — nothing here posts.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { type ServiceAuthorityContext, verifyServiceAuthorityInTx } from '../../platform/auth/service-authority';
import { hasOrgAccess } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant } from '../../platform/db/client';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { type PlanningPeriod, planningContext } from './activity-rate-definition';
import { activityRate } from './schema';

export const ACTIVITY_PRICE_CAPABILITY = 'CO.PLAN.ACTIVITYPRICE.EXECUTE';
export const ACTIVITY_PRICE_ROUTE = '/config/activity-rates';
export const ACTIVITY_PRICE_OBJECT_CLASS = 'activity_price_run';

export class ActivityPriceError extends Error {
  readonly remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ActivityPriceError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new ActivityPriceError(message, remedy);
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

// ── Input ───────────────────────────────────────────────────────────────────

const upperKey = (pattern: RegExp, message: string) =>
  z.string().trim().transform((v) => v.toUpperCase()).pipe(z.string().regex(pattern, message));

export const calculateValuesSchema = z.object({
  controllingArea: upperKey(/^[A-Z0-9]{4}$/, 'The Controlling Area is exactly four letters or digits.'),
  planVersion: upperKey(/^[A-Z0-9]{1,3}$/, 'The Planning Version is up to three letters or digits.'),
  fiscalYear: z.number().int().min(1900, 'The Fiscal Year is a four-digit year.').max(9999, 'The Fiscal Year is a four-digit year.'),
  periodFrom: z.number().int().min(1, 'The fiscal period is between 1 and 16.').max(16, 'The fiscal period is between 1 and 16.'),
  periodTo: z.number().int().min(1, 'The fiscal period is between 1 and 16.').max(16, 'The fiscal period is between 1 and 16.'),
  basis: z.enum(['ANNUAL', 'PERIOD']).default('ANNUAL'),
  reason: z.string().trim().min(1, 'A reason is required.').max(500, 'The reason is at most 500 characters.'),
  requestKey: z.string().trim().max(64).optional(),
});

const actorFields = {
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
};

export const calculateInputSchema = calculateValuesSchema.extend(actorFields).strict();
export type CalculateInput = z.input<typeof calculateInputSchema>;
export type PriceBasis = 'ANNUAL' | 'PERIOD';

// ── The pass — pure ─────────────────────────────────────────────────────────

/** Round a non-negative fraction half-up. */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

export interface ComputePeriodInput {
  period: number;
  /** numeric(13,3) as text. */
  plannedQuantity: string;
  /** The centre's planned cost in this period, numeric as text (scale ≤ 4). */
  plannedCost: string;
  priceUnit: number;
}

export interface ComputePairInput {
  costCenter: string;
  activityType: string;
  /** One entry per activity_rate row the pair has in the range. */
  rows: ComputePeriodInput[];
  /** ANNUAL: the centre's planned cost over the whole range (periods without a rate row included). */
  rangeCost: string;
}

export interface ComputePricesInput {
  basis: PriceBasis;
  pairs: ComputePairInput[];
}

export interface PairComputation {
  costCenter: string;
  activityType: string;
  /** The quantity and cost the price was formed on (range totals). */
  quantity: string;
  cost: string;
  /** The fixed price written into each row, per period. */
  prices: Array<{ period: number; price: string; priceUnit: number }>;
  /** Planned cost minus the cost the priced output absorbs: what two-decimal prices leave behind. */
  residual: string;
  problem?: { code: 'NO_OUTPUT' | 'NEGATIVE_COST' | 'PRICE_TOO_LARGE'; message: string };
}

export interface PriceComputation {
  iterations: number;
  pairs: PairComputation[];
  totalResidual: string;
}

const MAX_PRICE_CENTS = 99_999_999_999n; // numeric(11,2)

/**
 * One pass of the price calculation. ANNUAL: one price for the range — the range's planned cost over
 * the range's planned quantity — written into every row. PERIOD: each row priced on its own period's
 * cost and quantity. Each price is rounded once, half-up, to two decimals; the residual is planned
 * cost minus Σ price ÷ price unit × quantity, rounded half-up to four.
 */
export function computePrices(input: ComputePricesInput): PriceComputation {
  let total = 0n;
  const pairs = input.pairs.map((pair): PairComputation => {
    const qty = pair.rows.reduce((s, r) => s + toScaled(r.plannedQuantity, 3), 0n);
    const rowCost = pair.rows.reduce((s, r) => s + toScaled(r.plannedCost), 0n);
    const cost = input.basis === 'ANNUAL' ? toScaled(pair.rangeCost) : rowCost;
    const base: PairComputation = {
      costCenter: pair.costCenter, activityType: pair.activityType,
      quantity: fromScaled(qty, 3), cost: fromScaled(cost), prices: [], residual: '0.0000',
    };
    if (cost < 0n) {
      return { ...base, problem: { code: 'NEGATIVE_COST', message: `Cost centre ${pair.costCenter} plans a negative cost of ${fromScaled(cost)} in the range; an activity price cannot be negative.` } };
    }
    const priceOf = (cost4: bigint, qty3: bigint, unit: number) => divideHalfUp(cost4 * BigInt(unit) * 10n, qty3);
    if (input.basis === 'ANNUAL') {
      if (qty === 0n) {
        return { ...base, problem: { code: 'NO_OUTPUT', message: `Cost centre ${pair.costCenter} plans no output for activity type ${pair.activityType} in the range; an activity price cannot be calculated from nothing.` } };
      }
    }
    let absorbed = 0n;
    for (const row of [...pair.rows].sort((a, b) => a.period - b.period)) {
      const rowQty = toScaled(row.plannedQuantity, 3);
      let cents: bigint;
      if (input.basis === 'ANNUAL') {
        cents = priceOf(cost, qty, row.priceUnit);
      } else {
        const periodCost = toScaled(row.plannedCost);
        if (periodCost < 0n) {
          return { ...base, prices: [], problem: { code: 'NEGATIVE_COST', message: `Cost centre ${pair.costCenter} plans a negative cost of ${fromScaled(periodCost)} in period ${row.period}; an activity price cannot be negative.` } };
        }
        if (rowQty === 0n) {
          return { ...base, prices: [], problem: { code: 'NO_OUTPUT', message: `Cost centre ${pair.costCenter} plans no output for activity type ${pair.activityType} in period ${row.period}; an activity price cannot be calculated from nothing.` } };
        }
        cents = priceOf(periodCost, rowQty, row.priceUnit);
      }
      if (cents > MAX_PRICE_CENTS) {
        return { ...base, prices: [], problem: { code: 'PRICE_TOO_LARGE', message: `The price for ${pair.costCenter}/${pair.activityType} in period ${row.period} exceeds what a price column holds (999,999,999.99).` } };
      }
      base.prices.push({ period: row.period, price: fromScaled(cents, 2), priceUnit: row.priceUnit });
      absorbed += divideHalfUp(cents * rowQty, 10n * BigInt(row.priceUnit));
    }
    const residual = cost - absorbed;
    total += residual;
    return { ...base, residual: fromScaled(residual) };
  });
  return { iterations: 1, pairs, totalResidual: fromScaled(total) };
}

// ── Assembling the run from the tenant ──────────────────────────────────────

export type PairStatus = 'CALCULATED' | 'SKIPPED' | 'REFUSED';

export interface ActivityPricePair {
  costCenter: string;
  activityType: string;
  /** The indicator in the range, or a description when it changes within it. */
  priceIndicator: string;
  status: PairStatus;
  reason?: string;
  quantity: string;
  cost: string;
  /** Standing fixed prices, per period. */
  oldPrices: Array<{ period: number; fixedPrice: string; variablePrice: string }>;
  /** Calculated fixed prices, per period (CALCULATED only). */
  newPrices: Array<{ period: number; price: string; priceUnit: number }>;
  residual: string;
}

export interface ActivityPriceRunView {
  controllingArea: string;
  fiscalYear: number;
  planVersion: string;
  periodFrom: number;
  periodTo: number;
  basis: PriceBasis;
  currency: string;
  iterations: number;
  pairs: ActivityPricePair[];
  totalResidual: string;
  /** True when the run writes nothing because a pair is refused or none is calculable. */
  blocked: boolean;
  /** Why a calculation would be refused, one line per cause. */
  refusals: string[];
  /** Set once a calculation has written. */
  written?: { rows: number; changed: boolean };
}

const overlaps = (from: string, until: string, start: string, end: string) => from <= end && start <= until;
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

async function judge(tx: Tx, client: string, authorization: ServiceAuthorityContext | undefined) {
  const verdict = await verifyServiceAuthorityInTx(tx, client, authorization, ACTIVITY_PRICE_CAPABILITY, { requirePlantScope: false });
  if (!verdict.ok) fail(verdict.refusal.message, verdict.refusal.remedy);
  return verdict.restrictions;
}

interface Selection {
  controllingArea: string;
  planVersion: string;
  fiscalYear: number;
  periodFrom: number;
  periodTo: number;
  basis: PriceBasis;
}

async function assemble(tx: Tx, client: string, s: Selection, restrictions: Awaited<ReturnType<typeof judge>>): Promise<ActivityPriceRunView> {
  const context = await planningContext(client, s.controllingArea, s.fiscalYear);
  if (!context) fail(`Controlling Area ${s.controllingArea} is not defined in this tenant.`, 'Choose a controlling area that stands.');
  if (s.periodFrom > s.periodTo) fail(`Period ${s.periodFrom} lies after period ${s.periodTo}.`, 'Choose a range whose first period is not after its last.');
  const windows = new Map(context.periods.map((p) => [p.period, p]));
  const range: PlanningPeriod[] = [];
  for (let p = s.periodFrom; p <= s.periodTo; p++) {
    const w = windows.get(p);
    if (!w) {
      fail(`Fiscal period ${p} is not defined by fiscal year variant ${context.fiscalYearVariant} for ${s.fiscalYear}.`, 'Choose periods the variant defines for the year (OB29).');
    }
    range.push(w);
  }
  const periods = range.map((p) => p.period);

  const rates = await tx.select().from(activityRate).where(and(
    eq(activityRate.client, client), eq(activityRate.controllingArea, s.controllingArea),
    eq(activityRate.planVersion, s.planVersion), eq(activityRate.fiscalYear, s.fiscalYear),
    inArray(activityRate.period, periods),
  ));
  const pairKeys = [...new Set(rates.map((r) => `${r.costCenter}|${r.activityType}`))].sort();
  const types = [...new Set(rates.map((r) => r.activityType))];
  const typeRows = types.length === 0 ? [] : (await tx.execute(sql`
    select activity_type, valid_from, valid_to, price_indicator, is_posting_locked
      from activity_type
     where client = ${client} and controlling_area = ${s.controllingArea}
       and activity_type in (${sql.join(types.map((t) => sql`${t}`), sql`, `)})
  `)) as unknown as Array<{ activity_type: string; valid_from: unknown; valid_to: unknown; price_indicator: string; is_posting_locked: boolean }>;

  // The centre's planned cost per period; a revenue element reduces it, as the report flips its sign.
  const centres = [...new Set(rates.map((r) => r.costCenter))];
  const costRows = centres.length === 0 ? [] : (await tx.execute(sql`
    select p.cost_center, p.period,
           sum(case when exists (
                 select 1 from gl_account g
                   join company_code c on c.client = g.client and c.chart_of_accounts = g.chart_of_accounts
                   join controlling_area_company a on a.client = c.client and a.company_code = c.company_code
                  where g.client = p.client and a.controlling_area = p.controlling_area
                    and g.account_number = p.cost_element and g.account_type = 'REVENUE')
               then -p.planned_amount else p.planned_amount end)::text as amount,
           count(*)::int as rows
      from cost_center_plan p
     where p.client = ${client} and p.controlling_area = ${s.controllingArea} and p.plan_version = ${s.planVersion}
       and p.fiscal_year = ${s.fiscalYear} and p.period in (${sql.join(periods.map((p) => sql`${p}`), sql`, `)})
       and p.cost_center in (${sql.join(centres.map((c) => sql`${c}`), sql`, `)})
     group by p.cost_center, p.period
  `)) as unknown as Array<{ cost_center: string; period: number; amount: string; rows: number }>;
  const costOf = (centre: string, period: number) => costRows.find((c) => c.cost_center === centre && Number(c.period) === period)?.amount ?? '0';
  const hasCostPlan = (centre: string) => costRows.some((c) => c.cost_center === centre && Number(c.rows) > 0);
  const rangeCost = (centre: string) => fromScaled(periods.reduce((sum, p) => sum + toScaled(costOf(centre, p)), 0n));

  // Company Code reach over every centre the run would price.
  const centreCompany = centres.length === 0 ? [] : (await tx.execute(sql`
    select distinct on (cost_center) cost_center, company_code from cost_center
     where client = ${client} and controlling_area = ${s.controllingArea}
       and cost_center in (${sql.join(centres.map((c) => sql`${c}`), sql`, `)})
     order by cost_center, valid_from desc
  `)) as unknown as Array<{ cost_center: string; company_code: string | null }>;
  const areaCompanies = ((await tx.execute(sql`
    select company_code from controlling_area_company where client = ${client} and controlling_area = ${s.controllingArea}
  `)) as unknown as Array<{ company_code: string }>).map((r) => String(r.company_code).trim());

  const typesOfCentre = new Map<string, Set<string>>();
  for (const r of rates) typesOfCentre.set(r.costCenter, (typesOfCentre.get(r.costCenter) ?? new Set()).add(r.activityType));

  const pairs: ActivityPricePair[] = [];
  const toCompute: ComputePairInput[] = [];
  for (const key of pairKeys) {
    const [costCenter, activityType] = key.split('|') as [string, string];
    const rows = rates.filter((r) => r.costCenter === costCenter && r.activityType === activityType);
    const pair: ActivityPricePair = {
      costCenter, activityType, priceIndicator: '', status: 'CALCULATED',
      quantity: fromScaled(rows.reduce((s2, r) => s2 + toScaled(String(r.plannedQuantity), 3), 0n), 3),
      cost: rangeCost(costCenter),
      oldPrices: rows.map((r) => ({ period: r.period, fixedPrice: String(r.fixedPrice), variablePrice: String(r.variablePrice) })).sort((a, b) => a.period - b.period),
      newPrices: [], residual: '0.0000',
    };
    // The indicator of the type row standing in each period of the range.
    const standing = range.map((w) => ({
      window: w,
      row: typeRows.find((t) => t.activity_type === activityType && overlaps(day(t.valid_from), day(t.valid_to), w.start, w.end)),
    }));
    const indicators = [...new Set(standing.filter((x) => x.row).map((x) => String(x.row!.price_indicator).trim()))];
    pair.priceIndicator = indicators.length === 1 ? indicators[0]! : indicators.length === 0 ? '—' : `changes (${indicators.join(', ')})`;
    const refuse = (reason: string) => { pair.status = 'REFUSED'; pair.reason = reason; };
    if (indicators.includes('2')) {
      refuse(`Activity type ${activityType} carries price indicator 2 (automatic on capacity). Capacity-based pricing needs a cost centre on the work centre master, which does not stand; plan this activity type manually or set indicator 1.`);
    } else if (indicators.length > 0 && indicators.every((i) => i === '3')) {
      pair.status = 'SKIPPED';
      pair.reason = 'Manual price indicator (3): prices are entered, never calculated.';
    } else if (indicators.length > 1) {
      refuse(`Activity type ${activityType} changes price indicator within periods ${s.periodFrom}–${s.periodTo} (${indicators.join(', ')}); calculate a range in which it stands on indicator 1 throughout.`);
    } else if (indicators.length === 0) {
      refuse(`Activity type ${activityType} is not valid in period ${range[0]!.period} (${range[0]!.start} to ${range[0]!.end}).`);
    } else {
      const missing = standing.find((x) => !x.row);
      const locked = standing.find((x) => x.row?.is_posting_locked);
      const others = [...(typesOfCentre.get(costCenter) ?? [])].filter((t) => t !== activityType).sort();
      const companies = (() => {
        const c = centreCompany.find((r) => r.cost_center === costCenter)?.company_code;
        return c ? [String(c).trim()] : areaCompanies;
      })();
      const outside = companies.find((c) => !hasOrgAccess(restrictions, 'COMPANY_CODE', c));
      if (missing) {
        refuse(`Activity type ${activityType} is not valid in period ${missing.window.period} (${missing.window.start} to ${missing.window.end}).`);
      } else if (locked) {
        refuse(`Activity type ${activityType} is locked for posting in period ${locked.window.period}.`);
      } else if (others.length > 0) {
        refuse(`Cost centre ${costCenter} plans more than one activity type (${[activityType, ...others].sort().join(', ')}) in the range; with no rule to split its cost between them (equivalence numbers are not built), no price is calculated for it.`);
      } else if (!hasCostPlan(costCenter)) {
        refuse(`Cost centre ${costCenter} has no primary-cost plan for version ${s.planVersion} in periods ${s.periodFrom}–${s.periodTo}; plan its costs at /controlling/cost-center-planning first.`);
      } else if (outside) {
        refuse(`Your Company Code scope does not cover company code ${outside}, to which cost centre ${costCenter} belongs.`);
      } else {
        toCompute.push({
          costCenter, activityType, rangeCost: rangeCost(costCenter),
          rows: rows.map((r) => ({ period: r.period, plannedQuantity: String(r.plannedQuantity), plannedCost: costOf(costCenter, r.period), priceUnit: r.priceUnit })),
        });
      }
    }
    pairs.push(pair);
  }

  const computation = computePrices({ basis: s.basis, pairs: toCompute });
  for (const c of computation.pairs) {
    const pair = pairs.find((p) => p.costCenter === c.costCenter && p.activityType === c.activityType)!;
    pair.cost = c.cost;
    if (c.problem) {
      pair.status = 'REFUSED';
      pair.reason = c.problem.message;
    } else {
      pair.newPrices = c.prices;
      pair.residual = c.residual;
    }
  }
  const refusals = pairs.filter((p) => p.status === 'REFUSED').map((p) => `${p.costCenter}/${p.activityType}: ${p.reason}`);
  const calculable = pairs.filter((p) => p.status === 'CALCULATED');
  if (refusals.length === 0 && calculable.length === 0) {
    refusals.push('Nothing to calculate: no cost centre plans output against an automatic activity type in this range.');
  }
  const totalResidual = fromScaled(calculable.reduce((sum, p) => sum + toScaled(p.residual), 0n));
  return {
    controllingArea: s.controllingArea, fiscalYear: s.fiscalYear, planVersion: s.planVersion,
    periodFrom: s.periodFrom, periodTo: s.periodTo, basis: s.basis, currency: context.currency,
    iterations: computation.iterations, pairs, totalResidual, blocked: refusals.length > 0, refusals,
  };
}

function parse(raw: CalculateInput) {
  const parsed = calculateInputSchema.safeParse(raw);
  if (!parsed.success) fail(parsed.error.issues[0]?.message ?? 'The calculation is not valid.', 'Correct the indicated value and submit again.');
  return parsed.data;
}

// ── The services ────────────────────────────────────────────────────────────

/** What a calculation would write, without writing. Refused pairs are shown, not thrown. */
export async function previewActivityPrices(raw: CalculateInput, options: { authorization?: ServiceAuthorityContext } = {}): Promise<ActivityPriceRunView> {
  const { client, ...values } = parse(raw);
  return withTenant(client, async (tx) => assemble(tx, client, values, await judge(tx, client, options.authorization)));
}

/**
 * Calculate and write the prices. Refused when any pair in the range is refused — naming each — or
 * when nothing is calculable. Only `activity_rate` rows that stand are written: no row is created.
 */
export async function calculateActivityPrices(raw: CalculateInput, options: { authorization?: ServiceAuthorityContext } = {}): Promise<ActivityPriceRunView> {
  const { client, changedBy, reason, requestKey, ...values } = parse(raw);
  return withTenant(client, async (tx) => {
    const restrictions = await judge(tx, client, options.authorization);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`activity-price:${client}:${values.controllingArea}:${values.planVersion}:${values.fiscalYear}`}, 0))`);
    const view = await assemble(tx, client, values, restrictions);
    if (view.blocked) {
      fail(
        view.refusals.length === 1 ? view.refusals[0]! : `The calculation is refused for ${view.refusals.length} reasons: ${view.refusals.join(' · ')}`,
        'Resolve each named pair (plan output or cost, set the indicator, or narrow the range), then calculate again.',
      );
    }
    const before: Record<string, string> = {};
    const after: Record<string, string> = {};
    const labels: Record<string, string> = {};
    const now = new Date();
    let rows = 0;
    let changed = 0;
    for (const pair of view.pairs.filter((p) => p.status === 'CALCULATED')) {
      for (const price of pair.newPrices) {
        const old = pair.oldPrices.find((o) => o.period === price.period)!;
        rows++;
        if (old.fixedPrice === price.price && Number(old.variablePrice) === 0) continue;
        changed++;
        await tx.update(activityRate).set({ fixedPrice: price.price, variablePrice: '0.00', changedBy, changedAt: now }).where(and(
          eq(activityRate.client, client), eq(activityRate.controllingArea, values.controllingArea),
          eq(activityRate.planVersion, values.planVersion), eq(activityRate.fiscalYear, values.fiscalYear),
          eq(activityRate.period, price.period), eq(activityRate.costCenter, pair.costCenter), eq(activityRate.activityType, pair.activityType),
        ));
        const field = `${pair.costCenter}/${pair.activityType}/p${price.period}`;
        before[field] = `${old.fixedPrice} + ${old.variablePrice}`;
        after[field] = `${price.price} + 0.00`;
        labels[field] = `${pair.costCenter} ${pair.activityType} period ${price.period} fixed + variable price`;
      }
      const residualField = `${pair.costCenter}/${pair.activityType}/residual`;
      after[residualField] = pair.residual;
      labels[residualField] = `${pair.costCenter} ${pair.activityType} rounding residual (${view.currency})`;
    }
    if (changed > 0) {
      after.totalResidual = view.totalResidual;
      after.basis = values.basis;
      after.iterations = String(view.iterations);
      labels.totalResidual = `Total rounding residual (${view.currency})`;
      await recordChange(tx, {
        client,
        objectClass: ACTIVITY_PRICE_OBJECT_CLASS,
        objectKey: `${values.controllingArea}/${values.planVersion}/${values.fiscalYear}/${values.periodFrom}-${values.periodTo}`,
        changeType: 'CHANGE',
        changedBy,
        transactionCode: ACTIVITY_PRICE_CAPABILITY,
        reason,
        correlationId: requestKey,
        before,
        after,
        fieldLabels: labels,
        securityRelevantFields: Object.keys(after).filter((k) => /\/p\d+$/.test(k)),
      });
    }
    return { ...view, written: { rows, changed: changed > 0 } };
  });
}

export interface CalculableActivity {
  costCenter: string;
  activityType: string;
  priceIndicator: string;
  status: PairStatus;
  reason?: string;
  plannedQuantity: string;
  plannedCost: string;
}

export interface CalculableListing {
  /** The range the listing judged: the regular periods in which activity is planned, unless given. */
  periodFrom: number;
  periodTo: number;
  pairs: CalculableActivity[];
}

/**
 * What a run would do, for the screen: calculated, skipped or refused, and why. Without a range it
 * judges the regular periods from the first to the last in which the version plans any activity — a
 * year judged from period 1 would refuse every activity type that starts later in it.
 */
export async function listCalculableActivities(
  input: { client: string; controllingArea: string; fiscalYear: number; planVersion: string; periodFrom?: number; periodTo?: number },
  options: { authorization?: ServiceAuthorityContext } = {},
): Promise<CalculableListing | null> {
  const area = input.controllingArea.trim().toUpperCase();
  const version = (input.planVersion || '000').toUpperCase();
  const context = await planningContext(input.client, area, input.fiscalYear);
  if (!context || context.periods.length === 0) return null;
  const regular = context.periods.filter((p) => p.periodType === 'REGULAR').map((p) => p.period);
  return withTenant(input.client, async (tx) => {
    const restrictions = await judge(tx, input.client, options.authorization);
    const planned = (await tx.execute(sql`
      select min(period)::int as first, max(period)::int as last from activity_rate
       where client = ${input.client} and controlling_area = ${area} and plan_version = ${version} and fiscal_year = ${input.fiscalYear}
         and period in (${sql.join(regular.map((p) => sql`${p}`), sql`, `)})
    `)) as unknown as Array<{ first: number | null; last: number | null }>;
    const periodFrom = input.periodFrom ?? planned[0]?.first ?? regular[0]!;
    const periodTo = input.periodTo ?? planned[0]?.last ?? regular.at(-1)!;
    const view = await assemble(tx, input.client, {
      controllingArea: area, planVersion: version, fiscalYear: input.fiscalYear, periodFrom, periodTo, basis: 'ANNUAL',
    }, restrictions);
    return {
      periodFrom,
      periodTo,
      pairs: view.pairs.map((p) => ({
        costCenter: p.costCenter, activityType: p.activityType, priceIndicator: p.priceIndicator, status: p.status,
        reason: p.reason, plannedQuantity: p.quantity, plannedCost: p.cost,
      })),
    };
  });
}
