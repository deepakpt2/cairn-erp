'use server';

import { revalidatePath } from 'next/cache';

import {
  ACTIVITY,
  AvailabilityCheckError,
  LOCK_OBJECT,
  ROUTE,
  assignCheckingGroup,
  saveCheckingGroup,
  saveCheckingRule,
  saveScopeOfCheck,
} from '@/modules/production/availability-check';
import { requireCapability, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';

export interface AvailabilityActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function flag(form: FormData, name: string): string {
  return form.get(name) === 'X' ? 'X' : ' ';
}

function fail(error: unknown): AvailabilityActionState {
  if (error instanceof AvailabilityCheckError || error instanceof EnqueueError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

function modeOf(form: FormData): 'CREATE' | 'CHANGE' | 'DELETE' {
  const mode = read(form, 'mode');
  if (mode === 'CHANGE' || mode === 'DELETE') return mode;
  return 'CREATE';
}

export async function saveCheckingGroupAction(
  _previous: AvailabilityActionState,
  form: FormData,
): Promise<AvailabilityActionState> {
  const session = await requireSession(ROUTE);
  try {
    await requireCapability(ACTIVITY, session);
    const checkingGroup = read(form, 'checkingGroup');
    const mode = modeOf(form);
    if (mode !== 'CREATE') {
      await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: `GROUP/${checkingGroup}` });
    }
    const saved = await saveCheckingGroup({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      checkingGroup,
      description: read(form, 'description'),
      noCheck: flag(form, 'noCheck'),
      version: Number(read(form, 'version') || '0'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: saved ? `Checking group ${saved.checkingGroup} saved.` : `Checking group ${checkingGroup} deleted.` };
  } catch (error) {
    return fail(error);
  }
}

export async function saveCheckingRuleAction(
  _previous: AvailabilityActionState,
  form: FormData,
): Promise<AvailabilityActionState> {
  const session = await requireSession(ROUTE);
  try {
    await requireCapability(ACTIVITY, session);
    const checkingRule = read(form, 'checkingRule');
    const mode = modeOf(form);
    if (mode !== 'CREATE') {
      await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: `RULE/${checkingRule}` });
    }
    const saved = await saveCheckingRule({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      checkingRule,
      description: read(form, 'description'),
      version: Number(read(form, 'version') || '0'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: saved ? `Checking rule ${saved.checkingRule} saved.` : `Checking rule ${checkingRule} deleted.` };
  } catch (error) {
    return fail(error);
  }
}

export async function assignCheckingGroupAction(
  _previous: AvailabilityActionState,
  form: FormData,
): Promise<AvailabilityActionState> {
  const session = await requireSession(ROUTE);
  try {
    await requireCapability(ACTIVITY, session);
    const saved = await assignCheckingGroup({
      client: session.user.client,
      changedBy: session.user.username,
      materialNumber: read(form, 'materialNumber'),
      plant: read(form, 'plant'),
      checkingGroup: read(form, 'checkingGroup'),
      expectedVersion: Number(read(form, 'expectedVersion') || '0'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: saved.checkingGroup
        ? `Material ${saved.materialNumber} in plant ${saved.plant} uses checking group ${saved.checkingGroup}.`
        : `Material ${saved.materialNumber} in plant ${saved.plant} has no checking group.`,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function saveScopeAction(
  _previous: AvailabilityActionState,
  form: FormData,
): Promise<AvailabilityActionState> {
  const session = await requireSession(ROUTE);
  try {
    await requireCapability(ACTIVITY, session);
    const checkingGroup = read(form, 'checkingGroup');
    const checkingRule = read(form, 'checkingRule');
    const mode = modeOf(form);
    if (mode !== 'CREATE') {
      await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: `SCOPE/${checkingGroup}/${checkingRule}` });
    }
    const saved = await saveScopeOfCheck({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      checkingGroup,
      checkingRule,
      includeSafetyStock: flag(form, 'includeSafetyStock'),
      includeQualityStock: flag(form, 'includeQualityStock'),
      includeBlockedStock: flag(form, 'includeBlockedStock'),
      includeRestrictedUse: flag(form, 'includeRestrictedUse'),
      purchaseOrders: flag(form, 'purchaseOrders'),
      purchaseRequisitions: flag(form, 'purchaseRequisitions'),
      plannedOrders: read(form, 'plannedOrders') || ' ',
      productionOrders: read(form, 'productionOrders') || ' ',
      dependentRequirements: flag(form, 'dependentRequirements'),
      reservations: flag(form, 'reservations'),
      receiptsInPast: read(form, 'receiptsInPast') || ' ',
      version: Number(read(form, 'version') || '0'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: saved
        ? `Scope ${saved.checkingGroup}/${saved.checkingRule} saved. No ATP quantity was calculated.`
        : `Scope ${checkingGroup}/${checkingRule} deleted.`,
    };
  } catch (error) {
    return fail(error);
  }
}
