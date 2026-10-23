'use server';

import { revalidatePath } from 'next/cache';

import { requireCapability } from '@/platform/auth/current';
import {
  createPlanRevaluationOrder,
  PLAN_REVALUATION_CAPABILITY,
  PLAN_REVALUATION_ROUTE,
  PlanRevaluationError,
  type CreatePlanRevaluationResult,
} from '@/modules/foundation/plan-revaluation';

export interface PlanRevaluationActionState {
  ok: boolean;
  message?: string;
  result?: CreatePlanRevaluationResult;
}

export async function createPlanRevaluationAction(
  _previous: PlanRevaluationActionState,
  formData: FormData,
): Promise<PlanRevaluationActionState> {
  const session = await requireCapability(PLAN_REVALUATION_CAPABILITY);
  const payload = String(formData.get('payload') ?? '');
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return { ok: false, message: 'The selection could not be read.' };
  }
  try {
    const result = await createPlanRevaluationOrder({
      client: session.user.client,
      changedBy: session.user.username,
      controllingArea: String(input.controllingArea ?? ''),
      fiscalYear: Number(input.fiscalYear),
      periodFrom: Number(input.periodFrom),
      periodTo: Number(input.periodTo),
      planVersion: String(input.planVersion ?? ''),
      description: String(input.description ?? ''),
      orderFrom: String(input.orderFrom ?? ''),
      orderTo: String(input.orderTo ?? ''),
      requestKey: String(input.requestKey ?? '') || undefined,
    });
    revalidatePath(PLAN_REVALUATION_ROUTE);
    return {
      ok: true,
      result,
      message: `Plan revaluation ${result.revaluationNumber} saved. Plan amounts were not changed.`,
    };
  } catch (error) {
    const message = error instanceof PlanRevaluationError || error instanceof Error
      ? error.message
      : 'The plan revaluation could not be saved.';
    return { ok: false, message };
  }
}
