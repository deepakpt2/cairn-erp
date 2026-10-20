'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  MATERIAL_DOC_OUTPUT_CAPABILITY,
  MATERIAL_DOC_OUTPUT_ROUTE,
  MaterialDocumentOutputError,
  determineOutputs,
  dispatchMessage,
  dispatchPending,
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
    });
    const run = await dispatchPending({
      client: session.user.client, changedBy: session.user.username, selection: selectionOf(form),
    });
    revalidatePath(MATERIAL_DOC_OUTPUT_ROUTE);
    return {
      ok: true,
      message: `Determined ${determined.created} output${determined.created === 1 ? '' : 's'} over ${determined.examined} document${determined.examined === 1 ? '' : 's'}`
        + `${determined.transfers > 0 ? ` (${determined.transfers} transfer${determined.transfers === 1 ? '' : 's'} earned none)` : ''}; `
        + `dispatched ${run.dispatched}, failed ${run.failed}.`,
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
    });
    revalidatePath(MATERIAL_DOC_OUTPUT_ROUTE);
    return result.status === 'PROCESSED'
      ? { ok: true, message: `Dispatched ${result.outputType} for ${result.documentNumber}; send count ${result.sendCount}.` }
      : { ok: false, message: `${result.outputType} for ${result.documentNumber} failed.`, remedy: result.errorText ?? undefined };
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
    });
    revalidatePath(MATERIAL_DOC_OUTPUT_ROUTE);
    return { ok: true, message: `Recipient recorded for ${text(form, 'outputType')} on ${text(form, 'documentNumber')}.` };
  } catch (error) {
    if (error instanceof MaterialDocumentOutputError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}
