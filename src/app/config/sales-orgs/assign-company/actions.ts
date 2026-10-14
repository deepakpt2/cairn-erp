'use server';

/** Capability-protected SCR-021 initial Sales Organization -> Company Code assignment. */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import {
  assignSalesOrgCompanyCode,
  SalesOrgCompanyCodeAssignmentError,
} from '@/modules/foundation/sales-org-company-code-assignment';
import { t } from '@/platform/i18n';

const ACTIVITY = 'CFG.ORG.SALESORG.ASSIGN_COMPANY';
const ROUTE = '/config/sales-orgs/assign-company';

export interface SalesOrgCompanyCodeAssignmentState {
  ok: boolean;
  message?: string;
  remedy?: string;
  salesOrg?: string;
  companyCode?: string;
}

function read(form: FormData, key: string) {
  return String(form.get(key) ?? '').trim().toUpperCase();
}

/** Tenant and actor are never accepted from the request; both come from the verified session. */
export async function assignSalesOrgCompanyCodeAction(
  _previous: SalesOrgCompanyCodeAssignmentState,
  form: FormData,
): Promise<SalesOrgCompanyCodeAssignmentState> {
  const session = await requireSession(ROUTE);
  const salesOrgCode = read(form, 'salesOrg');
  const companyCodeValue = read(form, 'companyCode');

  try {
    await requireCapability(ACTIVITY, session);
    const result = await assignSalesOrgCompanyCode({
      client: session.user.client,
      changedBy: session.user.username,
      salesOrg: salesOrgCode,
      companyCode: companyCodeValue,
    });

    revalidatePath(ROUTE);
    revalidatePath('/config/sales-orgs');
    revalidatePath('/config');
    return {
      ok: true,
      message: result.reassigned
        ? t('salesOrg.companyReassigned', {
            salesOrg: result.salesOrg,
            companyCode: result.companyCode,
          })
        : result.assigned
          ? t('salesOrg.companyAssigned', {
              salesOrg: result.salesOrg,
              companyCode: result.companyCode,
            })
          : t('salesOrg.companyAlreadyAssigned', {
              salesOrg: result.salesOrg,
              companyCode: result.companyCode,
            }),
      salesOrg: result.salesOrg,
      companyCode: result.companyCode,
    };
  } catch (error) {
    if (error instanceof SalesOrgCompanyCodeAssignmentError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy, salesOrg: salesOrgCode };
    }
    throw error;
  }
}
