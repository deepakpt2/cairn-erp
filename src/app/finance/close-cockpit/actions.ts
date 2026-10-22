'use server';

/** FIN.CLOSE.COCKPIT — authenticate, authorise and run cockpit acts (SCR-101). */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  CLOSE_COCKPIT_CAPABILITY, CloseCockpitError, attachEvidence, createTaskListFromTemplate,
  executeTask, finalizeTaskList, overrideTaskStatus, processScheduledExecutions, releaseTaskList,
  reopenTask, signOffTask, type CloseCycleKey, type TaskStatus,
} from '@/modules/finance/close-cockpit';
import { requireCapability, requireSession, AuthzError } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';

const PATH = '/finance/close-cockpit';

export interface CloseState { ok: boolean; message?: string; remedy?: string }

function cycleFrom(formData: FormData): CloseCycleKey {
  const read = (name: string) => String(formData.get(name) ?? '').trim();
  return {
    companyCode: read('companyCode'), taskListId: read('taskListId').toUpperCase(),
    fiscalYear: Number(read('fiscalYear')), postingPeriod: Number(read('postingPeriod')),
  };
}

function cycleUrl(cycle: CloseCycleKey): string {
  const q = new URLSearchParams({
    company: cycle.companyCode, list: cycle.taskListId,
    fy: String(cycle.fiscalYear), period: String(cycle.postingPeriod),
  });
  return `${PATH}?${q.toString()}`;
}

async function guard(formData: FormData) {
  const session = await requireSession(PATH);
  await requireCapability(CLOSE_COCKPIT_CAPABILITY, session);
  return session;
}

function errorState(error: unknown): CloseState {
  if (error instanceof CloseCockpitError || error instanceof AuthzError) {
    return { ok: false, message: error.message, remedy: (error as { remedy?: string }).remedy };
  }
  console.error('Close cockpit action failed', error);
  return { ok: false, message: 'The action failed. Nothing was changed.', remedy: 'Contact an administrator if the problem persists.' };
}

export async function createListAction(_previous: CloseState, formData: FormData): Promise<CloseState> {
  let target = PATH;
  try {
    const session = await guard(formData);
    const cycle = cycleFrom(formData);
    await createTaskListFromTemplate({
      client: session.user.client, changedBy: session.user.username, cycle,
      templateCode: String(formData.get('templateCode') ?? '').trim().toUpperCase(),
      description: String(formData.get('description') ?? '').trim() || undefined,
    });
    target = cycleUrl(cycle);
  } catch (error) {
    return errorState(error);
  }
  redirect(target);
}

async function changeCycle(
  formData: FormData,
  write: (session: Awaited<ReturnType<typeof guard>>, cycle: CloseCycleKey) => Promise<void>,
) {
  const session = await guard(formData);
  const cycle = cycleFrom(formData);
  try {
    await assertChangeForSession(session, {
      lockObject: 'CLOSE_CYCLE',
      argument: `${cycle.companyCode}/${cycle.taskListId}/${cycle.fiscalYear}/${cycle.postingPeriod}`,
    });
    await write(session, cycle);
    revalidatePath(PATH);
  } catch (error) {
    if (error instanceof EnqueueError) {
      const message = error.remedy ? `${error.message} ${error.remedy}` : error.message;
      redirect(`${cycleUrl(cycle)}&error=${encodeURIComponent(message)}`);
    }
    throw error;
  }
}

export async function releaseListAction(formData: FormData): Promise<void> {
  await changeCycle(formData, (session, cycle) => releaseTaskList({
    client: session.user.client, changedBy: session.user.username, cycle,
  }));
}

export async function finalizeListAction(formData: FormData): Promise<void> {
  await changeCycle(formData, (session, cycle) => finalizeTaskList({
    client: session.user.client, changedBy: session.user.username, cycle,
  }));
}

export async function processScheduledAction(formData: FormData): Promise<void> {
  await changeCycle(formData, (session, cycle) => processScheduledExecutions({
    client: session.user.client, changedBy: session.user.username, cycle,
  }));
}

export async function executeTaskAction(formData: FormData): Promise<void> {
  await changeCycle(formData, (session, cycle) => executeTask({
    client: session.user.client, changedBy: session.user.username, cycle,
    taskId: String(formData.get('taskId') ?? '').trim(),
    mode: String(formData.get('mode') ?? 'FOREGROUND') === 'BACKGROUND' ? 'BACKGROUND' : 'FOREGROUND',
  }));
}

export async function evidenceAction(formData: FormData): Promise<void> {
  await changeCycle(formData, (session, cycle) => attachEvidence({
    client: session.user.client, changedBy: session.user.username, cycle,
    taskId: String(formData.get('taskId') ?? '').trim(),
    evidenceRef: String(formData.get('evidenceRef') ?? ''),
  }));
}

export async function signoffAction(formData: FormData): Promise<void> {
  await changeCycle(formData, (session, cycle) => signOffTask({
    client: session.user.client, changedBy: session.user.username, cycle,
    taskId: String(formData.get('taskId') ?? '').trim(),
  }));
}

export async function overrideAction(formData: FormData): Promise<void> {
  await changeCycle(formData, (session, cycle) => overrideTaskStatus({
    client: session.user.client, changedBy: session.user.username, cycle,
    taskId: String(formData.get('taskId') ?? '').trim(),
    newStatus: String(formData.get('newStatus') ?? '') as TaskStatus,
    reason: String(formData.get('reason') ?? ''),
  }));
}

export async function reopenAction(formData: FormData): Promise<void> {
  await changeCycle(formData, (session, cycle) => reopenTask({
    client: session.user.client, changedBy: session.user.username, cycle,
    taskId: String(formData.get('taskId') ?? '').trim(),
    reason: String(formData.get('reason') ?? ''),
  }));
}
