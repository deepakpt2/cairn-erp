'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  SALES_ORDER_CAPABILITY,
  SALES_ORDER_RELEASE_CAPABILITY,
  SALES_ORDER_ROUTE,
  SalesOrderError,
  cancelSalesOrder,
  changeSalesOrder,
  createSalesOrder,
  releaseSalesOrderCredit,
  type OrderCreateInput,
} from '@/modules/sales/sales-order';

const ROUTE = SALES_ORDER_ROUTE;
const LINE_SLOTS = 10;

export interface OrderActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  orderNumber?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optional(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value === '' ? undefined : value;
}

/**
 * The grid posts its items as numbered slots. A slot with no material is not an item: the form leaves
 * blank rows empty rather than submitting zeroes, and a half-filled row is refused by the service
 * rather than dropped, because a silently dropped line is an order that does not say what was asked.
 */
function linesFrom(form: FormData): OrderCreateInput['lines'] {
  const lines: OrderCreateInput['lines'] = [];
  for (let slot = 1; slot <= LINE_SLOTS; slot += 1) {
    const materialNumber = text(form, `line-${slot}-material`);
    if (!materialNumber) continue;
    const entry: OrderCreateInput['lines'][number] = {
      lineNumber: undefined,
      materialNumber,
      plant: text(form, `line-${slot}-plant`),
      orderQuantity: Number(text(form, `line-${slot}-quantity`) || '0'),
    };
    const unit = optional(form, `line-${slot}-unit`);
    if (unit) entry.quantityUnit = unit;
    const tax = optional(form, `line-${slot}-tax`);
    if (tax) entry.taxCode = tax;
    const profitCenter = optional(form, `line-${slot}-profitCenter`);
    if (profitCenter) entry.profitCenter = profitCenter;
    const needDate = optional(form, `line-${slot}-needed`);
    if (needDate) entry.requestedDeliveryDate = needDate;
    lines.push(entry);
  }
  return lines;
}

function headerFrom(form: FormData) {
  return {
    salesOrg: text(form, 'salesOrg'),
    distributionChannel: text(form, 'distributionChannel'),
    division: text(form, 'division'),
    customerNumber: text(form, 'customerNumber'),
    companyCode: text(form, 'companyCode'),
    currency: text(form, 'currency'),
    orderDate: text(form, 'orderDate'),
    ...(optional(form, 'requestedDate') ? { requestedDate: optional(form, 'requestedDate') } : {}),
    purchaseOrderReference: optional(form, 'purchaseOrderReference'),
    headerText: optional(form, 'headerText'),
    creditControlArea: optional(form, 'creditControlArea'),
  };
}

export async function createOrderAction(
  _previous: OrderActionState,
  form: FormData,
): Promise<OrderActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SALES_ORDER_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the sales order capability.', remedy: 'Ask for SALES.ORDER.CREATE.' };
  }
  try {
    const result = await createSalesOrder({
      client: session.user.client,
      changedBy: session.user.username,
      ...headerFrom(form),
      lines: linesFrom(form),
      // The submission key makes a double press or a retried request the same order, not a second one.
      requestKey: text(form, 'requestKey') || `SO-${session.user.username}-${Date.now()}`,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      orderNumber: result.orderNumber,
      message: result.credit.status === 'BLOCKED'
        ? `Sales order ${result.orderNumber} created and blocked for credit: ${result.credit.reason}.`
        : `Sales order ${result.orderNumber} created. Credit check ${result.credit.status.toLowerCase()}.`,
      remedy: result.credit.status === 'BLOCKED'
        ? 'Release the block at /finance/credit-release, or with the release capability below, before a delivery is created.'
        : undefined,
    };
  } catch (error) {
    if (error instanceof SalesOrderError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

export async function changeOrderAction(
  _previous: OrderActionState,
  form: FormData,
): Promise<OrderActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SALES_ORDER_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the sales order capability.', remedy: 'Ask for SALES.ORDER.CREATE.' };
  }
  const submitted = linesFrom(form);
  // A change addresses its items by the numbers they already carry.
  const orderNumber = text(form, 'orderNumber');
  const lines = submitted.map((line, index) => ({
    ...line,
    lineNumber: Number(text(form, `line-${index + 1}-lineNumber`) || (index + 1) * 10),
  }));
  try {
    const result = await changeSalesOrder({
      client: session.user.client,
      changedBy: session.user.username,
      orderNumber,
      expectedVersion: Number(text(form, 'expectedVersion') || '0'),
      ...headerFrom(form),
      lines,
      rejectLines: [],
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      orderNumber: result.orderNumber,
      message: result.credit?.status === 'BLOCKED'
        ? `Sales order ${result.orderNumber} changed. The new value is blocked for credit: ${result.credit.reason}.`
        : `Sales order ${result.orderNumber} changed.`,
    };
  } catch (error) {
    if (error instanceof SalesOrderError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

export async function cancelOrderAction(
  _previous: OrderActionState,
  form: FormData,
): Promise<OrderActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SALES_ORDER_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the sales order capability.', remedy: 'Ask for SALES.ORDER.CREATE.' };
  }
  try {
    const result = await cancelSalesOrder({
      client: session.user.client,
      changedBy: session.user.username,
      orderNumber: text(form, 'orderNumber'),
      expectedVersion: Number(text(form, 'expectedVersion') || '0'),
      reason: optional(form, 'cancelReason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, orderNumber: result.orderNumber, message: `Sales order ${result.orderNumber} cancelled.` };
  } catch (error) {
    if (error instanceof SalesOrderError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

/**
 * Release the credit block on an order. The capability is the registered sales release code and the
 * judgement is the credit engine's, so the screen cannot release what the engine would refuse.
 */
export async function releaseCreditAction(
  _previous: OrderActionState,
  form: FormData,
): Promise<OrderActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SALES_ORDER_RELEASE_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the sales order release capability.',
      remedy: 'Ask for SALES.ORDER.RELEASE, or release the document at /finance/credit-release.',
    };
  }
  const orderNumber = text(form, 'orderNumber');
  try {
    const outcome = await releaseSalesOrderCredit({
      client: session.user.client,
      changedBy: session.user.username,
      orderNumber,
      justification: optional(form, 'releaseJustification'),
      approvalRef: optional(form, 'releaseApprovalRef'),
      canOverride: can(session, 'FIN.CREDIT.OVERRIDE'),
    });
    revalidatePath(ROUTE);
    return {
      ok: outcome.ok,
      orderNumber,
      message: outcome.ok
        ? `Sales order ${orderNumber} released for credit.`
        : outcome.message ?? `Sales order ${orderNumber} was not released.`,
      remedy: outcome.ok ? undefined : 'A release needs a justification, and only a blocked document can be released.',
    };
  } catch (error) {
    if (error instanceof SalesOrderError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}
