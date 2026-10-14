'use server';

/** Capability-protected SCR-022 Distribution Channel definition actions. */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import {
  deactivateDistributionChannel,
  DistributionDimensionMaintenanceError,
  saveDistributionChannelDefinition,
  type DistributionChannelMaintenanceInput,
} from '@/modules/foundation/distribution-channel-division-maintenance';
import { t } from '@/platform/i18n';

const ACTIVITY = 'CFG.ORG.DISTCHANNEL.DEFINE';
const ROUTE = '/config/distribution-channels';

export interface DistributionChannelActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  distributionChannel?: string;
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
export async function saveDistributionChannelAction(
  _previous: DistributionChannelActionState,
  form: FormData,
): Promise<DistributionChannelActionState> {
  const session = await requireSession(ROUTE);
  const code = read(form, 'distributionChannel');
  try {
    await requireCapability(ACTIVITY, session);
    const result = await saveDistributionChannelDefinition({
      client: session.user.client,
      changedBy: session.user.username,
      mode: read(form, 'mode') as DistributionChannelMaintenanceInput['mode'],
      distributionChannel: code,
      expectedVersion: expectedVersion(form),
      reason: read(form, 'reason'),
      values: { name: read(form, 'name') },
    });
    revalidateViews();
    const entry = t('distributionChannel.singular');
    const message = result.created
      ? t('orgDefinition.created', { entry, code: result.distributionChannel })
      : result.changed
        ? t('orgDefinition.changed', { entry, code: result.distributionChannel })
        : t('orgDefinition.unchanged', { code: result.distributionChannel });
    return {
      ok: true, message, distributionChannel: result.distributionChannel,
      version: result.version, changed: result.changed, isActive: result.isActive,
    };
  } catch (error) {
    if (error instanceof DistributionDimensionMaintenanceError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy, distributionChannel: code };
    }
    throw error;
  }
}

export async function deactivateDistributionChannelAction(
  _previous: DistributionChannelActionState,
  form: FormData,
): Promise<DistributionChannelActionState> {
  const session = await requireSession(ROUTE);
  const code = read(form, 'distributionChannel');
  try {
    await requireCapability(ACTIVITY, session);
    const result = await deactivateDistributionChannel({
      client: session.user.client,
      changedBy: session.user.username,
      distributionChannel: code,
      expectedVersion: expectedVersion(form),
      reason: read(form, 'reason'),
    });
    revalidateViews();
    const message = result.changed
      ? t('orgDefinition.deactivated', { entry: t('distributionChannel.singular'), code: result.distributionChannel })
      : t('orgDefinition.alreadyInactive', { entry: t('distributionChannel.singular'), code: result.distributionChannel });
    return {
      ok: true, message, distributionChannel: result.distributionChannel,
      version: result.version, changed: result.changed, isActive: result.isActive,
    };
  } catch (error) {
    if (error instanceof DistributionDimensionMaintenanceError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy, distributionChannel: code };
    }
    throw error;
  }
}
