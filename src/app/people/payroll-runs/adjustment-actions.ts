'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { PAYROLL_RESULT_ROUTE, PAYROLL_RUN_ROUTE, PayrollRunError } from '@/modules/people/payroll-run';
import { PayrollStructureError } from '@/modules/people/payroll-structure';
import {
  ADJUSTMENT_APPROVE_CAPABILITY,
  ADJUSTMENT_ENTER_CAPABILITY,
  cancelAdjustment,
  decideAdjustment,
  enterAdjustment,
} from '@/modules/people/payroll-components';

export interface AdjustmentActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  requestKey?: string;
}

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

async function guard(capability: string): Promise<{ client: string; actor: string; access: { authorization: { userId: string; sessionId: string } } } | AdjustmentActionState> {
  const session = await requireSession(PAYROLL_RUN_ROUTE);
  if (!can(session, capability)) {
    return { ok: false, message: `You do not hold ${capability}.`, remedy: `Ask for ${capability}.` };
  }
  return {
    client: session.user.client,
    actor: session.user.username,
    // The service judges the session itself: capability, company, plant and employee reach.
    access: { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } },
  };
}

function refusal(error: unknown): AdjustmentActionState {
  if (error instanceof PayrollRunError || error instanceof PayrollStructureError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

function refresh(): void {
  revalidatePath(PAYROLL_RUN_ROUTE);
  revalidatePath(PAYROLL_RESULT_ROUTE);
}

/** Enter a one-time adjustment: company, fiscal year, period, employee, component, amount, reason, optional reference. It is PENDING until someone else approves it. */
export async function enterAdjustmentAction(_prev: AdjustmentActionState, form: FormData): Promise<AdjustmentActionState> {
  const g = await guard(ADJUSTMENT_ENTER_CAPABILITY);
  if (!('actor' in g)) return g;
  try {
    const view = await enterAdjustment({
      client: g.client, companyCode: text(form, 'companyCode'), fiscalYear: text(form, 'fiscalYear') as unknown as number,
      period: text(form, 'period') as unknown as number, personnelNumber: text(form, 'personnelNumber'), componentCode: text(form, 'componentCode'),
      amount: text(form, 'amount'), reason: text(form, 'reason'), sourceReference: text(form, 'sourceReference'),
      correctsResultId: text(form, 'correctsResultId'), requestKey: text(form, 'requestKey') || undefined, changedBy: g.actor,
    }, g.access);
    refresh();
    return { ok: true, message: `Adjustment entered for ${view.personnelNumber}: ${view.amount} ${view.currency} (${view.componentCode}), pending approval by someone other than ${g.actor}. It does not affect payroll until approved and the run is recalculated.` };
  } catch (error) {
    return refusal(error);
  }
}

/** Approve or reject: `adjustmentId`, `decision` (APPROVE | REJECT), `note` (required to reject). */
export async function decideAdjustmentAction(_prev: AdjustmentActionState, form: FormData): Promise<AdjustmentActionState> {
  const g = await guard(ADJUSTMENT_APPROVE_CAPABILITY);
  if (!('actor' in g)) return g;
  const decision = text(form, 'decision') === 'REJECT' ? 'REJECT' : 'APPROVE';
  try {
    const view = await decideAdjustment({ client: g.client, adjustmentId: text(form, 'adjustmentId'), decision, note: text(form, 'note'), changedBy: g.actor }, g.access);
    refresh();
    return {
      ok: true,
      message: decision === 'APPROVE'
        ? `Adjustment ${view.adjustmentId} approved by ${g.actor}. Recalculate the proposed run so it is picked up; it is applied when the run is released.`
        : `Adjustment ${view.adjustmentId} rejected: ${view.decisionNote}. It will not affect payroll.`,
    };
  } catch (error) {
    return refusal(error);
  }
}

/** Cancel a pending or approved adjustment (never an applied one): `adjustmentId`, `reason`. */
export async function cancelAdjustmentAction(_prev: AdjustmentActionState, form: FormData): Promise<AdjustmentActionState> {
  const session = await requireSession(PAYROLL_RUN_ROUTE);
  if (!can(session, ADJUSTMENT_ENTER_CAPABILITY) && !can(session, ADJUSTMENT_APPROVE_CAPABILITY)) {
    return { ok: false, message: `You do not hold ${ADJUSTMENT_ENTER_CAPABILITY} or ${ADJUSTMENT_APPROVE_CAPABILITY}.` };
  }
  try {
    const view = await cancelAdjustment({
      client: session.user.client, adjustmentId: text(form, 'adjustmentId'), reason: text(form, 'reason'), changedBy: session.user.username,
    }, { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } });
    refresh();
    return { ok: true, message: `Adjustment ${view.adjustmentId} cancelled: ${view.decisionNote}.` };
  } catch (error) {
    return refusal(error);
  }
}
