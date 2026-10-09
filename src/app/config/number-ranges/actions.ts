'use server';

import { revalidatePath } from 'next/cache';
import { requireSession, requireCapability, AuthzError } from '@/platform/auth/current';
import { maintainNumberRange, NUMBER_RANGE_ACTIVITY, type NumberRangeInput } from '@/modules/foundation/number-ranges';
import { ConfigError } from '@/modules/foundation/services';
import { t } from '@/platform/i18n';

export interface RangeState { ok: boolean; message?: string; remedy?: string; key?: string }

export async function saveNumberRange(_previous: RangeState, form: FormData): Promise<RangeState> {
  const session = await requireSession('/config/number-ranges');
  const read = (name: string) => String(form.get(name) ?? '').trim();
  try {
    await requireCapability(NUMBER_RANGE_ACTIVITY, session);
    const result = await maintainNumberRange({
      client: session.user.client, changedBy: session.user.username,
      objectCode: read('objectCode') as NumberRangeInput['objectCode'],
      companyCode: read('companyCode'), subObject: read('subObject'),
      fiscalYear: Number(read('fiscalYear')), prefix: read('prefix'),
      fromNumber: Number(read('fromNumber')), toNumber: Number(read('toNumber')),
      numberLength: Number(read('numberLength')),
      displayStyle: read('displayStyle') as NumberRangeInput['displayStyle'],
      status: read('status') as NumberRangeInput['status'],
      mode: read('mode') as NumberRangeInput['mode'], reason: read('reason'),
    });
    revalidatePath('/config/number-ranges');
    revalidatePath('/config');
    revalidatePath('/finance/journal/new');
    return { ok: true, message: t('nr.saved'), key: result.key };
  } catch (error) {
    if (error instanceof ConfigError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
