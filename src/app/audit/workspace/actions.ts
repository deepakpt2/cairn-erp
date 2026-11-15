'use server';

import { can, requireSession } from '@/platform/auth/current';
import {
  AUDIT_TRAIL_CAPABILITY,
  AUDIT_WORKSPACE_CAPABILITY,
  AUDIT_WORKSPACE_ROUTE,
  AuditError,
  recordAuditView,
  searchChangeHistory,
} from '@/modules/audit/workspace';

const ROUTE = AUDIT_WORKSPACE_ROUTE;

export interface ChangeHistoryRow {
  changedAt: string;
  changedBy: string;
  changeType: string;
  transactionCode: string | null;
  reason: string | null;
  items: Array<{ field: string; oldValue: string | null; newValue: string | null }>;
}

export interface AuditSearchState {
  ok: boolean;
  message?: string;
  remedy?: string;
  rows?: ChangeHistoryRow[];
  /** The terms searched, so the form keeps them after React resets it. */
  terms?: { objectClass: string; objectKey: string; module: string; companyCode: string };
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function actorOf(session: Awaited<ReturnType<typeof requireSession>>) {
  return { client: session.user.client, userId: session.user.userId, username: session.user.username };
}

/** Log one view of the workspace. Invoked from a client island after render, never during it. */
export async function logWorkspaceViewAction(detail: string): Promise<void> {
  const session = await requireSession(ROUTE);
  if (!can(session, AUDIT_WORKSPACE_CAPABILITY)) return;
  await recordAuditView(actorOf(session), ROUTE, detail.slice(0, 500));
}

/** Search the change-document trail (SM20 / SCU3) under the live grant. Logged. */
export async function searchHistoryAction(_prev: AuditSearchState, form: FormData): Promise<AuditSearchState> {
  const session = await requireSession(ROUTE);
  const terms = {
    objectClass: text(form, 'objectClass'),
    objectKey: text(form, 'objectKey'),
    module: text(form, 'module'),
    companyCode: text(form, 'companyCode'),
  };
  if (!can(session, AUDIT_TRAIL_CAPABILITY)) {
    return { ok: false, terms, message: `You do not hold ${AUDIT_TRAIL_CAPABILITY}.`, remedy: `Ask for ${AUDIT_TRAIL_CAPABILITY}.` };
  }
  try {
    const history = await searchChangeHistory(actorOf(session), {
      objectClass: terms.objectClass,
      objectKey: terms.objectKey,
      module: terms.module,
      companyCode: terms.companyCode || undefined,
    });
    const rows: ChangeHistoryRow[] = (history as unknown as Array<Record<string, unknown>>).map((doc) => ({
      changedAt: doc.changedAt instanceof Date ? doc.changedAt.toISOString() : String(doc.changedAt ?? ''),
      changedBy: String(doc.changedBy ?? ''),
      changeType: String(doc.changeType ?? ''),
      transactionCode: doc.transactionCode ? String(doc.transactionCode) : null,
      reason: doc.reason ? String(doc.reason) : null,
      items: ((doc.items as Array<Record<string, unknown>> | undefined) ?? []).map((item) => ({
        field: String(item.fieldName ?? item.field ?? ''),
        oldValue: item.oldValue === null || item.oldValue === undefined ? null : String(item.oldValue),
        newValue: item.newValue === null || item.newValue === undefined ? null : String(item.newValue),
      })),
    }));
    return { ok: true, rows, terms, message: rows.length === 0 ? 'No change documents for that object.' : undefined };
  } catch (error) {
    if (error instanceof AuditError) return { ok: false, terms, message: error.message, remedy: error.remedy };
    throw error;
  }
}
