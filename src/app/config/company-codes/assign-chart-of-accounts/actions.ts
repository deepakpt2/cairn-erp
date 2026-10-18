'use server';

/**
 * Capability-protected dedicated CoA assignment action.
 *
 * The assignment's own authority only (CFG.ORG.COMPANYCODE.ASSIGN_COA):
 * SCR-013 separated it from Company Code definition, and this screen
 * keeps that separation. The tenant and actor come from the session.
 * A reason is mandatory on the write and stands on the change document.
 */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import {
  assignCompanyCodeCoa,
  CompanyCodeCoaAssignmentError,
} from '@/modules/foundation/company-code-coa-assignment';
import { t } from '@/platform/i18n';

const ROUTE = '/config/company-codes/assign-chart-of-accounts';
export const COMPANY_CODE_ASSIGN_COA = 'CFG.ORG.COMPANYCODE.ASSIGN_COA';

export interface CoaAssignmentActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

export async function assignCoaAction(
  _previous: CoaAssignmentActionState,
  formData: FormData,
): Promise<CoaAssignmentActionState> {
  const session = await requireSession(ROUTE);
  const read = (key: string) => String(formData.get(key) ?? '').trim();

  try {
    await requireCapability(COMPANY_CODE_ASSIGN_COA, session);
    const reason = read('reason');
    if (!reason) {
      return {
        ok: false,
        message: t('coaAssign.reasonRequired'),
        remedy: t('coaAssign.reasonRequiredRemedy'),
      };
    }
    const result = await assignCompanyCodeCoa({
      client: session.user.client,
      changedBy: session.user.username,
      companyCode: read('companyCode'),
      chartOfAccounts: read('chartOfAccounts'),
      reason,
    });

    revalidatePath(ROUTE);
    revalidatePath('/config/company-codes');
    revalidatePath('/config');
    revalidatePath('/config/posting-periods');
    revalidatePath('/finance/journal/new');
    return {
      ok: true,
      message: result.assigned
        ? t('cc.coaAssigned', { code: result.companyCode, chart: result.chartOfAccounts })
        : t('cc.coaAlreadyAssigned', { code: result.companyCode, chart: result.chartOfAccounts }),
    };
  } catch (error) {
    if (error instanceof CompanyCodeCoaAssignmentError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
