'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  TRANSFER_POST_CAPABILITY,
  TransferPostingError,
  postTransfer,
  reverseTransfer,
  validateTransfer,
  type TransferValidation,
} from '@/modules/inventory/transfer-posting';

export interface TransferActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  documentNumber?: string;
  /** SCR-146: what a check found — present only for a check, never for a posting. */
  preview?: TransferValidation;
}

const ROUTE = '/inventory/transfer-posting';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function postTransferAction(
  _previous: TransferActionState,
  form: FormData,
): Promise<TransferActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, TRANSFER_POST_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the transfer posting capability.' };
  }
  try {
    const doc = await postTransfer({
      client: session.user.client,
      changedBy: session.user.username,
      movementTypeCode: text(form, 'movementTypeCode'),
      materialNumber: text(form, 'materialNumber'),
      quantity: Number(text(form, 'quantity')),
      issuingPlant: text(form, 'issuingPlant'),
      issuingStorageLocation: text(form, 'issuingStorageLocation'),
      receivingPlant: text(form, 'receivingPlant'),
      receivingStorageLocation: text(form, 'receivingStorageLocation'),
      stockType: text(form, 'stockType') || undefined,
      documentDate: text(form, 'documentDate'),
      postingDate: text(form, 'postingDate'),
      headerText: text(form, 'headerText') || undefined,
      externalReference: text(form, 'externalReference') || undefined,
      requestKey: text(form, 'requestKey'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Transfer posted as material document ${doc.materialDocumentNumber}.`,
      documentNumber: doc.materialDocumentNumber,
    };
  } catch (error) {
    if (error instanceof TransferPostingError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

/** The item fields, in one place, so a check and a posting never read different things. */
function itemOf(form: FormData) {
  return {
    movementTypeCode: text(form, 'movementTypeCode'),
    materialNumber: text(form, 'materialNumber'),
    quantity: Number(text(form, 'quantity')),
    issuingPlant: text(form, 'issuingPlant'),
    issuingStorageLocation: text(form, 'issuingStorageLocation'),
    receivingPlant: text(form, 'receivingPlant'),
    receivingStorageLocation: text(form, 'receivingStorageLocation'),
    stockType: text(form, 'stockType') || undefined,
    documentDate: text(form, 'documentDate'),
    postingDate: text(form, 'postingDate'),
    headerText: text(form, 'headerText') || undefined,
    externalReference: text(form, 'externalReference') || undefined,
  };
}

/**
 * SCR-146 §16 — the check of the posting, which posts nothing.
 *
 * It answers with the same words a posting would use, because it asks the same question: the
 * screen calls `validateTransfer`, which runs the posting's own preflight and stops before the
 * writer. A check that says yes and a posting that says no is a defect, so there is one function.
 */
export async function checkTransferAction(
  _previous: TransferActionState,
  form: FormData,
): Promise<TransferActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, TRANSFER_POST_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the transfer posting capability.' };
  }
  try {
    const preview = await validateTransfer({
      client: session.user.client,
      changedBy: session.user.username,
      ...itemOf(form),
    });
    return { ok: true, message: 'The transfer would post.', preview };
  } catch (error) {
    if (error instanceof TransferPostingError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

export async function reverseTransferAction(
  _previous: TransferActionState,
  form: FormData,
): Promise<TransferActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, TRANSFER_POST_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the transfer posting capability.' };
  }
  try {
    const doc = await reverseTransfer({
      client: session.user.client,
      changedBy: session.user.username,
      materialDocumentNumber: text(form, 'materialDocumentNumber'),
      documentDate: text(form, 'documentDate'),
      postingDate: text(form, 'postingDate'),
      requestKey: text(form, 'requestKey'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Reversal posted as material document ${doc.materialDocumentNumber}.`,
      documentNumber: doc.materialDocumentNumber,
    };
  } catch (error) {
    if (error instanceof TransferPostingError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}
