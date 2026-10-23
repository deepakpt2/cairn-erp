'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  SCHEDULE_MAINTAIN_CAPABILITY,
  SCHEDULE_ROUTE,
  SchedulingAgreementScheduleError,
  maintainDeliverySchedule,
  type MaintainScheduleInput,
} from '@/modules/purchasing/scheduling-agreement-schedule';

export interface ScheduleActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

const INITIAL_OK = false;

export async function saveDeliveryScheduleAction(
  _previous: ScheduleActionState,
  form: FormData,
): Promise<ScheduleActionState> {
  const session = await requireSession(SCHEDULE_ROUTE);
  if (!can(session, SCHEDULE_MAINTAIN_CAPABILITY)) {
    return { ok: INITIAL_OK, message: 'You do not hold the delivery-schedule maintain capability.' };
  }
  const raw = form.get('payload');
  if (typeof raw !== 'string') return { ok: false, message: 'The schedule payload is missing.' };
  let payload: MaintainScheduleInput;
  try {
    payload = JSON.parse(raw) as MaintainScheduleInput;
  } catch {
    return { ok: false, message: 'The schedule payload is not valid JSON.' };
  }
  if (!payload.agreementNumber) return { ok: false, message: 'An agreement number is required.' };
  try {
    await assertChangeForSession(session, {
      lockObject: 'SCHEDULING_AGREEMENT',
      argument: payload.agreementNumber,
    });
    const saved = await maintainDeliverySchedule({
      ...payload,
      client: session.user.client,
      changedBy: session.user.username,
    });
    revalidatePath(SCHEDULE_ROUTE);
    return {
      ok: true,
      message: `Delivery schedule for ${saved.agreementNumber} item ${saved.itemNumber} was saved. No goods receipt or supplier release was posted.`,
    };
  } catch (error) {
    if (error instanceof SchedulingAgreementScheduleError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: 'remedy' in error ? error.remedy : undefined };
    }
    throw error;
  }
}
