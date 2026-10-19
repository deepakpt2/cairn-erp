'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  CONSOLIDATE_CAPABILITY, CONSOLIDATION_MONITOR_AUTHORITIES,
  ConsolidationMonitorError, cancelConsolidationExecution,
  executeConsolidationTask, executeConsolidationTaskGroup,
  type ConsolidationMonitorSelection,
} from '@/modules/finance/consolidation-monitor';

export interface ConsolidationMonitorActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  runId?: string;
}

const ROUTE = '/finance/consolidation-monitor';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function selectionFrom(form: FormData): ConsolidationMonitorSelection {
  return {
    area: text(form, 'area').toUpperCase(),
    group: text(form, 'group').toUpperCase(),
    version: text(form, 'version').toUpperCase(),
    fiscalYear: Number(text(form, 'fiscalYear')) || new Date().getFullYear(),
    period: Number(text(form, 'period')) || 1,
    taskGroup: text(form, 'taskGroup').toUpperCase(),
    unit: text(form, 'unit').toUpperCase(),
    mode: text(form, 'mode').toUpperCase() === 'UPDATE' ? 'UPDATE' : 'TEST',
    warningPolicy: text(form, 'warningPolicy').toUpperCase() === 'ALLOW_WARNINGS'
      ? 'ALLOW_WARNINGS'
      : 'BLOCK_ON_WARNING',
  };
}

function wrap(error: unknown): ConsolidationMonitorActionState {
  if (error instanceof ConsolidationMonitorError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

function authorityForMode(selection: ConsolidationMonitorSelection): string {
  return selection.mode === 'UPDATE'
    ? CONSOLIDATION_MONITOR_AUTHORITIES.update
    : CONSOLIDATION_MONITOR_AUTHORITIES.test;
}

export async function executeTaskAction(
  _prev: ConsolidationMonitorActionState,
  form: FormData,
): Promise<ConsolidationMonitorActionState> {
  const session = await requireSession(ROUTE);
  const selection = selectionFrom(form);
  const authority = authorityForMode(selection);
  if (!can(session, authority)) {
    return { ok: false, message: `You do not hold the consolidation ${selection.mode.toLowerCase()} run authority (${authority}).` };
  }
  try {
    const run = await executeConsolidationTask({
      client: session.user.client,
      executedBy: session.user.username,
      selection,
      task: text(form, 'task'),
      unit: text(form, 'unit'),
    });
    revalidatePath(ROUTE);
    return {
      ok: run.status === 'COMPLETED' || run.status === 'WARNING',
      message: `${run.mode} run ${run.runId} for task ${run.task} finished ${run.status}: ${run.resultSummary}`,
      runId: run.runId,
    };
  } catch (error) {
    return wrap(error);
  }
}

export async function executeTaskGroupAction(
  _prev: ConsolidationMonitorActionState,
  form: FormData,
): Promise<ConsolidationMonitorActionState> {
  const session = await requireSession(ROUTE);
  const selection = selectionFrom(form);
  const authority = authorityForMode(selection);
  if (!can(session, authority)) {
    return { ok: false, message: `You do not hold the consolidation ${selection.mode.toLowerCase()} run authority (${authority}).` };
  }
  try {
    const result = await executeConsolidationTaskGroup({
      client: session.user.client,
      executedBy: session.user.username,
      selection,
      taskGroup: text(form, 'taskGroup'),
      errorPolicy: text(form, 'errorPolicy').toUpperCase() === 'CONTINUE_ON_ERROR'
        ? 'CONTINUE_ON_ERROR'
        : 'STOP_ON_ERROR',
    });
    revalidatePath(ROUTE);
    const last = result.runs[result.runs.length - 1];
    return {
      ok: !result.stopped,
      message: result.runs.length === 0
        ? 'No eligible task/unit rows stood for this task group.'
        : `Task group ${text(form, 'taskGroup').toUpperCase()} executed ${result.runs.length} task attempt(s)${result.stopped ? ' and stopped on an error or block' : ''}. Last: ${last?.task} ${last?.status}.`,
      runId: last?.runId,
    };
  } catch (error) {
    return wrap(error);
  }
}

export async function cancelExecutionAction(
  _prev: ConsolidationMonitorActionState,
  form: FormData,
): Promise<ConsolidationMonitorActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, CONSOLIDATION_MONITOR_AUTHORITIES.update)) {
    return { ok: false, message: `You do not hold the consolidation update authority (${CONSOLIDATION_MONITOR_AUTHORITIES.update}).` };
  }
  try {
    const run = await cancelConsolidationExecution({
      client: session.user.client,
      executedBy: session.user.username,
      runId: text(form, 'runId'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Run ${run.runId} cancelled; the task stands open for a retry.`, runId: run.runId };
  } catch (error) {
    return wrap(error);
  }
}
