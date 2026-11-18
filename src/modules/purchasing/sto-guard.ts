/**
 * Stock transport orders (ITEM-22) are purchase orders without a supplier, a price or an invoice.
 * Every commercial entry point refuses one BY NAME through this guard instead of failing on a missing
 * supplier somewhere deeper. Standard supplier orders pass untouched.
 *
 * Kept free of other module imports so the inventory, finance and purchasing services can all use it.
 */
import { sql } from 'drizzle-orm';

import type { Tx } from '../../platform/db/client';

export const STO_ORDER_TYPE = 'STOCK_TRANSPORT';

export type StoRefusalProcess =
  | 'supplier invoice' | 'parked supplier invoice' | 'supplier return' | 'goods receipt against a supplier'
  | 'GR/IR clearing' | 'down payment' | 'vendor evaluation' | 'quotation, contract or info record'
  | 'account assignment';

export interface StoRefusal { message: string; remedy: string }

/** The refusal for a stock transport order, or null when the order is a supplier order (or does not exist). */
export async function stoRefusal(
  tx: Tx, client: string, orderNumber: string, process: StoRefusalProcess,
): Promise<StoRefusal | null> {
  const rows = await tx.execute(sql`
    select document_type from purchase_order where client = ${client} and order_number = ${orderNumber}
  `) as unknown as Array<{ document_type: string }>;
  if (rows[0]?.document_type !== STO_ORDER_TYPE) return null;
  const remedies: Partial<Record<StoRefusalProcess, string>> = {
    'goods receipt against a supplier':
      'Receive it from transit: the goods receipt screen shows the quantities that stand in transit for a stock transport order.',
    'supplier return': 'Reverse the goods receipt (102) or the goods issue (352) on the material document reversal screen.',
  };
  return {
    message: `Order ${orderNumber} is a stock transport order, which carries no supplier, no price and no invoice: a ${process} does not apply to it.`,
    remedy: remedies[process]
      ?? 'A stock transport order moves stock between two plants; it is issued (351) and received (101) from transit, and never invoiced.',
  };
}
