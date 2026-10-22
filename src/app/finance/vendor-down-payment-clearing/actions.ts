'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  VENDOR_DOWN_PAYMENT_CLEARING_CAPABILITY,
  VendorDownPaymentClearingError,
  clearDownPayments,
  type ClearingItemRef,
} from '@/modules/finance/vendor-down-payment-clearing';

export interface DownPaymentClearingActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/finance/vendor-down-payment-clearing';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function parseItems(form: FormData, boxName: string, amountPrefix: string): ClearingItemRef[] {
  return form.getAll(boxName).map((value) => {
    const [documentNumber, fiscalYear, lineNumber] = String(value).split('|');
    const key = `${documentNumber}|${fiscalYear}|${lineNumber}`;
    const amountText = text(form, `${amountPrefix}${key}`);
    return {
      documentNumber, fiscalYear: Number(fiscalYear), lineNumber: Number(lineNumber),
      applied: amountText ? Number(amountText) : undefined,
    };
  });
}

export async function postClearingAction(
  _previous: DownPaymentClearingActionState,
  form: FormData,
): Promise<DownPaymentClearingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, VENDOR_DOWN_PAYMENT_CLEARING_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the down payment clearing capability.' };
  }
  try {
    await assertChangeForSession(session, {
      lockObject: 'VENDOR_DOWN_PAYMENT',
      argument: `${text(form, 'vendor')}/${text(form, 'companyCode')}/${text(form, 'indicator')}`,
    });
    const result = await clearDownPayments({
      client: session.user.client, changedBy: session.user.username,
      vendorNumber: text(form, 'vendor').toUpperCase(),
      companyCode: text(form, 'companyCode'),
      indicator: text(form, 'indicator').toUpperCase(),
      documentDate: text(form, 'documentDate'), postingDate: text(form, 'postingDate'),
      clearingDate: text(form, 'clearingDate') || text(form, 'postingDate'),
      currency: text(form, 'currency').toUpperCase(),
      reference: text(form, 'reference') || undefined,
      requestKey: text(form, 'requestKey') || crypto.randomUUID(),
      downPayments: parseItems(form, 'downPayment', 'apply-dp-'),
      invoices: parseItems(form, 'invoice', 'settle-inv-'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Clearing posted as document ${result.journalDocumentNumber}: ${Number(result.totalApplied).toFixed(2)} applied on ${result.clearingDate}, ${result.itemsCleared} items cleared in full.`,
    };
  } catch (error) {
    if (error instanceof EnqueueError || error instanceof VendorDownPaymentClearingError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
