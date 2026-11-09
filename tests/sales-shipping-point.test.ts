/**
 * DI-020 (§3.3) — where the goods leave from.
 *
 * A delivery has always named the plant its stock stands in. The dock inside that plant is a
 * different question, and until now nobody asked it: the plant was the answer, and the person
 * raising the delivery was never asked to name a gate, a ramp or a bay.
 *
 * Three things answer it, and none of them is entered on the delivery: the shipping condition of
 * the customer the goods are going to, the loading group of the material being sent, and the
 * delivering plant. Together they name a shipping point through a table the tenant maintains, the
 * way OVL2 does.
 *
 * What these tests hold to:
 *
 * The row naming the most keys answers, and blank is a value that is matched — a customer who has
 * said nothing is answered by the rows that name no condition, never by a condition invented for
 * them.
 *
 * Where the condition and the loading group both have something to say and no row says both, the
 * material's group stands. A dock that cannot lift the goods is no answer at all, whereas a
 * customer who wants them quickly can be served from anywhere that can load them.
 *
 * Where nothing answers, the delivery is refused and names the screen. A delivery with no dock is
 * a delivery nobody can pick.
 *
 * And a delivery carries the address it was raised with, so remaking a customer next month does
 * not move this month's goods.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveCustomerCredit } from '../src/modules/finance/credit';
import { saveSalesCondition } from '../src/modules/sales/conditions';
import { saveCustomerPartner } from '../src/modules/sales/partners';
import {
  ShippingPointMaintenanceError,
  assignShippingPoint,
  changeShippingPointAssignmentStatus,
  changeShippingConditionStatus,
  changeShippingPointStatus,
  defineShippingCondition,
  defineShippingPoint,
  listShippingPointConfiguration,
} from '../src/modules/sales/shipping-point-maintenance';
import { ShippingPointError, shippingPointFor } from '../src/modules/sales/shipping-point';
import { createSalesOrder } from '../src/modules/sales/sales-order';
import {
  createDelivery, getDelivery, listDeliverableOrderLines,
} from '../src/modules/sales/delivery';
import {
  assignSalesAreaDimensions, createTenant, defineTestRanges, destroyTenant, maintainMaterialSales,
  type TestTenant,
} from './helpers';

const ACTOR = 'SD9245_DOCK';
const AREA = 'CA45';
const CUSTOMER = 'SD9245CUST1';
const SHIP_TO = 'SD9245CUST2';
const PLANT = '1000';
const DATE = '2026-10-15';

/**
 * The docks. Each is a place, and none of them carries a plant: the rows below do that.
 *
 * MAIN is the one the fixture hands every configured tenant — the standard plant's own dock, with a
 * row naming it for whatever that plant has no opinion about. It is the row these tests read when
 * nobody has said anything.
 */
const MAIN = '1000';
const FAST = 'FAST';
const CRANE = 'CRAN';
const FAST_CRANE = 'FSTC';
const FAST_TWO = 'FST2';
const PALLET = 'PALT';
const GONE = 'GONE';

/** The conditions customers ask under. */
const EXPRESS = '01';
const EXPRESS_TWO = '02';
const WITHDRAWN_CONDITION = 'ZZ';

/** What the materials take to load. */
const NEEDS_CRANE = 'CRAT';
const ON_PALLETS = 'PAL2';
const THROUGH_A_WITHDRAWN_DOCK = 'GON1';

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
const key = (what: string) => `sd9245-${what}-${++counter}`;

describe('where the goods leave from', () => {
  let tenant: TestTenant;

  const addMaterial = async (materialNumber: string, loadingGroup?: string) => {
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${tenant.client}, ${materialNumber}, ${`Dock test ${materialNumber}`}, 'RAW', 'UNT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, safety_stock, created_by)
        values (${tenant.client}, ${materialNumber}, ${PLANT}, 0, ${ACTOR})
        on conflict (client, material_number, plant) do update set safety_stock = 0
      `);
    });
    await maintainMaterialSales(tenant, { materialNumber, deliveringPlant: PLANT, loadingGroup });
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      customerNumber: '', materialNumber, currency: 'USD', amount: 25, priceUnit: 1,
      validityFrom: '2026-01-01', validityTo: '2026-12-31',
    });
  };

  /** What a customer has asked for, maintained on their own sales area. */
  const setCondition = async (partnerNumber: string, shippingCondition: string | null) => {
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`update customer_sales_area set shipping_condition = ${shippingCondition}
        where client = ${tenant.client} and partner_number = ${partnerNumber}
          and sales_org = '1000' and distribution_channel = '10' and division = '01'`);
    });
  };

  const order = (materialNumbers: string[]) => createSalesOrder({
    ...base,
    requestKey: key('order'),
    lines: materialNumbers.map((materialNumber) => ({
      lineNumber: undefined, materialNumber, plant: PLANT, orderQuantity: 2, quantityUnit: 'UNT', taxCode: 'T10',
    })),
  });

  /** Raise a delivery for every line of the order, and read back the dock it was given. */
  const ship = async (orderNumber: string) => {
    const open = await listDeliverableOrderLines(tenant.client, { orderNumber });
    const shipped = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber, deliveryDate: DATE,
      items: open.map((line) => ({ orderLineNumber: line.lineNumber, quantity: '2' })),
      requestKey: key('delivery'),
    });
    return getDelivery(tenant.client, shipped.deliveryNumber);
  };

  beforeAll(async () => {
    tenant = await createTenant('sd9245-shipping-point');
    base.client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(tenant.client, async (tx) => {
      for (const range of [
        { objectCode: 'SALESORD', subObject: 'OR', prefix: 'SO', numberLength: 7 },
        { objectCode: 'DELIVERY', subObject: 'LF', prefix: 'DL', numberLength: 7 },
        { objectCode: 'MATDOC', subObject: '*', prefix: 'MD', numberLength: 8 },
        { objectCode: 'CUSTINV', subObject: '*', prefix: 'CI', numberLength: 7 },
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
        insert into sales_org_text (client, sales_org, language_key, name, created_by)
        values (${tenant.client}, '1000', 'E', 'Dock test sales organization', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into sales_area (client, sales_org, distribution_channel, division, name, created_by)
        values (${tenant.client}, '1000', '10', '01', 'Dock test sales area', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${tenant.client}, ${PLANT}, 'Dock test plant', '1000', 'KW', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
        values (${tenant.client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into credit_control_area (client, credit_control_area, name, currency, warning_threshold_percent, created_by)
        values (${tenant.client}, ${AREA}, 'Dock test credit area', 'USD', 90, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into credit_risk_category (client, risk_category, name, created_by)
        values (${tenant.client}, 'A', 'Low risk', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`update company_code set credit_control_area = ${AREA}
        where client = ${tenant.client} and company_code = '1000'`);
      for (const partner of [CUSTOMER, SHIP_TO]) {
        await tx.execute(sql`
          insert into business_partner (client, partner_number, category, name, city, street, created_by)
          values (${tenant.client}, ${partner}, 'ORGANIZATION', ${`Dock test ${partner}`},
                  ${`City of ${partner}`}, ${`Street of ${partner}`}, ${ACTOR})
          on conflict (client, partner_number) do update
            set city = excluded.city, street = excluded.street
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
        await tx.execute(sql`
          insert into customer_sales_area (client, partner_number, role_code, sales_org, distribution_channel, division,
                                           pricing_procedure, is_blocked, sales_status, created_by)
          values (${tenant.client}, ${partner}, 'CUSTOMER', '1000', '10', '01', 'PR01', false, 'MAINTAINED', ${ACTOR})
          on conflict (client, partner_number, sales_org, distribution_channel, division)
          do update set is_blocked = false, sales_status = 'MAINTAINED'
        `);
      }
      await tx.execute(sql`
        insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
        values (${tenant.client}, 'KW', 'T10', 'Output tax 10 percent', 'VAT', 10, ${ACTOR}) on conflict do nothing
      `);
    });

    await saveCustomerCredit({
      client: tenant.client, changedBy: ACTOR, customer: CUSTOMER, creditControlArea: AREA,
      creditLimit: '1000000.00', riskCategory: 'A', isBlocked: false, changeReason: 'Dock test credit data.',
    });

    // The goods are going to the ship-to, not to the sold-to: which is the whole reason a delivery
    // names one at all.
    await saveCustomerPartner({
      client: tenant.client, changedBy: ACTOR, partnerNumber: CUSTOMER,
      salesOrg: '1000', distributionChannel: '10', division: '01',
      functionCode: 'SH', assignedPartnerNumber: SHIP_TO,
    });

    // The docks, the conditions, and the table that puts them together.
    // MAIN stands already: the fixture's own dock, named 'Main dock', assigned to the standard plant
    // for everything that plant has no opinion about. The rest are this file's.
    for (const [shippingPoint, name] of [
      [FAST, 'Express dock'], [CRANE, 'Crane bay'], [FAST_CRANE, 'Express crane bay'],
      [FAST_TWO, 'Second express dock'], [PALLET, 'Pallet dock'], [GONE, 'Dock that stopped loading'],
    ] as const) {
      await defineShippingPoint({ client: tenant.client, changedBy: ACTOR, shippingPoint, name });
    }
    for (const [shippingCondition, description] of [
      [EXPRESS, 'Express, next day'], [EXPRESS_TWO, 'Express, second day'],
      [WITHDRAWN_CONDITION, 'Withdrawn, nobody may ask for it'],
    ] as const) {
      await defineShippingCondition({ client: tenant.client, changedBy: ACTOR, shippingCondition, description });
    }
    // The row naming neither condition nor group is the fixture's: the standard plant's own dock,
    // already assigned. There can be only one such row, so it is read rather than maintained here.
    const rows: Array<{ shippingCondition?: string; loadingGroup?: string; shippingPoint: string }> = [
      { shippingCondition: EXPRESS, shippingPoint: FAST },
      { loadingGroup: NEEDS_CRANE, shippingPoint: CRANE },
      { shippingCondition: EXPRESS, loadingGroup: NEEDS_CRANE, shippingPoint: FAST_CRANE },
      { shippingCondition: EXPRESS_TWO, shippingPoint: FAST_TWO },
      { loadingGroup: ON_PALLETS, shippingPoint: PALLET },
      { loadingGroup: THROUGH_A_WITHDRAWN_DOCK, shippingPoint: GONE },
    ];
    for (const row of rows) {
      await assignShippingPoint({ client: tenant.client, changedBy: ACTOR, deliveringPlant: PLANT, ...row });
    }
    // Two rows that stand but must not answer: a dock that stopped loading, and a condition nobody
    // may ask for.
    await changeShippingPointStatus({
      client: tenant.client, changedBy: ACTOR, shippingPoint: GONE, isActive: false,
    });
    await changeShippingConditionStatus({
      client: tenant.client, changedBy: ACTOR, shippingCondition: WITHDRAWN_CONDITION, isActive: false,
    });
  });

  afterAll(async () => {
    await destroyTenant(tenant.client);
  });

  it('loads through the dock the plant keeps for everything it has no opinion about', async () => {
    const material = 'SD9245M001';
    await addMaterial(material);
    const placed = await order([material]);
    const read = await ship(placed.orderNumber);
    // Nobody said anything: no condition on the customer, no group on the material. The row naming
    // neither is the plant's own answer, and it is the one that loads.
    expect(read!.shippingPoint).toBe(MAIN);
  });

  it('loads where the customer the goods are going to asked for', async () => {
    const material = 'SD9245M002';
    await addMaterial(material);
    await setCondition(SHIP_TO, EXPRESS);
    const placed = await order([material]);
    const read = await ship(placed.orderNumber);
    // The ship-to's own requirement, not the sold-to's: the goods are going to them.
    expect(read!.shippingPoint).toBe(FAST);
    await setCondition(SHIP_TO, null);
  });

  it('falls back to the sold-to where the ship-to keeps no sales area of their own', async () => {
    const material = 'SD9245M003';
    await addMaterial(material);
    await setCondition(CUSTOMER, EXPRESS);
    const placed = await order([material]);
    const read = await ship(placed.orderNumber);
    expect(read!.shippingPoint).toBe(FAST);
    await setCondition(CUSTOMER, null);
  });

  it('loads where the material can be lifted', async () => {
    const material = 'SD9245M004';
    await addMaterial(material, NEEDS_CRANE);
    const placed = await order([material]);
    const read = await ship(placed.orderNumber);
    expect(read!.shippingPoint).toBe(CRANE);
  });

  it('reads the row naming both before either row naming one', async () => {
    const material = 'SD9245M005';
    await addMaterial(material, NEEDS_CRANE);
    await setCondition(SHIP_TO, EXPRESS);
    const placed = await order([material]);
    const read = await ship(placed.orderNumber);
    // Express and a crane: the row maintained for exactly that, not the express dock and not the
    // crane bay on its own.
    expect(read!.shippingPoint).toBe(FAST_CRANE);
    await setCondition(SHIP_TO, null);
  });

  it('lets the material stand over the customer when no row names both', async () => {
    const material = 'SD9245M006';
    await addMaterial(material, ON_PALLETS);
    await setCondition(SHIP_TO, EXPRESS_TWO);
    const placed = await order([material]);
    const read = await ship(placed.orderNumber);
    // Both have something to say: the customer wants it on the second-day dock, the material needs
    // the pallet dock. A dock that cannot lift the goods is no answer at all.
    expect(read!.shippingPoint).toBe(PALLET);
    await setCondition(SHIP_TO, null);
  });

  it('carries the address it was raised with, and does not move when the master does', async () => {
    const material = 'SD9245M007';
    await addMaterial(material);
    const placed = await order([material]);
    const read = await ship(placed.orderNumber);
    expect(read!.shipTo?.partnerNumber).toBe(SHIP_TO);
    expect(read!.shipTo?.name).toBe(`Dock test ${SHIP_TO}`);
    expect(read!.shipTo?.city).toBe(`City of ${SHIP_TO}`);
    expect(read!.shipTo?.street).toBe(`Street of ${SHIP_TO}`);

    // The customer moves. The goods did not.
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`update business_partner set city = 'Somewhere else entirely'
        where client = ${tenant.client} and partner_number = ${SHIP_TO}`);
    });
    const after = await getDelivery(tenant.client, read!.deliveryNumber);
    expect(after!.shipTo?.city).toBe(`City of ${SHIP_TO}`);
  });

  it('refuses a delivery that would load from two docks', async () => {
    const crane = 'SD9245M008';
    const pallet = 'SD9245M009';
    await addMaterial(crane, NEEDS_CRANE);
    await addMaterial(pallet, ON_PALLETS);
    const placed = await order([crane, pallet]);
    const open = await listDeliverableOrderLines(tenant.client, { orderNumber: placed.orderNumber });
    await expect(createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: placed.orderNumber, deliveryDate: DATE,
      items: open.map((line) => ({ orderLineNumber: line.lineNumber, quantity: '2' })),
      requestKey: key('two-docks'),
    })).rejects.toThrow(/Item \d+ loads through shipping point (PALT|CRAN), and this delivery loads through (CRAN|PALT)\./);
  });

  it('refuses a dock that stopped loading, and names it', async () => {
    const material = 'SD9245M010';
    await addMaterial(material, THROUGH_A_WITHDRAWN_DOCK);
    const placed = await order([material]);
    const open = await listDeliverableOrderLines(tenant.client, { orderNumber: placed.orderNumber });
    await expect(createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: placed.orderNumber, deliveryDate: DATE,
      items: [{ orderLineNumber: open[0].lineNumber, quantity: '2' }], requestKey: key('gone-dock'),
    })).rejects.toThrow(/Shipping point GONE stands withdrawn/);
  });

  it('refuses a condition nobody may ask for, and names it', async () => {
    const material = 'SD9245M011';
    await addMaterial(material);
    await setCondition(SHIP_TO, WITHDRAWN_CONDITION);
    const placed = await order([material]);
    const open = await listDeliverableOrderLines(tenant.client, { orderNumber: placed.orderNumber });
    await expect(createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: placed.orderNumber, deliveryDate: DATE,
      items: [{ orderLineNumber: open[0].lineNumber, quantity: '2' }], requestKey: key('gone-condition'),
    })).rejects.toThrow(/Shipping condition ZZ stands withdrawn/);
    await setCondition(SHIP_TO, null);
  });

  it('refuses a combination nobody maintained, and names the screen', async () => {
    const material = 'SD9245M012';
    await addMaterial(material);
    // Withdraw the express row and the plant's own row: nothing is left to answer for a customer
    // who wants it express and a material with no group.
    await changeShippingPointAssignmentStatus({
      client: tenant.client, changedBy: ACTOR, deliveringPlant: PLANT,
      shippingCondition: EXPRESS, loadingGroup: '', isActive: false,
    });
    await changeShippingPointAssignmentStatus({
      client: tenant.client, changedBy: ACTOR, deliveringPlant: PLANT,
      shippingCondition: '', loadingGroup: '', isActive: false,
    });
    await setCondition(SHIP_TO, EXPRESS);
    const placed = await order([material]);
    const open = await listDeliverableOrderLines(tenant.client, { orderNumber: placed.orderNumber });
    await expect(createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: placed.orderNumber, deliveryDate: DATE,
      items: [{ orderLineNumber: open[0].lineNumber, quantity: '2' }], requestKey: key('no-row'),
    })).rejects.toThrow(/No shipping point is determined for plant 1000 with shipping condition 01 and loading group none/);

    // Restored, because the tests after this one are read as the tenant stands.
    await setCondition(SHIP_TO, null);
    await changeShippingPointAssignmentStatus({
      client: tenant.client, changedBy: ACTOR, deliveringPlant: PLANT,
      shippingCondition: EXPRESS, loadingGroup: '', isActive: true,
    });
    await changeShippingPointAssignmentStatus({
      client: tenant.client, changedBy: ACTOR, deliveringPlant: PLANT,
      shippingCondition: '', loadingGroup: '', isActive: true,
    });
  });

  it('refuses a condition that does not stand, rather than reading it as a customer who said nothing', async () => {
    await expect(withTenant(tenant.client, (tx) => shippingPointFor(tx, tenant.client, {
      deliveringPlant: PLANT, shippingCondition: 'QQ', loadingGroup: '',
    }))).rejects.toThrow(ShippingPointError);
    await expect(withTenant(tenant.client, (tx) => shippingPointFor(tx, tenant.client, {
      deliveringPlant: PLANT, shippingCondition: 'QQ', loadingGroup: '',
    }))).rejects.toThrow(/Shipping condition QQ does not stand for this tenant/);
  });

  it('refuses a second row for one combination, because the engine would have to choose', async () => {
    await expect(assignShippingPoint({
      client: tenant.client, changedBy: ACTOR, deliveringPlant: PLANT,
      shippingCondition: EXPRESS, shippingPoint: FAST_TWO,
    })).rejects.toThrow(ShippingPointMaintenanceError);
    await expect(assignShippingPoint({
      client: tenant.client, changedBy: ACTOR, deliveringPlant: PLANT,
      shippingCondition: EXPRESS, shippingPoint: FAST_TWO,
    })).rejects.toThrow(/A shipping point already stands for plant 1000 with shipping condition 01/);
  });

  it('refuses an assignment naming a plant or a dock that does not stand', async () => {
    await expect(assignShippingPoint({
      client: tenant.client, changedBy: ACTOR, deliveringPlant: 'NOPE', shippingPoint: MAIN,
    })).rejects.toThrow(/Plant NOPE does not stand for this tenant/);
    await expect(assignShippingPoint({
      client: tenant.client, changedBy: ACTOR, deliveringPlant: PLANT, shippingPoint: 'NOPE',
    })).rejects.toThrow(/Shipping point NOPE does not stand for this tenant/);
    await expect(assignShippingPoint({
      client: tenant.client, changedBy: ACTOR, deliveringPlant: PLANT,
      shippingCondition: 'QQ', shippingPoint: MAIN,
    })).rejects.toThrow(/Shipping condition QQ does not stand for this tenant/);
  });

  it('reads the whole configuration back as the screen shows it', async () => {
    const configuration = await listShippingPointConfiguration(tenant.client);
    const assigned = configuration.assignments.find((row) => row.deliveringPlant === PLANT
      && row.shippingCondition === '' && row.loadingGroup === '');
    expect(assigned?.shippingPoint).toBe(MAIN);
    expect(assigned?.shippingPointName).toBe('Main dock');
    expect(assigned?.pointStands).toBe(true);
    const withdrawn = configuration.assignments.find((row) => row.shippingPoint === GONE);
    expect(withdrawn?.pointStands).toBe(false);
    expect(configuration.points.find((row) => row.shippingPoint === MAIN)?.assignments).toBe(1);
    expect(configuration.loadingGroups).toContain(NEEDS_CRANE);
  });
});
