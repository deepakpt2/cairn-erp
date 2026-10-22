'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import { saveNumberRangeObject } from '@/modules/foundation/number-ranges';
import { ConfigError } from '@/modules/foundation/services';

export interface NumberRangeObjectActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

const ROUTE = '/config/number-range-objects';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export async function saveNumberRangeObjectAction(
  _previous: NumberRangeObjectActionState,
  form: FormData,
): Promise<NumberRangeObjectActionState> {
  const session = await requireSession(ROUTE);
  try {
    await assertChangeForSession(session, { lockObject: 'NUMBER_RANGE_OBJECT', argument: read(form, 'objectCode') });
    const result = await saveNumberRangeObject({
      client: session.user.client,
      changedBy: session.user.username,
      objectCode: read(form, 'objectCode'),
      description: read(form, 'description'),
      numberLength: Number(read(form, 'numberLength')),
      warningPercent: read(form, 'warningPercent'),
      yearRelevant: read(form, 'yearRelevant') === 'on',
      subobjectHint: read(form, 'subobjectHint'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return result.changed
      ? { ok: true, message: `Number range object ${result.objectCode} saved.` }
      : { ok: true, message: `Number range object ${result.objectCode} already holds these facts; nothing was changed.` };
  } catch (error) {
    if (error instanceof ConfigError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
