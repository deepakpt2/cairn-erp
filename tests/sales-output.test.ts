/**
 * 9252 — the document the customer receives: output.
 *
 * Everything else in Sales is a document the company keeps. This is the one it hands over, and until
 * this increment the package could show an invoice on a screen and send it nowhere, which is the gap
 * the audit names as C7.
 *
 * The rules this file holds to are the ones that make it a decision rather than a decoration:
 *
 * **No condition record, no output.** A document nobody configured an output for earns none, rather
 * than a plausible one nobody asked for. That is the first thing proved here, and it is proved with a
 * document that has been billed and sent nothing.
 *
 * **The access sequence is read most specific first.** A record naming the customer stands over one
 * naming only the sales area that customer is sold to — so one customer is e-mailed and another is
 * printed from the same two records.
 *
 * **Determination happens where the document is born**, inside the transaction that wrote it, so a
 * document never stands with its output missing because the process died between two writes. And the
 * run fills what stands missing, which is how a document that stood before any record did acquires
 * its output at all.
 *
 * **What was sent is kept.** The rendering stands on the message, so a copy read later is the document
 * the customer received and not a fresh reading of masters that have moved since.
 *
 * **An output is issued once.** A second dispatch is refused; issuing again writes a new message beside
 * the first, with the reason it was raised, and the first stands exactly as it was sent.
 *
 * **An e-mail with nobody to send it to fails for real**, and records why.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveCustomerCredit } from '../src/modules/finance/credit';
import { outputMessage } from '../src/modules/foundation/output-schema';
import { saveSalesCondition } from '../src/modules/sales/conditions';
import { createSalesOrder } from '../src/modules/sales/sales-order';
import {
  confirmDeliveryPicks, createDelivery, getDelivery, postDeliveryGoodsIssue,
} from '../src/modules/sales/delivery';
import { createBillingFromPlanDate } from '../src/modules/sales/billing';
import { saveBillingPlan } from '../src/modules/sales/billing-plan';
import {
  determineSalesOutputsForSelection,
  dispatchPendingSalesOutput,
  dispatchSalesOutput,
  listOutputConditionRecords,
  listSalesOutput,
  reissueSalesOutput,
  saveOutputConditionRecord,
  setSalesOutputRecipient,
  type SaveOutputConditionInput,
} from '../src/modules/sales/output';
import {
  assignSalesAreaDimensions,
  createTenant,
  defineTestRanges,
  destroyTenant,
  maintainMaterialSales,
  seedAccounts,
  type TestTenant,
} from './helpers';
import { listInbox } from '../src/platform/notification/notify';
import { registerJob } from '../src/platform/job/registry';
import { ensureDefinition } from '../src/platform/job/queue';
import { runClaimed } from '../src/platform/job/execute';
import { fanoutJob, FANOUT_JOB } from '../src/platform/notification/jobs/fanout';

const ACTOR = 'SD9252_OUTPUT';
const AREA = 'CCA1';
const CUSTOMER = 'SD9252CUST1';
/** The second customer: the one no record names, and so the one the sales-area record answers for. */
const OTHER_CUSTOMER = 'SD9252CUST2';
const MATERIAL = 'SD9252MAT1';
const PLANT = '1000';
const STORE = '0001';
const ORDER_DATE = '2026-10-15';
const BILLING_DATE = '2026-11-01';
const RECON = '110000';
/** Whoever runs the fan-out in these tests: the worker, rather than the request path. */
const WORKER = 'test-worker';

// The fan-out is a real job, so it has to be registered for `runClaimed` to find it.
registerJob(fanoutJob);

let counter = 0;
const key = (label: string) => `sd9252-${label}-${++counter}`;

const base = {
  client: '',
  changedBy: ACTOR,
  salesOrg: '1000',
  distributionChannel: '10',
  division: '01',
  customerNumber: CUSTOMER,
  companyCode: '1000',
  currency: 'USD',
  orderDate: ORDER_DATE,
};

describe('the document the customer receives: output (9252)', () => {
  let tenant: TestTenant;
  /** The invoice whose output failed. Set by the test that fails it and read by the one after it. */
  let quietBilling = '';

  beforeAll(async () => {
    tenant = await createTenant('sd9252-output');
    base.client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(tenant.client, async (tx) => {
      for (const range of [
        { objectCode: 'SALESORD', subObject: 'OR', prefix: 'SO', numberLength: 7 },
        { objectCode: 'DELIVERY', subObject: 'LF', prefix: 'DL', numberLength: 7 },
        { objectCode: 'BILLING', subObject: 'F2', prefix: 'INV', numberLength: 7 },
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
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${tenant.client}, ${MATERIAL}, 'Output test material', 'RAW', 'UNT', ${ACTOR}) on conflict do nothing
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
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        values (${tenant.client}, ${MATERIAL}, ${PLANT}, ${STORE}, 'UNRESTRICTED', 100, ${ACTOR}) on conflict do nothing
      `);
      // The opening stock is backed by an opening document: a projection row with no material document
      // behind it is a ghost, and reconciliation treats it as drift — which is what it is.
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
        values (${tenant.client}, 'OPENING_BALANCE', 'Opening balance', 'RECEIPT', 'MATERIAL_DOCUMENT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date,
                                       posting_date, header_text, status, created_by)
        values (${tenant.client}, 'MD-OPEN001', 2026, ${ORDER_DATE}, ${ORDER_DATE}, 'Opening balance', 'POSTED', ${ACTOR})
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
      // Two customers. The first is named by a record of its own and carries an e-mail address; the
      // second is named by none and carries none, which is what makes the access sequence visible.
      for (const [partner, email] of [[CUSTOMER, 'accounts@customer.example'], [OTHER_CUSTOMER, null]] as const) {
        await tx.execute(sql`
          insert into business_partner (client, partner_number, category, name, email, created_by)
          values (${tenant.client}, ${partner}, 'ORGANIZATION', ${`Test customer ${partner}`}, ${email}, ${ACTOR})
          on conflict (client, partner_number) do update set email = excluded.email
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
          values (${tenant.client}, ${partner}, 'CUSTOMER', '1000', '10', '01', 'PR01', false, 'MAINTAINED', ${ACTOR})
          on conflict (client, partner_number, sales_org, distribution_channel, division)
          do update set sales_status = excluded.sales_status
        `);
        await tx.execute(sql`
          insert into customer_company_code (
            client, partner_number, role_code, company_code, chart_of_accounts,
            reconciliation_account, payment_terms_code, created_by
          )
          values (${tenant.client}, ${partner}, 'CUSTOMER', '1000', 'CA01', ${RECON}, 'NET30', ${ACTOR})
          on conflict do nothing
        `);
      }
    });
    // The accounts the goods issue posts to, and the determination that names them. A delivery that
    // posts a movement posts a journal, and a journal names accounts that have to stand.
    await seedAccounts(tenant, ['120000', '510300']);
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        select ${tenant.client}, c.chart_of_accounts, v.e, v.vc, '', v.a, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${tenant.client} limit 1) c
        cross join (values
          ('INVENTORY', 'RAW_INVENTORY', '120000'),
          ('SALES_ISSUE', 'RAW_INVENTORY', '510300')
        ) as v(e, vc, a)
        on conflict do nothing
      `);
    });
    await maintainMaterialSales(tenant, { materialNumber: MATERIAL, deliveringPlant: PLANT });
    for (const partner of [CUSTOMER, OTHER_CUSTOMER]) {
      await saveCustomerCredit({
        client: tenant.client, changedBy: ACTOR, customer: partner, creditControlArea: AREA,
        creditLimit: '1000000.00', riskCategory: 'A', isBlocked: false,
        changeReason: 'Output test fixture.',
      });
    }
    // Twenty-five a unit: two units are fifty net, five tax, fifty-five gross — the figures the invoice
    // the customer receives has to carry.
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      conditionType: 'PR00', customerNumber: '', materialNumber: MATERIAL, currency: 'USD',
      amount: 25, priceUnit: 1, validityFrom: '2026-01-01', validityTo: '2026-12-31',
      supersedeStanding: false,
    });
  }, 180_000);

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
  });

  /** An order of two units, invoiced in full on one plan date. */
  async function place(customerNumber: string = CUSTOMER) {
    const placed = await createSalesOrder({
      ...base, customerNumber, requestKey: key('order'),
      lines: [{
        lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: 2, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    });
    await saveBillingPlan({
      client: tenant.client, changedBy: ACTOR, orderNumber: placed.orderNumber, orderLineNumber: 10,
      planType: 'MS', reason: 'Invoiced in full.',
      dates: [{ billingDate: BILLING_DATE, percentage: 100, billingRule: 'INVOICE' }],
    });
    return placed.orderNumber;
  }

  async function bill(orderNumber: string) {
    const billed = await createBillingFromPlanDate({
      client: tenant.client, changedBy: ACTOR, orderNumber, orderLineNumber: 10,
      dateNumber: 10, billingDate: BILLING_DATE, requestKey: key('bill'),
    });
    expect(billed.billing.status).toBe('POSTED');
    return billed.billing.billingNumber;
  }

  /** Every message that stands for one document, oldest issue first. */
  async function messages(category: string, documentNumber: string) {
    return withTenant(tenant.client, (tx) => tx.select().from(outputMessage).where(and(
      eq(outputMessage.client, tenant.client),
      eq(outputMessage.documentCategory, category),
      eq(outputMessage.documentNumber, documentNumber),
    )).orderBy(outputMessage.outputType, outputMessage.issueNumber));
  }

  /** Maintain an output condition record, and report the access it landed at. */
  async function record(overrides: Omit<SaveOutputConditionInput, 'client' | 'changedBy'>) {
    return saveOutputConditionRecord({ client: tenant.client, changedBy: ACTOR, ...overrides });
  }

  it('sends nothing where no record stands, because no record means no output', async () => {
    const orderNumber = await place();
    const billingNumber = await bill(orderNumber);

    // Billed, posted, and carrying an invoice — and sent nothing. The package delivers the output
    // types and no records: who receives what is a tenant's decision, not the package's.
    expect(await messages('BILLING', billingNumber)).toHaveLength(0);
    expect(await messages('SALES_ORDER', orderNumber)).toHaveLength(0);

    // The run determines nothing either, because there is nothing to determine.
    const run = await determineSalesOutputsForSelection({
      client: tenant.client, changedBy: ACTOR, selection: { documentCategory: 'BILLING' },
    });
    expect(run.created).toBe(0);
    expect(await messages('BILLING', billingNumber)).toHaveLength(0);
  });

  it('reads the access sequence most specific first: one customer is emailed, another is printed', async () => {
    // Access 3 — the sales area: every invoice in it is printed.
    const area = await record({
      outputType: 'RD00', documentCategory: 'BILLING',
      salesOrg: '1000', distributionChannel: '10', division: '01',
      transmissionMedium: 'PRINT', dispatchTime: 'IMMEDIATE', partnerFunction: 'BP',
      validityFrom: '2026-01-01', validityTo: '2026-12-31',
    });
    expect(area.access).toBe(3);
    // Access 1 — the sales area, the document type and this customer: its invoices are emailed to the
    // bill-to, and a specific record stands over a general one.
    const customer = await record({
      outputType: 'RD00', documentCategory: 'BILLING', documentType: 'F2',
      salesOrg: '1000', distributionChannel: '10', division: '01', customerNumber: CUSTOMER,
      transmissionMedium: 'EMAIL', dispatchTime: 'IMMEDIATE', partnerFunction: 'BP',
      validityFrom: '2026-01-01', validityTo: '2026-12-31',
    });
    expect(customer.access).toBe(1);

    const named = await bill(await place(CUSTOMER));
    const other = await bill(await place(OTHER_CUSTOMER));

    const forNamed = await messages('BILLING', named);
    expect(forNamed).toHaveLength(1);
    expect(forNamed[0]).toMatchObject({
      outputType: 'RD00', transmissionMedium: 'EMAIL', status: 'PROCESSED',
      recipient: 'accounts@customer.example', sendCount: 1,
    });

    const forOther = await messages('BILLING', other);
    expect(forOther).toHaveLength(1);
    expect(forOther[0]).toMatchObject({
      outputType: 'RD00', transmissionMedium: 'PRINT', status: 'PROCESSED', recipient: null,
    });
  });

  it('keeps what was sent with the message, so a copy read later is the document that went out', async () => {
    const billingNumber = await bill(await place(CUSTOMER));
    const [message] = await messages('BILLING', billingNumber);
    expect(message.renderedDocument).toBeTruthy();

    const document = message.renderedDocument ?? '';
    // The invoice the customer receives carries the number it is asked to pay against, the customer it
    // is addressed to, and the money — read from the document as it stands, and stored beside it.
    expect(document).toContain('INVOICE');
    expect(document).toContain(billingNumber);
    expect(document).toContain(CUSTOMER);
    expect(document).toContain('55.00');
    expect(document).toContain('50.00');
    expect(document).toContain(MATERIAL);
    expect(document).toContain('USD');
  });

  it('fails an email that has nobody to send it to, and succeeds once a recipient stands', async () => {
    // A record for a customer whose master carries no e-mail address: the partner the record names has
    // nothing to send it to, and that is a recorded failure rather than a quiet success.
    await record({
      outputType: 'RD00', documentCategory: 'BILLING', documentType: 'F2',
      salesOrg: '1000', distributionChannel: '10', division: '01', customerNumber: OTHER_CUSTOMER,
      transmissionMedium: 'EMAIL', dispatchTime: 'IMMEDIATE', partnerFunction: 'BP',
      validityFrom: '2026-01-01', validityTo: '2026-12-31',
    });

    const billingNumber = await bill(await place(OTHER_CUSTOMER));
    const [failed] = await messages('BILLING', billingNumber);
    expect(failed).toMatchObject({ transmissionMedium: 'EMAIL', status: 'ERROR', recipient: null });
    expect(failed.errorText).toMatch(/needs a recipient/);
    // Nothing was rendered, because nothing was sent.
    expect(failed.renderedDocument).toBeNull();

    // Give the partner an address and dispatch again: it succeeds, and the rendering stands where it
    // was refused before.
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update business_partner set email = 'later@customer.example'
       where client = ${tenant.client} and partner_number = ${OTHER_CUSTOMER}
    `));
    await setSalesOutputRecipient({
      client: tenant.client, changedBy: ACTOR, documentCategory: 'BILLING',
      documentNumber: billingNumber, outputType: 'RD00', transmissionMedium: 'EMAIL',
      recipient: 'later@customer.example',
    });
    const done = await dispatchSalesOutput({
      client: tenant.client, changedBy: ACTOR, documentCategory: 'BILLING',
      documentNumber: billingNumber, outputType: 'RD00', transmissionMedium: 'EMAIL',
    });
    expect(done).toMatchObject({ status: 'PROCESSED', sendCount: 1, recipient: 'later@customer.example' });

    const [repaired] = await messages('BILLING', billingNumber);
    expect(repaired).toMatchObject({ status: 'PROCESSED', sendCount: 1 });
    expect(repaired.errorText).toBeNull();
    expect(repaired.renderedDocument).toContain(billingNumber);
  });

  it('issues an output once: a second dispatch is refused, and a re-issue stands beside the first', async () => {
    const billingNumber = await bill(await place(CUSTOMER));
    const [first] = await messages('BILLING', billingNumber);
    expect(first.status).toBe('PROCESSED');

    // A repeat is not a rewrite of the first: it is a new output, and the service says so.
    await expect(dispatchSalesOutput({
      client: tenant.client, changedBy: ACTOR, documentCategory: 'BILLING',
      documentNumber: billingNumber, outputType: 'RD00', transmissionMedium: 'EMAIL',
    })).rejects.toThrow(/already processed/);

    const reissue = await reissueSalesOutput({
      client: tenant.client, changedBy: ACTOR, documentCategory: 'BILLING',
      documentNumber: billingNumber, outputType: 'RD00', transmissionMedium: 'EMAIL',
      reason: 'The customer said the first copy never arrived.',
    });
    expect(reissue.issueNumber).toBe(2);
    expect(reissue.message).toMatchObject({ status: 'PROCESSED', issueNumber: 2 });

    const both = await messages('BILLING', billingNumber);
    expect(both).toHaveLength(2);
    expect(both[0]).toMatchObject({ issueNumber: 1, status: 'PROCESSED', sendCount: 1, reissueReason: null });
    expect(both[1]).toMatchObject({ issueNumber: 2, status: 'PROCESSED', sendCount: 1 });
    expect(both[1].reissueReason).toBe('The customer said the first copy never arrived.');
    // Both stand as they were sent, which is what makes “we sent it twice, here is both” answerable.
    expect(both[0].renderedDocument).toContain(billingNumber);
    expect(both[1].renderedDocument).toContain(billingNumber);
  });

  it('determines the confirmation with the order it belongs to, and the note with the goods', async () => {
    await record({
      outputType: 'BA00', documentCategory: 'SALES_ORDER',
      salesOrg: '1000', distributionChannel: '10', division: '01',
      transmissionMedium: 'PRINT', dispatchTime: 'IMMEDIATE', partnerFunction: 'SP',
      validityFrom: '2026-01-01', validityTo: '2026-12-31',
    });
    await record({
      outputType: 'LD00', documentCategory: 'DELIVERY',
      salesOrg: '1000', distributionChannel: '10', division: '01',
      transmissionMedium: 'PRINT', dispatchTime: 'IMMEDIATE', partnerFunction: 'SH',
      validityFrom: '2026-01-01', validityTo: '2026-12-31',
    });

    // A document posted before any record stood earns nothing, which is what the first test proved; the
    // run is how history acquires its outputs at all.
    const run = await determineSalesOutputsForSelection({
      client: tenant.client, changedBy: ACTOR, selection: { documentCategory: 'SALES_ORDER' },
    });
    expect(run.examined).toBeGreaterThan(0);
    expect(run.created).toBeGreaterThan(0);
    // Determination writes the confirmations; the run's second half sends them.
    const sent = await dispatchPendingSalesOutput({
      client: tenant.client, changedBy: ACTOR, selection: { documentCategory: 'SALES_ORDER' },
    });
    expect(sent.dispatched).toBe(run.created);

    const orders = await listSalesOutput({
      client: tenant.client,
      selection: { documentCategory: 'SALES_ORDER', outputType: 'BA00' },
    });
    expect(orders.rows.length).toBeGreaterThan(0);
    const confirmation = orders.rows[0];
    expect(confirmation).toMatchObject({ outputType: 'BA00', status: 'PROCESSED', transmissionMedium: 'PRINT' });
    expect(confirmation.renderedDocument).toContain('ORDER CONFIRMATION');
    expect(confirmation.renderedDocument).toContain(confirmation.documentNumber);

    // The goods go out, and the note that travels with them is determined inside the posting.
    const orderNumber = await place(CUSTOMER);
    const delivery = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber, deliveryDate: ORDER_DATE,
      items: [{ orderLineNumber: 10, quantity: '2' }], requestKey: key('delivery'),
    });
    const [message] = await messages('SALES_ORDER', orderNumber);
    expect(message).toMatchObject({ outputType: 'BA00', status: 'PROCESSED' });

    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: delivery.deliveryNumber,
      items: [{ lineNumber: 10, quantity: '2', storageLocation: STORE }], requestKey: key('pick'),
    });
    const picked = await getDelivery(tenant.client, delivery.deliveryNumber);
    const issued = await postDeliveryGoodsIssue({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: delivery.deliveryNumber,
      expectedVersion: picked!.version, postingDate: ORDER_DATE,
    });
    expect(issued.delivery.status).toBe('GOODS_ISSUED');

    const notes = await messages('DELIVERY', delivery.deliveryNumber);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ outputType: 'LD00', status: 'PROCESSED', transmissionMedium: 'PRINT' });
    expect(notes[0].renderedDocument).toContain('DELIVERY NOTE');
    expect(notes[0].renderedDocument).toContain(delivery.deliveryNumber);
    expect(notes[0].renderedDocument).toContain(issued.materialDocumentNumber);
  });

  it('dispatches what the periodic run finds pending, and leaves what was sent alone', async () => {
    // An order confirmation that waits for the run, at the most specific access: this customer's own
    // orders, and not every order in the sales area.
    await record({
      outputType: 'BA00', documentCategory: 'SALES_ORDER', documentType: 'OR',
      salesOrg: '1000', distributionChannel: '10', division: '01', customerNumber: CUSTOMER,
      transmissionMedium: 'PRINT', dispatchTime: 'PERIODIC', partnerFunction: 'SP',
      validityFrom: '2026-01-01', validityTo: '2026-12-31',
    });
    const orderNumber = await place(CUSTOMER);

    // Determined as the order was written — determination runs inside the transaction that wrote the
    // document — and left standing until the run is called, because the record says periodic.
    const [standing] = await messages('SALES_ORDER', orderNumber);
    expect(standing).toMatchObject({ dispatchTime: 'PERIODIC', status: 'PENDING', sendCount: 0 });
    expect(standing.renderedDocument).toBeNull();

    const dispatched = await dispatchPendingSalesOutput({
      client: tenant.client, changedBy: ACTOR,
      selection: { documentCategory: 'SALES_ORDER', documentNumber: orderNumber },
    });
    expect(dispatched.dispatched).toBe(1);
    expect(dispatched.failed).toBe(0);

    const [sent] = await messages('SALES_ORDER', orderNumber);
    expect(sent).toMatchObject({ status: 'PROCESSED', sendCount: 1 });
    expect(sent.renderedDocument).toContain('ORDER CONFIRMATION');
    expect(sent.renderedDocument).toContain(orderNumber);
  });

  it('reads the queue back with the records that decided it', async () => {
    const queue = await listSalesOutput({ client: tenant.client });
    expect(queue.rows.length).toBeGreaterThan(0);
    expect(queue.processed).toBeGreaterThan(0);
    for (const row of queue.rows) {
      expect(['SALES_ORDER', 'DELIVERY', 'BILLING']).toContain(row.documentCategory);
      expect(row.outputTypeDescription.length).toBeGreaterThan(0);
    }

    const records = await listOutputConditionRecords(tenant.client, { validOn: BILLING_DATE });
    expect(records.length).toBeGreaterThan(0);
    // Every record says which access it answers at, so a reader can see why one stood over another.
    for (const entry of records) {
      expect(entry.access).toBeGreaterThanOrEqual(1);
      expect(entry.access).toBeLessThanOrEqual(5);
    }
    expect(records.some((entry) => entry.access === 1)).toBe(true);
    expect(records.some((entry) => entry.access === 3)).toBe(true);
  });

  /** A customer that can be sold to, carrying the e-mail address named — or none. */
  async function sellTo(partnerNumber: string, email: string | null): Promise<void> {
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, email, created_by)
        values (${tenant.client}, ${partnerNumber}, 'ORGANIZATION', ${`Test customer ${partnerNumber}`}, ${email}, ${ACTOR})
        on conflict (client, partner_number) do update set email = excluded.email
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${tenant.client}, ${partnerNumber}, 'CUSTOMER', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into customer_sales_area (
          client, partner_number, role_code, sales_org, distribution_channel, division,
          pricing_procedure, is_blocked, sales_status, created_by
        )
        values (${tenant.client}, ${partnerNumber}, 'CUSTOMER', '1000', '10', '01', 'PR01', false, 'MAINTAINED', ${ACTOR})
        on conflict (client, partner_number, sales_org, distribution_channel, division)
        do update set sales_status = excluded.sales_status
      `);
      await tx.execute(sql`
        insert into customer_company_code (
          client, partner_number, role_code, company_code, chart_of_accounts,
          reconciliation_account, payment_terms_code, created_by
        )
        values (${tenant.client}, ${partnerNumber}, 'CUSTOMER', '1000', 'CA01', ${RECON}, 'NET30', ${ACTOR})
        on conflict do nothing
      `);
    });
    await saveCustomerCredit({
      client: tenant.client, changedBy: ACTOR, customer: partnerNumber, creditControlArea: AREA,
      creditLimit: '1000000.00', riskCategory: 'A', isBlocked: false, changeReason: 'Output test fixture.',
    });
  }

  /** Every fan-out run queued for one document, in the order it was queued. */
  async function fanoutRuns(documentNumber: string) {
    return (await withTenant(tenant.client, (tx) => tx.execute(sql`
      select id, triggered_by as "triggeredBy"
        from job_run
       where client = ${tenant.client}
         and job_code = ${FANOUT_JOB}
         and parameters->>'objectKey' = ${documentNumber}
       order by queued_at, id
    `))) as unknown as { id: string; triggeredBy: string }[];
  }

  /** Run them, the way the worker would, and report how each ended. */
  async function drainFanout(documentNumber: string): Promise<string[]> {
    const outcomes: string[] = [];
    for (const run of await fanoutRuns(documentNumber)) {
      outcomes.push(await runClaimed(WORKER, { runId: run.id, client: tenant.client, jobCode: FANOUT_JOB }));
    }
    return outcomes;
  }

  function inboxOf(userId: string, kind: string, objectKey: string) {
    return listInbox(tenant.client, userId).then((rows) =>
      rows.filter((row) => row.kind === kind && row.objectKey === objectKey));
  }

  it('tells whoever may dispatch output, and not a holder of the same capability in another sales organisation', async () => {
    // A customer the company can sell to, whose master carries no e-mail
    // address. The invoice is e-mailed because a record says so, and it fails
    // because there is nobody to send it to — which is the only way the queue
    // comes to hold work nobody has looked at.
    const quiet = 'SD9252CUST3';
    await sellTo(quiet, null);
    await record({
      outputType: 'RD00', documentCategory: 'BILLING', documentType: 'F2',
      salesOrg: '1000', distributionChannel: '10', division: '01', customerNumber: quiet,
      transmissionMedium: 'EMAIL', dispatchTime: 'IMMEDIATE', partnerFunction: 'BP',
      validityFrom: '2026-01-01', validityTo: '2026-12-31',
    });

    // Two holders of the capability that puts a failed output right. One holds
    // it over the sales organisation this document belongs to; the other holds
    // the very same capability over a sales organisation that has nothing to do
    // with it, and is told nothing.
    const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
    const here = `u-out-${suffix}`;
    const elsewhere = `u-outelse-${suffix}`;
    const grantHere = `grant-out-${suffix}`;
    const grantElsewhere = `grant-outelse-${suffix}`;
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into app_user (id, client, username, full_name, password_hash, is_active)
        values
          (${here}, ${tenant.client}, ${'outhere' + suffix}, 'Output clerk here', 'scrypt:x:x', true),
          (${elsewhere}, ${tenant.client}, ${'outelse' + suffix}, 'Output clerk elsewhere', 'scrypt:x:x', true)
        on conflict (id) do nothing
      `);
      await tx.execute(sql`
        insert into user_capability (id, client, user_id, capability_code, valid_from, reason, granter)
        values
          (${grantHere}, ${tenant.client}, ${here}, 'SALES.OUTPUT.PROCESS', current_date, 'DIRECT', 'TEST'),
          (${grantElsewhere}, ${tenant.client}, ${elsewhere}, 'SALES.OUTPUT.PROCESS', current_date, 'DIRECT', 'TEST')
        on conflict (id) do nothing
      `);
      await tx.execute(sql`
        insert into user_capability_scope (client, grant_id, scope_type, scope_value)
        values
          (${tenant.client}, ${grantHere}, 'SALES_ORG', '1000'),
          (${tenant.client}, ${grantElsewhere}, 'SALES_ORG', '2000')
        on conflict do nothing
      `);
      await ensureDefinition(tx, {
        code: FANOUT_JOB, name: 'Resolve who to notify', module: 'PEOPLE',
        chunkSize: 100, maxRetries: 2, timeoutSeconds: 300, isScheduled: false,
      });
    });

    // The invoice is written and dispatched in one transaction, and it fails
    // there and then. Before this increment that was the end of it: the message
    // stood at ERROR until somebody happened to look at the queue.
    const billingNumber = await bill(await place(quiet));
    quietBilling = billingNumber;
    const [failed] = await messages('BILLING', billingNumber);
    expect(failed).toMatchObject({ transmissionMedium: 'EMAIL', status: 'ERROR', recipient: null });

    // The transaction recorded only that somebody has to be told, not who.
    // Deciding who means loading every candidate's authority, which is the
    // worker's job and not the request path's — least of all a request that is
    // in the middle of writing an invoice.
    const runs = await fanoutRuns(billingNumber);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.triggeredBy).toBe('OUTPUT');

    expect(await drainFanout(billingNumber)).toEqual(['SUCCEEDED']);

    const told = await inboxOf(here, 'OUTPUT.FAILED', billingNumber);
    expect(told).toHaveLength(1);
    expect(told[0]!.objectClass).toBe('sales_output');
    expect(told[0]!.isUnseen).toBe(true);
    expect(told[0]!.title).toContain(billingNumber);

    // Same capability, another sales organisation. Telling them would put work
    // in an inbox whose owner the output screen then refuses to act as.
    expect(await inboxOf(elsewhere, 'OUTPUT.FAILED', billingNumber)).toHaveLength(0);
  });

  it('says nothing again while the output stands in error, and nothing at all once it goes out', async () => {
    // Dispatching it again fails the same way. That is the same episode: the
    // clerk already holds the message, unread, and a second copy of it would
    // only be the deduplication throwing it away at the cost of a run.
    const again = await dispatchSalesOutput({
      client: tenant.client, changedBy: ACTOR, documentCategory: 'BILLING',
      documentNumber: quietBilling, outputType: 'RD00', transmissionMedium: 'EMAIL',
    });
    expect(again.status).toBe('ERROR');
    expect(await fanoutRuns(quietBilling)).toHaveLength(1);

    // Give the partner an address and dispatch once more: the output goes out,
    // and nobody is told about a failure that is over.
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update business_partner set email = 'quiet@customer.example'
       where client = ${tenant.client} and partner_number = 'SD9252CUST3'
    `));
    await setSalesOutputRecipient({
      client: tenant.client, changedBy: ACTOR, documentCategory: 'BILLING',
      documentNumber: quietBilling, outputType: 'RD00', transmissionMedium: 'EMAIL',
      recipient: 'quiet@customer.example',
    });
    const sent = await dispatchSalesOutput({
      client: tenant.client, changedBy: ACTOR, documentCategory: 'BILLING',
      documentNumber: quietBilling, outputType: 'RD00', transmissionMedium: 'EMAIL',
    });
    expect(sent.status).toBe('PROCESSED');
    expect(await fanoutRuns(quietBilling)).toHaveLength(1);
  });
});
