'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  CUSTOMER_INVOICE_CAPABILITY,
  CustomerInvoiceError,
  cancelCustomerInvoice,
  postCustomerInvoice,
} from '@/modules/finance/customer-invoice';

export interface CustomerInvoiceActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  invoiceNumber?: string;
}

const ROUTE = '/finance/customer-invoice';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function guard(session: Awaited<ReturnType<typeof requireSession>>): CustomerInvoiceActionState | null {
  return can(session, CUSTOMER_INVOICE_CAPABILITY)
    ? null
    : { ok: false, message: 'You do not hold the customer invoice posting capability.' };
}

function wrap(error: unknown): CustomerInvoiceActionState {
  if (error instanceof CustomerInvoiceError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

export async function postInvoiceAction(
  _previous: CustomerInvoiceActionState,
  form: FormData,
): Promise<CustomerInvoiceActionState> {
  const session = await requireSession(ROUTE);
  const denied = guard(session);
  if (denied) return denied;
  try {
    const count = Number(text(form, 'lineCount') || 1);
    const lines = [];
    for (let i = 1; i <= Math.max(1, count); i += 1) {
      const glAccount = text(form, `gl-${i}`);
      const netAmount = Number(text(form, `net-${i}`));
      if (!glAccount && !netAmount) continue;
      lines.push({
        glAccount, netAmount,
        taxCode: text(form, `tax-${i}`) || undefined,
        profitCenter: text(form, `pc-${i}`) || undefined,
        lineText: text(form, `text-${i}`) || undefined,
      });
    }
    const view = await postCustomerInvoice({
      client: session.user.client, changedBy: session.user.username,
      customerNumber: text(form, 'customer').toUpperCase(),
      companyCode: text(form, 'companyCode'),
      documentDate: text(form, 'documentDate'), postingDate: text(form, 'postingDate'),
      reference: text(form, 'reference'), currency: text(form, 'currency').toUpperCase(),
      paymentTermsCode: text(form, 'paymentTerms') || undefined,
      grossAmount: Number(text(form, 'grossAmount')),
      headerText: text(form, 'headerText') || undefined,
      requestKey: text(form, 'requestKey') || crypto.randomUUID(),
      lines,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Invoice posted as document ${view.invoiceNumber}; journal ${view.journalDocumentNumber}.`,
      invoiceNumber: view.invoiceNumber,
    };
  } catch (error) {
    return wrap(error);
  }
}

export async function cancelInvoiceAction(
  _previous: CustomerInvoiceActionState,
  form: FormData,
): Promise<CustomerInvoiceActionState> {
  const session = await requireSession(ROUTE);
  const denied = guard(session);
  if (denied) return denied;
  try {
    const view = await cancelCustomerInvoice({
      client: session.user.client, changedBy: session.user.username,
      invoiceNumber: text(form, 'invoice'),
      postingDate: text(form, 'cancelDate'),
      requestKey: text(form, 'requestKey') || crypto.randomUUID(),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Cancellation posted as document ${view.invoiceNumber}; journal ${view.journalDocumentNumber}.`,
      invoiceNumber: view.invoiceNumber,
    };
  } catch (error) {
    return wrap(error);
  }
}
