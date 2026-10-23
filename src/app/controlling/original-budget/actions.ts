'use server';

import { revalidatePath } from 'next/cache';

import { requireCapability } from '@/platform/auth/current';
import {
  changeOriginalBudget,
  InternalOrderBudgetError,
  ORIGINAL_BUDGET_CHANGE_CAPABILITY,
  ORIGINAL_BUDGET_ROUTE,
} from '@/modules/foundation/internal-order-budget';

export interface BudgetActionState {
  ok: boolean;
  message?: string;
  documentNumber?: string;
}

export async function saveOriginalBudgetAction(
  _previous: BudgetActionState,
  formData: FormData,
): Promise<BudgetActionState> {
  const session = await requireCapability(ORIGINAL_BUDGET_CHANGE_CAPABILITY);
  const payload = String(formData.get('payload') ?? '');
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return { ok: false, message: 'The budget could not be read.' };
  }
  const annual = Array.isArray(input.annual)
    ? input.annual.flatMap((row) => {
        const value = row as { fiscalYear?: unknown; amount?: unknown };
        const amount = String(value.amount ?? '').trim();
        if (!amount) return [];
        return [{ fiscalYear: Number(value.fiscalYear), amount }];
      })
    : undefined;
  try {
    const saved = await changeOriginalBudget({
      client: session.user.client,
      changedBy: session.user.username,
      orderNumber: String(input.orderNumber ?? ''),
      documentDate: String(input.documentDate ?? ''),
      overallAmount: String(input.overallAmount ?? '').trim() || undefined,
      annual,
      documentText: String(input.documentText ?? ''),
      requestKey: String(input.requestKey ?? '') || undefined,
    });
    revalidatePath(ORIGINAL_BUDGET_ROUTE);
    return {
      ok: true,
      documentNumber: saved.documentNumber,
      message: `Original budget document ${saved.documentNumber} saved. Nothing was posted.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The original budget could not be saved.';
    return { ok: false, message: error instanceof InternalOrderBudgetError ? message : message };
  }
}
