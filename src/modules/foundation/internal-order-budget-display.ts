/**
 * KO23 — display the original budget. This service has no save.
 */
import { z } from 'zod';

import {
  getOriginalBudget,
  InternalOrderBudgetError,
  type OriginalBudgetView,
} from './internal-order-budget';

const displayInput = z.object({
  client: z.string().trim().min(1).max(4),
  orderNumber: z.string().trim().min(1).max(20),
}).strict();

export async function displayOriginalBudget(raw: unknown): Promise<OriginalBudgetView> {
  const parsed = displayInput.safeParse(raw);
  if (!parsed.success) {
    throw new InternalOrderBudgetError('Display takes the client and order number only. It does not accept a change.');
  }
  const budget = await getOriginalBudget(parsed.data.client, parsed.data.orderNumber);
  if (!budget) throw new InternalOrderBudgetError(`Internal order ${parsed.data.orderNumber} does not exist.`);
  return budget;
}
