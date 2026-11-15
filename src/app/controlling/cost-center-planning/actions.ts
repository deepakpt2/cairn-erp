'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  COST_CENTER_PLANNING_CAPABILITY,
  COST_CENTER_PLANNING_ROUTE,
  CostCenterPlanningError,
  saveCostCenterPlan,
  planningCurrencyDecimals,
  spreadAnnualTotal,
} from '@/modules/foundation/cost-center-planning';
import { planningContext } from '@/modules/foundation/activity-rate-definition';

export interface PlanningActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Save the grid. Rows are read by index: `element_<i>`, then `amount_<i>_<period>` for every period
 * of the context, or `total_<i>` — when filled, spread over the regular periods and taking the place
 * of that row's period cells. A blank element row is ignored; a filled element with every cell blank
 * deletes that element's standing plan. Also `reason` and the hidden selection and `requestKey`.
 */
export async function savePlanAction(_prev: PlanningActionState, form: FormData): Promise<PlanningActionState> {
  const session = await requireSession(COST_CENTER_PLANNING_ROUTE);
  if (!can(session, COST_CENTER_PLANNING_CAPABILITY)) {
    return { ok: false, message: `You do not hold ${COST_CENTER_PLANNING_CAPABILITY}.`, remedy: `Ask an administrator for ${COST_CENTER_PLANNING_CAPABILITY}.` };
  }
  const controllingArea = text(form, 'controllingArea').toUpperCase();
  const fiscalYear = Number(text(form, 'fiscalYear'));
  const planVersion = text(form, 'planVersion').toUpperCase() || '000';
  const costCenter = text(form, 'costCenter').toUpperCase();
  try {
    const context = await planningContext(session.user.client, controllingArea, fiscalYear);
    if (!context) throw new CostCenterPlanningError(`Controlling Area ${controllingArea} is not defined in this tenant.`, 'Choose a controlling area that stands.');
    const decimals = await planningCurrencyDecimals(session.user.client, context.currency);
    const regular = context.periods.filter((p) => p.periodType === 'REGULAR');
    const indices = [...form.keys()].filter((k) => /^element_\d+$/.test(k)).map((k) => Number(k.slice(8))).sort((a, b) => a - b);
    const entries: Array<{ costElement: string; period: number; amount: string }> = [];
    for (const i of indices) {
      const costElement = text(form, `element_${i}`).toUpperCase();
      if (!costElement) continue;
      const total = text(form, `total_${i}`);
      const spread = total ? spreadAnnualTotal(total, regular.length, decimals) : null;
      for (const period of context.periods) {
        const amount = spread
          ? (period.periodType === 'REGULAR' ? spread[regular.indexOf(period)]! : '')
          : text(form, `amount_${i}_${period.period}`);
        entries.push({ costElement, period: period.period, amount });
      }
    }
    const result = await saveCostCenterPlan({
      client: session.user.client,
      changedBy: session.user.username,
      controllingArea, fiscalYear, planVersion, costCenter,
      entries,
      reason: text(form, 'reason'),
      requestKey: text(form, 'requestKey') || undefined,
    }, { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } });
    revalidatePath(COST_CENTER_PLANNING_ROUTE);
    revalidatePath('/controlling/cost-center-report');
    return {
      ok: true,
      message: result.changed
        ? `Plan saved for ${costCenter}, version ${planVersion}, ${fiscalYear}: ${result.rows} cell${result.rows === 1 ? '' : 's'} stand, ${result.periods} period${result.periods === 1 ? '' : 's'} changed.`
        : 'Nothing changed: the plan already stands as entered.',
    };
  } catch (error) {
    if (error instanceof CostCenterPlanningError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}
