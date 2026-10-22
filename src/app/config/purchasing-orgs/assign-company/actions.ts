'use server';

/** Capability-protected SCR-018 initial Purchasing Organisation -> Company Code assignment. */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  assignPurchasingOrgCompanyCode,
  PurchasingOrgCompanyCodeAssignmentError,
} from '@/modules/foundation/purchasing-org-company-code-assignment';
import { t } from '@/platform/i18n';

const ACTIVITY = 'CFG.PROC.PURORG.ASSIGN_COMPANY';
const ROUTE = '/config/purchasing-orgs/assign-company';

export interface PurchasingOrgCompanyCodeAssignmentState {
  ok: boolean;
  message?: string;
  remedy?: string;
  purchasingOrg?: string;
  companyCode?: string;
}

function read(form: FormData, key: string) {
  return String(form.get(key) ?? '').trim();
}

/** Tenant and actor are never accepted from the request; both come from the verified session. */
export async function assignPurchasingOrgCompanyCodeAction(
  _previous: PurchasingOrgCompanyCodeAssignmentState,
  form: FormData,
): Promise<PurchasingOrgCompanyCodeAssignmentState> {
  const session = await requireSession(ROUTE);
  const purchasingOrgCode = read(form, 'purchasingOrg');
  const companyCode = read(form, 'companyCode');

  try {
    await requireCapability(ACTIVITY, session);
    await assertChangeForSession(session, { lockObject: 'PURCHASING_ORG_COMPANY', argument: purchasingOrgCode });
    const result = await assignPurchasingOrgCompanyCode({
      client: session.user.client,
      changedBy: session.user.username,
      purchasingOrg: purchasingOrgCode,
      companyCode,
    });

    revalidatePath(ROUTE);
    revalidatePath('/config/purchasing-orgs');
    revalidatePath('/config');
    return {
      ok: true,
      message: result.assigned
        ? t('purchasingOrg.companyAssigned', {
            org: result.purchasingOrg,
            company: result.companyCode,
          })
        : t('purchasingOrg.companyAlreadyAssigned', {
            org: result.purchasingOrg,
            company: result.companyCode,
          }),
      purchasingOrg: result.purchasingOrg,
      companyCode: result.companyCode,
    };
  } catch (error) {
    if (error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy, purchasingOrg: purchasingOrgCode };
    }
    if (error instanceof PurchasingOrgCompanyCodeAssignmentError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy, purchasingOrg: purchasingOrgCode };
    }
    throw error;
  }
}
