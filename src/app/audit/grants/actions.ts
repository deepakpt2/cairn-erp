'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  AUDIT_GRANT_CAPABILITY,
  AUDIT_GRANT_ROUTE,
  AUDIT_WORKSPACE_ROUTE,
  AuditError,
  createAuditGrant,
  revokeAuditGrant,
} from '@/modules/audit/workspace';

const ROUTE = AUDIT_GRANT_ROUTE;

export interface AuditGrantActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  /** A fresh idempotency key for the next submission of the form. */
  requestKey?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function refusal(error: unknown): AuditGrantActionState {
  if (error instanceof AuditError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

async function controller() {
  const session = await requireSession(ROUTE);
  if (!can(session, AUDIT_GRANT_CAPABILITY)) {
    return { session, refused: { ok: false, message: `You do not hold ${AUDIT_GRANT_CAPABILITY}.`, remedy: `Ask for ${AUDIT_GRANT_CAPABILITY}. The auditor never holds it.` } as AuditGrantActionState };
  }
  if (!session.sessionId) {
    return { session, refused: { ok: false, message: 'Your session could not be verified.', remedy: 'Sign in again.' } as AuditGrantActionState };
  }
  return { session, refused: null };
}

/** Grant time-boxed, scoped, read-only access. `scopeKind[]` and `scopeValue[]` pair positionally. */
export async function createAuditGrantAction(_prev: AuditGrantActionState, form: FormData): Promise<AuditGrantActionState> {
  const { session, refused } = await controller();
  if (refused) return refused;
  const kinds = form.getAll('scopeKind[]').map((v) => (typeof v === 'string' ? v : ''));
  const values = form.getAll('scopeValue[]').map((v) => (typeof v === 'string' ? v : ''));
  const scope = kinds.map((kind, i) => ({ kind, value: values[i] ?? '' })).filter((row) => row.value.trim() !== '');
  try {
    const grant = await createAuditGrant({
      client: session.user.client,
      authorization: { userId: session.user.userId, sessionId: session.sessionId! },
      auditorUserId: text(form, 'auditorUserId'),
      validFrom: text(form, 'validFrom'),
      validTo: text(form, 'validTo') || null,
      scope,
      reason: text(form, 'reason'),
      requestKey: text(form, 'requestKey') || undefined,
    });
    revalidatePath(ROUTE);
    revalidatePath(AUDIT_WORKSPACE_ROUTE);
    return {
      ok: true,
      message: `Audit grant ${grant.grantId} given to ${grant.auditorUsername ?? grant.auditorUserId}, ${grant.validFrom} to ${grant.validTo} (${grant.status}).`,
      requestKey: randomUUID(),
    };
  } catch (error) {
    return refusal(error);
  }
}

/** Revoke a grant. The auditor's next read is refused. */
export async function revokeAuditGrantAction(_prev: AuditGrantActionState, form: FormData): Promise<AuditGrantActionState> {
  const { session, refused } = await controller();
  if (refused) return refused;
  try {
    const grant = await revokeAuditGrant({
      client: session.user.client,
      authorization: { userId: session.user.userId, sessionId: session.sessionId! },
      grantId: text(form, 'grantId'),
      reason: text(form, 'reason'),
    });
    revalidatePath(ROUTE);
    revalidatePath(AUDIT_WORKSPACE_ROUTE);
    return { ok: true, message: `Audit grant ${grant.grantId} revoked.` };
  } catch (error) {
    return refusal(error);
  }
}
