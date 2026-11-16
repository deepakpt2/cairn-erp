/**
 * Demo phase D17_SALES_AVAILABILITY — the availability check, reachable.
 *
 * The demo had no checking rule, group or scope at all, so no material was ever checked and every order
 * was confirmed in full. This phase configures the smallest thing that shows the check working:
 * - checking rules OR (an order) and LF (a delivery), maintained only if absent;
 * - checking group D1 with a scope for each rule: the safety stock is deducted, the other open orders'
 *   promises are subtracted (the default), and open purchase orders count as supply;
 * - D1 assigned to one material, the trading good TRAD-JUICE, at the distribution centre.
 * Every other material, and every document type, is left exactly as it was: no document type names a
 * rule, so orders are checked under OR as before, and a material with no group is not checked.
 *
 * Then one order for more TRAD-JUICE than the centre can promise, checked as it is raised (confirmed
 * partially), and the delivery created from it — whose quantity comes from the confirmation, not the order.
 * Idempotent: configuration only when missing, the order and delivery request-keyed.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../db/client';
import {
  assignCheckingGroup, saveCheckingGroup, saveCheckingRule, saveScopeOfCheck,
} from '../../modules/production/availability-check';
import { simulateSalesOrderAvailability, type SalesAvailabilityLineResult } from '../../modules/sales/availability-check';
import { createDelivery, listDeliverableOrderLines } from '../../modules/sales/delivery';
import { createSalesOrder } from '../../modules/sales/sales-order';
import { DEMO_ACTOR, DEMO_STRUCTURE } from './demo-organisation';
import { withActingUser } from './demo-people';
import type { DemoTimeline } from './demo-provisioning';

const REASON = 'Demo: the availability check';
const GROUP = 'D1';
const MATERIAL = 'TRAD-JUICE';
const CUSTOMER = 'CUS-1000';
const SALES_CLERK = 'demo.sales';
const REQUEST_KEY = 'DEMO-ATP-ORDER-3';
const DELIVERY_KEY = 'DEMO-ATP-DELIVERY-3';
/** More than the centre can promise from stock, and small enough to stay inside the customer's credit limit. */
const ORDER_QUANTITY = 2000;

export interface DemoSalesAvailabilityResult {
  configurationAdded: string[];
  orderNumber: string;
  material: string;
  plant: string;
  requestedDate: string;
  requestedQuantity: string;
  availableAtRequestedDate: string;
  confirmedQuantity: string;
  confirmedDate: string | null;
  partial: boolean;
  elementsCounted: string[];
  deliveryNumber: string | null;
  deliveryQuantity: string | null;
}

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export async function buildDemoSalesAvailability(input: { client: string; timeline: DemoTimeline }): Promise<DemoSalesAvailabilityResult> {
  const client = input.client;
  const plant = DEMO_STRUCTURE.distributionPlant;
  const added: string[] = [];
  const exists = async (query: ReturnType<typeof sql>) => (await withTenant(client, (tx) => tx.execute(query)) as unknown as unknown[]).length > 0;

  // 1. Configuration, only where missing.
  for (const [rule, description] of [['OR', 'Order entry'], ['LF', 'Delivery creation']] as const) {
    if (!(await exists(sql`select 1 from availability_checking_rule where client = ${client} and checking_rule = ${rule}`))) {
      await saveCheckingRule({ client, changedBy: DEMO_ACTOR, mode: 'CREATE', checkingRule: rule, description, version: 0, reason: REASON });
      added.push(`checking rule ${rule}`);
    }
  }
  if (!(await exists(sql`select 1 from availability_checking_group where client = ${client} and checking_group = ${GROUP}`))) {
    await saveCheckingGroup({ client, changedBy: DEMO_ACTOR, mode: 'CREATE', checkingGroup: GROUP, description: 'Counted over time', noCheck: ' ', version: 0, reason: REASON });
    added.push(`checking group ${GROUP}`);
  }
  for (const rule of ['OR', 'LF']) {
    if (!(await exists(sql`select 1 from availability_check_scope where client = ${client} and checking_group = ${GROUP} and checking_rule = ${rule}`))) {
      await saveScopeOfCheck({
        client, changedBy: DEMO_ACTOR, mode: 'CREATE', checkingGroup: GROUP, checkingRule: rule,
        includeSafetyStock: 'X', includeQualityStock: ' ', includeBlockedStock: ' ', includeRestrictedUse: ' ',
        purchaseOrders: 'X', purchaseRequisitions: ' ', plannedOrders: ' ', productionOrders: ' ',
        dependentRequirements: ' ', reservations: ' ', receiptsInPast: ' ', salesRequirements: 'X',
        version: 0, reason: REASON,
      });
      added.push(`scope ${GROUP}/${rule} (safety stock deducted, other orders subtracted, purchase orders counted)`);
    }
  }
  const [view] = (await withTenant(client, (tx) => tx.execute(sql`
    select checking_group, version from material_plant where client = ${client} and material_number = ${MATERIAL} and plant = ${plant}`))) as unknown as Array<{ checking_group: string | null; version: number }>;
  if (!view) throw new Error(`D17_SALES_AVAILABILITY: ${MATERIAL} has no plant view in ${plant}.`);
  if ((view.checking_group ?? '').trim() === '') {
    await assignCheckingGroup({ client, changedBy: DEMO_ACTOR, materialNumber: MATERIAL, plant, checkingGroup: GROUP, expectedVersion: Number(view.version), reason: REASON });
    added.push(`${MATERIAL} in plant ${plant} assigned to checking group ${GROUP}`);
  }

  // 2. The order, checked as it is raised, and the delivery created from what was confirmed.
  const requestedDate = addDays(input.timeline.anchorDate, 7);
  const standing = (await withTenant(client, (tx) => tx.execute(sql`select order_number from sales_order where client = ${client} and request_key = ${REQUEST_KEY}`))) as unknown as Array<{ order_number: string }>;
  const orderNumber = standing[0]?.order_number ?? (await withActingUser(client, SALES_CLERK, (actor) => createSalesOrder({
    client, changedBy: SALES_CLERK, salesOrg: DEMO_STRUCTURE.salesOrg, distributionChannel: DEMO_STRUCTURE.distributionChannel,
    division: DEMO_STRUCTURE.division, customerNumber: CUSTOMER, companyCode: DEMO_STRUCTURE.companyCode,
    creditControlArea: DEMO_STRUCTURE.creditControlArea, currency: 'KWD', orderDate: input.timeline.anchorDate, requestedDate,
    headerText: 'Demo availability check', requestKey: REQUEST_KEY,
    lines: [{ materialNumber: MATERIAL, plant, orderQuantity: ORDER_QUANTITY, quantityUnit: 'BOX', taxCode: 'S5', requestedDeliveryDate: requestedDate }],
  }, { authorization: actor }))).orderNumber;

  const line: SalesAvailabilityLineResult = await withActingUser(client, DEMO_ACTOR_FOR_CHECK, async (actor) =>
    (await simulateSalesOrderAvailability({ client, orderNumber }, { authorization: actor })).lines[0]!);
  const proposed = line.proposed;

  let deliveryNumber: string | null = null;
  let deliveryQuantity: string | null = null;
  const deliveryStanding = (await withTenant(client, (tx) => tx.execute(sql`select delivery_number from delivery where client = ${client} and request_key = ${DELIVERY_KEY}`))) as unknown as Array<{ delivery_number: string }>;
  if (deliveryStanding[0]) {
    deliveryNumber = deliveryStanding[0].delivery_number;
  } else {
    const open = await listDeliverableOrderLines(client, { orderNumber });
    if (open.length > 0) {
      const created = await withActingUser(client, SALES_CLERK, (actor) => createDelivery({
        client, changedBy: SALES_CLERK, orderNumber, deliveryDate: requestedDate, goodsMovementDate: requestedDate,
        headerText: 'Demo availability check', requestKey: DELIVERY_KEY,
        items: open.map((l) => ({ orderLineNumber: l.lineNumber, quantity: l.remainingQuantity })),
      }, { authorization: actor }));
      deliveryNumber = created.deliveryNumber;
    }
  }
  if (deliveryNumber) {
    const [qty] = (await withTenant(client, (tx) => tx.execute(sql`select sum(delivery_quantity)::text as q from delivery_line where client = ${client} and delivery_number = ${deliveryNumber}`))) as unknown as Array<{ q: string }>;
    deliveryQuantity = qty?.q ?? null;
  }

  return {
    configurationAdded: added, orderNumber, material: MATERIAL, plant, requestedDate,
    requestedQuantity: line.orderQuantity, availableAtRequestedDate: proposed?.availableAtRequestedDate ?? '—',
    confirmedQuantity: line.standing.confirmedQuantity ?? '—', confirmedDate: line.standing.confirmedDate,
    partial: proposed?.partial ?? false,
    elementsCounted: (proposed?.basis ?? []).map((b) => `${b.date} ${b.direction === 'RECEIPT' ? '+' : '-'}${b.quantity} ${b.elementType} ${b.documentNumber}`),
    deliveryNumber, deliveryQuantity,
  };
}

/** The administrator reads the check (the clerk raises documents); explicitly scoped by D9. */
const DEMO_ACTOR_FOR_CHECK = 'demo.admin';
