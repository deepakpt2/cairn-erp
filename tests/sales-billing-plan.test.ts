/**
 * 9248 and 9249 — what is billed when: the billing plan.
 *
 * Until this increment, billing had one source and one only: a delivery whose goods had gone out. That
 * is right for goods and silently makes every other kind of sale unbillable — twelve months of
 * maintenance, a piece of work paid in three stages, a licence renewed every quarter. None of them is
 * delivered, so none of them could be invoiced.
 *
 * A plan hangs off the order item and is made of dates, each carrying a share of the item's value and
 * the day it falls due. It is not a reminder and not a report: the plan *is* the billing schedule. So
 * this file asks about the rules that make a plan worth keeping rather than a list of dates.
 *
 * The shares total a hundred, because a plan that promises ninety has not said when the last tenth is
 * billed. A date is billed once, and only on or after the day it names — a plan is a promise about a
 * day, and the day is the point of it. The value billed is the order's own arithmetic at the share the
 * date carries, not a price looked up again. A cancelled document releases its date, as it releases the
 * delivery it stands against. And a date is withdrawn rather than deleted, because a plan is part of
 * what was agreed about an order and an order whose plan changed twice was agreed three times.
 *
 * Nothing here goes through a screen: the services are called directly, because a screen is a way of
 * reaching a service and not a place where rules live.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveCustomerCredit } from '../src/modules/finance/credit';
import { saveSalesCondition } from '../src/modules/sales/conditions';
import { createSalesOrder } from '../src/modules/sales/sales-order';
import { cancelBillingDocument, createBillingFromPlanDate } from '../src/modules/sales/billing';
import {
  BillingPlanError,
  getBillingPlan,
  listBillingPlans,
  listBillablePlanDates,
  planTypeChoices,
  saveBillingPlan,
} from '../src/modules/sales/billing-plan';
import {
  assignSalesAreaDimensions,
  createTenant,
  defineTestRanges,
  destroyTenant,
  maintainMaterialSales,
  type TestTenant,
} from './helpers';
import { createSalesActor, refreshSalesActor, type SalesActor } from './helpers/sales-actor';

const ACTOR = 'SD9248_BILLING_PLAN';
const AREA = 'CCA1';
const CUSTOMER = 'SD9248CUST1';
const MATERIAL = 'SD9248MAT1';
const PLANT = '1000';
const STORE = '0001';
const DATE = '2026-10-15';

/** The four dates of the plan: two that have come due by DATE and two that have not. */
const FIRST = '2026-10-01';
const SECOND = '2026-11-01';
const THIRD = '2026-12-01';
const FOURTH = '2027-01-01';

let counter = 0;
const key = (label: string) => `sd9248-${label}-${++counter}`;

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

/** Four equal quarters: the milestone plan every test below starts from. */
const QUARTERS = [
  { billingDate: FIRST, percentage: 25 },
  { billingDate: SECOND, percentage: 25 },
  { billingDate: THIRD, percentage: 25 },
  { billingDate: FOURTH, percentage: 25 },
];


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

async function placeOrder(client: string, requestKey: string): Promise<string> {
  const placed = await createSalesOrder({
    ...base,
    client,
    requestKey,
    lines: [{
      lineNumber: undefined,
      materialNumber: MATERIAL,
      plant: PLANT,
      orderQuantity: 2,
      quantityUnit: 'UNT',
      taxCode: 'T10',
    }],
  }, { authorization: await salesAuthority(base.client) });
  return placed.orderNumber;
}

describe('a billing plan says when an order item is billed (9248)', () => {
  let tenant: TestTenant;
  let order = '';
  let firstBilling = '';
  let secondBilling = '';

  beforeAll(async () => {
    tenant = await createTenant('sd9248-billing-plan');
    base.client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(tenant.client, async (tx) => {
      for (const range of [
        { objectCode: 'SALESORD', subObject: 'OR', prefix: 'SO', numberLength: 7 },
        { objectCode: 'BILLING', subObject: 'F2', prefix: 'INV', numberLength: 7 },
        // What a cancellation document draws from: the release test cancels what it billed.
        { objectCode: 'BILLING', subObject: 'S1', prefix: 'CN', numberLength: 7 },
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
        insert into sales_area (client, sales_org, distribution_channel, division, name, created_by)
        values (${tenant.client}, '1000', '10', '01', 'Test sales area', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${tenant.client}, ${PLANT}, 'Test shipping plant', '1000', 'KW', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
        values (${tenant.client}, ${PLANT}, ${STORE}, 'Main store', true, false, ${ACTOR})
        on conflict (client, plant, storage_location) do update set is_active = excluded.is_active
      `);
      await tx.execute(sql`
        insert into credit_control_area (client, credit_control_area, name, currency, warning_threshold_percent, created_by)
        values (${tenant.client}, ${AREA}, 'Test credit area', 'USD', 90, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        update company_code set credit_control_area = ${AREA}
        where client = ${tenant.client} and company_code = '1000'
      `);
      await tx.execute(sql`
        insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
        values (${tenant.client}, 'KW', 'T10', 'Output tax 10 percent', 'VAT', 10, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into credit_risk_category (client, risk_category, name, created_by)
        values (${tenant.client}, 'A', 'Low risk', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${tenant.client}, ${CUSTOMER}, 'ORGANIZATION', ${`Test customer ${CUSTOMER}`}, ${ACTOR})
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
        values (${tenant.client}, ${CUSTOMER}, 'CUSTOMER', '1000', '10', '01', 'PR01', false, 'MAINTAINED', ${ACTOR})
        on conflict (client, partner_number, sales_org, distribution_channel, division)
        do update set sales_status = excluded.sales_status
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
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${tenant.client}, ${MATERIAL}, 'Billing plan test material', 'RAW', 'UNT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        values (${tenant.client}, ${MATERIAL}, ${PLANT}, ${ACTOR}) on conflict do nothing
      `);
    });
    await maintainMaterialSales(tenant, { materialNumber: MATERIAL, deliveringPlant: PLANT });
    await saveCustomerCredit({
      client: tenant.client, changedBy: ACTOR, customer: CUSTOMER, creditControlArea: AREA,
      creditLimit: '1000000.00', riskCategory: 'A', isBlocked: false,
      changeReason: 'Billing plan test fixture.',
    });
    // Twenty-five a unit: two units is fifty net, five tax, fifty-five gross, and a quarter of that is
    // what each of the four dates bills.
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      customerNumber: '', materialNumber: MATERIAL, currency: 'USD', amount: 25, priceUnit: 1,
      validityFrom: '2026-01-01', validityTo: '2026-12-31', supersedeStanding: false,
    });
  }, 120_000);

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
  });

  it('delivers the two kinds of plan with the package, in words a maintainer reads', async () => {
    const types = await planTypeChoices(tenant.client);
    expect(types.map((row) => row.planType)).toEqual(['MS', 'PE']);
    for (const row of types) {
      // A code nobody can read is a code somebody will guess at.
      expect(row.meaning.length).toBeGreaterThan(40);
      expect(row.displayName.length).toBeGreaterThan(3);
    }
  });

  it('shares a hundred per cent between the dates, and refuses every other number', async () => {
    order = await placeOrder(tenant.client, key('order'));
    const short = { ...QUARTERS[0], percentage: 40 };
    await expect(saveBillingPlan({
      client: tenant.client, changedBy: ACTOR, orderNumber: order, orderLineNumber: 10,
      planType: 'MS', dates: [short, QUARTERS[1], QUARTERS[2]],
      reason: 'A plan that promises ninety.',
    })).rejects.toBeInstanceOf(BillingPlanError);
    await expect(saveBillingPlan({
      client: tenant.client, changedBy: ACTOR, orderNumber: order, orderLineNumber: 10,
      planType: 'MS', dates: [short, QUARTERS[1], QUARTERS[2]],
      reason: 'A plan that promises ninety.',
    })).rejects.toThrow(/90/);

    await expect(saveBillingPlan({
      client: tenant.client, changedBy: ACTOR, orderNumber: order, orderLineNumber: 10,
      planType: 'MS',
      dates: [{ billingDate: FIRST, percentage: 60 }, { billingDate: SECOND, percentage: 50 }],
      reason: 'A plan that promises a hundred and ten.',
    })).rejects.toThrow(/110/);
    // Nothing was written by either refusal: an item keeps no half-plan behind.
    expect(await getBillingPlan(tenant.client, order, 10)).toBeNull();
  });

  it('writes the plan as a whole, and reads it back with the shares it was given', async () => {
    const saved = await saveBillingPlan({
      client: tenant.client, changedBy: ACTOR, orderNumber: order, orderLineNumber: 10,
      planType: 'MS', dates: QUARTERS, reason: 'Agreed schedule with the customer.',
    });
    expect(saved.version).toBe(1);

    const plan = await getBillingPlan(tenant.client, order, 10);
    expect(plan?.planType).toBe('MS');
    expect(plan?.planTypeName).toBe('Milestone');
    expect(plan?.totalPercentage).toBe(100);
    // Dates are numbered in tens, and the number a date carries is the number it keeps.
    expect(plan?.dates.map((date) => date.dateNumber)).toEqual([10, 20, 30, 40]);
    expect(plan?.dates.map((date) => date.billingDate)).toEqual([FIRST, SECOND, THIRD, FOURTH]);
    expect(plan?.dates.every((date) => date.status === 'OPEN')).toBe(true);

    const listed = await listBillingPlans(tenant.client, { orderNumber: order });
    expect(listed).toHaveLength(1);
    expect(listed[0].materialNumber).toBe(MATERIAL);
  });

  it('offers a date on the day it names, and not a day before it', async () => {
    const before = await listBillablePlanDates(tenant.client, { onDate: '2026-09-30', orderNumber: order });
    expect(before).toHaveLength(0);

    const due = await listBillablePlanDates(tenant.client, { onDate: FIRST, orderNumber: order });
    expect(due).toHaveLength(1);
    // A quarter of the item, in quantity and in money: two units at twenty-five, plus ten per cent tax.
    expect(due[0]).toMatchObject({
      orderNumber: order, orderLineNumber: 10, dateNumber: 10, billingDate: FIRST, percentage: 25,
      quantity: '0.500', quantityUnit: 'UNT', value: '13.75', currency: 'USD',
    });

    const later = await listBillablePlanDates(tenant.client, { onDate: THIRD, orderNumber: order });
    expect(later.map((row) => row.dateNumber)).toEqual([10, 20, 30]);
  });

  it('bills a date at the share it names, and the document names no delivery', async () => {
    const result = await createBillingFromPlanDate({
      client: tenant.client, changedBy: ACTOR, orderNumber: order, orderLineNumber: 10,
      dateNumber: 10, billingDate: FIRST, requestKey: key('bill-first'),
    }, { authorization: await salesAuthority(base.client) });
    firstBilling = result.billing.billingNumber;
    expect(result.posted).toBe(true);
    expect(result.replayed).toBe(false);
    // Nothing was shipped and no delivery is invented to satisfy a column that used to be not-null.
    expect(result.billing.deliveryNumber).toBeNull();
    expect(result.billing.orderNumber).toBe(order);
    expect(result.billing.lines).toHaveLength(1);
    expect(result.billing.lines[0].deliveryLineNumber).toBeNull();
    expect(result.billing.lines[0].orderLineNumber).toBe(10);
    expect(result.billing.lines[0].billingQuantity).toBe('0.500');
    // The order's own arithmetic at a quarter: fifty net and five tax, quartered.
    expect(Number(result.billing.netValue)).toBe(12.5);
    expect(Number(result.billing.taxValue)).toBe(1.25);
    expect(Number(result.billing.grossValue)).toBe(13.75);
    expect(result.billing.customerInvoiceNumber).not.toBeNull();

    const plan = await getBillingPlan(tenant.client, order, 10);
    const billed = plan?.dates.find((date) => date.dateNumber === 10);
    expect(billed?.status).toBe('BILLED');
    expect(billed?.billingNumber).toBe(firstBilling);
    // Billed and no longer offered: the due list is what is left to do, not what has been done.
    const due = await listBillablePlanDates(tenant.client, { onDate: THIRD, orderNumber: order });
    expect(due.map((row) => row.dateNumber)).toEqual([20, 30]);
  });

  it('refuses a date before its day, and again once it has been billed', async () => {
    await expect(createBillingFromPlanDate({
      client: tenant.client, changedBy: ACTOR, orderNumber: order, orderLineNumber: 10,
      dateNumber: 20, billingDate: '2026-10-14', requestKey: key('bill-early'),
    }, { authorization: await salesAuthority(base.client) })).rejects.toThrow(new RegExp(SECOND));

    await expect(createBillingFromPlanDate({
      client: tenant.client, changedBy: ACTOR, orderNumber: order, orderLineNumber: 10,
      dateNumber: 10, billingDate: FIRST, requestKey: key('bill-twice'),
    }, { authorization: await salesAuthority(base.client) })).rejects.toThrow(new RegExp(firstBilling));
  });

  it('will not rewrite a plan one of whose dates has been billed', async () => {
    await expect(saveBillingPlan({
      client: tenant.client, changedBy: ACTOR, orderNumber: order, orderLineNumber: 10,
      planType: 'MS', dates: QUARTERS, reason: 'Changing a plan that is settled.',
      expectedVersion: 1,
    })).rejects.toThrow(new RegExp(firstBilling));
  });

  it('releases the date when the document that billed it is cancelled, and it can be billed again', async () => {
    const cancelled = await cancelBillingDocument({
      client: tenant.client, changedBy: ACTOR, billingNumber: firstBilling,
      postingDate: DATE, reason: 'Wrong share on the first date.',
    });
    expect(cancelled.billing.status).toBe('CANCELLED');

    const released = await getBillingPlan(tenant.client, order, 10);
    const date = released?.dates.find((row) => row.dateNumber === 10);
    expect(date?.status).toBe('OPEN');
    expect(date?.billingNumber).toBeNull();

    const again = await createBillingFromPlanDate({
      client: tenant.client, changedBy: ACTOR, orderNumber: order, orderLineNumber: 10,
      dateNumber: 10, billingDate: FIRST, requestKey: key('bill-released'),
    }, { authorization: await salesAuthority(base.client) });
    secondBilling = again.billing.billingNumber;
    expect(again.billing.billingNumber).not.toBe(firstBilling);
    expect(Number(again.billing.grossValue)).toBe(13.75);
    expect(again.posted).toBe(true);
  });

  it('withdraws a date that is not submitted again, and a withdrawn date bills nothing', async () => {
    // Cancel first: a plan with a billed date is settled as it stands.
    await cancelBillingDocument({
      client: tenant.client, changedBy: ACTOR, billingNumber: secondBilling,
      postingDate: DATE, reason: 'Closing the fixture.',
    });
    const before = await getBillingPlan(tenant.client, order, 10);
    const rewritten = await saveBillingPlan({
      client: tenant.client, changedBy: ACTOR, orderNumber: order, orderLineNumber: 10,
      planType: 'MS',
      dates: [
        { dateNumber: 10, billingDate: FIRST, percentage: 50 },
        { dateNumber: 20, billingDate: SECOND, percentage: 50 },
      ],
      reason: 'Two stages instead of four.',
      expectedVersion: before!.version,
    });
    expect(rewritten.version).toBe(before!.version + 1);

    const plan = await getBillingPlan(tenant.client, order, 10);
    expect(plan?.totalPercentage).toBe(100);
    // The withdrawn dates stay: a plan is part of what was agreed about this order.
    expect(plan?.dates).toHaveLength(4);
    expect(plan?.dates.filter((date) => date.status === 'WITHDRAWN').map((date) => date.dateNumber))
      .toEqual([30, 40]);
    // The dates that stand keep the numbers they were given.
    expect(plan?.dates.filter((date) => date.status === 'OPEN').map((date) => date.percentage))
      .toEqual([50, 50]);

    await expect(createBillingFromPlanDate({
      client: tenant.client, changedBy: ACTOR, orderNumber: order, orderLineNumber: 10,
      dateNumber: 30, billingDate: THIRD, requestKey: key('bill-withdrawn'),
    }, { authorization: await salesAuthority(base.client) })).rejects.toThrow(/withdrawn/i);
  });
});
