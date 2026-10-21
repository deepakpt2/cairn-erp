import { sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import type { Tx } from '../../platform/db/client';

/**
 * SCR-149 — the header and the item say what the allocations say.
 *
 * A count status is not a posting status. This is the one place that recomputes both, so a count
 * saved after a partial posting cannot put the header back to COUNTED, and a reversal cannot leave
 * an item looking posted.
 */

export async function releaseDifferenceAllocations(
  tx: Tx,
  client: string,
  changedBy: string,
  release: {
    reversalDocument: string;
    lines: Array<{ originalDocument: string; originalLine: number; reversalLine: number }>;
  },
): Promise<void> {
  const documents = new Map<string, { documentNumber: string; fiscalYear: number }>();
  for (const line of release.lines) {
    const standing = await tx.execute(sql`
      select reversed_quantity::text as reversed
        from physical_inventory_difference_allocation
       where client = ${client}
         and material_document_number = ${line.originalDocument}
         and line_number = ${line.originalLine}
    `) as unknown as Array<{ reversed: string }>;
    if (standing.length === 0) continue;
    if (Number(standing[0].reversed) > 0) {
      throw new Error(
        `Material document ${line.originalDocument} line ${line.originalLine} has already released its inventory difference.`,
      );
    }
    const released = await tx.execute(sql`
      update physical_inventory_difference_allocation
         set reversed_quantity = abs(posted_difference),
             reversal_document_number = ${release.reversalDocument},
             reversal_line = ${line.reversalLine},
             changed_by = ${changedBy},
             changed_at = now()
       where client = ${client}
         and material_document_number = ${line.originalDocument}
         and line_number = ${line.originalLine}
         and reversed_quantity = 0
      returning inventory_document_number, fiscal_year
    `) as unknown as Array<{ inventory_document_number: string; fiscal_year: number }>;
    for (const row of released) {
      documents.set(`${row.inventory_document_number}/${row.fiscal_year}`, {
        documentNumber: row.inventory_document_number,
        fiscalYear: row.fiscal_year,
      });
    }
  }
  for (const document of documents.values()) {
    await recomputePostingStatus(tx, client, document.documentNumber, document.fiscalYear, changedBy);
  }
}

/**
 * The completion policy. An item is resolved when it is counted and its difference is zero, or
 * counted and its nonzero difference is fully posted. An uncounted item is not resolved. The
 * header is POSTED only when every item is resolved, and PARTIALLY_POSTED when something remains
 * posted and something is not resolved. Nothing posted leaves the count status the items deserve.
 */
export async function recomputePostingStatus(
  tx: Tx,
  client: string,
  documentNumber: string,
  fiscalYear: number,
  changedBy: string,
): Promise<string> {
  const header = await tx.execute(sql`
    select status from physical_inventory_document
     where client = ${client}
       and inventory_document_number = ${documentNumber}
       and fiscal_year = ${fiscalYear}
     for update
  `) as unknown as Array<{ status: string }>;
  if (!header[0] || header[0].status === 'CANCELLED') return header[0]?.status ?? 'CANCELLED';

  const items = await tx.execute(sql`
    select i.item_number, i.count_status, i.difference_quantity::text as difference,
           i.posting_status,
           coalesce(sum(abs(a.posted_difference) - a.reversed_quantity), 0)::text as remaining_posted
      from physical_inventory_item i
      left join physical_inventory_difference_allocation a
        on a.client = i.client
       and a.inventory_document_number = i.inventory_document_number
       and a.fiscal_year = i.fiscal_year
       and a.item_number = i.item_number
     where i.client = ${client}
       and i.inventory_document_number = ${documentNumber}
       and i.fiscal_year = ${fiscalYear}
     group by i.item_number, i.count_status, i.difference_quantity, i.posting_status
     order by i.item_number
  `) as unknown as Array<{
    item_number: number; count_status: string; difference: string | null;
    posting_status: string; remaining_posted: string;
  }>;

  let anyRemaining = false;
  let allResolved = items.length > 0;
  let counted = 0;
  for (const item of items) {
    const difference = item.difference === null ? null : Math.abs(Number(item.difference));
    const remaining = Number(item.remaining_posted);
    if (remaining > 1e-9) anyRemaining = true;
    const fullyPosted = difference !== null && difference > 1e-9 && remaining + 1e-9 >= difference;
    const nextItemStatus = fullyPosted ? 'POSTED' : 'UNPOSTED';
    if (nextItemStatus !== item.posting_status) {
      await tx.execute(sql`
        update physical_inventory_item
           set posting_status = ${nextItemStatus}, changed_by = ${changedBy}, changed_at = now()
         where client = ${client}
           and inventory_document_number = ${documentNumber}
           and fiscal_year = ${fiscalYear}
           and item_number = ${item.item_number}
      `);
    }
    if (item.count_status === 'COUNTED') counted += 1;
    const zero = difference !== null && difference <= 1e-9 && item.count_status === 'COUNTED';
    if (!(zero || fullyPosted)) allResolved = false;
  }

  let next = header[0].status;
  if (allResolved) next = 'POSTED';
  else if (anyRemaining) next = 'PARTIALLY_POSTED';
  else if (counted === 0) next = 'CREATED';
  else if (counted === items.length) next = 'COUNTED';
  else next = 'PARTIALLY_COUNTED';

  if (next !== header[0].status) {
    await tx.execute(sql`
      update physical_inventory_document
         set status = ${next}, version = version + 1, changed_by = ${changedBy}, changed_at = now()
       where client = ${client}
         and inventory_document_number = ${documentNumber}
         and fiscal_year = ${fiscalYear}
    `);
    await recordChange(tx, {
      client,
      objectClass: 'physical_inventory_document',
      objectKey: `${documentNumber}/${fiscalYear}`,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: 'INV.PHYINV.DIFF.POST',
      before: { status: header[0].status },
      after: { status: next },
    });
  }
  return next;
}
