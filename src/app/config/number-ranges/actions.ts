'use server';

import { revalidatePath } from 'next/cache';
import { requireSession, requireCapability, AuthzError } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  adjustNumberRangeCurrent,
  maintainNumberRange,
  NUMBER_OBJECTS,
  NUMBER_RANGE_ACTIVITY,
  type NumberRangeInput,
} from '@/modules/foundation/number-ranges';
import { ConfigError } from '@/modules/foundation/services';
import { t } from '@/platform/i18n';

export interface RangeState { ok: boolean; message?: string; remedy?: string; key?: string }

export async function saveNumberRange(_previous: RangeState, form: FormData): Promise<RangeState> {
  const session = await requireSession('/config/number-ranges');
  const read = (name: string) => String(form.get(name) ?? '').trim();
  try {
    await requireCapability(NUMBER_RANGE_ACTIVITY, session);
    if (read('mode') === 'CHANGE') {
      await assertChangeForSession(session, {
        lockObject: 'NUMBER_RANGE',
        argument: `${read('objectCode')}/${read('companyCode')}/${read('subObject')}/${read('fiscalYear')}`,
      });
    }
    const result = await maintainNumberRange({
      client: session.user.client, changedBy: session.user.username,
      objectCode: read('objectCode') as NumberRangeInput['objectCode'],
      companyCode: read('companyCode'), subObject: read('subObject'),
      fiscalYear: Number(read('fiscalYear')), prefix: read('prefix'),
      fromNumber: Number(read('fromNumber')), toNumber: Number(read('toNumber')),
      numberLength: Number(read('numberLength')),
      displayStyle: read('displayStyle') as NumberRangeInput['displayStyle'],
      isExternal: read('isExternal') === 'external',
      isBuffered: read('isBuffered') === 'buffered',
      bufferSize: Number(read('bufferSize') || 0),
      status: read('status') as NumberRangeInput['status'],
      mode: read('mode') as NumberRangeInput['mode'], reason: read('reason'),
    });
    revalidatePath('/config/number-ranges');
    revalidatePath('/config');
    revalidatePath('/finance/journal/new');
    return { ok: true, message: t('nr.saved'), key: result.key };
  } catch (error) {
    if (error instanceof ConfigError || error instanceof AuthzError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}

export async function adjustNumberRangeCurrentAction(
  _previous: RangeState,
  form: FormData,
): Promise<RangeState> {
  const session = await requireSession('/config/number-ranges');
  const read = (name: string) => String(form.get(name) ?? '').trim();
  try {
    await requireCapability(NUMBER_RANGE_ACTIVITY, session);
    await assertChangeForSession(session, {
      lockObject: 'NUMBER_RANGE',
      argument: `${read('objectCode')}/${read('companyCode')}/${read('subObject')}/${read('fiscalYear')}`,
    });
    const result = await adjustNumberRangeCurrent({
      client: session.user.client,
      changedBy: session.user.username,
      objectCode: read('objectCode') as (typeof NUMBER_OBJECTS)[number],
      companyCode: read('companyCode'),
      subObject: read('subObject'),
      fiscalYear: Number(read('fiscalYear')),
      currentNumber: Number(read('currentNumber')),
      reason: read('reason'),
    });
    revalidatePath('/config/number-ranges');
    revalidatePath('/config');
    if (!result.changed) {
      return { ok: true, message: 'The counter already stands at that number; nothing was changed.' };
    }
    return {
      ok: true,
      message: result.wouldRepeat
        ? `Current number adjusted. Warning: numbers up to ${result.lastIssued} were already issued from this interval and will be given out again.`
        : 'Current number adjusted.',
    };
  } catch (error) {
    if (error instanceof ConfigError || error instanceof AuthzError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
