'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  BILLING_CANCEL_CAPABILITY,
  BILLING_CAPABILITY,
  BILLING_ROUTE,
  BillingError,
  cancelBillingDocument,
  postBillingDocument,
} from '@/modules/sales/billing';

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
    });
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
