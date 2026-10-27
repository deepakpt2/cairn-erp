/**
 * Sales pricing — the condition record a sales order item is priced by.
 *
 * CAIRN.md §11.2 requires the order and the invoice to price consistently. A figure typed into an
 * order form satisfies neither the reader who asks what this customer was quoted on that date nor the
 * invoice that has to match the order it came from, so an item's price is read from a standing
 * condition record and the record is named on the line.
 *
 * The access order is customer-and-material, then material alone, then customer alone; the record with
 * the latest start date that still covers the order date answers. A pricing procedure, its steps,
 * access sequences, scales and the discount and freight condition types are recorded as DI-018: they
 * need a master to maintain and a screen to maintain it from, and neither is invented here.
 */
import { and, eq, sql } from 'drizzle-orm';

import { type Tx } from '../../platform/db/client';
import { customerSalesArea } from '../foundation/customer-sales-area-schema';
import { materialPlant } from '../inventory/schema';
import { salesConditionRecord } from './schema';

/** The one condition type that stands: the item price. */
export const PRICING_CONDITION_TYPE = 'PR00';

export class PricingError extends Error {
  remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'PricingError';
    this.remedy = remedy;
  }
}

export interface PricedItem {
  /** The amount as the record states it, per `priceUnit` units, in the record's currency. */
  netPrice: string;
  priceUnit: number;
  conditionNumber: string;
  currency: string;
  /** Which key found the record, so a reader can tell a customer price from a general one. */
  access: 'CUSTOMER_MATERIAL' | 'MATERIAL' | 'CUSTOMER';
}

function round2(value: number): string {
  if (!Number.isFinite(value)) {
    throw new PricingError('A price did not scale to a number.', 'Check the condition record amount.');
  }
  return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
}

/** The net value of an item: quantity ÷ price unit × the amount the record states. */
export function itemNetAmount(orderQuantity: string, priced: PricedItem): string {
  const value = (Number(orderQuantity) * Number(priced.netPrice)) / priced.priceUnit;
  return round2(value);
}

/** The defaults that stand for this sold-to in this sales area. */
export async function resolveCustomerSalesData(
  tx: Tx,
  client: string,
  customerNumber: string,
  salesOrg: string,
  distributionChannel: string,
  division: string,
): Promise<{ isBlocked: boolean; salesStatus: string; deliveringPlant: string | null; completeDelivery: boolean }> {
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
  };
}

/**
 * Price one item from the standing records. A miss is a refusal: there is no default price, no zero,
 * and no figure taken from the form.
 */
export async function priceItem(
  tx: Tx,
  client: string,
  input: {
    salesOrg: string;
    distributionChannel: string;
    division: string;
    customerNumber: string;
    materialNumber: string;
    documentDate: string;
    currency: string;
  },
): Promise<PricedItem> {
  const accesses = [
    { customer: input.customerNumber, material: input.materialNumber, name: 'CUSTOMER_MATERIAL' as const },
    { customer: '', material: input.materialNumber, name: 'MATERIAL' as const },
    { customer: input.customerNumber, material: '', name: 'CUSTOMER' as const },
  ];
  for (const attempt of accesses) {
    const [found] = await tx.select().from(salesConditionRecord).where(and(
      eq(salesConditionRecord.client, client),
      eq(salesConditionRecord.conditionType, PRICING_CONDITION_TYPE),
      eq(salesConditionRecord.salesOrg, input.salesOrg),
      eq(salesConditionRecord.distributionChannel, input.distributionChannel),
      eq(salesConditionRecord.division, input.division),
      eq(salesConditionRecord.customerNumber, attempt.customer),
      eq(salesConditionRecord.materialNumber, attempt.material),
      sql`${salesConditionRecord.validityFrom} <= ${input.documentDate}`,
      sql`${salesConditionRecord.validityTo} >= ${input.documentDate}`,
    )).orderBy(sql`${salesConditionRecord.validityFrom} desc, ${salesConditionRecord.conditionNumber} desc`).limit(1);
    if (!found) continue;
    if (found.currency.trim().toUpperCase() !== input.currency.trim().toUpperCase()) {
      throw new PricingError(
        `Condition record ${found.conditionNumber} is stated in ${found.currency}, not in the order currency ${input.currency}.`,
        'Maintain a record in the order currency, or order in the currency the record states. A price is never converted silently into an order.',
      );
    }
    return {
      netPrice: found.amount,
      priceUnit: found.priceUnit,
      conditionNumber: found.conditionNumber,
      currency: found.currency,
      access: attempt.name,
    };
  }
  throw new PricingError(
    `No ${PRICING_CONDITION_TYPE} condition record stands for material ${input.materialNumber} and customer ${input.customerNumber} in sales area ${input.salesOrg}/${input.distributionChannel}/${input.division} on ${input.documentDate}.`,
    'Maintain the condition record at /sales/conditions for a validity period that includes the order date. A priced item is never answered with zero.',
  );
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
