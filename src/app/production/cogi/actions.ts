'use server';

import { requireSession } from '@/platform/auth/current';
import {
  correctProductionCogiFailure,
  discardProductionCogiFailure,
  ProductionCogiError,
  PRODUCTION_COGI_ROUTE,
  retryProductionCogiFailure,
} from '@/modules/production/production-cogi';

export interface ProductionCogiActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  failureId?: string;
  revisionNumber?: number;
  outcome?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function auth(session: Awaited<ReturnType<typeof requireSession>>) {
  return { userId: session.user.userId, sessionId: session.sessionId ?? '' };
}

function errorState(error: unknown, fallback: string): ProductionCogiActionState {
  if (error instanceof ProductionCogiError) return { ok: false, message: error.message, remedy: error.remedy };
  return { ok: false, message: error instanceof Error ? error.message : fallback };
}

export async function correctProductionCogiAction(
  _previous: ProductionCogiActionState,
  form: FormData,
): Promise<ProductionCogiActionState> {
  const session = await requireSession(PRODUCTION_COGI_ROUTE);
  try {
    const lineCount = Number.parseInt(text(form, 'lineCount'), 10);
    if (!Number.isInteger(lineCount) || lineCount < 1 || lineCount > 100) {
      return { ok: false, message: 'Refresh the movement details and try again.' };
    }
    const changes = Array.from({ length: lineCount }, (_, index) => {
      const lineNumber = index + 1;
      const quantity = form.get(`quantity_${lineNumber}`);
      const storageLocation = form.get(`storageLocation_${lineNumber}`);
      const batch = form.get(`batch_${lineNumber}`);
      return {
        lineNumber,
        ...(typeof quantity === 'string' ? { quantity: quantity.trim() } : {}),
        ...(typeof storageLocation === 'string' ? { storageLocation: storageLocation.trim() || null } : {}),
        ...(typeof batch === 'string' ? { batch: batch.trim() || null } : {}),
      };
    });
    const result = await correctProductionCogiFailure({
      client: session.user.client,
      failureId: text(form, 'failureId'),
      expectedRevision: Number.parseInt(text(form, 'expectedRevision'), 10),
      reason: text(form, 'reason'),
      changes,
      authorization: auth(session),
    });
    return {
      ok: true,
      failureId: result.failureId,
      revisionNumber: result.revisionNumber,
      message: `Correction revision ${result.revisionNumber} is saved. The original CO11N payload remains unchanged; reprocess this movement to post the corrected details.`,
    };
  } catch (error) {
    return errorState(error, 'The movement correction was not saved.');
  }
}

export async function retryProductionCogiAction(
  _previous: ProductionCogiActionState,
  form: FormData,
): Promise<ProductionCogiActionState> {
  const session = await requireSession(PRODUCTION_COGI_ROUTE);
  if (text(form, 'confirmReprocess') !== 'on') {
    return { ok: false, message: 'Confirm that this action will post a material document before reprocessing.' };
  }
  try {
    const result = await retryProductionCogiFailure({
      client: session.user.client,
      failureId: text(form, 'failureId'),
      authorization: auth(session),
    });
    switch (result.outcome) {
      case 'POSTED':
        return { ok: true, failureId: result.failureId, outcome: result.outcome, message: `Material document ${result.materialDocumentNumber}/${result.documentYear} was posted.` };
      case 'FAILED':
      case 'BLOCKED':
        return { ok: false, failureId: result.failureId, outcome: result.outcome, message: result.errorText };
      case 'ALREADY_POSTED':
        return { ok: true, failureId: result.failureId, outcome: result.outcome, message: 'This movement is already posted. No second material document was created.' };
      case 'BUSY':
        return { ok: false, failureId: result.failureId, outcome: result.outcome, message: 'Another posting attempt owns this movement. Refresh the record after it finishes.' };
      case 'LEASE_LOST':
        return { ok: false, failureId: result.failureId, outcome: result.outcome, message: 'The posting lease changed before completion. Refresh the record before taking another action.' };
      case 'NOT_ELIGIBLE':
        return { ok: false, failureId: result.failureId, outcome: result.outcome, message: 'This movement cannot be reprocessed in its current status.' };
    }
  } catch (error) {
    return errorState(error, 'The movement was not reprocessed.');
  }
}

export async function discardProductionCogiAction(
  _previous: ProductionCogiActionState,
  form: FormData,
): Promise<ProductionCogiActionState> {
  const session = await requireSession(PRODUCTION_COGI_ROUTE);
  if (text(form, 'confirmDiscard') !== 'on') {
    return { ok: false, message: 'Confirm that this failed movement must not be posted.' };
  }
  try {
    const result = await discardProductionCogiFailure({
      client: session.user.client,
      failureId: text(form, 'failureId'),
      reason: text(form, 'reason'),
      authorization: auth(session),
    });
    return {
      ok: true,
      failureId: result.failureId,
      outcome: result.alreadyDiscarded ? 'ALREADY_DISCARDED' : 'DISCARDED',
      message: result.alreadyDiscarded
        ? 'This movement was already discarded with the same reason. No record was removed.'
        : 'The movement is retained as DISCARDED. No goods movement was posted and reservations were not adjusted.',
    };
  } catch (error) {
    return errorState(error, 'The movement was not discarded.');
  }
}
