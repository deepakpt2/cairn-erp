/**
 * What the customer has already committed to in Sales and has not yet been billed for.
 *
 * CAIRN.md §14.8 defines the credit exposure as "open sales orders (not yet delivered) + open deliveries
 * (not yet billed) + open invoices (not yet paid) + special liabilities". The receivable half is the credit
 * engine's own read of the ledger; these two halves can only be counted by the module that owns the
 * documents, so the engine asks for them rather than reaching in (§5.1 — modules do not read each other's
 * tables, they compose through owners).
 *
 * The value of an un-delivered order line is its own price applied to the quantity that still stands open,
 * and the value of a delivered-not-billed line is that price applied to the quantity that left on the
 * delivery. Neither figure is stored anywhere else, which is why the order keeps no delivered counter: the
 * sums below are the answer, read from the documents themselves.
 *
 * A cancellation removes a commitment; a delivery whose billing document has not posted keeps its value in
 * the basis, because the goods have gone and no receivable has been raised yet. A document in a currency
 * other than the credit area's own is not counted: the engine judges in local terms and receives an
 * unconverted document value the way it always has, and converting here would invent a rate rule the credit
 * master does not state (DI-019).
 */
import { sql } from 'drizzle-orm';

import type { Tx } from '../../platform/db/client';

/**
 * The open sales commitments of one customer in one credit control area, as a decimal string.
 *
 * `excludeSalesDocument` keeps the document being judged out of its own basis: an order change re-prices a
 * row that is already standing, and a goods issue re-checks a delivery that is already counted, so without
 * the exclusion the ladder would compare the limit against the same value twice.
 */
export async function openSalesCommitments(
  tx: Tx,
  client: string,
  customer: string,
  areaCurrency: string,
  excludeSalesDocument?: string,
): Promise<string> {
  const rows = await tx.execute(sql`
    select coalesce(sum(value), 0)::text as value
      from (
        select (l.net_amount + l.tax_amount)
                 * (l.order_quantity - coalesce(open.delivered, 0)) / l.order_quantity as value
          from sales_order_line l
          join sales_order o
            on o.client = l.client and o.order_number = l.order_number
          left join (
            select dl.client, dl.order_number, dl.order_line_number,
                   sum(dl.delivery_quantity) as delivered
              from delivery_line dl
              join delivery d
                on d.client = dl.client and d.delivery_number = dl.delivery_number
             and d.status <> 'CANCELLED'
             group by 1, 2, 3
          ) open on open.client = l.client and open.order_number = l.order_number
               and open.order_line_number = l.line_number
         where l.client = ${client}
           and o.customer_number = ${customer}
           and o.status = 'OPEN'
           and o.currency = ${areaCurrency}
           and l.status = 'OPEN'
           and l.order_quantity > coalesce(open.delivered, 0)
           and (${excludeSalesDocument ?? null}::text is null or l.order_number <> ${excludeSalesDocument ?? null})

        union all

        select (l.net_amount + l.tax_amount) * dl.delivery_quantity / l.order_quantity as value
          from delivery_line dl
          join delivery d
            on d.client = dl.client and d.delivery_number = dl.delivery_number
          join sales_order o
            on o.client = d.client and o.order_number = d.order_number
          join sales_order_line l
            on l.client = dl.client and l.order_number = dl.order_number and l.line_number = dl.order_line_number
          left join billing_document bd
            on bd.client = dl.client and bd.delivery_number = dl.delivery_number and bd.status = 'POSTED'
         where dl.client = ${client}
           and o.customer_number = ${customer}
           and d.status <> 'CANCELLED'
           and o.status <> 'CANCELLED'
           and o.currency = ${areaCurrency}
           and bd.billing_number is null
           and (${excludeSalesDocument ?? null}::text is null or d.delivery_number <> ${excludeSalesDocument ?? null})
      ) commitments
  `) as unknown as Array<{ value: string }>;
  return rows[0]?.value ?? '0';
}
