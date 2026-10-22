'use server';

/**
 * SCR-162 — the blocked-invoice screen's door.
 *
 * A check calls the preview and writes nothing. Place and release call the
 * service. A price, a quantity, a quality reason, an approval, a post, a
 * clear, an export, a batch, an evaluation date and a payment run are passed
 * through, so the service refuses them by name. This screen does not post.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { can, requireSession } from '@/platform/auth/current';
import {
  BLOCKED_INVOICE_CAPABILITY,
  BLOCKED_INVOICE_HOLD_CAPABILITY,
  BLOCKED_INVOICE_ROUTE,
  BlockedInvoiceError,
  placePaymentBlock,
  previewPaymentBlock,
  releasePaymentBlock,
  type BlockedInvoiceInput,
} from '@/modules/purchasing/blocked-invoice';

export interface BlockedInvoiceActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  wrote?: boolean;
  invoiceNumber?: string;
  active?: boolean;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function extras(form: FormData): Partial<BlockedInvoiceInput> {
  const extra: Partial<BlockedInvoiceInput> = {};
  if (text(form, 'price')) extra.price = text(form, 'price');
  if (text(form, 'quantity')) extra.quantity = text(form, 'quantity');
  if (text(form, 'quality')) extra.quality = text(form, 'quality');
  if (text(form, 'reason')) extra.reason = text(form, 'reason');
  if (text(form, 'approval')) extra.approval = text(form, 'approval');
  if (text(form, 'post')) extra.post = text(form, 'post');
  if (text(form, 'clear')) extra.clear = text(form, 'clear');
  if (text(form, 'export')) extra.export = text(form, 'export');
  if (text(form, 'batch')) extra.batch = text(form, 'batch');
  if (text(form, 'evaluationDate')) extra.evaluationDate = text(form, 'evaluationDate');
  if (text(form, 'paymentRun')) extra.paymentRun = text(form, 'paymentRun');
  return extra;
}

function inputOf(form: FormData, changedBy: string, client: string): BlockedInvoiceInput {
  const version = text(form, 'expectedVersion');
  return {
    client,
    changedBy,
    invoiceNumber: text(form, 'invoiceNumber'),
    comment: text(form, 'comment'),
    requestKey: text(form, 'requestKey'),
    expectedVersion: version ? Number(version) : undefined,
    ...extras(form),
  };
}

function refused(caught: unknown): BlockedInvoiceActionState | null {
  if (caught instanceof BlockedInvoiceError) return { ok: false, message: caught.message, remedy: caught.remedy };
  return null;
}

function returnTo(form: FormData, invoiceNumber: string, notice: string): never {
  const params = new URLSearchParams();
  for (const name of ['companyFrom', 'companyTo', 'fiscalYear', 'supplier', 'orderNumber', 'reference', 'includeReleased']) {
    const value = text(form, name);
    if (value) params.set(name, value);
  }
  params.set('invoiceNumber', invoiceNumber);
  params.set('notice', notice);
  redirect(`${BLOCKED_INVOICE_ROUTE}?${params.toString()}`);
}

function missing(which: 'place' | 'release'): BlockedInvoiceActionState {
  const code = which === 'place' ? BLOCKED_INVOICE_HOLD_CAPABILITY : BLOCKED_INVOICE_CAPABILITY;
  return { ok: false, message: `You do not hold ${code}.` };
}

export async function checkBlockedInvoiceAction(
  _state: BlockedInvoiceActionState,
  form: FormData,
): Promise<BlockedInvoiceActionState> {
  const session = await requireSession(BLOCKED_INVOICE_ROUTE);
  const action = text(form, 'intent') === 'place' ? 'place' : 'release';
  const capability = action === 'place' ? BLOCKED_INVOICE_HOLD_CAPABILITY : BLOCKED_INVOICE_CAPABILITY;
  if (!can(session, capability)) return missing(action);
  try {
    const preview = await previewPaymentBlock({
      ...inputOf(form, session.user.username, session.user.client),
      action,
    });
    return { ok: preview.eligible, message: preview.message, wrote: false, invoiceNumber: preview.invoiceNumber, active: preview.active };
  } catch (caught) {
    return refused(caught) ?? { ok: false, message: 'The hold could not be checked.' };
  }
}

export async function placeBlockedInvoiceAction(
  _state: BlockedInvoiceActionState,
  form: FormData,
): Promise<BlockedInvoiceActionState> {
  const session = await requireSession(BLOCKED_INVOICE_ROUTE);
  if (!can(session, BLOCKED_INVOICE_HOLD_CAPABILITY)) return missing('place');
  let result;
  try {
    result = await placePaymentBlock(inputOf(form, session.user.username, session.user.client));
  } catch (caught) {
    return refused(caught) ?? { ok: false, message: 'The hold could not be placed.' };
  }
  revalidatePath(BLOCKED_INVOICE_ROUTE);
  returnTo(
    form,
    result.invoiceNumber,
    result.wrote
      ? `A manual hold stands on ${result.invoiceNumber}. The journal was not changed.`
      : `The same request already stood. ${result.invoiceNumber} was not written again.`,
  );
}

export async function releaseBlockedInvoiceAction(
  _state: BlockedInvoiceActionState,
  form: FormData,
): Promise<BlockedInvoiceActionState> {
  const session = await requireSession(BLOCKED_INVOICE_ROUTE);
  if (!can(session, BLOCKED_INVOICE_CAPABILITY)) return missing('release');
  let result;
  try {
    result = await releasePaymentBlock(inputOf(form, session.user.username, session.user.client));
  } catch (caught) {
    return refused(caught) ?? { ok: false, message: 'The hold could not be released.' };
  }
  revalidatePath(BLOCKED_INVOICE_ROUTE);
  returnTo(
    form,
    result.invoiceNumber,
    result.wrote
      ? `The manual hold on ${result.invoiceNumber} was released. The journal was not changed.`
      : `The same request already stood. ${result.invoiceNumber} was not written again.`,
  );
}


