'use server';

/** FIN.CREDIT.RELEASE — authenticate, authorise, act (SCR-105). */
import { revalidatePath } from 'next/cache';
import {
  CREDIT_OVERRIDE_CAPABILITY, CREDIT_RELEASE_CAPABILITY, CreditError,
  reblockDocument, recheckDocument, rejectReleaseRequest, releaseDocument,
  releaseDocumentsBulk, type ReleaseOutcome,
} from '@/modules/finance/credit';
import { can, requireCapability, requireSession, AuthzError } from '@/platform/auth/current';

const PATH = '/finance/credit-release';

export interface ReleaseState { outcomes: ReleaseOutcome[]; message?: string }

async function guard() {
  const session = await requireSession(PATH);
  await requireCapability(CREDIT_RELEASE_CAPABILITY, session);
  return session;
}

function errorOutcome(salesDocument: string, error: unknown): ReleaseOutcome {
  if (error instanceof CreditError || error instanceof AuthzError) {
    return { salesDocument, ok: false, status: null, message: error.message };
  }
  console.error('Credit release action failed', error);
  return { salesDocument, ok: false, status: null, message: 'The action failed; nothing was changed.' };
}

export async function recheckAction(formData: FormData): Promise<void> {
  const session = await guard();
  const salesDocument = String(formData.get('salesDocument') ?? '').trim();
  try {
    await recheckDocument({ client: session.user.client, changedBy: session.user.username, salesDocument });
  } catch (error) {
    if (error instanceof CreditError) throw error;
    throw error;
  }
  revalidatePath(PATH);
}

export async function releaseAction(_previous: ReleaseState, formData: FormData): Promise<ReleaseState> {
  const salesDocument = String(formData.get('salesDocument') ?? '').trim();
  try {
    const session = await guard();
    const justification = String(formData.get('justification') ?? '').trim();
    const outcome = await releaseDocument({
      client: session.user.client, changedBy: session.user.username, salesDocument,
      expectedVersion: formData.get('version') ? Number(formData.get('version')) : undefined,
      override: justification ? { justification, approvalRef: String(formData.get('approvalRef') ?? '').trim() || undefined } : undefined,
      canOverride: can(session, CREDIT_OVERRIDE_CAPABILITY),
    });
    revalidatePath(PATH);
    return { outcomes: [outcome] };
  } catch (error) {
    return { outcomes: [errorOutcome(salesDocument, error)] };
  }
}

export async function bulkReleaseAction(_previous: ReleaseState, formData: FormData): Promise<ReleaseState> {
  try {
    const session = await guard();
    const documents: string[] = [];
    for (const key of formData.keys()) {
      if (key.startsWith('doc_') && formData.get(key) === 'on') documents.push(key.slice(4));
    }
    if (documents.length === 0) return { outcomes: [], message: 'Select at least one document.' };
    const justification = String(formData.get('justification') ?? '').trim();
    const overrides = justification
      ? Object.fromEntries(documents.map((d) => [d, { justification, approvalRef: String(formData.get('approvalRef') ?? '').trim() || undefined }]))
      : undefined;
    const outcomes = await releaseDocumentsBulk({
      client: session.user.client, changedBy: session.user.username, salesDocuments: documents,
      overrides, canOverride: can(session, CREDIT_OVERRIDE_CAPABILITY),
    });
    revalidatePath(PATH);
    return { outcomes };
  } catch (error) {
    return { outcomes: [errorOutcome('(bulk)', error)] };
  }
}

export async function rejectAction(_previous: ReleaseState, formData: FormData): Promise<ReleaseState> {
  const salesDocument = String(formData.get('salesDocument') ?? '').trim();
  try {
    const session = await guard();
    const outcome = await rejectReleaseRequest({
      client: session.user.client, changedBy: session.user.username, salesDocument,
      reason: String(formData.get('reason') ?? ''),
    });
    revalidatePath(PATH);
    return { outcomes: [outcome] };
  } catch (error) {
    return { outcomes: [errorOutcome(salesDocument, error)] };
  }
}

export async function reblockAction(_previous: ReleaseState, formData: FormData): Promise<ReleaseState> {
  const salesDocument = String(formData.get('salesDocument') ?? '').trim();
  try {
    const session = await guard();
    const outcome = await reblockDocument({
      client: session.user.client, changedBy: session.user.username, salesDocument,
      reason: String(formData.get('reason') ?? ''),
    });
    revalidatePath(PATH);
    return { outcomes: [outcome] };
  } catch (error) {
    return { outcomes: [errorOutcome(salesDocument, error)] };
  }
}
