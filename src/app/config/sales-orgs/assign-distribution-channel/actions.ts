'use server';

/** Capability-protected OVXK Sales Organization ↔ Distribution Channel assignment. */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import {
  assignSalesOrgDistributionChannel,
  SalesOrgDistributionChannelAssignmentError,
  unassignSalesOrgDistributionChannel,
} from '@/modules/foundation/sales-org-distribution-channel-assignment';
import { t } from '@/platform/i18n';

const ACTIVITY = 'CFG.ORG.SALESORG.ASSIGN_DISTCHANNEL';
const ROUTE = '/config/sales-orgs/assign-distribution-channel';

export interface SalesOrgDistributionChannelAssignmentState {
  ok: boolean;
  message?: string;
  remedy?: string;
  salesOrg?: string;
  distributionChannel?: string;
}

function read(form: FormData, key: string) {
  return String(form.get(key) ?? '').trim().toUpperCase();
}

function failure(
  error: SalesOrgDistributionChannelAssignmentError | AuthzError,
  operation: 'assignment' | 'removal',
  salesOrg: string,
  distributionChannel: string,
): SalesOrgDistributionChannelAssignmentState {
  if (error instanceof AuthzError) {
    return {
      ok: false,
      message: t('salesOrgChannel.capabilityRequired', { capability: error.capability }),
      remedy: t('salesOrgChannel.capabilityRemedy', { capability: error.capability }),
      salesOrg,
      distributionChannel,
    };
  }

  return {
    ok: false,
    message: t(
      operation === 'assignment'
        ? 'salesOrgChannel.assignmentFailed'
        : 'salesOrgChannel.removalFailed',
      { detail: error.message },
    ),
    remedy: error.remedy,
    salesOrg,
    distributionChannel,
  };
}

/** Tenant and actor are never accepted from the request; both come from the verified session. */
export async function assignSalesOrgDistributionChannelAction(
  _previous: SalesOrgDistributionChannelAssignmentState,
  form: FormData,
): Promise<SalesOrgDistributionChannelAssignmentState> {
  const session = await requireSession(ROUTE);
  const salesOrg = read(form, 'salesOrg');
  const distributionChannel = read(form, 'distributionChannel');

  try {
    await requireCapability(ACTIVITY, session);
    const result = await assignSalesOrgDistributionChannel({
      client: session.user.client,
      changedBy: session.user.username,
      salesOrg,
      distributionChannel,
    });

    revalidatePath(ROUTE);
    revalidatePath('/config/sales-orgs');
    revalidatePath('/config/distribution-channels');
    revalidatePath('/config/sales-areas');
    revalidatePath('/config');
    return {
      ok: true,
      message: result.assigned
        ? t('salesOrgChannel.assigned', { salesOrg: result.salesOrg, distributionChannel: result.distributionChannel })
        : t('salesOrgChannel.alreadyAssigned', { salesOrg: result.salesOrg, distributionChannel: result.distributionChannel }),
      salesOrg: result.salesOrg,
      distributionChannel: result.distributionChannel,
    };
  } catch (error) {
    if (error instanceof SalesOrgDistributionChannelAssignmentError || error instanceof AuthzError) {
      return failure(error, 'assignment', salesOrg, distributionChannel);
    }
    throw error;
  }
}

/** Removes an unused pair; the backend retains its change-document history. */
export async function unassignSalesOrgDistributionChannelAction(
  _previous: SalesOrgDistributionChannelAssignmentState,
  form: FormData,
): Promise<SalesOrgDistributionChannelAssignmentState> {
  const session = await requireSession(ROUTE);
  const salesOrg = read(form, 'salesOrg');
  const distributionChannel = read(form, 'distributionChannel');

  try {
    await requireCapability(ACTIVITY, session);
    const result = await unassignSalesOrgDistributionChannel({
      client: session.user.client,
      changedBy: session.user.username,
      salesOrg,
      distributionChannel,
    });

    revalidatePath(ROUTE);
    revalidatePath('/config/sales-orgs');
    revalidatePath('/config/distribution-channels');
    revalidatePath('/config/sales-areas');
    revalidatePath('/config');
    return {
      ok: true,
      message: t('salesOrgChannel.removed', {
        salesOrg: result.salesOrg,
        distributionChannel: result.distributionChannel,
      }),
      salesOrg: result.salesOrg,
      distributionChannel: result.distributionChannel,
    };
  } catch (error) {
    if (error instanceof SalesOrgDistributionChannelAssignmentError || error instanceof AuthzError) {
      return failure(error, 'removal', salesOrg, distributionChannel);
    }
    throw error;
  }
}
