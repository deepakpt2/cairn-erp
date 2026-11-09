import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { reverseMaterialDocument } from '../src/modules/inventory/material-document-reversal';
import { saveCustomerCredit } from '../src/modules/finance/credit';
import {
  billingDueList,
  billDueList,
  cancelBillingDocument,
  getBilling,
  groupDueList,
  listSplitCriteria,
  saveSplitCriterion,
  salesDocumentFlow,
  type BillingDueRow,
} from '../src/modules/sales/billing';
import { writeDocumentPartners } from '../src/modules/sales/partners';
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

/**
 * §4.5 — billing the month: the collective run over the billing due list (audit gap G2).
 *
 * What stands here is the act the package never had: a month of goods-issued deliveries becomes the
 * handful of invoices the split criteria say it should be, in one submission. What one document *is*
 * does not change, and two of these tests say so with money rather than with words — a collective
 * document posts one receivable, for the sum of the deliveries it billed, against the payer.
 *
 * The three criteria that are not a decision are the first thing proved, because they are the whole
 * argument for the run being safe: two payers never land on one document, whatever is maintained.
 */
const ACTOR = 'SD9253_COLLECTIVE';
const AREA = 'CCA1';
const CUSTOMER = 'SD9253CUST1';
const OTHER_CUSTOMER = 'SD9253CUST2';
const SHIP_TO_1 = 'SD9253SHIP1';
const SHIP_TO_2 = 'SD9253SHIP2';
const MATERIAL = 'SD9253MAT1';
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
const key = (what: string) => `sd9253-${what}-${++counter}`;

async function seedPartners(client: string, partners: string[]) {
  await withTenant(client, async (tx) => {
    for (const partner of partners) {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${client}, ${partner}, 'ORGANIZATION', ${`Collective test ${partner}`}, ${ACTOR})
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

/**
 * One order, one delivery, goods issued: the smallest thing that can earn an invoice.
 *
 * `shipTo` is written on the delivery after it stands, because the order's own partners are determined
 * from the sold-to and a fixture that wanted two ship-tos for one customer has no other way in. It is
 * the same row the due list reads, not a second opinion about where the goods went.
 */
async function issuedDelivery(
  client: string,
  input: { customerNumber: string; quantity: number; shipTo?: string },
) {
  const created = await createSalesOrder({
    ...base, customerNumber: input.customerNumber, requestKey: key('order'),
    lines: [{
      lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
      orderQuantity: input.quantity, quantityUnit: 'UNT', taxCode: 'T10',
    }],
  });
  const open = await listDeliverableOrderLines(client, { orderNumber: created.orderNumber });
  const built = await createDelivery({
    client, changedBy: ACTOR, orderNumber: created.orderNumber, deliveryDate: DATE,
    goodsMovementDate: DATE, headerText: 'Collective run fixture',
    items: [{ orderLineNumber: open[0].lineNumber, quantity: String(input.quantity) }],
    requestKey: key('delivery'),
  });
  await confirmDeliveryPicks({
    client, changedBy: ACTOR, deliveryNumber: built.deliveryNumber,
    items: [{ lineNumber: 10, quantity: String(input.quantity), storageLocation: STORE }],
  });
  // The pick raised the delivery's version, and the issue is refused on a stale one: read it back
  // rather than guessing how many acts moved it on.
  const picked = await getDelivery(client, built.deliveryNumber);
  const issued = await postDeliveryGoodsIssue({
    client, changedBy: ACTOR, deliveryNumber: built.deliveryNumber,
    expectedVersion: picked!.version, postingDate: DATE, documentDate: DATE,
  });
  if (input.shipTo) {
    const shipTo = input.shipTo;
    await withTenant(client, (tx) => writeDocumentPartners(tx, {
      client, documentCategory: 'DELIVERY', documentNumber: built.deliveryNumber,
      partners: {
        soldTo: input.customerNumber, shipTo,
        billTo: input.customerNumber, payer: input.customerNumber,
      },
      changedBy: ACTOR,
    }));
  }
  return { orderNumber: created.orderNumber, deliveryNumber: built.deliveryNumber, issued };
}

describe('collective billing — the month-end run (§4.5, gap G2)', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTenant('sd9253-collective-billing');
    base.client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(tenant.client, async (tx) => {
      for (const range of [
        { objectCode: 'SALESORD', subObject: 'OR', prefix: 'SO', numberLength: 7 },
        { objectCode: 'DELIVERY', subObject: 'LF', prefix: 'DL', numberLength: 7 },
        { objectCode: 'BILLING', subObject: 'F2', prefix: 'INV', numberLength: 7 },
        // What a cancellation document draws its number from, for the run that is undone and re-billed.
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
        values (${tenant.client}, ${MATERIAL}, 'Collective test material', 'RAW', 'UNT', ${ACTOR}) on conflict do nothing
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
    // What the material costs. Every figure asserted below is this price at the quantity that went out,
    // plus ten per cent tax — the order's own arithmetic, quoted by the document that bills it.
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      customerNumber: '', materialNumber: MATERIAL, currency: 'USD', amount: 25, priceUnit: 1,
      validityFrom: '2026-01-01', validityTo: '2026-12-31', supersedeStanding: false,
    });
    await seedPartners(tenant.client, [CUSTOMER, OTHER_CUSTOMER, SHIP_TO_1, SHIP_TO_2]);
    for (const partner of [CUSTOMER, OTHER_CUSTOMER]) {
      await saveCustomerCredit({
        client: tenant.client, changedBy: ACTOR, customer: partner, creditControlArea: AREA,
        creditLimit: '1000000.00', riskCategory: 'A', isBlocked: false,
        changeReason: 'Collective billing fixture credit data.',
      });
    }
  });

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
  });

  // ── The grouping, before it touches the database ──────────────────────────────

  it('groups by payer, currency and company code with nothing maintained, and by each criterion once it is', () => {
    const row = (over: Partial<BillingDueRow>): BillingDueRow => ({
      deliveryNumber: 'DL-1', orderNumber: 'SO-1', customerNumber: CUSTOMER, payer: CUSTOMER,
      shipTo: SHIP_TO_1, salesOrg: '1000', distributionChannel: '10', division: '01',
      companyCode: '1000', currency: 'USD', plant: PLANT, goodsMovementDate: DATE,
      materialDocumentNumber: 'MD-1', value: '100.00', ...over,
    });
    const rows = [
      row({ deliveryNumber: 'DL-1' }),
      row({ deliveryNumber: 'DL-2', shipTo: SHIP_TO_2, value: '50.00' }),
      row({ deliveryNumber: 'DL-3', payer: OTHER_CUSTOMER, customerNumber: OTHER_CUSTOMER, value: '10.00' }),
      row({ deliveryNumber: 'DL-4', currency: 'EUR', value: '20.00' }),
      row({ deliveryNumber: 'DL-5', companyCode: '2000', value: '30.00' }),
    ];

    // Nothing maintained: one group per payer, currency and company code. Five deliveries, four documents.
    expect(groupDueList(rows, []).map((group) => group.deliveries.map((line) => line.deliveryNumber)))
      .toEqual([['DL-1', 'DL-2'], ['DL-3'], ['DL-4'], ['DL-5']]);
    // The group is worth the sum of what its deliveries are worth, which is what the screen shows the
    // reader before the run: how many invoices, and for how much.
    expect(groupDueList(rows, [])[0].value).toBe('150.00');

    // SHIP_TO maintained, and DL-2 went somewhere else: the pair becomes two documents.
    expect(groupDueList(rows, ['SHIP_TO']).map((group) => group.deliveries.map((line) => line.deliveryNumber)))
      .toEqual([['DL-1'], ['DL-2'], ['DL-3'], ['DL-4'], ['DL-5']]);
    // A criterion no two rows differ in changes nothing, and saying so is the point: maintaining one is
    // not a promise that it will split.
    expect(groupDueList(rows, ['PLANT'])).toHaveLength(4);
    // Two criteria together.
    expect(groupDueList([...rows, row({ deliveryNumber: 'DL-6', plant: '2000' })], ['PLANT', 'DIVISION']))
      .toHaveLength(5);
  });

  it('delivers the five criteria, none of them maintained, and maintains one on request', async () => {
    const before = await listSplitCriteria(tenant.client);
    expect(before.map((row) => row.criterion))
      .toEqual(['SALES_ORG', 'DISTRIBUTION_CHANNEL', 'DIVISION', 'SHIP_TO', 'PLANT']);
    // Nothing is maintained, and the run's default is therefore "one invoice per payer". A reader who
    // has never seen this screen is told that, rather than being shown five empty rows.
    expect(before.every((row) => !row.isActive)).toBe(true);
    expect(before.every((row) => row.displayName && row.meaning)).toBe(true);

    const saved = await saveSplitCriterion({
      client: tenant.client, criterion: 'SHIP_TO', isActive: true, sequence: 1, changedBy: ACTOR,
    });
    expect(saved).toMatchObject({ criterion: 'SHIP_TO', isActive: true, position: 1 });
    const after = await listSplitCriteria(tenant.client);
    expect(after.filter((row) => row.isActive).map((row) => row.criterion)).toEqual(['SHIP_TO']);

    // Withdrawn, and it stays in the list: what was billed under it stands.
    await saveSplitCriterion({
      client: tenant.client, criterion: 'SHIP_TO', isActive: false, changedBy: ACTOR,
    });
    const withdrawn = await listSplitCriteria(tenant.client);
    expect(withdrawn.find((row) => row.criterion === 'SHIP_TO'))
      .toMatchObject({ isActive: false, position: 0 });
    expect(withdrawn).toHaveLength(5);
  });

  // ── The run ─────────────────────────────────────────────────────────────────

  it('bills a month of deliveries as one document, and the month leaves the due list', async () => {
    const first = await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 4 });
    const second = await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 6 });

    const due = await billingDueList(tenant.client, {});
    expect(due.length).toBeGreaterThanOrEqual(2);
    // The due list names the payer the receivable will be raised against, and the company and currency
    // it will be accounted in — everything a group key can be read from, and nothing else.
    expect(due.every((row) => row.payer === CUSTOMER && row.currency === 'USD')).toBe(true);

    const run = await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
    });
    // Two deliveries, one payer, one currency, one company code, no criterion maintained: one document.
    expect(run.documents).toHaveLength(1);
    const created = run.documents[0];
    expect(created.posted).toBe(true);
    expect(created.replayed).toBe(false);
    expect(created.billing.customerInvoiceNumber).toBeTruthy();

    // The document carries both deliveries, one line per delivery line, numbered straight through.
    const view = await getBilling(tenant.client, created.billing.billingNumber);
    expect(view).not.toBeNull();
    expect(view!.lines).toHaveLength(2);
    // Numbered straight through the document, each carrying the delivery line it was priced from —
    // both deliveries number their own lines from ten, which is why the document numbers them 10 and 20.
    expect(view!.lines.map((line) => line.lineNumber)).toEqual([10, 20]);
    expect(view!.lines.map((line) => line.deliveryLineNumber)).toEqual([10, 10]);
    // Both orders stand on the line that was priced from them, and the header names none: a document
    // that pretended to one of them would be billing the other on its authority.
    expect([...new Set(view!.lines.map((line) => line.orderNumber))].sort())
      .toEqual([first.orderNumber, second.orderNumber].sort());
    expect(view!.orderNumber).toBeNull();
    expect(view!.deliveryNumber).toBeNull();

    // The value: 4 at 25 and 6 at 25, plus ten per cent tax. One receivable, for the whole month.
    expect(Number(view!.netValue)).toBe(250);
    expect(Number(view!.taxValue)).toBe(25);
    expect(Number(view!.grossValue)).toBe(275);
    expect(Number(created.invoice?.grossAmount)).toBe(275);

    // The month is billed. A second run has nothing left to do, which is what makes the run safe to
    // repeat: the due list, and not a flag, is what says a delivery has been billed.
    const again = await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
    });
    expect(again.documents).toHaveLength(0);

    // The flow still names the invoice, read through the lines: a header that names no delivery would
    // otherwise leave a month-end invoice looking like it billed nothing.
    const flow = await salesDocumentFlow(tenant.client, first.orderNumber);
    const row = flow.find((entry) => entry.deliveryNumber === first.deliveryNumber);
    expect(row?.billingNumber).toBe(created.billing.billingNumber);
    expect(row?.billingStatus).toBe('POSTED');
  });

  it('bills a month once, and a cancelled document frees its group to be billed again', async () => {
    await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 3 });
    const first = await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
    });
    expect(first.documents).toHaveLength(1);
    const number = first.documents[0].billing.billingNumber;
    const invoices = () => withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as n from customer_invoice where client = ${tenant.client}
    `) as unknown as Promise<Array<{ n: number }>>);
    const invoicesBefore = (await invoices())[0].n;

    // Run again: the month is already billed, so the due list offers nothing and no second receivable
    // is raised. What makes the retry safe is the due list and not a submission key — a delivery that
    // has been billed is no longer due, and a run takes no key because a key names one document and a
    // run draws several.
    const retry = await billDueList({ client: tenant.client, changedBy: ACTOR, billingDate: DATE });
    expect(retry.documents).toHaveLength(0);
    expect((await invoices())[0].n).toBe(invoicesBefore);

    // The document is cancelled, and the cancellation is what puts the delivery back on the due list:
    // a cancelled document stops occupying the delivery's slot, exactly as it does for one billed
    // on its own.
    await cancelBillingDocument({
      client: tenant.client, changedBy: ACTOR, billingNumber: number, postingDate: DATE,
      reason: 'Billed against the wrong month', requestKey: key('cancel'),
    });
    expect(await billingDueList(tenant.client, {})).toHaveLength(1);

    // The run raises a real document for it, and not the one that was undone.
    const corrected = await billDueList({ client: tenant.client, changedBy: ACTOR, billingDate: DATE });
    expect(corrected.documents).toHaveLength(1);
    expect(corrected.documents[0].billing.billingNumber).not.toBe(number);
    expect(corrected.documents[0].posted).toBe(true);
    expect(corrected.documents[0].billing.customerInvoiceNumber).toBeTruthy();
    // Two receivables were raised since the first run: the mirror the cancellation posted against the
    // one it undid, and the corrected invoice itself.
    expect((await invoices())[0].n).toBe(invoicesBefore + 2);
  });

  it('never puts two payers on one document, whatever is maintained', async () => {
    await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 2 });
    await issuedDelivery(tenant.client, { customerNumber: OTHER_CUSTOMER, quantity: 3 });

    const run = await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
    });
    // One document for each payer: a receivable is owed by one customer, and a document that named two
    // would be owed by neither.
    expect(run.documents).toHaveLength(2);
    const payers = run.documents.map((row) => row.billing.customerNumber).sort();
    expect(payers).toEqual([CUSTOMER, OTHER_CUSTOMER].sort());
    expect(run.documents.every((row) => row.posted)).toBe(true);
    // Each carries only its own payer's deliveries, and a document that billed one delivery names it
    // while one that billed several names none — the header is a convenience for the document that has
    // exactly one, and no pretence of one for the document that has not.
    for (const document of run.documents) {
      const view = await getBilling(tenant.client, document.billing.billingNumber);
      expect(view!.customerNumber).toBe(document.billing.customerNumber);
      if (view!.lines.length === 1) expect(view!.deliveryNumber).not.toBeNull();
      else expect(view!.deliveryNumber).toBeNull();
      expect([...new Set(view!.lines.map((line) => line.orderNumber))]).toHaveLength(view!.lines.length);
    }
  });

  it('splits one due list into several documents once a criterion is maintained', async () => {
    await saveSplitCriterion({
      client: tenant.client, criterion: 'SHIP_TO', isActive: true, sequence: 1, changedBy: ACTOR,
    });
    // Three deliveries to one payer, two of them to one ship-to and one to another.
    await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 2, shipTo: SHIP_TO_1 });
    await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 3, shipTo: SHIP_TO_1 });
    await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 5, shipTo: SHIP_TO_2 });

    const groups = groupDueList(await billingDueList(tenant.client, {}), ['SHIP_TO']);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.deliveries.length).sort()).toEqual([1, 2]);

    const run = await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
    });
    expect(run.documents).toHaveLength(2);
    const byValue = run.documents
      .map((row) => Number(row.billing.grossValue))
      .sort((left, right) => left - right);
    // 5 at 25 plus tax, and 5 at 25 plus tax: the split is by ship-to and the two documents happen to
    // carry the same value, which is the arithmetic rather than the point.
    expect(byValue).toEqual([137.5, 137.5]);
    expect(run.documents.every((row) => row.posted)).toBe(true);
    // One document for two deliveries carries two lines and no delivery of its own; the other carries
    // one line and names the delivery it billed.
    const sizes = (await Promise.all(run.documents.map((row) => getBilling(tenant.client, row.billing.billingNumber))))
      .map((view) => view!.lines.length)
      .sort((left, right) => left - right);
    expect(sizes).toEqual([1, 2]);

    await saveSplitCriterion({
      client: tenant.client, criterion: 'SHIP_TO', isActive: false, changedBy: ACTOR,
    });
  });

  it('fails the whole run rather than billing part of a month', async () => {
    await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 2 });
    await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 2 });
    const before = await billingDueList(tenant.client, {});
    expect(before.length).toBeGreaterThanOrEqual(2);

    // The one thing a month-end run cannot do without: a number to draw. It is blocked here rather
    // than exhausted, because a run that stops halfway for want of numbers is the same failure either
    // way and a blocked range is the one a reader can put right.
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update number_range set status = 'BLOCKED'
      where client = ${tenant.client} and object_code = 'BILLING' and sub_object = 'F2'
    `));

    await expect(billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
    })).rejects.toThrow(/no billing number can be drawn/);

    // Nothing was written for any group: billing the first and stopping at the second is not a
    // month-end run, it is two runs and a reconciliation.
    const written = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as n from billing_document
      where client = ${tenant.client} and request_key like 'sd9253-no-number%'
    `) as unknown as Promise<Array<{ n: number }>>);
    expect(written[0].n).toBe(0);
    expect(await billingDueList(tenant.client, {})).toHaveLength(before.length);

    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update number_range set status = 'ACTIVE'
      where client = ${tenant.client} and object_code = 'BILLING' and sub_object = 'F2'
    `));
    // The month is still there to be billed, and the run that could not draw a number took none of it.
    const after = await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
    });
    expect(after.documents).toHaveLength(1);
    expect(after.documents[0].posted).toBe(true);
  });

  it('drops a reversed issue from the month: what the goods came back on is not offered again', async () => {
    const kept = await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 2 });
    const returned = await issuedDelivery(tenant.client, { customerNumber: CUSTOMER, quantity: 2 });

    // The movement that shipped it is reversed, and the delivery goes back to being picked rather than
    // issued — so it leaves the due list rather than being offered and then refused. A month-end run
    // over what remains is a run over goods that are still out.
    await reverseMaterialDocument({
      client: tenant.client, changedBy: ACTOR, materialDocumentNumber: returned.issued.materialDocumentNumber,
      fiscalYear: returned.issued.materialDocumentYear, postingDate: DATE, documentDate: DATE,
      headerText: 'Shipment withdrawn', requestKey: key('reverse'),
    });
    expect((await getDelivery(tenant.client, returned.deliveryNumber))?.goodsIssueStands).toBe(false);

    const due = await billingDueList(tenant.client, {});
    expect(due.map((row) => row.deliveryNumber)).toContain(kept.deliveryNumber);
    expect(due.map((row) => row.deliveryNumber)).not.toContain(returned.deliveryNumber);

    const run = await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
    });
    expect(run.documents).toHaveLength(1);
    expect(run.documents[0].posted).toBe(true);
  });
});
