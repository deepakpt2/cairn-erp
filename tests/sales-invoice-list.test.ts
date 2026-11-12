import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveCustomerCredit } from '../src/modules/finance/credit';
import { getCustomerInvoice } from '../src/modules/finance/customer-invoice';
import { billDueList, cancelBillingDocument, getBilling, postBillingDocument } from '../src/modules/sales/billing';
import {
  INVOICE_LIST_TYPE,
  cancelInvoiceList,
  createInvoiceList,
  getInvoiceList,
  invoiceListDueDocuments,
  listInvoiceLists,
  releaseInvoiceList,
} from '../src/modules/sales/invoice-list';
import { saveSalesCondition } from '../src/modules/sales/conditions';
import {
  confirmDeliveryPicks,
  createDelivery,
  getDelivery,
  listDeliverableOrderLines,
  postDeliveryGoodsIssue,
} from '../src/modules/sales/delivery';
import { createSalesOrder } from '../src/modules/sales/sales-order';
import {
  assignSalesAreaDimensions, createTenant, defineTestRanges, destroyTenant, maintainMaterialSales,
  type TestTenant,
} from './helpers';
import { createSalesActor, refreshSalesActor, type SalesActor } from './helpers/sales-actor';

/**
 * §4.6 — the customer's invoice: invoice lists (audit gap G2, second half).
 *
 * What stands here is the act the package never had: several billing documents that already stand
 * become one document to the customer, and the release of that one document is what raises the
 * receivable. Two tests carry the weight of it, and both are about money rather than about rows:
 *
 * **A document that is due for a list posts nothing.** It stands OPEN, billed and complete, and no
 * customer invoice was created for it. That is the only shape under which a list is not a second
 * receivable for money its members already owed, and it is the rule SAP keeps by not releasing a
 * document to accounting until its list is released.
 *
 * **The release posts one receivable, for the group.** One invoice, against the payer, worth the sum
 * of the documents on the list — and the members never got one of their own.
 *
 * Relevance is the other half, and it is proved by its absence before it is proved by its presence:
 * with no schedule on the payer, or no list type on the billing type, a document bills exactly as it
 * always did. Nothing that stands today changes.
 */
const ACTOR = 'SD9254_LIST';
const AREA = 'CCA1';
const CUSTOMER = 'SD9254CUST1';
const PAYER = 'SD9254PAYER';
const OTHER_CUSTOMER = 'SD9254CUST2';
const MATERIAL = 'SD9254MAT1';
const DATE = '2026-10-15';
const PLANT = '1000';
const STORE = '0001';

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
const key = (what: string) => `sd9254-${what}-${++counter}`;


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

async function seedPartners(client: string, partners: string[]) {
  await withTenant(client, async (tx) => {
    for (const partner of partners) {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${client}, ${partner}, 'ORGANIZATION', ${`Invoice list test ${partner}`}, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${client}, ${partner}, 'CUSTOMER', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into customer_sales_area (
          client, partner_number, role_code, sales_org, distribution_channel, division,
          pricing_procedure, is_blocked, sales_status, created_by
        )
        values (${client}, ${partner}, 'CUSTOMER', '1000', '10', '01', 'PR01', false, 'MAINTAINED', ${ACTOR})
        on conflict (client, partner_number, sales_org, distribution_channel, division)
        do update set sales_status = excluded.sales_status
      `);
      await tx.execute(sql`
        insert into customer_company_code (
          client, partner_number, role_code, company_code, chart_of_accounts,
          reconciliation_account, payment_terms_code, created_by
        )
        values (${client}, ${partner}, 'CUSTOMER', '1000', 'CA01', '110000', 'NET30', ${ACTOR})
        on conflict do nothing
      `);
    }
  });
}

/** The payer's schedule: the half of relevance that lives on the master. */
async function setSchedule(client: string, partner: string, schedule: string) {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      update customer_sales_area set invoice_list_schedule = ${schedule}
       where client = ${client} and partner_number = ${partner}
    `);
  });
}

/** The billing type's list type: SAP's OVV7, the other half. */
async function setBillingListType(client: string, listType: string | null) {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      update sales_document_type set invoice_list_type = ${listType}
       where client = ${client} and document_type = 'F2'
    `);
  });
}

/**
 * One order, one delivery, goods issued: the smallest thing that can earn an invoice. The payer is
 * written on the delivery after it stands, because the order's own partners are determined from the
 * sold-to and a fixture that wants a separate payer has no other way in.
 */
async function issuedDelivery(client: string, input: { customerNumber: string; quantity: number }) {
  const created = await createSalesOrder({
    ...base, customerNumber: input.customerNumber, requestKey: key('order'),
    lines: [{
      lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
      orderQuantity: input.quantity, quantityUnit: 'UNT', taxCode: 'T10',
    }],
  }, { authorization: await salesAuthority(base.client) });
  const open = await listDeliverableOrderLines(client, { orderNumber: created.orderNumber });
  const built = await createDelivery({
    client, changedBy: ACTOR, orderNumber: created.orderNumber, deliveryDate: DATE,
    goodsMovementDate: DATE, headerText: 'Invoice list fixture',
    items: [{ orderLineNumber: open[0].lineNumber, quantity: String(input.quantity) }],
    requestKey: key('delivery'),
  }, { authorization: await salesAuthority(base.client) });
  await confirmDeliveryPicks({
    client, changedBy: ACTOR, deliveryNumber: built.deliveryNumber,
    items: [{ lineNumber: 10, quantity: String(input.quantity), storageLocation: STORE }],
  });
  const picked = await getDelivery(client, built.deliveryNumber);
  await postDeliveryGoodsIssue({
    client, changedBy: ACTOR, deliveryNumber: built.deliveryNumber,
    expectedVersion: picked!.version, postingDate: DATE, documentDate: DATE,
  }, { authorization: await salesAuthority(base.client) });
  return { orderNumber: created.orderNumber, deliveryNumber: built.deliveryNumber };
}

describe('invoice lists — the customer\'s invoice (§4.6, gap G2)', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTenant('sd9254-invoice-list');
    base.client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(tenant.client, async (tx) => {
      for (const range of [
        { objectCode: 'SALESORD', subObject: 'OR', prefix: 'SO', numberLength: 7 },
        { objectCode: 'DELIVERY', subObject: 'LF', prefix: 'DL', numberLength: 7 },
        { objectCode: 'BILLING', subObject: 'F2', prefix: 'INV', numberLength: 7 },
        { objectCode: 'BILLING', subObject: 'S1', prefix: 'CN', numberLength: 7 },
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
        values (${tenant.client}, '1000', 'E', 'Test sales organization', ${ACTOR}) on conflict do nothing
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
        insert into credit_risk_category (client, risk_category, name, created_by)
        values (${tenant.client}, 'A', 'Low risk', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        update company_code set credit_control_area = ${AREA}
        where client = ${tenant.client} and company_code = '1000'
      `);
      await tx.execute(sql`
        insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
        values (${tenant.client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${tenant.client}, ${MATERIAL}, 'Invoice list test material', 'RAW', 'UNT', ${ACTOR}) on conflict do nothing
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
                500, 5000, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        values (${tenant.client}, ${MATERIAL}, ${PLANT}, ${STORE}, 'UNRESTRICTED', 500, ${ACTOR}) on conflict do nothing
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
                'UNRESTRICTED', 'RECEIPT', 500, 'UNT', 500, 'UNT', ${ACTOR})
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
    await maintainMaterialSales(tenant, { materialNumber: MATERIAL, deliveringPlant: PLANT });
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      customerNumber: '', materialNumber: MATERIAL, currency: 'USD', amount: 25, priceUnit: 1,
      validityFrom: '2026-01-01', validityTo: '2026-12-31', supersedeStanding: false,
    });
    await seedPartners(tenant.client, [CUSTOMER, PAYER, OTHER_CUSTOMER]);
    for (const partner of [CUSTOMER, PAYER, OTHER_CUSTOMER]) {
      await saveCustomerCredit({
        client: tenant.client, changedBy: ACTOR, customer: partner, creditControlArea: AREA,
        creditLimit: '1000000.00', riskCategory: 'A', isBlocked: false,
        changeReason: 'Invoice list fixture credit data.',
      });
    }
  });

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
  });

  // ── Relevance, proved first by its absence ─────────────────────────────────

  it('bills as it always did while the payer carries no schedule: no list, and the receivable stands', async () => {
    const { deliveryNumber } = await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 2 });
    // Nothing maintained: the billing type carries no list type and the payer carries no schedule.
    const [created] = (await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
      selection: { deliveryNumber },
    }, { authorization: await salesAuthority(base.client) })).documents;

    expect(created.billing.invoiceListStatus).toBe('NOT_RELEVANT');
    expect(created.awaitingInvoiceList).toBe(false);
    // Released to accounting on its own, the day it was billed — the behaviour every document raised
    // before this increment has, and keeps.
    expect(created.posted).toBe(true);
    expect(created.billing.customerInvoiceNumber).not.toBeNull();
    expect(await invoiceListDueDocuments(tenant.client)).toEqual([]);
  });

  it('needs both halves: a list type with no schedule, and a schedule with no list type, both bill alone', async () => {
    // The billing type is listed, the payer is not.
    await setBillingListType(tenant.client, INVOICE_LIST_TYPE);
    const onlyType = await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 3 });
    const [withType] = (await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
      selection: { deliveryNumber: onlyType.deliveryNumber },
    }, { authorization: await salesAuthority(base.client) })).documents;
    expect(withType.billing.invoiceListStatus).toBe('NOT_RELEVANT');
    expect(withType.posted).toBe(true);

    // And the other way round: the payer's schedule stands, the billing type is clear again.
    await setBillingListType(tenant.client, null);
    await setSchedule(tenant.client, CUSTOMER, 'MONTHLY');
    const onlySchedule = await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 4 });
    const [withSchedule] = (await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
      selection: { deliveryNumber: onlySchedule.deliveryNumber },
    }, { authorization: await salesAuthority(base.client) })).documents;
    expect(withSchedule.billing.invoiceListStatus).toBe('NOT_RELEVANT');
    expect(withSchedule.posted).toBe(true);

    await setSchedule(tenant.client, CUSTOMER, 'NONE');
  });

  // ── The one rule that makes a list worth having ───────────────────────────

  it('a document due for a list posts nothing at all, and stands waiting', async () => {
    await setBillingListType(tenant.client, INVOICE_LIST_TYPE);
    await setSchedule(tenant.client, CUSTOMER, 'MONTHLY');
    const { deliveryNumber } = await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 5 });

    const [created] = (await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
      selection: { deliveryNumber },
    }, { authorization: await salesAuthority(base.client) })).documents;

    // 5 units at 25 is 125, plus ten per cent — billed, complete, and worth exactly what it was
    // always worth. What it is not is released to accounting.
    expect(Number(created.billing.netValue)).toBe(125);
    expect(Number(created.billing.taxValue)).toBe(12.5);
    expect(created.billing.invoiceListStatus).toBe('DUE');
    expect(created.awaitingInvoiceList).toBe(true);
    expect(created.posted).toBe(false);
    expect(created.invoice).toBeNull();
    expect(created.billing.status).toBe('OPEN');
    expect(created.billing.customerInvoiceNumber).toBeNull();

    // The list date is the end of the month the billing date falls in: 2026-10-31 for a document
    // billed on 2026-10-15. This package keeps the period where SAP keeps a factory calendar.
    const read = await getBilling(tenant.client, created.billing.billingNumber);
    expect(read?.invoiceListNumber).toBeNull();
  });

  // ── Grouping the month — VF21 ─────────────────────────────────────────────

  it('groups the payer\'s documents onto one list, and the members stop being theirs to post', async () => {
    const first = await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 2 });
    const second = await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 3 });
    const billed = [];
    for (const { deliveryNumber } of [first, second]) {
      const [document] = (await billDueList({
        client: tenant.client, changedBy: ACTOR, billingDate: DATE,
        selection: { deliveryNumber },
      }, { authorization: await salesAuthority(base.client) })).documents;
      billed.push(document);
    }

    const due = await invoiceListDueDocuments(tenant.client, { payer: CUSTOMER });
    // Both of this test's documents are waiting; the ones earlier tests left waiting are waiting too,
    // which is why this says *contains* rather than *is* — the due list is a standing queue, not a
    // list of what one caller just raised.
    for (const document of billed) {
      expect(due.map((row) => row.billingNumber)).toContain(document.billing.billingNumber);
    }
    // Every member carries the same list date, because the period is the payer's and the documents
    // were billed inside it.
    expect(new Set(due.map((row) => row.invoiceListDate)).size).toBe(1);
    expect(due[0].invoiceListDate).toBe('2026-10-31');
    // The list type came from the billing type (OVV7), not from anything the caller said.
    expect(due[0].invoiceListType).toBe(INVOICE_LIST_TYPE);

    const { list, listed } = await createInvoiceList({
      client: tenant.client, changedBy: ACTOR, billingNumbers: billed.map((d) => d.billing.billingNumber),
    });
    expect(listed.sort()).toEqual(billed.map((d) => d.billing.billingNumber).sort());
    expect(list.items).toHaveLength(2);
    expect(list.header.documentType).toBe(INVOICE_LIST_TYPE);
    expect(list.header.status).toBe('OPEN');
    // The list is worth the sum of what its members are worth: 50 + 75 net, plus ten per cent.
    expect(list.header.netValue).toBe(125);
    expect(list.header.taxValue).toBe(12.5);
    expect(list.header.grossValue).toBe(137.5);
    // What each member contributes is written down on the list, so a list read years from states
    // what it sent the customer for from rows that have moved since.
    expect(list.items.map((item) => item.netValue).sort((a, b) => a - b)).toEqual([50, 75]);

    for (const document of billed) {
      const read = await getBilling(tenant.client, document.billing.billingNumber);
      expect(read?.invoiceListStatus).toBe('LISTED');
      expect(read?.invoiceListNumber).toBe(list.header.billingNumber);
      // Still nothing posted, and still theirs not to post.
      expect(read?.customerInvoiceNumber).toBeNull();
    }
    // And the two documents are out of the queue: what is still waiting is what other tests left
    // waiting, not what this list took.
    const stillDue = (await invoiceListDueDocuments(tenant.client)).map((row) => row.billingNumber);
    for (const document of billed) expect(stillDue).not.toContain(document.billing.billingNumber);
    return list;
  });

  it('refuses to list a document that is not relevant, one that is listed, or two groups at once', async () => {
    // Not relevant: the payer carries no schedule, so the document was released to accounting the
    // day it was billed. Which is the refusal from the other side — a document that is not waiting
    // for a list has already posted its own receivable, and cannot be made to post another.
    const plain = await issuedDelivery(tenant.client, { customerNumber: OTHER_CUSTOMER, quantity: 1 });
    const [own] = (await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
      selection: { deliveryNumber: plain.deliveryNumber },
    }, { authorization: await salesAuthority(base.client) })).documents;
    expect(own.billing.invoiceListStatus).toBe('NOT_RELEVANT');
    await expect(createInvoiceList({
      client: tenant.client, changedBy: ACTOR, billingNumbers: [own.billing.billingNumber],
    })).rejects.toThrow(/cannot be listed/i);

    // Listed once, and not twice: the second refusal is the one that protects the customer.
    const again = await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 1 });
    const [document] = (await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
      selection: { deliveryNumber: again.deliveryNumber },
    }, { authorization: await salesAuthority(base.client) })).documents;
    const { list } = await createInvoiceList({
      client: tenant.client, changedBy: ACTOR, billingNumbers: [document.billing.billingNumber],
    });
    await expect(createInvoiceList({
      client: tenant.client, changedBy: ACTOR, billingNumbers: [document.billing.billingNumber],
    })).rejects.toThrow(/already on invoice list/i);

    // One list is one payer. Documents for two payers are two lists, and saying so is kinder than
    // picking one of them.
    const other = await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 1 });
    const [otherDocument] = (await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
      selection: { deliveryNumber: other.deliveryNumber },
    }, { authorization: await salesAuthority(base.client) })).documents;
    await setSchedule(tenant.client, OTHER_CUSTOMER, 'MONTHLY');
    const thirdPayer = await issuedDelivery(tenant.client, { customerNumber: OTHER_CUSTOMER, quantity: 1 });
    const [thirdDocument] = (await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
      selection: { deliveryNumber: thirdPayer.deliveryNumber },
    }, { authorization: await salesAuthority(base.client) })).documents;
    await expect(createInvoiceList({
      client: tenant.client, changedBy: ACTOR,
      billingNumbers: [otherDocument.billing.billingNumber, thirdDocument.billing.billingNumber],
    })).rejects.toThrow(/fall into 2 groups/i);
    await setSchedule(tenant.client, OTHER_CUSTOMER, 'NONE');

    // And a list with nothing on it is not a list.
    await expect(createInvoiceList({
      client: tenant.client, changedBy: ACTOR, selection: { payer: 'NOBODY-HERE' },
    })).rejects.toThrow(/No billing document is waiting/i);
    expect(list.header.status).toBe('OPEN');
  });

  // ── Releasing the list — VF24 ─────────────────────────────────────────────

  it('releases one receivable for the whole group, and the members never get one of their own', async () => {
    const first = await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 4 });
    const second = await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 6 });
    const billed = [];
    for (const { deliveryNumber } of [first, second]) {
      const [document] = (await billDueList({
        client: tenant.client, changedBy: ACTOR, billingDate: DATE,
        selection: { deliveryNumber },
      }, { authorization: await salesAuthority(base.client) })).documents;
      billed.push(document);
    }
    const { list } = await createInvoiceList({
      client: tenant.client, changedBy: ACTOR, billingNumbers: billed.map((d) => d.billing.billingNumber),
    });

    const released = await releaseInvoiceList({
      client: tenant.client, changedBy: ACTOR, invoiceListNumber: list.header.billingNumber,
      expectedVersion: list.header.version,
    });
    expect(released.posted).toBe(true);
    expect(released.replayed).toBe(false);
    expect(released.invoice).not.toBeNull();
    // Posted on the day the period closed, not the day somebody pressed the button: the receivable
    // is dated the document it belongs to.
    expect(released.invoice!.postingDate).toBe('2026-10-31');

    // One invoice, for the group: 10 units at 25 is 250, plus ten per cent.
    const invoice = await getCustomerInvoice(tenant.client, released.invoice!.invoiceNumber);
    expect(invoice?.customerNumber).toBe(CUSTOMER);
    expect(Number(invoice?.taxAmount)).toBe(25);
    expect(Number(invoice?.grossAmount)).toBe(275);
    expect(Number(invoice?.grossAmount) - Number(invoice?.taxAmount)).toBe(250);
    expect(invoice?.lines).toHaveLength(2);
    expect(invoice?.lines.map((line) => Number(line.netAmount)).sort((a, b) => a - b)).toEqual([100, 150]);

    // The list stands released, and names the receivable behind it.
    const after = await getInvoiceList(tenant.client, list.header.billingNumber);
    expect(after?.header.status).toBe('POSTED');
    expect(after?.header.customerInvoiceNumber).toBe(released.invoice!.invoiceNumber);
    expect(after?.header.journalDocumentNumber).not.toBeNull();

    // And the members still carry no receivable: they never did, which is the whole point.
    for (const document of billed) {
      const read = await getBilling(tenant.client, document.billing.billingNumber);
      expect(read?.customerInvoiceNumber).toBeNull();
      expect(read?.status).toBe('OPEN');
      expect(read?.invoiceListStatus).toBe('LISTED');
    }

    // Releasing it again reads the same receivable back rather than raising a second one.
    const replayed = await releaseInvoiceList({
      client: tenant.client, changedBy: ACTOR, invoiceListNumber: list.header.billingNumber,
      postingDate: DATE,
    });
    expect(replayed.replayed).toBe(true);
    expect(replayed.invoice).toBeNull();
  });

  it('stands the list in the register, and refuses to release it on a view that has moved', async () => {
    const rows = await listInvoiceLists(tenant.client);
    const posted = rows.filter((row) => row.status === 'POSTED');
    expect(posted.length).toBeGreaterThan(0);
    // The register says how many documents stand on each list, which is what a clerk checks before
    // releasing the month.
    expect(posted.every((row) => row.itemCount > 0)).toBe(true);
    expect(rows.every((row) => row.payer.length > 0)).toBe(true);

    // A stale version is refused: two people with the same list open is not a race to win.
    const open = rows.find((row) => row.status === 'OPEN');
    if (open) {
      await expect(releaseInvoiceList({
        client: tenant.client, changedBy: ACTOR, invoiceListNumber: open.billingNumber,
        postingDate: DATE, expectedVersion: 99,
      })).rejects.toThrow(/changed while it was being released/i);
    }
  });

  // ── Cancelling a list returns its members to due ──────────────────────────

  it('cancelling a list gives the documents back, to be listed again or released alone', async () => {
    const { deliveryNumber } = await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 7 });
    const [document] = (await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
      selection: { deliveryNumber },
    }, { authorization: await salesAuthority(base.client) })).documents;
    const { list } = await createInvoiceList({
      client: tenant.client, changedBy: ACTOR, billingNumbers: [document.billing.billingNumber],
    });

    const cancelled = await cancelInvoiceList({
      client: tenant.client, changedBy: ACTOR, invoiceListNumber: list.header.billingNumber,
      reason: 'Wrong period', expectedVersion: list.header.version,
    });
    expect(cancelled.header.status).toBe('CANCELLED');
    expect(cancelled.items).toHaveLength(0);

    // The member is due again, and nothing was posted either way.
    const read = await getBilling(tenant.client, document.billing.billingNumber);
    expect(read?.invoiceListStatus).toBe('DUE');
    expect(read?.invoiceListNumber).toBeNull();
    expect(read?.customerInvoiceNumber).toBeNull();
    expect((await invoiceListDueDocuments(tenant.client, { payer: CUSTOMER }))
      .map((row) => row.billingNumber)).toContain(document.billing.billingNumber);

    // A cancelled list is not released, and is not cancelled twice.
    await expect(releaseInvoiceList({
      client: tenant.client, changedBy: ACTOR, invoiceListNumber: list.header.billingNumber,
    })).rejects.toThrow(/has been cancelled/i);
    await expect(cancelInvoiceList({
      client: tenant.client, changedBy: ACTOR, invoiceListNumber: list.header.billingNumber,
      reason: 'Again',
    })).rejects.toThrow(/already been cancelled/i);
  });

  it('a released list is a receivable, and a receivable is not undone here', async () => {
    const { deliveryNumber } = await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 8 });
    const [document] = (await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
      selection: { deliveryNumber },
    }, { authorization: await salesAuthority(base.client) })).documents;
    const { list } = await createInvoiceList({
      client: tenant.client, changedBy: ACTOR, billingNumbers: [document.billing.billingNumber],
    });
    await releaseInvoiceList({
      client: tenant.client, changedBy: ACTOR, invoiceListNumber: list.header.billingNumber,
    });
    await expect(cancelInvoiceList({
      client: tenant.client, changedBy: ACTOR, invoiceListNumber: list.header.billingNumber,
      reason: 'Too late',
    })).rejects.toThrow(/released to accounting/i);
  });

  // ── Relevance is a fact of the day the document was billed ────────────────

  it('does not revise a document that was listed, whatever the master says afterwards', async () => {
    const { deliveryNumber } = await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 9 });
    const [document] = (await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
      selection: { deliveryNumber },
    }, { authorization: await salesAuthority(base.client) })).documents;
    expect(document.billing.invoiceListStatus).toBe('DUE');

    // The payer asks to be billed on their own again. The document that is already waiting does not
    // change: SAP stamps FKART_RL and FKDAT_RL at creation and will not change them online, and for
    // the same reason — a document that was listed does not stop being listed.
    await setSchedule(tenant.client, CUSTOMER, 'NONE');
    await setBillingListType(tenant.client, null);
    const read = await getBilling(tenant.client, document.billing.billingNumber);
    expect(read?.invoiceListStatus).toBe('DUE');
    expect(read?.customerInvoiceNumber).toBeNull();
  });
  // ── A listed document is settled with its list, not underneath it ─────────

  it('a document waiting for a list posts nothing, whoever asks', async () => {
    // The rule a list rests on, from the other door. `billDueList` already answers this way on the day
    // the document is raised; this is the same document being asked again, later, through the call a
    // screen makes for one delivery. A document that is DUE is not a document that failed to post —
    // it is one that has deliberately not posted yet.
    await setSchedule(tenant.client, CUSTOMER, 'MONTHLY');
    await setBillingListType(tenant.client, INVOICE_LIST_TYPE);

    const { deliveryNumber } = await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 4 });
    const [document] = (await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
      selection: { deliveryNumber },
    }, { authorization: await salesAuthority(base.client) })).documents;
    expect(document.billing.invoiceListStatus).toBe('DUE');

    const asked = await postBillingDocument({
      client: tenant.client, changedBy: ACTOR, deliveryNumber, billingDate: DATE,
    }, { authorization: await salesAuthority(tenant.client) });
    expect(asked.posted).toBe(false);
    expect(asked.awaitingInvoiceList).toBe(true);
    // Still no receivable of its own. That is the whole property.
    const read = await getBilling(tenant.client, document.billing.billingNumber);
    expect(read?.customerInvoiceNumber).toBeNull();
    expect(read?.status).toBe('OPEN');
  });

  it('a listed document refuses to be released or cancelled on its own', async () => {
    await setSchedule(tenant.client, CUSTOMER, 'MONTHLY');
    await setBillingListType(tenant.client, INVOICE_LIST_TYPE);

    const { deliveryNumber } = await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 5 });
    const [document] = (await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
      selection: { deliveryNumber },
    }, { authorization: await salesAuthority(base.client) })).documents;
    const { list } = await createInvoiceList({
      client: tenant.client, changedBy: ACTOR, billingNumbers: [document.billing.billingNumber],
    });
    const number = document.billing.billingNumber;
    expect((await getBilling(tenant.client, number))?.invoiceListStatus).toBe('LISTED');

    // Neither door is open. The list is the document the customer was sent, and this document's value
    // is one of its items: release it here and the customer owes the money twice, cancel it here and
    // the list asks for money its own rows no longer add up to.
    await expect(postBillingDocument({
      client: tenant.client, changedBy: ACTOR, deliveryNumber, billingDate: DATE,
    }, { authorization: await salesAuthority(tenant.client) })).rejects.toThrow(/stands on invoice list/i);
    await expect(cancelBillingDocument({
      client: tenant.client, changedBy: ACTOR, billingNumber: number, postingDate: DATE,
    })).rejects.toThrow(/stands on invoice list/i);

    // And the refusal changed nothing: the document stands exactly as it did.
    const after = await getBilling(tenant.client, number);
    expect(after?.invoiceListStatus).toBe('LISTED');
    expect(after?.invoiceListNumber).toBe(list.header.billingNumber);
    expect(after?.customerInvoiceNumber).toBeNull();
    expect(after?.status).toBe('OPEN');

    // Cancelling the list gives it back, and then both doors open again — the guard is about the list,
    // not about the document for ever after.
    await cancelInvoiceList({
      client: tenant.client, changedBy: ACTOR, invoiceListNumber: list.header.billingNumber,
      reason: 'Guard',
    });
    const freed = await getBilling(tenant.client, number);
    expect(freed?.invoiceListStatus).toBe('DUE');
    await expect(cancelBillingDocument({
      client: tenant.client, changedBy: ACTOR, billingNumber: number, postingDate: DATE,
    })).resolves.toBeTruthy();
  });
});
