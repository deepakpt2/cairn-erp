/**
 * Stock transport order supply and requirement for planning (MD04 and the MRP run) — ITEM-22.
 *
 * An STO is a genuine purchasing document, so planning reads it instead of inventing a second supply. Every
 * quantity stands EXACTLY ONCE and nothing is derived from material-document direction signs (a 351 line is
 * not a purchase receipt and must never be summed as one):
 *
 *   receiving plant   not yet issued   (ordered - net issued)      a planned receipt, on the schedule dates
 *                     in transit       (net issued - net received) a separate in-transit receipt
 *   supplying plant   not yet issued   (ordered - net issued)      a requirement, on the same schedule dates
 *
 * A 101 turns transit into on-hand stock (the opening stock then rises while the transit receipt falls); a
 * 102 puts it back into transit; a 352 returns the quantity to "not yet issued". The open quantity follows the
 * schedule lines in date order: issued quantity consumes the earliest lines first, so what is still open keeps
 * its own due date. Transit has no recorded arrival date, so it is dated today and labelled as an estimate.
 * No reservation is claimed for the supplying plant: the requirement is a planning figure only.
 */
import { sql } from 'drizzle-orm';

import type { Tx } from '../../platform/db/client';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { toBaseQuantity, UnitConversionError } from '../inventory/unit-conversion';

export type StoPlanningKind = 'RECEIPT' | 'TRANSIT' | 'ISSUE';

export interface StoPlanningElement {
  kind: StoPlanningKind;
  orderNumber: string;
  itemNumber: number;
  /** ISO date. For TRANSIT the day of the calculation, and `estimated` is true. */
  date: string;
  /** Base-unit quantity, exact (scale 3). */
  quantity: bigint;
  estimated: boolean;
}

const Q = 3;
const q3 = (value: string | number) => toScaled(typeof value === 'number' ? value.toFixed(Q) : value, Q);

export const stoQuantityNumber = (value: bigint): number => Number(fromScaled(value, Q));

export async function stoPlanningElements(
  tx: Tx, client: string, materialNumber: string, plant: string, today: string,
): Promise<{ elements: StoPlanningElement[]; unitBlocked: number }> {
  const items = await tx.execute(sql`
    select i.order_number, i.item_number, i.quantity::text as quantity, i.unit, i.plant as receiving_plant,
           po.supplying_plant, i.delivery_completed
      from purchase_order_item i
      join purchase_order po on po.client = i.client and po.order_number = i.order_number
     where i.client = ${client} and po.document_type = 'STOCK_TRANSPORT' and not i.marked_for_deletion
       and i.material_number = ${materialNumber} and (i.plant = ${plant} or po.supplying_plant = ${plant})
     order by i.order_number, i.item_number
  `) as unknown as Array<{
    order_number: string; item_number: number; quantity: string; unit: string; receiving_plant: string;
    supplying_plant: string; delivery_completed: boolean;
  }>;
  if (items.length === 0) return { elements: [], unitBlocked: 0 };
  const [master] = await tx.execute(sql`
    select base_unit from material where client = ${client} and material_number = ${materialNumber}
  `) as unknown as Array<{ base_unit: string }>;
  const baseUnit = master?.base_unit ?? '';
  const schedules = await tx.execute(sql`
    select order_number, item_number, delivery_date::text as delivery_date, quantity::text as quantity
      from purchase_order_schedule_line s
     where client = ${client} and (order_number, item_number) in (
       select order_number, item_number from purchase_order_item where client = ${client} and material_number = ${materialNumber}
     )
     order by order_number, item_number, delivery_date, line_number
  `) as unknown as Array<{ order_number: string; item_number: number; delivery_date: string; quantity: string }>;
  const totals = await tx.execute(sql`
    select order_number, item_number,
           sum(issued_quantity - reversed_quantity)::text as net_issued, sum(received_quantity)::text as net_received
      from sto_transit_allocation where client = ${client} and material_number = ${materialNumber}
     group by order_number, item_number
  `) as unknown as Array<{ order_number: string; item_number: number; net_issued: string; net_received: string }>;

  const out: StoPlanningElement[] = [];
  let unitBlocked = 0;
  for (const item of items) {
    const ordered = q3(item.quantity);
    let orderedBase = ordered;
    if (item.unit !== baseUnit) {
      try {
        const conversion = await toBaseQuantity(tx, client, { materialNumber, quantity: Number(item.quantity), entryUnit: item.unit });
        orderedBase = q3(conversion.baseQuantity);
      } catch (caught) {
        if (caught instanceof UnitConversionError) { unitBlocked += 1; continue; }
        throw caught;
      }
    }
    const total = totals.find((t) => t.order_number === item.order_number && t.item_number === item.item_number);
    const netIssued = q3(total?.net_issued ?? '0');
    const netReceived = q3(total?.net_received ?? '0');
    const inTransit = netIssued - netReceived;
    const mine = schedules.filter((s) => s.order_number === item.order_number && s.item_number === item.item_number);
    // Issued quantity consumes the earliest schedule lines first; what stays open keeps its own date.
    let issuedLeft = netIssued;
    const open: Array<{ date: string; quantity: bigint }> = [];
    let allocated = 0n;
    for (const line of mine) {
      const lineBase = ordered === 0n ? 0n : (q3(line.quantity) * orderedBase) / ordered;
      allocated += lineBase;
      const used = issuedLeft < lineBase ? issuedLeft : lineBase;
      issuedLeft -= used;
      if (lineBase - used > 0n) open.push({ date: line.delivery_date, quantity: lineBase - used });
    }
    // Integer division can leave a unit of the last scale behind: the last line takes it.
    if (mine.length > 0 && allocated !== orderedBase && open.length > 0) {
      open[open.length - 1].quantity += orderedBase - allocated;
    }
    const closed = item.delivery_completed;
    if (item.receiving_plant === plant) {
      if (!closed) {
        for (const line of open) {
          out.push({ kind: 'RECEIPT', orderNumber: item.order_number, itemNumber: item.item_number, date: line.date, quantity: line.quantity, estimated: false });
        }
      }
      if (inTransit > 0n) {
        out.push({ kind: 'TRANSIT', orderNumber: item.order_number, itemNumber: item.item_number, date: today, quantity: inTransit, estimated: true });
      }
    }
    if (item.supplying_plant === plant && !closed) {
      for (const line of open) {
        out.push({ kind: 'ISSUE', orderNumber: item.order_number, itemNumber: item.item_number, date: line.date, quantity: line.quantity, estimated: false });
      }
    }
  }
  return { elements: out.filter((e) => e.quantity > 0n), unitBlocked };
}
