'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  VENDOR_DOWN_PAYMENT_REQUEST_CAPABILITY,
  VendorDownPaymentRequestError,
  createVendorDownPaymentRequest,
} from '@/modules/finance/vendor-down-payment-request';

export interface VendorRequestActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/finance/vendor-down-payment-request';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function postVendorRequestAction(
  _previous: VendorRequestActionState,
  form: FormData,
): Promise<VendorRequestActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, VENDOR_DOWN_PAYMENT_REQUEST_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the vendor down payment request capability.' };
  }
  try {
    const result = await createVendorDownPaymentRequest({
      client: session.user.client, changedBy: session.user.username,
      vendorNumber: text(form, 'vendor').toUpperCase(),
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
    if (error instanceof VendorDownPaymentRequestError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
