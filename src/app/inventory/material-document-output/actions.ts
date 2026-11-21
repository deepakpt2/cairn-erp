'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { PdfDownloadError } from '@/modules/output/download-pdf';
import type { PdfDownloadState } from '@/ui/output/DocumentPrint';
import {
  MATERIAL_DOC_OUTPUT_CAPABILITY,
  MATERIAL_DOC_OUTPUT_ROUTE,
  MaterialDocumentOutputError,
  determineOutputs,
  dispatchMessage,
  dispatchPending,
  materialOutputPdf,
  setRecipient,
  type OutputSelection,
} from '@/modules/inventory/material-document-output';

export interface OutputActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function selectionOf(form: FormData): OutputSelection {
  return {
    outputType: text(form, 'outputType') || undefined,
    transmissionMedium: text(form, 'transmissionMedium') || undefined,
    dispatchTime: text(form, 'dispatchTime') || undefined,
    status: text(form, 'status') || undefined,
    documentFrom: text(form, 'documentFrom') || undefined,
    documentTo: text(form, 'documentTo') || undefined,
    documentYear: text(form, 'documentYear') || undefined,
    plantFrom: text(form, 'plantFrom') || undefined,
    plantTo: text(form, 'plantTo') || undefined,
    postingDateFrom: text(form, 'postingDateFrom') || undefined,
    postingDateTo: text(form, 'postingDateTo') || undefined,
  };
}

export async function runOutputsAction(
  _previous: OutputActionState,
  form: FormData,
): Promise<OutputActionState> {
  const session = await requireSession(MATERIAL_DOC_OUTPUT_ROUTE);
  if (!can(session, MATERIAL_DOC_OUTPUT_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the material document output capability.' };
  }
  try {
    const determined = await determineOutputs({
      client: session.user.client, changedBy: session.user.username, selection: selectionOf(form),
      authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' },
    });
    const run = await dispatchPending({
      client: session.user.client, changedBy: session.user.username, selection: selectionOf(form),
      authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' },
    });
    revalidatePath(MATERIAL_DOC_OUTPUT_ROUTE);
    return {
      ok: true,
      message: `Determined ${determined.created} output${determined.created === 1 ? '' : 's'} over ${determined.examined} document${determined.examined === 1 ? '' : 's'}`
        + `${determined.transfers > 0 ? ` (${determined.transfers} transfer${determined.transfers === 1 ? '' : 's'} earned none)` : ''}; `
        + `${run.queued} queued for the OUTPUT.DISPATCH job, which renders and sends them within a couple of minutes.`,
    };
  } catch (error) {
    if (error instanceof MaterialDocumentOutputError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

export async function dispatchOneAction(
  _previous: OutputActionState,
  form: FormData,
): Promise<OutputActionState> {
  const session = await requireSession(MATERIAL_DOC_OUTPUT_ROUTE);
  if (!can(session, MATERIAL_DOC_OUTPUT_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the material document output capability.' };
  }
  try {
    const result = await dispatchMessage({
      client: session.user.client, changedBy: session.user.username,
      documentNumber: text(form, 'documentNumber'),
      outputType: text(form, 'outputType'),
      transmissionMedium: text(form, 'transmissionMedium'),
      authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' },
    });
    revalidatePath(MATERIAL_DOC_OUTPUT_ROUTE);
    return {
      ok: true,
      message: `${result.outputType} for ${result.documentNumber} is queued. The OUTPUT.DISPATCH job renders and sends it within a couple of minutes; refresh to see it processed.`,
    };
  } catch (error) {
    if (error instanceof MaterialDocumentOutputError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

export async function recipientAction(
  _previous: OutputActionState,
  form: FormData,
): Promise<OutputActionState> {
  const session = await requireSession(MATERIAL_DOC_OUTPUT_ROUTE);
  if (!can(session, MATERIAL_DOC_OUTPUT_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the material document output capability.' };
  }
  try {
    await setRecipient({
      client: session.user.client, changedBy: session.user.username,
      documentNumber: text(form, 'documentNumber'),
      outputType: text(form, 'outputType'),
      transmissionMedium: text(form, 'transmissionMedium'),
      recipient: text(form, 'recipient'),
      printerQueue: text(form, 'printerQueue'),
      authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' },
    });
    revalidatePath(MATERIAL_DOC_OUTPUT_ROUTE);
    return { ok: true, message: `Recipient recorded for ${text(form, 'outputType')} on ${text(form, 'documentNumber')}.` };
  } catch (error) {
    if (error instanceof MaterialDocumentOutputError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

/** Download PDF: built from the message's stored rendering only; refuses a message with none. */
export async function downloadSlipPdfAction(form: FormData): Promise<PdfDownloadState> {
  const session = await requireSession(MATERIAL_DOC_OUTPUT_ROUTE);
  if (!can(session, MATERIAL_DOC_OUTPUT_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the material document output capability.' };
  }
  try {
    const pdf = await materialOutputPdf({
      client: session.user.client,
      documentNumber: text(form, 'documentNumber'),
      outputType: text(form, 'outputType'),
      transmissionMedium: text(form, 'transmissionMedium'),
      authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' },
    });
    return { ok: true, fileName: pdf.fileName, base64: pdf.base64, warning: pdf.warning };
  } catch (error) {
    if (error instanceof MaterialDocumentOutputError) return { ok: false, message: error.message, remedy: error.remedy };
    if (error instanceof PdfDownloadError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}
