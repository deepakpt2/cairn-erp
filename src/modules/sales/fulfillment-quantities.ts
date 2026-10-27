/**
 * What the sales chain has already advanced, in one place.
 *
 * An order line's open quantity and a delivery line's billable quantity are the same arithmetic seen from two
 * documents, and the arithmetic has to have one author: the order service refuses to reduce a line below what
 * stands delivered, the delivery service refuses to carry more than the line has open, and the billing service
 * refuses to bill what is not issued. All three read it here, from the documents themselves, so no counter on
 * a header or a line can drift from the chain it is supposed to summarize.
 *
 * Cancelled documents are excluded — a cancelled delivery owes nothing and a cancelled billing has no
 * receivable — and a billing whose accounting entry did not post still counts its delivery as an open
 * commitment, which is what keeps the goods and the money from being able to disagree.
 */
import { sql } from 'drizzle-orm';

import type { Tx } from '../../platform/db/client';

export interface OrderLineProgress {
  /** Delivered quantity per order item, over the deliveries that stand. */
  delivered: Map<number, string>;
  /** Billed quantity per order item, over the billing documents that stand. */
  billed: Map<number, string>;
}

export async function orderLineProgress(tx: Tx, client: string, orderNumber: string): Promise<OrderLineProgress> {
  const delivered = await tx.execute(sql`
    select dl.order_line_number as line_number, coalesce(sum(dl.delivery_quantity), 0)::text as quantity
      from delivery_line dl
      join delivery d on d.client = dl.client and d.delivery_number = dl.delivery_number
     where dl.client = ${client} and dl.order_number = ${orderNumber} and d.status <> 'CANCELLED'
     group by 1
  `) as unknown as Array<{ line_number: number; quantity: string }>;
  const billed = await tx.execute(sql`
    select dl.order_line_number as line_number, coalesce(sum(bl.billing_quantity), 0)::text as quantity
      from billing_document_line bl
      join billing_document bd on bd.client = bl.client and bd.billing_number = bl.billing_number
      join delivery_line dl
        on dl.client = bl.client and dl.delivery_number = bl.delivery_number and dl.line_number = bl.delivery_line_number
     where dl.client = ${client} and dl.order_number = ${orderNumber} and bd.status <> 'CANCELLED'
     group by 1
  `) as unknown as Array<{ line_number: number; quantity: string }>;
  return {
    delivered: new Map(delivered.map((row) => [Number(row.line_number), row.quantity])),
    billed: new Map(billed.map((row) => [Number(row.line_number), row.quantity])),
  };
}

/** The numbers of the chain documents that stand against an order, whichever link wrote them. */
export async function fulfillmentDocumentsOf(
  tx: Tx,
  client: string,
  orderNumber: string,
): Promise<{ deliveries: string[]; billings: string[] }> {
  const deliveries = await tx.execute(sql`
    select delivery_number from delivery
     where client = ${client} and order_number = ${orderNumber} and status <> 'CANCELLED'
  `) as unknown as Array<{ delivery_number: string }>;
  const billings = await tx.execute(sql`
    select billing_number from billing_document
     where client = ${client} and order_number = ${orderNumber} and status <> 'CANCELLED'
  `) as unknown as Array<{ billing_number: string }>;
  return {
    deliveries: deliveries.map((row) => row.delivery_number),
    billings: billings.map((row) => row.billing_number),
  };
}

/** The quantities the chain has taken off one order line, as a number the caller can compare against. */
export function deliveredOf(progress: OrderLineProgress, orderLineNumber: number): number {
  return Number(progress.delivered.get(orderLineNumber) ?? '0');
}

export function billedOf(progress: OrderLineProgress, orderLineNumber: number): number {
  return Number(progress.billed.get(orderLineNumber) ?? '0');
}
