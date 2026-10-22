'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  AccountDeterminationError,
  deleteAccountDetermination,
  saveAccountDetermination,
  type DeterminationDeleteInput,
  type DeterminationInput,
} from '@/modules/foundation/account-determination';

export interface AccountDeterminationActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

const ROUTE = '/config/account-determination';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function words(input: { chartOfAccounts: string; event: string }) {
  return { chart: input.chartOfAccounts, event: t(`acctDet.event.${input.event}`) };
}

function determinationArgument(form: FormData): string {
  return [read(form, 'chartOfAccounts'), read(form, 'event'), read(form, 'valuationClass'), read(form, 'generalModifier')].join('/');
}

export async function saveDeterminationAction(
  _previous: AccountDeterminationActionState,
  form: FormData,
): Promise<AccountDeterminationActionState> {
  const session = await requireSession(ROUTE);
  const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';

  const input: DeterminationInput = {
    client: session.user.client,
    changedBy: session.user.username,
    mode,
    chartOfAccounts: read(form, 'chartOfAccounts'),
    event: read(form, 'event'),
    valuationClass: read(form, 'valuationClass'),
    generalModifier: read(form, 'generalModifier'),
    glAccount: read(form, 'glAccount'),
    reason: read(form, 'reason'),
  };

  try {
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, { lockObject: 'ACCOUNT_DETERMINATION', argument: determinationArgument(form) });
    }
    const result = await saveAccountDetermination(input);
    revalidatePath(ROUTE);
    if (!result.changed) {
      return { ok: true, message: t('acctDet.unchanged', words(result)) };
    }
    return {
      ok: true,
      message: mode === 'CREATE' ? t('acctDet.created', words(result)) : t('acctDet.changed', words(result)),
    };
  } catch (error) {
    if (error instanceof AccountDeterminationError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    return { ok: false, message: t('acctDet.unexpected'), remedy: t('acctDet.unexpectedRemedy') };
  }
}

export async function deleteDeterminationAction(
  _previous: AccountDeterminationActionState,
  form: FormData,
): Promise<AccountDeterminationActionState> {
  const session = await requireSession(ROUTE);

  const input: DeterminationDeleteInput = {
    client: session.user.client,
    changedBy: session.user.username,
    chartOfAccounts: read(form, 'chartOfAccounts'),
    event: read(form, 'event'),
    valuationClass: read(form, 'valuationClass'),
    generalModifier: read(form, 'generalModifier'),
    reason: read(form, 'reason'),
  };

  try {
    await assertChangeForSession(session, { lockObject: 'ACCOUNT_DETERMINATION', argument: determinationArgument(form) });
    await deleteAccountDetermination(input);
    revalidatePath(ROUTE);
    return { ok: true, message: t('acctDet.deleted', words(input)) };
  } catch (error) {
    if (error instanceof AccountDeterminationError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    return { ok: false, message: t('acctDet.unexpected'), remedy: t('acctDet.unexpectedRemedy') };
  }
}
