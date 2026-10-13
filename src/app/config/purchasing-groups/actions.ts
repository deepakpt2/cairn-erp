'use server';

/** Capability-protected SCR-019 Purchasing Group overview save action. */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import {
  PurchasingGroupMaintenanceError,
  savePurchasingGroupChanges,
  type PurchasingGroupChangeOutcome,
  type PurchasingGroupChangeSetInput,
} from '@/modules/foundation/purchasing-group-maintenance';
import { t } from '@/platform/i18n';

const ACTIVITY = 'CFG.PROC.PURGROUP.DEFINE';
const ROUTE = '/config/purchasing-groups';

export interface PurchasingGroupActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  outcomes?: PurchasingGroupChangeOutcome[];
}

function read(form: FormData, key: string) {
  return String(form.get(key) ?? '').trim();
}

function revalidatePurchasingGroupViews() {
  revalidatePath(ROUTE);
  revalidatePath('/config');
  // Consumers keep their existing screens; refresh their selectable master-data choices.
  revalidatePath('/foundation/partners');
  revalidatePath('/inventory/materials');
}

/** Tenant, actor and capability are derived from the verified session, not submitted fields. */
export async function savePurchasingGroupChangesAction(
  _previous: PurchasingGroupActionState,
  form: FormData,
): Promise<PurchasingGroupActionState> {
  const session = await requireSession(ROUTE);

  try {
    await requireCapability(ACTIVITY, session);
    let changes: unknown;
    try {
      changes = JSON.parse(read(form, 'changes'));
    } catch {
      throw new PurchasingGroupMaintenanceError(
        'Purchasing Group changes could not be read.',
        'Reload the overview and enter the changes again.',
      );
    }

    const result = await savePurchasingGroupChanges({
      client: session.user.client,
      changedBy: session.user.username,
      reason: read(form, 'reason'),
      changes: changes as PurchasingGroupChangeSetInput['changes'],
    });

    revalidatePurchasingGroupViews();
    return {
      ok: true,
      message:
        result.changedCount === 0
          ? t('purchasingGroup.unchanged')
          : result.changedCount === 1
            ? t('purchasingGroup.savedOne')
            : t('purchasingGroup.savedMany', { count: result.changedCount }),
      outcomes: result.outcomes,
    };
  } catch (error) {
    if (error instanceof PurchasingGroupMaintenanceError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
