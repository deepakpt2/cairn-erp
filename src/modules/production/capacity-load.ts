/**
 * Capacity load — CM01, PROD.CAPACITY.LOAD.DISPLAY. Read-only.
 *
 * This is the first place the codebase EVALUATES capacity: work_center_capacity stores available time and
 * nothing computed it before. It is a derived report and says so. There are no stored capacity
 * requirements, so requirements are recomputed on every read from the standard values on each order's
 * operations (production orders) or on its routing's operations (planned orders):
 *
 *   requirement = standard value × operation quantity ÷ base quantity
 *   available   = (end − start − breaks) × individual capacities × utilisation % × working days
 *
 * Individual capacities MULTIPLY available capacity. They would divide a scheduling *duration*, which this
 * report never computes.
 *
 * Three coarse assumptions are carried as warnings, never hidden: working days per week (no factory-calendar
 * rules are stored), the whole order's load dated at its scheduled start (operations carry no dates), and
 * time units that must match (there is no generic unit converter). Every defaulted field raises its own
 * warning. Nothing is written, cached or stored.
 */
import { sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { withTenant } from '../../platform/db/client';
import { ProductionVersionError, selectProductionVersion } from './production-version';
import { minutesBetween } from './work-center';

export const CAPACITY_LOAD_CAPABILITY = 'PROD.CAPACITY.LOAD.DISPLAY';
export const CAPACITY_LOAD_ROUTE = '/production/capacity-load';
export const CAPACITY_LOAD_ALIAS = 'CM01';
/** Work centres scanned when the caller names no limit. */
export const CAPACITY_LOAD_DEFAULT_LIMIT = 200;
/** The most work centres one scan may be asked for. Above it is refused, never clamped. */
export const CAPACITY_LOAD_LIMIT_CEILING = 1000;
export const DEFAULT_WORKING_DAYS_PER_WEEK = 5;
export const CAPACITY_PERIODS = ['DAY', 'WEEK', 'MONTH'] as const;
export const CAPACITY_ORDER_STATUSES = ['CREATED', 'RELEASED'] as const;
/** The key of the per-work-centre row that gathers load no capacity could be attributed to. */
export const UNASSIGNED_CATEGORY = '';

export type CapacityPeriod = (typeof CAPACITY_PERIODS)[number];

export class CapacityLoadError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'CapacityLoadError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy: string): never {
  throw new CapacityLoadError(message, remedy);
}

export interface CapacityLoadQuery {
  client: string;
  plant: string;
  workCenterFrom?: string | null;
  workCenterTo?: string | null;
  capacityCategory?: string | null;
  dateFrom: string;
  dateTo: string;
  period?: CapacityPeriod;
  workingDaysPerWeek?: number | null;
  includePlannedOrders?: boolean;
  statuses?: string[];
  limit?: number | null;
}

export type CapacityWarningCode =
  | 'CAPACITY_WORKING_DAYS_ASSUMED' | 'CAPACITY_ORDER_DATES_COARSE' | 'CAPACITY_LOAD_TRUNCATED'
  | 'CAPACITY_NO_TIMES' | 'CAPACITY_NO_UTILISATION' | 'CAPACITY_NO_INDIVIDUAL' | 'CAPACITY_NO_CALENDAR'
  | 'CAPACITY_UNIT_MISMATCH' | 'CAPACITY_UNIT_UNSTATED' | 'CAPACITY_NO_BASE_QTY' | 'CAPACITY_UNASSIGNED_LOAD'
  | 'CAPACITY_MIXED_UNITS' | 'PLANNED_NO_VERSION';

export interface CapacityWarning {
  code: CapacityWarningCode;
  scope: 'HEADER' | 'ROW';
  workCenter?: string;
  capacityCategory?: string;
  message: string;
}

export interface CapacityLoadCell { period: string; available: number; required: number; loadPercent: number | null }

export interface CapacityLoadRow {
  workCenter: string;
  workCenterDescription: string;
  capacityCategory: string;
  capacityDescription: string | null;
  /** True for the row that gathers load no capacity could be attributed to. */
  unassigned: boolean;
  /** True when the capacity has no operating times: its available capacity is UNKNOWN, shown as zero. */
  availableUnknown: boolean;
  /** Null means the unit is not stated anywhere (see CAPACITY_UNIT_UNSTATED). */
  unit: string | null;
  cells: CapacityLoadCell[];
  total: { available: number; required: number; loadPercent: number | null };
  warnings: CapacityWarning[];
}

export interface CapacityLoadReport {
  plant: string;
  dateFrom: string;
  dateTo: string;
  period: CapacityPeriod;
  workingDaysPerWeek: number;
  periods: string[];
  /** The dates each period column covers, clipped to the selection, for drilling through. */
  periodRanges: Record<string, { from: string; to: string; days: number }>;
  rows: CapacityLoadRow[];
  totals: { available: number; required: number; loadPercent: number | null };
  scanned: { workCenters: number; orders: number; plannedOrders: number };
  warnings: CapacityWarning[];
  truncated: boolean;
  notScanned: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dates and buckets
// ─────────────────────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkDate(value: string, label: string): string {
  const parsed = ISO_DATE.test(String(value)) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(`${label} ${value} is not a calendar date.`, 'Use the format YYYY-MM-DD.');
  }
  return value;
}

const DAY_MS = 86_400_000;
const toTime = (d: string) => new Date(`${d}T00:00:00Z`).getTime();
const toDate = (t: number) => new Date(t).toISOString().slice(0, 10);

/** ISO 8601 week key, `YYYY-Www`. */
export function isoWeekKey(date: string): string {
  const t = new Date(`${date}T00:00:00Z`);
  const day = (t.getUTCDay() + 6) % 7; // Monday = 0
  t.setUTCDate(t.getUTCDate() - day + 3); // the Thursday of this week decides the year
  const year = t.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((t.getTime() - firstThursday.getTime()) / DAY_MS - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function bucketKey(date: string, period: CapacityPeriod): string {
  if (period === 'DAY') return date;
  if (period === 'MONTH') return date.slice(0, 7);
  return isoWeekKey(date);
}

// ─────────────────────────────────────────────────────────────────────────────
// Arithmetic
// ─────────────────────────────────────────────────────────────────────────────

/** Minutes of capacity one working day provides, or null when the operating times are not stated. */
export function effectiveDailyMinutes(c: {
  startTime: string | null; endTime: string | null; breakMinutes: number;
  individualCapacities: number | null; utilization: number | null;
}): number | null {
  if (!c.startTime || !c.endTime) return null;
  const daily = minutesBetween(c.startTime, c.endTime) - c.breakMinutes;
  return (daily * (c.individualCapacities ?? 1) * (c.utilization ?? 100)) / 100;
}

/** standard value × operation quantity ÷ base quantity. Null when the base quantity is absent or zero. */
export function requirementOf(value: number, operationQuantity: number, baseQuantity: number | null): number | null {
  if (baseQuantity == null || !(baseQuantity > 0)) return null;
  return (value * operationQuantity) / baseQuantity;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const percent = (required: number, available: number): number | null => (available > 0 ? Math.round((required / available) * 100) : null);

// ─────────────────────────────────────────────────────────────────────────────
// The report
// ─────────────────────────────────────────────────────────────────────────────

interface CapacityRow {
  workCenter: string; description: string; category: string; capacityDescription: string | null;
  calendar: string | null; baseUnit: string | null; parameter: string | null;
  startTime: string | null; endTime: string | null; breakMinutes: number;
  utilization: number | null; individualCapacities: number | null;
}

interface Acc {
  row: CapacityRow | null; // null for an unassigned row
  workCenter: string; description: string;
  unit: string | null;
  required: Map<string, number>;
  warnings: CapacityWarning[];
  seen: Set<string>;
}

interface Operation {
  workCenter: string;
  start: string;
  quantity: number; // operation quantity, or the order's
  baseQuantity: number | null;
  values: Array<{ parameter: string; quantity: number; unit: string }>;
}

export async function loadCapacityReport(input: CapacityLoadQuery, capabilities: string[]): Promise<CapacityLoadReport> {
  // 1. Authority, before any read.
  if (!hasCapability(capabilities, CAPACITY_LOAD_CAPABILITY)) {
    fail(`You do not hold ${CAPACITY_LOAD_CAPABILITY}.`, 'Ask an administrator for the authority to display capacity load.');
  }
  const client = input.client;
  const plant = String(input.plant ?? '').trim().toUpperCase();
  const period = input.period ?? 'WEEK';
  const wdpw = input.workingDaysPerWeek ?? DEFAULT_WORKING_DAYS_PER_WEEK;
  const limit = input.limit ?? CAPACITY_LOAD_DEFAULT_LIMIT;
  const wcFrom = (input.workCenterFrom ?? '').trim().toUpperCase();
  const wcTo = (input.workCenterTo ?? '').trim().toUpperCase();
  const category = (input.capacityCategory ?? '').trim().toUpperCase();
  const statuses = input.statuses && input.statuses.length > 0 ? [...new Set(input.statuses)] : [...CAPACITY_ORDER_STATUSES];
  const includePlanned = input.includePlannedOrders ?? true;

  return withTenant(client, async (tx) => {
    // 2.–7. Validation, in the stated order.
    if (!plant) fail('A plant is required.', 'The report is of one plant.');
    const [stands] = (await tx.execute(sql`select 1 as hit from plant where client = ${client} and plant = ${plant} limit 1`)) as unknown as Array<{ hit: number }>;
    if (!stands) fail(`Plant ${plant} does not stand.`, 'Choose a plant that exists.');
    checkDate(input.dateFrom, 'The from date');
    checkDate(input.dateTo, 'The to date');
    if (input.dateTo < input.dateFrom) fail(`The to date ${input.dateTo} is before the from date ${input.dateFrom}.`, 'Put the earlier date first.');
    if (wcFrom && wcTo && wcFrom > wcTo) fail(`Work center from ${wcFrom} is later than work center to ${wcTo}.`, 'Put the lower work center first.');
    if (!(CAPACITY_PERIODS as readonly string[]).includes(period)) fail(`Period ${period} is not one this report shows.`, `Choose ${CAPACITY_PERIODS.join(', ')}.`);
    if (!Number.isInteger(wdpw) || wdpw < 1 || wdpw > 7) fail(`Working days per week ${wdpw} is not a whole number from 1 to 7.`, 'Enter 1 to 7.');
    if (!Number.isInteger(limit) || limit < 1) fail('The number of work centers to scan must be a positive whole number.', `Enter a number from 1 to ${CAPACITY_LOAD_LIMIT_CEILING}.`);
    if (limit > CAPACITY_LOAD_LIMIT_CEILING) {
      fail(`A scan of ${limit} work centers is above the ceiling of ${CAPACITY_LOAD_LIMIT_CEILING}.`, `Ask for at most ${CAPACITY_LOAD_LIMIT_CEILING}, or narrow the work center range and scan in steps.`);
    }
    for (const s of statuses) {
      if (!(CAPACITY_ORDER_STATUSES as readonly string[]).includes(s)) fail(`Order status ${s} is not one this report counts.`, `Choose ${CAPACITY_ORDER_STATUSES.join(' and ')}.`);
    }

    // The full axis first: an empty period is an empty column, not a gap.
    const periods: string[] = [];
    const periodRanges: CapacityLoadReport['periodRanges'] = {};
    for (let t = toTime(input.dateFrom); t <= toTime(input.dateTo); t += DAY_MS) {
      const date = toDate(t);
      const key = bucketKey(date, period);
      if (!periodRanges[key]) { periods.push(key); periodRanges[key] = { from: date, to: date, days: 0 }; }
      periodRanges[key].to = date;
      periodRanges[key].days += 1;
    }

    // Work centres and their capacities, bounded by the limit on work centres.
    const caps = (await tx.execute(sql`
      select c.work_center, w.description, c.capacity_category, c.description as capacity_description, c.factory_calendar, c.base_unit,
             c.standard_value_parameter, c.start_time, c.end_time, c.break_minutes, c.utilization::float8 as utilization, c.individual_capacities
        from work_center_capacity c
        join work_center w on w.client = c.client and w.plant = c.plant and w.work_center = c.work_center
       where c.client = ${client} and c.plant = ${plant} and w.deletion_flag = ' '
         and (${wcFrom || null}::varchar is null or c.work_center >= ${wcFrom || null})
         and (${wcTo || null}::varchar is null or c.work_center <= ${wcTo || null})
         and (${category || null}::varchar is null or c.capacity_category = ${category || null})
       order by c.work_center, c.capacity_category
    `)) as unknown as Array<Record<string, unknown>>;
    const allCenters = [...new Set(caps.map((r) => String(r.work_center)))];
    const centers = new Set(allCenters.slice(0, limit));
    const notScanned = allCenters.length - centers.size;
    const capRows: CapacityRow[] = caps.filter((r) => centers.has(String(r.work_center))).map((r) => ({
      workCenter: String(r.work_center), description: String(r.description), category: String(r.capacity_category),
      capacityDescription: (r.capacity_description as string | null) ?? null,
      calendar: (r.factory_calendar as string | null)?.trim() || null, baseUnit: (r.base_unit as string | null) ?? null,
      parameter: (r.standard_value_parameter as string | null) ?? null,
      startTime: (r.start_time as string | null) ?? null, endTime: (r.end_time as string | null) ?? null,
      breakMinutes: Number(r.break_minutes), utilization: r.utilization == null ? null : Number(r.utilization),
      individualCapacities: r.individual_capacities == null ? null : Number(r.individual_capacities),
    }));
    const centerList = [...centers];

    // Operations: orders (production) first. Capacity is resolved at the OPERATION's work center plant, so an
    // order of another plant that loads this plant's work center is counted.
    const operations: Operation[] = [];
    const orderNumbers = new Set<string>();
    if (centerList.length > 0) {
      const ops = (await tx.execute(sql`
        select o.order_number, o.operation_number, o.work_center, p.scheduled_start,
               coalesce(o.operation_quantity, p.order_quantity)::float8 as quantity, o.base_quantity::float8 as base_quantity
          from production_order_operation o
          join production_order p on p.client = o.client and p.order_number = o.order_number
         where o.client = ${client} and o.work_center_plant = ${plant} and o.work_center is not null
           and o.work_center in ${sql`(${sql.join(centerList.map((c) => sql`${c}`), sql`, `)})`}
           and p.status in ${sql`(${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})`}
           and p.scheduled_start >= ${input.dateFrom} and p.scheduled_start <= ${input.dateTo}
      `)) as unknown as Array<Record<string, unknown>>;
      const vals = ops.length === 0 ? [] : (await tx.execute(sql`
        select v.order_number, v.operation_number, v.parameter, v.quantity::float8 as quantity, v.unit
          from production_order_operation_value v
          join production_order p on p.client = v.client and p.order_number = v.order_number
         where v.client = ${client} and v.quantity is not null
           and p.status in ${sql`(${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})`}
           and p.scheduled_start >= ${input.dateFrom} and p.scheduled_start <= ${input.dateTo}
      `)) as unknown as Array<Record<string, unknown>>;
      const byOp = new Map<string, Operation['values']>();
      for (const v of vals) {
        const key = `${v.order_number}/${v.operation_number}`;
        if (!byOp.has(key)) byOp.set(key, []);
        byOp.get(key)!.push({ parameter: String(v.parameter), quantity: Number(v.quantity), unit: String(v.unit) });
      }
      for (const o of ops) {
        orderNumbers.add(String(o.order_number));
        operations.push({
          workCenter: String(o.work_center), start: String(o.scheduled_start), quantity: Number(o.quantity),
          baseQuantity: o.base_quantity == null ? null : Number(o.base_quantity),
          values: byOp.get(`${o.order_number}/${o.operation_number}`) ?? [],
        });
      }
    }

    // Planned orders have no operations: load is reached through the production version's routing.
    let plannedScanned = 0;
    let plannedNoVersion = 0;
    if (includePlanned && centerList.length > 0) {
      const planned = (await tx.execute(sql`
        select order_number, material_number, plant, quantity::float8 as quantity, unit, start_date::text as start_date
          from planned_order
         where client = ${client} and start_date >= ${input.dateFrom}::date and start_date <= ${input.dateTo}::date
         order by order_number
      `)) as unknown as Array<Record<string, unknown>>;
      for (const po of planned) {
        let version;
        try {
          version = await selectProductionVersion(client, {
            materialNumber: String(po.material_number), plant: String(po.plant), keyDate: String(po.start_date),
            quantity: String(po.quantity), unit: String(po.unit), context: 'PLANNING',
          }, tx);
        } catch (error) {
          if (!(error instanceof ProductionVersionError)) throw error;
          plannedNoVersion += 1;
          continue;
        }
        const ro = (await tx.execute(sql`
          select o.operation_number, o.work_center, o.base_quantity::float8 as base_quantity
            from routing_operation o
           where o.client = ${client} and o.task_list_type = ${version.taskListType} and o.routing_group = ${version.routingGroup}
             and o.group_counter = ${version.groupCounter} and o.deletion_flag = ' ' and o.plant = ${plant} and o.work_center is not null
             and o.work_center in ${sql`(${sql.join(centerList.map((c) => sql`${c}`), sql`, `)})`}
             and o.valid_from <= ${String(po.start_date)}::date and o.valid_to >= ${String(po.start_date)}::date
        `)) as unknown as Array<Record<string, unknown>>;
        if (ro.length === 0) continue;
        plannedScanned += 1;
        const rv = (await tx.execute(sql`
          select operation_number, parameter, quantity::float8 as quantity, unit
            from routing_operation_value
           where client = ${client} and task_list_type = ${version.taskListType} and routing_group = ${version.routingGroup} and group_counter = ${version.groupCounter}
        `)) as unknown as Array<Record<string, unknown>>;
        for (const o of ro) {
          operations.push({
            workCenter: String(o.work_center), start: String(po.start_date),
            // A routing operation's quantity is the routing's own base, not this order's: the planned quantity scales it.
            quantity: Number(po.quantity),
            baseQuantity: o.base_quantity == null ? null : Number(o.base_quantity),
            values: rv.filter((v) => v.operation_number === o.operation_number)
              .map((v) => ({ parameter: String(v.parameter), quantity: Number(v.quantity), unit: String(v.unit) })),
          });
        }
      }
    }

    // Accumulators: one per capacity, plus one Unassigned per work centre that has an unmapped capacity.
    const accs = new Map<string, Acc>();
    for (const r of capRows) {
      accs.set(`${r.workCenter}|${r.category}`, { row: r, workCenter: r.workCenter, description: r.description, unit: r.baseUnit, required: new Map(), warnings: [], seen: new Set() });
    }
    const unassignedCenters = new Set(capRows.filter((r) => !r.parameter).map((r) => r.workCenter));
    for (const wc of unassignedCenters) {
      const d = capRows.find((r) => r.workCenter === wc)!.description;
      accs.set(`${wc}|${UNASSIGNED_CATEGORY}`, { row: null, workCenter: wc, description: d, unit: null, required: new Map(), warnings: [], seen: new Set() });
    }
    const warnOnce = (acc: Acc, w: CapacityWarning) => {
      const k = `${w.code}|${w.message}`;
      if (acc.seen.has(k)) return;
      acc.seen.add(k);
      acc.warnings.push(w);
    };
    const contribute = (acc: Acc, op: Operation, param: string, quantity: number, unit: string, label: string) => {
      const req = requirementOf(quantity, op.quantity, op.baseQuantity);
      const where = { workCenter: acc.workCenter, capacityCategory: acc.row?.category ?? UNASSIGNED_CATEGORY, scope: 'ROW' as const };
      if (req == null) {
        warnOnce(acc, { ...where, code: 'CAPACITY_NO_BASE_QTY', message: `Work center ${acc.workCenter}: an operation has no base quantity, so its ${param} value was skipped rather than treated as per-unit.` });
        return;
      }
      if (acc.unit == null) {
        acc.unit = unit;
        if (acc.row) warnOnce(acc, { ...where, code: 'CAPACITY_UNIT_UNSTATED', message: `${label} states no capacity unit, so ${unit} (the first contribution's unit) is used; contributions in another unit are excluded.` });
      } else if (unit !== acc.unit) {
        warnOnce(acc, { ...where, code: 'CAPACITY_UNIT_MISMATCH', message: `${label}: parameter ${param} is in ${unit} but the capacity is measured in ${acc.unit}. No conversion is made, so the contribution is excluded.` });
        return;
      }
      const key = bucketKey(op.start, period);
      acc.required.set(key, (acc.required.get(key) ?? 0) + req);
    };

    for (const op of operations) {
      const mapped = capRows.filter((r) => r.workCenter === op.workCenter && r.parameter);
      const claimed = new Set(mapped.map((r) => r.parameter));
      for (const cap of mapped) {
        const value = op.values.find((v) => v.parameter === cap.parameter);
        if (!value) continue;
        contribute(accs.get(`${cap.workCenter}|${cap.category}`)!, op, cap.parameter!, value.quantity, value.unit, `Capacity ${cap.category} of work center ${cap.workCenter}`);
      }
      const un = accs.get(`${op.workCenter}|${UNASSIGNED_CATEGORY}`);
      if (un) {
        for (const v of op.values) {
          if (claimed.has(v.parameter)) continue;
          contribute(un, op, v.parameter, v.quantity, v.unit, `Work center ${op.workCenter}`);
        }
      }
    }

    // Rows.
    const rows: CapacityLoadRow[] = [];
    for (const acc of accs.values()) {
      const r = acc.row;
      const where = { workCenter: acc.workCenter, capacityCategory: r?.category ?? UNASSIGNED_CATEGORY, scope: 'ROW' as const };
      const daily = r ? effectiveDailyMinutes(r) : 0;
      const rowWarnings = [...acc.warnings];
      if (r) {
        if (daily == null) rowWarnings.push({ ...where, code: 'CAPACITY_NO_TIMES', message: `Capacity ${r.category} of work center ${r.workCenter} has no operating times, so its available capacity is shown as zero. Maintain start and finish times on CR02.` });
        if (r.utilization == null) rowWarnings.push({ ...where, code: 'CAPACITY_NO_UTILISATION', message: `Capacity ${r.category} of work center ${r.workCenter} states no utilisation, so 100% is used.` });
        if (r.individualCapacities == null) rowWarnings.push({ ...where, code: 'CAPACITY_NO_INDIVIDUAL', message: `Capacity ${r.category} of work center ${r.workCenter} states no individual capacities, so 1 is used.` });
        if (!r.calendar) rowWarnings.push({ ...where, code: 'CAPACITY_NO_CALENDAR', message: `Capacity ${r.category} of work center ${r.workCenter}: no factory calendar is assigned, and no calendar rules are stored anywhere, so non-working days cannot be excluded.` });
      }
      let totalAvailable = 0;
      let totalRequired = 0;
      const cells = periods.map((p) => {
        const workingDays = Math.round((periodRanges[p].days * wdpw) / 7);
        const available = (daily ?? 0) * workingDays;
        const required = acc.required.get(p) ?? 0;
        totalAvailable += available;
        totalRequired += required;
        return { period: p, available: round3(available), required: round3(required), loadPercent: percent(required, available) };
      });
      if (!r && totalRequired > 0) {
        rowWarnings.push({ ...where, code: 'CAPACITY_UNASSIGNED_LOAD', message: `Work center ${acc.workCenter}: ${round3(totalRequired)} ${acc.unit ?? ''} of load could not be attributed to a capacity, because the capacity carries no standard value parameter.`.replace('  ', ' ') });
      }
      if (!r && totalRequired === 0) continue; // nothing unattributed: no row
      rows.push({
        workCenter: acc.workCenter, workCenterDescription: acc.description,
        capacityCategory: r?.category ?? UNASSIGNED_CATEGORY, capacityDescription: r?.capacityDescription ?? null,
        unassigned: !r, availableUnknown: r ? daily == null : false, unit: acc.unit, cells,
        total: { available: round3(totalAvailable), required: round3(totalRequired), loadPercent: percent(totalRequired, totalAvailable) },
        warnings: rowWarnings,
      });
    }
    rows.sort((a, b) => (a.workCenter < b.workCenter ? -1 : a.workCenter > b.workCenter ? 1 : a.unassigned === b.unassigned ? (a.capacityCategory < b.capacityCategory ? -1 : 1) : a.unassigned ? 1 : -1));

    // Totals only mean something in one unit.
    const units = new Set(rows.map((r) => r.unit).filter((u): u is string => u != null));
    const available = rows.reduce((n, r) => n + r.total.available, 0);
    const required = rows.reduce((n, r) => n + r.total.required, 0);
    const mixed = units.size > 1;

    const header: CapacityWarning[] = [
      { code: 'CAPACITY_WORKING_DAYS_ASSUMED', scope: 'HEADER', message: `Available capacity uses ${wdpw} working days per week, because no factory-calendar rules are stored. Non-working days are not excluded. Change the figure on the selection screen to match your plant. (Working days in a period are round(calendar days × ${wdpw} ÷ 7): a proportion, not a promise about which days.)` },
      { code: 'CAPACITY_ORDER_DATES_COARSE', scope: 'HEADER', message: "Load is dated at the order's scheduled start, because operations carry no scheduled dates. Peaks are overstated." },
    ];
    if (plannedNoVersion > 0) header.push({ code: 'PLANNED_NO_VERSION', scope: 'HEADER', message: `${plannedNoVersion} planned order${plannedNoVersion === 1 ? ' has' : 's have'} no selectable production version and contribute${plannedNoVersion === 1 ? 's' : ''} no load.` });
    if (notScanned > 0) header.push({ code: 'CAPACITY_LOAD_TRUNCATED', scope: 'HEADER', message: `${notScanned} work center${notScanned === 1 ? ' was' : 's were'} not scanned. The scan limit is ${limit}.` });
    if (mixed) header.push({ code: 'CAPACITY_MIXED_UNITS', scope: 'HEADER', message: `The rows are measured in more than one unit (${[...units].join(', ')}), so no overall load percentage is given.` });

    return {
      plant, dateFrom: input.dateFrom, dateTo: input.dateTo, period, workingDaysPerWeek: wdpw, periods, periodRanges, rows,
      totals: { available: round3(available), required: round3(required), loadPercent: mixed ? null : percent(required, available) },
      scanned: { workCenters: centers.size, orders: orderNumbers.size, plannedOrders: plannedScanned },
      warnings: [...header, ...rows.flatMap((r) => r.warnings)],
      truncated: notScanned > 0, notScanned,
    };
  });
}

/** COOIS (order information), the production order list for a cell's period, dated by scheduled start. */
export function drillDownFor(plant: string, range: { from: string; to: string }): string {
  const query = new URLSearchParams({
    selection: 'PRODUCTION_ORDER:HEADERS', run: '1', plant, dateBasis: 'SCHEDULED_START', dateFrom: range.from, dateTo: range.to,
  });
  return `/production/order-information?${query.toString()}`;
}
