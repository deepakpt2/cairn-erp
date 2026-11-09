'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  BILLING_SPLIT_ROUTE,
  SPLIT_DEFINE_CAPABILITY,
  setSplitCriterionStatus,
} from '@/modules/sales/billing';

export interface BillingSplitActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = BILLING_SPLIT_ROUTE;

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function denied(): BillingSplitActionState {
  return {
    ok: false,
    message: `You do not hold the authority ${SPLIT_DEFINE_CAPABILITY}.`,
    remedy: 'Ask an administrator for an exact-code role assignment; wildcard role patterns do not grant this authority.',
  };
}

/**
 * Turn a criterion on or off.
 *
 * The gate precedes the call, as it does on every configuration screen: how a customer is billed is a
 * decision a company commits to, not an act on a document. The run itself is guarded by
 * SALES.BILLING.CREATE, because the run raises and posts documents — what is decided here is only how
 * many it raises.
 */
export async function setSplitCriterionAction(
  _previous: BillingSplitActionState,
  form: FormData,
): Promise<BillingSplitActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SPLIT_DEFINE_CAPABILITY)) return denied();

  const criterion = text(form, 'criterion');
  const isActive = text(form, 'isActive') === 'yes';
  try {
    await setSplitCriterionStatus({
      client: session.user.client,
      criterion,
      isActive,
      changedBy: session.user.username,
    });
    revalidatePath(ROUTE);
    revalidatePath('/sales/billing');
    return {
      ok: true,
      message: isActive
        ? 'The run will split by it. Nothing that stands is changed: what was billed as one document stays one document.'
        : 'Withdrawn. It is kept rather than deleted, so a reader can still see why a month came out as it did.',
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'The criterion could not be saved.',
    };
  }
}
