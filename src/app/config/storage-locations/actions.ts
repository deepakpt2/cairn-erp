'use server';

/** Capability-protected Storage Location maintenance actions for the SCR-016 UI. */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import {
  deactivateStorageLocation,
  saveStorageLocation,
  StorageLocationMaintenanceError,
  type StorageLocationMaintenanceMode,
} from '@/modules/foundation/storage-location-maintenance';
import { t } from '@/platform/i18n';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';

const ACTIVITY = 'CFG.ORG.STORAGELOC.DEFINE';
const ROUTE = '/config/storage-locations';

export interface StorageLocationActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  plant?: string;
  storageLocation?: string;
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

/** Supports checkbox and hidden-false + checked-checkbox form patterns. */
function readNegativeStockFlag(form: FormData, key: string): boolean {
  const values = form.getAll(key).map((value) => String(value).trim().toLowerCase());
  if (values.length === 0 || values.every((value) => value === '')) return false;

  const trueValues = new Set(['true', 'on', '1']);
  const falseValues = new Set(['false', 'off', '0']);
  if (values.some((value) => !trueValues.has(value) && !falseValues.has(value))) {
    return Number.NaN as unknown as boolean;
  }
  if (values.some((value) => trueValues.has(value))) return true;
  return false;
}

function revalidateStorageLocationViews() {
  revalidatePath(ROUTE);
  revalidatePath('/config/plants');
  revalidatePath('/config');
}

/** Tenant and actor are never accepted from the request; both come from the verified session. */
export async function saveStorageLocationAction(
  _previous: StorageLocationActionState,
  form: FormData,
): Promise<StorageLocationActionState> {
  const session = await requireSession(ROUTE);
  const plantCode = read(form, 'plant');
  const storageLocationCode = read(form, 'storageLocation');

  try {
    await requireCapability(ACTIVITY, session);
    if (read(form, 'mode') === 'CHANGE') {
      await assertChangeForSession(session, { lockObject: 'STORAGE_LOCATION', argument: `${plantCode}/${storageLocationCode}` });
    }
    const result = await saveStorageLocation({
      client: session.user.client,
      changedBy: session.user.username,
      mode: read(form, 'mode') as StorageLocationMaintenanceMode,
      plant: plantCode,
      storageLocation: storageLocationCode,
      expectedVersion: expectedVersion(form),
      reason: read(form, 'reason'),
      values: {
        name: read(form, 'name'),
        allowNegativeStock: readNegativeStockFlag(form, 'allowNegativeStock'),
      },
    });

    revalidateStorageLocationViews();
    const message = result.created
      ? t('storageLocation.created', { plant: result.plant, code: result.storageLocation })
      : result.changed
        ? t('storageLocation.changed', { plant: result.plant, code: result.storageLocation })
        : t('storageLocation.unchanged', { plant: result.plant, code: result.storageLocation });

    return {
      ok: true,
      message,
      plant: result.plant,
      storageLocation: result.storageLocation,
      version: result.version,
      changed: result.changed,
      isActive: result.isActive,
    };
  } catch (error) {
    if (error instanceof StorageLocationMaintenanceError || error instanceof AuthzError || error instanceof EnqueueError) {
      return {
        ok: false,
        message: error.message,
        remedy: error.remedy,
        plant: plantCode,
        storageLocation: storageLocationCode,
      };
    }
    throw error;
  }
}

/** Deactivation retains the Storage Location row and its field-level history. */
export async function deactivateStorageLocationAction(
  _previous: StorageLocationActionState,
  form: FormData,
): Promise<StorageLocationActionState> {
  const session = await requireSession(ROUTE);
  const plantCode = read(form, 'plant');
  const storageLocationCode = read(form, 'storageLocation');

  try {
    await requireCapability(ACTIVITY, session);
    await assertChangeForSession(session, { lockObject: 'STORAGE_LOCATION', argument: `${plantCode}/${storageLocationCode}` });
    const result = await deactivateStorageLocation({
      client: session.user.client,
      changedBy: session.user.username,
      plant: plantCode,
      storageLocation: storageLocationCode,
      expectedVersion: expectedVersion(form),
      reason: read(form, 'reason'),
    });

    revalidateStorageLocationViews();
    return {
      ok: true,
      message: result.changed
        ? t('storageLocation.deactivated', { plant: result.plant, code: result.storageLocation })
        : t('storageLocation.alreadyInactive', { plant: result.plant, code: result.storageLocation }),
      plant: result.plant,
      storageLocation: result.storageLocation,
      version: result.version,
      changed: result.changed,
      isActive: result.isActive,
    };
  } catch (error) {
    if (error instanceof StorageLocationMaintenanceError || error instanceof AuthzError || error instanceof EnqueueError) {
      return {
        ok: false,
        message: error.message,
        remedy: error.remedy,
        plant: plantCode,
        storageLocation: storageLocationCode,
      };
    }
    throw error;
  }
}
