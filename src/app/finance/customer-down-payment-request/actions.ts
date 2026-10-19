'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  CUSTOMER_DOWN_PAYMENT_REQUEST_CAPABILITY,
  CustomerDownPaymentRequestError,
  createCustomerDownPaymentRequest,
} from '@/modules/finance/customer-down-payment-request';

export interface DownPaymentRequestActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/finance/customer-down-payment-request';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function postRequestAction(
  _previous: DownPaymentRequestActionState,
  form: FormData,
): Promise<DownPaymentRequestActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, CUSTOMER_DOWN_PAYMENT_REQUEST_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the down payment request capability.' };
  }
  try {
    const result = await createCustomerDownPaymentRequest({
      client: session.user.client, changedBy: session.user.username,
      customerNumber: text(form, 'customer').toUpperCase(),
      companyCode: text(form, 'companyCode'),
      documentDate: text(form, 'documentDate'), postingDate: text(form, 'postingDate'),
      dueDate: text(form, 'dueDate'),
      amount: Number(text(form, 'amount')),
      currency: text(form, 'currency').toUpperCase(),
      specialGlIndicator: text(form, 'indicator').toUpperCase(),
      documentType: text(form, 'documentType').toUpperCase(),
      reference: text(form, 'reference') || undefined,
      requestKey: text(form, 'requestKey') || crypto.randomUUID(),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Request ${result.requestNumber} posted: ${Number(result.requestedAmount).toFixed(2)} standing open, expecting indicator ${result.targetIndicator} at fulfillment.`,
    };
  } catch (error) {
    if (error instanceof CustomerDownPaymentRequestError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
