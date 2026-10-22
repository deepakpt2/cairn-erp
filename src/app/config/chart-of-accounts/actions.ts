'use server';

/** Capability-protected OB13 Chart of Accounts definition action. */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ChartOfAccountsMaintenanceError,
  saveChartOfAccounts,
  saveGroupChartOfAccounts,
  setChartOfAccountsActive,
  setGroupChartOfAccountsActive,
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
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, { lockObject: 'CHART_OF_ACCOUNTS', argument: readKey('chartOfAccounts') });
    }
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

function revalidateChartRoutes() {
  revalidatePath(ROUTE);
  revalidatePath('/config');
  revalidatePath('/config/company-codes');
  revalidatePath('/config/gl-accounts');
}

function mapChartError(error: unknown): ChartOfAccountsActionState {
  if (error instanceof ChartOfAccountsMaintenanceError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  if (error instanceof EnqueueError) {
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

/** Deactivate/reactivate an operational chart. The reason is mandatory and audited. */
export async function setChartOfAccountsActiveAction(
  _previous: ChartOfAccountsActionState,
  form: FormData,
): Promise<ChartOfAccountsActionState> {
  const session = await requireSession(ROUTE);
  const read = (key: string) => String(form.get(key) ?? '').trim();
  const rawVersion = Number(form.get('expectedVersion') ?? '0');

  try {
    await requireCapability(ACTIVITY, session);
    await assertChangeForSession(session, { lockObject: 'CHART_OF_ACCOUNTS', argument: read('chartOfAccounts') });
    const result = await setChartOfAccountsActive({
      client: session.user.client,
      changedBy: session.user.username,
      chartOfAccounts: read('chartOfAccounts').toUpperCase(),
      isActive: read('isActive') === 'true',
      expectedVersion: Number.isFinite(rawVersion) ? rawVersion : Number.NaN,
      reason: read('reason'),
    });

    revalidateChartRoutes();

    return {
      ok: true,
      message: !result.changed
        ? t('chartOfAccounts.alreadyInState', {
            code: result.chartOfAccounts,
            state: result.isActive ? t('chartOfAccounts.active') : t('chartOfAccounts.deactivated'),
          })
        : result.isActive
          ? t('chartOfAccounts.reactivatedMessage', { code: result.chartOfAccounts })
          : t('chartOfAccounts.deactivatedMessage', { code: result.chartOfAccounts }),
    };
  } catch (error) {
    return mapChartError(error);
  }
}

/** Create or change a Group CoA registry entry (OB13 amendment). */
export async function saveGroupChartOfAccountsAction(
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
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, { lockObject: 'GROUP_CHART', argument: readKey('groupChartOfAccounts') });
    }
    const result = await saveGroupChartOfAccounts({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      expectedVersion: Number.isFinite(rawVersion) ? rawVersion : Number.NaN,
      groupChartOfAccounts: readKey('groupChartOfAccounts'),
      name: read('name'),
      language: readKey('language'),
      reason: read('reason'),
    });

    revalidateChartRoutes();

    if (mode === 'CREATE') {
      return {
        ok: true,
        message: result.created
          ? t('chartOfAccounts.groupCreated', { code: result.groupChartOfAccounts })
          : t('chartOfAccounts.groupAlreadyExists', { code: result.groupChartOfAccounts }),
      };
    }

    return {
      ok: true,
      message: result.changed
        ? t('chartOfAccounts.groupChanged', { code: result.groupChartOfAccounts })
        : t('chartOfAccounts.groupUnchanged', { code: result.groupChartOfAccounts }),
    };
  } catch (error) {
    return mapChartError(error);
  }
}

/** Deactivate/reactivate a Group CoA registry entry. */
export async function setGroupChartOfAccountsActiveAction(
  _previous: ChartOfAccountsActionState,
  form: FormData,
): Promise<ChartOfAccountsActionState> {
  const session = await requireSession(ROUTE);
  const read = (key: string) => String(form.get(key) ?? '').trim();
  const rawVersion = Number(form.get('expectedVersion') ?? '0');

  try {
    await requireCapability(ACTIVITY, session);
    await assertChangeForSession(session, { lockObject: 'GROUP_CHART', argument: read('groupChartOfAccounts') });
    const result = await setGroupChartOfAccountsActive({
      client: session.user.client,
      changedBy: session.user.username,
      groupChartOfAccounts: read('groupChartOfAccounts').toUpperCase(),
      isActive: read('isActive') === 'true',
      expectedVersion: Number.isFinite(rawVersion) ? rawVersion : Number.NaN,
      reason: read('reason'),
    });

    revalidateChartRoutes();

    return {
      ok: true,
      message: result.isActive
        ? t('chartOfAccounts.groupReactivatedMessage', { code: result.groupChartOfAccounts })
        : t('chartOfAccounts.groupDeactivatedMessage', { code: result.groupChartOfAccounts }),
    };
  } catch (error) {
    return mapChartError(error);
  }
}
