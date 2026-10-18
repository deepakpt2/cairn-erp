'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  INVOICE_CAPABILITY,
  InvoiceVerificationError,
  cancelSupplierInvoice,
  postSupplierInvoice,
} from '@/modules/purchasing/invoice-verification';

export interface InvoiceActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  documentNumber?: string;
}

const ROUTE = '/purchasing/invoice-verification';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function postInvoiceAction(
  _previous: InvoiceActionState,
  form: FormData,
): Promise<InvoiceActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, INVOICE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the invoice recording capability.' };
  }
  const lines: Array<{ itemNumber: number; quantity: number; netAmount: number; taxCode?: string }> = [];
  for (const [key, value] of form.entries()) {
    if (!key.startsWith('qty-')) continue;
    const quantity = Number(value);
    if (quantity > 0) {
      const itemNumber = Number(key.slice(4));
      lines.push({
        itemNumber,
        quantity,
        netAmount: Number(form.get(`amt-${itemNumber}`)),
        taxCode: text(form, `tax-${itemNumber}`) || undefined,
      });
    }
  }
  try {
    const doc = await postSupplierInvoice({
      client: session.user.client,
      changedBy: session.user.username,
      orderNumber: text(form, 'orderNumber'),
      supplierReference: text(form, 'supplierReference'),
      invoiceDate: text(form, 'invoiceDate'),
      postingDate: text(form, 'postingDate'),
      grossAmount: Number(form.get('grossAmount')),
      headerText: text(form, 'headerText') || undefined,
      requestKey: text(form, 'requestKey'),
      lines,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Invoice posted as document ${doc.invoiceNumber}; journal ${doc.journalDocumentNumber}.`,
      documentNumber: doc.invoiceNumber,
    };
  } catch (error) {
    if (error instanceof InvoiceVerificationError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

export async function cancelInvoiceAction(
  _previous: InvoiceActionState,
  form: FormData,
): Promise<InvoiceActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, INVOICE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the invoice recording capability.' };
  }
  try {
    const doc = await cancelSupplierInvoice({
      client: session.user.client,
      changedBy: session.user.username,
      invoiceNumber: text(form, 'invoiceNumber'),
      postingDate: text(form, 'postingDate'),
      requestKey: text(form, 'requestKey'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Cancellation posted as document ${doc.invoiceNumber}.`,
      documentNumber: doc.invoiceNumber,
    };
  } catch (error) {
    if (error instanceof InvoiceVerificationError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}
