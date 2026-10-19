'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  CUSTOMER_DOWN_PAYMENT_CAPABILITY,
  CustomerDownPaymentError,
  postCustomerDownPayment,
} from '@/modules/finance/customer-down-payment';

export interface CustomerDownPaymentActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/finance/customer-down-payment';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function postDownPaymentAction(
  _previous: CustomerDownPaymentActionState,
  form: FormData,
): Promise<CustomerDownPaymentActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, CUSTOMER_DOWN_PAYMENT_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the customer down payment capability.' };
  }
  try {
    const result = await postCustomerDownPayment({
      client: session.user.client, changedBy: session.user.username,
      customerNumber: text(form, 'customer').toUpperCase(),
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
    if (error instanceof CustomerDownPaymentError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
