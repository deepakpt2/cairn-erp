'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  AUDIT_EXPORT_CAPABILITY,
  AUDIT_FINDING_ROUTE,
  AUDIT_RESPOND_CAPABILITY,
  AUDIT_WORKSPACE_CAPABILITY,
  AUDIT_WORKSPACE_ROUTE,
  AuditError,
  exportEvidence,
  raiseFinding,
  recordAuditView,
  respondToFinding,
} from '@/modules/audit/workspace';

const ROUTE = AUDIT_FINDING_ROUTE;

export interface FindingActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

export interface ExportState extends FindingActionState {
  filename?: string;
  csv?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function refusal(error: unknown): FindingActionState {
  if (error instanceof AuditError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

function actorOf(session: Awaited<ReturnType<typeof requireSession>>) {
  return { client: session.user.client, userId: session.user.userId, username: session.user.username };
}

/** Log one view of the findings screen, from a client island. */
export async function logFindingsViewAction(detail: string): Promise<void> {
  const session = await requireSession(ROUTE);
  if (!can(session, AUDIT_WORKSPACE_CAPABILITY)) return;
  await recordAuditView(actorOf(session), ROUTE, detail.slice(0, 500));
}

/** Raise a finding, note, bookmark or request to management. */
export async function raiseFindingAction(_prev: FindingActionState, form: FormData): Promise<FindingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, AUDIT_WORKSPACE_CAPABILITY)) {
    return { ok: false, message: `You do not hold ${AUDIT_WORKSPACE_CAPABILITY}.`, remedy: `Ask for ${AUDIT_WORKSPACE_CAPABILITY}.` };
  }
  try {
    const finding = await raiseFinding({
      actor: actorOf(session),
      grantId: text(form, 'grantId') || null,
      kind: text(form, 'kind'),
      subject: text(form, 'subject'),
      body: text(form, 'body'),
      objectClass: text(form, 'objectClass') || null,
      objectKey: text(form, 'objectKey') || null,
    });
    revalidatePath(ROUTE);
    revalidatePath(AUDIT_WORKSPACE_ROUTE);
    return { ok: true, message: `${finding.kind} "${finding.subject}" raised.` };
  } catch (error) {
    return refusal(error);
  }
}

/** Management's answer. Never by the raiser. */
export async function respondToFindingAction(_prev: FindingActionState, form: FormData): Promise<FindingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, AUDIT_RESPOND_CAPABILITY)) {
    return { ok: false, message: `You do not hold ${AUDIT_RESPOND_CAPABILITY}.`, remedy: `Ask for ${AUDIT_RESPOND_CAPABILITY}.` };
  }
  if (!session.sessionId) return { ok: false, message: 'Your session could not be verified.', remedy: 'Sign in again.' };
  try {
    const finding = await respondToFinding({
      client: session.user.client,
      authorization: { userId: session.user.userId, sessionId: session.sessionId },
      findingId: text(form, 'findingId'),
      response: text(form, 'response'),
      status: text(form, 'status'),
    });
    revalidatePath(ROUTE);
    revalidatePath(AUDIT_WORKSPACE_ROUTE);
    return { ok: true, message: `Answered: ${finding.status}.` };
  } catch (error) {
    return refusal(error);
  }
}

/** Export the evidence pack of the live grant. Logged as EXPORT. */
export async function exportEvidenceAction(_prev: ExportState, _form: FormData): Promise<ExportState> {
  const session = await requireSession(ROUTE);
  if (!can(session, AUDIT_EXPORT_CAPABILITY)) {
    return { ok: false, message: `You do not hold ${AUDIT_EXPORT_CAPABILITY}.`, remedy: `Ask for ${AUDIT_EXPORT_CAPABILITY}.` };
  }
  try {
    const pack = await exportEvidence(actorOf(session));
    return { ok: true, message: `Exported ${pack.rows} row(s). The export is logged.`, filename: pack.filename, csv: pack.csv };
  } catch (error) {
    return refusal(error);
  }
}
