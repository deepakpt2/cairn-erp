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
 * And a scope the check cannot count is a refusal, not a silence. The scope rows carry flags for
 * purchase requisitions, planned orders, production orders, dependent requirements and reservations;
 * this check counts warehouse stock and what other orders have already been promised, and nothing
 * else. Counting less than the scope asked for without saying so is how a plant promises goods it has
 * not found.
 *
 * Nothing here writes to `planning_file` and nothing transfers a requirement into MRP: decision (6)
 * drew that line, and MRP behaviour is untouched by this module.
 */
import { and, eq, sql } from 'drizzle-orm';

import { withTenant, type Tx } from '../../platform/db/client';
import { materialPlant, materialSales } from '../inventory/schema';
import {
  availabilityCheckScope, availabilityCheckingGroup, availabilityCheckingRule,
} from '../production/schema';
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

export class AvailabilityError extends Error {
  remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'AvailabilityError';
    this.remedy = remedy;
  }
}

export interface AvailabilityResult {
  checkingGroup: string;
  checkingRule: string;
  /** What the plant can promise, in the material's base unit, never below zero. */
  available: number;
  stockOnHand: number;
  safetyStock: number;
  /** What other open orders have already been promised and not yet delivered. */
  promisedToOthers: number;
}

/** What a schedule line says: what was asked for and by when, and what the check confirmed. */
export interface ScheduleLine {
  scheduleNumber: number;
  requestedDate: string;
  requestedQuantity: string;
  confirmedQuantity: string;
  confirmedDate: string | null;
}

/**
 * The available quantity of a material at a plant, under the scope of check the tenant maintains.
 *
 * Returns null where the material carries no checking group, or where its group is maintained with
 * the no-check indicator set: either is a decision that this material is not checked, and a check
 * that answers anyway is a promise nobody asked for.
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
      `Maintain checking rule ${rule} at ${AVAILABILITY_ROUTE}: ${rule === ORDER_CHECKING_RULE ? 'OR is the context an order is created in' : 'LF is the context a delivery is created in'}.`,
    );
  }

  const [scope] = await tx.select().from(availabilityCheckScope).where(and(
    eq(availabilityCheckScope.client, client),
    eq(availabilityCheckScope.checkingGroup, group),
    eq(availabilityCheckScope.checkingRule, rule),
  )).limit(1);

  // What the scope asks for that this check does not count. The flags stand in the master because
  // SAP carries them; counting them is a later increment's work, and pretending to have counted them
  // is the one thing a check must never do.
  const flagged = (value: string) => value.trim() !== '' && value.trim() !== ' ';
  const uncounted = [
    ['purchase orders', flagged(scope?.purchaseOrders ?? '')],
    ['purchase requisitions', flagged(scope?.purchaseRequisitions ?? '')],
    ['planned orders', flagged(scope?.plannedOrders ?? '')],
    ['production orders', flagged(scope?.productionOrders ?? '')],
    ['dependent requirements', flagged(scope?.dependentRequirements ?? '')],
    ['reservations', flagged(scope?.reservations ?? '')],
    ['restricted-use stock', flagged(scope?.includeRestrictedUse ?? '')],
  ].filter(([, set]) => set).map(([name]) => name as string);
  if (uncounted.length > 0) {
    throw new AvailabilityError(
      `The scope of check for group ${group} and rule ${rule} asks the check to count ${uncounted.join(', ')}, and this check counts warehouse stock and what other orders have been promised, and nothing else.`,
      `Clear them at ${AVAILABILITY_ROUTE}, or leave the scope unmaintained: a check that counts less than it was configured to count promises goods it has not found.`,
    );
  }

  // Warehouse stock. Returns stock is never counted: goods a customer sent back are not the
  // company's to promise until they have been inspected and transferred out of that bucket.
  const types = ['UNRESTRICTED'];
  if (flagged(scope?.includeQualityStock ?? '')) types.push('QUALITY');
  if (flagged(scope?.includeBlockedStock ?? '')) types.push('BLOCKED');
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

  let safetyStock = 0;
  if (flagged(scope?.includeSafetyStock ?? '')) {
    const [plantRow] = await tx.select({ safetyStock: materialPlant.safetyStock }).from(materialPlant)
      .where(and(eq(materialPlant.client, client),
        eq(materialPlant.materialNumber, input.materialNumber),
        eq(materialPlant.plant, input.plant))).limit(1);
    safetyStock = Number(plantRow?.safetyStock ?? '0');
  }

  // What other open orders have already been promised and not shipped. Promising the same stock twice
  // is the one failure an availability check exists to prevent, so it counts here even though no
  // scope flag asks for it: it is what the promise is, not a stream of supply.
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
  const promisedToOthers = Number(promisedRows[0]?.promised ?? '0');

  return {
    checkingGroup: group,
    checkingRule: rule,
    available: Math.max(0, stockOnHand - safetyStock - promisedToOthers),
    stockOnHand,
    safetyStock,
    promisedToOthers,
  };
}

/**
 * What each line gets: the check run once per material and plant, and the answers consumed in the
 * order the lines stand in — the first order to ask is the first to be promised, which is the only
 * rule a plant can defend when two customers want the same stock.
 *
 * Quantities are handled in the material's base unit, because that is the unit the stock is counted
 * in; the answer is handed back in the unit the line was ordered in.
 *
 * What has already gone out is not asked for again. A line with four delivered of ten is a line with
 * six still to promise, and a check that asked for ten after the plant had shipped four would promise
 * goods the plant no longer needs to find. What was delivered stays confirmed, and the check answers
 * for the rest.
 */
export async function confirmOrderLines(
  tx: Tx,
  client: string,
  input: {
    salesOrg: string;
    distributionChannel: string;
    checkingRule: string;
    exclude?: { orderNumber: string };
    lines: Array<{ lineNumber: number; materialNumber: string; plant: string;
      orderQuantity: number; baseQuantity: number; requestedDate: string;
      /** Already delivered against this line, in the unit it was ordered in. */
      deliveredQuantity?: number }>;
  },
): Promise<Map<number, number>> {
  const byKey = new Map<string, { available: number | null; lines: typeof input.lines }>();
  for (const line of input.lines) {
    const key = `${line.materialNumber}/${line.plant}`;
    const bucket = byKey.get(key) ?? { available: null as number | null, lines: [] };
    bucket.lines.push(line);
    byKey.set(key, bucket);
  }
  const confirmed = new Map<number, number>();
  for (const bucket of byKey.values()) {
    const first = bucket.lines[0];
    const result = await availableToPromise(tx, client, {
      materialNumber: first.materialNumber, plant: first.plant,
      salesOrg: input.salesOrg, distributionChannel: input.distributionChannel,
      checkingRule: input.checkingRule, ...(input.exclude ? { exclude: input.exclude } : {}),
    });
    // A material the tenant never configured a check for is confirmed in full. Promising nothing to a
    // customer nobody decided to check would be a promise broken for want of a configuration.
    if (!result) {
      for (const line of bucket.lines) confirmed.set(line.lineNumber, line.orderQuantity);
      continue;
    }
    let left = result.available;
    for (const line of bucket.lines) {
      const delivered = line.deliveredQuantity ?? 0;
      const rate = line.orderQuantity > 0 ? line.baseQuantity / line.orderQuantity : 1;
      const open = Math.max(0, line.orderQuantity - delivered);
      const asked = Math.max(0, line.baseQuantity - delivered * rate);
      const given = Math.max(0, Math.min(asked, left));
      left -= given;
      const more = rate > 0 ? given / rate : given;
      confirmed.set(line.lineNumber, round3(Math.min(line.orderQuantity, delivered + more)));
      void open;
    }
  }
  return confirmed;
}

/**
 * Write the schedule lines an order line was confirmed by. Upserted, because a changed order re-runs
 * the check and the application role holds no DELETE on a promise the plant made.
 */
export async function writeScheduleLines(tx: Tx, input: {
  client: string;
  orderNumber: string;
  changedBy: string;
  lines: Array<{ lineNumber: number; requestedQuantity: number; confirmedQuantity: number; requestedDate: string }>;
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
      confirmedDate: line.confirmedQuantity > 0 ? line.requestedDate : null,
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
        confirmedDate: line.confirmedQuantity > 0 ? line.requestedDate : null,
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
