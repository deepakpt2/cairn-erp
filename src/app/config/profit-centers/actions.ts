'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ProfitCenterError,
  deleteProfitCenter,
  saveProfitCenter,
  setProfitCenterPostingLock,
  type ProfitCenterDeleteInput,
  type ProfitCenterInput,
  type ProfitCenterLockInput,
} from '@/modules/foundation/profit-center-definition';

export interface ProfitCenterActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

const ROUTE = '/config/profit-centers';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function periodArgument(form: FormData): string {
  return [read(form, 'controllingArea'), read(form, 'profitCenter'), read(form, 'validFrom')]
    .map((part) => part.trim())
    .join('/');
}

export async function saveProfitCenterAction(
  _previous: ProfitCenterActionState,
  form: FormData,
): Promise<ProfitCenterActionState> {
  const session = await requireSession(ROUTE);
  const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';

  const input: ProfitCenterInput = {
    client: session.user.client,
    changedBy: session.user.username,
    mode,
    controllingArea: read(form, 'controllingArea'),
    profitCenter: read(form, 'profitCenter'),
    validFrom: read(form, 'validFrom'),
    validTo: read(form, 'validTo'),
    name: read(form, 'name'),
    longText: read(form, 'longText'),
    personResponsible: read(form, 'personResponsible'),
    responsibleUser: read(form, 'responsibleUser'),
    segment: read(form, 'segment'),
    reason: read(form, 'reason'),
  };

  try {
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, { lockObject: 'PROFIT_CENTER', argument: periodArgument(form) });
    }
    const result = await saveProfitCenter(input);
    revalidatePath(ROUTE);
    if (!result.changed) {
      return {
        ok: true,
        message: `Profit Centre ${result.profitCenter} already holds these facts for the period from ${result.validFrom}; nothing was changed.`,
      };
    }
    return {
      ok: true,
      message:
        mode === 'CREATE'
          ? `Profit Centre ${result.profitCenter} created in Controlling Area ${result.controllingArea} from ${result.validFrom}.`
          : `Profit Centre ${result.profitCenter} changed for the period from ${result.validFrom}.`,
    };
  } catch (error) {
    if (error instanceof EnqueueError || error instanceof ProfitCenterError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    return {
      ok: false,
      message: 'The profit centre could not be saved.',
      remedy: 'Nothing was written. Try again, and if it fails again ask an administrator to check the server log.',
    };
  }
}

export async function lockProfitCenterAction(
  _previous: ProfitCenterActionState,
  form: FormData,
): Promise<ProfitCenterActionState> {
  const session = await requireSession(ROUTE);
  const locked = read(form, 'locked') === 'true';

  const input: ProfitCenterLockInput = {
    client: session.user.client,
    changedBy: session.user.username,
    controllingArea: read(form, 'controllingArea'),
    profitCenter: read(form, 'profitCenter'),
    validFrom: read(form, 'validFrom'),
    locked,
    reason: read(form, 'reason'),
  };

  try {
    await assertChangeForSession(session, { lockObject: 'PROFIT_CENTER', argument: periodArgument(form) });
    const result = await setProfitCenterPostingLock(input);
    revalidatePath(ROUTE);
    if (!result.changed) {
      return {
        ok: true,
        message: `Profit Centre ${input.profitCenter} is already ${locked ? 'locked' : 'open'} for posting; nothing was changed.`,
      };
    }
    return {
      ok: true,
      message: locked
        ? `Profit Centre ${input.profitCenter} locked for posting from ${input.validFrom}.`
        : `Profit Centre ${input.profitCenter} open for posting again from ${input.validFrom}.`,
    };
  } catch (error) {
    if (error instanceof EnqueueError || error instanceof ProfitCenterError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    return {
      ok: false,
      message: 'The posting lock could not be changed.',
      remedy: 'Nothing was written. Try again, and if it fails again ask an administrator to check the server log.',
    };
  }
}

export async function deleteProfitCenterAction(
  _previous: ProfitCenterActionState,
  form: FormData,
): Promise<ProfitCenterActionState> {
  const session = await requireSession(ROUTE);

  const input: ProfitCenterDeleteInput = {
    client: session.user.client,
    changedBy: session.user.username,
    controllingArea: read(form, 'controllingArea'),
    profitCenter: read(form, 'profitCenter'),
    validFrom: read(form, 'validFrom'),
    reason: read(form, 'reason'),
  };

  try {
    await assertChangeForSession(session, { lockObject: 'PROFIT_CENTER', argument: periodArgument(form) });
    await deleteProfitCenter(input);
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Profit Centre ${input.profitCenter} period from ${input.validFrom} deleted.`,
    };
  } catch (error) {
    if (error instanceof EnqueueError || error instanceof ProfitCenterError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    return {
      ok: false,
      message: 'The profit centre could not be deleted.',
      remedy: 'Nothing was written. Try again, and if it fails again ask an administrator to check the server log.',
    };
  }
}
