'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  OUTGOING_PAYMENT_CAPABILITY,
  OutgoingPaymentError,
  postOutgoingPayment,
} from '@/modules/finance/outgoing-payment';

export interface OutgoingPaymentActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/finance/outgoing-payment';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function wrap(error: unknown): OutgoingPaymentActionState {
  if (error instanceof OutgoingPaymentError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

export async function postPaymentAction(
  _previous: OutgoingPaymentActionState,
  form: FormData,
): Promise<OutgoingPaymentActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, OUTGOING_PAYMENT_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the outgoing payment capability.' };
  }
  try {
    const items = form.getAll('item').map((value) => {
      const [documentNumber, fiscalYear, lineNumber] = String(value).split('|');
      return { documentNumber, fiscalYear: Number(fiscalYear), lineNumber: Number(lineNumber) };
    });
    const result = await postOutgoingPayment({
      client: session.user.client, changedBy: session.user.username,
      vendorNumber: text(form, 'vendor').toUpperCase(),
      companyCode: text(form, 'companyCode'),
      documentDate: text(form, 'documentDate'), postingDate: text(form, 'postingDate'),
      clearingDate: text(form, 'clearingDate') || text(form, 'postingDate'),
      bankGlAccount: text(form, 'bankAccount'),
      amount: Number(text(form, 'amount')),
      currency: text(form, 'currency').toUpperCase(),
      reference: text(form, 'reference') || undefined,
      valueDate: text(form, 'valueDate') || undefined,
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
