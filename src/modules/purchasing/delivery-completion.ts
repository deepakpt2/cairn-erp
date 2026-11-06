/**
 * Delivery completion policy — whether a goods receipt closes the item it posts against.
 *
 * One plant wants the balance closed as soon as a delivery lands inside the underdelivery
 * tolerance: the supplier has done enough, and an open residue of four units is noise that
 * somebody would otherwise chase for a month. Another wants a buyer to decide every time,
 * because a closed item stops receiving and the buyer is the one who knows whether more is
 * coming. Both are right, so the rule is configuration rather than a constant.
 *
 * It is held as a company-code default with a plant override. A plant row wins; a plant
 * with no row inherits the company code it belongs to; and with no row at all the answer
 * is no — an item closes when somebody closes it, which is how the application behaved
 * before this policy existed.
 *
 * The decision is a pure function of what was configured and what has been received, so it
 * can be read without a database in reach.
 */
import { and, eq } from 'drizzle-orm';

import { type Tx } from '../../platform/db/client';
import { purchaseDeliveryCompletionPlant, purchaseDeliveryCompletionPolicy } from './schema';

export interface DeliveryCompletionDecision {
  /** Whether the receipt closes the item. */
  close: boolean;
  /** Why. Shown to the buyer, so it names the figures it judged. */
  reason: string;
}

export interface DeliveryCompletionPolicy {
  autoClose: boolean;
  /** Where the answer came from, so a refusal can say whose rule it was. */
  source: string;
}

/**
 * Whether a receipt that has brought an item to `receivedAfter` closes it.
 *
 * Tolerance is a floor, not a ceiling: the item closes once what has been received is at
 * least what was ordered less the underdelivery tolerance. A receipt that overshoots closes
 * it too — the quantity is met and passed.
 */
export function deliveryCompletionDecision(input: {
  autoClose: boolean;
  ordered: number;
  receivedAfter: number;
  underdeliveryTolerance: number;
}): DeliveryCompletionDecision {
  if (!input.autoClose) {
    return {
      close: false,
      reason: 'Delivery completion is not set by a receipt here. The item stays open until someone closes it.',
    };
  }
  const floor = input.ordered * (1 - Math.max(0, input.underdeliveryTolerance) / 100);
  if (input.receivedAfter + 1e-9 < floor) {
    return {
      close: false,
      reason:
        `Received ${input.receivedAfter} of ${input.ordered} is below the underdelivery floor of ${round3(floor)} `
        + `(${input.underdeliveryTolerance}% under). The item stays open.`,
    };
  }
  return {
    close: true,
    reason:
      `Received ${input.receivedAfter} of ${input.ordered} has reached the underdelivery floor of ${round3(floor)} `
      + `(${input.underdeliveryTolerance}% under). The item is closed.`,
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The rule that stands for a plant: its own row if it keeps one, otherwise the company it
 * belongs to, otherwise no closure by receipt at all.
 */
export async function readDeliveryCompletionPolicy(
  tx: Tx,
  client: string,
  companyCode: string,
  plantCode: string,
): Promise<DeliveryCompletionPolicy> {
  const [override] = await tx.select().from(purchaseDeliveryCompletionPlant).where(and(
    eq(purchaseDeliveryCompletionPlant.client, client),
    eq(purchaseDeliveryCompletionPlant.plant, plantCode),
  )).limit(1);
  if (override) {
    return { autoClose: override.autoClose, source: `the rule kept for plant ${plantCode}` };
  }
  const [fallback] = await tx.select().from(purchaseDeliveryCompletionPolicy).where(and(
    eq(purchaseDeliveryCompletionPolicy.client, client),
    eq(purchaseDeliveryCompletionPolicy.companyCode, companyCode),
  )).limit(1);
  if (fallback) {
    return { autoClose: fallback.autoClose, source: `the rule kept for company code ${companyCode}` };
  }
  return { autoClose: false, source: 'no delivery-completion rule' };
}
