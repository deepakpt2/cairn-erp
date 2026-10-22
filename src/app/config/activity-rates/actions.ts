'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ActivityRateError,
  deleteActivityRate,
  saveActivityRates,
  type ActivityRateDeleteInput,
  type ActivityRatesInput,
} from '@/modules/foundation/activity-rate-definition';

export interface ActivityRateActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

const ROUTE = '/config/activity-rates';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export async function saveActivityRatesAction(
  _previous: ActivityRateActionState,
  form: FormData,
): Promise<ActivityRateActionState> {
  const session = await requireSession(ROUTE);

  const periods = read(form, 'periods')
    .split(',')
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 16);

  const input: ActivityRatesInput = {
    client: session.user.client,
    changedBy: session.user.username,
    controllingArea: read(form, 'controllingArea'),
    planVersion: read(form, 'planVersion'),
    fiscalYear: Number(read(form, 'fiscalYear')),
    costCenter: read(form, 'costCenter'),
    activityType: read(form, 'activityType'),
    entries: periods.map((period) => ({
      period,
      plannedQuantity: read(form, `p${period}Quantity`) || '0',
      fixedPrice: read(form, `p${period}FixedPrice`) || '0',
      variablePrice: read(form, `p${period}VariablePrice`) || '0',
      priceUnit: Number(read(form, `p${period}PriceUnit`) || '1'),
    })),
    reason: read(form, 'reason'),
  };

  try {
    await assertChangeForSession(session, {
      lockObject: 'ACTIVITY_RATE',
      argument: [input.controllingArea, input.planVersion, String(input.fiscalYear), input.costCenter, input.activityType].join('/'),
    });
    const result = await saveActivityRates(input);
    revalidatePath(ROUTE);
    if (!result.changed) {
      return {
        ok: true,
        message: `The plan for ${input.costCenter} / ${input.activityType} already holds these values; nothing was changed.`,
      };
    }
    return {
      ok: true,
      message: `Plan saved for ${input.costCenter} / ${input.activityType}: ${result.periods} period${result.periods === 1 ? '' : 's'} written.`,
    };
  } catch (error) {
    if (error instanceof ActivityRateError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    return {
      ok: false,
      message: 'The activity rates could not be saved.',
      remedy: 'Nothing was written. Try again, and if it fails again ask an administrator to check the server log.',
    };
  }
}

export async function deleteActivityRateAction(
  _previous: ActivityRateActionState,
  form: FormData,
): Promise<ActivityRateActionState> {
  const session = await requireSession(ROUTE);

  const input: ActivityRateDeleteInput = {
    client: session.user.client,
    changedBy: session.user.username,
    controllingArea: read(form, 'controllingArea'),
    planVersion: read(form, 'planVersion'),
    fiscalYear: Number(read(form, 'fiscalYear')),
    period: Number(read(form, 'period')),
    costCenter: read(form, 'costCenter'),
    activityType: read(form, 'activityType'),
    reason: read(form, 'reason'),
  };

  try {
    await assertChangeForSession(session, {
      lockObject: 'ACTIVITY_RATE',
      argument: [input.controllingArea, input.planVersion, String(input.fiscalYear), input.costCenter, input.activityType].join('/'),
    });
    await deleteActivityRate(input);
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Activity rate for ${input.costCenter} / ${input.activityType} in period ${input.period} deleted.`,
    };
  } catch (error) {
    if (error instanceof ActivityRateError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    return {
      ok: false,
      message: 'The activity rate could not be deleted.',
      remedy: 'Nothing was written. Try again, and if it fails again ask an administrator to check the server log.',
    };
  }
}
