'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import {
  ReleaseStrategyError,
  deleteReleaseGroup,
  deleteReleaseStrategy,
  saveReleaseGroup,
  saveReleaseStrategy,
  setReleaseStrategyStatus,
} from '@/modules/foundation/release-strategy-definition';

export interface ReleaseActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

const ROUTE = '/config/release-strategies';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function fail(error: unknown): ReleaseActionState {
  if (error instanceof ReleaseStrategyError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

export async function saveReleaseGroupAction(
  _previous: ReleaseActionState,
  form: FormData,
): Promise<ReleaseActionState> {
  const session = await requireSession(ROUTE);
  const payload = JSON.parse(read(form, 'payload') || '{}') as Record<string, unknown>;
  try {
    const result = await saveReleaseGroup({
      client: session.user.client,
      changedBy: session.user.username,
      mode: read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE',
      groupCode: String(payload.groupCode ?? ''),
      documentCategory: String(payload.documentCategory ?? ''),
      description: String(payload.description ?? ''),
      codes: Array.isArray(payload.codes)
        ? (payload.codes as Array<Record<string, unknown>>).map((row) => ({
            code: String(row.code ?? ''), description: String(row.description ?? ''),
          }))
        : [],
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Release group ${result.groupCode} saved.` };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteReleaseGroupAction(
  _previous: ReleaseActionState,
  form: FormData,
): Promise<ReleaseActionState> {
  const session = await requireSession(ROUTE);
  try {
    const result = await deleteReleaseGroup({
      client: session.user.client,
      changedBy: session.user.username,
      groupCode: read(form, 'groupCode'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Release group ${result.groupCode} deleted.` };
  } catch (error) {
    return fail(error);
  }
}

export async function saveReleaseStrategyAction(
  _previous: ReleaseActionState,
  form: FormData,
): Promise<ReleaseActionState> {
  const session = await requireSession(ROUTE);
  const payload = JSON.parse(read(form, 'payload') || '{}') as Record<string, unknown>;
  try {
    const result = await saveReleaseStrategy({
      client: session.user.client,
      changedBy: session.user.username,
      mode: read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE',
      groupCode: String(payload.groupCode ?? ''),
      strategyCode: String(payload.strategyCode ?? ''),
      description: String(payload.description ?? ''),
      className: String(payload.className ?? ''),
      priority: Number(payload.priority ?? 100),
      criteria: Array.isArray(payload.criteria)
        ? (payload.criteria as Array<Record<string, unknown>>).map((row) => ({
            characteristicName: String(row.characteristicName ?? ''),
            operator: String(row.operator ?? 'EQ'),
            valueFrom: String(row.valueFrom ?? ''),
            valueTo: String(row.valueTo ?? ''),
          }))
        : [],
      steps: Array.isArray(payload.steps) ? payload.steps.map(String) : [],
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Strategy ${result.strategyCode} saved in group ${result.groupCode}.` };
  } catch (error) {
    return fail(error);
  }
}

export async function setReleaseStrategyStatusAction(
  _previous: ReleaseActionState,
  form: FormData,
): Promise<ReleaseActionState> {
  const session = await requireSession(ROUTE);
  const status = read(form, 'status') === 'BLOCKED' ? 'BLOCKED' : 'ACTIVE';
  try {
    const result = await setReleaseStrategyStatus({
      client: session.user.client,
      changedBy: session.user.username,
      groupCode: read(form, 'groupCode'),
      strategyCode: read(form, 'strategyCode'),
      status,
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return result.changed
      ? { ok: true, message: `Strategy ${result.strategyCode} is now ${status === 'ACTIVE' ? 'active' : 'blocked'}.` }
      : { ok: true, message: `Strategy ${result.strategyCode} already stands ${status.toLowerCase()}.` };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteReleaseStrategyAction(
  _previous: ReleaseActionState,
  form: FormData,
): Promise<ReleaseActionState> {
  const session = await requireSession(ROUTE);
  try {
    const result = await deleteReleaseStrategy({
      client: session.user.client,
      changedBy: session.user.username,
      groupCode: read(form, 'groupCode'),
      strategyCode: read(form, 'strategyCode'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Strategy ${result.strategyCode} deleted.` };
  } catch (error) {
    return fail(error);
  }
}
