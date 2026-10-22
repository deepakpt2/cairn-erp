'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  CostCenterError,
  deleteCostCenter,
  saveCostCenter,
  setCostCenterPostingLock,
  type CostCenterDeleteInput,
  type CostCenterInput,
  type CostCenterLockInput,
} from '@/modules/foundation/cost-center-definition';

export interface CostCenterActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

const ROUTE = '/config/cost-centers';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function periodArgument(form: FormData): string {
  return [read(form, 'controllingArea'), read(form, 'costCenter'), read(form, 'validFrom')]
    .map((part) => part.trim())
    .join('/');
}

export async function saveCostCenterAction(
  _previous: CostCenterActionState,
  form: FormData,
): Promise<CostCenterActionState> {
  const session = await requireSession(ROUTE);
  const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';

  const input: CostCenterInput = {
    client: session.user.client,
    changedBy: session.user.username,
    mode,
    controllingArea: read(form, 'controllingArea'),
    costCenter: read(form, 'costCenter'),
    validFrom: read(form, 'validFrom'),
    validTo: read(form, 'validTo'),
    name: read(form, 'name'),
    personResponsible: read(form, 'personResponsible'),
    category: read(form, 'category'),
    companyCode: read(form, 'companyCode'),
    reason: read(form, 'reason'),
  };

  try {
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, { lockObject: 'COST_CENTER', argument: periodArgument(form) });
    }
    const result = await saveCostCenter(input);
    revalidatePath(ROUTE);
    if (!result.changed) {
      return {
        ok: true,
        message: `Cost Centre ${result.costCenter} already holds these facts for the period from ${result.validFrom}; nothing was changed.`,
      };
    }
    return {
      ok: true,
      message:
        mode === 'CREATE'
          ? `Cost Centre ${result.costCenter} created in Controlling Area ${result.controllingArea} from ${result.validFrom}.`
          : `Cost Centre ${result.costCenter} changed for the period from ${result.validFrom}.`,
    };
  } catch (error) {
    if (error instanceof EnqueueError || error instanceof CostCenterError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    return {
      ok: false,
      message: 'The cost centre could not be saved.',
      remedy: 'Nothing was written. Try again, and if it fails again ask an administrator to check the server log.',
    };
  }
}

export async function lockCostCenterAction(
  _previous: CostCenterActionState,
  form: FormData,
): Promise<CostCenterActionState> {
  const session = await requireSession(ROUTE);
  const locked = read(form, 'locked') === 'true';

  const input: CostCenterLockInput = {
    client: session.user.client,
    changedBy: session.user.username,
    controllingArea: read(form, 'controllingArea'),
    costCenter: read(form, 'costCenter'),
    validFrom: read(form, 'validFrom'),
    locked,
    reason: read(form, 'reason'),
  };

  try {
    await assertChangeForSession(session, { lockObject: 'COST_CENTER', argument: periodArgument(form) });
    const result = await setCostCenterPostingLock(input);
    revalidatePath(ROUTE);
    if (!result.changed) {
      return {
        ok: true,
        message: `Cost Centre ${input.costCenter} is already ${locked ? 'locked' : 'open'} for posting; nothing was changed.`,
      };
    }
    return {
      ok: true,
      message: locked
        ? `Cost Centre ${input.costCenter} locked for posting from ${input.validFrom}.`
        : `Cost Centre ${input.costCenter} open for posting again from ${input.validFrom}.`,
    };
  } catch (error) {
    if (error instanceof EnqueueError || error instanceof CostCenterError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    return {
      ok: false,
      message: 'The posting lock could not be changed.',
      remedy: 'Nothing was written. Try again, and if it fails again ask an administrator to check the server log.',
    };
  }
}

export async function deleteCostCenterAction(
  _previous: CostCenterActionState,
  form: FormData,
): Promise<CostCenterActionState> {
  const session = await requireSession(ROUTE);

  const input: CostCenterDeleteInput = {
    client: session.user.client,
    changedBy: session.user.username,
    controllingArea: read(form, 'controllingArea'),
    costCenter: read(form, 'costCenter'),
    validFrom: read(form, 'validFrom'),
    reason: read(form, 'reason'),
  };

  try {
    await assertChangeForSession(session, { lockObject: 'COST_CENTER', argument: periodArgument(form) });
    await deleteCostCenter(input);
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Cost Centre ${input.costCenter} period from ${input.validFrom} deleted.`,
    };
  } catch (error) {
    if (error instanceof EnqueueError || error instanceof CostCenterError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    return {
      ok: false,
      message: 'The cost centre could not be deleted.',
      remedy: 'Nothing was written. Try again, and if it fails again ask an administrator to check the server log.',
    };
  }
}
