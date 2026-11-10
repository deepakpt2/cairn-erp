import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveCustomerCredit } from '../src/modules/finance/credit';
import { saveSalesCondition } from '../src/modules/sales/conditions';
import {
  addPricingProcedureStep, definePricingProcedure, defineProcedureDetermination,
} from '../src/modules/sales/pricing-procedure-maintenance';
import { billDueList } from '../src/modules/sales/billing';
import {
  confirmDeliveryPicks, createDelivery, getDelivery, listDeliverableOrderLines, postDeliveryGoodsIssue,
} from '../src/modules/sales/delivery';
import { changeSalesOrder, createSalesOrder, getSalesOrder } from '../src/modules/sales/sales-order';
import { listAnalysis } from '../src/modules/sales/analysis';
import { listDocumentRegister } from '../src/modules/sales/registers';
import {
  assignSalesAreaDimensions, createTenant, destroyTenant, maintainMaterialSales,
  type TestTenant,
} from './helpers';

/**
 * §5.3 — sales analysis: sales, backlog, returns, margin.
 *
 * An analysis is read by somebody who is not about to do anything with what they see, which is what
 * makes it different from a register and what it owes them. Four promises are proved here, and they
 * are the ones a reader would be harmed by if they were broken:
 *
 * **It ties to the register.** The plan sets this as the demonstration for Phase 5: the analysis
 * totals tie to the billing register, and through it to the ledger. A report that agreed with
 * nothing else in the system is not a report.
 *
 * **Money is never added across currencies.** Every row carries one, and the totals are reported
 * once per currency.
 *
 * **The backlog is the open quantity, read the way the chain reads it.** The same join
 * `fulfillment-quantities.ts` uses, because that module is what refuses a delivery that carries too
 * much. An analysis that called a line open when the delivery service calls it drawn down would be
 * worse than no analysis.
 *
 * **No margin is printed where no cost stands.** The most dangerous figure a margin report can
 * print is a margin equal to its revenue, which is what you get when an absent cost is read as zero.
 */
const ACTOR = 'SD9257_ANALYSIS';
const AREA = 'CCA1';
const CUSTOMER = 'SD9257CUST1';
const OTHER_CUSTOMER = 'SD9257CUST2';
const MATERIAL = 'SD9257MAT1';
const NOCOST_CUSTOMER = 'SD9257CUST3';
/** The pricing procedure this customer is priced by, and the one that carries no cost step. */
const NOCOST_PROCEDURE = 'NP01';
const PLANT = '1000';
const STORE = '0001';
const DATE = '2026-10-16';
const LATER = '2026-11-16';

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

/** The material is priced at 25 a unit and valued at 10, so a unit earns 15. */
const PRICE = 25;
const COST = 10;

describe('sales analysis: sales, backlog, returns and margin (§5.3)', () => {
  let tenant: TestTenant;
  let counter = 0;
  const key = (what: string) => `sd9257-${what}-${++counter}`;

  beforeAll(async () => {
    tenant = await createTenant('sd9257-analysis');
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
        values (${tenant.client}, ${CUSTOMER}, 'ORGANIZATION', 'Analysis test customer', ${ACTOR})
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
      for (const partner of [OTHER_CUSTOMER, NOCOST_CUSTOMER]) {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${tenant.client}, ${partner}, 'ORGANIZATION', ${`Analysis test ${partner}`}, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${tenant.client}, ${partner}, 'CUSTOMER', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into customer_sales_area (
          client, partner_number, role_code, sales_org, distribution_channel, division,
          pricing_procedure, is_blocked, sales_status, created_by
        )
        values (${tenant.client}, ${partner}, 'CUSTOMER', '1000', '10', '01',
                ${partner === NOCOST_CUSTOMER ? 'NP' : 'PR01'}, false, 'MAINTAINED', ${ACTOR})
        on conflict (client, partner_number, sales_org, distribution_channel, division)
        do update set is_blocked = false, sales_status = 'MAINTAINED'
      `);
      await tx.execute(sql`
        insert into customer_company_code (
          client, partner_number, role_code, company_code, chart_of_accounts,
          reconciliation_account, payment_terms_code, created_by
        )
        values (${tenant.client}, ${partner}, 'CUSTOMER', '1000', 'CA01', '110000', 'NET30', ${ACTOR})
        on conflict do nothing
      `);
      }
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${tenant.client}, ${MATERIAL}, 'Analysis test material', 'RAW', 'UNT', ${ACTOR})
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
        values (${tenant.client}, 'MD-ANA001', 2026, ${DATE}, ${DATE}, 'Opening balance', 'POSTED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (client, material_document_number, line_number, movement_type,
                                            material_number, plant, storage_location, stock_type,
                                            line_direction, entry_quantity, entry_unit, base_quantity,
                                            base_unit, created_by)
        values (${tenant.client}, 'MD-ANA001', 1, 'OPENING_BALANCE', ${MATERIAL}, ${PLANT}, ${STORE},
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
    // A customer priced by a procedure that names no cost step, which is the ordinary way a tenant
    // comes to have documents with no cost on them — not a broken material, but a pricing decision.
    await definePricingProcedure({
      client: tenant.client, changedBy: ACTOR, procedureCode: NOCOST_PROCEDURE, name: 'Priced without a cost',
    });
    await addPricingProcedureStep({
      client: tenant.client, changedBy: ACTOR, procedureCode: NOCOST_PROCEDURE, stepNumber: 10,
      conditionType: 'PR00', isRequired: true, conditionLevel: 'ITEM',
    });
    await addPricingProcedureStep({
      client: tenant.client, changedBy: ACTOR, procedureCode: NOCOST_PROCEDURE, stepNumber: 40,
      conditionType: 'MWST', fromStep: 10, toStep: 10, conditionLevel: 'ITEM',
    });
    await defineProcedureDetermination({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      documentPricingProcedure: 'A', customerPricingProcedure: 'NP', procedureCode: NOCOST_PROCEDURE,
    });
    const area = { salesOrg: '1000', distributionChannel: '10', division: '01' };
    const period = { validityFrom: '2026-01-01', validityTo: '2026-12-31', supersedeStanding: false };
    for (const partner of [CUSTOMER, OTHER_CUSTOMER, NOCOST_CUSTOMER]) {
      await saveSalesCondition({
        client: tenant.client, changedBy: ACTOR, ...area, customerNumber: partner,
        materialNumber: MATERIAL, currency: 'USD', amount: PRICE, priceUnit: 1, ...period,
      });
    }
    for (const partner of [CUSTOMER, OTHER_CUSTOMER, NOCOST_CUSTOMER]) {
      await saveCustomerCredit({
        client: tenant.client, changedBy: ACTOR, customer: partner, creditControlArea: AREA,
        creditLimit: '1000000.00', riskCategory: 'A', isBlocked: false,
        changeReason: 'Analysis test credit data.',
      });
    }
  });

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
  });

  /** One order, priced and standing. */
  async function ordered(units: number, customerNumber = CUSTOMER, materialNumber = MATERIAL) {
    return createSalesOrder({
      ...base, customerNumber, requestKey: key('order'),
      lines: [{
        lineNumber: undefined, materialNumber, plant: PLANT,
        orderQuantity: units, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    });
  }

  /** An order, delivered and goods issued. */
  async function shipped(units: number, customerNumber = CUSTOMER, materialNumber = MATERIAL) {
    const created = await ordered(units, customerNumber, materialNumber);
    const open = await listDeliverableOrderLines(tenant.client, { orderNumber: created.orderNumber });
    const built = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.orderNumber, deliveryDate: DATE,
      goodsMovementDate: DATE, headerText: 'Analysis fixture',
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
    return { orderNumber: created.orderNumber, deliveryNumber: built.deliveryNumber };
  }

  /** Ordered, shipped and billed. */
  async function billed(
    units: number, customerNumber = CUSTOMER, materialNumber = MATERIAL, billingDate = DATE,
  ) {
    const chain = await shipped(units, customerNumber, materialNumber);
    const [document] = (await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate,
      selection: { deliveryNumber: chain.deliveryNumber },
    })).documents;
    return { ...chain, billingNumber: document.billing.billingNumber };
  }

  it('the sales analysis ties to the billing register', async () => {
    // The demonstration the plan sets for Phase 5, on a customer of its own so that nothing another
    // test raises can walk into it. Two orders, four and six units, both delivered and billed.
    await billed(4, OTHER_CUSTOMER);
    await billed(6, OTHER_CUSTOMER);

    const byCustomer = await listAnalysis(tenant.client, {
      kind: 'SALES', groupBy: 'CUSTOMER', filter: { customerNumber: OTHER_CUSTOMER },
    });
    expect(byCustomer.rows).toHaveLength(1);
    expect(byCustomer.rows[0].key).toBe(OTHER_CUSTOMER);
    expect(byCustomer.rows[0].currency).toBe('USD');
    expect(Number(byCustomer.rows[0].quantity)).toBe(10);
    expect(Number(byCustomer.rows[0].netValue)).toBe(250);

    // The same ten units, read off the documents rather than off the lines. What the register totals
    // and what the analysis totals are the same money, or one of them is not describing anything.
    const register = await listDocumentRegister(tenant.client, {
      kind: 'BILLING', filter: { customerNumber: OTHER_CUSTOMER },
    });
    expect(register.count).toBe(2);
    expect(Number(register.totals.netValue)).toBe(Number(byCustomer.totals[0].netValue));
    expect(byCustomer.totals).toHaveLength(1);
    expect(byCustomer.totals[0].currency).toBe('USD');
  });

  it('what was sold is grouped the way the business asks about it', async () => {
    const { billingNumber } = await billed(4);

    const byMaterial = await listAnalysis(tenant.client, {
      kind: 'SALES', groupBy: 'MATERIAL', filter: { documentNumber: billingNumber },
    });
    expect(byMaterial.rows).toHaveLength(1);
    expect(byMaterial.rows[0].key).toBe(MATERIAL);
    expect(byMaterial.rows[0].keyName).toContain('Analysis test material');
    expect(Number(byMaterial.rows[0].netValue)).toBe(100);

    // The same money, cut three other ways. A report that can only be cut one way is a report that
    // answers one question.
    for (const [groupBy, expected] of [
      ['CUSTOMER', CUSTOMER], ['SALES_ORG', '1000'], ['DOCUMENT_TYPE', 'F2'],
    ] as const) {
      const answer = await listAnalysis(tenant.client, {
        kind: 'SALES', groupBy, filter: { documentNumber: billingNumber },
      });
      expect(answer.rows).toHaveLength(1);
      expect(answer.rows[0].key).toBe(expected);
    }

    // Grouped by period, the row is the bucket and not a document attribute.
    const byPeriod = await listAnalysis(tenant.client, {
      kind: 'SALES', groupBy: 'PERIOD', period: 'MONTH', filter: { documentNumber: billingNumber },
    });
    expect(byPeriod.rows).toHaveLength(1);
    expect(byPeriod.rows[0].key).toBe('2026-10');
  });

  it('the period axis buckets the way the reader asked', async () => {
    // Two invoices a month apart. Asked for the whole window, one row; asked by month, two, in order.
    await billed(2, CUSTOMER, MATERIAL, DATE);
    await billed(3, CUSTOMER, MATERIAL, LATER);

    const whole = await listAnalysis(tenant.client, {
      kind: 'SALES', groupBy: 'CUSTOMER', period: 'TOTAL',
      filter: { customerNumber: CUSTOMER, materialNumber: MATERIAL, dateFrom: DATE, dateTo: LATER },
    });
    expect(whole.rows).toHaveLength(1);
    expect(whole.rows[0].period).toBe('');

    const monthly = await listAnalysis(tenant.client, {
      kind: 'SALES', groupBy: 'PERIOD', period: 'MONTH',
      filter: { customerNumber: CUSTOMER, materialNumber: MATERIAL, dateFrom: DATE, dateTo: LATER },
    });
    expect(monthly.rows.map((row) => row.key)).toEqual(['2026-10', '2026-11']);
    expect(monthly.rows).toHaveLength(2);

    // And a window that names a month that holds nothing answers nothing rather than everything.
    const outside = await listAnalysis(tenant.client, {
      kind: 'SALES', groupBy: 'PERIOD', period: 'MONTH',
      filter: { dateFrom: '2027-01-01', dateTo: '2027-12-31' },
    });
    expect(outside.rows).toEqual([]);
    expect(outside.totals).toEqual([]);
  });

  it('the backlog is what is still to come, read the way the chain reads it', async () => {
    const created = await ordered(10);
    const open = await listDeliverableOrderLines(tenant.client, { orderNumber: created.orderNumber });
    const built = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.orderNumber, deliveryDate: DATE,
      goodsMovementDate: DATE, headerText: 'Analysis fixture',
      items: [{ orderLineNumber: open[0].lineNumber, quantity: '4' }],
      requestKey: key('delivery'),
    });
    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: built.deliveryNumber,
      items: [{ lineNumber: 10, quantity: '4', storageLocation: STORE }],
    });
    const picked = await getDelivery(tenant.client, built.deliveryNumber);
    await postDeliveryGoodsIssue({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: built.deliveryNumber,
      expectedVersion: picked!.version, postingDate: DATE, documentDate: DATE,
    });

    const backlog = await listAnalysis(tenant.client, {
      kind: 'BACKLOG', groupBy: 'CUSTOMER', filter: { orderNumber: created.orderNumber },
    });
    expect(backlog.rows).toHaveLength(1);
    // Ten ordered, four gone: six still to come, at the price the line was agreed at.
    expect(Number(backlog.rows[0].quantity)).toBe(6);
    expect(Number(backlog.rows[0].netValue)).toBe(6 * PRICE);
    // The backlog carries no cost, because a promise to ship is not a sale.
    expect(backlog.rows[0].costValue).toBeNull();

    // A rejected line is not part of what is still to come: it is finished. Two lines were ordered,
    // eight units on the first and three on the second, and the first is rejected — so what is open
    // is the three, at the price they were agreed at.
    const withRejected = await createSalesOrder({
      ...base, requestKey: key('order'),
      lines: [
        {
          lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
          orderQuantity: 8, quantityUnit: 'UNT', taxCode: 'T10',
        },
        {
          lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
          orderQuantity: 3, quantityUnit: 'UNT', taxCode: 'T10',
        },
      ],
    });
    const standing = await getSalesOrder(tenant.client, withRejected.orderNumber);
    const rejectedLine = standing!.lines[0].lineNumber;
    const keptLine = standing!.lines[1].lineNumber;
    await changeSalesOrder({
      ...base, orderNumber: withRejected.orderNumber, expectedVersion: standing!.version,
      requestKey: key('reject'),
      rejectLines: [{ lineNumber: rejectedLine, reason: 'CUST' }],
      lines: [{
        lineNumber: keptLine, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: 3, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    });
    const afterRejection = await listAnalysis(tenant.client, {
      kind: 'BACKLOG', groupBy: 'CUSTOMER', filter: { orderNumber: withRejected.orderNumber },
    });
    expect(afterRejection.rows).toHaveLength(1);
    expect(Number(afterRejection.rows[0].quantity)).toBe(3);
    expect(Number(afterRejection.rows[0].netValue)).toBe(3 * PRICE);
    // Eight units were on the order and eight are gone from the backlog, which is what a rejection
    // means: not deferred, finished.
    expect(afterRejection.rows[0].quantity).not.toBe('11');

    // And nothing is open on an order that was delivered in full.
    const complete = await shipped(5);
    const none = await listAnalysis(tenant.client, {
      kind: 'BACKLOG', groupBy: 'CUSTOMER', filter: { orderNumber: complete.orderNumber },
    });
    expect(none.rows).toEqual([]);
  });

  it('the margin is read from the cost the pricing carried', async () => {
    const { billingNumber } = await billed(4);
    const margin = await listAnalysis(tenant.client, {
      kind: 'MARGIN', groupBy: 'MATERIAL', filter: { documentNumber: billingNumber },
    });
    expect(margin.rows).toHaveLength(1);
    // Four units at 25, valued at 10 apiece: 100 of revenue, 40 of cost, 60 earned.
    expect(Number(margin.rows[0].netValue)).toBe(4 * PRICE);
    expect(Number(margin.rows[0].costValue)).toBe(4 * COST);
    expect(Number(margin.rows[0].marginValue)).toBe(4 * (PRICE - COST));
    expect(Number(margin.rows[0].marginPercent)).toBe(60);
    expect(margin.rows[0].costIsComplete).toBe(true);
    expect(margin.totals[0].costIsComplete).toBe(true);

    // Sales is the same money without the cost: two questions about one set of documents, not two
    // sets of documents.
    const sales = await listAnalysis(tenant.client, {
      kind: 'SALES', groupBy: 'MATERIAL', filter: { documentNumber: billingNumber },
    });
    expect(Number(sales.rows[0].netValue)).toBe(Number(margin.rows[0].netValue));
    expect(sales.rows[0].costValue).toBeNull();
  });

  it('no margin is printed where the pricing carried no cost', async () => {
    // This customer is priced by a procedure that names no cost step, which is the ordinary way a
    // tenant comes to have documents with no cost on them. A cost that was never calculated is
    // absent, not zero. The dangerous answer is 100 of revenue, 0 of cost and a margin of 100 per
    // cent — which is what you get by reading an absent cost as nothing.
    const { billingNumber } = await billed(4, NOCOST_CUSTOMER);
    const margin = await listAnalysis(tenant.client, {
      kind: 'MARGIN', groupBy: 'CUSTOMER', filter: { customerNumber: NOCOST_CUSTOMER },
    });
    expect(margin.rows).toHaveLength(1);
    expect(Number(margin.rows[0].netValue)).toBe(4 * PRICE);
    expect(margin.rows[0].costValue).toBeNull();
    expect(margin.rows[0].marginValue).toBeNull();
    expect(margin.rows[0].marginPercent).toBeNull();
    expect(margin.rows[0].costIsComplete).toBe(false);
    expect(margin.totals[0].costIsComplete).toBe(false);
    // The revenue is still there, and still right: a missing cost does not make the sale vanish.
    expect(Number(margin.totals[0].netValue)).toBe(4 * PRICE);
  });

  it('money is never added across currencies, and a currency that stands for nothing answers nothing', async () => {
    const { billingNumber } = await billed(2);
    const usd = await listAnalysis(tenant.client, {
      kind: 'SALES', groupBy: 'CUSTOMER', filter: { documentNumber: billingNumber, currency: 'USD' },
    });
    expect(usd.rows).toHaveLength(1);
    expect(usd.totals).toHaveLength(1);
    expect(usd.totals[0].currency).toBe('USD');

    // The document is stated in USD, so naming another currency answers nothing rather than
    // answering the same money under a different name.
    const eur = await listAnalysis(tenant.client, {
      kind: 'SALES', groupBy: 'CUSTOMER', filter: { documentNumber: billingNumber, currency: 'EUR' },
    });
    expect(eur.rows).toEqual([]);
  });

  it('returns are read where a tenant has them, and nowhere else', async () => {
    // No returns chain is configured, so the analysis answers nothing rather than guessing that a
    // negative quantity is a return. The same promise the returns register makes (§5.2).
    const returns = await listAnalysis(tenant.client, { kind: 'RETURNS', groupBy: 'CUSTOMER' });
    expect(returns.kind).toBe('RETURNS');
    expect(returns.rows).toEqual([]);
    expect(returns.totals).toEqual([]);
    expect(returns.count).toBe(0);
  });
});
