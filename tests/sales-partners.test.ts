/**
 * DI-020 (§3.1) — who a sale is made with.
 *
 * A sale is made with one customer and answered by up to four: the sold-to that orders, the ship-to
 * that receives, the bill-to the invoice is addressed to, and the payer who owes the money. Before
 * this, one column on the order header was all four at once, and a receivable could only ever name
 * the company that placed the order.
 *
 * Three properties carry the step.
 *
 * Blank is a value: a row maintained for one sales area stands over the row maintained for all of
 * them, and the row naming no area is what answers for a customer nobody has refined.
 *
 * A function nobody maintains falls back to the one above it — the payer to the bill-to, and the
 * ship-to and the bill-to to the sold-to.
 *
 * A document carries the partners it was made with, so the money goes back to the customer that paid
 * it and not to the customer that happened to place the order.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveCustomerCredit } from '../src/modules/finance/credit';
import { saveSalesCondition } from '../src/modules/sales/conditions';
import {
  PartnerError, changeCustomerPartnerStatus, listCustomerPartners, saveCustomerPartner,
} from '../src/modules/sales/partners';
import { createSalesOrder, getSalesOrder } from '../src/modules/sales/sales-order';
import {
  confirmDeliveryPicks, createDelivery, getDelivery, listDeliverableOrderLines, postDeliveryGoodsIssue,
} from '../src/modules/sales/delivery';
import { getBilling, postBillingDocument } from '../src/modules/sales/billing';
import { createCreditMemo, postCreditMemo } from '../src/modules/sales/credit-memo';
import {
  assignSalesAreaDimensions, createTenant, defineTestRanges, destroyTenant, maintainMaterialSales,
  type TestTenant,
} from './helpers';
import { createSalesActor, refreshSalesActor, type SalesActor } from './helpers/sales-actor';

const ACTOR = 'SD9242_PARTNERS';
const AREA = 'CCA1';
const CUSTOMER = 'SD9242CUST1';
const SHIP_ANY = 'SD9242SHIP1';
const SHIP_AREA = 'SD9242SHIP2';
const BILL_TO = 'SD9242BILL1';
const PAYER = 'SD9242PAY1';
const NOT_A_CUSTOMER = 'SD9242VEND1';
const MATERIAL = 'SD9242MAT1';
const PLANT = '1000';
const STORE = '0001';
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
const key = (what: string) => `sd9242-${what}-${++counter}`;


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

describe('who a sale is made with', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTenant('sd9242-partners');
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
        values (${tenant.client}, '1000', 'E', 'Partner test sales organization', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into sales_area (client, sales_org, distribution_channel, division, name, created_by)
        values (${tenant.client}, '1000', '10', '01', 'Partner test sales area', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${tenant.client}, ${PLANT}, 'Partner test plant', '1000', 'KW', ${ACTOR}) on conflict do nothing
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
      // Credit: the chain refuses to deliver a blocked or unrecorded customer, and a fixture that
      // cannot deliver cannot bill. The record is the sold-to's, which is the customer the ladder is
      // read for today; the payer's exposure is a question this step deliberately leaves open.
      await tx.execute(sql`
        insert into credit_control_area (client, credit_control_area, name, currency, warning_threshold_percent, created_by)
        values (${tenant.client}, ${AREA}, 'Partner test credit area', 'USD', 90, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into credit_risk_category (client, risk_category, name, created_by)
        values (${tenant.client}, 'A', 'Low risk', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        update company_code set credit_control_area = ${AREA}
        where client = ${tenant.client} and company_code = '1000'
      `);

      // A customer is a business partner carrying the role, extended to the company code with a
      // reconciliation account. Every partner here is one, because any of them could be the payer —
      // and the one that is not a customer is the one the refusal is about.
      for (const [partner, name] of [
        [CUSTOMER, 'Partner test customer'],
        [SHIP_ANY, 'Any-area ship-to'],
        [SHIP_AREA, 'Sales-area ship-to'],
        [BILL_TO, 'Partner test bill-to'],
        [PAYER, 'Partner test payer'],
      ] as const) {
        await tx.execute(sql`
          insert into business_partner (client, partner_number, category, name, city, street, created_by)
          values (${tenant.client}, ${partner}, 'ORGANIZATION', ${name}, ${`City of ${partner}`},
                  ${`Street of ${partner}`}, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into bp_role (client, partner_number, role_code, created_by)
          values (${tenant.client}, ${partner}, 'CUSTOMER', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into customer_company_code (
            client, partner_number, role_code, company_code, chart_of_accounts,
            reconciliation_account, payment_terms_code, created_by
          ) values (${tenant.client}, ${partner}, 'CUSTOMER', '1000', 'CA01', '110000', 'NET30', ${ACTOR})
          on conflict do nothing
        `);
      }
      // The one that stands as a business partner but not as a customer: a vendor, which is what a
      // tenant reaches for by mistake when the ship-to has not been extended.
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${tenant.client}, ${NOT_A_CUSTOMER}, 'ORGANIZATION', 'Not a customer', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${tenant.client}, ${NOT_A_CUSTOMER}, 'SUPPLIER', ${ACTOR}) on conflict do nothing
      `);

      await tx.execute(sql`
        insert into customer_sales_area (
          client, partner_number, role_code, sales_org, distribution_channel, division,
          pricing_procedure, is_blocked, sales_status, created_by
        )
        values (${tenant.client}, ${CUSTOMER}, 'CUSTOMER', '1000', '10', '01', 'PR01', false, 'MAINTAINED', ${ACTOR})
        on conflict (client, partner_number, sales_org, distribution_channel, division)
        do update set is_blocked = false, sales_status = 'MAINTAINED'
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${tenant.client}, ${MATERIAL}, 'Partner test material', 'RAW', 'UNT', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        values (${tenant.client}, ${MATERIAL}, ${PLANT}, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency,
                                        total_stock_quantity, stock_value, created_by)
        values (${tenant.client}, ${MATERIAL}, ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1, 'USD',
                100, 1000, ${ACTOR})
        on conflict (client, material_number, valuation_area)
        do update set moving_average_price = excluded.moving_average_price
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        values (${tenant.client}, ${MATERIAL}, ${PLANT}, ${STORE}, 'UNRESTRICTED', 100, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
        values (${tenant.client}, 'OPENING_BALANCE', 'Opening balance', 'RECEIPT', 'MATERIAL_DOCUMENT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date,
                                       posting_date, header_text, status, created_by)
        values (${tenant.client}, 'MD-OPEN001', 2026, ${DATE}, ${DATE}, 'Opening balance', 'POSTED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (client, material_document_number, line_number, movement_type,
                                            material_number, plant, storage_location, stock_type, line_direction,
                                            entry_quantity, entry_unit, base_quantity, base_unit, created_by)
        values (${tenant.client}, 'MD-OPEN001', 1, 'OPENING_BALANCE', ${MATERIAL}, ${PLANT}, ${STORE},
                'UNRESTRICTED', 'RECEIPT', 100, 'UNT', 100, 'UNT', ${ACTOR})
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
      creditLimit: '1000000.00', riskCategory: 'A', isBlocked: false, changeReason: 'Partner test credit data.',
    });
    await maintainMaterialSales(tenant, { materialNumber: MATERIAL, deliveringPlant: PLANT });
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      customerNumber: '', materialNumber: MATERIAL, currency: 'USD', amount: 25, priceUnit: 1,
      validityFrom: '2026-01-01', validityTo: '2026-12-31',
    });
  });

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
  });

  /** An order, delivered and billed, at the price the record stands at. */
  async function chain(what: string, quantity: number) {
    const placed = await createSalesOrder({
      ...base, requestKey: key(`${what}-order`),
      lines: [{
        lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: quantity, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    }, { authorization: await salesAuthority(tenant.client) });
    const open = await listDeliverableOrderLines(tenant.client, { orderNumber: placed.orderNumber });
    const shipped = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: placed.orderNumber, deliveryDate: DATE,
      items: [{ orderLineNumber: open[0].lineNumber, quantity: String(quantity) }],
      requestKey: key(`${what}-delivery`),
    }, { authorization: await salesAuthority(tenant.client) });
    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: shipped.deliveryNumber,
      items: [{ lineNumber: 10, quantity: String(quantity), storageLocation: STORE }],
      requestKey: key(`${what}-pick`),
    });
    const standing = await getDelivery(tenant.client, shipped.deliveryNumber);
    await postDeliveryGoodsIssue({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: shipped.deliveryNumber,
      expectedVersion: standing!.version, postingDate: DATE,
    }, { authorization: await salesAuthority(tenant.client) });
    const billed = await postBillingDocument({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: shipped.deliveryNumber, billingDate: DATE,
      requestKey: key(`${what}-invoice`),
    }, { authorization: await salesAuthority(tenant.client) });
    return { placed, shipped, billed };
  }

  it('is all four at once until somebody says otherwise', async () => {
    // Nothing is maintained for this customer, so the sale is made with the customer on the header —
    // which is what every order in the books is, and what none of them may stop being.
    const placed = await createSalesOrder({
      ...base, requestKey: key('defaults-order'),
      lines: [{
        lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: 1, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    }, { authorization: await salesAuthority(tenant.client) });
    const order = await getSalesOrder(tenant.client, placed.orderNumber);
    expect(order!.partners).toEqual({
      soldTo: CUSTOMER, shipTo: CUSTOMER, billTo: CUSTOMER, payer: CUSTOMER,
    });
  });

  it('reads the row that names the sales area before the row that names none', async () => {
    // A ship-to for every sales area, and a ship-to for this one. Both stand; the one naming the area
    // answers, because the one naming none is what answers for the areas nobody refined.
    await saveCustomerPartner({
      client: tenant.client, changedBy: ACTOR, partnerNumber: CUSTOMER,
      functionCode: 'SH', assignedPartnerNumber: SHIP_ANY,
    });
    await saveCustomerPartner({
      client: tenant.client, changedBy: ACTOR, partnerNumber: CUSTOMER,
      salesOrg: '1000', distributionChannel: '10', division: '01',
      functionCode: 'SH', assignedPartnerNumber: SHIP_AREA,
    });
    const placed = await createSalesOrder({
      ...base, requestKey: key('specific-order'),
      lines: [{
        lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: 1, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    }, { authorization: await salesAuthority(tenant.client) });
    const order = await getSalesOrder(tenant.client, placed.orderNumber);
    expect(order!.partners.shipTo).toBe(SHIP_AREA);
    expect(order!.partners.soldTo).toBe(CUSTOMER);
    // Everything else still defaults: a ship-to is not a bill-to, and naming one does not name the other.
    expect(order!.partners.billTo).toBe(CUSTOMER);
    expect(order!.partners.payer).toBe(CUSTOMER);
  });

  it('falls back to the one above: the payer to the bill-to, the bill-to to the sold-to', async () => {
    await saveCustomerPartner({
      client: tenant.client, changedBy: ACTOR, partnerNumber: CUSTOMER,
      functionCode: 'BP', assignedPartnerNumber: BILL_TO,
    });
    const placed = await createSalesOrder({
      ...base, requestKey: key('fallback-order'),
      lines: [{
        lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: 1, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    }, { authorization: await salesAuthority(tenant.client) });
    const before = await getSalesOrder(tenant.client, placed.orderNumber);
    // No payer is maintained, so the invoice is settled by the customer it is addressed to — which is
    // the first place to look for the customer who pays.
    expect(before!.partners.billTo).toBe(BILL_TO);
    expect(before!.partners.payer).toBe(BILL_TO);

    await saveCustomerPartner({
      client: tenant.client, changedBy: ACTOR, partnerNumber: CUSTOMER,
      functionCode: 'PY', assignedPartnerNumber: PAYER,
    });
    const after = await createSalesOrder({
      ...base, requestKey: key('payer-order'),
      lines: [{
        lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: 1, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    }, { authorization: await salesAuthority(tenant.client) });
    const order = await getSalesOrder(tenant.client, after.orderNumber);
    expect(order!.partners.billTo).toBe(BILL_TO);
    expect(order!.partners.payer).toBe(PAYER);
  });

  it('carries them down the chain: the ship-to receives, the bill-to is addressed, the payer owes', async () => {
    const done = await chain('chain', 4);

    // The delivery is raised for the ship-to, and it is the ship-to's address the goods go to.
    const delivery = await getDelivery(tenant.client, done.shipped.deliveryNumber);
    expect(delivery!.partners.shipTo).toBe(SHIP_AREA);
    expect(delivery!.shipTo?.partnerNumber).toBe(SHIP_AREA);
    expect(delivery!.shipTo?.city).toBe(`City of ${SHIP_AREA}`);
    expect(delivery!.shipTo?.name).toBe('Sales-area ship-to');

    // The invoice names who it is addressed to and who owes it.
    const invoice = await getBilling(tenant.client, done.billed.billing.billingNumber);
    expect(invoice!.partners).toEqual({
      soldTo: CUSTOMER, shipTo: SHIP_AREA, billTo: BILL_TO, payer: PAYER,
    });

    // And the receivable is the payer's, not the sold-to's: the money is owed by the customer that
    // pays, and it is that customer's open item and that customer's ageing.
    const receivable = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select business_partner from journal_entry_line
       where client = ${tenant.client} and document_number = ${done.billed.invoice!.journalDocumentNumber}
         and debit_credit = 'S'
    `) as unknown as Promise<Array<{ business_partner: string }>>);
    expect(receivable.map((row) => row.business_partner)).toEqual([PAYER]);
    const open = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select customer_number from customer_invoice
       where client = ${tenant.client} and invoice_number = ${done.billed.invoice!.invoiceNumber}
    `) as unknown as Promise<Array<{ customer_number: string }>>);
    expect(open[0]?.customer_number).toBe(PAYER);
  });

  it('gives the money back to the payer, not to the customer that placed the order', async () => {
    const done = await chain('credit', 2);
    const raised = await createCreditMemo({
      client: tenant.client, changedBy: ACTOR, billingNumber: done.billed.billing.billingNumber,
      billingDate: DATE, requestKey: key('credit-memo'),
      items: [{ billingLineNumber: 10, quantity: 1 }],
    });
    const memo = await getBilling(tenant.client, raised.billingNumber);
    // The credit is made with the partners of the invoice it is giving back.
    expect(memo!.partners).toEqual({
      soldTo: CUSTOMER, shipTo: SHIP_AREA, billTo: BILL_TO, payer: PAYER,
    });
    const draft = await getBilling(tenant.client, raised.billingNumber);
    const posted = await postCreditMemo({
      client: tenant.client, changedBy: ACTOR, billingNumber: raised.billingNumber,
      expectedVersion: draft!.version, postingDate: DATE, requestKey: key('credit-posted'),
    });
    const credited = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select business_partner from journal_entry_line
       where client = ${tenant.client} and document_number = ${posted.journalDocumentNumber}
         and debit_credit = 'H'
    `) as unknown as Promise<Array<{ business_partner: string }>>);
    // Back to the payer: a receivable raised against a head office is settled by a head office, and
    // not left open on the subsidiary that happened to place the order.
    expect(credited.map((row) => row.business_partner)).toEqual([PAYER]);
  });

  it('withdraws a function rather than inventing an answer, and lets it be restored', async () => {
    const before = await createSalesOrder({
      ...base, requestKey: key('before-withdrawal'),
      lines: [{
        lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: 1, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    }, { authorization: await salesAuthority(tenant.client) });
    expect((await getSalesOrder(tenant.client, before.orderNumber))!.partners.shipTo).toBe(SHIP_AREA);

    await changeCustomerPartnerStatus({
      client: tenant.client, changedBy: ACTOR, partnerNumber: CUSTOMER,
      salesOrg: '1000', distributionChannel: '10', division: '01',
      functionCode: 'SH', isActive: false,
    });
    // The row naming the area no longer answers, so the row naming none does.
    const during = await createSalesOrder({
      ...base, requestKey: key('during-withdrawal'),
      lines: [{
        lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: 1, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    }, { authorization: await salesAuthority(tenant.client) });
    expect((await getSalesOrder(tenant.client, during.orderNumber))!.partners.shipTo).toBe(SHIP_ANY);
    // The withdrawn row still stands: it says who used to ship for this customer, which is what an
    // auditor reads when the answer was changed.
    const configuration = await listCustomerPartners(tenant.client, CUSTOMER);
    expect(configuration.rows.filter((row) => row.functionCode === 'SH')).toHaveLength(2);

    await changeCustomerPartnerStatus({
      client: tenant.client, changedBy: ACTOR, partnerNumber: CUSTOMER,
      salesOrg: '1000', distributionChannel: '10', division: '01',
      functionCode: 'SH', isActive: true,
    });
    const after = await createSalesOrder({
      ...base, requestKey: key('after-withdrawal'),
      lines: [{
        lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: 1, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    }, { authorization: await salesAuthority(tenant.client) });
    expect((await getSalesOrder(tenant.client, after.orderNumber))!.partners.shipTo).toBe(SHIP_AREA);
  });

  it('refuses a partner that cannot play the part, and refuses to assign the sold-to', async () => {
    await expect(saveCustomerPartner({
      client: tenant.client, changedBy: ACTOR, partnerNumber: CUSTOMER,
      functionCode: 'SP', assignedPartnerNumber: CUSTOMER,
    })).rejects.toThrow(PartnerError);

    await expect(saveCustomerPartner({
      client: tenant.client, changedBy: ACTOR, partnerNumber: CUSTOMER,
      functionCode: 'PY', assignedPartnerNumber: NOT_A_CUSTOMER,
    })).rejects.toThrow(/does not stand as a customer/);

    await expect(saveCustomerPartner({
      client: tenant.client, changedBy: ACTOR, partnerNumber: CUSTOMER,
      functionCode: 'ZZ', assignedPartnerNumber: PAYER,
    })).rejects.toThrow(/is not one this package determines/);

    // And the customer the master belongs to must be a customer too.
    await expect(saveCustomerPartner({
      client: tenant.client, changedBy: ACTOR, partnerNumber: NOT_A_CUSTOMER,
      functionCode: 'PY', assignedPartnerNumber: PAYER,
    })).rejects.toThrow(PartnerError);
  });
});
