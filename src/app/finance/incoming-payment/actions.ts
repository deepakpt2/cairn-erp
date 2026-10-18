'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  INCOMING_PAYMENT_CAPABILITY,
  IncomingPaymentError,
  postIncomingPayment,
} from '@/modules/finance/incoming-payment';

export interface IncomingPaymentActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/finance/incoming-payment';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function wrap(error: unknown): IncomingPaymentActionState {
  if (error instanceof IncomingPaymentError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

export async function postPaymentAction(
  _previous: IncomingPaymentActionState,
  form: FormData,
): Promise<IncomingPaymentActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, INCOMING_PAYMENT_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the incoming payment capability.' };
  }
  try {
    const items = form.getAll('item').map((value) => {
      const [documentNumber, fiscalYear, lineNumber] = String(value).split('|');
      return { documentNumber, fiscalYear: Number(fiscalYear), lineNumber: Number(lineNumber) };
    });
    const result = await postIncomingPayment({
      client: session.user.client, changedBy: session.user.username,
      customerNumber: text(form, 'customer').toUpperCase(),
      companyCode: text(form, 'companyCode'),
      documentDate: text(form, 'documentDate'), postingDate: text(form, 'postingDate'),
      clearingDate: text(form, 'clearingDate') || text(form, 'postingDate'),
      bankGlAccount: text(form, 'bankAccount'),
      amount: Number(text(form, 'amount')),
      currency: text(form, 'currency').toUpperCase(),
      reference: text(form, 'reference') || undefined,
      onAccountAmount: Number(text(form, 'onAccount')) || 0,
      requestKey: text(form, 'requestKey') || crypto.randomUUID(),
      items,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Payment posted as document ${result.journalDocumentNumber}: ${result.itemsCleared} items cleared on ${result.clearingDate}.`,
    };
  } catch (error) {
    return wrap(error);
  }
}
