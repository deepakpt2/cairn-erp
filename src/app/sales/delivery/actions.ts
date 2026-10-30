'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { SalesOrderError } from '@/modules/sales/sales-order';
import {
  SALES_ORDER_RELEASE_CAPABILITY,
  releaseSalesOrderCredit,
} from '@/modules/sales/sales-order';
import {
  DELIVERY_CAPABILITY,
  DELIVERY_GOODS_ISSUE_CAPABILITY,
  DELIVERY_PICK_CAPABILITY,
  DELIVERY_ROUTE,
  DeliveryError,
  cancelDelivery,
  confirmDeliveryPicks,
  createDelivery,
  postDeliveryGoodsIssue,
} from '@/modules/sales/delivery';

const ROUTE = DELIVERY_ROUTE;
const LINE_SLOTS = 10;

export interface DeliveryActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  deliveryNumber?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optional(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value === '' ? undefined : value;
}

/** A refusal from either engine reads the same way: the service's words and the service's remedy. */
function refuse(error: unknown): DeliveryActionState {
  if (error instanceof DeliveryError || error instanceof SalesOrderError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

/**
 * The items a delivery form submitted. A row whose quantity is blank is not an item — the form leaves the
 * open lines it does not want untouched rather than submitting zeroes.
 */
function itemsFrom(form: FormData) {
  const items: Array<{ orderLineNumber: number; quantity: string }> = [];
  for (let slot = 1; slot <= LINE_SLOTS; slot += 1) {
    const orderLineNumber = text(form, `line-${slot}-orderLine`);
    const quantity = text(form, `line-${slot}-quantity`);
    if (!orderLineNumber || !quantity) continue;
    items.push({ orderLineNumber: Number(orderLineNumber), quantity });
  }
  return items;
}

export async function createDeliveryAction(
  _previous: DeliveryActionState,
  form: FormData,
): Promise<DeliveryActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, DELIVERY_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the delivery capability.', remedy: 'Ask for SALES.DELIVERY.CREATE.' };
  }
  const items = itemsFrom(form);
  if (!items.length) {
    return { ok: false, message: 'No item was given a delivery quantity.', remedy: 'Enter the quantity for at least one open order item.' };
  }
  try {
    const result = await createDelivery({
      client: session.user.client,
      changedBy: session.user.username,
      orderNumber: text(form, 'orderNumber'),
      deliveryDate: text(form, 'deliveryDate'),
      goodsMovementDate: optional(form, 'goodsMovementDate'),
      headerText: optional(form, 'headerText'),
      items,
      requestKey: text(form, 'requestKey') || `DL-${session.user.username}-${Date.now()}`,
    });
    revalidatePath(ROUTE);
    const blocked = result.credit?.status === 'BLOCKED';
    return {
      ok: true,
      deliveryNumber: result.deliveryNumber,
      message: result.replayed
        ? `Delivery ${result.deliveryNumber} was already created by this submission; nothing was created twice.`
        : blocked
          ? `Delivery ${result.deliveryNumber} created, and the credit check blocked it: ${result.credit?.reason}.`
          : `Delivery ${result.deliveryNumber} created from the open quantities of ${result.orderNumber}.`,
      remedy: blocked
        ? 'Release the blocked delivery at /finance/credit-release before its goods issue is posted.'
        : undefined,
    };
  } catch (error) {
    return refuse(error);
  }
}

/**
 * The pick rows a delivery form submitted: one per open item that was given a quantity, each naming the
 * storage location the goods came from.
 */
function picksFrom(form: FormData) {
  const items: Array<{
    lineNumber: number; quantity: string; storageLocation?: string; batchNumber?: string; reason?: string;
  }> = [];
  for (let slot = 1; slot <= LINE_SLOTS; slot += 1) {
    const lineNumber = text(form, `pick-${slot}-line`);
    const quantity = text(form, `pick-${slot}-quantity`);
    if (!lineNumber) continue;
    const entry: {
      lineNumber: number; quantity: string; storageLocation?: string; batchNumber?: string; reason?: string;
    } = { lineNumber: Number(lineNumber), quantity: quantity || '0' };
    const location = optional(form, `pick-${slot}-location`);
    if (location) entry.storageLocation = location;
    const batch = optional(form, `pick-${slot}-batch`);
    if (batch) entry.batchNumber = batch;
    const reason = optional(form, `pick-${slot}-reason`);
    if (reason) entry.reason = reason;
    items.push(entry);
  }
  return items;
}

export async function confirmPicksAction(
  _previous: DeliveryActionState,
  form: FormData,
): Promise<DeliveryActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, DELIVERY_PICK_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the picking capability.', remedy: 'Ask for SALES.DELIVERY.PICK.' };
  }
  const items = picksFrom(form);
  if (!items.length) {
    return { ok: false, message: 'No pick was stated.', remedy: 'Enter what came to the dock for at least one item.' };
  }
  const deliveryNumber = text(form, 'deliveryNumber');
  try {
    await confirmDeliveryPicks({
      client: session.user.client,
      changedBy: session.user.username,
      deliveryNumber,
      expectedVersion: Number(text(form, 'expectedVersion') || '0'),
      items,
      requestKey: text(form, 'pickRequestKey') || `PK-${session.user.username}-${Date.now()}`,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      deliveryNumber,
      message: `Picking confirmed on delivery ${deliveryNumber}.`,
      remedy: 'The goods issue posts what the picks state, and only when every item is picked in full.',
    };
  } catch (error) {
    return refuse(error);
  }
}

/**
 * Post the goods issue. The movement, the valuation, the journal, the delivery's status and its link to the
 * material document either all stand or none of them do, and a refused stock quantity is reported in the
 * inventory engine's own words.
 */
export async function postGoodsIssueAction(
  _previous: DeliveryActionState,
  form: FormData,
): Promise<DeliveryActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, DELIVERY_GOODS_ISSUE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the goods issue capability.', remedy: 'Ask for SALES.GI.POST.' };
  }
  const deliveryNumber = text(form, 'deliveryNumber');
  try {
    const result = await postDeliveryGoodsIssue({
      client: session.user.client,
      changedBy: session.user.username,
      deliveryNumber,
      expectedVersion: Number(text(form, 'expectedVersion') || '0'),
      postingDate: text(form, 'postingDate'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      deliveryNumber,
      message: `Goods issue posted for delivery ${deliveryNumber}: material document ${result.materialDocumentNumber}`
        + `${result.journalDocumentNumber ? `, accounting document ${result.journalDocumentNumber}` : ''}`
        + `, value ${result.totalValue}.`,
      remedy: result.creditBlockedForBilling
        ? 'The movement is posted, but the value breached the limit: the billing is held until the delivery is released at /finance/credit-release.'
        : `Bill the delivery at /sales/billing?delivery=${deliveryNumber}.`,
    };
  } catch (error) {
    return refuse(error);
  }
}

export async function cancelDeliveryAction(
  _previous: DeliveryActionState,
  form: FormData,
): Promise<DeliveryActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, DELIVERY_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the delivery capability.', remedy: 'Ask for SALES.DELIVERY.CREATE.' };
  }
  const deliveryNumber = text(form, 'deliveryNumber');
  try {
    await cancelDelivery({
      client: session.user.client,
      changedBy: session.user.username,
      deliveryNumber,
      expectedVersion: Number(text(form, 'expectedVersion') || '0'),
      reason: optional(form, 'cancelReason'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      deliveryNumber,
      message: `Delivery ${deliveryNumber} cancelled.`,
      remedy: 'The order line\'s open quantity is back where it belongs: the delivery was never counted on the order.',
    };
  } catch (error) {
    return refuse(error);
  }
}

/**
 * Release the credit block that stands against a delivery. The capability is the sales order release code —
 * releasing a delivery is an act of sales, not of credit maintenance — and the judgement is the credit
 * engine's, so the screen cannot release what the engine would refuse.
 */
export async function releaseDeliveryCreditAction(
  _previous: DeliveryActionState,
  form: FormData,
): Promise<DeliveryActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SALES_ORDER_RELEASE_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the sales order release capability.',
      remedy: 'Ask for SALES.ORDER.RELEASE, or release the document at /finance/credit-release.',
    };
  }
  const deliveryNumber = text(form, 'deliveryNumber');
  try {
    const outcome = await releaseSalesOrderCredit({
      client: session.user.client,
      changedBy: session.user.username,
      orderNumber: deliveryNumber,
      justification: optional(form, 'releaseJustification'),
      approvalRef: optional(form, 'releaseApprovalRef'),
      canOverride: can(session, 'FIN.CREDIT.OVERRIDE'),
    });
    revalidatePath(ROUTE);
    return {
      ok: outcome.ok,
      deliveryNumber,
      message: outcome.ok
        ? `Delivery ${deliveryNumber} released for credit.`
        : outcome.message ?? `Delivery ${deliveryNumber} was not released.`,
      remedy: outcome.ok ? undefined : 'A release needs a justification, and only a blocked document can be released.',
    };
  } catch (error) {
    if (error instanceof SalesOrderError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}
