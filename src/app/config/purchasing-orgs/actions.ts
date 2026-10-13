'use server';

/** Capability-protected SCR-017 Purchasing Organisation definition actions; assignments remain separate. */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import {
  deactivatePurchasingOrg,
  PurchasingOrgMaintenanceError,
  savePurchasingOrgDefinition,
  type PurchasingOrgMaintenanceMode,
} from '@/modules/foundation/purchasing-org-maintenance';
import { t } from '@/platform/i18n';

const ACTIVITY = 'CFG.PROC.PURORG.DEFINE';
const ROUTE = '/config/purchasing-orgs';

export interface PurchasingOrgMaintenanceActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  purchasingOrg?: string;
  version?: number;
  changed?: boolean;
  isActive?: boolean;
}

function read(form: FormData, key: string) {
  return String(form.get(key) ?? '').trim();
}

function expectedVersion(form: FormData) {
  const value = read(form, 'expectedVersion');
  return value === '' ? Number.NaN : Number(value);
}

function revalidatePurchasingOrgViews() {
  revalidatePath(ROUTE);
  revalidatePath('/config');
}

/** Tenant and actor are never accepted from the request; both come from the verified session. */
export async function savePurchasingOrgDefinitionAction(
  _previous: PurchasingOrgMaintenanceActionState,
  form: FormData,
): Promise<PurchasingOrgMaintenanceActionState> {
  // Keep anonymous redirects outside the catch so unauthenticated users go to sign-in.
  const session = await requireSession(ROUTE);
  const code = read(form, 'purchasingOrg');

  try {
    await requireCapability(ACTIVITY, session);
    const result = await savePurchasingOrgDefinition({
      client: session.user.client,
      changedBy: session.user.username,
      mode: read(form, 'mode') as PurchasingOrgMaintenanceMode,
      purchasingOrg: code,
      expectedVersion: expectedVersion(form),
      reason: read(form, 'reason'),
      values: {
        name: read(form, 'name'),
      },
    });

    revalidatePurchasingOrgViews();
    const message = result.created
      ? t('purchasingOrg.created', { code: result.purchasingOrg })
      : result.changed
        ? t('purchasingOrg.changed', { code: result.purchasingOrg })
        : t('purchasingOrg.unchanged', { code: result.purchasingOrg });

    return {
      ok: true,
      message,
      purchasingOrg: result.purchasingOrg,
      version: result.version,
      changed: result.changed,
      isActive: result.isActive,
    };
  } catch (error) {
    if (error instanceof PurchasingOrgMaintenanceError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy, purchasingOrg: code };
    }
    throw error;
  }
}

/** Deactivation is non-destructive and retains Company Code/Plant assignments and history. */
export async function deactivatePurchasingOrgAction(
  _previous: PurchasingOrgMaintenanceActionState,
  form: FormData,
): Promise<PurchasingOrgMaintenanceActionState> {
  const session = await requireSession(ROUTE);
  const code = read(form, 'purchasingOrg');

  try {
    await requireCapability(ACTIVITY, session);
    const result = await deactivatePurchasingOrg({
      client: session.user.client,
      changedBy: session.user.username,
      purchasingOrg: code,
      expectedVersion: expectedVersion(form),
      reason: read(form, 'reason'),
    });

    revalidatePurchasingOrgViews();
    return {
      ok: true,
      message: result.changed
        ? t('purchasingOrg.deactivated', { code: result.purchasingOrg })
        : t('purchasingOrg.alreadyInactive', { code: result.purchasingOrg }),
      purchasingOrg: result.purchasingOrg,
      version: result.version,
      changed: result.changed,
      isActive: result.isActive,
    };
  } catch (error) {
    if (error instanceof PurchasingOrgMaintenanceError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy, purchasingOrg: code };
    }
    throw error;
  }
}
