/**
 * DI-020 (§3.4) — what the master promised, honoured at the door.
 *
 * The customer sales area has carried a delivering plant, a complete-delivery requirement and an
 * order-combination permission since the master was built, and no document has ever read any of them.
 * A field a screen maintains and nothing honours is worse than no field: it looks like a promise being
 * kept. This file is the promise, kept.
 *
 * Five things are held to:
 *
 * Where the goods come from is answered by the master where the item does not say — the ship-to's
 * sales area first, then the sold-to's, then the material's own sales view — and where none of them
 * says, the order is refused naming both screens rather than borrowing a plant from somewhere.
 *
 * A customer who asked for the whole order at once gets the whole order at once, and one who said an
 * item travels complete gets it complete. A customer who set a limit on how many times an item may be
 * split gets the rest together once the limit is spent.
 *
 * Two orders may travel as one delivery where the customer allows it, and the delivery still goes to
 * one address from one dock.
 *
 * And the master's own maintenance refuses a value that is not one: an indicator that is neither
 * blank nor C, a maximum that is not a number a delivery could count to.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveCustomerCredit } from '../src/modules/finance/credit';
import { saveSalesCondition } from '../src/modules/sales/conditions';
import {
  getCustomerSalesArea, saveCustomerSalesArea, type CustomerSalesAreaInput,
} from '../src/modules/foundation/customer-sales-areas';
import { saveCustomerPartner } from '../src/modules/sales/partners';
import { assignShippingPoint, defineShippingPoint } from '../src/modules/sales/shipping-point-maintenance';
import { createSalesOrder, getSalesOrder } from '../src/modules/sales/sales-order';
import { createDelivery, listDeliverableOrderLines } from '../src/modules/sales/delivery';
import {
  assignSalesAreaDimensions, createTenant, defineTestRanges, destroyTenant, maintainMaterialSales,
  type TestTenant,
} from './helpers';
import { createSalesActor, refreshSalesActor, type SalesActor } from './helpers/sales-actor';

const ACTOR = 'SD9247_TERMS';
const AREA = 'CA47';
const CUSTOMER = 'SD9247CUST1';
const SHIP_TO = 'SD9247CUST2';
const OTHER_SHIP_TO = 'SD9247CUST3';
/** A party who receives goods but keeps no sales area of their own, so the sold-to has to answer. */
const NO_AREA_SHIP_TO = 'SD9247CUST4';
/** The plant the standard structure gives every fixture tenant, and a second one to answer with. */
const PLANT = '1000';
const SECOND_PLANT = '2000';
const DATE = '2026-10-15';

const base = {
  client: '',
  changedBy: ACTOR,
  salesOrg: '1000',
  distributionChannel: '10',
  division: '01',
  customerNumber: CUSTOMER,
  companyCode: '1000',
  currency: 'USD',
  orderDate: DATE,
};

let counter = 0;
const key = (what: string) => `sd9247-${what}-${++counter}`;


const SALES_ACTOR = { username: '', userId: '', sessionId: '', authorization: { userId: '', sessionId: '' } };
let SALES_ACTOR_READY: Promise<void> | null = null;
let SALES_ACTOR_TENANT = '';

/**
 * The authority a sales service is handed.
 *
 * The actor is signed in the first time a service is called, and its Company Code
 * and Plant reach is refreshed on every call: a suite builds its masters in
 * `beforeAll` and often adds a plant after the tenant exists, and a service asked
 * before that plant was granted would answer that the actor's reach does not cover
 * it — which is the rule working, not a test failing for the wrong reason.
 * Keyed on the tenant as well, because a suite that stands two tenants needs a
 * session in each and a session from one is not a session in the other.
 */
async function salesAuthority(client: string) {
  if (!SALES_ACTOR.userId || SALES_ACTOR_TENANT !== client) {
    SALES_ACTOR_TENANT = client;
    SALES_ACTOR_READY = createSalesActor(client).then((actor) => { Object.assign(SALES_ACTOR, actor); });
    await SALES_ACTOR_READY;
  }
  await refreshSalesActor(client, SALES_ACTOR);
  return SALES_ACTOR.authorization;
}

describe('what the master promised', () => {
  let tenant: TestTenant;

  const addMaterial = async (materialNumber: string, deliveringPlant?: string) => {
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${tenant.client}, ${materialNumber}, ${`Terms test ${materialNumber}`}, 'RAW', 'UNT', ${ACTOR})
        on conflict do nothing
      `);
      for (const site of [PLANT, SECOND_PLANT]) {
        await tx.execute(sql`
          insert into material_plant (client, material_number, plant, safety_stock, created_by)
          values (${tenant.client}, ${materialNumber}, ${site}, 0, ${ACTOR})
          on conflict (client, material_number, plant) do update set safety_stock = 0
        `);
      }
    });
    await maintainMaterialSales(tenant, { materialNumber, deliveringPlant: deliveringPlant || PLANT });
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      customerNumber: '', materialNumber, currency: 'USD', amount: 25, priceUnit: 1,
      validityFrom: '2026-01-01', validityTo: '2026-12-31',
    });
  };

  /** What a customer's own sales area says about where their goods come from and how they travel. */
  const setSalesArea = async (partnerNumber: string, patch: {
    deliveringPlant?: string | null;
    completeDelivery?: boolean;
    orderCombination?: boolean;
    partialDeliveryIndicator?: string;
    maxPartialDeliveries?: number;
  }) => {
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`update customer_sales_area set
          delivering_plant = case when ${patch.deliveringPlant === undefined} then delivering_plant
                                  else nullif(${patch.deliveringPlant ?? ''}, '') end,
          complete_delivery = coalesce(${patch.completeDelivery ?? null}::boolean, complete_delivery),
          order_combination = coalesce(${patch.orderCombination ?? null}::boolean, order_combination),
          partial_delivery_indicator = coalesce(${patch.partialDeliveryIndicator ?? null}::varchar, partial_delivery_indicator),
          max_partial_deliveries = coalesce(${patch.maxPartialDeliveries ?? null}::smallint, max_partial_deliveries)
        where client = ${tenant.client} and partner_number = ${partnerNumber}
          and sales_org = '1000' and distribution_channel = '10' and division = '01'`);
    });
  };

  const order = async (materialNumber: string, quantity = 10, plant?: string) => createSalesOrder({
    ...base,
    requestKey: key(`order-${materialNumber}`),
    lines: [{
      lineNumber: undefined, materialNumber, plant: plant as string,
      orderQuantity: quantity, quantityUnit: 'UNT', taxCode: 'T10',
    }],
  }, { authorization: await salesAuthority(base.client) });

  /** Raise a delivery for one item of an order, and return the delivery number. */
  const ship = async (orderNumber: string, quantity: string, what: string, extra: object = {}) => createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber, deliveryDate: DATE,
      items: [{ orderLineNumber: 10, quantity, ...extra }], requestKey: key(what),
    }, { authorization: await salesAuthority(base.client) });

  beforeAll(async () => {
    tenant = await createTenant('sd9247-delivery-terms');
    base.client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(tenant.client, async (tx) => {
      for (const range of [
        { objectCode: 'SALESORD', subObject: 'OR', prefix: 'SO', numberLength: 7 },
        { objectCode: 'DELIVERY', subObject: 'LF', prefix: 'DL', numberLength: 7 },
      ]) {
        await defineRange(tx, { client: tenant.client, createdBy: ACTOR, ...range });
      }
      await assignSalesAreaDimensions(tenant, '1000', [{ distributionChannel: '10', division: '01' }]);
      await tx.execute(sql`
        insert into unit_of_measure (code, name, dimension, decimal_places, is_base_unit)
        values ('UNT', 'Test counted unit', 'COUNT', 0, false)
        on conflict (code) do update set decimal_places = excluded.decimal_places
      `);
      await tx.execute(sql`
        insert into sales_org (client, sales_org, company_code, currency, created_by)
        values (${tenant.client}, '1000', '1000', 'USD', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into sales_area (client, sales_org, distribution_channel, division, name, created_by)
        values (${tenant.client}, '1000', '10', '01', 'Terms test sales area', ${ACTOR}) on conflict do nothing
      `);
      // The second plant the master can answer with. Same company, so the sales area accepts it.
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${tenant.client}, ${SECOND_PLANT}, 'Second test plant', '1000', 'KW', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
        values (${tenant.client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into credit_control_area (client, credit_control_area, name, currency, warning_threshold_percent, created_by)
        values (${tenant.client}, ${AREA}, 'Terms test credit area', 'USD', 90, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into credit_risk_category (client, risk_category, name, created_by)
        values (${tenant.client}, 'A', 'Low risk', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`update company_code set credit_control_area = ${AREA}
        where client = ${tenant.client} and company_code = '1000'`);
      for (const partner of [CUSTOMER, SHIP_TO, OTHER_SHIP_TO, NO_AREA_SHIP_TO]) {
        await tx.execute(sql`
          insert into business_partner (client, partner_number, category, name, city, street, created_by)
          values (${tenant.client}, ${partner}, 'ORGANIZATION', ${`Terms test ${partner}`},
                  'Kuwait City', 'Test street', ${ACTOR})
          on conflict (client, partner_number) do nothing
        `);
        await tx.execute(sql`
          insert into bp_role (client, partner_number, role_code, created_by)
          values (${tenant.client}, ${partner}, 'CUSTOMER', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into customer_company_code (client, partner_number, role_code, company_code, chart_of_accounts,
                                             reconciliation_account, payment_terms_code, created_by)
          values (${tenant.client}, ${partner}, 'CUSTOMER', '1000', 'CA01', '110000', 'NET30', ${ACTOR})
          on conflict do nothing
        `);
        if (partner !== NO_AREA_SHIP_TO) {
          await tx.execute(sql`
            insert into customer_sales_area (client, partner_number, role_code, sales_org, distribution_channel, division,
                                             pricing_procedure, is_blocked, sales_status, created_by)
            values (${tenant.client}, ${partner}, 'CUSTOMER', '1000', '10', '01', 'PR01', false, 'MAINTAINED', ${ACTOR})
            on conflict (client, partner_number, sales_org, distribution_channel, division)
            do update set is_blocked = false, sales_status = 'MAINTAINED'
          `);
        }
      }
      await tx.execute(sql`
        insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
        values (${tenant.client}, 'KW', 'T10', 'Output tax 10 percent', 'VAT', 10, ${ACTOR}) on conflict do nothing
      `);
    });

    for (const partner of [CUSTOMER, SHIP_TO, OTHER_SHIP_TO]) {
      await saveCustomerCredit({
        client: tenant.client, changedBy: ACTOR, customer: partner, creditControlArea: AREA,
        creditLimit: '1000000.00', riskCategory: 'A', isBlocked: false, changeReason: 'Terms test credit data.',
      });
    }

    // The goods go to the ship-to, so it is the ship-to's master that answers first.
    await saveCustomerPartner({
      client: tenant.client, changedBy: ACTOR, partnerNumber: CUSTOMER,
      salesOrg: '1000', distributionChannel: '10', division: '01',
      functionCode: 'SH', assignedPartnerNumber: SHIP_TO,
    });

    // The second plant needs a dock of its own, or nothing can be delivered from it.
    await defineShippingPoint({
      client: tenant.client, changedBy: ACTOR, shippingPoint: SECOND_PLANT, name: 'Second plant dock',
    });
    await assignShippingPoint({
      client: tenant.client, changedBy: ACTOR, deliveringPlant: SECOND_PLANT, shippingPoint: SECOND_PLANT,
    });

    for (const material of ['M001', 'M002', 'M003', 'M004', 'M005', 'M006', 'M007', 'M008']) {
      await addMaterial(`SD9247${material}`);
    }
  });

  afterAll(async () => {
    await destroyTenant(tenant.client);
  });

  it('takes the plant the goods are going to from the ship-to the order names', async () => {
    await setSalesArea(SHIP_TO, { deliveringPlant: SECOND_PLANT });
    const placed = await order('SD9247M001');
    const read = await getSalesOrder(tenant.client, placed.orderNumber);
    // The item named no plant at all, and the master did.
    expect(read!.lines[0].plant).toBe(SECOND_PLANT);
    await setSalesArea(SHIP_TO, { deliveringPlant: null });
  });

  it('falls back to the sold-to where the ship-to keeps no sales area of their own', async () => {
    await saveCustomerPartner({
      client: tenant.client, changedBy: ACTOR, partnerNumber: CUSTOMER,
      salesOrg: '1000', distributionChannel: '10', division: '01',
      functionCode: 'SH', assignedPartnerNumber: NO_AREA_SHIP_TO,
    });
    await setSalesArea(CUSTOMER, { deliveringPlant: SECOND_PLANT });
    const placed = await order('SD9247M002');
    const read = await getSalesOrder(tenant.client, placed.orderNumber);
    expect(read!.lines[0].plant).toBe(SECOND_PLANT);
    await setSalesArea(CUSTOMER, { deliveringPlant: null });
    await saveCustomerPartner({
      client: tenant.client, changedBy: ACTOR, partnerNumber: CUSTOMER,
      salesOrg: '1000', distributionChannel: '10', division: '01',
      functionCode: 'SH', assignedPartnerNumber: SHIP_TO,
    });
  });

  it('falls back to the material’s own sales view where no customer names a plant', async () => {
    await maintainMaterialSales(tenant, { materialNumber: 'SD9247M003', deliveringPlant: SECOND_PLANT });
    const placed = await order('SD9247M003');
    const read = await getSalesOrder(tenant.client, placed.orderNumber);
    expect(read!.lines[0].plant).toBe(SECOND_PLANT);
  });

  it('refuses an item that names no plant when nothing in the master does, naming both screens', async () => {
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update customer_sales_area set delivering_plant = null where client = ${tenant.client}`));
    await withTenant(tenant.client, (tx) => tx.execute(sql`update material_sales
      set delivering_plant = null where client = ${tenant.client} and material_number = 'SD9247M004'`));
    await expect(order('SD9247M004')).rejects.toThrow(
      /No delivering plant is determined for material SD9247M004 and customer SD9247CUST2/,
    );
    // Restored for the tests that follow.
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update customer_sales_area set delivering_plant = ${PLANT} where client = ${tenant.client}`));
    await maintainMaterialSales(tenant, { materialNumber: 'SD9247M004', deliveringPlant: PLANT });
  });

  it('keeps the plant a person named, and does not second-guess it', async () => {
    await setSalesArea(SHIP_TO, { deliveringPlant: SECOND_PLANT });
    const placed = await order('SD9247M005', 10, PLANT);
    const read = await getSalesOrder(tenant.client, placed.orderNumber);
    // A proposal honoured is a proposal: the master said 2000, the person said 1000, and the
    // document is the day it was raised.
    expect(read!.lines[0].plant).toBe(PLANT);
    await setSalesArea(SHIP_TO, { deliveringPlant: null });
  });

  it('refuses to let a part of the order go out where the customer asked for the whole of it', async () => {
    await setSalesArea(SHIP_TO, { completeDelivery: true });
    const placed = await order('SD9247M006', 10);
    await expect(ship(placed.orderNumber, '4', 'complete-part')).rejects.toThrow(
      /Customer SD9247CUST2 requires a complete delivery, and 4 of the 10.000 UNT open on item 10/,
    );
    const whole = await ship(placed.orderNumber, '10', 'complete-whole');
    expect(whole.deliveryNumber).toBeTruthy();
    await setSalesArea(SHIP_TO, { completeDelivery: false });
  });

  it('refuses to leave an item behind where the customer asked for the whole order', async () => {
    const placed = await createSalesOrder({
      ...base, requestKey: key('two-items'),
      lines: [
        { lineNumber: undefined, materialNumber: 'SD9247M007', plant: PLANT, orderQuantity: 3, quantityUnit: 'UNT', taxCode: 'T10' },
        { lineNumber: undefined, materialNumber: 'SD9247M007', plant: PLANT, orderQuantity: 3, quantityUnit: 'UNT', taxCode: 'T10' },
      ],
    }, { authorization: await salesAuthority(base.client) });
    const open = await listDeliverableOrderLines(tenant.client, { orderNumber: placed.orderNumber });
    await setSalesArea(SHIP_TO, { completeDelivery: true });
    await expect(createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: placed.orderNumber, deliveryDate: DATE,
      items: [{ orderLineNumber: open[0].lineNumber, quantity: '3' }], requestKey: key('leaves-one'),
    }, { authorization: await salesAuthority(base.client) })).rejects.toThrow(/requires a complete delivery of order .*, and item 20 is being left behind/);
    await setSalesArea(SHIP_TO, { completeDelivery: false });
  });

  it('refuses a part of an item the customer said travels complete, and takes the whole of it', async () => {
    await setSalesArea(SHIP_TO, { partialDeliveryIndicator: 'C' });
    const placed = await order('SD9247M008', 10);
    await expect(ship(placed.orderNumber, '6', 'indicator-part')).rejects.toThrow(
      /Customer SD9247CUST2 allows no partial deliveries, and 6 of the 10.000 UNT open on item 10/,
    );
    const whole = await ship(placed.orderNumber, '10', 'indicator-whole');
    expect(whole.deliveryNumber).toBeTruthy();
    await setSalesArea(SHIP_TO, { partialDeliveryIndicator: '' });
  });

  it('allows one partial delivery where the customer allowed one, and then wants the rest together', async () => {
    await setSalesArea(SHIP_TO, { maxPartialDeliveries: 1 });
    const placed = await order('SD9247M001', 10);
    // The first split is the one they allowed.
    const first = await ship(placed.orderNumber, '4', 'max-first');
    expect(first.deliveryNumber).toBeTruthy();
    // The second is not: one partial delivery stands against the item, and one was all they allowed.
    await expect(ship(placed.orderNumber, '3', 'max-second')).rejects.toThrow(
      /Customer SD9247CUST2 allows 1 partial delivery of an item, and 1 already stand against item 10/,
    );
    const rest = await ship(placed.orderNumber, '6', 'max-rest');
    expect(rest.deliveryNumber).toBeTruthy();
    await setSalesArea(SHIP_TO, { maxPartialDeliveries: 0 });
  });

  it('gathers two orders into one delivery where the customer allows their orders to be combined', async () => {
    await setSalesArea(SHIP_TO, { orderCombination: true });
    const first = await order('SD9247M002', 5);
    const second = await order('SD9247M002', 5);
    const combined = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: first.orderNumber, deliveryDate: DATE,
      items: [
        { orderNumber: first.orderNumber, orderLineNumber: 10, quantity: '5' },
        { orderNumber: second.orderNumber, orderLineNumber: 10, quantity: '5' },
      ],
      requestKey: key('combined'),
    }, { authorization: await salesAuthority(base.client) });
    expect(combined.deliveryNumber).toBeTruthy();
    await setSalesArea(SHIP_TO, { orderCombination: false });
  });

  it('refuses to gather the orders of a customer who does not allow it', async () => {
    const first = await order('SD9247M003', 5);
    const second = await order('SD9247M003', 5);
    await expect(createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: first.orderNumber, deliveryDate: DATE,
      items: [
        { orderNumber: first.orderNumber, orderLineNumber: 10, quantity: '5' },
        { orderNumber: second.orderNumber, orderLineNumber: 10, quantity: '5' },
      ],
      requestKey: key('no-combination'),
    }, { authorization: await salesAuthority(base.client) })).rejects.toThrow(/Customer SD9247CUST2 does not allow their orders to be combined, so order .* travels alone/);
  });

  it('refuses to gather orders that are going to two different addresses', async () => {
    await setSalesArea(SHIP_TO, { orderCombination: true });
    const first = await order('SD9247M004', 5);
    // The same customer, but from here on their goods go somewhere else: the row naming the sales
    // area stands over the row naming none, and the order written after it carries the new address.
    await saveCustomerPartner({
      client: tenant.client, changedBy: ACTOR, partnerNumber: CUSTOMER,
      salesOrg: '1000', distributionChannel: '10', division: '01',
      functionCode: 'SH', assignedPartnerNumber: OTHER_SHIP_TO,
    });
    const second = await order('SD9247M004', 5);
    await expect(createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: first.orderNumber, deliveryDate: DATE,
      items: [
        { orderNumber: first.orderNumber, orderLineNumber: 10, quantity: '5' },
        { orderNumber: second.orderNumber, orderLineNumber: 10, quantity: '5' },
      ],
      requestKey: key('two-addresses'),
    }, { authorization: await salesAuthority(base.client) })).rejects.toThrow(/ships to SD9247CUST3, and this delivery ships to SD9247CUST2/);
    await saveCustomerPartner({
      client: tenant.client, changedBy: ACTOR, partnerNumber: CUSTOMER,
      salesOrg: '1000', distributionChannel: '10', division: '01',
      functionCode: 'SH', assignedPartnerNumber: SHIP_TO,
    });
    await setSalesArea(SHIP_TO, { orderCombination: false });
  });

  it('maintains how much of an item may go out at once, and refuses a value that is not one', async () => {
    const input = (patch: Partial<CustomerSalesAreaInput> = {}): CustomerSalesAreaInput => ({
      client: tenant.client, partnerNumber: OTHER_SHIP_TO, salesOrg: '1000',
      distributionChannel: '10', division: '01', expectedVersion: 0, changedBy: ACTOR,
      reason: 'Terms test maintenance', salesDistrict: '', accountAssignmentGroup: '',
      deliveringPlant: PLANT, pricingProcedure: 'PR01',
      completeDelivery: false, orderCombination: false, isBlocked: false, ...patch,
    });
    // The row was written by the fixture, so the save stands on the version the fixture left.
    const opened = await getCustomerSalesArea(tenant.client, OTHER_SHIP_TO, '1000', '10', '01');
    const saved = await saveCustomerSalesArea(input({
      expectedVersion: opened?.version ?? 0, partialDeliveryIndicator: 'C', maxPartialDeliveries: 2,
    }));
    const row = await getCustomerSalesArea(tenant.client, OTHER_SHIP_TO, '1000', '10', '01');
    expect(row).toMatchObject({ partialDeliveryIndicator: 'C', maxPartialDeliveries: 2 });
    expect(saved.changed).toBe(true);

    await expect(saveCustomerSalesArea(input({
      expectedVersion: row!.version, partialDeliveryIndicator: 'X',
    }))).rejects.toThrow(/partial delivery indicator/i);
    await expect(saveCustomerSalesArea(input({
      expectedVersion: row!.version, maxPartialDeliveries: 10,
    }))).rejects.toThrow();

    // Blank and zero are the values a customer who has said nothing carries, and they are accepted.
    const cleared = await saveCustomerSalesArea(input({
      expectedVersion: row!.version, partialDeliveryIndicator: '', maxPartialDeliveries: 0,
    }));
    expect(cleared.changed).toBe(true);
  });
});
