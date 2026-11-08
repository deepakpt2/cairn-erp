'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  RETURNS_DELIVERY_CAPABILITY,
  RETURNS_ORDER_CAPABILITY,
  RETURNS_RECEIPT_CAPABILITY,
  RETURNS_ROUTE,
  ReturnsError,
  createReturnsDelivery,
  createReturnsOrder,
  postReturnsDelivery,
} from '@/modules/sales/returns';

const ROUTE = RETURNS_ROUTE;
const LINE_SLOTS = 10;

export interface ReturnsActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  orderNumber?: string;
  deliveryNumber?: string;
  materialDocumentNumber?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optional(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value === '' ? undefined : value;
}

/** A refusal is reported in the returns engine's own words, with the remedy it names. */
function refuse(error: unknown): ReturnsActionState {
  if (error instanceof ReturnsError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

/**
 * The lines a returns-order form submitted: one per invoice line the customer is sending goods back on.
 * A row with no quantity is not a line — the form leaves the invoiced lines it does not want untouched
 * rather than submitting zeroes.
 */
function orderLinesFrom(form: FormData): Array<{ billingLineNumber: number; quantity: number }> {
  const items: Array<{ billingLineNumber: number; quantity: number }> = [];
  for (let slot = 1; slot <= LINE_SLOTS; slot += 1) {
    const billingLineNumber = text(form, `line-${slot}-billingLine`);
    const quantity = text(form, `line-${slot}-quantity`);
    if (!billingLineNumber || !quantity) continue;
    items.push({ billingLineNumber: Number(billingLineNumber), quantity: Number(quantity) });
  }
  return items;
}

/**
 * The lines a returns-delivery form submitted. What `lineNumber` means depends on what the return was
 * raised against: a line of the returns order, or a line of the outbound delivery. The service says
 * which, and refuses the document when neither or both were named.
 */
function deliveryLinesFrom(form: FormData): Array<{ lineNumber: number; quantity: number }> {
  const items: Array<{ lineNumber: number; quantity: number }> = [];
  for (let slot = 1; slot <= LINE_SLOTS; slot += 1) {
    const lineNumber = text(form, `line-${slot}-line`);
    const quantity = text(form, `line-${slot}-quantity`);
    if (!lineNumber || !quantity) continue;
    items.push({ lineNumber: Number(lineNumber), quantity: Number(quantity) });
  }
  return items;
}

/**
 * Raise the returns order: the complaint, priced from the invoice line the goods were billed on.
 *
 * The price is never taken from the form. A return settles what was billed, and a condition record
 * renegotiated since the invoice is no part of what the customer is owed back — so the only thing the
 * screen submits is which invoiced lines are coming back and how much of each.
 */
export async function createReturnsOrderAction(
  _previous: ReturnsActionState,
  form: FormData,
): Promise<ReturnsActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RETURNS_ORDER_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the returns order capability.',
      remedy: 'Ask for SALES.RETURNS.ORDER.CREATE.',
    };
  }
  const items = orderLinesFrom(form);
  if (!items.length) {
    return {
      ok: false,
      message: 'No invoiced line was given a quantity to return.',
      remedy: 'Enter how much of at least one invoiced line the customer is sending back.',
    };
  }
  try {
    const result = await createReturnsOrder({
      client: session.user.client,
      changedBy: session.user.username,
      requestKey: text(form, 'requestKey') || `RO-${session.user.username}-${Date.now()}`,
      billingNumber: text(form, 'billingNumber'),
      orderDate: text(form, 'orderDate'),
      headerText: optional(form, 'headerText'),
      items,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      orderNumber: result.orderNumber,
      message: result.replayed
        ? `Returns order ${result.orderNumber} was already raised by this submission; nothing was raised twice.`
        : `Returns order ${result.orderNumber} raised against ${text(form, 'billingNumber')} for ${result.grossValue}.`,
      remedy: result.replayed
        ? undefined
        : 'The order claims the goods; it does not receive them. Raise its returns delivery, and the warehouse receives against that.',
    };
  } catch (error) {
    return refuse(error);
  }
}

/**
 * Raise the returns delivery: the document the warehouse receives against.
 *
 * SAP raises it two ways and so does this screen — against the outbound delivery, when what is known
 * is that goods left on a particular shipment, or against a returns order, which is how a return that
 * began as a complaint reaches the warehouse. The service refuses a document that names neither, and
 * one that names both.
 */
export async function createReturnsDeliveryAction(
  _previous: ReturnsActionState,
  form: FormData,
): Promise<ReturnsActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RETURNS_DELIVERY_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the returns delivery capability.',
      remedy: 'Ask for SALES.RETURNS.DELIVERY.CREATE.',
    };
  }
  const items = deliveryLinesFrom(form);
  if (!items.length) {
    return {
      ok: false,
      message: 'No line was given a quantity to receive back.',
      remedy: 'Name the lines the goods are coming back against, and how much of each.',
    };
  }
  const raisedAgainst = text(form, 'raisedAgainst') === 'order' ? 'order' : 'delivery';
  try {
    const result = await createReturnsDelivery({
      client: session.user.client,
      changedBy: session.user.username,
      requestKey: text(form, 'requestKey') || `RT-${session.user.username}-${Date.now()}`,
      deliveryDate: text(form, 'deliveryDate'),
      headerText: optional(form, 'headerText'),
      ...(raisedAgainst === 'order'
        ? { returnsOrderNumber: text(form, 'returnsOrderNumber') }
        : { deliveryNumber: text(form, 'deliveryNumber') }),
      items,
    });
    revalidatePath(ROUTE);
    const against = raisedAgainst === 'order' ? text(form, 'returnsOrderNumber') : text(form, 'deliveryNumber');
    return {
      ok: true,
      deliveryNumber: result.deliveryNumber,
      message: result.replayed
        ? `Returns delivery ${result.deliveryNumber} was already raised by this submission; nothing was raised twice.`
        : `Returns delivery ${result.deliveryNumber} raised against ${against}.`,
      remedy: result.replayed
        ? undefined
        : 'The goods come back when the delivery is received, and not before: nothing has moved yet.',
    };
  } catch (error) {
    return refuse(error);
  }
}

/**
 * Receive a returns delivery: the 651.
 *
 * The version the form was rendered with travels with it, so a document somebody else has moved on
 * since is refused rather than received twice. The movement puts the goods into returns stock, which
 * is not valuated, so the answer names no accounting document: the value arrives when the inspected
 * goods are transferred out of returns stock into valuated stock.
 */
export async function receiveReturnsDeliveryAction(
  _previous: ReturnsActionState,
  form: FormData,
): Promise<ReturnsActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RETURNS_RECEIPT_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the returns receipt capability.',
      remedy: 'Ask for SALES.RETURNS.RECEIPT.POST.',
    };
  }
  const deliveryNumber = text(form, 'deliveryNumber');
  try {
    const result = await postReturnsDelivery({
      client: session.user.client,
      changedBy: session.user.username,
      deliveryNumber,
      expectedVersion: Number(text(form, 'expectedVersion') || '0'),
      postingDate: text(form, 'postingDate'),
      documentDate: optional(form, 'documentDate'),
      requestKey: text(form, 'requestKey') || `RT-GR-${session.user.username}-${Date.now()}`,
    });
    revalidatePath(ROUTE);
    const quantity = result.lines.reduce((sum, line) => sum + line.quantity, 0);
    return {
      ok: true,
      deliveryNumber: result.returnsDeliveryNumber,
      materialDocumentNumber: result.materialDocumentNumber,
      message: `Returns delivery ${result.returnsDeliveryNumber} received: material document ${result.materialDocumentNumber}, ${result.lines.length} line(s), ${quantity} into returns stock.`,
      remedy: 'Returns stock is not valuated, so the movement posts no accounting document. Inspect the goods and transfer them into valuated stock at /inventory/transfer-posting; the credit is raised at /sales/credit-memo.',
    };
  } catch (error) {
    return refuse(error);
  }
}
