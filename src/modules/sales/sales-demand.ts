/**
 * Sales-order demand for planning (MD04 and the MRP run) — one projection, two readers.
 *
 * A real, open customer requirement is demand on the plant that has to ship it. MD04 and MRP both read it
 * here, so the list a planner looks at and the shortage a run plans from cannot disagree.
 *
 * What counts. A sales_order whose header is OPEN and whose item is OPEN (a rejected item and a cancelled
 * order are not demand), of a document type that is not the returns chain's: the returns order, the complaint
 * and the credit memo request are configured in `sales_returns_configuration` (the standard RE / CR / G2 stand
 * in where nothing is configured) and an order raised with reference to an invoice is a return as well.
 * Quotations, down-payment requests and billing documents live in tables of their own and are never read.
 *
 * What the quantity is. The REQUESTED open quantity, not the ATP-confirmed one: an unconfirmed order still needs
 * supply. Open = ordered − quantity the customer's goods issue has taken out.
 *
 * The invariant (one author, the sentence the tests assert):
 *   Order demand falls when, and only when, stock falls — at the goods issue. Stock is reduced by posting the
 *   issue, so the same transaction that posts it makes `delivery.goods_issue_stands` true and
 *   `delivery_line.goods_issue_quantity` the issued quantity. An outbound delivery that is created or picked
 *   but not goods-issued leaves the order's demand untouched (stock is still on the shelf). A reversal of the
 *   issue puts the stock back and, in the same transaction, clears `goods_issue_quantity`, so the demand is
 *   restored with it. A delivery is therefore NOT a second requirement: nothing is counted twice and nothing
 *   is transferred, because the order line stays the single demand document until the goods leave.
 *   Goods that come back on a returns delivery land in returns stock (not MRP-available) and do not reopen
 *   the order line, exactly as `fulfillment-quantities.ts` has always treated them.
 *
 * Dates and partial fulfilment. A line may carry several schedule lines (`sales_order_schedule`). There is no
 * stored link between a delivery and a schedule line, so the allocation is INFERRED and documented here, not
 * pretended: the issued quantity consumes the earliest requested date first (schedule number breaks a tie),
 * and what is left keeps its own requested date. A line with no schedule line (never checked) is one element
 * at the item's requested date, else the header's, else the order date. If the schedule lines add up to less
 * than the item the remainder is dated like an unscheduled line; if they add up to more, the latest dates give
 * way. Quantities are converted to the base unit with the item's stored conversion (`base_quantity` ÷
 * `order_quantity`, written once at entry); the last element takes any scale-3 rounding remainder.
 *
 * What is refused, by name rather than silently: an item whose delivery stands in another unit than the item,
 * or whose quantities are not positive, is returned in `blocked` with the reason and contributes no demand.
 * Reservations carry no stored link to a sales order (nothing in sales writes one), so an independent
 * reservation is never suppressed here — it is a separate requirement the plant has promised away.
 */
import { sql } from 'drizzle-orm';

import type { Tx } from '../../platform/db/client';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import {
  STANDARD_CREDIT_MEMO_REQUEST_TYPE, STANDARD_CREDIT_MEMO_TYPE, STANDARD_RETURNS_DELIVERY_TYPE,
  STANDARD_RETURNS_ORDER_TYPE,
} from './document-type';

const Q = 3;

export interface SalesDemandElement {
  orderNumber: string;
  lineNumber: number;
  /** Null for a quantity no schedule line carries (an unscheduled item, or the remainder beyond the schedule lines). */
  scheduleNumber: number | null;
  /** ISO date the customer asked for. */
  date: string;
  /** Open quantity in the material's base unit, scale 3, exact. */
  quantity: bigint;
  /** What the open quantity is, in the order unit, for the drill-down. */
  orderUnitQuantity: bigint;
  unit: string;
  documentType: string;
}

export interface SalesDemandBlocked {
  orderNumber: string;
  lineNumber: number;
  reason: string;
}

export interface SalesDemand {
  elements: SalesDemandElement[];
  blocked: SalesDemandBlocked[];
}

const scaled = (value: unknown): bigint => toScaled(String(value ?? '0'), Q);

export const salesDemandQuantityNumber = (value: bigint): number => Number(fromScaled(value, Q));

interface LineRow {
  order_number: string; line_number: number; document_type: string; quantity_unit: string;
  order_quantity: string; base_quantity: string; fallback_date: string;
  issued: string | null; issued_units: number; issued_unit: string | null;
}

export async function salesDemandElements(
  tx: Tx, client: string, materialNumber: string, plant: string,
): Promise<SalesDemand> {
  const lines = await tx.execute(sql`
    select l.order_number, l.line_number, o.document_type, trim(l.quantity_unit) as quantity_unit,
           l.order_quantity::text as order_quantity, l.base_quantity::text as base_quantity,
           coalesce(l.requested_delivery_date, o.requested_date, o.order_date)::text as fallback_date,
           iss.issued::text as issued, coalesce(iss.units, 0)::int as issued_units, iss.unit as issued_unit
      from sales_order_line l
      join sales_order o on o.client = l.client and o.order_number = l.order_number
      left join lateral (
        select coalesce(sum(dl.goods_issue_quantity), 0) as issued, count(distinct dl.quantity_unit) as units,
               min(trim(dl.quantity_unit)) as unit
          from delivery_line dl
          join delivery d on d.client = dl.client and d.delivery_number = dl.delivery_number
         where dl.client = l.client and dl.order_number = l.order_number and dl.order_line_number = l.line_number
           and d.status = 'GOODS_ISSUED' and d.goods_issue_stands and dl.status = 'GOODS_ISSUED'
           and d.document_type <> ${STANDARD_RETURNS_DELIVERY_TYPE}::text
      ) iss on true
     where l.client = ${client} and l.material_number = ${materialNumber} and l.plant = ${plant}
       and o.status = 'OPEN' and l.status = 'OPEN'
       and o.reference_document_type is null
       and o.document_type not in (
         select returns_order_type from sales_returns_configuration where client = ${client}
         union select complaint_type from sales_returns_configuration where client = ${client}
         union select credit_memo_type from sales_returns_configuration where client = ${client}
         union select ${STANDARD_RETURNS_ORDER_TYPE}::text union select ${STANDARD_CREDIT_MEMO_REQUEST_TYPE}::text
         union select ${STANDARD_CREDIT_MEMO_TYPE}::text
       )
     order by l.order_number, l.line_number
  `) as unknown as LineRow[];
  if (lines.length === 0) return { elements: [], blocked: [] };

  const schedules = await tx.execute(sql`
    select s.order_number, s.order_line_number as line_number, s.schedule_number,
           s.requested_date::text as requested_date, s.requested_quantity::text as quantity
      from sales_order_schedule s
      join sales_order_line l on l.client = s.client and l.order_number = s.order_number and l.line_number = s.order_line_number
     where s.client = ${client} and l.material_number = ${materialNumber} and l.plant = ${plant}
     order by s.order_number, s.order_line_number, s.requested_date, s.schedule_number
  `) as unknown as Array<{ order_number: string; line_number: number; schedule_number: number; requested_date: string; quantity: string }>;

  const elements: SalesDemandElement[] = [];
  const blocked: SalesDemandBlocked[] = [];
  for (const line of lines) {
    const orderQty = scaled(line.order_quantity);
    const baseQty = scaled(line.base_quantity);
    const lineNumber = Number(line.line_number);
    if (orderQty <= 0n || baseQty <= 0n) {
      blocked.push({ orderNumber: line.order_number, lineNumber, reason: 'The item carries no positive ordered or base quantity.' });
      continue;
    }
    const issuedUnits = scaled(line.issued);
    if (issuedUnits > 0n && (Number(line.issued_units) > 1 || String(line.issued_unit ?? '') !== line.quantity_unit)) {
      blocked.push({
        orderNumber: line.order_number, lineNumber,
        reason: `A goods issue against the item stands in another unit than the item (${line.quantity_unit}); the unit is not assumed equal.`,
      });
      continue;
    }
    const totalOpen = issuedUnits >= orderQty ? 0n : orderQty - issuedUnits;
    if (totalOpen === 0n) continue;

    // Allocation: the issued quantity consumes the earliest requested dates first.
    let consume = issuedUnits;
    const open: Array<{ schedule: number | null; date: string; quantity: bigint }> = [];
    for (const s of schedules.filter((row) => row.order_number === line.order_number && Number(row.line_number) === lineNumber)) {
      const asked = scaled(s.quantity);
      const used = consume < asked ? consume : asked;
      consume -= used;
      if (asked - used > 0n) open.push({ schedule: Number(s.schedule_number), date: s.requested_date, quantity: asked - used });
    }
    let sum = open.reduce((total, item) => total + item.quantity, 0n);
    // Schedule lines beyond the item give way, latest date first.
    for (let index = open.length - 1; sum > totalOpen && index >= 0; index -= 1) {
      const cut = sum - totalOpen < open[index].quantity ? sum - totalOpen : open[index].quantity;
      open[index].quantity -= cut;
      sum -= cut;
    }
    const kept = open.filter((item) => item.quantity > 0n);
    if (sum < totalOpen) kept.push({ schedule: null, date: line.fallback_date, quantity: totalOpen - sum });

    // Base-unit conversion by the item's stored ratio; the last element takes the rounding remainder.
    const targetBase = totalOpen === orderQty ? baseQty : (totalOpen * baseQty) / orderQty;
    let allocated = 0n;
    kept.forEach((item, index) => {
      const quantity = index === kept.length - 1
        ? targetBase - allocated
        : (item.quantity * baseQty) / orderQty;
      allocated += quantity;
      if (quantity > 0n) {
        elements.push({
          orderNumber: line.order_number, lineNumber, scheduleNumber: item.schedule, date: item.date,
          quantity, orderUnitQuantity: item.quantity, unit: line.quantity_unit, documentType: line.document_type,
        });
      }
    });
  }
  return { elements, blocked };
}

/**
 * Mark the planning file for the material/plant pairs a sales or delivery change touched — the existing
 * net-change marker, in the caller's transaction, never a second change table. A pair is marked only where the
 * material is maintained in that plant (the file's key is a material-plant row). A run that is planning the
 * pair clears the marker only if its timestamp is the one it read, so a change made during the run survives.
 */
export async function markSalesPlanning(
  tx: Tx, client: string, actor: string, reason: string,
  targets: Array<{ materialNumber: string; plant: string }>,
): Promise<void> {
  const seen = new Set<string>();
  for (const target of targets) {
    const material = target.materialNumber.trim();
    const plant = target.plant.trim();
    if (!material || !plant || seen.has(`${material}|${plant}`)) continue;
    seen.add(`${material}|${plant}`);
    await tx.execute(sql`
      insert into planning_file (client, material_number, plant, net_change, reason, last_changed_by)
      select mp.client, mp.material_number, mp.plant, true, ${reason.slice(0, 80)}, ${actor.slice(0, 60)}
        from material_plant mp
       where mp.client = ${client} and mp.material_number = ${material} and mp.plant = ${plant}
      on conflict (client, material_number, plant)
      do update set net_change = true, reason = excluded.reason, last_changed_at = now(), last_changed_by = excluded.last_changed_by
    `);
  }
}

/** The material/plant pairs of every item of an order (for a cancellation, which touches them all). */
export async function orderPlanningTargets(
  tx: Tx, client: string, orderNumber: string,
): Promise<Array<{ materialNumber: string; plant: string }>> {
  const found = await tx.execute(sql`
    select distinct material_number, plant from sales_order_line
     where client = ${client} and order_number = ${orderNumber}
  `) as unknown as Array<{ material_number: string; plant: string }>;
  return found.map((row) => ({ materialNumber: row.material_number, plant: row.plant }));
}

/** The pairs behind a delivery's lines (goods issue and its reversal). */
export async function deliveryPlanningTargets(
  tx: Tx, client: string, deliveryNumber: string,
): Promise<Array<{ materialNumber: string; plant: string }>> {
  const found = await tx.execute(sql`
    select distinct material_number, plant from delivery_line
     where client = ${client} and delivery_number = ${deliveryNumber}
  `) as unknown as Array<{ material_number: string; plant: string }>;
  return found.map((row) => ({ materialNumber: row.material_number, plant: row.plant }));
}
