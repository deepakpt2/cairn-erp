'use server';
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  changeCustomerPartnerStatus, PartnerError, saveCustomerPartner,
} from '@/modules/sales/partners';

export interface CustomerPartnerActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  version?: number;
}

function read(form: FormData, key: string) {
  return String(form.get(key) ?? '').trim();
}

/**
 * Name who plays a partner function for a customer. The tenant is always session-derived, and the
 * capability is the one the workbench activity names: assigning a payer is what decides whose
 * receivable a sale raises.
 */
export async function saveCustomerPartnerAction(
  _previous: CustomerPartnerActionState,
  form: FormData,
): Promise<CustomerPartnerActionState> {
  const session = await requireSession('/foundation/partners');
  const partnerNumber = read(form, 'partnerNumber');
  try {
    await requireCapability('CFG.SALES.PARTNER.DEFINE', session);
    await assertChangeForSession(session, {
      lockObject: 'CUSTOMER_SALES_PARTNER', argument: `${partnerNumber}/${read(form, 'functionCode')}`,
    });
    const result = await saveCustomerPartner({
      client: session.user.client,
      changedBy: session.user.username,
      partnerNumber,
      functionCode: read(form, 'functionCode'),
      assignedPartnerNumber: read(form, 'assignedPartnerNumber'),
      expectedVersion: Number(read(form, 'expectedVersion')) || 0,
      // Maintained for the sales area the screen stands on, or for all of them: the row naming the
      // area is the one that answers, and the row naming none is what answers for every other area.
      ...(read(form, 'scope') === 'AREA' ? {
        salesOrg: read(form, 'areaOrg'),
        distributionChannel: read(form, 'areaChannel'),
        division: read(form, 'areaDivision'),
      } : {}),
    });
    revalidatePath('/foundation/partners');
    return { ok: true, message: 'saved', version: result.version };
  } catch (error) {
    if (error instanceof PartnerError || error instanceof AuthzError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}

/** Withdraw a partner function, or restore one. The row is never deleted: it is evidence. */
export async function changeCustomerPartnerStatusAction(input: {
  partnerNumber: string; functionCode: string; salesOrg: string;
  distributionChannel: string; division: string; isActive: boolean;
}, _form: FormData): Promise<CustomerPartnerActionState> {
  const session = await requireSession('/foundation/partners');
  try {
    await requireCapability('CFG.SALES.PARTNER.DEFINE', session);
    await assertChangeForSession(session, {
      lockObject: 'CUSTOMER_SALES_PARTNER', argument: `${input.partnerNumber}/${input.functionCode}`,
    });
    const result = await changeCustomerPartnerStatus({
      client: session.user.client, changedBy: session.user.username, ...input,
    });
    revalidatePath('/foundation/partners');
    return { ok: true, message: input.isActive ? 'restored' : 'withdrawn', version: result.version };
  } catch (error) {
    if (error instanceof PartnerError || error instanceof AuthzError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
