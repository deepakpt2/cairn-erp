'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  CUSTOMER_CREDIT_MEMO_CAPABILITY,
  CustomerCreditMemoError,
  getCustomerCreditMemo,
  postCustomerCreditMemo,
} from '@/modules/finance/customer-credit-memo';
import { cancelCustomerInvoice, CustomerInvoiceError } from '@/modules/finance/customer-invoice';

const ROUTE = '/sales/credit-memo';

export interface CreditMemoActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  invoiceNumber?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optional(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value === '' ? undefined : value;
}

function refuse(error: unknown): CreditMemoActionState {
  if (error instanceof CustomerCreditMemoError) return { ok: false, message: error.message, remedy: error.remedy };
  if (error instanceof CustomerInvoiceError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

/** Post a customer credit memo against an original billing document or invoice. */
export async function postCreditMemoAction(
  _previous: CreditMemoActionState,
  form: FormData,
): Promise<CreditMemoActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, CUSTOMER_CREDIT_MEMO_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the customer credit memo posting capability.', remedy: 'Ask for FIN.AR.CREDITMEMO.POST.' };
  }
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
    const view = await postCustomerCreditMemo({
      client: session.user.client, changedBy: session.user.username,
      customerNumber: text(form, 'customer').toUpperCase(),
      companyCode: text(form, 'companyCode'),
      documentDate: text(form, 'documentDate'), postingDate: text(form, 'postingDate'),
      reference: text(form, 'reference'), currency: text(form, 'currency').toUpperCase(),
      paymentTermsCode: text(form, 'paymentTerms') || undefined,
      grossAmount: Number(text(form, 'grossAmount')),
      creditOfBilling: optional(form, 'creditOfBilling'),
      creditOfInvoice: optional(form, 'creditOfInvoice'),
      headerText: text(form, 'headerText') || undefined,
      requestKey: text(form, 'requestKey') || crypto.randomUUID(),
      lines,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Credit memo posted as document ${view.invoiceNumber}; journal ${view.journalDocumentNumber}.`,
      invoiceNumber: view.invoiceNumber,
    };
  } catch (error) {
    return refuse(error);
  }
}

/** Cancel a posted credit memo through the invoice's own linked mirror. */
export async function cancelCreditMemoAction(
  _previous: CreditMemoActionState,
  form: FormData,
): Promise<CreditMemoActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, CUSTOMER_CREDIT_MEMO_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the customer credit memo posting capability.', remedy: 'Ask for FIN.AR.CREDITMEMO.POST.' };
  }
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
    return refuse(error);
  }
}
