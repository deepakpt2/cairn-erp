'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  CUSTOMER_DOWN_PAYMENT_CLEARING_CAPABILITY,
  CustomerDownPaymentClearingError,
  clearCustomerDownPayments,
  type ClearingAllocation,
  type ClearingItemRef,
} from '@/modules/finance/customer-down-payment-clearing';

export interface CustomerClearingActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/finance/customer-down-payment-clearing';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function parseRef(key: string): ClearingItemRef {
  const [documentNumber, fiscalYear, lineNumber] = key.split('|');
  return { documentNumber, fiscalYear: Number(fiscalYear), lineNumber: Number(lineNumber) };
}

function parseAllocations(form: FormData): ClearingAllocation[] {
  const raw = text(form, 'allocations');
  if (!raw) return [];
  const rows = JSON.parse(raw) as Array<{ downPaymentKey?: string; invoiceKey?: string; amount?: string }>;
  return rows
    .filter((r) => r.downPaymentKey && r.invoiceKey && r.amount)
    .map((r) => ({
      downPayment: parseRef(r.downPaymentKey!),
      invoice: parseRef(r.invoiceKey!),
      amount: Number(r.amount),
    }));
}

export async function postCustomerClearingAction(
  _previous: CustomerClearingActionState,
  form: FormData,
): Promise<CustomerClearingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, CUSTOMER_DOWN_PAYMENT_CLEARING_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the customer down payment clearing capability.' };
  }
  try {
    const result = await clearCustomerDownPayments({
      client: session.user.client, changedBy: session.user.username,
      customerNumber: text(form, 'customer').toUpperCase(),
      companyCode: text(form, 'companyCode'),
      indicator: text(form, 'indicator').toUpperCase(),
      documentDate: text(form, 'documentDate'), postingDate: text(form, 'postingDate'),
      clearingDate: text(form, 'clearingDate') || text(form, 'postingDate'),
      currency: text(form, 'currency').toUpperCase(),
      reference: text(form, 'reference') || undefined,
      requestKey: text(form, 'requestKey') || crypto.randomUUID(),
      allocations: parseAllocations(form),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Clearing posted as document ${result.journalDocumentNumber}: ${Number(result.totalApplied).toFixed(2)} applied on ${result.clearingDate}, ${result.itemsCleared} items cleared in full.`,
    };
  } catch (error) {
    if (error instanceof CustomerDownPaymentClearingError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
