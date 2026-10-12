'use server';

/** Capability-protected Plant definition create/change actions; no assignment or UI behavior. */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import {
  PlantMaintenanceError,
  savePlantDefinition,
  type PlantDefinitionMode,
} from '@/modules/foundation/plant-maintenance';
import { t } from '@/platform/i18n';

const ACTIVITY = 'CFG.ORG.PLANT.DEFINE';
const ROUTE = '/config/plants';

export interface PlantMaintenanceActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  plant?: string;
  version?: number;
  changed?: boolean;
}

function read(form: FormData, key: string) {
  return String(form.get(key) ?? '').trim();
}

function expectedVersion(form: FormData) {
  const value = read(form, 'expectedVersion');
  return value === '' ? Number.NaN : Number(value);
}

/**
 * Supports explicit true/false form values and the hidden-false + checked-checkbox
 * pattern. An omitted flag is left for the service's true default.
 */
function readSiteFlag(form: FormData, key: string): boolean | undefined {
  const values = form.getAll(key).map((value) => String(value).trim().toLowerCase());
  if (values.length === 0 || values.every((value) => value === '')) return undefined;

  const trueValues = new Set(['true', 'on', '1']);
  const falseValues = new Set(['false', 'off', '0']);
  if (values.some((value) => !trueValues.has(value) && !falseValues.has(value))) {
    return Number.NaN as unknown as boolean;
  }
  if (values.some((value) => trueValues.has(value))) return true;
  return false;
}

/** Tenant and actor are never accepted from the request; both come from the verified session. */
export async function savePlantDefinitionAction(
  _previous: PlantMaintenanceActionState,
  form: FormData,
): Promise<PlantMaintenanceActionState> {
  const session = await requireSession(ROUTE);
  const plantCode = read(form, 'plant');

  try {
    await requireCapability(ACTIVITY, session);
    const result = await savePlantDefinition({
      client: session.user.client,
      changedBy: session.user.username,
      mode: read(form, 'mode') as PlantDefinitionMode,
      plant: plantCode,
      expectedVersion: expectedVersion(form),
      reason: read(form, 'reason'),
      values: {
        name: read(form, 'name'),
        country: read(form, 'country'),
        street: read(form, 'street'),
        houseNumber: read(form, 'houseNumber'),
        postalCode: read(form, 'postalCode'),
        city: read(form, 'city'),
        region: read(form, 'region'),
        factoryCalendar: read(form, 'factoryCalendar'),
        language: read(form, 'language'),
        isProductionSite: readSiteFlag(form, 'isProductionSite'),
        isStorageSite: readSiteFlag(form, 'isStorageSite'),
      },
    });

    revalidatePath(ROUTE);
    revalidatePath('/config');
    const message = result.created
      ? t('plant.created', { code: result.plant })
      : result.changed
        ? t('plant.changed', { code: result.plant })
        : t('plant.unchanged', { code: result.plant });

    return {
      ok: true,
      message,
      plant: result.plant,
      version: result.version,
      changed: result.changed,
    };
  } catch (error) {
    if (error instanceof PlantMaintenanceError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy, plant: plantCode };
    }
    throw error;
  }
}
