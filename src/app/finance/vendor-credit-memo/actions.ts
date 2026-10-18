'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  VENDOR_CREDIT_MEMO_CAPABILITY,
  VendorCreditMemoError,
  postVendorCreditMemo,
} from '@/modules/finance/vendor-credit-memo';
import { cancelVendorInvoice, VendorInvoiceError } from '@/modules/finance/vendor-invoice';

export interface VendorCreditMemoActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  invoiceNumber?: string;
}

const ROUTE = '/finance/vendor-credit-memo';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function guard(session: Awaited<ReturnType<typeof requireSession>>): VendorCreditMemoActionState | null {
  return can(session, VENDOR_CREDIT_MEMO_CAPABILITY)
    ? null
    : { ok: false, message: 'You do not hold the vendor credit memo posting capability.' };
}

function wrap(error: unknown): VendorCreditMemoActionState {
  if (error instanceof VendorCreditMemoError) return { ok: false, message: error.message, remedy: error.remedy };
  if (error instanceof VendorInvoiceError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

export async function postMemoAction(
  _previous: VendorCreditMemoActionState,
  form: FormData,
): Promise<VendorCreditMemoActionState> {
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
        costCenter: text(form, `cc-${i}`) || undefined,
        profitCenter: text(form, `pc-${i}`) || undefined,
        lineText: text(form, `text-${i}`) || undefined,
      });
    }
    const view = await postVendorCreditMemo({
      client: session.user.client, changedBy: session.user.username,
      vendorNumber: text(form, 'vendor').toUpperCase(),
      companyCode: text(form, 'companyCode'),
      documentDate: text(form, 'documentDate'), postingDate: text(form, 'postingDate'),
      reference: text(form, 'reference'), currency: text(form, 'currency').toUpperCase(),
      paymentTermsCode: text(form, 'paymentTerms') || undefined,
      grossAmount: Number(text(form, 'grossAmount')),
      creditOf: text(form, 'creditOf') || undefined,
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
    return wrap(error);
  }
}

export async function cancelMemoAction(
  _previous: VendorCreditMemoActionState,
  form: FormData,
): Promise<VendorCreditMemoActionState> {
  const session = await requireSession(ROUTE);
  const denied = guard(session);
  if (denied) return denied;
  try {
    const view = await cancelVendorInvoice({
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
