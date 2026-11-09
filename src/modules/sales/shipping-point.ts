/**
 * Where the goods leave from — SAP's OVL2, and the table behind it, TVSTZ.
 *
 * A delivery has always named the plant it loads from. The dock inside that plant is a different
 * question, and it is one the person raising the delivery cannot be asked: the answer is the
 * customer's requirement (how fast, by what arrangement — the shipping condition), the material's
 * requirement (what it takes to lift it onto a vehicle — the loading group), and the plant the stock
 * stands in. Three keys, one answer, and a table the tenant maintains.
 *
 * The table is a determination, so it is built the way every determination in this package is: rows,
 * blank as a value that is matched, most specific first. Where the condition and the loading group
 * both have something to say and no row says both, the material's group stands over the customer's
 * condition. That order is not arbitrary. A dock that cannot lift the goods is no answer at all,
 * whereas a customer who wants them quickly can be served from anywhere that can load them.
 *
 * Where nothing answers, the delivery is refused and names this screen. SAP's standard writes the
 * same fact into the incompletion log and lets the document stand; until that log exists, a delivery
 * with no shipping point is a delivery nobody can pick, and saying so at the door is the honest
 * version of the same rule.
 */
import { and, eq } from 'drizzle-orm';

import { type Tx } from '../../platform/db/client';
import { customerSalesArea } from '../foundation/customer-sales-area-schema';
import { materialSales } from '../inventory/schema';
import { shippingCondition, shippingPoint, shippingPointDetermination } from './schema';

export const SHIPPING_POINT_ROUTE = '/config/shipping-points';

/** The reference codes a reader arrives with: OVXJ maintains a point, OVL2 the table, OVXC the plant's. */
export const SHIPPING_POINT_ALIASES = ['OVXJ', 'OVL2', 'OVXC'] as const;

export class ShippingPointError extends Error {
  remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ShippingPointError';
    this.remedy = remedy;
  }
}

export interface ShippingPointKeys {
  /** The plant the stock stands in, and the plant the dock belongs to. */
  deliveringPlant: string;
  /** What the customer asked for. Blank where they asked for nothing. */
  shippingCondition: string;
  /** What the material takes to load. Blank where it takes nothing in particular. */
  loadingGroup: string;
}

/**
 * The shipping point that loads these three keys.
 *
 * A condition that does not stand in the master is refused by name rather than treated as blank: a
 * customer maintained with a condition nobody defined is an error in the master, not a customer who
 * said nothing. The loading group carries no master of its own — it is a grouping the tenant writes
 * on the material and matches by value — so a group with no row is simply a group nobody has
 * configured, and the refusal says which.
 */
export async function shippingPointFor(
  tx: Tx,
  client: string,
  input: ShippingPointKeys,
): Promise<string> {
  const plant = (input.deliveringPlant ?? '').trim().toUpperCase();
  const condition = (input.shippingCondition ?? '').trim().toUpperCase();
  const group = (input.loadingGroup ?? '').trim().toUpperCase();

  if (condition) {
    const [standing] = await tx.select().from(shippingCondition).where(and(
      eq(shippingCondition.client, client),
      eq(shippingCondition.shippingCondition, condition),
    )).limit(1);
    if (!standing) {
      throw new ShippingPointError(
        `Shipping condition ${condition} does not stand for this tenant.`,
        `Maintain shipping condition ${condition} at ${SHIPPING_POINT_ROUTE}, or clear it from the customer's sales area — a condition nobody defined is not a requirement anybody can serve.`,
      );
    }
    if (!standing.isActive) {
      throw new ShippingPointError(
        `Shipping condition ${condition} stands withdrawn, and a customer carrying it cannot be served.`,
        `Restore the condition, or clear it from the customer's sales area, at ${SHIPPING_POINT_ROUTE}.`,
      );
    }
  }

  const rows = await tx.select().from(shippingPointDetermination).where(and(
    eq(shippingPointDetermination.client, client),
    eq(shippingPointDetermination.deliveringPlant, plant),
    eq(shippingPointDetermination.isActive, true),
  ));
  const fits = (wantedCondition: string, wantedGroup: string): string | undefined => rows
    .find((row) => row.shippingCondition === wantedCondition && row.loadingGroup === wantedGroup)
    ?.shippingPoint;
  // Most specific first, and the material's loading group stands over the customer's condition.
  const answer = fits(condition, group)
    ?? fits('', group)
    ?? fits(condition, '')
    ?? fits('', '');

  if (!answer) {
    throw new ShippingPointError(
      `No shipping point is determined for plant ${plant} with shipping condition ${condition || 'none'} and loading group ${group || 'none'}.`,
      `Maintain the combination at ${SHIPPING_POINT_ROUTE}: the delivering plant, the shipping condition of the customer the goods are going to, and the loading group of the material being sent. A delivery that names no dock is a delivery nobody can load.`,
    );
  }

  const [point] = await tx.select().from(shippingPoint).where(and(
    eq(shippingPoint.client, client),
    eq(shippingPoint.shippingPoint, answer),
  )).limit(1);
  if (!point || !point.isActive) {
    throw new ShippingPointError(
      `Shipping point ${answer} stands withdrawn, and plant ${plant} is assigned to it for shipping condition ${condition || 'none'} and loading group ${group || 'none'}.`,
      `Restore the shipping point, or assign the plant another at ${SHIPPING_POINT_ROUTE}.`,
    );
  }
  return answer;
}

/**
 * What the customer the goods are going to has asked for: the ship-to's own sales area, and the
 * sold-to's where the ship-to keeps none.
 *
 * The ship-to is the customer the goods physically go to, so it is their requirement that decides
 * the dock — which is the whole reason the delivery names one at all. Where that customer keeps no
 * sales area of their own, the sold-to's stands in, exactly as it does for the partners themselves.
 */
export async function shippingConditionOf(tx: Tx, client: string, input: {
  shipTo: string;
  soldTo: string;
  salesOrg: string;
  distributionChannel: string;
  division: string;
}): Promise<string> {
  const read = async (partnerNumber: string): Promise<string> => {
    const [area] = await tx.select({ shippingCondition: customerSalesArea.shippingCondition })
      .from(customerSalesArea).where(and(
        eq(customerSalesArea.client, client),
        eq(customerSalesArea.partnerNumber, partnerNumber),
        eq(customerSalesArea.salesOrg, input.salesOrg),
        eq(customerSalesArea.distributionChannel, input.distributionChannel),
        eq(customerSalesArea.division, input.division),
      )).limit(1);
    return (area?.shippingCondition ?? '').trim().toUpperCase();
  };
  return (await read(input.shipTo)) || (await read(input.soldTo));
}

/**
 * What the material takes to load, as the sales view states it.
 *
 * Blank where the material carries no group: those are answered by the determination rows that name
 * none. The plant view is not consulted — the loading group is a fact about the material's sale, not
 * about where it happens to be stored.
 */
export async function loadingGroupOf(tx: Tx, client: string, input: {
  materialNumber: string;
  salesOrg: string;
  distributionChannel: string;
}): Promise<string> {
  const [view] = await tx.select({ loadingGroup: materialSales.loadingGroup })
    .from(materialSales).where(and(
      eq(materialSales.client, client),
      eq(materialSales.materialNumber, input.materialNumber),
      eq(materialSales.salesOrg, input.salesOrg),
      eq(materialSales.distributionChannel, input.distributionChannel),
    )).limit(1);
  return (view?.loadingGroup ?? '').trim().toUpperCase();
}
