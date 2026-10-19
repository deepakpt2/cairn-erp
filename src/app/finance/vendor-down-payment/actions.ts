'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  VENDOR_DOWN_PAYMENT_CAPABILITY,
  VendorDownPaymentError,
  postVendorDownPayment,
} from '@/modules/finance/vendor-down-payment';

export interface VendorDownPaymentActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/finance/vendor-down-payment';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function postDownPaymentAction(
  _previous: VendorDownPaymentActionState,
  form: FormData,
): Promise<VendorDownPaymentActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, VENDOR_DOWN_PAYMENT_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the vendor down payment capability.' };
  }
  try {
    const result = await postVendorDownPayment({
      client: session.user.client, changedBy: session.user.username,
      vendorNumber: text(form, 'vendor').toUpperCase(),
      companyCode: text(form, 'companyCode'),
      documentDate: text(form, 'documentDate'), postingDate: text(form, 'postingDate'),
      bankGlAccount: text(form, 'bankAccount'),
      amount: Number(text(form, 'amount')),
      currency: text(form, 'currency').toUpperCase(),
      specialGlIndicator: text(form, 'specialGlIndicator').toUpperCase(),
      reference: text(form, 'reference') || undefined,
      valueDate: text(form, 'valueDate') || undefined,
      text: text(form, 'text') || undefined,
      requestKey: text(form, 'requestKey') || crypto.randomUUID(),
      requestAllocations: text(form, 'fulfillRequest') ? [{
        requestNumber: text(form, 'fulfillRequest'),
        amount: text(form, 'fulfillAmount') ? Number(text(form, 'fulfillAmount')) : undefined,
      }] : undefined,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Down payment posted as document ${result.journalDocumentNumber}: ${Number(result.amount).toFixed(2)} standing on alternative account ${result.alternativeAccount}.`,
    };
  } catch (error) {
    if (error instanceof VendorDownPaymentError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
