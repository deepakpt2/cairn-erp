'use server';

/**
 * SCR-149 — the posting screen's door.
 *
 * The action carries the form to the service and brings back the service's own refusal. It judges
 * two things of its own: whether the person may post, and whether the form tries to supply an
 * amount, an account, a stock balance, a status, or a fraction of one item. Those are not fields
 * this screen has, and a crafted request must not have them quietly dropped. A threshold is
 * passed through, so the service can refuse it by name. Reversal is a separate action and a
 * separate capability.
 */
import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { NumberRangeError } from '@/platform/numbering';
import { PeriodError } from '@/platform/periods';
import { PostingError } from '@/platform/posting';
import { REVERSE_CAPABILITY } from '@/modules/inventory/material-document-reversal';
import { MaterialReversalError } from '@/modules/inventory/material-document-reversal';
import {
  PHYSICAL_INVENTORY_DIFF_POST_CAPABILITY,
  PHYSICAL_INVENTORY_DIFF_POST_ROUTE,
  PhysicalInventoryPostingError,
  postDifferences,
  reverseDifferencePosting,
  validateDifferencePosting,
  type DifferencePostingPreview,
  type PostedDifferences,
} from '@/modules/inventory/physical-inventory-posting';

export interface PostingActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  preview?: DifferencePostingPreview | null;
  posted?: PostedDifferences | null;
  reversalDocument?: string | null;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** Header text and the external reference are judged at the length the person sent, not shortened. */
function raw(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function named(form: FormData, pattern: RegExp): boolean {
  return [...form.keys()].some((name) => pattern.test(name));
}

/**
 * Fields the client is not allowed to decide. A present field is a refusal, never a value that
 * is read and ignored.
 */
function clientSupplied(form: FormData): string | null {
  const messages: string[] = [];
  if (named(form, /^(quantity|partialQuantity|itemQuantity|fraction)/)) {
    messages.push('A fraction of one item\'s difference is not posted. The whole remaining difference posts, or the batch does not.');
  }
  if (named(form, /^(amount|postingValue)$/)) {
    messages.push('The amount is not taken from the request. The plant valuation is what posts.');
  }
  if (named(form, /^(glAccount|account|offsetAccount|inventoryAccount)$/)) {
    messages.push('The account is not taken from the request.');
  }
  if (named(form, /^(stock|stockBalance|quantityOnHand)$/)) {
    messages.push('The stock balance is not taken from the request.');
  }
  if (named(form, /^(postingStatus)$/)) {
    messages.push('The posting status is not taken from the request.');
  }
  return messages.length > 0 ? messages.join(' ') : null;
}

function selectionOf(form: FormData) {
  const itemNumbers = form.getAll('item')
    .map((value) => Number(String(value)))
    .filter((value) => Number.isInteger(value) && value > 0);
  return {
    documentNumber: text(form, 'documentNumber').toUpperCase(),
    fiscalYear: Number(text(form, 'fiscalYear') || '0'),
    itemNumbers,
    postingDate: text(form, 'postingDate'),
    documentDate: text(form, 'documentDate'),
    headerText: raw(form, 'headerText') || undefined,
    externalReference: raw(form, 'externalReference') || undefined,
    ...(form.has('maximumDifferenceValue')
      ? { maximumDifferenceValue: form.get('maximumDifferenceValue') }
      : {}),
  };
}

function refused(caught: unknown): PostingActionState | null {
  if (
    caught instanceof PhysicalInventoryPostingError
    || caught instanceof PostingError
    || caught instanceof PeriodError
    || caught instanceof NumberRangeError
    || caught instanceof MaterialReversalError
  ) {
    const remedy = 'remedy' in caught && typeof caught.remedy === 'string' ? caught.remedy : undefined;
    return { ok: false, message: caught.message, remedy };
  }
  return null;
}

export async function checkPostingAction(
  _previous: PostingActionState,
  form: FormData,
): Promise<PostingActionState> {
  const session = await requireSession(PHYSICAL_INVENTORY_DIFF_POST_ROUTE);
  if (!can(session, PHYSICAL_INVENTORY_DIFF_POST_CAPABILITY)) {
    return { ok: false, message: `You do not hold the difference posting capability (${PHYSICAL_INVENTORY_DIFF_POST_CAPABILITY}).` };
  }
  const supplied = clientSupplied(form);
  if (supplied) return { ok: false, message: supplied };
  try {
    const preview = await validateDifferencePosting({
      client: session.user.client,
      changedBy: session.user.username,
      ...selectionOf(form),
    });
    return {
      ok: true,
      message: preview.journalRequired
        ? 'The selection would post, and a journal would be written.'
        : 'The selection would post quantity only. No journal would be written.',
      preview,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}

export async function postDifferencesAction(
  _previous: PostingActionState,
  form: FormData,
): Promise<PostingActionState> {
  const session = await requireSession(PHYSICAL_INVENTORY_DIFF_POST_ROUTE);
  if (!can(session, PHYSICAL_INVENTORY_DIFF_POST_CAPABILITY)) {
    return { ok: false, message: `You do not hold the difference posting capability (${PHYSICAL_INVENTORY_DIFF_POST_CAPABILITY}).` };
  }
  const supplied = clientSupplied(form);
  if (supplied) return { ok: false, message: supplied };
  try {
    const posted = await postDifferences({
      client: session.user.client,
      changedBy: session.user.username,
      requestKey: text(form, 'requestKey'),
      ...selectionOf(form),
    });
    revalidatePath(PHYSICAL_INVENTORY_DIFF_POST_ROUTE);
    const journal = posted.journalDocumentNumber
      ? ` Journal ${posted.journalDocumentNumber}.`
      : ' No journal was written.';
    return {
      ok: true,
      message: `Posted material document ${posted.materialDocumentNumber}.${journal} The count stands at ${posted.headerStatus}.`,
      posted,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}

/** Reversal is not the posting capability. A person who can post cannot reverse from that fact alone. */
export async function reversePostingAction(
  _previous: PostingActionState,
  form: FormData,
): Promise<PostingActionState> {
  const session = await requireSession(PHYSICAL_INVENTORY_DIFF_POST_ROUTE);
  if (!can(session, REVERSE_CAPABILITY)) {
    return {
      ok: false,
      message: `You do not hold the reversal capability (${REVERSE_CAPABILITY}). A posting permission does not reverse.`,
    };
  }
  try {
    const reversed = await reverseDifferencePosting({
      client: session.user.client,
      changedBy: session.user.username,
      materialDocumentNumber: text(form, 'materialDocumentNumber'),
      postingDate: text(form, 'postingDate'),
      documentDate: text(form, 'documentDate'),
      headerText: raw(form, 'headerText') || undefined,
      requestKey: text(form, 'requestKey'),
      ...(text(form, 'reason') ? { reason: text(form, 'reason') } : {}),
    });
    revalidatePath(PHYSICAL_INVENTORY_DIFF_POST_ROUTE);
    return {
      ok: true,
      message: `Reversal posted as material document ${reversed.materialDocumentNumber}. The difference is not selected again.`,
      reversalDocument: reversed.materialDocumentNumber,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}

