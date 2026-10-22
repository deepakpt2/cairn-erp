'use server';

/** Capability-protected OVXG Sales Area maintenance actions. */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  deactivateSalesArea,
  reactivateSalesArea,
  SalesAreaMaintenanceError,
  salesAreaF4Choices,
  saveSalesArea,
} from '@/modules/foundation/sales-area-maintenance';
import { t } from '@/platform/i18n';

const ACTIVITY = 'CFG.ORG.SALESAREA.DEFINE';
const ROUTE = '/config/sales-areas';

export interface SalesAreaActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

export interface SalesAreaValueHelpState {
  ok: boolean;
  message?: string;
  remedy?: string;
  choices?: Awaited<ReturnType<typeof salesAreaF4Choices>>;
}

function readCode(form: FormData, key: string) {
  return String(form.get(key) ?? '').trim().toUpperCase();
}

function salesAreaArgument(form: FormData) {
  return [readCode(form, 'salesOrg'), readCode(form, 'distributionChannel'), readCode(form, 'division')].join('/');
}

function expectedVersion(form: FormData) {
  const value = Number(form.get('expectedVersion') ?? '0');
  return Number.isFinite(value) ? value : Number.NaN;
}

function failure(error: SalesAreaMaintenanceError | AuthzError, fallback: string): SalesAreaActionState {
  if (error instanceof AuthzError) {
    return {
      ok: false,
      message: t('salesArea.capabilityRequired', { capability: error.capability }),
      remedy: t('salesArea.capabilityRemedy', { capability: error.capability }),
    };
  }
  return {
    ok: false,
    message: t(fallback, { detail: error.message }),
    remedy: error.remedy,
  };
}

/** Tenant and actor are always taken from the verified session, never from the submitted form. */
export async function saveSalesAreaAction(
  _previous: SalesAreaActionState,
  form: FormData,
): Promise<SalesAreaActionState> {
  const session = await requireSession(ROUTE);
  const mode = String(form.get('mode') ?? '') as 'CREATE' | 'CHANGE';

  try {
    await requireCapability(ACTIVITY, session);
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, { lockObject: 'SALES_AREA', argument: salesAreaArgument(form) });
    }
    const result = await saveSalesArea({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      salesOrg: readCode(form, 'salesOrg'),
      distributionChannel: readCode(form, 'distributionChannel'),
      division: readCode(form, 'division'),
      name: String(form.get('name') ?? '').trim(),
      expectedVersion: expectedVersion(form),
    });
    revalidatePath(ROUTE);
    revalidatePath('/config');
    revalidatePath('/foundation/partners');
    if (mode === 'CREATE') {
      return {
        ok: true,
        message: result.created
          ? t('salesArea.created', { key: `${result.salesOrg}/${result.distributionChannel}/${result.division}` })
          : t('salesArea.alreadyExists', { key: `${result.salesOrg}/${result.distributionChannel}/${result.division}` }),
      };
    }
    return {
      ok: true,
      message: result.changed ? t('salesArea.nameChanged') : t('salesArea.unchanged'),
    };
  } catch (error) {
    if (error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    if (error instanceof SalesAreaMaintenanceError || error instanceof AuthzError) {
      return failure(error, 'salesArea.saveFailed');
    }
    throw error;
  }
}

export async function deactivateSalesAreaAction(
  _previous: SalesAreaActionState,
  form: FormData,
): Promise<SalesAreaActionState> {
  const session = await requireSession(ROUTE);
  try {
    await requireCapability(ACTIVITY, session);
    await assertChangeForSession(session, { lockObject: 'SALES_AREA', argument: salesAreaArgument(form) });
    const result = await deactivateSalesArea({
      client: session.user.client,
      changedBy: session.user.username,
      salesOrg: readCode(form, 'salesOrg'),
      distributionChannel: readCode(form, 'distributionChannel'),
      division: readCode(form, 'division'),
      expectedVersion: expectedVersion(form),
    });
    revalidatePath(ROUTE);
    revalidatePath('/config');
    revalidatePath('/foundation/partners');
    return { ok: true, message: result.changed ? t('salesArea.deactivated') : t('salesArea.alreadyInactive') };
  } catch (error) {
    if (error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    if (error instanceof SalesAreaMaintenanceError || error instanceof AuthzError) {
      return failure(error, 'salesArea.deactivateFailed');
    }
    throw error;
  }
}

export async function reactivateSalesAreaAction(
  _previous: SalesAreaActionState,
  form: FormData,
): Promise<SalesAreaActionState> {
  const session = await requireSession(ROUTE);
  try {
    await requireCapability(ACTIVITY, session);
    await assertChangeForSession(session, { lockObject: 'SALES_AREA', argument: salesAreaArgument(form) });
    const result = await reactivateSalesArea({
      client: session.user.client,
      changedBy: session.user.username,
      salesOrg: readCode(form, 'salesOrg'),
      distributionChannel: readCode(form, 'distributionChannel'),
      division: readCode(form, 'division'),
      expectedVersion: expectedVersion(form),
    });
    revalidatePath(ROUTE);
    revalidatePath('/config');
    revalidatePath('/foundation/partners');
    return { ok: true, message: result.changed ? t('salesArea.reactivated') : t('salesArea.alreadyActive') };
  } catch (error) {
    if (error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    if (error instanceof SalesAreaMaintenanceError || error instanceof AuthzError) {
      return failure(error, 'salesArea.reactivateFailed');
    }
    throw error;
  }
}

/** Refreshes dependent value-help lists for the authenticated tenant and selected Sales Organization. */
export async function salesAreaValueHelpAction(salesOrg: string): Promise<SalesAreaValueHelpState> {
  const session = await requireSession(ROUTE);
  try {
    await requireCapability(ACTIVITY, session);
    const choices = await salesAreaF4Choices(
      session.user.client,
      String(salesOrg ?? '').trim().toUpperCase(),
      session.user.logonLanguage ?? 'E',
    );
    return { ok: true, choices };
  } catch (error) {
    if (error instanceof SalesAreaMaintenanceError || error instanceof AuthzError) {
      const state = failure(error, 'salesArea.lookupFailed');
      return { ...state, choices: undefined };
    }
    throw error;
  }
}
