'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  BILLING_CANCEL_CAPABILITY,
  BILLING_CAPABILITY,
  BILLING_ROUTE,
  BILLING_SPLIT_ROUTE,
  BillingError,
  billDueList,
  cancelBillingDocument,
  createBillingFromPlanDate,
  postBillingDocument,
} from '@/modules/sales/billing';
import {
  DownPaymentError,
  cancelDownPaymentRequest,
  requestDownPaymentFromPlanDate,
} from '@/modules/sales/down-payment';

const ROUTE = BILLING_ROUTE;

export interface BillingActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  billingNumber?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optional(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value === '' ? undefined : value;
}

function refuse(error: unknown): BillingActionState {
  if (error instanceof BillingError) return { ok: false, message: error.message, remedy: error.remedy };
  // A down payment request is raised from here too, and its refusals are reported the same way — in the
  // service's own words, with the remedy it names.
  if (error instanceof DownPaymentError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

/**
 * Bill a goods-issued delivery. The entry point is the retry-aware one: a delivery that already has an
 * unbilled document standing is posted, not duplicated, and a held document is only released by the credit
 * engine — never here.
 */
export async function createBillingAction(
  _previous: BillingActionState,
  form: FormData,
): Promise<BillingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, BILLING_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the billing capability.', remedy: 'Ask for SALES.BILLING.CREATE.' };
  }
  try {
    const result = await postBillingDocument({
      client: session.user.client,
      changedBy: session.user.username,
      deliveryNumber: text(form, 'deliveryNumber'),
      billingDate: text(form, 'billingDate'),
      requestKey: text(form, 'requestKey') || `BL-${session.user.username}-${Date.now()}`,
    }, { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } });
    revalidatePath(ROUTE);
    if (result.heldForCredit) {
      return {
        ok: false,
        billingNumber: result.billing.billingNumber,
        message: `Billing document ${result.billing.billingNumber} stands, but the receivable is held: the delivery or its order is credit-blocked.`,
        remedy: 'Release the blocked document at /finance/credit-release, then bill again — the same document posts, not a second one.',
      };
    }
    return {
      ok: true,
      billingNumber: result.billing.billingNumber,
      message: result.posted
        ? `Billing document ${result.billing.billingNumber} posted the receivable as invoice ${result.billing.customerInvoiceNumber}.`
        : `Billing document ${result.billing.billingNumber} stands open.`,
      remedy: result.invoice?.dueDate
        ? `The invoice is due ${result.invoice.dueDate}; it appears in the customer's open items and in ageing.`
        : undefined,
    };
  } catch (error) {
    return refuse(error);
  }
}

/**
 * Bill the due list.
 *
 * One submission, one document per group the criteria produce. The capability is the same one billing a
 * single delivery needs, because the run *is* billing: it raises documents and posts receivables, and a
 * separate authority for doing it in bulk would be a second way to post the same money.
 *
 * What is reported back is what the run did to every group, not only to the first: eleven groups is
 * eleven documents, and a reader told only that "the run finished" has no way to know whether the
 * eleventh was held for credit and left standing.
 */
export async function billDueListAction(
  _previous: BillingActionState,
  form: FormData,
): Promise<BillingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, BILLING_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the billing capability.', remedy: 'Ask for SALES.BILLING.CREATE.' };
  }
  try {
    const result = await billDueList({
      client: session.user.client,
      changedBy: session.user.username,
      billingDate: text(form, 'billingDate'),
      postingDate: optional(form, 'postingDate'),
      selection: {
        customerNumber: optional(form, 'customerNumber')?.toUpperCase(),
        salesOrg: optional(form, 'salesOrg'),
        plant: optional(form, 'plant'),
      },
    }, { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } });
    revalidatePath(ROUTE);
    const documents = result.documents;
    if (documents.length === 0) {
      return {
        ok: true,
        message: 'Nothing on the due list was goods-issued and unbilled, so nothing was billed.',
      };
    }
    const posted = documents.filter((row) => row.posted);
    const held = documents.filter((row) => row.heldForCredit);
    const replayed = documents.filter((row) => row.replayed);
    const parts = [
      `${posted.length} of ${documents.length} documents posted`,
      held.length ? `${held.length} held for credit and left standing` : '',
      replayed.length ? `${replayed.length} already billed under this submission` : '',
    ].filter((row) => row);
    return {
      ok: held.length === 0,
      billingNumber: documents[0]?.billing.billingNumber,
      message: `The due list was billed as ${documents.length} `
        + `${documents.length === 1 ? 'document' : 'documents'}: ${parts.join(', ')}.`,
      remedy: held.length
        ? `Release the blocked documents at /finance/credit-release, then bill again — the documents that stand post, and no second document is raised for them.`
        : `Split them differently at ${BILLING_SPLIT_ROUTE}.`,
    };
  } catch (error) {
    return refuse(error);
  }
}

/**
 * Bill a date of an order item's billing plan: the second way a billing document comes to be.
 *
 * Nothing is delivered by it and nothing moves. The value is the order's own arithmetic at the share
 * the plan names — the same conditions, scaled the same way a delivered quantity scales them — so a
 * document raised here is the same document the delivery path would have raised, with no delivery
 * behind it. An item that carries a plan is billed here and nowhere else: the delivery path refuses
 * it by name.
 */
export async function billPlanDateAction(
  _previous: BillingActionState,
  form: FormData,
): Promise<BillingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, BILLING_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the billing capability.', remedy: 'Ask for SALES.BILLING.CREATE.' };
  }
  const orderNumber = text(form, 'orderNumber').toUpperCase();
  const orderLineNumber = Number(text(form, 'orderLineNumber') || '0');
  const dateNumber = Number(text(form, 'dateNumber') || '0');
  try {
    const result = await createBillingFromPlanDate({
      client: session.user.client,
      changedBy: session.user.username,
      orderNumber,
      orderLineNumber,
      dateNumber,
      billingDate: text(form, 'billingDate'),
      requestKey: text(form, 'requestKey') || `BL-PD-${session.user.username}-${Date.now()}`,
    }, { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } });
    revalidatePath(ROUTE);
    if (result.heldForCredit) {
      return {
        ok: false,
        billingNumber: result.billing.billingNumber,
        message: `Billing document ${result.billing.billingNumber} stands, but the receivable is held: order ${orderNumber} is credit-blocked.`,
        remedy: 'Release the blocked document at /finance/credit-release, then bill the same date again — the same document posts, not a second one.',
      };
    }
    return {
      ok: true,
      billingNumber: result.billing.billingNumber,
      message: result.posted
        ? `Date ${dateNumber} of order ${orderNumber} item ${orderLineNumber} billed as ${result.billing.billingNumber}, receivable posted as invoice ${result.billing.customerInvoiceNumber}.`
        : `Billing document ${result.billing.billingNumber} stands open for date ${dateNumber} of order ${orderNumber} item ${orderLineNumber}.`,
      remedy: result.replayed
        ? 'This submission had already raised it; nothing was billed twice.'
        : result.invoice?.dueDate
          ? `The invoice is due ${result.invoice.dueDate}. The date is billed and is not offered again.`
          : 'The date is billed and is not offered again.',
    };
  } catch (error) {
    return refuse(error);
  }
}

/** Cancel a billing document: the receivable leaves the account through the invoice's own cancellation. */
export async function cancelBillingAction(
  _previous: BillingActionState,
  form: FormData,
): Promise<BillingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, BILLING_CANCEL_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the billing cancellation capability.', remedy: 'Ask for SALES.BILLING.CANCEL.' };
  }
  const billingNumber = text(form, 'billingNumber');
  try {
    const result = await cancelBillingDocument({
      client: session.user.client,
      changedBy: session.user.username,
      billingNumber,
      postingDate: text(form, 'cancellationDate'),
      reason: optional(form, 'cancelReason'),
      requestKey: optional(form, 'cancelRequestKey'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      billingNumber,
      message: result.invoice
        ? `Billing document ${billingNumber} cancelled; the receivable was mirrored by invoice ${result.invoice.invoiceNumber}.`
        : `Billing document ${billingNumber} cancelled before it posted, so there was no receivable to mirror.`,
    };
  } catch (error) {
    return refuse(error);
  }
}

/**
 * Ask a plan date's share of an order item in advance.
 *
 * This is the second thing a plan date can do, and it is not billing: no receivable is raised, no
 * revenue is recognised and no journal is written. The document asks the customer for the money and
 * stands behind a noted item in accounting, and the money itself arrives through the receipt, which is
 * accounting's own act. The advance is settled when the invoice that earns it is raised — the invoice
 * clears it, and what is then still to pay is the billed value less the advance.
 *
 * The capability is the billing code and not an accounting one, because asking for an advance from an
 * order is a commercial act and the noted item posts nothing: the money cannot move without the
 * receipt, which is guarded by FIN.AR.DOWNPAYMENT.POST.
 */
export async function requestDownPaymentAction(
  _previous: BillingActionState,
  form: FormData,
): Promise<BillingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, BILLING_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the billing capability.', remedy: 'Ask for SALES.BILLING.CREATE.' };
  }
  const orderNumber = text(form, 'orderNumber').toUpperCase();
  const orderLineNumber = Number(text(form, 'orderLineNumber') || '0');
  const dateNumber = Number(text(form, 'dateNumber') || '0');
  try {
    const result = await requestDownPaymentFromPlanDate({
      client: session.user.client,
      changedBy: session.user.username,
      orderNumber,
      orderLineNumber,
      dateNumber,
      billingDate: text(form, 'billingDate'),
      dueDate: optional(form, 'dueDate'),
      requestKey: text(form, 'requestKey') || `BL-DP-${session.user.username}-${Date.now()}`,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      billingNumber: result.billingNumber,
      message: result.replayed
        ? `The advance of date ${dateNumber} of order ${orderNumber} item ${orderLineNumber} was already asked for as ${result.billingNumber}, under accounting request ${result.requestNumber}.`
        : `Date ${dateNumber} of order ${orderNumber} item ${orderLineNumber} asked ${result.amount} ${result.currency.trim()} in advance as ${result.billingNumber}, under accounting request ${result.requestNumber}.`,
      remedy: result.replayed
        ? 'Nothing was asked for twice: the same submission found the document that stands.'
        : `Nothing has been posted — the request is a noted item, due ${result.dueDate}. The money arrives through the receipt under indicator ${result.targetIndicator}, and the invoice that earns it clears the advance.`,
    };
  } catch (error) {
    return refuse(error);
  }
}

/**
 * Withdraw an advance that was asked for and never paid.
 *
 * The capability is the cancellation code: undoing a document is the same power here as it is for an
 * invoice. What the act refuses is money — a request that has been paid is settled by clearing it
 * against an invoice, not by withdrawing it.
 */
export async function cancelDownPaymentAction(
  _previous: BillingActionState,
  form: FormData,
): Promise<BillingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, BILLING_CANCEL_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the billing cancellation capability.', remedy: 'Ask for SALES.BILLING.CANCEL.' };
  }
  const billingNumber = text(form, 'billingNumber');
  try {
    const result = await cancelDownPaymentRequest({
      client: session.user.client,
      changedBy: session.user.username,
      billingNumber,
      reason: optional(form, 'cancelReason'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      billingNumber,
      message: `Down payment request ${billingNumber} withdrawn, and accounting request ${result.requestNumber} no longer answers.`,
      remedy: result.releasedDate
        ? `Date ${result.releasedDate} of the plan stands open again, so a corrected request can be raised against it.`
        : undefined,
    };
  } catch (error) {
    return refuse(error);
  }
}

/**
 * Bill a delivery again, after the document that billed it was cancelled.
 *
 * Since 9227 a cancelled document stops occupying the delivery's slot: the partial unique index holds
 * one *live* billing document per delivery, and a cancelled one is no longer live. The delivery is
 * therefore billable again, and the corrected document is a real document with a number of its own —
 * not an edit of the cancelled row, which stays behind so the chain remembers what was sent.
 *
 * The capability is the billing code and not a new one, because this is the same act as the first
 * bill: the correction is not a new power over the customer's account, it is the same power exercised
 * again after the previous exercise was undone. What stops a second live document is the database, and
 * what names it when it happens is the service.
 */
export async function rebillDeliveryAction(
  _previous: BillingActionState,
  form: FormData,
): Promise<BillingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, BILLING_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the billing capability.', remedy: 'Ask for SALES.BILLING.CREATE.' };
  }
  const deliveryNumber = text(form, 'deliveryNumber');
  const replaces = optional(form, 'replacesBillingNumber');
  try {
    const result = await postBillingDocument({
      client: session.user.client,
      changedBy: session.user.username,
      deliveryNumber,
      billingDate: text(form, 'billingDate'),
      requestKey: text(form, 'requestKey') || `BL-RE-${session.user.username}-${Date.now()}`,
    }, { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } });
    revalidatePath(ROUTE);
    if (result.heldForCredit) {
      return {
        ok: false,
        billingNumber: result.billing.billingNumber,
        message: `Billing document ${result.billing.billingNumber} stands, but the receivable is held: the delivery or its order is credit-blocked.`,
        remedy: 'Release the blocked document at /finance/credit-release; the corrected document posts from there rather than a second one being raised.',
      };
    }
    return {
      ok: true,
      billingNumber: result.billing.billingNumber,
      message: result.posted
        ? `Delivery ${deliveryNumber} billed again as ${result.billing.billingNumber}`
          + `${replaces ? `, replacing cancelled document ${replaces}` : ''}`
          + `, receivable posted as invoice ${result.billing.customerInvoiceNumber}.`
        : `Billing document ${result.billing.billingNumber} stands open for delivery ${deliveryNumber}.`,
      remedy: result.invoice?.dueDate
        ? `The corrected invoice is due ${result.invoice.dueDate}. The cancelled document stays in the chain, and the delivery carries one live billing document throughout.`
        : 'The cancelled document stays in the chain, and the delivery carries one live billing document throughout.',
    };
  } catch (error) {
    return refuse(error);
  }
}
