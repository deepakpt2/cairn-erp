'use server';

import { requireCapability } from '@/platform/auth/current';
import { processUncostedConfirmations, type BackfillResult } from '@/modules/production/activity-costing';
import { runWip, WipError, type WipRunResult } from '@/modules/production/order-wip';
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

export interface WipActionState {
  ok: boolean;
  message?: string;
  result?: WipRunResult;
}

/** Test run or update of the period-end financial WIP of one order or a small range. Authority is the settlement's. */
export async function runWipAction(_previous: WipActionState, formData: FormData): Promise<WipActionState> {
  const session = await requireCapability(PROD_ORDER_SETTLEMENT_CAPABILITY);
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(String(formData.get('payload') ?? '')) as Record<string, unknown>;
  } catch {
    return { ok: false, message: 'The selection could not be read.' };
  }
  try {
    const result = await runWip({
      client: session.user.client,
      by: session.user.username,
      authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' },
      orderNumber: String(input.orderNumber ?? ''),
      orderFrom: String(input.orderFrom ?? ''),
      orderTo: String(input.orderTo ?? ''),
      fiscalYear: Number(input.fiscalYear),
      period: Number(input.period),
      testRun: input.testRun !== false,
      requestKey: input.testRun === false ? String(input.requestKey ?? '') || undefined : undefined,
    });
    return { ok: true, result, message: result.message };
  } catch (error) {
    if (error instanceof WipError) return { ok: false, message: error.remedy ? `${error.message} ${error.remedy}` : error.message };
    return { ok: false, message: 'The WIP run could not be completed.' };
  }
}

export interface CostBackfillActionState {
  ok: boolean;
  message?: string;
  result?: BackfillResult;
}

/** Preview, then post, the activity cost of confirmations that were never costed — explicit, authorised, idempotent. */
export async function costBackfillAction(_previous: CostBackfillActionState, formData: FormData): Promise<CostBackfillActionState> {
  const session = await requireCapability(PROD_ORDER_SETTLEMENT_CAPABILITY);
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(String(formData.get('payload') ?? '')) as Record<string, unknown>;
  } catch {
    return { ok: false, message: 'The selection could not be read.' };
  }
  const orderNumber = String(input.orderNumber ?? '').trim().toUpperCase();
  if (!orderNumber) return { ok: false, message: 'Name the production order whose confirmations are to be costed.' };
  try {
    const result = await processUncostedConfirmations(session.user.client, {
      by: session.user.username,
      authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' },
      capability: PROD_ORDER_SETTLEMENT_CAPABILITY,
      orderNumber,
      preview: input.preview !== false,
    });
    return { ok: true, result, message: result.preview ? 'Preview. Nothing was posted.' : `${result.confirmations} confirmation(s) processed.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'The cost run could not be completed.' };
  }
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
    }, { userId: session.user.userId, sessionId: session.sessionId ?? '' });
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
