/**
 * DI-020 (§3.2) — what the plant can promise.
 *
 * An order asked for a quantity and got it. Nothing between the customer's request and the delivery
 * ever asked whether the goods were there: the order line carried one quantity, and the delivery
 * offered whatever was left of it. A plant that could supply six of the ten a customer ordered had no
 * way to say so, and no way to say it differently a week later when the rest arrived.
 *
 * Five properties carry the step.
 *
 * What was confirmed is what the delivery is created from, and not what was ordered: a plant that
 * promised six ships six and owes four.
 *
 * Stock promised to one order is not promised again to the next, which is the only failure an
 * availability check exists to prevent.
 *
 * A material nobody configured a check for is confirmed in full — a promise of nothing to a customer
 * nobody decided to check is a broken promise made by a configuration the tenant never asked for.
 *
 * The check is asked again at the door, because a promise made when the order was entered is a
 * promise about that day's stock.
 *
 * And a scope the check cannot count is a refusal that names the screen, never a silence that counts
 * less than it was configured to and says nothing.
 *
 * Every material here carries its own stock and its own promises, so a test is never a test of the
 * orders the tests before it left behind.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveCustomerCredit } from '../src/modules/finance/credit';
import { saveSalesCondition } from '../src/modules/sales/conditions';
import {
  DELIVERY_CHECKING_RULE, ORDER_CHECKING_RULE,
} from '../src/modules/sales/availability';
import {
  saveCheckingGroup, saveCheckingRule, saveScopeOfCheck,
} from '../src/modules/production/availability-check';
import { changeSalesOrder, createSalesOrder, getSalesOrder } from '../src/modules/sales/sales-order';
import {
  confirmDeliveryPicks, createDelivery, getDelivery, listDeliverableOrderLines, postDeliveryGoodsIssue,
} from '../src/modules/sales/delivery';
import {
  assignSalesAreaDimensions, createTenant, defineTestRanges, destroyTenant, maintainMaterialSales,
  type TestTenant,
} from './helpers';
import { createSalesActor, refreshSalesActor, type SalesActor } from './helpers/sales-actor';

const ACTOR = 'SD9243_ATP';
const AREA = 'CA43';
const CUSTOMER = 'SD9243CUST1';
const GROUP = '01';
const NO_CHECK_GROUP = '02';
const MISSING_GROUP = '99';
const PLANT = '1000';
const STORE = '0001';
const DATE = '2026-10-15';
/** Stock every material is opened at. The safety stock is what makes it scarce. */
const STOCK = 100;

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

/** One material per test, so no test is a test of the promises another left behind. */
const MAT = {
  confirms: 'SD9243M001',
  second: 'SD9243M002',
  unchecked: 'SD9243M003',
  delivery: 'SD9243M004',
  door: 'SD9243M005',
  change: 'SD9243M006',
  scope: 'SD9243M007',
  group: 'SD9243M008',
  noCheck: 'SD9243M009',
};

const BLANK_FLAGS = {
  includeSafetyStock: ' ',
  includeQualityStock: ' ',
  includeBlockedStock: ' ',
  includeRestrictedUse: ' ',
  purchaseOrders: ' ',
  purchaseRequisitions: ' ',
  plannedOrders: ' ',
  productionOrders: ' ',
  dependentRequirements: ' ',
  reservations: ' ',
  receiptsInPast: ' ',
};

let counter = 0;
const key = (what: string) => `sd9243-${what}-${++counter}`;


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

describe('what the plant can promise', () => {
  let tenant: TestTenant;

  /** Make the plant's surplus what the test needs it to be. The stock never moves; the reserve does. */
  const setSafetyStock = async (materialNumber: string, quantity: number) => {
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`update material_plant set safety_stock = ${quantity}
        where client = ${tenant.client} and material_number = ${materialNumber} and plant = ${PLANT}`);
    });
  };

  const addMaterial = async (materialNumber: string, checkingGroup: string | null) => {
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${tenant.client}, ${materialNumber}, ${`ATP test ${materialNumber}`}, 'RAW', 'UNT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, safety_stock, created_by)
        values (${tenant.client}, ${materialNumber}, ${PLANT}, 0, ${ACTOR})
        on conflict (client, material_number, plant) do update set safety_stock = 0
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency,
                                        total_stock_quantity, stock_value, created_by)
        values (${tenant.client}, ${materialNumber}, ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1, 'USD',
                ${STOCK}, ${STOCK * 10}, ${ACTOR})
        on conflict (client, material_number, valuation_area)
        do update set total_stock_quantity = excluded.total_stock_quantity, stock_value = excluded.stock_value
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        values (${tenant.client}, ${materialNumber}, ${PLANT}, ${STORE}, 'UNRESTRICTED', ${STOCK}, ${ACTOR})
        on conflict (client, material_number, plant, storage_location, stock_type, batch_number)
        do update set quantity = excluded.quantity
      `);
    });
    await maintainMaterialSales(tenant, {
      materialNumber, deliveringPlant: PLANT, availabilityCheckGroup: checkingGroup ?? undefined,
    });
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      customerNumber: '', materialNumber, currency: 'USD', amount: 25, priceUnit: 1,
      validityFrom: '2026-01-01', validityTo: '2026-12-31',
    });
  };

  const order = async (materialNumber: string, quantity: number) => createSalesOrder({
    ...base, requestKey: key(`${materialNumber}-order`),
    lines: [{ lineNumber: undefined, materialNumber, plant: PLANT, orderQuantity: quantity, quantityUnit: 'UNT', taxCode: 'T10' }],
  }, { authorization: await salesAuthority(base.client) });

  beforeAll(async () => {
    tenant = await createTenant('sd9243-atp');
    base.client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(tenant.client, async (tx) => {
      for (const range of [
        { objectCode: 'SALESORD', subObject: 'OR', prefix: 'SO', numberLength: 7 },
        { objectCode: 'DELIVERY', subObject: 'LF', prefix: 'DL', numberLength: 7 },
        { objectCode: 'BILLING', subObject: 'F2', prefix: 'INV', numberLength: 7 },
        { objectCode: 'BILLING', subObject: 'G2', prefix: 'CM', numberLength: 7 },
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
        values (${tenant.client}, '1000', 'E', 'ATP test sales organization', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into sales_area (client, sales_org, distribution_channel, division, name, created_by)
        values (${tenant.client}, '1000', '10', '01', 'ATP test sales area', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${tenant.client}, ${PLANT}, 'ATP test plant', '1000', 'KW', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
        values (${tenant.client}, ${PLANT}, ${STORE}, 'Main store', true, false, ${ACTOR})
        on conflict (client, plant, storage_location) do update set is_active = excluded.is_active
      `);
      await tx.execute(sql`
        insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
        values (${tenant.client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
      `);
      // Credit: the chain refuses to deliver an unrecorded customer, and a fixture that cannot
      // deliver cannot show what a delivery is created from.
      await tx.execute(sql`
        insert into credit_control_area (client, credit_control_area, name, currency, warning_threshold_percent, created_by)
        values (${tenant.client}, ${AREA}, 'ATP test credit area', 'USD', 90, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into credit_risk_category (client, risk_category, name, created_by)
        values (${tenant.client}, 'A', 'Low risk', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`update company_code set credit_control_area = ${AREA}
        where client = ${tenant.client} and company_code = '1000'`);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, city, street, created_by)
        values (${tenant.client}, ${CUSTOMER}, 'ORGANIZATION', 'ATP test customer', 'City', 'Street', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${tenant.client}, ${CUSTOMER}, 'CUSTOMER', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into customer_company_code (client, partner_number, role_code, company_code, chart_of_accounts,
                                           reconciliation_account, payment_terms_code, created_by)
        values (${tenant.client}, ${CUSTOMER}, 'CUSTOMER', '1000', 'CA01', '110000', 'NET30', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into customer_sales_area (client, partner_number, role_code, sales_org, distribution_channel, division,
                                         pricing_procedure, is_blocked, sales_status, created_by)
        values (${tenant.client}, ${CUSTOMER}, 'CUSTOMER', '1000', '10', '01', 'PR01', false, 'MAINTAINED', ${ACTOR})
        on conflict (client, partner_number, sales_org, distribution_channel, division)
        do update set is_blocked = false, sales_status = 'MAINTAINED'
      `);
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
        values (${tenant.client}, 'OPENING_BALANCE', 'Opening balance', 'RECEIPT', 'MATERIAL_DOCUMENT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                             previous_fiscal_year, previous_period, allow_backposting, created_by)
        values (${tenant.client}, '1000', 2026, 10, 2026, 9, true, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
        values (${tenant.client}, 'KW', 'T10', 'Output tax 10 percent', 'VAT', 10, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into gl_account (client, chart_of_accounts, account_number, name, account_type,
                                is_balance_sheet, is_open_item_managed, reconciliation_type,
                                requires_cost_object, is_tax_relevant, account_group, gl_account_type, created_by)
        select ${tenant.client}, c.chart_of_accounts, v.n, v.d, 'EXPENSE',
               false, false, null, false, false, 'GENL', 'PL_STATEMENT', ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${tenant.client} limit 1) c
        cross join (values ('510300', 'Cost of goods sold'), ('120000', 'Raw materials inventory')) as v(n, d)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        select ${tenant.client}, c.chart_of_accounts, v.e, v.vc, '', v.a, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${tenant.client} limit 1) c
        cross join (values
          ('INVENTORY', 'RAW_INVENTORY', '120000'),
          ('SALES_ISSUE', 'RAW_INVENTORY', '510300'),
          ('SALES_REVENUE', '', '300000'),
          ('TAX', '', '240000')
        ) as v(e, vc, a)
        on conflict do nothing
      `);
    });
    await saveCustomerCredit({
      client: tenant.client, changedBy: ACTOR, customer: CUSTOMER, creditControlArea: AREA,
      creditLimit: '1000000.00', riskCategory: 'A', isBlocked: false, changeReason: 'ATP test credit data.',
    });

    // The masters the check reads, maintained at /config/availability-check and nowhere else: nothing
    // in this step configures anything new.
    await saveCheckingGroup({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', checkingGroup: GROUP,
      description: 'Checked material', noCheck: ' ', version: 0, reason: 'ATP test: define the group',
    });
    await saveCheckingGroup({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', checkingGroup: NO_CHECK_GROUP,
      description: 'Never checked', noCheck: 'X', version: 0, reason: 'ATP test: define an unchecked group',
    });
    await saveCheckingRule({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', checkingRule: ORDER_CHECKING_RULE,
      description: 'Order entry', version: 0, reason: 'ATP test: define the order context',
    });
    await saveCheckingRule({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', checkingRule: DELIVERY_CHECKING_RULE,
      description: 'Delivery creation', version: 0, reason: 'ATP test: define the delivery context',
    });
    for (const checkingRule of [ORDER_CHECKING_RULE, DELIVERY_CHECKING_RULE]) {
      await saveScopeOfCheck({
        client: tenant.client, changedBy: ACTOR, mode: 'CREATE', checkingGroup: GROUP, checkingRule,
        ...BLANK_FLAGS, includeSafetyStock: 'X', version: 0, reason: 'ATP test: define the scope',
      });
    }
    for (const [materialNumber, group] of [
      [MAT.confirms, GROUP], [MAT.second, GROUP], [MAT.unchecked, null], [MAT.delivery, GROUP],
      [MAT.door, GROUP], [MAT.change, GROUP], [MAT.scope, GROUP], [MAT.group, GROUP],
      [MAT.noCheck, NO_CHECK_GROUP],
    ] as const) {
      await addMaterial(materialNumber, group);
    }
  });

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
  });

  it('confirms what the plant has, and no more', async () => {
    await setSafetyStock(MAT.confirms, STOCK - 6);
    const placed = await order(MAT.confirms, 10);
    const read = await getSalesOrder(tenant.client, placed.orderNumber);
    // Ten were ordered and six were promised. The order still says ten, because that is what the
    // customer asked for; the schedule line is where the plant's answer is written down.
    expect(read!.lines[0].orderQuantity).toBe('10.000');
    expect(read!.lines[0].confirmedQuantity).toBe('6.000');
    expect(read!.lines[0].schedule).toEqual([{
      scheduleNumber: 10, requestedDate: DATE, requestedQuantity: '10.000',
      confirmedQuantity: '6.000', confirmedDate: DATE,
    }]);
    // And the value is still the value of ten: a promise of six is not a price cut.
    expect(Number(read!.netValue)).toBe(250);
  });

  it('does not promise the same stock twice', async () => {
    await setSafetyStock(MAT.second, STOCK - 6);
    const first = await order(MAT.second, 6);
    expect((await getSalesOrder(tenant.client, first.orderNumber))!.lines[0].confirmedQuantity).toBe('6.000');
    // The next order asks for the same stock the first was promised, and gets nothing: promising it
    // twice is the one failure an availability check exists to prevent.
    const second = await order(MAT.second, 6);
    const read = await getSalesOrder(tenant.client, second.orderNumber);
    expect(read!.lines[0].confirmedQuantity).toBe('0.000');
    expect(read!.lines[0].schedule[0].confirmedDate).toBeNull();
    // Nothing confirmed is nothing to deliver, so the due list does not offer it at all.
    expect(await listDeliverableOrderLines(tenant.client, { orderNumber: second.orderNumber })).toEqual([]);
  });

  it('confirms a material nobody configured a check for in full', async () => {
    const placed = await order(MAT.unchecked, 10);
    const read = await getSalesOrder(tenant.client, placed.orderNumber);
    // No checking group stands for this material, in its sales view or at the plant, so the check was
    // never asked — and an answer of nothing would be a promise broken by a configuration the tenant
    // never asked for.
    expect(read!.lines[0].confirmedQuantity).toBe('10.000');
  });

  it('creates the delivery from what was confirmed, not from what was ordered', async () => {
    await setSafetyStock(MAT.delivery, STOCK - 6);
    const placed = await order(MAT.delivery, 10);
    const open = await listDeliverableOrderLines(tenant.client, { orderNumber: placed.orderNumber });
    expect(open[0].confirmedQuantity).toBe('6.000');
    expect(open[0].remainingQuantity).toBe('6.000');
    await expect(createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: placed.orderNumber, deliveryDate: DATE,
      items: [{ orderLineNumber: open[0].lineNumber, quantity: '8' }], requestKey: key('over-confirmed'),
    }, { authorization: await salesAuthority(base.client) })).rejects.toThrow(/of 10\.000 ordered and 6\.000 confirmed/);
    const shipped = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: placed.orderNumber, deliveryDate: DATE,
      items: [{ orderLineNumber: open[0].lineNumber, quantity: '6' }], requestKey: key('as-confirmed'),
    }, { authorization: await salesAuthority(base.client) });
    // The delivery carries what the plant had promised when it was made, so a line of six against an
    // order of ten can be read as a promise kept rather than a customer shorted.
    const read = await getDelivery(tenant.client, shipped.deliveryNumber);
    expect(read!.lines[0].orderedQuantity).toBe('10.000');
    expect(read!.lines[0].confirmedQuantity).toBe('6.000');
    expect(read!.lines[0].deliveryQuantity).toBe('6.000');
    // What the order still has open is four: ten were asked for and six have gone. It is not what may
    // still be shipped, which is nothing until the plant confirms more.
    expect(read!.lines[0].remainingQuantity).toBe('4.000');
  });

  it('asks again at the door, because the promise was about that day', async () => {
    await setSafetyStock(MAT.door, STOCK - 6);
    const placed = await order(MAT.door, 10);
    expect((await getSalesOrder(tenant.client, placed.orderNumber))!.lines[0].confirmedQuantity).toBe('6.000');
    // Between the order and the delivery the plant's surplus moved on: three are free now, not six.
    // The confirmation stands as a promise about the day it was made; the goods have to be there today.
    await setSafetyStock(MAT.door, STOCK - 3);
    await expect(createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: placed.orderNumber, deliveryDate: DATE,
      items: [{ orderLineNumber: 10, quantity: '6' }], requestKey: key('door-shut'),
    }, { authorization: await salesAuthority(base.client) })).rejects.toThrow(/can promise 3\.000 UNT/);
  });

  it('leaves what has gone out confirmed, and asks only for the rest', async () => {
    await setSafetyStock(MAT.change, STOCK - 6);
    const placed = await order(MAT.change, 8);
    const open = await listDeliverableOrderLines(tenant.client, { orderNumber: placed.orderNumber });
    const shipped = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: placed.orderNumber, deliveryDate: DATE,
      items: [{ orderLineNumber: open[0].lineNumber, quantity: '6' }], requestKey: key('change-delivery'),
    }, { authorization: await salesAuthority(base.client) });
    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: shipped.deliveryNumber,
      items: [{ lineNumber: 10, quantity: '6', storageLocation: STORE }], requestKey: key('change-pick'),
    });
    const standing = await getDelivery(tenant.client, shipped.deliveryNumber);
    await postDeliveryGoodsIssue({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: shipped.deliveryNumber,
      expectedVersion: standing!.version, postingDate: DATE,
    }, { authorization: await salesAuthority(base.client) });

    // The customer asks for four more. The plant has nothing left beyond what it has already shipped,
    // so the four are confirmed at zero — and the six that went out stay confirmed at six, because a
    // change does not un-promise what the plant has already delivered.
    const before = await getSalesOrder(tenant.client, placed.orderNumber);
    const changed = await changeSalesOrder({
      ...base,
      orderNumber: placed.orderNumber,
      expectedVersion: before!.version,
      lines: [
        { lineNumber: 10, materialNumber: MAT.change, plant: PLANT, orderQuantity: 8, quantityUnit: 'UNT' },
        { lineNumber: 20, materialNumber: MAT.change, plant: PLANT, orderQuantity: 4, quantityUnit: 'UNT' },
      ],
      rejectLines: [],
    });
    expect(changed.lines[0].confirmedQuantity).toBe('6.000');
    expect(changed.lines[1].confirmedQuantity).toBe('0.000');
    expect(changed.lines[1].schedule).toEqual([{
      scheduleNumber: 10, requestedDate: DATE, requestedQuantity: '4.000',
      confirmedQuantity: '0.000', confirmedDate: null,
    }]);
    // Six went out of eight that were promised, so the line is spent.
    expect(await listDeliverableOrderLines(tenant.client, { orderNumber: placed.orderNumber })).toEqual([]);
  });

  it('refuses a scope it cannot count, and names the screen', async () => {
    await setSafetyStock(MAT.scope, STOCK - 6);
    await saveScopeOfCheck({
      client: tenant.client, changedBy: ACTOR, mode: 'CHANGE', checkingGroup: GROUP,
      checkingRule: ORDER_CHECKING_RULE, ...BLANK_FLAGS, includeSafetyStock: 'X', plannedOrders: 'X',
      version: 1, reason: 'ATP test: ask for planned orders',
    });
    // The check counts warehouse stock and what other orders have been promised, and nothing else.
    // Counting less than the scope asked for without saying so is how a plant promises goods it has
    // not found, so it says so, and it names the screen the flags stand on.
    await expect(order(MAT.scope, 10)).rejects.toThrow(/count planned orders/);
    await saveScopeOfCheck({
      client: tenant.client, changedBy: ACTOR, mode: 'CHANGE', checkingGroup: GROUP,
      checkingRule: ORDER_CHECKING_RULE, ...BLANK_FLAGS, includeSafetyStock: 'X',
      version: 2, reason: 'ATP test: put the scope back',
    });
  });

  it('refuses a checking group that does not stand', async () => {
    await maintainMaterialSales(tenant, {
      materialNumber: MAT.group, deliveringPlant: PLANT, availabilityCheckGroup: MISSING_GROUP,
    });
    // A group that does not stand is not a check, and it is not a silent pass either: the material
    // names something the tenant has not defined.
    await expect(order(MAT.group, 10)).rejects.toThrow(/no such group stands/);
    await maintainMaterialSales(tenant, {
      materialNumber: MAT.group, deliveringPlant: PLANT, availabilityCheckGroup: GROUP,
    });
  });

  it('confirms in full a group maintained with the no-check indicator', async () => {
    await setSafetyStock(MAT.noCheck, STOCK - 6);
    const placed = await order(MAT.noCheck, 10);
    // The group stands and says: do not check this material. That is a configuration, not an absence
    // of one, and the answer it asks for is the full quantity.
    const read = await getSalesOrder(tenant.client, placed.orderNumber);
    expect(read!.lines[0].confirmedQuantity).toBe('10.000');
    expect(read!.lines[0].schedule[0].confirmedDate).toBe(DATE);
  });
});
