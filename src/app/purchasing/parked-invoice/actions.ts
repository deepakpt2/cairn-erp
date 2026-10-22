'use server';

/**
 * SCR-160 — the parked invoice screen's door.
 *
 * Open writes nothing. Check calls the preview and writes nothing, including
 * the number. Save calls the park. A category, a currency, a company code, a
 * supplier, a tax amount, freight, a discount, a status, an approval and a
 * deletion are passed through, so the service refuses them by name. This
 * screen does not post.
 */
import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  PARKED_INVOICE_CAPABILITY,
  PARKED_INVOICE_ROUTE,
  ParkedInvoiceError,
  changeParkedInvoice,
  parkSupplierInvoice,
  previewParkedInvoice,
  previewParkedInvoiceChange,
  type ParkedInvoiceInput,
  type ParkedInvoiceLineInput,
  type ParkedInvoicePreview,
} from '@/modules/purchasing/parked-invoice';

export interface ParkedInvoiceActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  wrote?: boolean;
  parkedNumber?: string | null;
  preview?: ParkedInvoicePreview | null;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function named(form: FormData, pattern: RegExp): boolean {
  return [...form.keys()].some((name) => pattern.test(name));
}

function missing(): ParkedInvoiceActionState {
  return {
    ok: false,
    message: `You do not hold the parked invoice capability (${PARKED_INVOICE_CAPABILITY}). Invoice verification does not park.`,
  };
}

function refused(caught: unknown): ParkedInvoiceActionState | null {
  if (caught instanceof ParkedInvoiceError || caught instanceof EnqueueError) return { ok: false, message: caught.message, remedy: caught.remedy };
  return null;
}

function blocked(form: FormData): ParkedInvoiceActionState | null {
  if (named(form, /^(post|delete|approve)$/)) {
    return { ok: false, message: 'This screen does not post a journal, and it does not delete a parked invoice.' };
  }
  return null;
}

function extras(form: FormData): Partial<ParkedInvoiceInput> {
  const extra: Partial<ParkedInvoiceInput> = {};
  if (text(form, 'category')) extra.category = text(form, 'category');
  if (text(form, 'currency')) extra.currency = text(form, 'currency');
  if (text(form, 'companyCode')) extra.companyCode = text(form, 'companyCode');
  if (text(form, 'supplierNumber')) extra.supplierNumber = text(form, 'supplierNumber');
  if (text(form, 'paymentTerms')) extra.paymentTerms = text(form, 'paymentTerms');
  if (text(form, 'exchangeRate')) extra.exchangeRate = text(form, 'exchangeRate');
  if (text(form, 'freight')) extra.freight = text(form, 'freight');
  if (text(form, 'discount')) extra.discount = text(form, 'discount');
  if (text(form, 'status')) extra.status = text(form, 'status');
  if (text(form, 'approval')) extra.approval = text(form, 'approval');
  if (text(form, 'hold')) extra.hold = text(form, 'hold');
  if (text(form, 'workflow')) extra.workflow = text(form, 'workflow');
  if (text(form, 'draft')) extra.draft = text(form, 'draft');
  if (text(form, 'posting')) extra.posting = text(form, 'posting');
  if (text(form, 'award')) extra.award = text(form, 'award');
  if (text(form, 'deletion')) extra.deletion = text(form, 'deletion');
  if (text(form, 'taxAmount')) extra.taxAmount = Number(text(form, 'taxAmount'));
  return extra;
}

function lines(form: FormData): ParkedInvoiceLineInput[] {
  const parsed: ParkedInvoiceLineInput[] = [];
  for (const [key, value] of form.entries()) {
    if (!key.startsWith('qty-') || typeof value !== 'string') continue;
    const quantity = Number(value);
    if (!(quantity > 0)) continue;
    const itemNumber = Number(key.slice(4));
    const taxAmount = text(form, `taxAmount-${itemNumber}`);
    parsed.push({
      itemNumber,
      quantity,
      netAmount: Number(form.get(`amt-${itemNumber}`)),
      taxCode: text(form, `tax-${itemNumber}`) || undefined,
      taxAmount: taxAmount ? Number(taxAmount) : undefined,
      unit: text(form, `unit-${itemNumber}`) || undefined,
    });
  }
  return parsed;
}

function input(sessionClient: string, username: string, form: FormData): ParkedInvoiceInput {
  return {
    client: sessionClient,
    changedBy: username,
    orderNumber: text(form, 'orderNumber'),
    supplierReference: text(form, 'supplierReference'),
    invoiceDate: text(form, 'invoiceDate'),
    postingDate: text(form, 'postingDate'),
    grossAmount: Number(form.get('grossAmount')),
    headerText: text(form, 'headerText') || undefined,
    reason: text(form, 'reason') || undefined,
    lines: lines(form),
    ...extras(form),
  };
}

export async function checkParkedInvoiceAction(
  _previous: ParkedInvoiceActionState,
  form: FormData,
): Promise<ParkedInvoiceActionState> {
  const session = await requireSession(PARKED_INVOICE_ROUTE);
  if (!can(session, PARKED_INVOICE_CAPABILITY)) return missing();
  const blockedState = blocked(form);
  if (blockedState) return blockedState;
  const parkedNumber = text(form, 'parkedNumber');
  try {
    const preview = parkedNumber
      ? await previewParkedInvoiceChange({ ...input(session.user.client, session.user.username, form), parkedNumber })
      : await previewParkedInvoice(input(session.user.client, session.user.username, form));
    return {
      ok: true,
      wrote: false,
      message: parkedNumber
        ? `Parked invoice ${parkedNumber} can be changed. Nothing was written.`
        : 'The invoice can be parked. Nothing was written.',
      parkedNumber: preview.parkedNumber,
      preview,
    };
  } catch (caught) {
    return refused(caught) ?? { ok: false, message: 'The check could not be read.' };
  }
}

export async function saveParkedInvoiceAction(
  _previous: ParkedInvoiceActionState,
  form: FormData,
): Promise<ParkedInvoiceActionState> {
  const session = await requireSession(PARKED_INVOICE_ROUTE);
  if (!can(session, PARKED_INVOICE_CAPABILITY)) return missing();
  const blockedState = blocked(form);
  if (blockedState) return blockedState;
  const parkedNumber = text(form, 'parkedNumber');
  try {
    if (parkedNumber) {
      await assertChangeForSession(session, { lockObject: 'PARKED_INVOICE', argument: parkedNumber });
    }
    const saved = parkedNumber
      ? await changeParkedInvoice({
        ...input(session.user.client, session.user.username, form),
        parkedNumber,
        expectedChangedAt: text(form, 'expectedChangedAt'),
      })
      : await parkSupplierInvoice({
        ...input(session.user.client, session.user.username, form),
        requestKey: text(form, 'requestKey'),
      });
    revalidatePath(PARKED_INVOICE_ROUTE);
    return {
      ok: true,
      wrote: true,
      message: parkedNumber
        ? `Parked invoice ${saved.parkedNumber} was changed. It was not posted.`
        : `Parked invoice ${saved.parkedNumber} stands. It was not posted.`,
      parkedNumber: saved.parkedNumber,
      preview: saved,
    };
  } catch (caught) {
    return refused(caught) ?? { ok: false, message: 'The parked invoice could not be saved.' };
  }
}
