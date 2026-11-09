'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  INVOICE_LIST_CREATE_CAPABILITY,
  INVOICE_LIST_RELEASE_CAPABILITY,
  INVOICE_LIST_ROUTE,
  InvoiceListError,
  cancelInvoiceList,
  createInvoiceList,
  releaseInvoiceList,
} from '@/modules/sales/invoice-list';

const ROUTE = INVOICE_LIST_ROUTE;

export interface InvoiceListActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  /** The list an act produced, so the screen can say which document the reader is looking at. */
  invoiceListNumber?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optional(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value === '' ? undefined : value;
}

function refuse(error: unknown): InvoiceListActionState {
  if (error instanceof InvoiceListError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  // The accounting-invoice service refuses in its own words, and those are the words a clerk has to
  // act on: a receivable that will not post is a customer or an account, not a list.
  if (error instanceof Error) return { ok: false, message: error.message };
  throw error;
}

function denied(capability: string): InvoiceListActionState {
  return {
    ok: false,
    message: `You do not hold the authority ${capability}.`,
    remedy: 'Ask an administrator for an exact-code role assignment; wildcard role patterns do not grant this authority.',
  };
}

/**
 * Group the chosen documents onto a list — `VF21`.
 *
 * The documents are what the screen showed as waiting, named one by one rather than restated as a
 * selection: what is grouped has to be what the reader ticked, and not what the queue holds by the
 * time the form arrives. A refusal that names a document names the one that moved.
 */
export async function createInvoiceListAction(
  _previous: InvoiceListActionState,
  form: FormData,
): Promise<InvoiceListActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, INVOICE_LIST_CREATE_CAPABILITY)) return denied(INVOICE_LIST_CREATE_CAPABILITY);

  const billingNumbers = form.getAll('billingNumber')
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map((value) => value.trim().toUpperCase());
  try {
    const { list, listed } = await createInvoiceList({
      client: session.user.client,
      changedBy: session.user.username,
      billingNumbers,
      referenceDocumentText: optional(form, 'referenceDocumentText'),
      requestKey: optional(form, 'requestKey'),
      transactionCode: INVOICE_LIST_CREATE_CAPABILITY,
    });
    revalidatePath(ROUTE);
    revalidatePath('/sales/billing');
    return {
      ok: true,
      message: `Invoice list ${list.header.billingNumber} groups ${listed.length} document${listed.length === 1 ? '' : 's'}, `
        + `worth ${list.header.grossValue.toFixed(2)} ${list.header.currency}. Nothing is posted: the release does that.`,
      invoiceListNumber: list.header.billingNumber,
    };
  } catch (error) {
    return refuse(error);
  }
}

/**
 * Release a list to accounting — `VF24`.
 *
 * This is the act that posts, and it is guarded separately from grouping for the same reason SAP keeps
 * `VF21` and `VF24` apart: whoever assembles the month is not automatically who commits the company to
 * a receivable. The version the screen read is sent back, so a list that changed underneath refuses
 * rather than posting twice.
 */
export async function releaseInvoiceListAction(
  _previous: InvoiceListActionState,
  form: FormData,
): Promise<InvoiceListActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, INVOICE_LIST_RELEASE_CAPABILITY)) return denied(INVOICE_LIST_RELEASE_CAPABILITY);

  const expectedVersion = Number(text(form, 'version'));
  try {
    const result = await releaseInvoiceList({
      client: session.user.client,
      changedBy: session.user.username,
      invoiceListNumber: text(form, 'invoiceListNumber'),
      postingDate: optional(form, 'postingDate'),
      expectedVersion: Number.isFinite(expectedVersion) ? expectedVersion : undefined,
      transactionCode: INVOICE_LIST_RELEASE_CAPABILITY,
    });
    revalidatePath(ROUTE);
    revalidatePath('/sales/billing');
    if (result.replayed) {
      return {
        ok: true,
        message: `Invoice list ${result.list.header.billingNumber} stands released already, as `
          + `${result.list.header.customerInvoiceNumber}. Nothing was posted twice.`,
        invoiceListNumber: result.list.header.billingNumber,
      };
    }
    return {
      ok: true,
      message: `Invoice list ${result.list.header.billingNumber} is released to accounting as `
        + `${result.invoice?.invoiceNumber ?? ''} — one receivable for `
        + `${result.list.items.length} document${result.list.items.length === 1 ? '' : 's'}, against the payer it names.`,
      invoiceListNumber: result.list.header.billingNumber,
    };
  } catch (error) {
    return refuse(error);
  }
}

/**
 * Cancel a list that has not been released: the members go back to being due, to be listed again or
 * released on their own. A released list is a receivable, and a receivable is cancelled in accounting.
 */
export async function cancelInvoiceListAction(
  _previous: InvoiceListActionState,
  form: FormData,
): Promise<InvoiceListActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, INVOICE_LIST_CREATE_CAPABILITY)) return denied(INVOICE_LIST_CREATE_CAPABILITY);

  const expectedVersion = Number(text(form, 'version'));
  try {
    const list = await cancelInvoiceList({
      client: session.user.client,
      changedBy: session.user.username,
      invoiceListNumber: text(form, 'invoiceListNumber'),
      reason: optional(form, 'reason'),
      expectedVersion: Number.isFinite(expectedVersion) ? expectedVersion : undefined,
      transactionCode: INVOICE_LIST_CREATE_CAPABILITY,
    });
    revalidatePath(ROUTE);
    revalidatePath('/sales/billing');
    return {
      ok: true,
      message: `Invoice list ${list.header.billingNumber} is cancelled. Nothing was posted, so the documents go back on the due list.`,
      invoiceListNumber: list.header.billingNumber,
    };
  } catch (error) {
    return refuse(error);
  }
}
