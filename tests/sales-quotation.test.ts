/**
 * ITEM-16 — sales quotation (VA21 / VA22 / VA23).
 *
 * A quotation is the answer given before the customer commits. What these tests hold it to: it prices
 * through the order's own engine; it is confirmed by the order's own availability plan but consumes
 * nothing, because its promise lives in tables the availability join never reads; it is judged for no
 * credit, completeness or output; it expires by a date and never by a write; and the order raised from
 * it is an ordinary order, created by the ordinary order service.
 */
import { getSalesOrder } from './helpers/sales-authorized';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveCustomerCredit } from '../src/modules/finance/credit';
import { saveSalesCondition } from '../src/modules/sales/conditions';
import { DELIVERY_CHECKING_RULE, ORDER_CHECKING_RULE } from '../src/modules/sales/availability';
import { saveCheckingGroup, saveCheckingRule, saveScopeOfCheck } from '../src/modules/production/availability-check';
import { createSalesOrder } from '../src/modules/sales/sales-order';
import {
  SalesQuotationError, createOrderFromQuotation, createQuotation, quotationCreateInput,
} from '../src/modules/sales/quotation';
import {
  assignSalesAreaDimensions, createTenant, defineTestRanges, destroyTenant, maintainMaterialSales,
  type TestTenant,
} from './helpers';
import { createSalesActor, refreshSalesActor } from './helpers/sales-actor';
import { changeQuotation, getQuotation, listQuotations, rejectQuotation } from './helpers/sales-authorized';

const ACTOR = 'SD16_QUOTE';
const AREA = 'CA16';
const CUSTOMER = 'SD16CUST1';
const GROUP = '01';
const NO_CHECK_GROUP = '02';
const PLANT = '1000';
const STORE = '0001';
const DATE = '2026-10-15';
const STOCK = 100;

const base = {
  client: '', changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
  customerNumber: CUSTOMER, companyCode: '1000', currency: 'USD',
};
const quote = { ...base, quotationDate: DATE, validTo: '2026-10-22' };

const MAT = {
  price: 'SD16M001', stock: 'SD16M002', twice: 'SD16M003', change: 'SD16M004', change2: 'SD16M005',
  credit: 'SD16M006', copy: 'SD16M007', copyB: 'SD16M008', reprice: 'SD16M009', rej: 'SD16M010',
  third: 'SD16M011', partial: 'SD16M012',
};
const BLANK_FLAGS = {
  includeSafetyStock: ' ', includeQualityStock: ' ', includeBlockedStock: ' ', includeRestrictedUse: ' ',
  purchaseOrders: ' ', purchaseRequisitions: ' ', plannedOrders: ' ', productionOrders: ' ',
  dependentRequirements: ' ', reservations: ' ', receiptsInPast: ' ',
};

let counter = 0;
const key = (what: string) => `sd16-${what}-${++counter}`;

const ACTORS = new Map<string, { userId: string; sessionId: string; authorization: { userId: string; sessionId: string } }>();
async function authority(client: string, who = 'full', capabilities?: readonly string[]) {
  const tag = `${client}/${who}`;
  if (!ACTORS.has(tag)) ACTORS.set(tag, await createSalesActor(client, capabilities ? { capabilities } : {}));
  const actor = ACTORS.get(tag)!;
  await refreshSalesActor(client, actor);
  return actor.authorization;
}

describe('sales quotation', () => {
  let tenant: TestTenant;

  const setSafetyStock = (materialNumber: string, quantity: number) => withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`update material_plant set safety_stock = ${quantity}
      where client = ${tenant.client} and material_number = ${materialNumber} and plant = ${PLANT}`);
  });

  const addMaterial = async (materialNumber: string) => {
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${tenant.client}, ${materialNumber}, ${`Quotation test ${materialNumber}`}, 'RAW', 'UNT', ${ACTOR})
        on conflict do nothing`);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, safety_stock, created_by)
        values (${tenant.client}, ${materialNumber}, ${PLANT}, 0, ${ACTOR})
        on conflict (client, material_number, plant) do update set safety_stock = 0`);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency,
                                        total_stock_quantity, stock_value, created_by)
        values (${tenant.client}, ${materialNumber}, ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1, 'USD',
                ${STOCK}, ${STOCK * 10}, ${ACTOR})
        on conflict (client, material_number, valuation_area)
        do update set total_stock_quantity = excluded.total_stock_quantity, stock_value = excluded.stock_value`);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        values (${tenant.client}, ${materialNumber}, ${PLANT}, ${STORE}, 'UNRESTRICTED', ${STOCK}, ${ACTOR})
        on conflict (client, material_number, plant, storage_location, stock_type, batch_number)
        do update set quantity = excluded.quantity`);
    });
    await maintainMaterialSales(tenant, { materialNumber, deliveringPlant: PLANT, availabilityCheckGroup: GROUP });
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      customerNumber: '', materialNumber, currency: 'USD', amount: 25, priceUnit: 1,
      validityFrom: '2026-01-01', validityTo: '2026-12-31',
    });
  };

  const line = (materialNumber: string, quantity: number, extra: Record<string, unknown> = {}) => ({
    lineNumber: undefined as number | undefined, materialNumber, plant: PLANT, orderQuantity: quantity,
    quantityUnit: 'UNT', taxCode: 'T10', ...extra,
  });
  const makeQuote = async (lines: ReturnType<typeof line>[], extra: Record<string, unknown> = {}, who = 'full') =>
    createQuotation({ ...quote, requestKey: key('quote'), lines, ...extra } as never, { authorization: await authority(base.client, who) });
  const makeOrder = async (materialNumber: string, quantity: number, orderDate = DATE) => createSalesOrder({
    ...base, orderDate, requestKey: key('order'), lines: [line(materialNumber, quantity)],
  } as never, { authorization: await authority(base.client) });
  const refused = async (work: Promise<unknown>, pattern: RegExp) => {
    const error = await work.then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(SalesQuotationError);
    expect((error as SalesQuotationError).message).toMatch(pattern);
    return error as SalesQuotationError;
  };
  const count = async (statement: ReturnType<typeof sql>) => withTenant(tenant.client, async (tx) => {
    const rows = await tx.execute(statement) as unknown as Array<{ n: string }>;
    return Number(rows[0]?.n ?? 0);
  });

  beforeAll(async () => {
    tenant = await createTenant('sd16-quote');
    base.client = tenant.client;
    quote.client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(tenant.client, async (tx) => {
      for (const range of [
        { objectCode: 'SALESORD', subObject: 'OR', prefix: 'SO', numberLength: 7 },
        { objectCode: 'SALESORD', subObject: 'AG', prefix: 'SQ', numberLength: 7 },
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
    for (const m of Object.values(MAT)) await addMaterial(m);
  });

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
  });

  it('numbers a quotation from SALESORD/AG and prices it the way the order prices the same items', async () => {
    const q = await makeQuote([line(MAT.price, 4)]);
    expect(q.quotationNumber).toMatch(/^SQ/);
    expect(q.documentType).toBe('AG');
    expect(q.status).toBe('OPEN');
    const o = await makeOrder(MAT.price, 4);
    // The same net, tax and gross the order carries: one pricing engine, not a second formula.
    expect([q.netValue, q.taxValue, q.grossValue]).toEqual([o.netValue, o.taxValue, o.grossValue]);
    expect(Number(q.netValue)).toBe(100);
    expect(q.lines[0]).toMatchObject({ lineNumber: 10, quotationQuantity: '4.000', netAmount: '100.0000', status: 'OPEN' });
    expect(q.lines[0].conditionNumber).toBe(o.lines[0].conditionNumber);
    expect(q.partners.soldTo).toBe(CUSTOMER);
    // The conditions are stored under their own category.
    expect(await count(sql`select count(*)::text as n from sales_document_condition
      where client = ${tenant.client} and document_category = 'QUOTATION' and document_number = ${q.quotationNumber}`)).toBeGreaterThan(0);
  });

  it('keeps the promise in its own schedule table and never in the order schedule', async () => {
    await setSafetyStock(MAT.partial, STOCK - 6);
    const q = await makeQuote([line(MAT.partial, 10)]);
    expect(q.lines[0].confirmedQuantity).toBe('6.000');
    expect(q.lines[0].schedule).toEqual([{
      scheduleNumber: 10, requestedDate: DATE, requestedQuantity: '10.000', confirmedQuantity: '6.000', confirmedDate: DATE,
    }]);
    expect(await count(sql`select count(*)::text as n from sales_order_schedule
      where client = ${tenant.client} and order_number = ${q.quotationNumber}`)).toBe(0);
    expect(await count(sql`select count(*)::text as n from sales_order where client = ${tenant.client}
      and order_number = ${q.quotationNumber}`)).toBe(0);
  });

  it('consumes no availability: an order for the whole stock is still confirmed in full', async () => {
    await setSafetyStock(MAT.stock, STOCK - 10);
    const q = await makeQuote([line(MAT.stock, 10)]);
    expect(q.lines[0].confirmedQuantity).toBe('10.000');
    const o = await getSalesOrder(tenant.client, (await makeOrder(MAT.stock, 10)).orderNumber);
    expect(o!.lines[0].confirmedQuantity).toBe('10.000');
  });

  it('confirms the full quantity on two quotations for the same stock', async () => {
    await setSafetyStock(MAT.twice, STOCK - 10);
    const first = await makeQuote([line(MAT.twice, 10)]);
    const second = await makeQuote([line(MAT.twice, 10)]);
    expect(first.lines[0].confirmedQuantity).toBe('10.000');
    expect(second.lines[0].confirmedQuantity).toBe('10.000');
  });

  it('refuses a valid-to before the quotation date, and the constraint backs the refusal', async () => {
    const error = await refused(makeQuote([line(MAT.price, 1)], { validTo: '2026-10-14' }), /valid to 2026-10-14/);
    expect(error.remedy).toMatch(/on or after the quotation date/);
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into sales_quotation (client, quotation_number, sales_org, distribution_channel, division, customer_number,
                                   company_code, currency, quotation_date, valid_to)
      values (${tenant.client}, 'BACKSTOP1', '1000', '10', '01', ${CUSTOMER}, '1000', 'USD', '2026-10-15', '2026-10-14')`)))
      .rejects.toThrow();
    // A quotation without an end date is not a quotation: refused before it reaches the service.
    expect(() => quotationCreateInput.parse({ ...quote, validTo: undefined, lines: [line(MAT.price, 1)] })).toThrow();
  });

  it('is judged for no credit, however large it is', async () => {
    const q = await makeQuote([line(MAT.credit, 60_000)]);
    expect(Number(q.grossValue)).toBeGreaterThan(1_000_000);
    expect(await count(sql`select count(*)::text as n from credit_determination
      where client = ${tenant.client} and sales_document = ${q.quotationNumber}`)).toBe(0);
    expect(q.status).toBe('OPEN');
  });

  it('writes no incompletion log row and no output message', async () => {
    const q = await makeQuote([line(MAT.price, 1)]);
    expect(await count(sql`select count(*)::text as n from sales_incompletion_log
      where client = ${tenant.client} and document_number = ${q.quotationNumber}`)).toBe(0);
    expect(await count(sql`select count(*)::text as n from output_message
      where client = ${tenant.client} and document_number = ${q.quotationNumber}`)).toBe(0);
  });

  it('changes: re-prices, bumps the version and refuses what it must', async () => {
    const q = await makeQuote([line(MAT.change, 2), line(MAT.change2, 3)]);
    const changed = await changeQuotation({
      ...quote, customerNumber: CUSTOMER, quotationNumber: q.quotationNumber, expectedVersion: q.version,
      lines: [line(MAT.change, 4, { lineNumber: 10 }), line(MAT.change2, 3, { lineNumber: 20 })],
    } as never);
    expect(changed.version).toBe(q.version + 1);
    expect(Number(changed.netValue)).toBe(175);
    expect(changed.lines.find((l) => l.lineNumber === 10)!.quotationQuantity).toBe('4.000');

    // Stale version.
    await refused(changeQuotation({
      ...quote, quotationNumber: q.quotationNumber, expectedVersion: q.version,
      lines: [line(MAT.change, 4, { lineNumber: 10 }), line(MAT.change2, 3, { lineNumber: 20 })],
    } as never), /changed since it was read/);
    // Sold-to and sales area are not changed.
    await refused(changeQuotation({
      ...quote, customerNumber: 'OTHERCUST', quotationNumber: q.quotationNumber, expectedVersion: changed.version,
      lines: [line(MAT.change, 4, { lineNumber: 10 }), line(MAT.change2, 3, { lineNumber: 20 })],
    } as never), /sold-to.*not changed/);
    await refused(changeQuotation({
      ...quote, division: '02', quotationNumber: q.quotationNumber, expectedVersion: changed.version,
      lines: [line(MAT.change, 4, { lineNumber: 10 }), line(MAT.change2, 3, { lineNumber: 20 })],
    } as never), /sold-to.*not changed/);
    // The day it was given is not moved.
    await refused(changeQuotation({
      ...quote, quotationDate: '2026-10-16', validTo: '2026-10-30', quotationNumber: q.quotationNumber, expectedVersion: changed.version,
      lines: [line(MAT.change, 4, { lineNumber: 10 }), line(MAT.change2, 3, { lineNumber: 20 })],
    } as never), /not changed/);
    // An item neither submitted nor rejected.
    await refused(changeQuotation({
      ...quote, quotationNumber: q.quotationNumber, expectedVersion: changed.version,
      lines: [line(MAT.change, 4, { lineNumber: 10 })],
    } as never), /Item 20 was neither submitted nor rejected/);
    // Reject one item with a reason: it stays, rejected, and leaves the totals.
    const rejected = await changeQuotation({
      ...quote, quotationNumber: q.quotationNumber, expectedVersion: changed.version,
      lines: [line(MAT.change, 4, { lineNumber: 10 })], rejectLines: [{ lineNumber: 20, reason: 'prce' }],
    } as never);
    expect(rejected.lines.find((l) => l.lineNumber === 20)).toMatchObject({ status: 'REJECTED', rejectionReason: 'PRCE' });
    expect(Number(rejected.netValue)).toBe(100);
  });

  it('rejects: sets the status and reason, refuses no reason, refuses twice, refuses a stale version', async () => {
    const q = await makeQuote([line(MAT.rej, 1)]);
    await refused(rejectQuotation({ client: tenant.client, changedBy: ACTOR, quotationNumber: q.quotationNumber, expectedVersion: q.version, reason: '' }), /needs a reason/);
    await refused(rejectQuotation({ client: tenant.client, changedBy: ACTOR, quotationNumber: q.quotationNumber, expectedVersion: q.version + 5, reason: 'LOST' }), /changed since it was read/);
    const done = await rejectQuotation({ client: tenant.client, changedBy: ACTOR, quotationNumber: q.quotationNumber, expectedVersion: q.version, reason: 'lost' });
    expect(done).toMatchObject({ status: 'REJECTED', rejectionReason: 'LOST', version: q.version + 1 });
    await refused(rejectQuotation({ client: tenant.client, changedBy: ACTOR, quotationNumber: q.quotationNumber, expectedVersion: done.version, reason: 'LOST' }), /already stands REJECTED/);
    // A rejected quotation is not changed either.
    await refused(changeQuotation({ ...quote, quotationNumber: q.quotationNumber, expectedVersion: done.version, lines: [line(MAT.rej, 1, { lineNumber: 10 })] } as never), /only an open quotation/);
  });

  it('computes expiry from the date and never writes it', async () => {
    const q = await makeQuote([line(MAT.third, 1)], { validTo: '2026-10-20' });
    expect((await getQuotation(tenant.client, q.quotationNumber, '2026-10-20'))!.isExpired).toBe(false);
    expect((await getQuotation(tenant.client, q.quotationNumber, '2026-10-21'))!.isExpired).toBe(true);
    const listed = (await listQuotations(tenant.client, { today: '2026-10-21' })).find((r) => r.quotationNumber === q.quotationNumber);
    expect(listed!.isExpired).toBe(true);
    // Read long after the date: the stored status is still OPEN.
    expect((await getQuotation(tenant.client, q.quotationNumber, '2031-01-01'))!.isExpired).toBe(true);
    const stored = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select status, rejection_reason, version from sales_quotation
       where client = ${tenant.client} and quotation_number = ${q.quotationNumber}`)) as unknown as Array<{ status: string; rejection_reason: string | null; version: number }>;
    expect(stored[0]).toMatchObject({ status: 'OPEN', rejection_reason: null, version: 1 });
    // A rejected quotation is not "expired": expiry is a fact about an open one.
    const r = await rejectQuotation({ client: tenant.client, changedBy: ACTOR, quotationNumber: q.quotationNumber, expectedVersion: 1, reason: 'LOST' });
    expect((await getQuotation(tenant.client, r.quotationNumber, '2031-01-01'))!.isExpired).toBe(false);
  });

  it('raises an ordinary order that names the quotation, keeps the item numbers and is credit-checked', async () => {
    const q = await makeQuote([line(MAT.copy, 3), line(MAT.copyB, 2), line(MAT.change, 1)]);
    // Item 20 is rejected: it is left behind, and 30 keeps its number.
    const changed = await changeQuotation({
      ...quote, quotationNumber: q.quotationNumber, expectedVersion: q.version,
      lines: [line(MAT.copy, 3, { lineNumber: 10 }), line(MAT.change, 1, { lineNumber: 30 })],
      rejectLines: [{ lineNumber: 20, reason: 'STCK' }],
    } as never);
    const result = await createOrderFromQuotation({
      client: tenant.client, changedBy: ACTOR, quotationNumber: q.quotationNumber, expectedVersion: changed.version,
      orderDate: DATE, requestKey: key('copy'), today: DATE,
    }, { authorization: await authority(base.client) });
    expect(result.alreadyRaised).toEqual([]);
    const order = await getSalesOrder(tenant.client, result.orderNumber);
    expect(order).toMatchObject({ referenceDocumentType: 'AG', referenceDocumentNumber: q.quotationNumber, documentType: 'OR' });
    expect(order!.lines.map((l) => l.lineNumber)).toEqual([10, 30]);
    expect(order!.credit).not.toBeNull();
    expect(order!.credit!.status).toBe('PASSED');
    expect((await getQuotation(tenant.client, q.quotationNumber))!.ordersRaised).toEqual([result.orderNumber]);
    expect((await listQuotations(tenant.client)).find((r) => r.quotationNumber === q.quotationNumber)!.ordersRaised).toEqual([result.orderNumber]);
    // The quotation is not consumed and not changed by being copied.
    expect((await getQuotation(tenant.client, q.quotationNumber))!.version).toBe(changed.version);

    // A second order is allowed, and the result names the first.
    const again = await createOrderFromQuotation({
      client: tenant.client, changedBy: ACTOR, quotationNumber: q.quotationNumber, expectedVersion: changed.version,
      orderDate: DATE, requestKey: key('copy'), today: DATE,
    }, { authorization: await authority(base.client) });
    expect(again.orderNumber).not.toBe(result.orderNumber);
    expect(again.alreadyRaised).toEqual([result.orderNumber]);
    expect((await getQuotation(tenant.client, q.quotationNumber))!.ordersRaised).toEqual([result.orderNumber, again.orderNumber]);
  });

  it('prices the order on the order date, not at the quotation price', async () => {
    const q = await makeQuote([line(MAT.reprice, 2)]);
    expect(Number(q.netValue)).toBe(50);
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      customerNumber: '', materialNumber: MAT.reprice, currency: 'USD', amount: 40, priceUnit: 1,
      validityFrom: '2026-10-18', validityTo: '2026-12-31', supersedeStanding: true,
    });
    const result = await createOrderFromQuotation({
      client: tenant.client, changedBy: ACTOR, quotationNumber: q.quotationNumber, expectedVersion: q.version,
      orderDate: '2026-10-20', requestKey: key('copy'), today: '2026-10-20',
    }, { authorization: await authority(base.client) });
    expect(Number(result.order.netValue)).toBe(80);
    // The quotation keeps the price it was given on its own date, even after a change.
    const again = await changeQuotation({
      ...quote, quotationNumber: q.quotationNumber, expectedVersion: q.version,
      lines: [line(MAT.reprice, 2, { lineNumber: 10 })],
    } as never);
    expect(Number(again.netValue)).toBe(50);
  });

  it('refuses to copy a rejected, an expired and an all-rejected quotation', async () => {
    const auth = await authority(base.client);
    const copy = (n: string, version: number, today = DATE) => createOrderFromQuotation({
      client: tenant.client, changedBy: ACTOR, quotationNumber: n, expectedVersion: version,
      orderDate: DATE, requestKey: key('copy'), today,
    }, { authorization: auth });

    const rejectedQ = await makeQuote([line(MAT.rej, 1)]);
    const r = await rejectQuotation({ client: tenant.client, changedBy: ACTOR, quotationNumber: rejectedQ.quotationNumber, expectedVersion: 1, reason: 'LOST' });
    await refused(copy(r.quotationNumber, r.version), /stands REJECTED/);

    const expiredQ = await makeQuote([line(MAT.rej, 1)], { validTo: '2026-10-16' });
    await refused(copy(expiredQ.quotationNumber, expiredQ.version, '2026-10-17'), /has expired/);
    // On the last day it still holds.
    await expect(copy(expiredQ.quotationNumber, expiredQ.version, '2026-10-16')).resolves.toBeTruthy();

    const staleQ = await makeQuote([line(MAT.rej, 1)]);
    await refused(copy(staleQ.quotationNumber, staleQ.version + 3), /changed since it was read/);
  });

  it('refuses to copy a quotation whose every item is rejected', async () => {
    const q = await makeQuote([line(MAT.rej, 1), line(MAT.price, 1)]);
    const changed = await changeQuotation({
      ...quote, quotationNumber: q.quotationNumber, expectedVersion: q.version,
      lines: [line(MAT.rej, 1, { lineNumber: 10 })], rejectLines: [{ lineNumber: 20, reason: 'STCK' }],
    } as never);
    const none = await changeQuotation({
      ...quote, quotationNumber: q.quotationNumber, expectedVersion: changed.version,
      lines: [line(MAT.rej, 1, { lineNumber: 10 })], rejectLines: [{ lineNumber: 10, reason: 'STCK' }],
    } as never);
    expect(none.lines.every((l) => l.status === 'REJECTED')).toBe(true);
    await refused(createOrderFromQuotation({
      client: tenant.client, changedBy: ACTOR, quotationNumber: q.quotationNumber, expectedVersion: none.version,
      orderDate: DATE, requestKey: key('copy'), today: DATE,
    }, { authorization: await authority(base.client) }), /no open items/);
  });

  it('refuses a copy without SALES.ORDER.CREATE, naming it, and without the quotation capability', async () => {
    const q = await makeQuote([line(MAT.copy, 1)]);
    const onlyQuotation = await authority(base.client, 'quotation-only', ['SALES.QUOTATION.CREATE']);
    const error = await refused(createOrderFromQuotation({
      client: tenant.client, changedBy: ACTOR, quotationNumber: q.quotationNumber, expectedVersion: q.version,
      orderDate: DATE, requestKey: key('copy'), today: DATE,
    }, { authorization: onlyQuotation }), /SALES\.ORDER\.CREATE/);
    expect(error.remedy).toMatch(/SALES\.ORDER\.CREATE/);
    expect((await getQuotation(tenant.client, q.quotationNumber))!.ordersRaised).toEqual([]);

    const onlyOrder = await authority(base.client, 'order-only', ['SALES.ORDER.CREATE']);
    await refused(createOrderFromQuotation({
      client: tenant.client, changedBy: ACTOR, quotationNumber: q.quotationNumber, expectedVersion: q.version,
      orderDate: DATE, requestKey: key('copy'), today: DATE,
    }, { authorization: onlyOrder }), /SALES\.QUOTATION\.CREATE|permission|authori/i);
    await refused(makeQuote([line(MAT.copy, 1)], {}, 'order-only'), /SALES\.QUOTATION\.CREATE|permission|authori/i);
  });

  it('returns one quotation and one order for a double submit', async () => {
    const auth = await authority(base.client);
    const requestKey = key('double');
    const a = await createQuotation({ ...quote, requestKey, lines: [line(MAT.copyB, 1)] } as never, { authorization: auth });
    const b = await createQuotation({ ...quote, requestKey, lines: [line(MAT.copyB, 1)] } as never, { authorization: auth });
    expect(b.quotationNumber).toBe(a.quotationNumber);
    expect(b.replayed).toBe(true);
    expect(await count(sql`select count(*)::text as n from sales_quotation where client = ${tenant.client} and request_key = ${requestKey}`)).toBe(1);

    const copyKey = key('double-copy');
    const input = {
      client: tenant.client, changedBy: ACTOR, quotationNumber: a.quotationNumber, expectedVersion: a.version,
      orderDate: DATE, requestKey: copyKey, today: DATE,
    };
    const first = await createOrderFromQuotation(input, { authorization: auth });
    const second = await createOrderFromQuotation(input, { authorization: auth });
    expect(second.orderNumber).toBe(first.orderNumber);
    expect(second.replayed).toBe(true);
    expect((await getQuotation(tenant.client, a.quotationNumber))!.ordersRaised).toEqual([first.orderNumber]);
    // Only the first press wrote an audit row for the link.
    expect(await count(sql`select count(*)::text as n from change_document
      where client = ${tenant.client} and object_class = 'sales_quotation' and object_key = ${a.quotationNumber}
        and change_type = 'CHANGE'`)).toBe(1);
  });

  it('cannot be deleted: the runtime role holds no DELETE', async () => {
    const q = await makeQuote([line(MAT.price, 1)]);
    const grants = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select t as "table", has_table_privilege('cairn_app', 'public.' || t, 'DELETE') as can_delete,
             has_table_privilege('cairn_app', 'public.' || t, 'UPDATE') as can_update
        from unnest(array['sales_quotation','sales_quotation_line','sales_quotation_schedule']) as t`)) as unknown as Array<{ table: string; can_delete: boolean; can_update: boolean }>;
    expect(grants.map((g) => g.can_delete)).toEqual([false, false, false]);
    expect(grants.map((g) => g.can_update)).toEqual([true, true, true]);
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`
      delete from sales_quotation where client = ${tenant.client} and quotation_number = ${q.quotationNumber}`))).rejects.toThrow();
    expect(await getQuotation(tenant.client, q.quotationNumber)).not.toBeNull();
  });

  it('records a CREATE and a CHANGE change document under sales_quotation', async () => {
    const q = await makeQuote([line(MAT.price, 1)]);
    await changeQuotation({ ...quote, quotationNumber: q.quotationNumber, expectedVersion: q.version, lines: [line(MAT.price, 2, { lineNumber: 10 })] } as never);
    const types = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select change_type from change_document
       where client = ${tenant.client} and object_class = 'sales_quotation' and object_key = ${q.quotationNumber}
       order by changed_at, id`)) as unknown as Array<{ change_type: string }>;
    expect(types.map((t) => t.change_type).sort()).toEqual(['CHANGE', 'CREATE']);
  });

  it('gates the screen and the actions on the capabilities', () => {
    const root = new URL('..', import.meta.url).pathname;
    const page = readFileSync(`${root}src/app/sales/quotations/page.tsx`, 'utf8');
    expect(page).toContain('requireSession(SALES_QUOTATION_ROUTE)');
    expect(page).toContain('can(session, SALES_QUOTATION_CAPABILITY)');
    const actions = readFileSync(`${root}src/app/sales/quotations/actions.ts`, 'utf8');
    expect(actions.match(/can\(session, SALES_QUOTATION_CAPABILITY\)/g)!.length).toBe(4);
    const copy = actions.slice(actions.indexOf('export async function createOrderFromQuotationAction'));
    expect(copy).toContain('can(session, SALES_ORDER_CAPABILITY)');
    expect(actions).not.toMatch(/\bdelete\b.*quotation/i);
    const screen = readFileSync(`${root}src/app/sales/quotations/page.tsx`, 'utf8');
    expect(screen).toContain('consumes no availability');
    expect(screen).toContain('creates no receivable');
    expect(screen).toContain('not judged for credit');
  });

  it('is registered: capability, registry row, aliases, document type and range', async () => {
    const reg = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select r.our_code, r.our_table, r.module, r.route_path, r.coverage_tier, r.conformance_tier,
             (select string_agg(a.alias, ',' order by a.alias) from term_alias a where a.term_id = r.id) as aliases
        from term_registry r where r.our_code = 'SALES.QUOTATION.CREATE'`)) as unknown as Array<Record<string, string>>;
    expect(reg[0]).toMatchObject({
      our_table: 'sales_quotation', module: 'SD', route_path: '/sales/quotations',
      coverage_tier: 'TIER_1_BUILT', conformance_tier: 'B', aliases: 'VA21,VA22,VA23',
    });
    const type = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select name, number_range_object, number_range_sub_object, pricing_procedure from sales_document_type
       where client = ${tenant.client} and document_type = 'AG'`)) as unknown as Array<Record<string, string>>;
    expect(type[0]).toMatchObject({ name: 'Quotation', number_range_object: 'SALESORD', number_range_sub_object: 'AG' });
    // Granted to no role by the migration.
    expect(await count(sql`select count(*)::text as n from role_capability
      where capability_code = 'SALES.QUOTATION.CREATE' and role_code not like 'TEST_SALES_%' and role_code not like 'TEST_FINANCE_%'`)).toBe(0);
  });
});
