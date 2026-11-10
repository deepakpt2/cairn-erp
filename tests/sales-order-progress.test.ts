import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';

import { saveCustomerCredit } from '../src/modules/finance/credit';
import { saveSalesCondition } from '../src/modules/sales/conditions';

import { listAnalysis } from '../src/modules/sales/analysis';
import { billDueList } from '../src/modules/sales/billing';
import {
  confirmDeliveryPicks, createDelivery, getDelivery, listDeliverableOrderLines, postDeliveryGoodsIssue,
} from '../src/modules/sales/delivery';
import { changeSalesOrder, createSalesOrder, getSalesOrder } from '../src/modules/sales/sales-order';
import {
  assignSalesAreaDimensions, createTenant, destroyTenant, maintainMaterialSales,
  type TestTenant,
} from './helpers';

/**
 * §5.4 — what the chain has taken off an item, on the order that asked for it.
 *
 * The quantities were already computed and nowhere shown: `fulfillment-quantities.ts` has been the
 * single author of "how much of this line is delivered and how much is billed" since the delivery
 * service started refusing things by it, and the order screen has never printed it. So a planner
 * reading an order could not see how much of it was done, and the numbers they could see — ordered,
 * confirmed — were the numbers the order was raised with rather than the ones the chain had moved.
 *
 * Three properties are proved, and the first is the one that makes the other two worth anything:
 *
 * **The screen reads what the services refuse by.** The delivered quantity an order reports is the
 * one the delivery service checks before it carries goods, and the one the order service checks
 * before it lets a line be reduced. A screen that showed a different number would be a screen that
 * argued with the refusal it was about to receive.
 *
 * **It agrees with the analysis.** The open quantity on the order is the backlog §5.3 counts. Two
 * screens reading the same arithmetic is only safe while there is one arithmetic.
 *
 * **An order is not capped at the size of the grid somebody drew.** The grid grew in this increment;
 * what is proved here is that the order underneath it will take as many items as it is given.
 */
const ACTOR = 'SD9258_PROGRESS';
const AREA = 'CCA1';
const CUSTOMER = 'SD9258CUST1';
const MATERIAL = 'SD9258MAT1';
const PLANT = '1000';
const STORE = '0001';
const DATE = '2026-10-16';

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
  documentType: 'OR',
};

describe('what the chain has taken off each item of an order (§5.4)', () => {
  let tenant: TestTenant;
  let counter = 0;
  const key = (what: string) => `sd9258-${what}-${++counter}`;

  beforeAll(async () => {
    tenant = await createTenant('sd9258-progress');
    base.client = tenant.client;
    await withTenant(tenant.client, async (tx) => {
      await defineRange(tx, {
        client: tenant.client, objectCode: 'SALESORD', subObject: 'OR', prefix: 'SO',
        numberLength: 7, createdBy: ACTOR,
      });
      await defineRange(tx, {
        client: tenant.client, objectCode: 'DELIVERY', subObject: 'LF', prefix: 'DV',
        numberLength: 7, createdBy: ACTOR,
      });
      await defineRange(tx, {
        client: tenant.client, objectCode: 'BILLING', subObject: 'F2', prefix: 'INV',
        numberLength: 7, createdBy: ACTOR,
      });
      await defineRange(tx, {
        client: tenant.client, objectCode: 'CUSTINV', subObject: '*', prefix: 'CI',
        numberLength: 7, createdBy: ACTOR,
      });
      // The cancellation type S1 draws its own number, because a credit memo is a document of its
      // own kind and not a second invoice.
      await defineRange(tx, {
        client: tenant.client, objectCode: 'BILLING', subObject: 'S1', prefix: 'CN',
        numberLength: 7, createdBy: ACTOR,
      });
      await defineRange(tx, {
        client: tenant.client, objectCode: 'MATDOC', subObject: '*', prefix: '',
        numberLength: 10, createdBy: ACTOR,
      });
      await defineRange(tx, {
        client: tenant.client, objectCode: 'RF_BELEG', subObject: 'GENERAL', prefix: 'JE',
        numberLength: 6, companyCode: '1000', fiscalYear: 2026, createdBy: ACTOR,
      });
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
        values (${tenant.client}, '1000', 'E', 'Test sales organization', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into sales_area (client, sales_org, distribution_channel, division, name, created_by)
        values (${tenant.client}, '1000', '10', '01', 'Test sales area', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, country, created_by)
        values (${tenant.client}, '1000', 'Test plant', 'KW', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active,
                                      allow_negative_stock, created_by)
        values (${tenant.client}, ${PLANT}, ${STORE}, 'Test store', true, false, ${ACTOR})
        on conflict (client, plant, storage_location) do update set is_active = excluded.is_active
      `);
      await tx.execute(sql`
        insert into credit_control_area (client, credit_control_area, name, currency,
                                         warning_threshold_percent, created_by)
        values (${tenant.client}, ${AREA}, 'Test credit area', 'USD', 90, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into credit_risk_category (client, risk_category, name, created_by)
        values (${tenant.client}, 'A', 'Low risk', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        update company_code set credit_control_area = ${AREA}
        where client = ${tenant.client} and company_code = '1000'
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${tenant.client}, ${CUSTOMER}, 'ORGANIZATION', 'Progress test customer', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${tenant.client}, ${CUSTOMER}, 'CUSTOMER', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into customer_sales_area (
          client, partner_number, role_code, sales_org, distribution_channel, division,
          pricing_procedure, is_blocked, sales_status, created_by
        )
        values (${tenant.client}, ${CUSTOMER}, 'CUSTOMER', '1000', '10', '01', 'PR01', false,
                'MAINTAINED', ${ACTOR})
        on conflict (client, partner_number, sales_org, distribution_channel, division)
        do update set is_blocked = false, sales_status = 'MAINTAINED'
      `);
      await tx.execute(sql`
        insert into customer_company_code (
          client, partner_number, role_code, company_code, chart_of_accounts,
          reconciliation_account, payment_terms_code, created_by
        )
        values (${tenant.client}, ${CUSTOMER}, 'CUSTOMER', '1000', 'CA01', '110000', 'NET30', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
        values (${tenant.client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${tenant.client}, ${MATERIAL}, 'Progress test material', 'RAW', 'UNT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        values (${tenant.client}, ${MATERIAL}, ${PLANT}, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class,
                                        price_control, standard_price, moving_average_price, price_unit,
                                        currency, total_stock_quantity, stock_value, created_by)
        values (${tenant.client}, ${MATERIAL}, ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1,
                'USD', 100, 1000, ${ACTOR})
        on conflict (client, material_number, valuation_area)
        do update set moving_average_price = excluded.moving_average_price
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type,
                                    quantity, created_by)
        values (${tenant.client}, ${MATERIAL}, ${PLANT}, ${STORE}, 'UNRESTRICTED', 100, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
        values (${tenant.client}, 'OPENING_BALANCE', 'Opening balance', 'RECEIPT', 'MATERIAL_DOCUMENT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date,
                                       posting_date, header_text, status, created_by)
        values (${tenant.client}, 'MD-PRG001', 2026, ${DATE}, ${DATE}, 'Opening balance', 'POSTED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (client, material_document_number, line_number, movement_type,
                                            material_number, plant, storage_location, stock_type,
                                            line_direction, entry_quantity, entry_unit, base_quantity,
                                            base_unit, created_by)
        values (${tenant.client}, 'MD-PRG001', 1, 'OPENING_BALANCE', ${MATERIAL}, ${PLANT}, ${STORE},
                'UNRESTRICTED', 'RECEIPT', 100, 'UNT', 100, 'UNT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into gl_account (client, chart_of_accounts, account_number, name, account_type,
                                is_balance_sheet, is_open_item_managed, reconciliation_type,
                                requires_cost_object, is_tax_relevant, account_group, gl_account_type,
                                created_by)
        select ${tenant.client}, c.chart_of_accounts, v.n, v.d, 'EXPENSE',
               false, false, null, false, false, 'GENL', 'PL_STATEMENT', ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${tenant.client} limit 1) c
        cross join (values ('510300', 'Cost of goods sold'), ('120000', 'Raw materials inventory')) as v(n, d)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class,
                                           general_modifier, gl_account, created_by)
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
      await tx.execute(sql`
        insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                             previous_fiscal_year, previous_period, allow_backposting, created_by)
        values (${tenant.client}, '1000', 2026, 10, 2026, 9, true, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
        values (${tenant.client}, 'KW', 'T10', 'Output tax 10 percent', 'VAT', 10, ${ACTOR}) on conflict do nothing
      `);
    });

    await maintainMaterialSales(tenant, { materialNumber: MATERIAL, deliveringPlant: PLANT });
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10',
      division: '01', customerNumber: CUSTOMER, materialNumber: MATERIAL, currency: 'USD',
      amount: 25, priceUnit: 1, validityFrom: '2026-01-01', validityTo: '2026-12-31',
      supersedeStanding: false,
    });
    await saveCustomerCredit({
      client: tenant.client, changedBy: ACTOR, customer: CUSTOMER, creditControlArea: AREA,
      creditLimit: '1000000.00', riskCategory: 'A', isBlocked: false,
      changeReason: 'Progress test credit data.',
    });
  });

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
  });

  /** One order of `units`, priced and standing. */
  async function ordered(units: number) {
    return createSalesOrder({
      ...base, requestKey: key('order'),
      lines: [{
        lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: units, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    });
  }

  /** Deliver `units` of an order and issue them, on a delivery of its own. */
  async function goneOut(orderNumber: string, units: number) {
    const open = await listDeliverableOrderLines(tenant.client, { orderNumber });
    const built = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber, deliveryDate: DATE,
      goodsMovementDate: DATE, headerText: 'Progress fixture',
      items: [{ orderLineNumber: open[0].lineNumber, quantity: String(units) }],
      requestKey: key('delivery'),
    });
    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: built.deliveryNumber,
      items: [{ lineNumber: 10, quantity: String(units), storageLocation: STORE }],
    });
    const picked = await getDelivery(tenant.client, built.deliveryNumber);
    await postDeliveryGoodsIssue({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: built.deliveryNumber,
      expectedVersion: picked!.version, postingDate: DATE, documentDate: DATE,
    });
    return built.deliveryNumber;
  }

  it('says what has gone out, what has been billed, and what is left, item by item', async () => {
    const created = await ordered(10);
    const line = async () => (await getSalesOrder(tenant.client, created.orderNumber))!.lines[0];

    // Nothing has happened to it yet, and it reads the way an unfulfilled item always did.
    expect((await line()).deliveredQuantity).toBe('0');
    expect((await line()).billedQuantity).toBe('0');
    expect((await line()).openQuantity).toBe('10');

    const delivered = await goneOut(created.orderNumber, 4);
    expect((await line()).deliveredQuantity).toBe('4');
    // Out, but not yet charged for — which is the question a planner asks before they invoice.
    expect((await line()).billedQuantity).toBe('0');
    expect((await line()).openQuantity).toBe('6');

    await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
      selection: { deliveryNumber: delivered },
    });
    expect((await line()).deliveredQuantity).toBe('4');
    expect((await line()).billedQuantity).toBe('4');
    expect((await line()).openQuantity).toBe('6');

    // A second delivery against the same line, and both quantities move where they should.
    await goneOut(created.orderNumber, 3);
    expect((await line()).deliveredQuantity).toBe('7');
    expect((await line()).billedQuantity).toBe('4');
    expect((await line()).openQuantity).toBe('3');
  });

  it('reports the quantity the services refuse by, not a reading of its own', async () => {
    // The promise that makes the number worth printing. The order service refuses to reduce an item
    // below what stands delivered, and the delivery service refuses to carry more than is open; both
    // read it from the same place this screen does. So the refusal names the number the screen shows.
    const created = await ordered(10);
    await goneOut(created.orderNumber, 6);

    const before = await getSalesOrder(tenant.client, created.orderNumber);
    expect(before!.lines[0].deliveredQuantity).toBe('6');
    expect(before!.lines[0].openQuantity).toBe('4');

    // Six have gone out, so this item's quantity is frozen: the delivery and any invoice already
    // quote it. Reducing it is refused — and the refusal names six, which is the number the planner
    // is looking at on the order. That is the whole property: the screen is not offering a number of
    // its own, it is offering the one the service is about to refuse by.
    const refused = await changeSalesOrder({
      ...base, orderNumber: created.orderNumber, expectedVersion: before!.version,
      requestKey: key('reduce'), rejectLines: [],
      lines: [{
        lineNumber: before!.lines[0].lineNumber, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: 3, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    }).then(() => null, (caught: unknown) => caught as Error);
    expect(refused).toBeInstanceOf(Error);
    expect(refused!.message).toContain(before!.lines[0].deliveredQuantity);
    expect(refused!.message).toContain('delivered');
  });

  it('the open quantity on the order is the backlog the analysis counts', async () => {
    // Two orders, each partly delivered. The analysis counts a backlog from the deliveries that
    // stand; the order counts an open quantity from the same ones. They are the same arithmetic read
    // twice, and a disagreement between them would mean one of the two screens is lying.
    const first = await ordered(10);
    const second = await ordered(5);
    await goneOut(first.orderNumber, 4);
    await goneOut(second.orderNumber, 2);

    const backlogOf = async (orderNumber: string) => Number((await listAnalysis(tenant.client, {
      kind: 'BACKLOG', groupBy: 'CUSTOMER', filter: { orderNumber },
    })).totals[0]?.quantity ?? '0');

    const expected: Array<[string, number]> = [[first.orderNumber, 6], [second.orderNumber, 3]];
    for (const [orderNumber, open] of expected) {
      const read = await getSalesOrder(tenant.client, orderNumber);
      const onTheOrder = read!.lines.reduce((sum, line) => sum + Number(line.openQuantity), 0);
      expect(onTheOrder).toBe(open);
      expect(await backlogOf(orderNumber)).toBe(onTheOrder);
    }
  });

  it('an order takes more items than the grid used to hold', async () => {
    // The grid was five rows on the screen and ten in the action, and it grows now. What is proved
    // here is the part a screen cannot prove for itself: that the order underneath will carry what
    // the grid sends it, and will report the chain's quantities on every one of them.
    const created = await createSalesOrder({
      ...base, requestKey: key('wide'),
      lines: Array.from({ length: 30 }, () => ({
        lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: 2, quantityUnit: 'UNT', taxCode: 'T10',
      })),
    });
    const read = await getSalesOrder(tenant.client, created.orderNumber);
    expect(read!.lines).toHaveLength(30);
    // Numbered in tens, as items have always been numbered, and every one of them unfulfilled.
    expect(read!.lines[0].lineNumber).toBe(10);
    expect(read!.lines[29].lineNumber).toBe(300);
    for (const line of read!.lines) {
      expect(line.deliveredQuantity).toBe('0');
      expect(line.billedQuantity).toBe('0');
      expect(line.openQuantity).toBe('2');
    }
  });
});
