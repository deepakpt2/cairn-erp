'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  CUSTOMER_CLEARING_CAPABILITY,
  CustomerClearingError,
  clearCustomerItems,
} from '@/modules/finance/customer-clearing';

export interface CustomerClearingActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/finance/customer-clearing';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function wrap(error: unknown): CustomerClearingActionState {
  if (error instanceof CustomerClearingError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

export async function clearAction(
  _previous: CustomerClearingActionState,
  form: FormData,
): Promise<CustomerClearingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, CUSTOMER_CLEARING_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the customer clearing capability.' };
  }
  try {
    const items = form.getAll('item').map((value) => {
      const [documentNumber, fiscalYear, lineNumber] = String(value).split('|');
      return { documentNumber, fiscalYear: Number(fiscalYear), lineNumber: Number(lineNumber) };
    });
    const result = await clearCustomerItems({
      client: session.user.client, changedBy: session.user.username,
      customer: text(form, 'customer').toUpperCase(), companyCode: text(form, 'companyCode'),
      clearingDate: text(form, 'clearingDate'), postingDate: text(form, 'postingDate'),
      documentDate: text(form, 'documentDate'),
      confirmed: text(form, 'confirmed') === 'yes',
      requestKey: text(form, 'requestKey'),
      items,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Clearing posted as document ${result.clearingDocumentNumber}: ${items.length} items cleared on ${text(form, 'clearingDate')}.`,
    };
  } catch (error) {
    return wrap(error);
  }
}
