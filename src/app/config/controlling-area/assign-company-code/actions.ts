'use server';

/** Capability-protected OX19 assignment and unassignment actions. */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import {
  assignCompanyCodeToControllingArea,
  ControllingAreaCompanyAssignmentError,
  unassignCompanyCodeFromControllingArea,
} from '@/modules/foundation/controlling-area-company-assignment';
import { t } from '@/platform/i18n';

const CONTROLLING_AREA_DEFINE = 'CFG.COST.CONTROLLINGAREA.DEFINE';
const COMPANY_CODE_DEFINE = 'CFG.ORG.COMPANYCODE.DEFINE';
const ROUTE = '/config/controlling-area/assign-company-code';

export interface ControllingAreaCompanyAssignmentActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  controllingArea?: string;
  companyCode?: string;
}

function read(form: FormData, key: string) {
  return String(form.get(key) ?? '').trim();
}

function readControllingArea(form: FormData) {
  return read(form, 'controllingArea').toUpperCase();
}

function failure(
  error: ControllingAreaCompanyAssignmentError | AuthzError,
  controllingArea: string,
  companyCode: string,
): ControllingAreaCompanyAssignmentActionState {
  return {
    ok: false,
    message: error.message,
    remedy: error.remedy,
    controllingArea,
    companyCode,
  };
}

/** Tenant and actor come only from the verified session; both owner-required authorities are checked. */
export async function assignControllingAreaCompanyAction(
  _previous: ControllingAreaCompanyAssignmentActionState,
  form: FormData,
): Promise<ControllingAreaCompanyAssignmentActionState> {
  const session = await requireSession(ROUTE);
  const controllingArea = readControllingArea(form);
  // OX19 preserves the Company Code master's exact key case.
  const companyCode = read(form, 'companyCode');

  try {
    await requireCapability(CONTROLLING_AREA_DEFINE, session);
    await requireCapability(COMPANY_CODE_DEFINE, session);
    const result = await assignCompanyCodeToControllingArea({
      client: session.user.client,
      changedBy: session.user.username,
      controllingArea,
      companyCode,
    });

    revalidateOxxPaths();
    return {
      ok: true,
      message: result.assigned
        ? t('controllingArea.assignmentAdded', { controllingArea: result.controllingArea, companyCode: result.companyCode })
        : t('controllingArea.assignmentDuplicate', { controllingArea: result.controllingArea, companyCode: result.companyCode }),
      controllingArea: result.controllingArea,
      companyCode: result.companyCode,
    };
  } catch (error) {
    if (error instanceof ControllingAreaCompanyAssignmentError || error instanceof AuthzError) {
      return failure(error, controllingArea, companyCode);
    }
    throw error;
  }
}

/** Removes the current link only; the backend retains the append-only change history. */
export async function unassignControllingAreaCompanyAction(
  _previous: ControllingAreaCompanyAssignmentActionState,
  form: FormData,
): Promise<ControllingAreaCompanyAssignmentActionState> {
  const session = await requireSession(ROUTE);
  const controllingArea = readControllingArea(form);
  const companyCode = read(form, 'companyCode');

  try {
    await requireCapability(CONTROLLING_AREA_DEFINE, session);
    await requireCapability(COMPANY_CODE_DEFINE, session);
    const result = await unassignCompanyCodeFromControllingArea({
      client: session.user.client,
      changedBy: session.user.username,
      controllingArea,
      companyCode,
    });

    revalidateOxxPaths();
    return {
      ok: true,
      message: t('controllingArea.assignmentRemoved', {
        controllingArea: result.controllingArea,
        companyCode: result.companyCode,
      }),
      controllingArea: result.controllingArea,
      companyCode: result.companyCode,
    };
  } catch (error) {
    if (error instanceof ControllingAreaCompanyAssignmentError || error instanceof AuthzError) {
      return failure(error, controllingArea, companyCode);
    }
    throw error;
  }
}

function revalidateOxxPaths() {
  revalidatePath(ROUTE);
  revalidatePath('/config/controlling-area');
  revalidatePath('/config');
  revalidatePath('/finance/journal/new');
}
