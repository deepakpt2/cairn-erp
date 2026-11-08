/**
 * Sales pricing — what a sales document is judged against before it is priced.
 *
 * The price itself is the work of the pricing procedure (pricing-procedure.ts), which reads the
 * standing condition records for every step of the procedure it determines and writes down the
 * conditions that answered. What stands here is the smaller question that is asked before the
 * procedure runs and inside it: whether the customer may be sold to in this sales area at all, and
 * whether the plant named on the line carries the material the line promises.
 *
 * Both are answered here because both are asked of master data the sales document does not own, and
 * because a refusal has to come before the pricing, not after it: there is no point pricing an order
 * for a customer who is blocked, or for a material a plant cannot deliver.
 */
import { and, eq } from 'drizzle-orm';

import { type Tx } from '../../platform/db/client';
import { customerSalesArea } from '../foundation/customer-sales-area-schema';
import { materialPlant } from '../inventory/schema';

export class PricingError extends Error {
  remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'PricingError';
    this.remedy = remedy;
  }
}

/** The defaults that stand for this sold-to in this sales area. */
export async function resolveCustomerSalesData(
  tx: Tx,
  client: string,
  customerNumber: string,
  salesOrg: string,
  distributionChannel: string,
  division: string,
): Promise<{ isBlocked: boolean; salesStatus: string; deliveringPlant: string | null; completeDelivery: boolean; pricingProcedure: string | null }> {
  const [record] = await tx.select().from(customerSalesArea).where(and(
    eq(customerSalesArea.client, client),
    eq(customerSalesArea.partnerNumber, customerNumber),
    eq(customerSalesArea.salesOrg, salesOrg),
    eq(customerSalesArea.distributionChannel, distributionChannel),
    eq(customerSalesArea.division, division),
  )).limit(1);
  if (!record) {
    throw new PricingError(
      `Customer ${customerNumber} has no sales-area data for ${salesOrg}/${distributionChannel}/${division}, so no order may be entered against it there.`,
      'Maintain the customer sales area defaults, which carry the order block, the delivering plant and the pricing procedure.',
    );
  }
  return {
    isBlocked: record.isBlocked,
    salesStatus: record.salesStatus,
    deliveringPlant: record.deliveringPlant,
    completeDelivery: record.completeDelivery,
    pricingProcedure: record.pricingProcedure,
  };
}

/**
 * The plant has to carry the material, or the order promises a delivery the warehouse cannot make.
 * This is the judgement the material sales view would otherwise own; only the purchase-side plant view
 * stands today, so the plant extension is what can honestly be checked.
 */
export async function assertMaterialAtPlant(
  tx: Tx,
  client: string,
  materialNumber: string,
  plant: string,
): Promise<{ batchManaged: boolean }> {
  const [row] = await tx.select().from(materialPlant).where(and(
    eq(materialPlant.client, client),
    eq(materialPlant.materialNumber, materialNumber),
    eq(materialPlant.plant, plant),
  )).limit(1);
  if (!row) {
    throw new PricingError(
      `Material ${materialNumber} is not extended to plant ${plant}, so nothing can be delivered from there.`,
      'Extend the material to the plant, or name a plant where it is maintained.',
    );
  }
  if (row.markedForDeletion) {
    throw new PricingError(
      `Material ${materialNumber} is flagged for deletion at plant ${plant}.`,
      'Lift the deletion flag, or order the material from a plant where it is active.',
    );
  }
  return { batchManaged: row.batchManaged };
}
