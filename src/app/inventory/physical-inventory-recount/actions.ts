'use server';

/**
 * SCR-150 — the recount screen's door.
 *
 * The action carries the form to the service and brings back the service's own refusal. A quantity,
 * a posting date, a batch, special stock, a threshold, an account, or a status on the form is
 * refused. Those are not fields this screen has, and a crafted request must not have them quietly
 * dropped. Check writes nothing.
 */
import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { NumberRangeError } from '@/platform/numbering';
import { PeriodError } from '@/platform/periods';
import { PhysicalInventoryError } from '@/modules/inventory/physical-inventory';
import {
  PHYSICAL_INVENTORY_RECOUNT_CAPABILITY,
  PHYSICAL_INVENTORY_RECOUNT_ROUTE,
  PhysicalInventoryRecountError,
  cancelRecount,
  createRecount,
  validateRecount,
  type RecountPreview,
  type RecountView,
} from '@/modules/inventory/physical-inventory-recount';

export interface RecountActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  preview?: RecountPreview | null;
  recount?: RecountView | null;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function raw(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function named(form: FormData, pattern: RegExp): boolean {
  return [...form.keys()].some((name) => pattern.test(name));
}

function clientSupplied(form: FormData): string | null {
  const messages: string[] = [];
  if (named(form, /^(quantity|countedQuantity|recountQuantity)$/)) {
    messages.push('The recount quantity is entered on the count of the new document. This screen does not take a quantity.');
  }
  if (named(form, /^(postingDate|documentDate)$/)) {
    messages.push('A planned recount date is not a posting date. This screen does not post.');
  }
  if (named(form, /^(batch|specialStock|serial)$/)) {
    messages.push('Batch and special stock are not carried on a recount.');
  }
  if (named(form, /^(varianceThreshold|threshold)$/)) {
    messages.push('A variance threshold is not implemented, and it will not recommend or hide an item.');
  }
  if (named(form, /^(companyCode|company_code)$/)) {
    messages.push('The company code is not taken from the request. It is the plant\'s.');
  }
  if (named(form, /^(amount|glAccount|account|stock|bookQuantity|postingStatus|countStatus)$/)) {
    messages.push('The stock, the amount, the account and the status are not taken from the request.');
  }
  return messages.length > 0 ? messages.join(' ') : null;
}

function selectionOf(form: FormData) {
  return {
    documentNumber: text(form, 'documentNumber'),
    fiscalYear: Number(text(form, 'fiscalYear')),
    itemNumbers: form.getAll('item').map((value) => Number(value)).filter((value) => Number.isInteger(value)),
    plannedRecountDate: text(form, 'plannedRecountDate'),
    reason: raw(form, 'reason'),
    headerText: raw(form, 'headerText'),
  };
}

function refused(caught: unknown): RecountActionState | null {
  if (
    caught instanceof PhysicalInventoryRecountError
    || caught instanceof PhysicalInventoryError
    || caught instanceof PeriodError
    || caught instanceof NumberRangeError
  ) {
    const remedy = 'remedy' in caught && typeof caught.remedy === 'string' ? caught.remedy : undefined;
    return { ok: false, message: caught.message, remedy };
  }
  return null;
}

function missing(): RecountActionState {
  return {
    ok: false,
    message: `You do not hold the recount capability (${PHYSICAL_INVENTORY_RECOUNT_CAPABILITY}). A count permission does not recount, and a posting permission does not recount.`,
  };
}

export async function checkRecountAction(
  _previous: RecountActionState,
  form: FormData,
): Promise<RecountActionState> {
  const session = await requireSession(PHYSICAL_INVENTORY_RECOUNT_ROUTE);
  if (!can(session, PHYSICAL_INVENTORY_RECOUNT_CAPABILITY)) return missing();
  const supplied = clientSupplied(form);
  if (supplied) return { ok: false, message: supplied };
  try {
    const preview = await validateRecount({
      client: session.user.client,
      changedBy: session.user.username,
      ...selectionOf(form),
    });
    return {
      ok: true,
      message: 'The selection can be recounted. Nothing was written. The book shown is the stock standing now, not the original snapshot.',
      preview,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}

export async function createRecountAction(
  _previous: RecountActionState,
  form: FormData,
): Promise<RecountActionState> {
  const session = await requireSession(PHYSICAL_INVENTORY_RECOUNT_ROUTE);
  if (!can(session, PHYSICAL_INVENTORY_RECOUNT_CAPABILITY)) return missing();
  const supplied = clientSupplied(form);
  if (supplied) return { ok: false, message: supplied };
  try {
    const recount = await createRecount({
      client: session.user.client,
      changedBy: session.user.username,
      requestKey: text(form, 'requestKey'),
      ...selectionOf(form),
    });
    revalidatePath(PHYSICAL_INVENTORY_RECOUNT_ROUTE);
    return {
      ok: true,
      message: `Recount document ${recount.recountDocumentNumber} stands. Enter the count on that document. The original count was not changed.`,
      recount,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}

export async function cancelRecountAction(
  _previous: RecountActionState,
  form: FormData,
): Promise<RecountActionState> {
  const session = await requireSession(PHYSICAL_INVENTORY_RECOUNT_ROUTE);
  if (!can(session, PHYSICAL_INVENTORY_RECOUNT_CAPABILITY)) return missing();
  if (named(form, /^(postingDate)$/)) {
    return { ok: false, message: 'Cancellation is not a reversal, and it is not a posting.' };
  }
  try {
    const recount = await cancelRecount({
      client: session.user.client,
      changedBy: session.user.username,
      recountDocumentNumber: text(form, 'recountDocumentNumber'),
      recountFiscalYear: Number(text(form, 'recountFiscalYear')),
      reason: raw(form, 'reason'),
    });
    revalidatePath(PHYSICAL_INVENTORY_RECOUNT_ROUTE);
    return {
      ok: true,
      message: `Recount ${recount.recountDocumentNumber} is cancelled. The link is kept. A posted recount is not reversed here.`,
      recount,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}
