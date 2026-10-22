'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  VENDOR_CLEARING_CAPABILITY,
  VendorClearingError,
  clearVendorItems,
} from '@/modules/finance/vendor-clearing';

export interface VendorClearingActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/finance/vendor-clearing';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function wrap(error: unknown): VendorClearingActionState {
  if (error instanceof VendorClearingError || error instanceof EnqueueError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

export async function clearAction(
  _previous: VendorClearingActionState,
  form: FormData,
): Promise<VendorClearingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, VENDOR_CLEARING_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the vendor clearing capability.' };
  }
  try {
    await assertChangeForSession(session, {
      lockObject: 'VENDOR_ACCOUNT',
      argument: `${text(form, 'supplier')}/${text(form, 'companyCode')}`,
    });
    const items = form.getAll('item').map((value) => {
      const [documentNumber, fiscalYear, lineNumber] = String(value).split('|');
      return { documentNumber, fiscalYear: Number(fiscalYear), lineNumber: Number(lineNumber) };
    });
    const result = await clearVendorItems({
      client: session.user.client, changedBy: session.user.username,
      supplier: text(form, 'supplier'), companyCode: text(form, 'companyCode'),
      clearingDate: text(form, 'clearingDate'), postingDate: text(form, 'postingDate'),
      documentDate: text(form, 'documentDate'),
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
