'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';

const ROUTE = '/platform/jobs';
const CANCEL = 'PLT.JOB.CANCEL';
const RETRY = 'PLT.JOB.RETRY';

export interface JobActionState {
  ok: boolean;
  message?: string;
}

/**
 * Ask a run to stop.
 *
 * This is a request, and the word matters: the worker finishes the chunk in its
 * hands and then stops. Killing it mid-chunk would leave half a document
 * written, which is a worse outcome than waiting a few seconds.
 */
export async function cancelRun(_prev: JobActionState, formData: FormData): Promise<JobActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, CANCEL)) return { ok: false, message: 'notAuthorised' };

  const runId = String(formData.get('runId') ?? '');
  if (!runId) return { ok: false, message: 'missingRun' };

  const { requestCancel } = await import('@/platform/job/queue');
  const ok = await withTenant(session.user.client, (tx) => requestCancel(tx, session.user.client, runId));
  revalidatePath(ROUTE);
  return ok ? { ok: true } : { ok: false, message: 'notFound' };
}

/** Put a stopped run back on the queue. */
export async function retryRun(_prev: JobActionState, formData: FormData): Promise<JobActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RETRY)) return { ok: false, message: 'notAuthorised' };

  const runId = String(formData.get('runId') ?? '');
  if (!runId) return { ok: false, message: 'missingRun' };

  const { retryRun: requeue } = await import('@/platform/job/queue');
  const ok = await withTenant(session.user.client, (tx) => requeue(tx, session.user.client, runId));
  revalidatePath(ROUTE);
  return ok ? { ok: true } : { ok: false, message: 'notFound' };
}
