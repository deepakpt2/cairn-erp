/**
 * What a reversal of a delivery's goods issue owes Sales.
 *
 * A material document is posted by Inventory and reversed by Inventory, and until this module existed
 * the reversal knew nothing about the delivery behind the movement. Two things went wrong because of
 * that, and both of them are the kind of wrong that is only discovered at the year end:
 *
 * A goods issue could be reversed with the revenue standing. The goods go back into the plant, the
 * delivery goes on saying they were issued, and the invoice that was raised on them stays on the
 * customer's account — a receivable with nothing behind it. Goods that have been invoiced are taken
 * back by cancelling the invoice, or by raising a return, never by undoing the movement underneath
 * them; so the reversal is refused, and the refusal names both ways through.
 *
 * And a reversal could leave the delivery standing GOODS_ISSUED. A screen that reads that status is
 * entitled to believe the goods are out, and the delivery is the owner of that fact — so when the
 * movement is undone the delivery is undone with it: back to PICKED if the pick still stands, back to
 * OPEN if it does not, with the issued quantity taken off the lines and the issue marked as no longer
 * standing.
 *
 * Inventory calls these two functions rather than reading the delivery itself, which is the same
 * arrangement the rest of the system uses: the module that owns a document answers questions about it.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import type { Tx } from '../../platform/db/client';
import { billingDocument, delivery, deliveryLine } from './schema';

const DELIVERY_OBJECT_CLASS = 'delivery';

export class GoodsIssueReversalError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'GoodsIssueReversalError';
    this.remedy = remedy;
  }
}

/** The delivery whose goods issue was posted as this material document, if that is what it was. */
async function deliveryForIssue(
  tx: Tx,
  client: string,
  materialDocumentNumber: string,
): Promise<typeof delivery.$inferSelect | undefined> {
  const [row] = await tx.select().from(delivery).where(and(
    eq(delivery.client, client),
    eq(delivery.materialDocumentNumber, materialDocumentNumber),
  )).limit(1);
  return row;
}

/**
 * Refuse the reversal of a goods issue that Sales cannot have undone.
 *
 * Two refusals, and the difference between them is which act is the way through. Goods that have been
 * invoiced are not taken back by a reversal — the invoice is cancelled, or the goods come back on a
 * returns delivery and are credited. Goods that have already come back are not taken back either:
 * the quantity that came back is counted against what was issued, and undoing the issue underneath it
 * would leave more returned than was ever sent out.
 *
 * A material document that was not a delivery's goods issue is none of this module's business, and
 * passes.
 */
export async function refuseGoodsIssueReversal(
  tx: Tx,
  client: string,
  materialDocumentNumber: string,
): Promise<void> {
  const header = await deliveryForIssue(tx, client, materialDocumentNumber);
  if (!header) return;

  const [billed] = await tx.select({ number: billingDocument.billingNumber }).from(billingDocument).where(and(
    eq(billingDocument.client, client),
    eq(billingDocument.deliveryNumber, header.deliveryNumber),
    sql`${billingDocument.status} <> 'CANCELLED' and ${billingDocument.creditOf} is null and ${billingDocument.cancellationOf} is null`,
  )).limit(1);
  if (billed) {
    throw new GoodsIssueReversalError(
      `Delivery ${header.deliveryNumber} is billed as ${billed.number}, and goods that have been invoiced are not taken back by reversing the movement.`,
      `Cancel billing document ${billed.number}, or raise a return against the delivery and credit the customer. The reversal was not posted.`,
    );
  }

  const [returned] = await tx.execute(sql`
    select coalesce(sum(greatest(coalesce(returned_quantity, 0), 0)), 0)::text as quantity
      from delivery_line
     where client = ${client} and delivery_number = ${header.deliveryNumber}
  `) as unknown as Array<{ quantity: string }>;
  if (Number(returned?.quantity ?? '0') > 1e-9) {
    throw new GoodsIssueReversalError(
      `Delivery ${header.deliveryNumber} has already had ${Number(returned.quantity)} of its goods come back, and an issue is not reversed from under a return.`,
      'Take the returned goods back out of returns stock first, or settle the return instead. The reversal was not posted.',
    );
  }
}

/**
 * Undo the delivery's goods issue, because the movement behind it has been undone.
 *
 * The delivery goes back to what it was before the issue: PICKED while the pick still stands, OPEN if
 * it does not. The issued quantity comes off the lines, so the delivery can be issued again from the
 * store's own confirmation rather than from a memory of a movement that no longer exists. The material
 * document stays named on the header — what was posted is history — but the issue no longer stands,
 * and that is the fact every screen reads.
 *
 * A partial reversal leaves the delivery alone: some of the goods are still out, so the delivery is
 * still issued, and saying otherwise would be a lie in the other direction.
 */
export async function noteGoodsIssueReversed(
  tx: Tx,
  client: string,
  materialDocumentNumber: string,
  changedBy: string,
): Promise<void> {
  const header = await deliveryForIssue(tx, client, materialDocumentNumber);
  if (!header || !header.goodsIssueStands) return;

  const lines = await tx.select().from(deliveryLine).where(and(
    eq(deliveryLine.client, client),
    eq(deliveryLine.deliveryNumber, header.deliveryNumber),
  )).orderBy(deliveryLine.lineNumber);

  for (const line of lines) {
    await tx.update(deliveryLine).set({
      goodsIssueQuantity: '0',
      status: Number(line.pickedQuantity) > 1e-9 ? 'PICKED' : 'OPEN',
      changedBy,
      changedAt: new Date(),
    }).where(and(
      eq(deliveryLine.client, client),
      eq(deliveryLine.deliveryNumber, header.deliveryNumber),
      eq(deliveryLine.lineNumber, line.lineNumber),
    ));
  }

  const status = lines.some((line) => Number(line.pickedQuantity) > 1e-9) ? 'PICKED' : 'OPEN';
  await tx.update(delivery).set({
    status,
    goodsIssueStands: false,
    version: header.version + 1,
    changedBy,
    changedAt: new Date(),
  }).where(and(
    eq(delivery.client, client),
    eq(delivery.deliveryNumber, header.deliveryNumber),
    eq(delivery.version, header.version),
  ));

  await recordChange(tx, {
    client, objectClass: DELIVERY_OBJECT_CLASS, objectKey: header.deliveryNumber,
    changeType: 'CHANGE', changedBy,
    before: { status: header.status, goodsIssueStands: true, version: header.version },
    after: {
      status, goodsIssueStands: false, version: header.version + 1,
      materialDocument: materialDocumentNumber,
    },
    fieldLabels: {
      status: 'Status', goodsIssueStands: 'Goods issue stands',
      materialDocument: 'Movement reversed',
    },
  });
}
