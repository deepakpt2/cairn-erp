/**
 * 9250 — money before the goods: the down payment.
 *
 * A delivery earns an invoice when its goods go out, and a plan date bills the share that has fallen
 * due. Neither is any answer to a customer who is asked to pay part of an order in advance: nothing
 * has been delivered and nothing has yet been earned. An invoice is a claim about goods or work, not a
 * request for money.
 *
 * So the advance has three acts, and this file asks about each of them and about the seams between
 * them. Asking raises a *request*: a billing document of its own in Sales, backed by a noted item in
 * accounting that posts nothing at all — no receivable, no journal, no revenue. Receiving is
 * accounting's act, and the money lands on an alternative reconciliation account, outside the
 * customer's ordinary receivables. And settling happens when the invoice that earned the advance is
 * raised: the transfer posting moves the advance onto the receivable, so what is still to pay is the
 * billed value less it.
 *
 * The rules this file holds to are the ones that keep the money honest. A request that money has
 * arrived against cannot be withdrawn — it is settled, not erased. A clearing takes the lesser of what
 * the advance still stands at and what the invoice still stands open at, and neither can be cleared
 * twice, because both are read from posted lines. Nothing defaults the indicator: what a request
 * indicator is, is configuration. And a plan that asks only for advances does not answer when the item
 * is billed, so the item stays billable by its deliveries — a plan with no invoice date that blocked
 * delivery billing would make the order unbillable and the advance unsettleable.
 *
 * Nothing here goes through a screen: the services are called directly, because a screen is a way of
 * reaching a service and not a place where rules live.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveCustomerCredit } from '../src/modules/finance/credit';
import { postCustomerDownPayment } from '../src/modules/finance/customer-down-payment';
import { getCustomerDownPaymentClearing } from '../src/modules/finance/customer-down-payment-clearing';
import { saveSalesCondition } from '../src/modules/sales/conditions';
import { createSalesOrder } from '../src/modules/sales/sales-order';
import { createBillingFromPlanDate } from '../src/modules/sales/billing';
import {
  plansForItems, saveBillingPlan, BillingPlanError,
} from '../src/modules/sales/billing-plan';
import {
  cancelDownPaymentRequest, orderDownPayments, requestDownPaymentFromPlanDate,
} from '../src/modules/sales/down-payment';
import { journalEntry } from '../src/modules/finance/schema';
import {
  assignSalesAreaDimensions,
  createTenant,
  defineTestRanges,
  destroyTenant,
  maintainMaterialSales,
  type TestTenant,
} from './helpers';
import { createSalesActor, refreshSalesActor, type SalesActor } from './helpers/sales-actor';

const ACTOR = 'SD9250_DOWN_PAYMENT';
const AREA = 'CCA1';
const CUSTOMER = 'SD9250CUST1';
const MATERIAL = 'SD9250MAT1';
const PLANT = '1000';
const STORE = '0001';
const DATE = '2026-10-15';

/** The day the advance falls due, and the two days the invoices fall on. */
const FIRST = '2026-10-01';
const SECOND = '2026-11-01';
const THIRD = '2026-12-01';
/** The alternative reconciliation account the advance lands on, and the ordinary one it settles to. */
const ALT_RECON = '230000';
const RECON = '110000';

let counter = 0;
const key = (label: string) => `sd9250-${label}-${++counter}`;

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

describe('money before the goods: the down payment (9250)', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTenant('sd9250-down-payment');
    base.client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(tenant.client, async (tx) => {
      for (const range of [
        { objectCode: 'SALESORD', subObject: 'OR', prefix: 'SO', numberLength: 7 },
        // The request document draws from the billing interval: a second interval is configuration a
        // tenant may make, not a prerequisite for asking for an advance.
        { objectCode: 'BILLING', subObject: 'F2', prefix: 'INV', numberLength: 7 },
        { objectCode: 'CUSTINV', subObject: '*', prefix: 'CI', numberLength: 7 },
        { objectCode: 'CUSTDPREQ', subObject: '*', prefix: 'CR', numberLength: 7 },
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
        values (${tenant.client}, ${CUSTOMER}, 'CUSTOMER', '1000', 'CA01', ${RECON}, 'NET30', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${tenant.client}, ${MATERIAL}, 'Down payment test material', 'RAW', 'UNT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        values (${tenant.client}, ${MATERIAL}, ${PLANT}, ${ACTOR}) on conflict do nothing
      `);
      // What a down payment is, is configuration and not a letter the code knows: A is an actual
      // indicator, and F is a request indicator because it names A as the indicator the receipt
      // arrives under.
      await tx.execute(sql`
        insert into special_gl_config (
          client, company_code, account_type, indicator,
          alternative_reconciliation_account, target_special_gl_indicator, description, created_by
        )
        values
          (${tenant.client}, '', 'AR', 'A', ${ALT_RECON}, null, 'Customer advances', ${ACTOR}),
          (${tenant.client}, '', 'AR', 'F', ${ALT_RECON}, 'A', 'Advance requests', ${ACTOR})
        on conflict do nothing
      `);
    });
    await maintainMaterialSales(tenant, { materialNumber: MATERIAL, deliveringPlant: PLANT });
    await saveCustomerCredit({
      client: tenant.client, changedBy: ACTOR, customer: CUSTOMER, creditControlArea: AREA,
      creditLimit: '1000000.00', riskCategory: 'A', isBlocked: false,
      changeReason: 'Down payment test fixture.',
    });
    // Twenty-five a unit: two units is fifty net, five tax, fifty-five gross. A quarter of the item is
    // 13.75 as money — 12.50 net and 1.25 tax — and that is what the advance asks for.
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      customerNumber: '', materialNumber: MATERIAL, currency: 'USD', amount: 25, priceUnit: 1,
      validityFrom: '2026-01-01', validityTo: '2026-12-31', supersedeStanding: false,
    });
  }, 120_000);

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
  });

  /** An order of two units of the material, quoted by the condition above. */
  async function place(): Promise<string> {
    const placed = await createSalesOrder({
      ...base,
      requestKey: key('order'),
      lines: [{
        lineNumber: undefined,
        materialNumber: MATERIAL,
        plant: PLANT,
        orderQuantity: 2,
        quantityUnit: 'UNT',
        taxCode: 'T10',
      }],
    }, { authorization: await salesAuthority(tenant.client) });
    return placed.orderNumber;
  }

  /** An advance on the first day, and the whole of the item invoiced in two halves after it. */
  async function plan(orderNumber: string): Promise<void> {
    await saveBillingPlan({
      client: tenant.client, changedBy: ACTOR, orderNumber, orderLineNumber: 10,
      planType: 'MS', reason: 'A quarter in advance, the rest on delivery.',
      dates: [
        { billingDate: FIRST, percentage: 25, billingRule: 'DOWN_PAYMENT' },
        { billingDate: SECOND, percentage: 50, billingRule: 'INVOICE' },
        { billingDate: THIRD, percentage: 50, billingRule: 'INVOICE' },
      ],
    });
  }

  it('asks for an advance without posting anything, and the date stands billed by it', async () => {
    const orderNumber = await place();
    await plan(orderNumber);

    const raised = await requestDownPaymentFromPlanDate({
      client: tenant.client, changedBy: ACTOR, orderNumber, orderLineNumber: 10,
      dateNumber: 10, billingDate: FIRST, requestKey: key('ask'),
    });
    expect(raised.replayed).toBe(false);
    // What a customer pays is net plus tax: a quarter of fifty-five, not a quarter of fifty.
    expect(raised.amount).toBe('13.75');
    expect(raised.currency).toBe('USD');
    // The indicator is configuration, and the target is the one the receipt will arrive under.
    expect(raised.indicator).toBe('F');
    expect(raised.targetIndicator).toBe('A');
    expect(raised.dueDate).toBe(FIRST);

    // Asking posts nothing. A noted item is a drawn number and no journal at all, and a request that
    // created a receivable would be a receivable for goods nobody has earned.
    const journals = await withTenant(tenant.client, (tx) => tx
      .select({ n: journalEntry.documentNumber })
      .from(journalEntry));
    expect(journals).toHaveLength(0);

    const register = await orderDownPayments(tenant.client, orderNumber);
    expect(register).toHaveLength(1);
    expect(register[0]).toMatchObject({
      billingNumber: raised.billingNumber,
      requestNumber: raised.requestNumber,
      dateNumber: 10,
      amount: '13.75',
      received: '0.00',
      status: 'OPEN',
      requestStatus: 'OPEN',
    });

    // The date is asked for once: a document that stood while its date stayed open would be asked for
    // again the next time the due list was read.
    await expect(requestDownPaymentFromPlanDate({
      client: tenant.client, changedBy: ACTOR, orderNumber, orderLineNumber: 10,
      dateNumber: 10, billingDate: FIRST, requestKey: key('ask-twice'),
    })).rejects.toThrow(/asked for once/);
  });

  it('refuses a date that invoices, a day that has not come, and an indicator that does not stand', async () => {
    const orderNumber = await place();
    await plan(orderNumber);

    // A date maintained to invoice is billed, not asked for.
    await expect(requestDownPaymentFromPlanDate({
      client: tenant.client, changedBy: ACTOR, orderNumber, orderLineNumber: 10,
      dateNumber: 20, billingDate: SECOND, requestKey: key('ask-invoice-date'),
    })).rejects.toThrow(/maintained to invoice/);
    // And the other way round: a date maintained to ask for an advance raises a request, not an
    // invoice. An advance asked for and then billed is the same money twice.
    await expect(createBillingFromPlanDate({
      client: tenant.client, changedBy: ACTOR, orderNumber, orderLineNumber: 10,
      dateNumber: 10, billingDate: FIRST, requestKey: key('bill-advance-date'),
    }, { authorization: await salesAuthority(tenant.client) })).rejects.toThrow(/raises a request and not an invoice/);

    // A plan is a promise about a day, and the day is the point of it.
    await expect(requestDownPaymentFromPlanDate({
      client: tenant.client, changedBy: ACTOR, orderNumber, orderLineNumber: 10,
      dateNumber: 30, billingDate: SECOND, requestKey: key('ask-later-date'),
    })).rejects.toThrow(/falls on 2026-12-01/);

    await expect(requestDownPaymentFromPlanDate({
      client: tenant.client, changedBy: ACTOR, orderNumber, orderLineNumber: 10,
      dateNumber: 10, billingDate: FIRST, indicator: 'Z', requestKey: key('ask-bad-indicator'),
    })).rejects.toThrow(/does not stand as a down-payment request indicator/);
  });

  it('clears the advance against the invoice that earned it, once, and not twice', async () => {
    const orderNumber = await place();
    await plan(orderNumber);

    const raised = await requestDownPaymentFromPlanDate({
      client: tenant.client, changedBy: ACTOR, orderNumber, orderLineNumber: 10,
      dateNumber: 10, billingDate: FIRST, requestKey: key('ask-settle'),
    });

    // The money arrives: accounting's own act, allocated to the request. Nothing else in the system
    // moves it, and it lands on the alternative reconciliation account the indicator names.
    await postCustomerDownPayment({
      client: tenant.client, changedBy: ACTOR,
      customerNumber: CUSTOMER, companyCode: '1000',
      documentDate: FIRST, postingDate: FIRST,
      bankGlAccount: '101000', amount: 13.75, currency: 'USD', specialGlIndicator: 'A',
      requestKey: key('receipt'),
      requestAllocations: [{ requestNumber: raised.requestNumber }],
    });
    const paid = await orderDownPayments(tenant.client, orderNumber);
    expect(paid[0]).toMatchObject({ received: '13.75', status: 'OPEN' });

    // The first invoice: half the item, 27.50, of which the customer has already paid 13.75.
    const first = await createBillingFromPlanDate({
      client: tenant.client, changedBy: ACTOR, orderNumber, orderLineNumber: 10,
      dateNumber: 20, billingDate: SECOND, requestKey: key('bill-first-half'),
    }, { authorization: await salesAuthority(tenant.client) });
    expect(first.posted).toBe(true);
    expect(Number(first.billing.grossValue)).toBeCloseTo(27.5, 2);
    expect(first.downPayment?.cleared).toBe('13.75');
    expect(first.downPayment?.clearingNumber).toBeTruthy();
    expect(first.downPayment?.error).toBeNull();
    // What the document says to the customer, and what the books say: billed, less the advance, is
    // what is still to pay.
    expect(Number(first.billing.downPaymentClearedAmount)).toBeCloseTo(13.75, 2);
    expect(Number(first.billing.grossValue) - Number(first.billing.downPaymentClearedAmount))
      .toBeCloseTo(13.75, 2);

    const afterFirst = await getCustomerDownPaymentClearing(tenant.client, CUSTOMER, '1000', 'A');
    const settled = afterFirst.invoices.find((row) => row.documentNumber === first.billing.journalDocumentNumber);
    expect(settled?.remaining).toBeCloseTo(13.75, 2);
    // The advance is spent: nothing of it stands to be cleared again.
    expect(afterFirst.downPayments.reduce((sum, row) => sum + row.remaining, 0)).toBeCloseTo(0, 2);

    // A request whose money has all been settled stands cleared, and the rest of the order is billed
    // on its own: the second invoice clears nothing, because nothing is left to clear.
    expect((await orderDownPayments(tenant.client, orderNumber))[0].status).toBe('CLEARED');
    const second = await createBillingFromPlanDate({
      client: tenant.client, changedBy: ACTOR, orderNumber, orderLineNumber: 10,
      dateNumber: 30, billingDate: THIRD, requestKey: key('bill-second-half'),
    }, { authorization: await salesAuthority(tenant.client) });
    expect(Number(second.billing.grossValue)).toBeCloseTo(27.5, 2);
    expect(second.downPayment).toBeUndefined();
    const afterSecond = await getCustomerDownPaymentClearing(tenant.client, CUSTOMER, '1000', 'A');
    const last = afterSecond.invoices.find((row) => row.documentNumber === second.billing.journalDocumentNumber);
    expect(last?.remaining).toBeCloseTo(27.5, 2);
  });

  it('withdraws an unpaid request, and refuses to withdraw one that money has arrived against', async () => {
    const orderNumber = await place();
    await plan(orderNumber);

    const raised = await requestDownPaymentFromPlanDate({
      client: tenant.client, changedBy: ACTOR, orderNumber, orderLineNumber: 10,
      dateNumber: 10, billingDate: FIRST, requestKey: key('ask-withdraw'),
    });
    const withdrawn = await cancelDownPaymentRequest({
      client: tenant.client, changedBy: ACTOR, billingNumber: raised.billingNumber,
      reason: 'The customer is paying on delivery instead.',
    });
    // The date is released, as a cancelled document releases the delivery it stands against: a
    // corrected request can be raised against it.
    expect(withdrawn.releasedDate).toBe(10);
    expect((await orderDownPayments(tenant.client, orderNumber))[0]).toMatchObject({
      status: 'CANCELLED', received: '0.00',
    });
    // The noted item stops answering: a request that stood would let a receipt be allocated to it for
    // years, and a customer no longer being asked must not be able to pay.
    const { getCustomerDownPaymentRequests } = await import(
      '../src/modules/finance/customer-down-payment-request'
    );
    const request = (await getCustomerDownPaymentRequests(tenant.client, CUSTOMER, '1000'))
      .find((row) => row.requestNumber === raised.requestNumber);
    expect(request?.status).toBe('REVERSED');
    await expect(cancelDownPaymentRequest({
      client: tenant.client, changedBy: ACTOR, billingNumber: raised.billingNumber,
    })).rejects.toThrow(/already stands withdrawn/);

    // Money that has arrived cannot be withdrawn away. It stands on the customer's special G/L
    // account and is settled the way an advance is settled — by clearing it against what is owed.
    const second = await place();
    await plan(second);
    const paid = await requestDownPaymentFromPlanDate({
      client: tenant.client, changedBy: ACTOR, orderNumber: second, orderLineNumber: 10,
      dateNumber: 10, billingDate: FIRST, requestKey: key('ask-then-paid'),
    });
    await postCustomerDownPayment({
      client: tenant.client, changedBy: ACTOR,
      customerNumber: CUSTOMER, companyCode: '1000',
      documentDate: FIRST, postingDate: FIRST,
      bankGlAccount: '101000', amount: 13.75, currency: 'USD', specialGlIndicator: 'A',
      requestKey: key('receipt-then-withdraw'),
      requestAllocations: [{ requestNumber: paid.requestNumber }],
    });
    await expect(cancelDownPaymentRequest({
      client: tenant.client, changedBy: ACTOR, billingNumber: paid.billingNumber,
    })).rejects.toThrow(/13\.75 .* of receipts standing against it/);
  });

  it('refuses to guess where the configuration names two request indicators', async () => {
    const orderNumber = await place();
    await plan(orderNumber);
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into special_gl_config (
        client, company_code, account_type, indicator,
        alternative_reconciliation_account, target_special_gl_indicator, description, created_by
      )
      values (${tenant.client}, '', 'AR', 'G', ${ALT_RECON}, 'A', 'Second advance requests', ${ACTOR})
      on conflict do nothing
    `));
    try {
      await expect(requestDownPaymentFromPlanDate({
        client: tenant.client, changedBy: ACTOR, orderNumber, orderLineNumber: 10,
        dateNumber: 10, billingDate: FIRST, requestKey: key('ask-ambiguous'),
      })).rejects.toThrow(/has to be named/);
    } finally {
      await withTenant(tenant.client, (tx) => tx.execute(sql`
        delete from special_gl_config
         where client = ${tenant.client} and account_type = 'AR' and indicator = 'G'
      `));
    }
  });

  it('leaves an item the plan only asks advances for to be billed by its deliveries', async () => {
    const orderNumber = await place();
    // A plan of advances alone: it says nothing about when the item is invoiced, so the item is billed
    // when its goods go out — and the advance is settled against that invoice.
    await saveBillingPlan({
      client: tenant.client, changedBy: ACTOR, orderNumber, orderLineNumber: 10,
      planType: 'MS', reason: 'Half in advance, the rest on delivery.',
      dates: [{ billingDate: FIRST, percentage: 50, billingRule: 'DOWN_PAYMENT' }],
    });
    const advanceOnly = await withTenant(tenant.client, (tx) => plansForItems(
      tx, tenant.client, [{ orderNumber, orderLineNumber: 10 }],
    ));
    expect(advanceOnly.get(`${orderNumber}|10`)).toMatchObject({
      hasInvoiceDates: false, nextDate: null,
    });

    const second = await place();
    await plan(second);
    const invoiced = await withTenant(tenant.client, (tx) => plansForItems(
      tx, tenant.client, [{ orderNumber: second, orderLineNumber: 10 }],
    ));
    // A plan carrying an invoice date answers when the item is billed, whether or not the day has
    // come: such an item is billed by its plan and never by a delivery.
    expect(invoiced.get(`${second}|10`)).toMatchObject({
      hasInvoiceDates: true, dateNumber: 20, nextDate: SECOND,
    });
  });

  it('asks for no more than the order carries, and no advance off a plan that stands settled', async () => {
    const orderNumber = await place();
    await expect(saveBillingPlan({
      client: tenant.client, changedBy: ACTOR, orderNumber, orderLineNumber: 10,
      planType: 'MS', reason: 'Asking for more than the whole.',
      dates: [
        { billingDate: FIRST, percentage: 60, billingRule: 'DOWN_PAYMENT' },
        { billingDate: SECOND, percentage: 50, billingRule: 'DOWN_PAYMENT' },
        { billingDate: THIRD, percentage: 100, billingRule: 'INVOICE' },
      ],
    })).rejects.toThrow(/no plan asks for more than the whole of it/);

    // The dates that invoice still share a hundred between them: an advance is money asked early, not
    // a share of the billing schedule.
    await expect(saveBillingPlan({
      client: tenant.client, changedBy: ACTOR, orderNumber, orderLineNumber: 10,
      planType: 'MS', reason: 'Ninety per cent invoiced.',
      dates: [
        { billingDate: FIRST, percentage: 25, billingRule: 'DOWN_PAYMENT' },
        { billingDate: SECOND, percentage: 90, billingRule: 'INVOICE' },
      ],
    })).rejects.toThrow(BillingPlanError);
  });
});
