'use server';

import { requireCapability } from '@/platform/auth/current';
import {
  ORDER_SETTLEMENT_COLLECTIVE_CAPABILITY,
  OrderSettlementError,
  settleOrdersCollective,
  type SettlementRunResult,
} from '@/modules/foundation/order-settlement';

export interface CollectiveSettlementActionState {
  ok: boolean;
  message?: string;
  result?: SettlementRunResult;
}

export async function settleOrdersCollectiveAction(
  _previous: CollectiveSettlementActionState,
  formData: FormData,
): Promise<CollectiveSettlementActionState> {
  const session = await requireCapability(ORDER_SETTLEMENT_COLLECTIVE_CAPABILITY);
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(String(formData.get('payload') ?? '')) as Record<string, unknown>;
  } catch {
    return { ok: false, message: 'The selection could not be read.' };
  }
  try {
    const result = await settleOrdersCollective({
      client: session.user.client,
      changedBy: session.user.username,
      controllingArea: String(input.controllingArea ?? ''),
      orderFrom: String(input.orderFrom ?? ''),
      orderTo: String(input.orderTo ?? ''),
      orderType: String(input.orderType ?? ''),
      fiscalYear: Number(input.fiscalYear),
      settlementPeriod: Number(input.settlementPeriod),
      testRun: input.testRun === true,
      checkTransactionData: input.checkTransactionData === true,
    });
    return {
      ok: result.posted || result.outcome === 'SIMULATED' || result.outcome === 'NOTHING_TO_SETTLE',
      result,
      message: result.message,
    };
  } catch (error) {
    const message = error instanceof OrderSettlementError || error instanceof Error
      ? error.message
      : 'The collective settlement could not be run.';
    const remedy = error instanceof OrderSettlementError ? error.remedy : undefined;
    return { ok: false, message: remedy ? `${message} ${remedy}` : message };
  }
}
