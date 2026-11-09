/**
 * Where the goods come from, and how much of them may go out at once.
 *
 * §3.4 — honouring the master. The customer sales area has carried a delivering plant, a
 * complete-delivery flag and an order-combination flag since the master was built, and nothing that
 * raised a document ever read them. A field a screen maintains and no document honours is worse than
 * no field, because it looks like a promise being kept.
 *
 * Two questions are answered here.
 *
 * The first is **which plant the goods come from**. SAP reads it in a sequence: the customer-material
 * info record first, then the ship-to's customer master, then the material's sales view. There is no
 * customer-material info record in this system — it is a master object of its own, and it is not what
 * this increment is about — so the sequence begins where the system has one: the ship-to's sales area,
 * falling back to the sold-to's where the ship-to keeps no sales area of their own, and then the
 * material's sales view. Where neither stands, the refusal names both screens. A plant is never
 * invented, and a plant nobody maintains is not a plant the delivery quietly borrows.
 *
 * The second is **how much of an order may go out at once**: complete delivery for the whole order,
 * the item-level partial-delivery indicator with SAP's `C`, and the maximum number of partial
 * deliveries. These are the customer's terms, and they are read from the same sales area, with the
 * same fallback.
 *
 * The answer is a proposal and not a straitjacket when it is used at order entry: a person who named
 * a plant deliberately did not do it by accident, and §2.4's property — a document answers to the day
 * it was raised — is worth more than a master being obeyed to the letter. At delivery creation it is
 * a rule, because by then the goods are at the door.
 */
import { and, eq } from 'drizzle-orm';

import { type Tx } from '../../platform/db/client';
import { customerSalesArea } from '../foundation/customer-sales-area-schema';
import { materialSales } from '../inventory/schema';

/** The screens a refusal sends a reader to: the customer master, and the material master. */
export const CUSTOMER_MASTER_ROUTE = '/foundation/partners';
export const MATERIAL_MASTER_ROUTE = '/inventory/materials';

export class DeliveringPlantError extends Error {
  remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'DeliveringPlantError';
    this.remedy = remedy;
  }
}

export interface DeliveringPlantKeys {
  /** The customer the goods are going to. Their master is read first. */
  shipTo: string;
  /** The customer the order was made with, read where the ship-to keeps no sales area of their own. */
  soldTo: string;
  materialNumber: string;
  salesOrg: string;
  distributionChannel: string;
  division: string;
}

export interface DeliveringPlantAnswer {
  plant: string;
  /** Which master answered, so a reader can see why that plant and not another. */
  from: 'SHIP_TO' | 'SOLD_TO' | 'MATERIAL';
  /** Whose sales area answered, and null where the material's own view did. */
  partnerNumber: string | null;
}

/**
 * What a customer's master says about how their goods go out.
 *
 * A customer with no sales area in this area carries no terms: they are left unencumbered rather than
 * refused, because an unmaintained master is not a customer who asked for the strictest rule.
 */
export interface DeliveryTerms {
  /** Whose sales area answered, and null where nobody's did. */
  partnerNumber: string | null;
  /** The whole order travels in one delivery, or in none. */
  completeDelivery: boolean;
  /** This customer's orders may be gathered into one delivery. */
  orderCombination: boolean;
  /** Blank leaves an item free to travel in pieces; 'C' delivers it complete or not at all. */
  partialDeliveryIndicator: string;
  /** How many times an item may be split. Zero is no limit, not no partial deliveries. */
  maxPartialDeliveries: number;
}

const UNENCUMBERED: DeliveryTerms = {
  partnerNumber: null,
  completeDelivery: false,
  orderCombination: false,
  partialDeliveryIndicator: '',
  maxPartialDeliveries: 0,
};

/**
 * How this customer's goods go out.
 *
 * The ship-to's sales area answers, because the goods are going to them; the sold-to's answers where
 * the ship-to keeps none of their own, the same fallback the shipping condition uses.
 */
export async function deliveryTermsFor(
  tx: Tx,
  client: string,
  keys: Omit<DeliveringPlantKeys, 'materialNumber'>,
): Promise<DeliveryTerms> {
  for (const [partnerNumber, from] of [[keys.shipTo, 'SHIP_TO'], [keys.soldTo, 'SOLD_TO']] as const) {
    // The sold-to is not read twice where they are the customer the goods are going to anyway.
    if (!partnerNumber || (from === 'SOLD_TO' && partnerNumber === keys.shipTo)) continue;
    const [area] = await tx.select().from(customerSalesArea).where(and(
      eq(customerSalesArea.client, client),
      eq(customerSalesArea.partnerNumber, partnerNumber),
      eq(customerSalesArea.salesOrg, keys.salesOrg),
      eq(customerSalesArea.distributionChannel, keys.distributionChannel),
      eq(customerSalesArea.division, keys.division),
    )).limit(1);
    if (!area) continue;
    return {
      partnerNumber,
      completeDelivery: area.completeDelivery,
      orderCombination: area.orderCombination,
      partialDeliveryIndicator: (area.partialDeliveryIndicator ?? '').trim().toUpperCase(),
      maxPartialDeliveries: area.maxPartialDeliveries ?? 0,
    };
  }
  return { ...UNENCUMBERED };
}

/**
 * The plant the goods come from.
 *
 * A plant that stands withdrawn or belongs to nobody is not offered: a delivery drawn from a plant
 * that cannot serve the order is a delivery the warehouse cannot pick.
 */
export async function deliveringPlantFor(
  tx: Tx,
  client: string,
  keys: DeliveringPlantKeys,
): Promise<DeliveringPlantAnswer> {
  for (const [partnerNumber, from] of [[keys.shipTo, 'SHIP_TO'], [keys.soldTo, 'SOLD_TO']] as const) {
    // The sold-to is not read twice where they are the customer the goods are going to anyway.
    if (!partnerNumber || (from === 'SOLD_TO' && partnerNumber === keys.shipTo)) continue;
    const [area] = await tx.select().from(customerSalesArea).where(and(
      eq(customerSalesArea.client, client),
      eq(customerSalesArea.partnerNumber, partnerNumber),
      eq(customerSalesArea.salesOrg, keys.salesOrg),
      eq(customerSalesArea.distributionChannel, keys.distributionChannel),
      eq(customerSalesArea.division, keys.division),
    )).limit(1);
    const plant = (area?.deliveringPlant ?? '').trim().toUpperCase();
    if (plant) return { plant, from, partnerNumber };
  }

  const [view] = await tx.select().from(materialSales).where(and(
    eq(materialSales.client, client),
    eq(materialSales.materialNumber, keys.materialNumber),
    eq(materialSales.salesOrg, keys.salesOrg),
    eq(materialSales.distributionChannel, keys.distributionChannel),
  )).limit(1);
  const plant = (view?.deliveringPlant ?? '').trim().toUpperCase();
  if (plant) return { plant, from: 'MATERIAL', partnerNumber: null };

  throw new DeliveringPlantError(
    `No delivering plant is determined for material ${keys.materialNumber} and customer ${keys.shipTo || keys.soldTo} in sales area ${keys.salesOrg}/${keys.distributionChannel}/${keys.division}.`,
    `Maintain a delivering plant for the customer at ${CUSTOMER_MASTER_ROUTE}, or for the material's sales view at ${MATERIAL_MASTER_ROUTE}. A delivery drawn from a plant nobody named is a delivery the warehouse was never asked to pick.`,
  );
}
