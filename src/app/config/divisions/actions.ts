'use server';

/** Capability-protected SCR-022 Division definition actions. */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import {
  deactivateDivision,
  DistributionDimensionMaintenanceError,
  saveDivisionDefinition,
  type DivisionMaintenanceInput,
} from '@/modules/foundation/distribution-channel-division-maintenance';
import { t } from '@/platform/i18n';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';

const ACTIVITY = 'CFG.ORG.DIVISION.DEFINE';
const ROUTE = '/config/divisions';

export interface DivisionActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  division?: string;
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
function revalidateViews() {
  revalidatePath(ROUTE);
  revalidatePath('/config');
}

/** The tenant and actor are always taken from the verified session. */
export async function saveDivisionAction(
  _previous: DivisionActionState,
  form: FormData,
): Promise<DivisionActionState> {
  const session = await requireSession(ROUTE);
  const code = read(form, 'division');
  try {
    await requireCapability(ACTIVITY, session);
    if (read(form, 'mode') === 'CHANGE') {
      await assertChangeForSession(session, { lockObject: 'DIVISION', argument: code });
    }
    const result = await saveDivisionDefinition({
      client: session.user.client,
      changedBy: session.user.username,
      mode: read(form, 'mode') as DivisionMaintenanceInput['mode'],
      division: code,
      expectedVersion: expectedVersion(form),
      reason: read(form, 'reason'),
      values: { name: read(form, 'name') },
    });
    revalidateViews();
    const entry = t('division.singular');
    const message = result.created
      ? t('orgDefinition.created', { entry, code: result.division })
      : result.changed
        ? t('orgDefinition.changed', { entry, code: result.division })
        : t('orgDefinition.unchanged', { code: result.division });
    return {
      ok: true, message, division: result.division,
      version: result.version, changed: result.changed, isActive: result.isActive,
    };
  } catch (error) {
    if (error instanceof DistributionDimensionMaintenanceError || error instanceof AuthzError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy, division: code };
    }
    throw error;
  }
}

export async function deactivateDivisionAction(
  _previous: DivisionActionState,
  form: FormData,
): Promise<DivisionActionState> {
  const session = await requireSession(ROUTE);
  const code = read(form, 'division');
  try {
    await requireCapability(ACTIVITY, session);
    await assertChangeForSession(session, { lockObject: 'DIVISION', argument: code });
    const result = await deactivateDivision({
      client: session.user.client,
      changedBy: session.user.username,
      division: code,
      expectedVersion: expectedVersion(form),
      reason: read(form, 'reason'),
    });
    revalidateViews();
    const message = result.changed
      ? t('orgDefinition.deactivated', { entry: t('division.singular'), code: result.division })
      : t('orgDefinition.alreadyInactive', { entry: t('division.singular'), code: result.division });
    return {
      ok: true, message, division: result.division,
      version: result.version, changed: result.changed, isActive: result.isActive,
    };
  } catch (error) {
    if (error instanceof DistributionDimensionMaintenanceError || error instanceof AuthzError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy, division: code };
    }
    throw error;
  }
}
