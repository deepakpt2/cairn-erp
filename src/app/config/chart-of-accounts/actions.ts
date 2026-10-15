'use server';

/** Capability-protected OB13 Chart of Accounts definition action. */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ChartOfAccountsMaintenanceError,
  saveChartOfAccounts,
} from '@/modules/foundation/chart-of-accounts-maintenance';

const ACTIVITY = 'CFG.FIN.COA.DEFINE';
const ROUTE = '/config/chart-of-accounts';

export interface ChartOfAccountsActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

/** Tenant and actor are session-derived; the browser cannot select another tenant or user. */
export async function saveChartOfAccountsAction(
  _previous: ChartOfAccountsActionState,
  form: FormData,
): Promise<ChartOfAccountsActionState> {
  const session = await requireSession(ROUTE);
  const read = (key: string) => String(form.get(key) ?? '').trim();
  const readKey = (key: string) => read(key).toUpperCase();
  const mode = String(form.get('mode') ?? '') as 'CREATE' | 'CHANGE';
  const rawVersion = Number(form.get('expectedVersion') ?? '0');

  try {
    await requireCapability(ACTIVITY, session);
    const result = await saveChartOfAccounts({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      expectedVersion: Number.isFinite(rawVersion) ? rawVersion : Number.NaN,
      chartOfAccounts: readKey('chartOfAccounts'),
      name: read('name'),
      language: readKey('language'),
      accountNumberLength: Number(read('accountNumberLength')),
      groupChart: readKey('groupChart'),
      costElementIntegration: readKey('costElementIntegration') as 'AUTOMATIC' | 'MANUAL' | 'NONE',
      isBlocked: form.get('isBlocked') === 'on',
      reason: read('reason'),
    });

    revalidatePath(ROUTE);
    revalidatePath('/config');
    revalidatePath('/config/company-codes');
    revalidatePath('/config/gl-accounts');

    if (mode === 'CREATE') {
      return {
        ok: true,
        message: result.created
          ? t('chartOfAccounts.created', { code: result.chartOfAccounts })
          : t('chartOfAccounts.alreadyExists', { code: result.chartOfAccounts }),
      };
    }

    return {
      ok: true,
      message: result.changed
        ? t('chartOfAccounts.changed', { code: result.chartOfAccounts })
        : t('chartOfAccounts.unchanged', { code: result.chartOfAccounts }),
    };
  } catch (error) {
    if (error instanceof ChartOfAccountsMaintenanceError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    if (error instanceof AuthzError) {
      return {
        ok: false,
        message: t('chartOfAccounts.capabilityRequired', { capability: error.capability }),
        remedy: t('chartOfAccounts.capabilityRemedy', { capability: error.capability }),
      };
    }
    throw error;
  }
}
