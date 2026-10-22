'use server';

/** Capability-protected OVXA Sales Organization ↔ Division assignment actions. */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  assignSalesOrgDivision,
  SalesOrgDivisionAssignmentError,
  unassignSalesOrgDivision,
} from '@/modules/foundation/sales-org-division-assignment';
import { t } from '@/platform/i18n';

const ACTIVITY = 'CFG.ORG.SALESORG.ASSIGN_DIVISION';
const ROUTE = '/config/sales-orgs/assign-division';

export interface SalesOrgDivisionAssignmentState {
  ok: boolean;
  message?: string;
  remedy?: string;
  salesOrg?: string;
  division?: string;
}

function read(form: FormData, key: string) {
  return String(form.get(key) ?? '').trim().toUpperCase();
}

function failure(
  error: SalesOrgDivisionAssignmentError | AuthzError,
  operation: 'assignment' | 'removal',
  salesOrg: string,
  division: string,
): SalesOrgDivisionAssignmentState {
  if (error instanceof AuthzError) {
    return {
      ok: false,
      message: t('salesOrgDivision.capabilityRequired', { capability: error.capability }),
      remedy: t('salesOrgDivision.capabilityRemedy', { capability: error.capability }),
      salesOrg,
      division,
    };
  }

  return {
    ok: false,
    message: t(
      operation === 'assignment'
        ? 'salesOrgDivision.assignmentFailed'
        : 'salesOrgDivision.removalFailed',
      { detail: error.message },
    ),
    remedy: error.remedy,
    salesOrg,
    division,
  };
}

/** Tenant and actor are never accepted from the request; both come from the verified session. */
export async function assignSalesOrgDivisionAction(
  _previous: SalesOrgDivisionAssignmentState,
  form: FormData,
): Promise<SalesOrgDivisionAssignmentState> {
  const session = await requireSession(ROUTE);
  const salesOrg = read(form, 'salesOrg');
  const division = read(form, 'division');

  try {
    await requireCapability(ACTIVITY, session);
    const result = await assignSalesOrgDivision({
      client: session.user.client,
      changedBy: session.user.username,
      salesOrg,
      division,
    });

    revalidatePath(ROUTE);
    revalidatePath('/config/sales-orgs');
    revalidatePath('/config/divisions');
    revalidatePath('/config/sales-areas');
    revalidatePath('/config');
    return {
      ok: true,
      message: result.assigned
        ? t('salesOrgDivision.assigned', { salesOrg: result.salesOrg, division: result.division })
        : t('salesOrgDivision.alreadyAssigned', { salesOrg: result.salesOrg, division: result.division }),
      salesOrg: result.salesOrg,
      division: result.division,
    };
  } catch (error) {
    if (error instanceof SalesOrgDivisionAssignmentError || error instanceof AuthzError) {
      return failure(error, 'assignment', salesOrg, division);
    }
    throw error;
  }
}

/** Removes an unused pair; the backend retains its change-document history. */
export async function unassignSalesOrgDivisionAction(
  _previous: SalesOrgDivisionAssignmentState,
  form: FormData,
): Promise<SalesOrgDivisionAssignmentState> {
  const session = await requireSession(ROUTE);
  const salesOrg = read(form, 'salesOrg');
  const division = read(form, 'division');

  try {
    await requireCapability(ACTIVITY, session);
    await assertChangeForSession(session, {
      lockObject: 'SALES_ORG_DIVISION',
      argument: `${salesOrg}/${division}`,
    });
    const result = await unassignSalesOrgDivision({
      client: session.user.client,
      changedBy: session.user.username,
      salesOrg,
      division,
    });

    revalidatePath(ROUTE);
    revalidatePath('/config/sales-orgs');
    revalidatePath('/config/divisions');
    revalidatePath('/config/sales-areas');
    revalidatePath('/config');
    return {
      ok: true,
      message: t('salesOrgDivision.removed', { salesOrg: result.salesOrg, division: result.division }),
      salesOrg: result.salesOrg,
      division: result.division,
    };
  } catch (error) {
    if (error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy, salesOrg, division };
    }
    if (error instanceof SalesOrgDivisionAssignmentError || error instanceof AuthzError) {
      return failure(error, 'removal', salesOrg, division);
    }
    throw error;
  }
}
