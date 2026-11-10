import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveCustomerCredit } from '../src/modules/finance/credit';
import { saveSalesCondition } from '../src/modules/sales/conditions';
import { billDueList, cancelBillingDocument, getBilling } from '../src/modules/sales/billing';
import {
  cancelDelivery, confirmDeliveryPicks, createDelivery, getDelivery,
  listDeliverableOrderLines, postDeliveryGoodsIssue,
} from '../src/modules/sales/delivery';
import { cancelSalesOrder, createSalesOrder, getSalesOrder } from '../src/modules/sales/sales-order';
import {
  listDocumentRegister, listDueRegister, listRegisterChoices,
} from '../src/modules/sales/registers';
import {
  assignSalesAreaDimensions, createTenant, destroyTenant, maintainMaterialSales,
  type TestTenant,
} from './helpers';

/**
 * §5.2 — the registers, and the due lists read through them.
 *
 * A register is a reading, not a record. Nothing in this increment writes a row that a document did
 * not already carry, which is why the migration carries only a capability: these five lists are
 * different questions put to the same documents, and the property worth protecting is that the
 * answer is the one the document would give if you opened it.
 *
 * Three things are proved, and everything else is a consequence of them:
 *
 * **Each kind reads its own documents.** An order register that quietly contained deliveries would
 * be a report nobody could trust a number off.
 *
 * **The total is the total of what was answered.** A register that listed two hundred documents and
 * totalled four thousand is two answers to one question, so the limit and the total move together.
 *
 * **The due lists are the services, not a restatement.** The register asks the same functions the
 * delivery and billing screens ask, and gives them the same filter — because a register that
 * disagreed with the act it is listing would be worse than no register at all.
 */
const ACTOR = 'SD9256_REGISTER';
const AREA = 'CCA1';
const CUSTOMER = 'SD9256CUST1';
const MATERIAL = 'SD9256MAT1';
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

/** The material is priced at 25 a unit, and tax is ten per cent, so four units net 100. */
const net = (units: number) => (units * 25).toFixed(2);

describe('the document registers and the due lists (§5.2)', () => {
  let tenant: TestTenant;
  let counter = 0;
  const key = (what: string) => `sd9256-${what}-${++counter}`;

  beforeAll(async () => {
    tenant = await createTenant('sd9256-registers');
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
        values (${tenant.client}, ${CUSTOMER}, 'ORGANIZATION', 'Register test customer', ${ACTOR})
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
        values (${tenant.client}, ${MATERIAL}, 'Register test material', 'RAW', 'UNT', ${ACTOR})
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
        values (${tenant.client}, 'MD-REG001', 2026, ${DATE}, ${DATE}, 'Opening balance', 'POSTED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (client, material_document_number, line_number, movement_type,
                                            material_number, plant, storage_location, stock_type,
                                            line_direction, entry_quantity, entry_unit, base_quantity,
                                            base_unit, created_by)
        values (${tenant.client}, 'MD-REG001', 1, 'OPENING_BALANCE', ${MATERIAL}, ${PLANT}, ${STORE},
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
      changeReason: 'Register test credit data.',
    });
  });

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
  });

  /** One order, priced and standing. The smallest thing a register can list. */
  async function ordered(units: number) {
    return createSalesOrder({
      ...base, requestKey: key('order'),
      lines: [{
        lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: units, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    });
  }

  /** An order, delivered and goods issued. The smallest thing that can earn an invoice. */
  async function shipped(units: number) {
    const created = await ordered(units);
    const open = await listDeliverableOrderLines(tenant.client, { orderNumber: created.orderNumber });
    const built = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.orderNumber, deliveryDate: DATE,
      goodsMovementDate: DATE, headerText: 'Register fixture',
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

  /** The whole chain: ordered, shipped and billed. */
  async function billed(units: number) {
    const chain = await shipped(units);
    const [document] = (await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
      selection: { deliveryNumber: chain.deliveryNumber },
    })).documents;
    return { ...chain, billingNumber: document.billing.billingNumber };
  }

  const numbers = (register: { rows: Array<{ documentNumber: string }> }) =>
    register.rows.map((row) => row.documentNumber);

  it('each register reads its own documents, and says what kind it is reading', async () => {
    const { orderNumber, deliveryNumber, billingNumber } = await billed(4);

    const orders = await listDocumentRegister(tenant.client, { kind: 'ORDER' });
    const deliveries = await listDocumentRegister(tenant.client, { kind: 'DELIVERY' });
    const billings = await listDocumentRegister(tenant.client, { kind: 'BILLING' });

    expect(orders.kind).toBe('ORDER');
    expect(deliveries.kind).toBe('DELIVERY');
    expect(billings.kind).toBe('BILLING');
    // Each carries the meaning it was asked for, so a screen does not have to restate it.
    expect(orders.meaning).not.toBe(deliveries.meaning);

    expect(numbers(orders)).toContain(orderNumber);
    expect(numbers(deliveries)).toContain(deliveryNumber);
    expect(numbers(billings)).toContain(billingNumber);

    // And none of them reaches past its own kind.
    expect(numbers(orders)).not.toContain(deliveryNumber);
    expect(numbers(orders)).not.toContain(billingNumber);
    expect(numbers(deliveries)).not.toContain(orderNumber);
    expect(numbers(billings)).not.toContain(deliveryNumber);

    // The row carries the facts a reader needs without opening the document: who it is for, what it
    // is worth, and where it stands.
    const row = orders.rows.find((candidate) => candidate.documentNumber === orderNumber)!;
    expect(row.customerNumber).toBe(CUSTOMER);
    expect(row.customerName).toContain('Register test');
    expect(Number(row.netValue)).toBe(100);
    expect(row.documentType).toBe('OR');
    expect(row.documentDate).toBe(DATE);
    expect(row.status).toBe('OPEN');
    const billedRow = billings.rows.find((candidate) => candidate.documentNumber === billingNumber)!;
    expect(Number(billedRow.netValue)).toBe(100);
    expect(Number(billedRow.grossValue)).toBe(110);
  });

  it('a filter narrows what stands, and a filter that names nothing answers nothing', async () => {
    const { orderNumber, deliveryNumber, billingNumber } = await billed(3);

    for (const kind of ['ORDER', 'DELIVERY', 'BILLING'] as const) {
      const wanted = kind === 'ORDER' ? orderNumber
        : kind === 'DELIVERY' ? deliveryNumber : billingNumber;
      const register = await listDocumentRegister(tenant.client, { kind, filter: { documentNumber: wanted } });
      expect(numbers(register)).toEqual([wanted]);
      // The count is what stands, not what was handed back: one row answered, one document matched.
      expect(register.count).toBe(1);
      expect(register.truncated).toBe(false);
    }

    // Three filters that name something absent, and each answers an empty list rather than
    // everything — the failure a register has to be safe against, because a screen always sends
    // every box whether it was filled in or not.
    for (const filter of [
      { documentNumber: 'NOSUCHDOC' },
      { materialNumber: 'NOSUCHMAT' },
      { customerNumber: 'NOSUCHCUST' },
      { dateFrom: '2027-01-01', dateTo: '2027-12-31' },
    ]) {
      const register = await listDocumentRegister(tenant.client, { kind: 'ORDER', filter });
      expect(register.rows).toEqual([]);
      expect(register.count).toBe(0);
      expect(register.totals.netValue).toBeNull();
    }

    // The filter this fixture can actually exercise: the material and the plant stand on the line,
    // so a register filtered to them finds the order, and one filtered to a plant that holds
    // nothing finds none.
    expect(numbers(await listDocumentRegister(tenant.client, {
      kind: 'ORDER', filter: { materialNumber: MATERIAL, plant: PLANT },
    }))).toContain(orderNumber);
    expect(numbers(await listDocumentRegister(tenant.client, {
      kind: 'ORDER', filter: { plant: '9999' },
    }))).not.toContain(orderNumber);
  });

  it('the total is what the register answered, not what the table holds', async () => {
    // Three orders, of four, five and six units. Asked for one at a time, each totals its own value;
    // asked together with a limit of one, the register totals the one document it handed back and
    // says it was cut short. A total read off the table would have answered 375.00 for a list
    // containing a single row.
    const first = await ordered(4);
    const second = await ordered(5);
    const third = await ordered(6);

    const alone = await listDocumentRegister(tenant.client, {
      kind: 'ORDER', filter: { documentNumber: second.orderNumber },
    });
    expect(alone.rows).toHaveLength(1);
    expect(Number(alone.totals.netValue)).toBe(125);
    expect(alone.totals.documents).toBe(1);

    const cut = await listDocumentRegister(tenant.client, { kind: 'ORDER', limit: 1 });
    expect(cut.rows).toHaveLength(1);
    expect(cut.truncated).toBe(true);
    expect(cut.totals.documents).toBe(1);
    // What stands is more than what was answered, and the total belongs to what was answered.
    expect(cut.count).toBeGreaterThan(1);
    expect(Number(cut.totals.netValue)).toBe(Number(cut.rows[0].netValue));

    // Asked again without a filter, all three stand in the answer, because a filter that is not
    // filled in is not a filter.
    const standing = numbers(await listDocumentRegister(tenant.client, {
      kind: 'ORDER', filter: { customerNumber: CUSTOMER },
    }));
    for (const created of [first, second, third]) expect(standing).toContain(created.orderNumber);
  });

  it('the due lists are the services the screens ask, not a restatement of them', async () => {
    const created = await ordered(7);

    // Nothing has been delivered, so the order's line is deliverable.
    const before = await listDueRegister(tenant.client, {
      kind: 'DELIVERY', filter: { orderNumber: created.orderNumber },
    });
    expect(before.kind).toBe('DELIVERY');
    expect(before.rows).toHaveLength(1);

    const open = await listDeliverableOrderLines(tenant.client, { orderNumber: created.orderNumber });
    const built = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.orderNumber, deliveryDate: DATE,
      goodsMovementDate: DATE, headerText: 'Register fixture',
      items: [{ orderLineNumber: open[0].lineNumber, quantity: '7' }],
      requestKey: key('delivery'),
    });
    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: built.deliveryNumber,
      items: [{ lineNumber: 10, quantity: '7', storageLocation: STORE }],
    });
    const picked = await getDelivery(tenant.client, built.deliveryNumber);

    // A delivery that stands but has not gone out is not yet billable, and the order line is no
    // longer asking to be delivered.
    expect((await listDueRegister(tenant.client, {
      kind: 'DELIVERY', filter: { orderNumber: created.orderNumber },
    })).rows).toHaveLength(0);
    expect((await listDueRegister(tenant.client, {
      kind: 'BILLING', filter: { deliveryNumber: built.deliveryNumber },
    })).rows).toHaveLength(0);

    await postDeliveryGoodsIssue({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: built.deliveryNumber,
      expectedVersion: picked!.version, postingDate: DATE, documentDate: DATE,
    });

    // Gone out, and now it is the billing due list that names it.
    const due = await listDueRegister(tenant.client, {
      kind: 'BILLING', filter: { deliveryNumber: built.deliveryNumber },
    });
    expect(due.kind).toBe('BILLING');
    expect(due.rows).toHaveLength(1);
    // The same row the billing screen would have offered: the register says nothing of its own.
    const [billable] = await billDueList({
      client: tenant.client, changedBy: ACTOR, billingDate: DATE,
      selection: { deliveryNumber: built.deliveryNumber },
    }).then((result) => result.documents);
    expect(billable.billing.deliveryNumber).toBe(built.deliveryNumber);

    // Billed, and the queue is empty again — the register is reading the same queue the billing
    // screen reads, not a copy of it taken earlier.
    expect((await listDueRegister(tenant.client, {
      kind: 'BILLING', filter: { deliveryNumber: built.deliveryNumber },
    })).rows).toHaveLength(0);
  });

  it('what was undone is listed together, whatever kind of document it was', async () => {
    // A cancelled order, a cancelled delivery and a credit memo are three different documents in
    // three different tables, and the only thing they have in common is that they are the record of
    // something that was taken back. That is the one question this register asks.
    const cancelledOrder = await ordered(2);
    const standing = await getSalesOrder(tenant.client, cancelledOrder.orderNumber);
    await cancelSalesOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: cancelledOrder.orderNumber,
      expectedVersion: standing!.version, reason: 'Register fixture',
    });

    // A delivery that has gone out cannot be taken back, so the one cancelled here is left
    // standing; that is the only state a delivery can be cancelled from.
    const cancellable = await ordered(3);
    const openLines = await listDeliverableOrderLines(tenant.client, {
      orderNumber: cancellable.orderNumber,
    });
    const built = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: cancellable.orderNumber, deliveryDate: DATE,
      goodsMovementDate: DATE, headerText: 'Register fixture',
      items: [{ orderLineNumber: openLines[0].lineNumber, quantity: '3' }],
      requestKey: key('delivery'),
    });
    const issued = await getDelivery(tenant.client, built.deliveryNumber);
    await cancelDelivery({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: built.deliveryNumber,
      expectedVersion: issued!.version, reason: 'Register fixture',
    });

    const credited = await billed(4);
    await cancelBillingDocument({
      client: tenant.client, changedBy: ACTOR, billingNumber: credited.billingNumber, postingDate: DATE,
    });

    const undone = await listDocumentRegister(tenant.client, { kind: 'CANCELLATION' });
    const listed = numbers(undone);
    expect(listed).toContain(cancelledOrder.orderNumber);
    expect(listed).toContain(built.deliveryNumber);

    // The credit memo, and not the invoice it answers. The register lists what undid something, and
    // an invoice that was cancelled did not undo anything — it was undone.
    expect(listed).not.toContain(credited.billingNumber);
    const credit = undone.rows.find((row) => row.referenceNumber === credited.billingNumber)!;
    expect(credit).toBeTruthy();
    // It carries the invoice's value back: what was charged is what was given back.
    expect(Math.abs(Number(credit.netValue))).toBe(100);
    expect(Number(credit.netValue)).toBeLessThan(0);

    // A cancelled order still stands in the order register, and says so: a register that hid
    // cancelled documents would be a register you could not reconcile against.
    const orders = await listDocumentRegister(tenant.client, {
      kind: 'ORDER', filter: { documentNumber: cancelledOrder.orderNumber },
    });
    expect(orders.rows[0].status).toBe('CANCELLED');
  });

  it('returns are read where a tenant has them, and nowhere else', async () => {
    // No returns chain is configured, so the register answers nothing rather than everything. This
    // is the shape a tenant with no returns sees, and it has to be an empty list rather than an
    // error or a guess that any order with a negative quantity is a return.
    const empty = await listDocumentRegister(tenant.client, { kind: 'RETURNS' });
    expect(empty.kind).toBe('RETURNS');
    expect(empty.rows).toEqual([]);
    expect(empty.count).toBe(0);
    expect(empty.totals.netValue).toBeNull();
  });

  it('the filter boxes are filled from what the tenant has', async () => {
    const choices = await listRegisterChoices(tenant.client);
    expect(choices.customers.map((row) => row.partnerNumber)).toContain(CUSTOMER);
    expect(choices.materials.map((row) => row.materialNumber)).toContain(MATERIAL);
    expect(choices.plants.map((row) => row.plant)).toContain(PLANT);
    expect(choices.salesOrgs.map((row) => row.salesOrg)).toContain('1000');
    expect(choices.documentTypes.map((row) => row.documentType)).toContain('OR');
    // One row per value, so a dropdown does not offer the same sales organisation twice because
    // three sales areas are maintained under it.
    expect(new Set(choices.salesOrgs.map((row) => row.salesOrg)).size)
      .toBe(choices.salesOrgs.length);
    expect(choices.statuses).toContain('CANCELLED');
  });
});
