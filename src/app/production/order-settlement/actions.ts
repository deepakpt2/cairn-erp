'use server';

import { requireCapability } from '@/platform/auth/current';
import {
  PROD_ORDER_SETTLEMENT_CAPABILITY,
  ProductionOrderSettlementError,
  settleProductionOrder,
  type ProductionOrderSettlementRunResult,
} from '@/modules/production/order-settlement';

export interface ProductionOrderSettlementActionState {
  ok: boolean;
  message?: string;
  result?: ProductionOrderSettlementRunResult;
}

export async function settleProductionOrderAction(
  _previous: ProductionOrderSettlementActionState,
  formData: FormData,
): Promise<ProductionOrderSettlementActionState> {
  const session = await requireCapability(PROD_ORDER_SETTLEMENT_CAPABILITY);
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(String(formData.get('payload') ?? '')) as Record<string, unknown>;
  } catch {
    return { ok: false, message: 'The selection could not be read.' };
  }
  try {
    const result = await settleProductionOrder({
      client: session.user.client,
      changedBy: session.user.username,
      orderNumber: String(input.orderNumber ?? ''),
      controllingArea: String(input.controllingArea ?? ''),
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
    const message = error instanceof ProductionOrderSettlementError || error instanceof Error
      ? error.message
      : 'The settlement could not be run.';
    const remedy = error instanceof ProductionOrderSettlementError ? error.remedy : undefined;
    return { ok: false, message: remedy ? `${message} ${remedy}` : message };
  }
}
