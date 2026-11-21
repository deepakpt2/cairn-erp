'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { PdfDownloadError } from '@/modules/output/download-pdf';
import { salesQuotationPdf } from '@/modules/sales/quotation-print';
import type { PdfDownloadState } from '@/ui/output/DocumentPrint';
import { SALES_ORDER_CAPABILITY } from '@/modules/sales/sales-order';
import {
  SALES_QUOTATION_CAPABILITY,
  SALES_QUOTATION_ROUTE,
  SalesQuotationError,
  changeQuotation,
  createOrderFromQuotation,
  createQuotation,
  rejectQuotation,
  type QuotationCreateInput,
} from '@/modules/sales/quotation';

const ROUTE = SALES_QUOTATION_ROUTE;
/** The bound the order screen and the service agree on: a form can say anything, and a server must not believe it. */
const MAX_POSTED_ROWS = 999;

export interface QuotationActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  quotationNumber?: string;
  orderNumber?: string;
}

const NOT_ALLOWED: QuotationActionState = {
  ok: false,
  message: 'You do not hold the sales quotation capability.',
  remedy: 'Ask for SALES.QUOTATION.CREATE.',
};

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optional(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value === '' ? undefined : value;
}

function postedRows(form: FormData): number {
  const raw = Number(text(form, 'lineCount') || '0');
  if (!Number.isFinite(raw) || raw < 1) return 0;
  return Math.min(Math.trunc(raw), MAX_POSTED_ROWS);
}

/** Numbered slots; a slot with no material is not an item, and a half-filled one is refused by the service. */
function linesFrom(form: FormData, numbered: boolean): QuotationCreateInput['lines'] {
  const lines: QuotationCreateInput['lines'] = [];
  for (let slot = 1; slot <= postedRows(form); slot += 1) {
    const materialNumber = text(form, `line-${slot}-material`);
    if (!materialNumber) continue;
    const given = numbered ? Number(text(form, `line-${slot}-lineNumber`) || '0') : 0;
    const entry: QuotationCreateInput['lines'][number] = {
      lineNumber: given > 0 ? given : undefined,
      materialNumber,
      plant: text(form, `line-${slot}-plant`),
      orderQuantity: Number(text(form, `line-${slot}-quantity`) || '0'),
    };
    const unit = optional(form, `line-${slot}-unit`);
    if (unit) entry.quantityUnit = unit;
    const tax = optional(form, `line-${slot}-tax`);
    if (tax) entry.taxCode = tax;
    const profitCenter = optional(form, `line-${slot}-profitCenter`);
    if (profitCenter) entry.profitCenter = profitCenter;
    const needDate = optional(form, `line-${slot}-needed`);
    if (needDate) entry.requestedDeliveryDate = needDate;
    lines.push(entry);
  }
  return lines;
}

function headerFrom(form: FormData) {
  return {
    salesOrg: text(form, 'salesOrg'),
    distributionChannel: text(form, 'distributionChannel'),
    division: text(form, 'division'),
    customerNumber: text(form, 'customerNumber'),
    companyCode: text(form, 'companyCode'),
    currency: text(form, 'currency'),
    quotationDate: text(form, 'quotationDate'),
    validTo: text(form, 'validTo'),
    ...(optional(form, 'requestedDate') ? { requestedDate: optional(form, 'requestedDate') } : {}),
    purchaseOrderReference: optional(form, 'purchaseOrderReference'),
    headerText: optional(form, 'headerText'),
  };
}

/** `rejectLines` posts as "20=PRCE, 30=STCK": the item number and its reason, one pair per item. */
function rejectLinesFrom(form: FormData): Array<{ lineNumber: number; reason: string }> {
  return text(form, 'rejectLines').split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [number = '', reason = ''] = part.split('=');
    return { lineNumber: Number(number.trim()), reason: reason.trim() };
  });
}

function refusal(error: unknown): QuotationActionState {
  if (error instanceof SalesQuotationError) return { ok: false, message: error.message, remedy: error.remedy };
  // A malformed field is the person's to fix, not a crash.
  if (error instanceof Error && error.name === 'ZodError') {
    return { ok: false, message: 'A field is missing or malformed.', remedy: 'Check the dates (YYYY-MM-DD), the quantities, and that every item names a material.' };
  }
  throw error;
}

const authorizationOf = (session: Awaited<ReturnType<typeof requireSession>>) =>
  ({ userId: session.user.userId, sessionId: session.sessionId ?? '' });

export async function createQuotationAction(_previous: QuotationActionState, form: FormData): Promise<QuotationActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SALES_QUOTATION_CAPABILITY)) return NOT_ALLOWED;
  try {
    const result = await createQuotation({
      client: session.user.client,
      changedBy: session.user.username,
      ...headerFrom(form),
      lines: linesFrom(form, false),
      requestKey: text(form, 'requestKey') || `SQ-${session.user.username}-${Date.now()}`,
    }, { authorization: authorizationOf(session) });
    revalidatePath(ROUTE);
    return { ok: true, quotationNumber: result.quotationNumber, message: `Quotation ${result.quotationNumber} created, valid to ${result.validTo}. It consumes no availability and is not judged for credit.` };
  } catch (error) {
    return refusal(error);
  }
}

export async function changeQuotationAction(_previous: QuotationActionState, form: FormData): Promise<QuotationActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SALES_QUOTATION_CAPABILITY)) return NOT_ALLOWED;
  try {
    const result = await changeQuotation({
      client: session.user.client,
      changedBy: session.user.username,
      quotationNumber: text(form, 'quotationNumber'),
      expectedVersion: Number(text(form, 'expectedVersion') || '0'),
      ...headerFrom(form),
      lines: linesFrom(form, true),
      rejectLines: rejectLinesFrom(form),
      authorization: authorizationOf(session),
    });
    revalidatePath(ROUTE);
    return { ok: true, quotationNumber: result.quotationNumber, message: `Quotation ${result.quotationNumber} changed (version ${result.version}).` };
  } catch (error) {
    return refusal(error);
  }
}

export async function rejectQuotationAction(_previous: QuotationActionState, form: FormData): Promise<QuotationActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SALES_QUOTATION_CAPABILITY)) return NOT_ALLOWED;
  try {
    const result = await rejectQuotation({
      client: session.user.client,
      changedBy: session.user.username,
      quotationNumber: text(form, 'quotationNumber'),
      expectedVersion: Number(text(form, 'expectedVersion') || '0'),
      reason: text(form, 'rejectReason'),
      authorization: authorizationOf(session),
    });
    revalidatePath(ROUTE);
    return { ok: true, quotationNumber: result.quotationNumber, message: `Quotation ${result.quotationNumber} rejected (${result.rejectionReason}).` };
  } catch (error) {
    return refusal(error);
  }
}

export async function createOrderFromQuotationAction(_previous: QuotationActionState, form: FormData): Promise<QuotationActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SALES_QUOTATION_CAPABILITY)) return NOT_ALLOWED;
  if (!can(session, SALES_ORDER_CAPABILITY)) {
    return {
      ok: false,
      message: 'Raising an order from a quotation creates a sales order, and you do not hold the sales order capability.',
      remedy: 'Ask for SALES.ORDER.CREATE.',
    };
  }
  try {
    const result = await createOrderFromQuotation({
      client: session.user.client,
      changedBy: session.user.username,
      quotationNumber: text(form, 'quotationNumber'),
      expectedVersion: Number(text(form, 'expectedVersion') || '0'),
      orderDate: text(form, 'orderDate'),
      ...(optional(form, 'requestedDate') ? { requestedDate: optional(form, 'requestedDate') } : {}),
      requestKey: text(form, 'requestKey') || `SQO-${session.user.username}-${Date.now()}`,
    }, { authorization: authorizationOf(session) });
    revalidatePath(ROUTE);
    revalidatePath('/sales/orders');
    const earlier = result.alreadyRaised.length
      ? ` This quotation had already produced ${result.alreadyRaised.length === 1 ? 'order' : 'orders'} ${result.alreadyRaised.join(', ')}.`
      : '';
    const credit = result.order.credit.status === 'BLOCKED' ? ` The order is blocked for credit: ${result.order.credit.reason}.` : '';
    return {
      ok: true,
      quotationNumber: result.quotationNumber,
      orderNumber: result.orderNumber,
      message: `Sales order ${result.orderNumber} raised from quotation ${result.quotationNumber}, priced on the order date.${credit}${earlier}`,
      remedy: earlier ? 'Check that the customer did not mean the earlier order before delivering against both.' : undefined,
    };
  } catch (error) {
    return refusal(error);
  }
}

/** Download the quotation as a PDF. */
export async function downloadQuotationPdfAction(form: FormData): Promise<PdfDownloadState> {
  const session = await requireSession(ROUTE);
  try {
    const pdf = await salesQuotationPdf({
      client: session.user.client,
      quotationNumber: String(form.get('quotationNumber') ?? '').trim(),
      capabilities: session.user.capabilities,
    });
    return { ok: true, fileName: pdf.fileName, base64: pdf.base64, warning: pdf.warning };
  } catch (error) {
    if (error instanceof PdfDownloadError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}
