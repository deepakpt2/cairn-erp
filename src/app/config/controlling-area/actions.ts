'use server';

/** Capability-protected OKKP Controlling Area definition action. */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ControllingAreaMaintenanceError,
  saveControllingArea,
} from '@/modules/foundation/controlling-area-maintenance';
import { t } from '@/platform/i18n';

const ACTIVITY = 'CFG.COST.CONTROLLINGAREA.DEFINE';
const ROUTE = '/config/controlling-area';

export interface ControllingAreaActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

/** Tenant and actor are session-derived; the browser cannot select another tenant or user. */
export async function saveControllingAreaAction(
  _previous: ControllingAreaActionState,
  form: FormData,
): Promise<ControllingAreaActionState> {
  const session = await requireSession(ROUTE);
  const read = (key: string) => String(form.get(key) ?? '').trim();
  const readKey = (key: string) => read(key).toUpperCase();
  const mode = String(form.get('mode') ?? '') as 'CREATE' | 'CHANGE';
  const rawVersion = Number(form.get('expectedVersion') ?? '0');

  try {
    await requireCapability(ACTIVITY, session);
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, { lockObject: 'CONTROLLING_AREA', argument: readKey('controllingArea') });
    }
    const result = await saveControllingArea({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      expectedVersion: Number.isFinite(rawVersion) ? rawVersion : Number.NaN,
      controllingArea: readKey('controllingArea'),
      name: read('name'),
      organizationName: read('organizationName'),
      companyCodeScope: String(form.get('companyCodeScope') ?? '') as 'SINGLE' | 'MULTIPLE',
      currency: readKey('currency'),
      fiscalYearVariant: readKey('fiscalYearVariant'),
    });

    revalidatePath(ROUTE);
    revalidatePath('/config');

    if (mode === 'CREATE') {
      return {
        ok: true,
        message: result.created
          ? t('controllingArea.created', { code: result.controllingArea })
          : t('controllingArea.alreadyExists', { code: result.controllingArea }),
      };
    }

    return {
      ok: true,
      message: result.changed
        ? t('controllingArea.changed', { code: result.controllingArea })
        : t('controllingArea.unchanged'),
    };
  } catch (error) {
    if (error instanceof ControllingAreaMaintenanceError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    if (error instanceof AuthzError) {
      return {
        ok: false,
        message: t('controllingArea.capabilityRequired', { capability: error.capability }),
        remedy: t('controllingArea.capabilityRemedy', { capability: error.capability }),
      };
    }
    throw error;
  }
}
