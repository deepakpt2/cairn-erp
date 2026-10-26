'use server';

import { revalidatePath } from 'next/cache';

import { requireCapability } from '@/platform/auth/current';
import {
  saveOrderSettlementConfiguration,
  SETTLEMENT_RULE_CAPABILITY,
  SETTLEMENT_RULE_ROUTE,
  SettlementConfigurationError,
  type SettlementConfigurationView,
} from '@/modules/foundation/settlement-configuration';

export interface SettlementRuleActionState {
  ok: boolean;
  message?: string;
  result?: SettlementConfigurationView;
}

export async function saveSettlementRuleAction(
  _previous: SettlementRuleActionState,
  formData: FormData,
): Promise<SettlementRuleActionState> {
  const session = await requireCapability(SETTLEMENT_RULE_CAPABILITY);
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(String(formData.get('payload') ?? '')) as Record<string, unknown>;
  } catch {
    return { ok: false, message: 'The rule could not be read.' };
  }
  const method = String(input.method ?? '');
  try {
    const result = await saveOrderSettlementConfiguration({
      client: session.user.client,
      changedBy: session.user.username,
      orderNumber: String(input.orderNumber ?? ''),
      receiverCategory: String(input.receiverCategory ?? '') as 'COST_CENTER' | 'INTERNAL_ORDER' | 'GL_ACCOUNT',
      receiver: String(input.receiver ?? ''),
      percentage: method === 'PERCENT' ? String(input.share ?? '') : '',
      equivalence: method === 'EQUIVALENCE' ? String(input.share ?? '') : '',
      amount: method === 'AMOUNT' ? String(input.share ?? '') : '',
      settlementType: String(input.settlementType ?? '') as 'PER' | 'FUL',
      validFromYear: Number(input.validFromYear),
      validFromPeriod: Number(input.validFromPeriod),
      validToYear: Number(input.validToYear),
      validToPeriod: Number(input.validToPeriod),
    });
    revalidatePath(SETTLEMENT_RULE_ROUTE);
    revalidatePath('/config/settlement-configuration');
    return { ok: true, result, message: `Settlement rule stored for ${result.orderNumber}. Nothing was posted.` };
  } catch (error) {
    const message = error instanceof SettlementConfigurationError || error instanceof Error
      ? error.message
      : 'The settlement rule could not be stored.';
    const remedy = error instanceof SettlementConfigurationError ? error.remedy : undefined;
    return { ok: false, message: remedy ? `${message} ${remedy}` : message };
  }
}
