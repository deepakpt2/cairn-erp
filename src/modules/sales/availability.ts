/**
 * What the plant can promise — the availability check and the schedule line it writes (SAP: ATP, VBEP).
 *
 * An order asked for a quantity and got it. Nothing between the customer's request and the delivery
 * ever asked whether the goods were there: the order line carried one quantity, and the delivery
 * offered whatever was left of it. A plant that could supply six of the ten a customer ordered had no
 * way to say so, and no way to say it differently a week later when the rest arrived.
 *
 * So the order line gains a second quantity. A schedule line says what was asked for and by when, and
 * what the check confirmed against it. The delivery is created from what was confirmed and not from
 * what was ordered, so a plant that can supply six ships six and owes four, and the due list says so.
 *
 * The check reads the masters that already stand rather than new ones. The checking group comes from
 * the material's sales view, which is where SAP reads it; the checking rule and the scope of check are
 * the production module's OVZ2 / OPJL / OVZ9 masters, maintained at /config/availability-check,
 * because a plant's promise is one question whether an order asks it or a production release does.
 *
 * Two rules it keeps.
 *
 * A material with no checking group is not checked. Confirming nothing for a customer who was never
 * to be checked would be a promise broken for want of a configuration the tenant never asked for.
 *
 * And a scope the check cannot count is a refusal, not a silence. Stock, the elements the scope selects
 * (purchase orders and requisitions, planned and production orders, dependent requirements, reservations,
 * counted by date in the base unit) and the promises other orders hold are all counted; restricted-use
 * stock has no store here and a scope asking for it is refused. Counting less than the scope asked for
 * without saying so is how a plant promises goods it has not found.
 *
 * Unit and horizon. Every counted element is brought into the base unit, and one that cannot be converted
 * is refused naming the row. The search for supply is bounded: a year past the latest date asked for,
 * and the stock/requirements list's own hit limit — a promise is never made from an unbounded search.
 *
 * Nothing in THIS module writes to `planning_file`. Sales demand reaches MD04 and MRP through `sales-demand.ts`
 * (requested open quantity, not the confirmed one); the order, delivery and goods-issue services mark the planning
 * file. This check still counts other orders' promises itself (`promisedToOthers`) and selects only the supply and
 * requirement elements its scope names, so the new SALES_ORDER element is never counted a second time here.
 */
import { and, eq, sql } from 'drizzle-orm';

import { withTenant, type Tx } from '../../platform/db/client';
import { materialPlant, materialSales } from '../inventory/schema';
import {
  availabilityCheckScope, availabilityCheckingGroup, availabilityCheckingRule,
} from '../production/schema';
import { elementUnitKey, resolveElementUnits, scopeDocumentStates } from '../production/order-availability';
import { StockRequirementsError, stockRequirementsListForProvisioning } from '../production/stock-requirements';
import { salesOrderSchedule } from './schema';

export const AVAILABILITY_ROUTE = '/config/availability-check';
/**
 * OPJL. The business context the check runs in, and the two characters the master carries: an order is
 * created under OR, a delivery under LF — the same two keys the sales document types are numbered by.
 * The rule is not a material field and not a checking group; it is the half of the scope's key that
 * says who is asking, and a tenant that wants the door checked differently from the order says so
 * here by maintaining a different scope against the same group.
 */
export const ORDER_CHECKING_RULE = 'OR';
export const DELIVERY_CHECKING_RULE = 'LF';

/** Why a check was refused, for a caller that reports it per line instead of throwing it. */
export type AvailabilityRefusal = 'NOT_CONFIGURED' | 'NO_SCOPE' | 'SCOPE_UNSUPPORTED' | 'UNIT_CONVERSION' | 'SUPPLY_LIST';

export class AvailabilityError extends Error {
  remedy?: string;
  code: AvailabilityRefusal;
  constructor(message: string, remedy?: string, code: AvailabilityRefusal = 'NOT_CONFIGURED') {
    super(message);
    this.name = 'AvailabilityError';
    this.remedy = remedy;
    this.code = code;
  }
}

/** One dated element the scope of check counted, in the material's base unit. */
export interface SupplyElement {
  date: string;
  elementType: string;
  direction: 'RECEIPT' | 'REQUIREMENT';
  documentNumber: string;
  documentItem: string;
  quantity: number;
}

export interface AvailabilityResult {
  checkingGroup: string;
  checkingRule: string;
  /** What the plant can promise at `date`, in the material's base unit, never below zero. */
  available: number;
  /** The date `available` stands at: today, unless the caller asked for another. */
  date: string;
  stockOnHand: number;
  safetyStock: number;
  /** What other open orders have already been promised and not yet delivered. */
  promisedToOthers: number;
  /** Stock less safety stock less promises, before any dated element: the level supply moves up and down. */
  baseline: number;
  /** The dated elements the scope counted, oldest first. Empty when the scope counts none. */
  elements: SupplyElement[];
  /** The last date the element search covered; null when no element was searched for. */
  horizonEnd: string | null;
  /** True when the list reached its hit limit, so the search ends at the last element it returned. */
  truncated: boolean;
  /** Whether a scope row stood for the group and rule. A missing row counts stock and promises only. */
  scopeStood: boolean;
}

/** What a schedule line says: what was asked for and by when, and what the check confirmed. */
export interface ScheduleLine {
  scheduleNumber: number;
  requestedDate: string;
  requestedQuantity: string;
  confirmedQuantity: string;
  confirmedDate: string | null;
}

/** How far past the latest date asked for the search for supply goes, when the caller names no horizon. */
export const DEFAULT_HORIZON_DAYS = 365;

const todayOf = () => new Date().toISOString().slice(0, 10);

function addDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

/** The quantity standing at a date: the baseline plus every counted element dated on or before it, never below zero. */
export function availableAt(result: Pick<AvailabilityResult, 'baseline' | 'elements'>, date: string): number {
  let level = result.baseline;
  for (const element of result.elements) {
    if (element.date > date) break;
    level += element.direction === 'RECEIPT' ? element.quantity : -element.quantity;
  }
  return round3(Math.max(0, level));
}

/**
 * The available quantity of a material at a plant, under the scope of check the tenant maintains.
 *
 * Returns null where the material carries no checking group, or where its group is maintained with
 * the no-check indicator set: either is a decision that this material is not checked, and a check
 * that answers anyway is a promise nobody asked for.
 *
 * Supply over time: when the scope counts purchase orders, requisitions, planned or production orders,
 * dependent requirements or reservations, the stock/requirements list is read for them, each element
 * is brought into the base unit (one it cannot convert is refused by name), and the quantity at a date
 * is the baseline plus what stands by then. A scope that counts none of them never reads the list and
 * answers exactly as before.
 */
export async function availableToPromise(
  tx: Tx,
  client: string,
  input: {
    materialNumber: string;
    plant: string;
    salesOrg: string;
    distributionChannel: string;
    checkingRule: string;
    /** The document whose own promise is not counted against itself. */
    exclude?: { orderNumber: string };
    /** The date `available` is read at. Default: today. */
    date?: string;
    /** The last date the search for supply covers. Default: a year past the date. */
    horizonEnd?: string;
    /** True when the rule was named by the document type; then a scope row must stand for it. */
    ruleNamed?: boolean;
  },
): Promise<AvailabilityResult | null> {
  const [view] = await tx.select({ group: materialSales.availabilityCheckGroup })
    .from(materialSales).where(and(
      eq(materialSales.client, client),
      eq(materialSales.materialNumber, input.materialNumber),
      eq(materialSales.salesOrg, input.salesOrg),
      eq(materialSales.distributionChannel, input.distributionChannel),
    )).limit(1);
  let group = (view?.group ?? '').trim().toUpperCase();
  if (!group) {
    // Where the sales view names none, the plant view answers: it is where the production module's
    // OVZ9 assignment lands, and both are the tenant saying "check this material". A material is not
    // left unchecked because the answer was written on the other screen.
    const [atPlant] = await tx.select({ group: materialPlant.checkingGroup }).from(materialPlant)
      .where(and(
        eq(materialPlant.client, client),
        eq(materialPlant.materialNumber, input.materialNumber),
        eq(materialPlant.plant, input.plant),
      )).limit(1);
    group = (atPlant?.group ?? '').trim().toUpperCase();
  }
  if (!group) return null;

  const [groupRow] = await tx.select().from(availabilityCheckingGroup).where(and(
    eq(availabilityCheckingGroup.client, client),
    eq(availabilityCheckingGroup.checkingGroup, group),
  )).limit(1);
  if (!groupRow) {
    throw new AvailabilityError(
      `Material ${input.materialNumber} carries checking group ${group}, and no such group stands.`,
      `Maintain checking group ${group} at ${AVAILABILITY_ROUTE}, or clear it from the material's sales view. A group that does not stand is not a check.`,
    );
  }
  if (groupRow.noCheck === 'X') return null;

  const rule = input.checkingRule.trim().toUpperCase();
  const [ruleRow] = await tx.select().from(availabilityCheckingRule).where(and(
    eq(availabilityCheckingRule.client, client),
    eq(availabilityCheckingRule.checkingRule, rule),
  )).limit(1);
  if (!ruleRow) {
    throw new AvailabilityError(
      `No checking rule ${rule} stands, so the availability of ${input.materialNumber} cannot be checked.`,
      `Maintain checking rule ${rule} at ${AVAILABILITY_ROUTE}: ${rule === ORDER_CHECKING_RULE ? 'OR is the context an order is created in' : rule === DELIVERY_CHECKING_RULE ? 'LF is the context a delivery is created in' : 'it is the rule the sales document type names'}.`,
    );
  }

  const [scope] = await tx.select().from(availabilityCheckScope).where(and(
    eq(availabilityCheckScope.client, client),
    eq(availabilityCheckScope.checkingGroup, group),
    eq(availabilityCheckScope.checkingRule, rule),
  )).limit(1);
  if (!scope && input.ruleNamed) {
    // A missing scope is not an empty scope. The default rule has always counted stock and promises
    // without one and keeps doing so; a rule a document type names is a configuration, and one with no
    // scope behind it is a configuration that was not finished.
    throw new AvailabilityError(
      `No scope of check stands for checking group ${group} and rule ${rule}, which the sales document type names, so the availability of ${input.materialNumber} cannot be checked.`,
      `Maintain the scope of check for group ${group} and rule ${rule} at ${AVAILABILITY_ROUTE}. A missing scope is not an empty one.`,
      'NO_SCOPE',
    );
  }

  // What the scope asks for that this check cannot count. Restricted-use stock has no store here; every
  // other flag is counted. Counting less than the scope asked for without saying so is how a plant
  // promises goods it has not found.
  const flagged = (value: string | undefined) => (value ?? '').trim() !== '';
  if (flagged(scope?.includeRestrictedUse)) {
    throw new AvailabilityError(
      `The scope of check for group ${group} and rule ${rule} asks the check to count restricted-use stock, and no stock is held in that bucket.`,
      `Clear it at ${AVAILABILITY_ROUTE}: a check that counts less than it was configured to count promises goods it has not found.`,
      'SCOPE_UNSUPPORTED',
    );
  }

  // Warehouse stock. Returns stock is never counted: goods a customer sent back are not the
  // company's to promise until they have been inspected and transferred out of that bucket.
  const types = ['UNRESTRICTED'];
  if (flagged(scope?.includeQualityStock)) types.push('QUALITY');
  if (flagged(scope?.includeBlockedStock)) types.push('BLOCKED');
  // The stock types are this module's own vocabulary and nothing a caller can put a character into,
  // so the list is written into the statement rather than bound as a parameter that would have to be
  // repeated once per type.
  const stockTypes = sql.raw(`(${types.map((type) => `'${type}'`).join(', ')})`);
  const stockRows = await (tx.execute(sql`
    select coalesce(sum(s.quantity), 0)::text as quantity
      from stock_quantity s
     where s.client = ${client} and s.material_number = ${input.materialNumber}
       and s.plant = ${input.plant} and s.stock_type in ${stockTypes}
  `) as unknown as Promise<Array<{ quantity: string }>>);
  const stockOnHand = Number(stockRows[0]?.quantity ?? '0');

  // The flag reads as an inclusion and acts as a deduction: with it set, the reserve is not available
  // and comes off. MD04 and the production check read it the same way.
  let safetyStock = 0;
  if (flagged(scope?.includeSafetyStock)) {
    const [plantRow] = await tx.select({ safetyStock: materialPlant.safetyStock }).from(materialPlant)
      .where(and(eq(materialPlant.client, client),
        eq(materialPlant.materialNumber, input.materialNumber),
        eq(materialPlant.plant, input.plant))).limit(1);
    safetyStock = Number(plantRow?.safetyStock ?? '0');
  }

  // What other open orders have already been promised and not shipped. Promising the same stock twice
  // is the one failure an availability check exists to prevent, so it counts unless the scope says
  // otherwise (Sales requirements blank): what the promise is, not a stream of supply.
  let promisedToOthers = 0;
  if (scope?.salesRequirements !== ' ') {
    const promisedRows = await (tx.execute(sql`
      select coalesce(sum(greatest(coalesce(sch.confirmed_quantity, 0) - coalesce(d.delivered, 0), 0)), 0)::text as promised
        from sales_order_schedule sch
        join sales_order_line l
          on l.client = sch.client and l.order_number = sch.order_number
         and l.line_number = sch.order_line_number
        join sales_order o on o.client = l.client and o.order_number = l.order_number
        left join (
          select dl.client, dl.order_number, dl.order_line_number, sum(dl.delivery_quantity) as delivered
            from delivery_line dl
            join delivery dd on dd.client = dl.client and dd.delivery_number = dl.delivery_number
           where dd.status <> 'CANCELLED'
           group by 1, 2, 3
        ) d on d.client = l.client and d.order_number = l.order_number and d.order_line_number = l.line_number
       where sch.client = ${client} and l.material_number = ${input.materialNumber} and l.plant = ${input.plant}
         and o.status = 'OPEN' and l.status = 'OPEN'
         and (${input.exclude?.orderNumber ?? null}::varchar is null or o.order_number <> ${input.exclude?.orderNumber ?? null})
    `) as unknown as Promise<Array<{ promised: string }>>);
    promisedToOthers = Number(promisedRows[0]?.promised ?? '0');
  }

  const today = todayOf();
  const date = input.date ?? today;
  const supply = await countedSupply(tx, client, {
    scope, materialNumber: input.materialNumber, plant: input.plant, today,
    horizonEnd: input.horizonEnd ?? addDays(date < today ? today : date, DEFAULT_HORIZON_DAYS),
  });

  const baseline = round3(stockOnHand - safetyStock - promisedToOthers);
  const result: AvailabilityResult = {
    checkingGroup: group,
    checkingRule: rule,
    available: 0,
    date,
    stockOnHand,
    safetyStock,
    promisedToOthers,
    baseline,
    elements: supply.elements,
    horizonEnd: supply.horizonEnd,
    truncated: supply.truncated,
    scopeStood: !!scope,
  };
  result.available = availableAt(result, date);
  return result;
}

/** The elements the scope selects from the stock/requirements list, each in the base unit, oldest first. */
async function countedSupply(
  tx: Tx,
  client: string,
  input: {
    scope: typeof availabilityCheckScope.$inferSelect | undefined;
    materialNumber: string; plant: string; today: string; horizonEnd: string;
  },
): Promise<{ elements: SupplyElement[]; horizonEnd: string | null; truncated: boolean }> {
  const scope = input.scope;
  const wanted = !!scope && [
    scope.purchaseOrders, scope.purchaseRequisitions, scope.plannedOrders, scope.productionOrders,
    scope.dependentRequirements, scope.reservations,
  ].some((value) => value.trim() !== '');
  if (!scope || !wanted) return { elements: [], horizonEnd: null, truncated: false };

  let list;
  try {
    list = await stockRequirementsListForProvisioning({
      client, today: input.today,
      selection: { material: input.materialNumber, plant: input.plant, horizonEnd: input.horizonEnd, displayPastDue: true },
    });
  } catch (error) {
    if (error instanceof StockRequirementsError) {
      throw new AvailabilityError(error.message, error.remedy ?? 'Resolve the stock/requirements list for this material, then ask again.', 'SUPPLY_LIST');
    }
    throw error;
  }

  const wantedTypes = new Set<string>();
  if (scope.purchaseOrders.trim()) wantedTypes.add('PURCHASE_ORDER');
  if (scope.purchaseRequisitions.trim()) wantedTypes.add('PURCHASE_REQUISITION');
  if (scope.plannedOrders.trim()) wantedTypes.add('PLANNED_ORDER');
  if (scope.productionOrders.trim()) wantedTypes.add('PRODUCTION_ORDER');
  if (scope.dependentRequirements.trim()) { wantedTypes.add('DEPENDENT_REQUIREMENT'); wantedTypes.add('PRODUCTION_COMPONENT'); }
  if (scope.reservations.trim()) wantedTypes.add('RESERVATION');
  const candidates = list.rows.filter((row) => wantedTypes.has(row.elementType));

  // "Firmed" planned orders and "released" production orders are the narrower readings of A and F.
  const states = await scopeDocumentStates(client, candidates, {
    plannedOrders: scope.plannedOrders as 'X' | 'A' | ' ', productionOrders: scope.productionOrders as 'X' | 'F' | ' ',
  } as never, input.today);
  const counted = candidates.filter((row) => {
    if (row.elementType === 'PLANNED_ORDER' && scope.plannedOrders === 'A' && !states.firmedPlanned.has(row.documentNumber)) return false;
    if (row.elementType === 'PRODUCTION_ORDER' && scope.productionOrders === 'F' && !states.releasedProduction.has(row.documentNumber)) return false;
    // "B": future receipts only. Past requirements still count — demand already missed is not cancelled.
    if (scope.receiptsInPast === 'B' && row.direction === 'RECEIPT' && row.date < input.today) return false;
    return true;
  });

  const units = await resolveElementUnits({
    client, plant: input.plant, materialNumber: input.materialNumber, baseUnit: list.baseUnit || null, rows: counted,
  });
  if (units.blockers.length > 0) {
    throw new AvailabilityError(
      `The availability of ${input.materialNumber} cannot be counted: ${units.blockers[0]}${units.blockers.length > 1 ? ` (and ${units.blockers.length - 1} more)` : ''}.`,
      'Bring the element into the material base unit (maintain the unit conversion), or clear the element from the scope of check. A unit is never assumed.',
      'UNIT_CONVERSION',
    );
  }
  const elements: SupplyElement[] = counted
    .map((row) => ({
      date: row.date,
      elementType: row.elementType,
      direction: row.direction,
      documentNumber: row.documentNumber,
      documentItem: row.documentItem,
      quantity: round3(units.quantities.get(elementUnitKey(row))?.quantity ?? row.quantity),
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.direction === b.direction ? 0 : a.direction === 'RECEIPT' ? -1 : 1));
  const last = elements.length > 0 ? elements[elements.length - 1]!.date : input.today;
  return { elements, horizonEnd: list.truncated ? (last < input.horizonEnd ? last : input.horizonEnd) : input.horizonEnd, truncated: list.truncated };
}

/** What the check decided for one order line. Quantities in the order unit unless named base. */
export interface LinePlan {
  lineNumber: number;
  materialNumber: string;
  plant: string;
  /** False where the material is not checked (no group, or the no-check group): confirmed in full, as always. */
  checked: boolean;
  checkingGroup: string | null;
  checkingRule: string | null;
  requestedDate: string;
  /** What the plant could supply at the requested date, in the order unit, before earlier lines' promises were taken. */
  availableAtRequestedDate: number;
  confirmedQuantity: number;
  /** The date the confirmation stands at; null only where nothing was confirmed. */
  confirmedDate: string | null;
  /** Confirmed, but less than asked, at the requested date and at every date within the horizon. */
  partial: boolean;
  /** The full quantity stands, but later than asked: the confirmed date is that later date. */
  delayed: boolean;
  /** Less than the full quantity was confirmed and no date inside the horizon supplies the rest. */
  remainderUndated: boolean;
  /** The last date the search for supply covered. */
  horizonEnd: string | null;
  /** The elements that made the number, base unit. */
  basis: SupplyElement[];
  baseQuantity: number;
  baseAsked: number;
}

/**
 * What each line gets, in full: the check run once per material and plant, and the answers consumed in
 * the order the lines stand in — the first order to ask is the first to be promised, which is the only
 * rule a plant can defend when two customers want the same stock.
 *
 * Quantities are handled in the material's base unit, because that is the unit the stock is counted
 * in; the answer is handed back in the unit the line was ordered in.
 *
 * What has already gone out is not asked for again. A line with four delivered of ten is a line with
 * six still to promise. What was delivered stays confirmed, and the check answers for the rest.
 *
 * The date. The quantity stands at the requested date if it is all there. Otherwise the earliest date
 * inside the horizon at which all of it stands is the confirmed date (the plant promises all of it by
 * then — the line carries one confirmation, never a split across dates). Where it never all stands,
 * what stands at the requested date is confirmed, and the remainder has no date: the plan says so.
 */
export async function planOrderLines(
  tx: Tx,
  client: string,
  input: {
    salesOrg: string;
    distributionChannel: string;
    checkingRule: string;
    /** True when the document type named the rule (a scope row must then stand). */
    ruleNamed?: boolean;
    exclude?: { orderNumber: string };
    lines: Array<{ lineNumber: number; materialNumber: string; plant: string;
      orderQuantity: number; baseQuantity: number; requestedDate: string;
      /** Already delivered against this line, in the unit it was ordered in. */
      deliveredQuantity?: number }>;
  },
): Promise<Map<number, LinePlan>> {
  const byKey = new Map<string, typeof input.lines>();
  for (const line of input.lines) {
    const key = `${line.materialNumber}/${line.plant}`;
    byKey.set(key, [...(byKey.get(key) ?? []), line]);
  }
  const today = todayOf();
  const plans = new Map<number, LinePlan>();
  for (const bucket of byKey.values()) {
    const first = bucket[0]!;
    const latest = bucket.reduce((m, l) => (l.requestedDate > m ? l.requestedDate : m), today);
    const result = await availableToPromise(tx, client, {
      materialNumber: first.materialNumber, plant: first.plant,
      salesOrg: input.salesOrg, distributionChannel: input.distributionChannel,
      checkingRule: input.checkingRule, ...(input.exclude ? { exclude: input.exclude } : {}),
      ...(input.ruleNamed ? { ruleNamed: true } : {}),
      horizonEnd: addDays(latest, DEFAULT_HORIZON_DAYS),
    });
    let consumed = 0;
    for (const line of bucket) {
      const delivered = line.deliveredQuantity ?? 0;
      const rate = line.orderQuantity > 0 ? line.baseQuantity / line.orderQuantity : 1;
      const asked = Math.max(0, line.baseQuantity - delivered * rate);
      const toOrderUnit = (base: number) => round3(rate > 0 ? base / rate : base);
      const common = {
        lineNumber: line.lineNumber, materialNumber: line.materialNumber, plant: line.plant,
        requestedDate: line.requestedDate, baseQuantity: line.baseQuantity, baseAsked: round3(asked),
      };
      if (!result) {
        plans.set(line.lineNumber, {
          ...common, checked: false, checkingGroup: null, checkingRule: null,
          availableAtRequestedDate: line.orderQuantity, confirmedQuantity: round3(line.orderQuantity),
          confirmedDate: line.orderQuantity > 0 ? line.requestedDate : null,
          partial: false, delayed: false, remainderUndated: false, horizonEnd: null, basis: [],
        });
        continue;
      }
      // A requested date in the past is read as today: stock stands now, and a past date is not a promise to keep.
      const at = line.requestedDate < today ? today : line.requestedDate;
      const open = Math.max(0, availableAt(result, at) - consumed);
      let given: number;
      let date: string | null;
      let delayed = false;
      let undated = false;
      if (asked <= open + 1e-9) {
        given = asked;
        date = given > 0 ? line.requestedDate : null;
      } else {
        const later = result.elements.map((e) => e.date).filter((d) => d > at && (result.horizonEnd === null || d <= result.horizonEnd));
        const full = [...new Set(later)].sort().find((d) => availableAt(result, d) - consumed >= asked - 1e-9);
        if (full) {
          given = asked;
          date = full;
          delayed = true;
        } else {
          given = open;
          date = given > 0 ? line.requestedDate : null;
          undated = true;
        }
      }
      consumed += given;
      plans.set(line.lineNumber, {
        ...common, checked: true, checkingGroup: result.checkingGroup, checkingRule: result.checkingRule,
        availableAtRequestedDate: toOrderUnit(open),
        confirmedQuantity: round3(Math.min(line.orderQuantity, delivered + toOrderUnit(given))),
        confirmedDate: date,
        partial: undated && given > 0 && given < asked - 1e-9, delayed, remainderUndated: undated,
        horizonEnd: result.horizonEnd,
        basis: result.elements.filter((e) => e.date <= (date ?? at)),
      });
    }
  }
  return plans;
}

/** The confirmed quantities of the plan, per line — what the order screens and the delivery have always read. */
export async function confirmOrderLines(
  tx: Tx,
  client: string,
  input: Parameters<typeof planOrderLines>[2],
): Promise<Map<number, number>> {
  const plans = await planOrderLines(tx, client, input);
  return new Map([...plans].map(([lineNumber, plan]) => [lineNumber, plan.confirmedQuantity]));
}

/**
 * Write the schedule lines an order line was confirmed by. Upserted, because a changed order re-runs
 * the check and the application role holds no DELETE on a promise the plant made.
 */
const dateOf = (line: { confirmedQuantity: number; requestedDate: string; confirmedDate?: string | null }) =>
  line.confirmedDate !== undefined ? line.confirmedDate : line.confirmedQuantity > 0 ? line.requestedDate : null;

export async function writeScheduleLines(tx: Tx, input: {
  client: string;
  orderNumber: string;
  changedBy: string;
  /** `confirmedDate` omitted: the requested date where something was confirmed, none where nothing was. */
  lines: Array<{ lineNumber: number; requestedQuantity: number; confirmedQuantity: number; requestedDate: string; confirmedDate?: string | null }>;
}): Promise<void> {
  for (const line of input.lines) {
    await tx.insert(salesOrderSchedule).values({
      client: input.client,
      orderNumber: input.orderNumber,
      orderLineNumber: line.lineNumber,
      scheduleNumber: 10,
      requestedDate: line.requestedDate,
      requestedQuantity: round3(line.requestedQuantity).toFixed(3),
      confirmedQuantity: round3(line.confirmedQuantity).toFixed(3),
      confirmedDate: dateOf(line),
      createdBy: input.changedBy,
    }).onConflictDoUpdate({
      target: [
        salesOrderSchedule.client, salesOrderSchedule.orderNumber,
        salesOrderSchedule.orderLineNumber, salesOrderSchedule.scheduleNumber,
      ],
      set: {
        requestedDate: line.requestedDate,
        requestedQuantity: round3(line.requestedQuantity).toFixed(3),
        confirmedQuantity: round3(line.confirmedQuantity).toFixed(3),
        confirmedDate: dateOf(line),
        changedBy: input.changedBy,
        changedAt: new Date(),
      },
    });
  }
}

/** The schedule lines of one order, in the order they stand. */
export async function scheduleLinesOf(
  client: string,
  orderNumber: string,
): Promise<Array<{ lineNumber: number } & ScheduleLine>> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(salesOrderSchedule).where(and(
      eq(salesOrderSchedule.client, client),
      eq(salesOrderSchedule.orderNumber, orderNumber),
    )).orderBy(salesOrderSchedule.orderLineNumber, salesOrderSchedule.scheduleNumber);
    return rows.map((row) => ({
      lineNumber: row.orderLineNumber,
      scheduleNumber: row.scheduleNumber,
      requestedDate: row.requestedDate,
      requestedQuantity: row.requestedQuantity,
      confirmedQuantity: row.confirmedQuantity,
      confirmedDate: row.confirmedDate,
    }));
  });
}

function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
