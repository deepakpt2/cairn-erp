'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ToleranceGroupError,
  saveEmployeeToleranceGroup,
  type ToleranceGroupInput,
} from '@/modules/foundation/employee-tolerance-definition';

export interface ToleranceGroupActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

const ROUTE = '/config/tolerance-groups';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/** The names the blank key parts carry on screen, for the answer sentence. */
function groupLabel(groupKey: string): string {
  return groupKey === '' ? t('tolGroup.defaultGroup') : groupKey;
}

function scopeLabel(companyCode: string): string {
  return companyCode === '' ? t('tolGroup.allCompanies') : companyCode;
}

export async function saveToleranceGroupAction(
  _previous: ToleranceGroupActionState,
  form: FormData,
): Promise<ToleranceGroupActionState> {
  const session = await requireSession(ROUTE);
  const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';

  const input: ToleranceGroupInput = {
    client: session.user.client,
    changedBy: session.user.username,
    mode,
    companyCode: read(form, 'companyCode'),
    groupKey: read(form, 'groupKey'),
    maxDocumentAmount: read(form, 'maxDocumentAmount'),
    maxLineAmount: read(form, 'maxLineAmount'),
    maxCashDiscountPercent: read(form, 'maxCashDiscountPercent'),
    paymentDiffRevenueAmount: read(form, 'paymentDiffRevenueAmount'),
    paymentDiffExpenseAmount: read(form, 'paymentDiffExpenseAmount'),
    paymentDiffRevenuePercent: read(form, 'paymentDiffRevenuePercent'),
    paymentDiffExpensePercent: read(form, 'paymentDiffExpensePercent'),
    reason: read(form, 'reason'),
  };

  try {
    const result = await saveEmployeeToleranceGroup(input);
    revalidatePath(ROUTE);
    const words = { group: groupLabel(result.groupKey), scope: scopeLabel(result.companyCode) };
    if (!result.changed) {
      return { ok: true, message: t('tolGroup.unchanged', words) };
    }
    return {
      ok: true,
      message: mode === 'CREATE' ? t('tolGroup.created', words) : t('tolGroup.changed', words),
    };
  } catch (error) {
    if (error instanceof ToleranceGroupError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    return { ok: false, message: t('tolGroup.unexpected'), remedy: t('tolGroup.unexpectedRemedy') };
  }
}
