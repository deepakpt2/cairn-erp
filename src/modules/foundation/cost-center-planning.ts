/**
 * Cost centre planning — primary costs (KP06), CO.PLAN.COSTCENTER.MAINTAIN.
 *
 * Writes `cost_center_plan`: planned amounts per controlling area, plan version, fiscal year, period,
 * cost centre and cost element. The actual/plan report (`cost-center-report.ts`, KP07 here) already
 * reads it. **Plan is plan, actual is actual**: nothing in this file reads or writes a journal.
 *
 * The activity and quantity side of KP06 is `/config/activity-rates` (`activity_rate`) and is not
 * touched. There is no cost-element master: a cost element is any G/L account of a chart reachable
 * from the controlling area, not blocked for posting.
 *
 * A save replaces the selection — controlling area, version, year and cost centre: what the screen
 * shows is what stands afterwards. There is no accumulating merge. Plan versions are a free key of up
 * to three characters, as for activity rates; there is no version table.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { type ServiceAuthorityContext, verifyServiceAuthorityInTx } from '../../platform/auth/service-authority';
import { hasOrgAccess } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant } from '../../platform/db/client';
import { DecimalError, MONEY_SCALE, fromScaled, toScaled } from '../../platform/posting/decimal';
import { type PlanningContext, type PlanningPeriod, planningContext } from './activity-rate-definition';
import { costCenter, costCenterPlan } from './schema';

export const COST_CENTER_PLANNING_CAPABILITY = 'CO.PLAN.COSTCENTER.MAINTAIN';
export const COST_CENTER_PLANNING_ROUTE = '/controlling/cost-center-planning';
export const COST_CENTER_PLANNING_OBJECT_CLASS = 'cost_center_plan';
export const DEFAULT_PLAN_VERSION = '000';
const CHART_ROUTE = '/config/chart-of-accounts';

export class CostCenterPlanningError extends Error {
  readonly remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CostCenterPlanningError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new CostCenterPlanningError(message, remedy);
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

// ── Input ───────────────────────────────────────────────────────────────────

const upperKey = (max: number, message: string, exact = false) =>
  z.string().trim().transform((v) => v.toUpperCase())
    .pipe(z.string().regex(exact ? new RegExp(`^[A-Z0-9]{${max}}$`) : new RegExp(`^[A-Z0-9]{1,${max}}$`), message));

const entrySchema = z.object({
  costElement: upperKey(10, 'A Cost Element is a G/L account number of up to ten letters or digits.'),
  period: z.number().int().min(1, 'The fiscal period is between 1 and 16.').max(16, 'The fiscal period is between 1 and 16.'),
  /** Blank: the cell is empty, and any standing row for it is deleted. */
  amount: z.string().trim(),
});

export const costCenterPlanValuesSchema = z.object({
  controllingArea: upperKey(4, 'The Controlling Area is exactly four letters or digits.', true),
  planVersion: upperKey(3, 'The Planning Version is up to three letters or digits.'),
  fiscalYear: z.number().int().min(1900, 'The Fiscal Year is a four-digit year.').max(9999, 'The Fiscal Year is a four-digit year.'),
  costCenter: upperKey(10, 'The Cost Centre is up to ten letters or digits.'),
  entries: z.array(entrySchema).min(1, 'Plan at least one period.'),
  reason: z.string().trim().min(1, 'A reason is required.').max(500, 'The reason is at most 500 characters.'),
  /** Idempotency: a replay of the same selection is accepted, one naming a different selection refused. */
  requestKey: z.string().trim().max(64).optional(),
});

const actorFields = {
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
};

export const saveCostCenterPlanSchema = costCenterPlanValuesSchema.extend(actorFields).strict();
export type SaveCostCenterPlanInput = z.input<typeof saveCostCenterPlanSchema>;

// ── The pure half ───────────────────────────────────────────────────────────

/**
 * Spread an annual total over `periods` cells, exactly: the parts always sum to the total. Worked in
 * integer units of the currency's smallest step (`decimals`, default the four-place money scale), the
 * remainder going one unit at a time to the earliest periods. Negative totals spread too (a plan may
 * carry a credit); a total smaller than the period count leaves the later periods at zero.
 */
export function spreadAnnualTotal(total: string, periods: number, decimals = MONEY_SCALE): string[] {
  if (!Number.isInteger(periods) || periods < 1) fail(`An annual total cannot be spread over ${periods} periods.`, 'Spread over at least one period.');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MONEY_SCALE) fail(`A currency cannot carry ${decimals} decimals here.`);
  let scaled: bigint;
  try {
    scaled = toScaled(String(total));
  } catch (error) {
    if (error instanceof DecimalError) fail(`The annual total "${total}" is not a number.`, 'Enter the total as a plain number, e.g. 12000.00.');
    throw error;
  }
  const unit = 10n ** BigInt(MONEY_SCALE - decimals);
  if (scaled % unit !== 0n) fail(`The annual total ${total} has more than ${decimals} decimal places.`, `Enter it to ${decimals} decimal places.`);
  const units = scaled / unit;
  const n = BigInt(periods);
  // Floor division, also for negatives, so the remainder is always 0..periods-1.
  let share = units / n;
  if (units % n !== 0n && units < 0n) share -= 1n;
  const rem = units - share * n;
  return Array.from({ length: periods }, (_, i) => fromScaled((share + (BigInt(i) < rem ? 1n : 0n)) * unit));
}

// ── Facts read from the tenant ──────────────────────────────────────────────

async function currencyDecimals(tx: Tx, currency: string): Promise<number> {
  // The platform currency reference carries the precision; nothing is duplicated here.
  const rows = (await tx.execute(sql`select decimal_places from currency where code = ${currency} limit 1`)) as unknown as Array<{ decimal_places: number }>;
  return rows[0] ? Number(rows[0].decimal_places) : 2;
}

async function areaCompanies(tx: Tx, client: string, area: string): Promise<Array<{ companyCode: string; chart: string | null }>> {
  const rows = (await tx.execute(sql`
    select a.company_code, c.chart_of_accounts
      from controlling_area_company a
      left join company_code c on c.client = a.client and c.company_code = a.company_code
     where a.client = ${client} and a.controlling_area = ${area}
     order by a.company_code
  `)) as unknown as Array<{ company_code: string; chart_of_accounts: string | null }>;
  return rows.map((r) => ({ companyCode: String(r.company_code).trim(), chart: r.chart_of_accounts ? String(r.chart_of_accounts).trim() : null }));
}

/** A bound, parameterised list for `in (...)`. */
const list = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

const overlaps = (from: string, until: string, start: string, end: string) => from <= end && start <= until;

async function centreRows(tx: Tx, client: string, area: string, centre: string) {
  return tx.select().from(costCenter)
    .where(and(eq(costCenter.client, client), eq(costCenter.controllingArea, area), eq(costCenter.costCenter, centre)))
    .orderBy(asc(costCenter.validFrom));
}

/**
 * Judge each cost element once: it must stand in a chart reachable from the area, and not be
 * blocked for posting there or at any company of the area.
 */
async function judgeElements(tx: Tx, client: string, area: string, elements: string[]): Promise<Map<string, { name: string; accountType: string }>> {
  const companies = await areaCompanies(tx, client, area);
  const charts = [...new Set(companies.map((c) => c.chart).filter((c): c is string => Boolean(c)))];
  const known = new Map<string, { name: string; accountType: string }>();
  if (elements.length === 0) return known;
  if (charts.length === 0) {
    fail(`Controlling Area ${area} has no company code with a chart of accounts, so no cost element can be found.`, 'Assign a company code with a chart of accounts to the controlling area (OKKP).');
  }
  const accounts = (await tx.execute(sql`
    select account_number, chart_of_accounts, name, account_type, is_blocked_posting
      from gl_account
     where client = ${client} and chart_of_accounts in (${list(charts)})
       and account_number in (${list(elements)})
  `)) as unknown as Array<{ account_number: string; chart_of_accounts: string; name: string; account_type: string; is_blocked_posting: boolean }>;
  const companyBlocks = (await tx.execute(sql`
    select gl_account, company_code from gl_account_company
     where client = ${client} and is_blocked_posting = true
       and company_code in (${list(companies.map((c) => c.companyCode))})
       and gl_account in (${list(elements)})
  `)) as unknown as Array<{ gl_account: string; company_code: string }>;
  for (const element of elements) {
    const found = accounts.filter((a) => a.account_number === element);
    if (found.length === 0) {
      fail(
        `Cost Element ${element} was not found: no chart of accounts of Controlling Area ${area} (${charts.join(', ')}) holds G/L account ${element}.`,
        `Check the account number, or create the account at ${CHART_ROUTE}.`,
      );
    }
    const blocked = found.find((a) => a.is_blocked_posting);
    if (blocked) {
      fail(`Cost Element ${element} is blocked for posting in chart ${blocked.chart_of_accounts}.`, `Unblock the account at ${CHART_ROUTE}, or plan another cost element.`);
    }
    const companyBlock = companyBlocks.find((b) => b.gl_account === element);
    if (companyBlock) {
      fail(`Cost Element ${element} is blocked for posting in company code ${companyBlock.company_code}.`, `Unblock it at company-code level at ${CHART_ROUTE}, or plan another cost element.`);
    }
    known.set(element, { name: found[0]!.name, accountType: found[0]!.account_type });
  }
  return known;
}

// ── Reading ─────────────────────────────────────────────────────────────────

export interface CostCenterChoice {
  costCenter: string;
  name: string;
  companyCode: string | null;
  validFrom: string;
  validTo: string;
  isPostingLocked: boolean;
}

/** Cost centres of the area whose validity meets the fiscal year, for the selection form. */
export async function listCostCentersFor(client: string, controllingArea: string, fiscalYear: number): Promise<CostCenterChoice[]> {
  const area = controllingArea.trim().toUpperCase();
  const context = await planningContext(client, area, fiscalYear);
  if (!context || context.periods.length === 0) return [];
  const yearStart = context.periods[0]!.start;
  const yearEnd = context.periods[context.periods.length - 1]!.end;
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(costCenter)
      .where(and(eq(costCenter.client, client), eq(costCenter.controllingArea, area)))
      .orderBy(asc(costCenter.costCenter), asc(costCenter.validFrom));
    const latest = new Map<string, CostCenterChoice>();
    for (const r of rows) {
      if (!overlaps(r.validFrom, r.validTo, yearStart, yearEnd)) continue;
      latest.set(r.costCenter, {
        costCenter: r.costCenter, name: r.name, companyCode: r.companyCode ?? null,
        validFrom: r.validFrom, validTo: r.validTo, isPostingLocked: r.isPostingLocked,
      });
    }
    return [...latest.values()];
  });
}

export interface PlanningGridView {
  context: PlanningContext;
  /** The currency's decimal places — the precision every cell is entered in. */
  decimals: number;
  costCenter: { costCenter: string; name: string; validFrom: string; validTo: string; isPostingLocked: boolean } | null;
  /** `${costElement}|${period}` → planned amount, for the rows that stand. */
  cells: Map<string, string>;
  /** Cost elements with standing rows, in order. */
  plannedElements: string[];
  /** Account names for the planned and suggested elements. */
  elementNames: Map<string, string>;
  /** G/L accounts posted to this cost centre in the prior fiscal year — a convenience, not a limit. */
  suggestedElements: string[];
}

/** The standing plan for one selection, with the context the grid is drawn in. */
export async function planningGrid(input: {
  client: string;
  controllingArea: string;
  fiscalYear: number;
  planVersion: string;
  costCenter: string;
}): Promise<PlanningGridView> {
  const area = input.controllingArea.trim().toUpperCase();
  const version = (input.planVersion.trim() || DEFAULT_PLAN_VERSION).toUpperCase();
  const centre = input.costCenter.trim().toUpperCase();
  const context = await planningContext(input.client, area, input.fiscalYear);
  if (!context) fail(`Controlling Area ${area} is not defined in this tenant.`, 'Choose a controlling area that stands.');
  return withTenant(input.client, async (tx) => {
    const decimals = await currencyDecimals(tx, context.currency);
    const centres = await centreRows(tx, input.client, area, centre);
    const yearStart = context.periods[0]?.start ?? `${input.fiscalYear}-01-01`;
    const yearEnd = context.periods.at(-1)?.end ?? `${input.fiscalYear}-12-31`;
    const inYear = centres.filter((r) => overlaps(r.validFrom, r.validTo, yearStart, yearEnd));
    const head = inYear.at(-1) ?? centres.at(-1) ?? null;
    const rows = await tx.select().from(costCenterPlan).where(and(
      eq(costCenterPlan.client, input.client), eq(costCenterPlan.controllingArea, area),
      eq(costCenterPlan.planVersion, version), eq(costCenterPlan.fiscalYear, input.fiscalYear),
      eq(costCenterPlan.costCenter, centre),
    )).orderBy(asc(costCenterPlan.costElement), asc(costCenterPlan.period));
    const cells = new Map(rows.map((r) => [`${r.costElement}|${r.period}`, String(r.plannedAmount)]));
    const plannedElements = [...new Set(rows.map((r) => r.costElement))];
    const prior = (await tx.execute(sql`
      select distinct l.gl_account
        from journal_entry_line l
        join journal_entry e on e.client = l.client and e.company_code = l.company_code
                            and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
       where l.client = ${input.client} and l.cost_center = ${centre}
         and e.posting_date between ${`${input.fiscalYear - 1}-01-01`}::date and ${`${input.fiscalYear - 1}-12-31`}::date
         and l.company_code in (select company_code from controlling_area_company where client = ${input.client} and controlling_area = ${area})
       order by l.gl_account
    `)) as unknown as Array<{ gl_account: string }>;
    const suggestedElements = prior.map((r) => r.gl_account).filter((a) => !plannedElements.includes(a));
    const wanted = [...plannedElements, ...suggestedElements];
    const names = wanted.length === 0 ? [] : ((await tx.execute(sql`
      select distinct on (account_number) account_number, name from gl_account
       where client = ${input.client} and account_number in (${list(wanted)})
       order by account_number
    `)) as unknown as Array<{ account_number: string; name: string }>);
    return {
      context,
      decimals,
      costCenter: head ? { costCenter: head.costCenter, name: head.name, validFrom: head.validFrom, validTo: head.validTo, isPostingLocked: head.isPostingLocked } : null,
      cells,
      plannedElements,
      elementNames: new Map(names.map((n) => [n.account_number, n.name])),
      suggestedElements,
    };
  });
}

// ── Saving ──────────────────────────────────────────────────────────────────

const selectionKey = (v: { controllingArea: string; planVersion: string; fiscalYear: number; costCenter: string }) =>
  `${v.controllingArea}/${v.planVersion}/${v.fiscalYear}/${v.costCenter}`;

/**
 * Save the plan for one selection (area, version, year, cost centre). The submitted cells replace
 * what stood: a filled cell is upserted, a blank or absent one deleted. The caller's session is judged
 * here — `CO.PLAN.COSTCENTER.MAINTAIN` and Company Code reach over the cost centre's company.
 */
export async function saveCostCenterPlan(
  raw: SaveCostCenterPlanInput,
  options: { authorization?: ServiceAuthorityContext } = {},
): Promise<{ changed: boolean; periods: number; rows: number }> {
  const parsed = saveCostCenterPlanSchema.safeParse(raw);
  if (!parsed.success) {
    fail(parsed.error.issues[0]?.message ?? 'The plan is not valid.', 'Correct the indicated value and submit again.');
  }
  const { client, changedBy, reason, requestKey, ...values } = parsed.data;
  const context = await planningContext(client, values.controllingArea, values.fiscalYear);
  if (!context) {
    fail(`Controlling Area ${values.controllingArea} is not defined in this tenant.`, 'Choose a controlling area that stands; cost centres are planned inside controlling areas.');
  }
  const windows = new Map(context.periods.map((p) => [p.period, p]));
  for (const entry of values.entries) {
    if (!windows.has(entry.period)) {
      fail(
        `Fiscal period ${entry.period} is not defined by fiscal year variant ${context.fiscalYearVariant} for ${values.fiscalYear}.`,
        'Plan only the periods the variant defines for the year (OB29).',
      );
    }
  }
  const seen = new Set<string>();
  for (const entry of values.entries) {
    const key = `${entry.costElement}|${entry.period}`;
    if (seen.has(key)) {
      fail(
        `Cost Element ${entry.costElement} is planned twice for period ${entry.period} in one save.`,
        'Each cost element and period stands once in the grid; correct the duplicated cell.',
      );
    }
    seen.add(key);
  }

  return withTenant(client, async (tx) => {
    // Authority: the service judges the session itself, not only the page.
    const authority = await verifyServiceAuthorityInTx(tx, client, options.authorization, COST_CENTER_PLANNING_CAPABILITY, { requirePlantScope: false });
    if (!authority.ok) fail(authority.refusal.message, authority.refusal.remedy);

    // Idempotency: a request key already used names its selection.
    if (requestKey) {
      const [prior] = (await tx.execute(sql`
        select object_key from change_document
         where client = ${client} and object_class = ${COST_CENTER_PLANNING_OBJECT_CLASS} and correlation_id = ${requestKey}
         limit 1
      `)) as unknown as Array<{ object_key: string }>;
      if (prior && prior.object_key !== selectionKey(values)) {
        fail(`This form was already submitted for plan ${prior.object_key}; it cannot now save ${selectionKey(values)}.`, 'Reload the planning screen and enter the plan again.');
      }
    }

    // The cost centre: standing in the area, valid and unlocked in every planned period.
    const centres = await centreRows(tx, client, values.controllingArea, values.costCenter);
    if (centres.length === 0) {
      fail(`Cost Centre ${values.costCenter} does not stand in Controlling Area ${values.controllingArea}.`, 'Choose a cost centre of the controlling area (KS01).');
    }
    // Validity is judged on the cells that carry an amount: a blank cell only deletes, and the grid
    // submits every period, including ones the centre does not cover.
    const plannedPeriods = [...new Set(values.entries.filter((e) => e.amount !== '').map((e) => e.period))].sort((a, b) => a - b);
    for (const period of plannedPeriods) {
      const window = windows.get(period) as PlanningPeriod;
      const standing = centres.find((r) => overlaps(r.validFrom, r.validTo, window.start, window.end));
      if (!standing) {
        fail(`Cost Centre ${values.costCenter} is not valid in period ${period} (${window.start} to ${window.end}).`, 'Plan only the periods the cost centre master covers; validity is judged per period, not per year.');
      }
      if (standing.isPostingLocked) {
        fail(`Cost Centre ${values.costCenter} is locked for posting in period ${period}.`, 'Unlock the cost centre (KS01) before planning against it, or plan a period it stands open in.');
      }
    }
    // Company Code reach: the centre's company, or else every company of the area.
    const centreCompanies = [...new Set(centres.map((r) => r.companyCode).filter((c): c is string => Boolean(c)))];
    const reach = centreCompanies.length > 0 ? centreCompanies : (await areaCompanies(tx, client, values.controllingArea)).map((c) => c.companyCode);
    const outside = reach.find((c) => !hasOrgAccess(authority.restrictions, 'COMPANY_CODE', c));
    if (outside) {
      fail(`Your Company Code scope does not cover company code ${outside}, to which Cost Centre ${values.costCenter} belongs.`, 'Ask an administrator to extend your Company Code scope, then plan again.');
    }

    // Cost elements and amounts.
    await judgeElements(tx, client, values.controllingArea, [...new Set(values.entries.map((e) => e.costElement))]);
    const decimals = await currencyDecimals(tx, context.currency);
    const filled = new Map<string, { costElement: string; period: number; amount: string }>();
    for (const entry of values.entries) {
      if (entry.amount === '') continue;
      let scaled: bigint;
      try {
        scaled = toScaled(entry.amount);
      } catch (error) {
        if (error instanceof DecimalError) {
          fail(`The amount "${entry.amount}" for Cost Element ${entry.costElement} in period ${entry.period} is not a number.`, `Enter a plain number in ${context.currency}, up to ${decimals} decimal places.`);
        }
        throw error;
      }
      // Judge the value, not the text: 1000.0000 is a whole amount in any currency. A text longer than
      // the four-place money scale is refused too, because toScaled would otherwise cut it silently.
      const places = (entry.amount.split('.')[1] ?? '').length;
      if (places > MONEY_SCALE || scaled % 10n ** BigInt(MONEY_SCALE - decimals) !== 0n) {
        fail(
          `The amount ${entry.amount} for Cost Element ${entry.costElement} in period ${entry.period} has more decimal places than ${context.currency} carries (${decimals}).`,
          `Enter amounts in ${context.currency} to at most ${decimals} decimal places.`,
        );
      }
      filled.set(`${entry.costElement}|${entry.period}`, { costElement: entry.costElement, period: entry.period, amount: fromScaled(scaled) });
    }

    // Replace the selection.
    const where = and(
      eq(costCenterPlan.client, client), eq(costCenterPlan.controllingArea, values.controllingArea),
      eq(costCenterPlan.planVersion, values.planVersion), eq(costCenterPlan.fiscalYear, values.fiscalYear),
      eq(costCenterPlan.costCenter, values.costCenter),
    );
    const standing = await tx.select().from(costCenterPlan).where(where);
    const beforeCells = new Map(standing.map((r) => [`${r.costElement}|${r.period}`, fromScaled(toScaled(String(r.plannedAmount)))]));
    const before: Record<string, string> = {};
    const after: Record<string, string> = {};
    const labels: Record<string, string> = {};
    const now = new Date();
    let changedCells = 0;
    const field = (key: string) => {
      const [element, period] = key.split('|');
      const name = `e${element}p${period}`;
      labels[name] = `Cost element ${element}, period ${period}`;
      return name;
    };

    for (const [key, cell] of filled) {
      const prior = beforeCells.get(key);
      if (prior === cell.amount) continue;
      changedCells++;
      const name = field(key);
      after[name] = cell.amount;
      if (prior !== undefined) {
        before[name] = prior;
        await tx.update(costCenterPlan).set({ plannedAmount: cell.amount, updatedBy: changedBy, updatedAt: now })
          .where(and(where, eq(costCenterPlan.period, cell.period), eq(costCenterPlan.costElement, cell.costElement)));
      } else {
        await tx.insert(costCenterPlan).values({
          client, controllingArea: values.controllingArea, planVersion: values.planVersion, fiscalYear: values.fiscalYear,
          period: cell.period, costCenter: values.costCenter, costElement: cell.costElement, plannedAmount: cell.amount,
          createdBy: changedBy,
        });
      }
    }
    const removed = standing.filter((r) => !filled.has(`${r.costElement}|${r.period}`));
    for (const r of removed) {
      changedCells++;
      before[field(`${r.costElement}|${r.period}`)] = beforeCells.get(`${r.costElement}|${r.period}`)!;
    }
    if (removed.length > 0) {
      for (const element of [...new Set(removed.map((r) => r.costElement))]) {
        await tx.delete(costCenterPlan).where(and(where, eq(costCenterPlan.costElement, element),
          inArray(costCenterPlan.period, removed.filter((r) => r.costElement === element).map((r) => r.period))));
      }
    }

    const periodsTouched = new Set([...Object.keys(after), ...Object.keys(before)].map((k) => k.split('p').at(-1)));
    if (changedCells > 0) {
      await recordChange(tx, {
        client,
        objectClass: COST_CENTER_PLANNING_OBJECT_CLASS,
        objectKey: selectionKey(values),
        changeType: standing.length === 0 ? 'CREATE' : filled.size === 0 ? 'DELETE' : 'CHANGE',
        changedBy,
        transactionCode: COST_CENTER_PLANNING_CAPABILITY,
        reason,
        correlationId: requestKey,
        before,
        after,
        fieldLabels: labels,
      });
    }
    return { changed: changedCells > 0, periods: periodsTouched.size, rows: filled.size };
  });
}

/** The controlling areas a plan can be entered in, for the selection form. */
export async function listPlanningAreas(client: string): Promise<Array<{ controllingArea: string; name: string; currency: string }>> {
  return withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select controlling_area, name, currency from controlling_area where client = ${client} order by controlling_area
    `)) as unknown as Array<{ controlling_area: string; name: string; currency: string }>;
    return rows.map((r) => ({ controllingArea: r.controlling_area, name: r.name, currency: String(r.currency).trim() }));
  });
}

/** The decimal places of a currency — the step an annual total is spread in. */
export async function planningCurrencyDecimals(client: string, currency: string): Promise<number> {
  return withTenant(client, (tx) => currencyDecimals(tx, currency));
}
