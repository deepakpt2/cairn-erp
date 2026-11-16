'use server';

import { redirect } from 'next/navigation';

import { can, requireSession } from '@/platform/auth/current';
import { COST_ESTIMATE_CAPABILITY, COST_ESTIMATE_ROUTE, CostEstimateError, createCostEstimate } from '@/modules/production/cost-estimate';

export interface CostEstimateActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** Create: `materialNumber`, `plant`, `costingDate`, `costingLotSize`, `costingVersion`, `planVersion`, `requestKey`. On success, shows the saved estimate. */
export async function createCostEstimateAction(_prev: CostEstimateActionState, form: FormData): Promise<CostEstimateActionState> {
  const session = await requireSession(COST_ESTIMATE_ROUTE);
  if (!can(session, COST_ESTIMATE_CAPABILITY)) {
    return { ok: false, message: `You do not hold ${COST_ESTIMATE_CAPABILITY}.`, remedy: `Ask an administrator for ${COST_ESTIMATE_CAPABILITY}.` };
  }
  let target: string;
  try {
    const view = await createCostEstimate({
      client: session.user.client,
      materialNumber: text(form, 'materialNumber'),
      plant: text(form, 'plant'),
      costingDate: text(form, 'costingDate'),
      costingLotSize: text(form, 'costingLotSize') || undefined,
      costingVersion: text(form, 'costingVersion') || undefined,
      planVersion: text(form, 'planVersion') || undefined,
      requestKey: text(form, 'requestKey') || undefined,
      actor: session.user.username,
    }, { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } });
    const query = new URLSearchParams({ materialNumber: view.materialNumber, plant: view.plant, costingDate: view.costingDate, costingVersion: view.costingVersion });
    target = `${COST_ESTIMATE_ROUTE}?${query.toString()}`;
  } catch (error) {
    if (error instanceof CostEstimateError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
  redirect(target);
}
