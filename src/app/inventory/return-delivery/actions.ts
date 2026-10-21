'use server';

/**
 * SCR-145 / INV.RETURN.POST (MBRL) — the two acts on the return screen.
 *
 * Selecting a reference changes nothing: `loadReferenceAction` reads the document and what may
 * still be returned from it, which is what §6.1 asks of preparation. Posting goes through
 * `postReturnDelivery`, which owns every judgement — quantity, stock, period, movement, lineage.
 * This file translates a form into that call and the service's own words back out.
 */
import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  RETURN_CAPABILITY,
  ReturnDeliveryError,
  getReturnableDocument,
  postReturnDelivery,
  type ReturnDocumentView,
  type ReturnableDocument,
} from '@/modules/inventory/return-delivery';

const MBRL_ROUTE = '/inventory/return-delivery';
const LINES = 6;

export interface ReferenceState {
  ok: boolean;
  message: string;
  document: ReturnableDocument | null;
}

export interface PostReturnState {
  ok: boolean;
  message: string;
  remedy?: string;
  posted: ReturnDocumentView | null;
}

const text = (form: FormData, name: string): string => String(form.get(name) ?? '').trim();

export async function loadReferenceAction(
  _previous: ReferenceState,
  form: FormData,
): Promise<ReferenceState> {
  const session = await requireSession(MBRL_ROUTE);
  if (!can(session, RETURN_CAPABILITY)) {
    return { ok: false, message: `You do not hold the return delivery capability (${RETURN_CAPABILITY}).`, document: null };
  }
  const documentNumber = text(form, 'documentNumber');
  const documentYear = text(form, 'documentYear');

  try {
    const document = await getReturnableDocument(session.user.client, {
      documentNumber,
      documentYear: documentYear ? Number(documentYear) : null,
    });
    if (!document) {
      return { ok: false, message: `Material document ${documentNumber || '(empty)'} does not exist.`, document: null };
    }
    const open = document.items.filter((i) => i.eligible).length;
    return {
      ok: true,
      message: open === 0
        ? `Material document ${document.documentNumber} carries no item that may still be returned.`
        : `Material document ${document.documentNumber} carries ${open} returnable item${open === 1 ? '' : 's'}.`,
      document,
    };
  } catch (caught) {
    if (caught instanceof ReturnDeliveryError) {
      return { ok: false, message: caught.message, document: null };
    }
    return { ok: false, message: 'The reference document could not be read.', document: null };
  }
}

export async function postReturnAction(
  _previous: PostReturnState,
  form: FormData,
): Promise<PostReturnState> {
  const session = await requireSession(MBRL_ROUTE);
  if (!can(session, RETURN_CAPABILITY)) {
    return { ok: false, message: `You do not hold the return delivery capability (${RETURN_CAPABILITY}).`, posted: null };
  }

  const lines: Array<{ originalLine: number; quantity: number; entryUnit?: string; storageLocation?: string }> = [];
  for (let n = 1; n <= LINES; n += 1) {
    const originalLine = Number(text(form, `originalLine-${n}`) || '0');
    const quantity = Number(text(form, `quantity-${n}`) || '0');
    if (!originalLine || !(quantity > 0)) continue;
    lines.push({
      originalLine,
      quantity,
      entryUnit: text(form, `unit-${n}`) || undefined,
      storageLocation: text(form, `sloc-${n}`) || undefined,
    });
  }
  if (lines.length === 0) {
    return { ok: false, message: 'No return quantities were entered.', remedy: 'Enter a quantity against at least one receipt item.', posted: null };
  }

  try {
    const posted = await postReturnDelivery({
      client: session.user.client,
      changedBy: session.user.username,
      documentNumber: text(form, 'documentNumber'),
      documentYear: text(form, 'documentYear') ? Number(text(form, 'documentYear')) : null,
      postingDate: text(form, 'postingDate'),
      documentDate: text(form, 'documentDate'),
      headerText: text(form, 'headerText') || undefined,
      externalReference: text(form, 'externalReference') || undefined,
      lines,
      requestKey: text(form, 'requestKey'),
    });
    revalidatePath(MBRL_ROUTE);
    return {
      ok: true,
      message: `Posted: material document ${posted.materialDocumentNumber}, returning against ${posted.returnsAgainst?.documentNumber ?? '(unknown)'}.`,
      posted,
    };
  } catch (caught) {
    if (caught instanceof ReturnDeliveryError) {
      return { ok: false, message: caught.message, remedy: caught.remedy, posted: null };
    }
    return { ok: false, message: 'The return could not be posted.', posted: null };
  }
}
