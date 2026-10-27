'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyRemedy } from '@/ui/lock/remedy';
import {
  EnqueueError,
  deleteEnqueueEntry,
  displayOnlyMessage,
  heartbeatChangeLock,
  openForChange,
  releaseChangeLock,
  type EnqueueOpen,
} from '@/platform/lock/enqueue';

const ROUTE = '/platform/locks';
const DELETE = 'PLT.LOCK.DELETE';

/**
 * What a screen needs to render a change session: the mode, the platform's own reason when this session
 * was told to display, and what the operator can do about it. `remedy` is null wherever there is nothing to
 * add — a CHANGE grant, or an error the platform itself carries no guidance for — so a screen shows a second
 * line only when there is one.
 */
export interface ChangeLockState {
  mode: 'CHANGE' | 'DISPLAY';
  message: string | null;
  remedy: string | null;
}

export interface LockDeleteState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function held(session: { sessionId?: string; user: { client: string; username: string } }) {
  if (!session.sessionId) {
    throw new EnqueueError('The session is missing.', 'ENQUEUE_ARGUMENT', 'Sign in again.');
  }
  return session.sessionId;
}

export async function openChangeLockAction(
  lockObject: string,
  argument: string,
  transactionCode: string,
): Promise<ChangeLockState> {
  const session = await requireSession(ROUTE);
  try {
    const opened = await openForChange({
      client: session.user.client,
      sessionId: held(session),
      username: session.user.username,
      lockObject,
      argument,
      transactionCode,
    });
    return {
      mode: opened.mode,
      message: displayOnlyMessage(opened),
      // One sentence, one condition, shared with the screens whose lock is opened during their server render.
      remedy: displayOnlyRemedy(opened),
    };
  } catch (error) {
    if (error instanceof EnqueueError) return { mode: 'DISPLAY', message: error.message, remedy: error.remedy ?? null };
    throw error;
  }
}

export async function heartbeatEnqueueAction(lockObject: string, argument: string): Promise<void> {
  const session = await requireSession(ROUTE);
  if (!session.sessionId) return;
  await heartbeatChangeLock({
    client: session.user.client,
    sessionId: session.sessionId,
    lockObject,
    argument,
  });
}

export async function releaseEnqueueAction(lockObject: string, argument: string): Promise<void> {
  const session = await requireSession(ROUTE);
  if (!session.sessionId) return;
  await releaseChangeLock({
    client: session.user.client,
    sessionId: session.sessionId,
    lockObject,
    argument,
  });
}

export async function deleteEnqueueAction(
  _previous: LockDeleteState,
  form: FormData,
): Promise<LockDeleteState> {
  const session = await requireSession(ROUTE);
  if (!can(session, DELETE)) {
    return { ok: false, message: 'You do not hold the authority to delete a lock.' };
  }
  try {
    await deleteEnqueueEntry({
      client: session.user.client,
      changedBy: session.user.username,
      lockObject: String(form.get('lockObject') ?? ''),
      argument: String(form.get('argument') ?? ''),
      reason: String(form.get('reason') ?? ''),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: 'The lock is gone. The document was not changed.' };
  } catch (error) {
    if (error instanceof EnqueueError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

export type { EnqueueOpen };
