'use server';

/** Capability-protected Company Code definition and CoA assignment actions. */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import {
  CompanyCodeDefinitionError,
  defineCompanyCode,
} from '@/modules/foundation/company-code-definition';
import {
  assignCompanyCodeCoa,
  CompanyCodeCoaAssignmentError,
} from '@/modules/foundation/company-code-coa-assignment';
import { t } from '@/platform/i18n';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';

export interface CompanyCodeState {
  ok: boolean;
  message?: string;
  remedy?: string;
  companyCode?: string;
}

export async function defineCompanyCodeAction(
  _previous: CompanyCodeState,
  formData: FormData,
): Promise<CompanyCodeState> {
  // Keep redirects outside the catch so an anonymous request is sent to sign-in.
  const session = await requireSession('/config/company-codes');
  const read = (key: string) => String(formData.get(key) ?? '').trim();

  try {
    await requireCapability('CFG.ORG.COMPANYCODE.DEFINE', session);
    const result = await defineCompanyCode({
      client: session.user.client,
      changedBy: session.user.username,
      companyCode: read('companyCode'),
      name: read('name'),
      country: read('country'),
      currency: read('currency'),
      city: read('city'),
      taxRegistrationNumber: read('taxRegistrationNumber'),
    });

    revalidatePath('/config/company-codes');
    revalidatePath('/config');
    revalidatePath('/config/posting-periods');
    return {
      ok: true,
      message: t('cc.created', { code: result.companyCode }),
      companyCode: result.companyCode,
    };
  } catch (error) {
    if (error instanceof CompanyCodeDefinitionError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}

export interface CompanyCodeCoaAssignmentState {
  ok: boolean;
  message?: string;
  remedy?: string;
  companyCode?: string;
  chartOfAccounts?: string;
}

/** Initial SCR-013 assignment only; no user-supplied tenant or actor values are accepted. */
export async function assignCompanyCodeCoaAction(
  _previous: CompanyCodeCoaAssignmentState,
  formData: FormData,
): Promise<CompanyCodeCoaAssignmentState> {
  const session = await requireSession('/config/company-codes');
  const read = (key: string) => String(formData.get(key) ?? '').trim();

  try {
    await requireCapability('CFG.ORG.COMPANYCODE.ASSIGN_COA', session);
    await assertChangeForSession(session, { lockObject: 'COMPANY_CODE', argument: read('companyCode') });
    const result = await assignCompanyCodeCoa({
      client: session.user.client,
      changedBy: session.user.username,
      companyCode: read('companyCode'),
      chartOfAccounts: read('chartOfAccounts'),
    });

    revalidatePath('/config/company-codes');
    revalidatePath('/config');
    revalidatePath('/config/posting-periods');
    revalidatePath('/finance/journal/new');
    return {
      ok: true,
      message: result.assigned
        ? t('cc.coaAssigned', {
            code: result.companyCode,
            chart: result.chartOfAccounts,
          })
        : t('cc.coaAlreadyAssigned', {
            code: result.companyCode,
            chart: result.chartOfAccounts,
          }),
      companyCode: result.companyCode,
      chartOfAccounts: result.chartOfAccounts,
    };
  } catch (error) {
    if (error instanceof CompanyCodeCoaAssignmentError || error instanceof AuthzError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
