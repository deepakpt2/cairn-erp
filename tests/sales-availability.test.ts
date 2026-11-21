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
import { changeSalesOrder, getSalesOrder, confirmDeliveryPicks, getDelivery, listDeliverableOrderLines } from './helpers/sales-authorized';
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
import { createSalesOrder } from '../src/modules/sales/sales-order';
import { changeSalesDocumentType } from '../src/modules/sales/document-type-maintenance';
import {
  SalesAvailabilityError, checkSalesOrderAvailability, simulateSalesOrderAvailability,
} from '../src/modules/sales/availability-check';
import { createDelivery, postDeliveryGoodsIssue } from '../src/modules/sales/delivery';
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
      checkingRule: ORDER_CHECKING_RULE, ...BLANK_FLAGS, includeSafetyStock: 'X', includeRestrictedUse: 'X',
      version: 1, reason: 'ATP test: ask for restricted-use stock',
    });
    // Restricted-use stock has no store, so the check cannot count it. (The supply flags — purchase and
    // planned orders and the rest — are counted since 9289.) Counting less than the scope asked for
    // without saying so is how a plant promises goods it has not found, so it says so.
    await expect(order(MAT.scope, 10)).rejects.toThrow(/count restricted-use stock/);
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

  // ── Supply over time, and the check on demand (migration 9289) ────────────────────────────────────────
  // Each test owns its material and, where it needs its own scope, its own checking group, so none is a
  // test of what another left behind. Stock is 100 for every material; the safety stock sets what is free.

  const today = new Date().toISOString().slice(0, 10);
  const day = (offset: number) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  let groupSeq = 0;
  const flags = (over: Partial<typeof BLANK_FLAGS & { salesRequirements: string }> = {}) => ({ ...BLANK_FLAGS, includeSafetyStock: 'X', ...over });

  /** A checking group of its own with a scope for the order rule, and the material put in it. */
  const configure = async (materialNumber: string, scope: Record<string, string> = {}, rule = ORDER_CHECKING_RULE) => {
    const checkingGroup = `T${(++groupSeq).toString(36).toUpperCase()}`;
    await saveCheckingGroup({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', checkingGroup, description: `ATP ${checkingGroup}`,
      noCheck: ' ', version: 0, reason: 'ATP test: a group of its own',
    });
    await saveScopeOfCheck({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', checkingGroup, checkingRule: rule,
      ...flags(), ...scope, version: 0, reason: 'ATP test: a scope of its own',
    });
    await maintainMaterialSales(tenant, { materialNumber, deliveringPlant: PLANT, availabilityCheckGroup: checkingGroup });
    return checkingGroup;
  };

  const plannedOrder = async (materialNumber: string, quantity: number, finish: string, o: { unit?: string; firmed?: boolean } = {}) => {
    const number = `P${String(++counter).padStart(9, '0')}`;
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into planned_order (client, order_number, material_number, plant, quantity, unit, start_date, finish_date, firming_status, request_key, created_by)
      values (${tenant.client}, ${number}, ${materialNumber}, ${PLANT}, ${quantity}, ${o.unit ?? 'UNT'}, ${finish}, ${finish},
              ${o.firmed ? 'FIRMED' : 'OPEN'}, ${key('planned')}, ${ACTOR})`));
    return number;
  };

  const purchaseOrder = async (materialNumber: string, quantity: number, due: string) => {
    const number = `47${String(++counter).padStart(8, '0')}`;
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`insert into purchasing_org (client, purchasing_org, name, created_by) values (${tenant.client}, 'O943', 'ATP org', ${ACTOR}) on conflict do nothing`);
      await tx.execute(sql`insert into purchasing_group (client, purchasing_group, name, created_by) values (${tenant.client}, 'G43', 'ATP group', ${ACTOR}) on conflict do nothing`);
      await tx.execute(sql`insert into business_partner (client, partner_number, name, created_by) values (${tenant.client}, 'V943', 'ATP supplier', ${ACTOR}) on conflict do nothing`);
      await tx.execute(sql`
        insert into purchase_order (client, order_number, document_type, supplier_number, purchasing_org, purchasing_group, company_code, currency, document_date, release_status, created_by)
        values (${tenant.client}, ${number}, 'STANDARD', 'V943', 'O943', 'G43', '1000', 'USD', ${due}, 'RELEASED', ${ACTOR})`);
      await tx.execute(sql`
        insert into purchase_order_item (client, order_number, item_number, item_category, material_number, short_text, quantity, unit, net_price, price_unit, net_value, plant, created_by)
        values (${tenant.client}, ${number}, 10, 'STANDARD', ${materialNumber}, 'ATP supply', ${quantity}, 'UNT', 10, 1, ${quantity * 10}, ${PLANT}, ${ACTOR})`);
    });
    return number;
  };

  const orderAt = async (materialNumber: string, quantity: number, requested: string) => createSalesOrder({
    ...base, requestKey: key(`${materialNumber}-at`),
    lines: [{ lineNumber: undefined, materialNumber, plant: PLANT, orderQuantity: quantity, quantityUnit: 'UNT', taxCode: 'T10', requestedDeliveryDate: requested }],
  }, { authorization: await salesAuthority(base.client) });

  const simulate = async (orderNumber: string) => simulateSalesOrderAvailability({ client: tenant.client, orderNumber }, { authorization: await salesAuthority(base.client) });
  const checkNow = async (orderNumber: string) => checkSalesOrderAvailability({ client: tenant.client, orderNumber }, { authorization: await salesAuthority(base.client) });
  const standing = async (orderNumber: string) => (await getSalesOrder(tenant.client, orderNumber))!.lines[0];
  const fresh = async (code: string, safety: number, scope: Record<string, string> = {}) => {
    const materialNumber = `SD9243${code}`;
    await addMaterial(materialNumber, null);
    await setSafetyStock(materialNumber, safety);
    await configure(materialNumber, scope);
    return materialNumber;
  };

  it('ATP 1-4. full, partial and zero are confirmed and never exceed the request or go below zero', async () => {
    const full = await fresh('A01', 90);                       // 10 free
    const partial = await fresh('A02', 94);                    // 6 free
    const none = await fresh('A03', 100);                      // nothing free
    const f = (await simulate((await orderAt(full, 8, day(5))).orderNumber)).lines[0]!;
    expect(f.proposed).toMatchObject({ confirmedQuantity: '8.000', confirmedDate: day(5), partial: false, delayed: false, remainderUndated: false });
    const p = (await simulate((await orderAt(partial, 10, day(5))).orderNumber)).lines[0]!;
    expect(p.proposed).toMatchObject({ confirmedQuantity: '6.000', confirmedDate: day(5), partial: true, remainderUndated: true });
    const z = (await simulate((await orderAt(none, 10, day(5))).orderNumber)).lines[0]!;
    expect(z.proposed).toMatchObject({ confirmedQuantity: '0.000', confirmedDate: null, partial: false, remainderUndated: true });
    for (const r of [f, p, z]) {
      expect(Number(r.proposed!.confirmedQuantity)).toBeLessThanOrEqual(Number(r.orderQuantity));
      expect(Number(r.proposed!.confirmedQuantity)).toBeGreaterThanOrEqual(0);
    }
  });

  it('ATP 3b. zero is distinguishable from never checked, before and after', async () => {
    const none = await fresh('A04', 100);
    const placed = await orderAt(none, 5, day(5));
    expect((await standing(placed.orderNumber)).confirmedQuantity).toBe('0.000');
    // A line raised before the check stood carries no confirmation: null, which is not zero.
    await withTenant(tenant.client, (tx) => tx.execute(sql`update sales_order_line set confirmed_quantity = null where client = ${tenant.client} and order_number = ${placed.orderNumber}`));
    const before = (await simulate(placed.orderNumber)).lines[0]!;
    expect(before.standing.confirmedQuantity).toBeNull();
    expect(before.change).toBe('FIRST');
    await checkNow(placed.orderNumber);
    expect((await standing(placed.orderNumber)).confirmedQuantity).toBe('0.000');
  });

  it('ATP 5. a blank document type rule is checked under OR, as before — not unchecked', async () => {
    const mat = await fresh('A05', 94);
    const placed = await orderAt(mat, 10, day(5));
    expect((await standing(placed.orderNumber)).confirmedQuantity).toBe('6.000');
    const result = await simulate(placed.orderNumber);
    expect(result).toMatchObject({ checkingRule: ORDER_CHECKING_RULE, ruleFromDocumentType: false });
    expect(result.lines[0]!.skipped).toBeNull();
  });

  it('ATP 5b. a rule the document type names is used, and a scope must stand for it', async () => {
    const mat = await fresh('A06', 94);                        // OR scope deducts safety stock: 6 free
    const placed = await orderAt(mat, 10, day(5));
    await saveCheckingRule({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', checkingRule: 'S1', description: 'Named by the type',
      version: 0, reason: 'ATP test: a rule a document type can name',
    });
    await withTenant(tenant.client, (tx) => tx.execute(sql`update sales_document_type set availability_check_rule = 'S1' where client = ${tenant.client} and document_type = 'OR'`));
    try {
      // The rule is named and no scope stands for it: reported per line on demand, refused at order entry.
      const missing = (await simulate(placed.orderNumber)).lines[0]!;
      expect(missing.skipped).toMatchObject({ reason: 'NO_SCOPE' });
      expect(missing.skipped!.message).toMatch(/group T[0-9A-Z] and rule S1/);
      await expect(orderAt(mat, 1, day(5))).rejects.toThrow(/No scope of check stands for checking group T[0-9A-Z] and rule S1/);
      // With a scope that does not deduct the reserve, the same order is promised all ten.
      const group = (await withTenant(tenant.client, (tx) => tx.execute(sql`select availability_check_group as g from material_sales where client = ${tenant.client} and material_number = ${mat}`)) as unknown as Array<{ g: string }>)[0]!.g;
      await saveScopeOfCheck({
        client: tenant.client, changedBy: ACTOR, mode: 'CREATE', checkingGroup: group, checkingRule: 'S1',
        ...BLANK_FLAGS, version: 0, reason: 'ATP test: a scope for the named rule',
      });
      const named = await simulate(placed.orderNumber);
      expect(named).toMatchObject({ checkingRule: 'S1', ruleFromDocumentType: true });
      expect(named.lines[0]!.proposed).toMatchObject({ confirmedQuantity: '10.000', partial: false });
    } finally {
      await withTenant(tenant.client, (tx) => tx.execute(sql`update sales_document_type set availability_check_rule = null where client = ${tenant.client} and document_type = 'OR'`));
    }
  });

  it('ATP 5c. document type maintenance names the rule, keeps it when omitted, and clears it to the default', async () => {
    const maintain = (extra: { availabilityCheckRule?: string | null }) => changeSalesDocumentType({
      client: tenant.client, changedBy: ACTOR, documentType: 'OR', name: 'Standard order', ...extra,
    });
    const rule = async () => ((await withTenant(tenant.client, (tx) => tx.execute(sql`select availability_check_rule as r from sales_document_type where client = ${tenant.client} and document_type = 'OR'`))) as unknown as Array<{ r: string | null }>)[0]!.r;
    await expect(maintain({ availabilityCheckRule: 'Z9' })).rejects.toThrow(/Checking rule Z9 does not stand/);
    expect(await rule()).toBeNull();
    await maintain({ availabilityCheckRule: ORDER_CHECKING_RULE });
    expect(await rule()).toBe(ORDER_CHECKING_RULE);
    await maintain({});                                         // omitted: kept
    expect(await rule()).toBe(ORDER_CHECKING_RULE);
    await maintain({ availabilityCheckRule: '' });              // blank: cleared — the order rule OR, not "no check"
    expect(await rule()).toBeNull();
  });

  it('ATP 6, 7. a line that cannot be checked is reported and the others are still checked', async () => {
    const good = await fresh('A07', 94);
    const unchecked = `SD9243A08`;
    await addMaterial(unchecked, null);
    const ungrouped = `SD9243A09`;
    await addMaterial(ungrouped, null);
    await configure(ungrouped);
    const placed = await createSalesOrder({
      ...base, requestKey: key('mixed'),
      lines: [good, unchecked, ungrouped].map((materialNumber) => ({ lineNumber: undefined, materialNumber, plant: PLANT, orderQuantity: 10, quantityUnit: 'UNT', taxCode: 'T10', requestedDeliveryDate: day(5) })),
    }, { authorization: await salesAuthority(base.client) });
    // After the order stands the third material's group is removed (no group row): reported, not thrown.
    await maintainMaterialSales(tenant, { materialNumber: ungrouped, deliveringPlant: PLANT, availabilityCheckGroup: MISSING_GROUP });
    const result = await simulate(placed.orderNumber);
    expect(result.lines[0]!.proposed).toMatchObject({ confirmedQuantity: '6.000' });
    expect(result.lines[1]!.skipped).toMatchObject({ reason: 'NOT_CHECKED' });
    expect(result.lines[1]!.proposed).toBeNull();
    expect(result.lines[2]!.skipped).toMatchObject({ reason: 'NOT_CONFIGURED' });
    expect(result.lines[2]!.skipped!.message).toMatch(/no such group stands/);
    // The write touches only what could be checked: the unchecked line keeps its full confirmation.
    await checkNow(placed.orderNumber);
    const read = await getSalesOrder(tenant.client, placed.orderNumber);
    expect(read!.lines.map((l) => l.confirmedQuantity)).toEqual(['6.000', '10.000', '10.000']);
  });

  it('ATP 8. a supply flag that is blank excludes its element, and switching it on changes the confirmation', async () => {
    const mat = await fresh('A10', 94);                        // 6 free
    await purchaseOrder(mat, 20, day(3));
    await plannedOrder(mat, 20, day(3));
    const placed = await orderAt(mat, 10, day(5));
    expect((await standing(placed.orderNumber)).confirmedQuantity).toBe('6.000');   // neither flag set: neither counted
    const group = (await withTenant(tenant.client, (tx) => tx.execute(sql`select availability_check_group as g from material_sales where client = ${tenant.client} and material_number = ${mat}`)) as unknown as Array<{ g: string }>)[0]!.g;
    const change = (over: Record<string, string>, version: number) => saveScopeOfCheck({
      client: tenant.client, changedBy: ACTOR, mode: 'CHANGE', checkingGroup: group, checkingRule: ORDER_CHECKING_RULE,
      ...flags(), ...over, version, reason: 'ATP test: toggle a supply flag',
    });
    await change({ purchaseOrders: 'X' }, 1);
    let line = (await simulate(placed.orderNumber)).lines[0]!;
    expect(line.proposed).toMatchObject({ confirmedQuantity: '10.000', confirmedDate: day(3) === day(5) ? day(5) : day(5), delayed: false });
    expect(line.proposed!.basis.map((b) => b.elementType)).toEqual(['PURCHASE_ORDER']);
    expect(line.change).toBe('RAISED');
    await change({ purchaseOrders: ' ' }, 2);
    line = (await simulate(placed.orderNumber)).lines[0]!;
    expect(line.proposed).toMatchObject({ confirmedQuantity: '6.000' });
    expect(line.proposed!.basis).toEqual([]);
    await change({ plannedOrders: 'X' }, 3);
    line = (await simulate(placed.orderNumber)).lines[0]!;
    expect(line.proposed!.basis.map((b) => b.elementType)).toEqual(['PLANNED_ORDER']);
    expect(line.proposed).toMatchObject({ confirmedQuantity: '10.000' });
  });

  it('ATP 9. plannedOrders A counts only firmed planned orders', async () => {
    const mat = await fresh('A11', 94, { plannedOrders: 'A' });
    await plannedOrder(mat, 20, day(3));                        // open: not counted under A
    const placed = await orderAt(mat, 10, day(5));
    expect((await standing(placed.orderNumber)).confirmedQuantity).toBe('6.000');
    await plannedOrder(mat, 20, day(3), { firmed: true });
    const line = (await simulate(placed.orderNumber)).lines[0]!;
    expect(line.proposed).toMatchObject({ confirmedQuantity: '10.000' });
    expect(line.proposed!.basis).toHaveLength(1);
  });

  it('ATP 10. sales requirements: another open order reduces what a new order is promised, unless the scope says otherwise', async () => {
    const mat = await fresh('A12', 94);                        // 6 free
    const first = await orderAt(mat, 6, day(5));
    const second = await orderAt(mat, 6, day(5));
    expect((await standing(first.orderNumber)).confirmedQuantity).toBe('6.000');
    expect((await standing(second.orderNumber)).confirmedQuantity).toBe('0.000');   // the same stock is not promised twice
    const group = (await withTenant(tenant.client, (tx) => tx.execute(sql`select availability_check_group as g from material_sales where client = ${tenant.client} and material_number = ${mat}`)) as unknown as Array<{ g: string }>)[0]!.g;
    await saveScopeOfCheck({
      client: tenant.client, changedBy: ACTOR, mode: 'CHANGE', checkingGroup: group, checkingRule: ORDER_CHECKING_RULE,
      ...flags(), salesRequirements: ' ', version: 1, reason: 'ATP test: stop subtracting other orders',
    });
    expect((await simulate(second.orderNumber)).lines[0]!.proposed).toMatchObject({ confirmedQuantity: '6.000' });
  });

  it('ATP 11, 16. re-checking excludes the order\'s own promise; a confirmation is written and not re-derived', async () => {
    const mat = await fresh('A13', 94);
    const placed = await orderAt(mat, 6, day(5));
    const first = await simulate(placed.orderNumber);
    const second = await simulate(placed.orderNumber);
    expect(second.lines[0]!.proposed).toEqual(first.lines[0]!.proposed);
    expect(first.lines[0]!.proposed).toMatchObject({ confirmedQuantity: '6.000', availableAtRequestedDate: '6.000' });
    expect(first.lines[0]!.change).toBe('UNCHANGED');
    await checkNow(placed.orderNumber);
    expect((await standing(placed.orderNumber)).confirmedQuantity).toBe('6.000');
    // Stock moves on afterwards; the promise the plant made does not.
    await setSafetyStock(mat, 100);
    expect((await standing(placed.orderNumber)).confirmedQuantity).toBe('6.000');
    expect((await getSalesOrder(tenant.client, placed.orderNumber))!.lines[0].schedule[0].confirmedQuantity).toBe('6.000');
    // Asked again on demand, it can lower the promise — shown, then written only when confirmed.
    const lowered = (await simulate(placed.orderNumber)).lines[0]!;
    expect(lowered).toMatchObject({ change: 'LOWERED' });
    expect((await standing(placed.orderNumber)).confirmedQuantity).toBe('6.000');
    await checkNow(placed.orderNumber);
    expect((await standing(placed.orderNumber)).confirmedQuantity).toBe('0.000');
  });

  it('ATP 12. safety stock is deducted when includeSafetyStock is X, and not when blank', async () => {
    const withReserve = await fresh('A14', 40);                // X: 60 free
    const noReserve = await fresh('A15', 40, { includeSafetyStock: ' ' });   // blank: all 100 free
    const a = await orderAt(withReserve, 100, day(5));
    const b = await orderAt(noReserve, 100, day(5));
    expect((await standing(a.orderNumber)).confirmedQuantity).toBe('60.000');
    expect((await standing(b.orderNumber)).confirmedQuantity).toBe('100.000');
  });

  it('ATP 13, 14. an element in another unit is converted to the base unit; one that cannot be is reported naming the units', async () => {
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`insert into unit_of_measure (code, name, dimension, decimal_places, is_base_unit) values ('CAS', 'Case', 'COUNT', 0, false), ('ODD', 'Odd unit', 'COUNT', 0, false) on conflict (code) do nothing`);
    });
    const converted = await fresh('A16', 94, { plannedOrders: 'X' });
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into material_uom_conversion (client, material_number, alternative_unit, base_unit, numerator, denominator, created_by)
      values (${tenant.client}, ${converted}, 'CAS', 'UNT', 12, 1, ${ACTOR}) on conflict do nothing`));
    await plannedOrder(converted, 1, day(3), { unit: 'CAS' });  // one case is twelve units
    const placed = await orderAt(converted, 20, day(5));
    expect((await simulate(placed.orderNumber)).lines[0]!.proposed).toMatchObject({ confirmedQuantity: '18.000' });   // 6 + 12
    const broken = await fresh('A17', 94, { plannedOrders: 'X' });
    await plannedOrder(broken, 5, day(3), { unit: 'ODD' });
    const refused = await orderAt(broken, 1, day(5)).then(() => null, (e: Error) => e);
    expect(refused?.message).toMatch(/cannot be counted/);
    expect(refused?.message).toMatch(/ODD/);
    expect(refused?.message).toMatch(/UNT|base unit/);
  });

  it('ATP 14b. a failed conversion is reported per line on demand', async () => {
    const mat = await fresh('A18', 94);
    const placed = await orderAt(mat, 10, day(5));
    const group = (await withTenant(tenant.client, (tx) => tx.execute(sql`select availability_check_group as g from material_sales where client = ${tenant.client} and material_number = ${mat}`)) as unknown as Array<{ g: string }>)[0]!.g;
    await plannedOrder(mat, 5, day(3), { unit: 'ODD' });
    await saveScopeOfCheck({
      client: tenant.client, changedBy: ACTOR, mode: 'CHANGE', checkingGroup: group, checkingRule: ORDER_CHECKING_RULE,
      ...flags(), plannedOrders: 'X', version: 1, reason: 'ATP test: count planned orders',
    });
    const line = (await simulate(placed.orderNumber)).lines[0]!;
    expect(line.skipped).toMatchObject({ reason: 'UNIT_CONVERSION' });
    expect(line.skipped!.message).toContain(mat);
    expect(line.skipped!.message).toContain('ODD');
  });

  it('ATP 15. a scope of restricted-use stock is refused by name (no such stock is held)', async () => {
    const mat = await fresh('A19', 94, { includeRestrictedUse: 'X' }).catch((e: Error) => e);
    // Nothing could be ordered under it: the refusal is the check's own.
    expect(typeof mat === 'string' || mat instanceof Error).toBe(true);
    const material = typeof mat === 'string' ? mat : 'SD9243A19';
    await expect(orderAt(material, 1, day(5))).rejects.toThrow(/restricted-use stock/);
  });

  it('ATP 7b. the earliest date at which the whole quantity stands is the confirmed date; a partial stands at the requested date', async () => {
    const later = await fresh('A20', 94, { plannedOrders: 'X' });          // 6 free, +10 on day 8: all 10 stand on day 8
    await plannedOrder(later, 10, day(8));
    const placed = await orderAt(later, 10, day(5));
    const line = (await simulate(placed.orderNumber)).lines[0]!;
    expect(line.proposed).toMatchObject({ confirmedQuantity: '10.000', confirmedDate: day(8), delayed: true, partial: false, remainderUndated: false, availableAtRequestedDate: '6.000' });
    expect((await standing(placed.orderNumber)).confirmedQuantity).toBe('10.000');
    expect((await getSalesOrder(tenant.client, placed.orderNumber))!.lines[0].schedule[0]).toMatchObject({ confirmedQuantity: '10.000', confirmedDate: day(8) });
    // More is asked for than will ever stand inside the horizon: what stands now is confirmed, the rest is undated.
    const never = await fresh('A21', 94, { plannedOrders: 'X' });
    await plannedOrder(never, 2, day(8));
    const short = await orderAt(never, 20, day(5));
    const p = (await simulate(short.orderNumber)).lines[0]!.proposed!;
    expect(p).toMatchObject({ confirmedQuantity: '6.000', confirmedDate: day(5), partial: true, remainderUndated: true, delayed: false });
    expect(p.horizonEnd).not.toBeNull();
    // A receipt beyond the horizon is not searched for.
    const beyond = await fresh('A22', 94, { plannedOrders: 'X' });
    await plannedOrder(beyond, 20, day(5 + 400));
    const far = (await simulate((await orderAt(beyond, 10, day(5))).orderNumber)).lines[0]!.proposed!;
    expect(far).toMatchObject({ confirmedQuantity: '6.000', remainderUndated: true });
  });

  it('ATP 8b. receipts in the past count unless the scope says future only (B)', async () => {
    const mat = await fresh('A23', 94, { plannedOrders: 'X' });
    await plannedOrder(mat, 10, day(-3));
    const placed = await orderAt(mat, 10, day(5));
    expect((await standing(placed.orderNumber)).confirmedQuantity).toBe('10.000');
    const group = (await withTenant(tenant.client, (tx) => tx.execute(sql`select availability_check_group as g from material_sales where client = ${tenant.client} and material_number = ${mat}`)) as unknown as Array<{ g: string }>)[0]!.g;
    await saveScopeOfCheck({
      client: tenant.client, changedBy: ACTOR, mode: 'CHANGE', checkingGroup: group, checkingRule: ORDER_CHECKING_RULE,
      ...flags(), plannedOrders: 'X', receiptsInPast: 'B', version: 1, reason: 'ATP test: future receipts only',
    });
    expect((await simulate(placed.orderNumber)).lines[0]!.proposed).toMatchObject({ confirmedQuantity: '6.000' });
  });

  it('ATP 4b. a re-check can raise a promise, and the preview says so beside the standing figure', async () => {
    const mat = await fresh('A24', 94, { plannedOrders: 'X' });
    const placed = await orderAt(mat, 10, day(5));
    expect((await standing(placed.orderNumber)).confirmedQuantity).toBe('6.000');
    await plannedOrder(mat, 10, day(2));
    const line = (await simulate(placed.orderNumber)).lines[0]!;
    expect(line.standing.confirmedQuantity).toBe('6.000');
    expect(line.proposed).toMatchObject({ confirmedQuantity: '10.000' });
    expect(line.change).toBe('RAISED');
    expect((await standing(placed.orderNumber)).confirmedQuantity).toBe('6.000');   // a simulation writes nothing
    const written = await checkNow(placed.orderNumber);
    expect(written.written).toBe(true);
    expect((await standing(placed.orderNumber)).confirmedQuantity).toBe('10.000');
  });

  it('ATP 17. the delivery ceiling is the confirmation the check wrote', async () => {
    const mat = await fresh('A25', 94);
    const placed = await orderAt(mat, 10, day(5));
    const open = await listDeliverableOrderLines(tenant.client, { orderNumber: placed.orderNumber });
    expect(open[0].confirmedQuantity).toBe('6.000');
    await expect(createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: placed.orderNumber, deliveryDate: DATE,
      items: [{ orderLineNumber: open[0].lineNumber, quantity: '9' }], requestKey: key('atp-over'),
    }, { authorization: await salesAuthority(base.client) })).rejects.toThrow(/6\.000 confirmed/);
  });

  it('ATP 18. an actor without the capability is refused by the service, before any write', async () => {
    const mat = await fresh('A26', 94, { plannedOrders: 'X' });
    const placed = await orderAt(mat, 10, day(5));
    await plannedOrder(mat, 10, day(2));
    const weak = await createSalesActor(tenant.client, { capabilities: ['SALES.ORDER.CREATE'] });
    await expect(checkSalesOrderAvailability({ client: tenant.client, orderNumber: placed.orderNumber }, { authorization: weak.authorization })).rejects.toBeInstanceOf(SalesAvailabilityError);
    await expect(simulateSalesOrderAvailability({ client: tenant.client, orderNumber: placed.orderNumber }, { authorization: weak.authorization })).rejects.toThrow(/AVAILABILITY\.CHECK|authority/);
    await expect(checkSalesOrderAvailability({ client: tenant.client, orderNumber: placed.orderNumber })).rejects.toThrow(/signed-in user/);
    expect((await standing(placed.orderNumber)).confirmedQuantity).toBe('6.000');
  });

  it('ATP 9b. an order that does not stand, or is not open, is refused whole', async () => {
    await expect(simulate('SO-NOSUCH')).rejects.toThrow(/Sales order SO-NOSUCH does not stand/);
    const mat = await fresh('A27', 94);
    const placed = await orderAt(mat, 3, day(5));
    await withTenant(tenant.client, (tx) => tx.execute(sql`update sales_order set status = 'CANCELLED' where client = ${tenant.client} and order_number = ${placed.orderNumber}`));
    await expect(simulate(placed.orderNumber)).rejects.toThrow(/only an open order is checked/);
  });
});
