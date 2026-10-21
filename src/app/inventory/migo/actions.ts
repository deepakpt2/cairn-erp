'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  GoodsIssueError, postGoodsIssue, type GoodsIssueView,
} from '@/modules/inventory/goods-issue';
import { MIGO_CAPABILITY, MIGO_ROUTE, resolveMigoCell } from '@/modules/inventory/migo';
import {
  ProductionReceiptError, postProductionReceipt, type ProductionReceiptView,
} from '@/modules/inventory/production-receipt';
import {
  TransferPostingError, postTransfer, type TransferDocumentView,
} from '@/modules/inventory/transfer-posting';
import {
  MaterialReversalError, reverseMaterialDocument, type ReversalDocumentView,
} from '@/modules/inventory/material-document-reversal';

export interface MigoActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  document?: GoodsIssueView | null;
}

export interface TransferActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  document?: TransferDocumentView | null;
}

export interface ReversalActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  document?: ReversalDocumentView | null;
}

export interface ReceiptActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  document?: ProductionReceiptView | null;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

const LINE_COUNT = 4;

export async function postMigoAction(
  _previous: MigoActionState,
  form: FormData,
): Promise<MigoActionState> {
  const session = await requireSession(MIGO_ROUTE);
  if (!can(session, MIGO_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the goods movement capability.' };
  }
  const action = text(form, 'migoAction');
  const reference = text(form, 'migoReference');
  const cell = resolveMigoCell(action, reference);
  if (!cell) {
    return { ok: false, message: 'Choose an action and a reference document type.' };
  }
  if (cell.kind !== 'POST_HERE') {
    // The screen only posts its own cell; the server says so rather than trusting the form.
    return { ok: false, message: `${cell.title} is not posted from this screen.`, remedy: cell.kind === 'ELSEWHERE' ? `Open ${cell.capability}.` : (cell as { reason: string }).reason };
  }

  const lines: Array<{
    materialNumber: string; plant: string; storageLocation?: string; quantity: number;
    entryUnit?: string; productionOrderNumber?: string; productionOrderItem?: number;
  }> = [];
  for (let n = 1; n <= LINE_COUNT; n += 1) {
    const materialNumber = text(form, `material-${n}`);
    if (!materialNumber) continue;
    lines.push({
      materialNumber,
      plant: text(form, `plant-${n}`),
      storageLocation: text(form, `sloc-${n}`) || undefined,
      quantity: Number(text(form, `quantity-${n}`) || '0'),
      entryUnit: text(form, `unit-${n}`) || undefined,
      productionOrderNumber: text(form, `order-${n}`) || text(form, 'orderNumber') || undefined,
      productionOrderItem: Number(text(form, `orderItem-${n}`) || text(form, 'orderItem') || '0') || undefined,
    });
  }

  try {
    const document = await postGoodsIssue({
      client: session.user.client,
      changedBy: session.user.username,
      movementTypeCode: cell.movement,
      postingDate: text(form, 'postingDate'),
      documentDate: text(form, 'documentDate'),
      headerText: text(form, 'headerText') || undefined,
      lines,
      requestKey: text(form, 'requestKey'),
    }, 'MIGO');
    revalidatePath(MIGO_ROUTE);
    return { ok: true, message: `Posted: material document ${document.materialDocumentNumber}.`, document };
  } catch (caught) {
    if (caught instanceof GoodsIssueError) {
      return { ok: false, message: caught.message, remedy: caught.remedy, document: null };
    }
    return { ok: false, message: 'The movement could not be posted.', document: null };
  }
}

/**
 * A01 + R08 — the finished good comes back from the order. The cell is re-resolved here for
 * the same reason the issue re-resolves it: a tampered form cannot post another cell.
 */
export async function postReceiptAction(
  _previous: ReceiptActionState,
  form: FormData,
): Promise<ReceiptActionState> {
  const session = await requireSession(MIGO_ROUTE);
  if (!can(session, MIGO_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the goods movement capability.' };
  }
  const cell = resolveMigoCell(text(form, 'migoAction'), text(form, 'migoReference'));
  if (!cell || cell.kind !== 'POST_HERE' || cell.movement !== '101') {
    return { ok: false, message: 'This form posts the goods receipt from a production order only.' };
  }

  try {
    const document = await postProductionReceipt({
      client: session.user.client,
      changedBy: session.user.username,
      orderNumber: text(form, 'orderNumber'),
      postingDate: text(form, 'postingDate'),
      documentDate: text(form, 'documentDate'),
      headerText: text(form, 'headerText') || undefined,
      lines: [{
        storageLocation: text(form, 'storageLocation'),
        quantity: Number(text(form, 'quantity') || '0'),
        entryUnit: text(form, 'unit') || undefined,
      }],
      requestKey: text(form, 'requestKey'),
    });
    revalidatePath(MIGO_ROUTE);
    return { ok: true, message: `Posted: material document ${document.materialDocumentNumber}.`, document };
  } catch (caught) {
    if (caught instanceof ProductionReceiptError) {
      return { ok: false, message: caught.message, remedy: caught.remedy, document: null };
    }
    return { ok: false, message: 'The receipt could not be posted.', document: null };
  }
}

/**
 * A04 + R10 — the transfer posting, entered where SAP enters it: on the movement screen,
 * against "Other", with the movement chosen on the item. The cell is re-resolved here for the
 * same reason the other two are, and the movement is checked against the cell's own list.
 */
export async function postTransferAction(
  _previous: TransferActionState,
  form: FormData,
): Promise<TransferActionState> {
  const session = await requireSession(MIGO_ROUTE);
  if (!can(session, MIGO_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the goods movement capability.' };
  }
  const cell = resolveMigoCell(text(form, 'migoAction'), text(form, 'migoReference'));
  if (!cell || cell.kind !== 'POST_HERE' || cell.form !== 'TRANSFER') {
    return { ok: false, message: 'This form posts a transfer posting only.' };
  }
  const movement = text(form, 'movementTypeCode');
  if (!cell.movements?.includes(movement)) {
    return { ok: false, message: `Movement ${movement || '(none)'} is not posted from this cell.` };
  }

  try {
    const document = await postTransfer({
      client: session.user.client,
      changedBy: session.user.username,
      movementTypeCode: movement,
      materialNumber: text(form, 'materialNumber'),
      quantity: Number(text(form, 'quantity') || '0'),
      entryUnit: text(form, 'unit') || undefined,
      issuingPlant: text(form, 'issuingPlant'),
      issuingStorageLocation: text(form, 'issuingStorageLocation'),
      receivingPlant: text(form, 'receivingPlant'),
      receivingStorageLocation: text(form, 'receivingStorageLocation'),
      stockType: text(form, 'stockType') || undefined,
      postingDate: text(form, 'postingDate'),
      documentDate: text(form, 'documentDate'),
      headerText: text(form, 'headerText') || undefined,
      requestKey: text(form, 'requestKey'),
    });
    revalidatePath(MIGO_ROUTE);
    return { ok: true, message: `Posted: material document ${document.materialDocumentNumber}.`, document };
  } catch (caught) {
    if (caught instanceof TransferPostingError) {
      return { ok: false, message: caught.message, remedy: caught.remedy, document: null };
    }
    return { ok: false, message: 'The transfer could not be posted.', document: null };
  }
}

/**
 * A03 + R05 — the cancellation, entered where SAP enters it. The reference is the document
 * being cancelled, so the form carries the original number and nothing else is invented.
 */
export async function postReversalAction(
  _previous: ReversalActionState,
  form: FormData,
): Promise<ReversalActionState> {
  const session = await requireSession(MIGO_ROUTE);
  if (!can(session, MIGO_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the goods movement capability.' };
  }
  const cell = resolveMigoCell(text(form, 'migoAction'), text(form, 'migoReference'));
  if (!cell || cell.kind !== 'POST_HERE' || cell.form !== 'REVERSE') {
    return { ok: false, message: 'This form cancels a material document only.' };
  }

  try {
    const document = await reverseMaterialDocument({
      client: session.user.client,
      changedBy: session.user.username,
      materialDocumentNumber: text(form, 'materialDocumentNumber'),
      postingDate: text(form, 'postingDate'),
      documentDate: text(form, 'documentDate'),
      headerText: text(form, 'headerText') || undefined,
      requestKey: text(form, 'requestKey'),
    });
    revalidatePath(MIGO_ROUTE);
    return { ok: true, message: `Reversed: material document ${document.materialDocumentNumber}.`, document };
  } catch (caught) {
    if (caught instanceof MaterialReversalError) {
      return { ok: false, message: caught.message, remedy: caught.remedy, document: null };
    }
    return { ok: false, message: 'The document could not be cancelled.', document: null };
  }
}
