import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { checkSalesDocumentCredit, releaseDocument, saveCustomerCredit } from '../src/modules/finance/credit';
import { reverseMaterialDocument } from '../src/modules/inventory/material-document-reversal';
import { getCustomerInvoice } from '../src/modules/finance/customer-invoice';
import {
  cancelBillingDocument,
  createBillingFromDelivery,
  getBilling,
  postBillingDocument,
} from '../src/modules/sales/billing';
import {
  DeliveryError,
  cancelDelivery,
  confirmDeliveryPicks,
  createDelivery,
  getDelivery,
  listDeliverableOrderLines,
  postDeliveryGoodsIssue,
} from '../src/modules/sales/delivery';
import {
  SalesOrderError,
  cancelSalesOrder,
  changeSalesOrder,
  createSalesOrder,
  getSalesOrder,
  releaseSalesOrderCredit,
} from '../src/modules/sales/sales-order';
import { saveSalesCondition } from '../src/modules/sales/conditions';
import {
  assignSalesAreaDimensions,
  createTenant,
  defineTestRanges,
  destroyTenant,
  type TestTenant,
} from './helpers';

/**
 * DI-020 — the order-to-invoice chain on the services that own it.
 *
 * Nothing here is mocked: the delivery, the pick, the movement, the material document, the journal, the stock
 * and the receivable are all written by the engines the screens call, and every assertion is read back from the
 * tables those engines keep. The five checks the deferred issue names are each in this file: the reversal of a
 * customer goods issue is the one movement that undoes it and it stands once; a delivered quantity is billed
 * once; a credit determination refuses at delivery creation and holds the invoice at billing; and an order line
 * the chain has drawn on cannot be rewritten underneath it.
 */
const ACTOR = 'SD9191_FULFIL_TEST';
const AREA = 'CCA1';
const CUSTOMER = 'SD9191CUST1';
const EXPOSED_CUSTOMER = 'SD9191CUST2';
const MATERIAL = 'SD9191MAT1';
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
const key = (what: string) => `sd9191-${what}-${++counter}`;

async function stateOf(client: string, materialDocumentNumber: string | null, journal: string | null) {
  return withTenant(client, async (tx) => {
    const stock = await tx.execute(sql`
      select quantity::text as q from stock_quantity
      where client = ${client} and material_number = ${MATERIAL} and plant = ${PLANT}
        and storage_location = ${STORE} and stock_type = 'UNRESTRICTED'
    `) as unknown as Array<{ q: string }>;
    const valuation = await tx.execute(sql`
      select total_stock_quantity::text as q, stock_value::text as v, moving_average_price::text as map
        from material_valuation where client = ${client} and material_number = ${MATERIAL} and valuation_area = ${PLANT}
    `) as unknown as Array<{ q: string; v: string; map: string }>;
    const journalLines = journal ? await tx.execute(sql`
      select gl_account, debit_credit, amount_local::text as amount
        from journal_entry_line where client = ${client} and document_number = ${journal}
       order by line_number
    `) as unknown as Array<{ gl_account: string; debit_credit: string; amount: string }> : [];
    const movement = materialDocumentNumber ? await tx.execute(sql`
      select ml.movement_type, ml.base_quantity::text as quantity, ml.reversal_of_document, ml.reversal_of_line,
             h.status as header_status
        from material_document_line ml
        join material_document h on h.client = ml.client and h.material_document_number = ml.material_document_number
       where ml.client = ${client} and ml.material_document_number = ${materialDocumentNumber}
       order by ml.line_number
    `) as unknown as Array<{
      movement_type: string; quantity: string; reversal_of_document: string | null;
      reversal_of_line: number | null; header_status: string;
    }> : [];
    return { stock: Number(stock[0]?.q ?? '0'), valuation: valuation[0], journalLines, movement };
  });
}

describe('sales fulfillment and billing (DI-020)', () => {
  let tenant: TestTenant;
  let order = '';
  let orderVersion = 1;
  let delivery = '';
  let deliveryVersion = 1;
  let materialDocument = '';
  let billing = '';

  beforeAll(async () => {
    tenant = await createTenant('sd9191-delivery-billing');
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
      for (const partner of [CUSTOMER, EXPOSED_CUSTOMER]) {
        await tx.execute(sql`
          insert into business_partner (client, partner_number, category, name, created_by)
          values (${tenant.client}, ${partner}, 'ORGANIZATION', ${`Test customer ${partner}`}, ${ACTOR}) on conflict do nothing
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
          values (${tenant.client}, ${partner}, 'CUSTOMER', '1000', 'CA01', '110000', 'NET30', ${ACTOR})
          on conflict do nothing
        `);
      }
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${tenant.client}, ${MATERIAL}, 'Fulfilled test material', 'RAW', 'UNT', ${ACTOR}) on conflict do nothing
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
      await tx.execute(sql`
        insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                             previous_fiscal_year, previous_period, allow_backposting, created_by)
        values (${tenant.client}, '1000', 2026, 10, 2026, 9, true, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
        values (${tenant.client}, 'KW', 'T10', 'Output tax 10 percent', 'VAT', 10, ${ACTOR}) on conflict do nothing
      `);
      // The accounts the movement and the receivable post through. The chart the company code carries is the
      // standard one, so only the two sales-specific accounts have to be added to it.
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
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      customerNumber: '', materialNumber: MATERIAL, currency: 'USD', amount: 25, priceUnit: 1,
      validityFrom: '2026-01-01', validityTo: '2026-12-31', supersedeStanding: false,
    });
    await saveCustomerCredit({
      client: tenant.client, changedBy: ACTOR, customer: CUSTOMER, creditControlArea: AREA,
      creditLimit: '1000000.00', riskCategory: 'A', isBlocked: false, changeReason: 'Test fixture credit data.',
    });
    await saveCustomerCredit({
      client: tenant.client, changedBy: ACTOR, customer: EXPOSED_CUSTOMER, creditControlArea: AREA,
      creditLimit: '1.00', riskCategory: 'A', isBlocked: false, changeReason: 'Test fixture credit data.',
    });
  });

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
  });

  it('carries the order line into the delivery: reference, unit, ordered, already delivered and open', async () => {
    const created = await createSalesOrder({
      ...base, requestKey: key('order'),
      lines: [{ lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT, orderQuantity: 6, quantityUnit: 'UNT', taxCode: 'T10' }],
    });
    order = created.orderNumber;
    // The column is numeric(23,4): the figure is asserted as money, not as a string of one shape.
    expect(Number(created.lines[0].netAmount)).toBe(150);

    // The open quantity the delivery may draw on, read from the order.
    const open = await listDeliverableOrderLines(tenant.client, { orderNumber: order });
    expect(open).toHaveLength(1);
    expect(open[0].orderNumber).toBe(order);
    expect(open[0].materialNumber).toBe(MATERIAL);
    expect(open[0].quantityUnit.trim()).toBe('UNT');
    expect(open[0].orderedQuantity).toBe('6.000');
    expect(open[0].deliveredQuantity).toBe('0.000');
    expect(open[0].remainingQuantity).toBe('6.000');

    const submission = key('delivery');
    const built = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: order, deliveryDate: DATE,
      goodsMovementDate: DATE, headerText: 'Partial shipment of the test order',
      items: [{ orderLineNumber: open[0].lineNumber, quantity: '4' }],
      requestKey: submission,
    });
    delivery = built.deliveryNumber;
    deliveryVersion = built.version;
    expect(built.replayed).toBe(false);
    expect(delivery).toMatch(/^DL-\d+$/);
    expect(built.status).toBe('OPEN');
    const line = built.lines[0];
    expect(line.orderLineNumber).toBe(10);
    expect(line.materialNumber).toBe(MATERIAL);
    expect(line.plant).toBe(PLANT);
    expect(line.quantityUnit.trim()).toBe('UNT');
    expect(line.orderedQuantity).toBe('6.000');
    expect(line.deliveredBefore).toBe('0.000');
    expect(line.deliveryQuantity).toBe('4.000');
    expect(line.remainingQuantity).toBe('2.000');
    expect(line.pickedQuantity).toBe('0.000');
    expect(built.value).toBe('110.00');
    // The delivery has no movement yet, and it says so.
    expect(built.materialDocumentNumber).toBeNull();

    // The same submission again is a replay, not a second document.
    const replay = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: order, deliveryDate: DATE,
      items: [{ orderLineNumber: 10, quantity: '4' }], requestKey: submission,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.deliveryNumber).toBe(delivery);
  });

  it('refuses more than the order line has open, an item twice, and a delivery that ships nothing', async () => {
    // And a delivery that has not gone out earns no invoice.
    await expect(createBillingFromDelivery({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: delivery, billingDate: DATE,
      requestKey: key('early-bill'),
    })).rejects.toThrow(/only a goods-issued delivery earns an invoice/);
    // 4 of the 6 are already on the standing delivery, so only 2 remain.
    const over = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: order, deliveryDate: DATE,
      items: [{ orderLineNumber: 10, quantity: '3' }], requestKey: key('over'),
    }).then(() => null, (error: unknown) => error);
    expect(over).toBeInstanceOf(DeliveryError);
    expect((over as DeliveryError).message).toMatch(/carries 2\.000 UNT open of 6\.000 ordered, and 3 was entered/);
    // The screen shows this sentence next to the refusal, so it has to be a remedy and not a stack trace.
    expect((over as DeliveryError).remedy).toMatch(/Reduce the quantity/);

    await expect(createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: order, deliveryDate: DATE,
      items: [{ orderLineNumber: 10, quantity: '1' }, { orderLineNumber: 10, quantity: '1' }], requestKey: key('twice'),
    })).rejects.toThrow(/was named twice/);

    await expect(createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: order, deliveryDate: DATE,
      items: [{ orderLineNumber: 90, quantity: '1' }], requestKey: key('missing'),
    })).rejects.toThrow(/carries no item 90/);

    // A quantity the unit cannot carry is refused at the delivery, exactly as at the order.
    await expect(createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: order, deliveryDate: DATE,
      items: [{ orderLineNumber: 10, quantity: '0.5' }], requestKey: key('scale'),
    })).rejects.toThrow(/unit UNT is maintained to 0 decimals/);
  });

  it('picks against the delivery and never beyond it', async () => {
    await expect(confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: delivery,
      items: [{ lineNumber: 10, quantity: '5', storageLocation: STORE }], requestKey: key('over-pick'),
    })).rejects.toThrow(/would confirm more than the delivery owes/);

    // A pick that names no store has nothing to post from: the movement would have to guess.
    await expect(confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: delivery,
      items: [{ lineNumber: 10, quantity: '4' }], requestKey: key('no-store'),
    })).rejects.toThrow(/name the storage location the goods are picked from/);

    // Two confirmations of 2 build the 4 the delivery owes, a wrong one is answered by its own negative,
    // and the corrected quantity is confirmed again. The history keeps all four rows.
    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: delivery,
      items: [{ lineNumber: 10, quantity: '2', storageLocation: STORE }], requestKey: key('pick-1'),
    });
    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: delivery,
      items: [{ lineNumber: 10, quantity: '2', storageLocation: STORE }], requestKey: key('pick-2'),
    });
    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: delivery,
      items: [{ lineNumber: 10, quantity: '-4', storageLocation: STORE, reason: 'Wrong store taken' }],
      requestKey: key('pick-wrong'),
    });
    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: delivery,
      items: [{ lineNumber: 10, quantity: '4', storageLocation: STORE }], requestKey: key('pick-right'),
    });

    // A correction of a pick that stands has to say why, because the history is append-only.
    await expect(confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: delivery,
      items: [{ lineNumber: 10, quantity: '-1' }], requestKey: key('silent-correction'),
    })).rejects.toThrow(/a correction to a pick has to say why/);

    const view = await getDelivery(tenant.client, delivery);
    expect(view!.status).toBe('PICKED');
    expect(view!.lines[0].pickedQuantity).toBe('4.000');
    expect(view!.lines[0].picks.map((pick) => pick.quantityDelta)).toEqual(['2.000', '2.000', '-4.000', '4.000']);
    expect(view!.lines[0].picks[2].reason).toBe('Wrong store taken');
    expect(view!.lines[0].picks[2].storageLocation).toBe(STORE);
  });

  it('refuses a goods issue while the pick is incomplete, and posts one once it is', async () => {
    const partial = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: order, deliveryDate: DATE,
      items: [{ orderLineNumber: 10, quantity: '1' }], requestKey: key('partial'),
    });
    const partialNumber = partial.deliveryNumber;
    await expect(postDeliveryGoodsIssue({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: partialNumber,
      expectedVersion: partial.version, postingDate: DATE,
    })).rejects.toThrow(/only a fully picked delivery can be goods-issued/);

    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: partialNumber,
      items: [{ lineNumber: 10, quantity: '1', storageLocation: STORE }], requestKey: key('partial-pick'),
    });
    await expect(postDeliveryGoodsIssue({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: partialNumber,
      expectedVersion: 99, postingDate: DATE,
    })).rejects.toThrow(/changed since it was read/);

    // The stock the movement needs is the shelf's own answer — nothing is invented to make it fit.
    const before = await stateOf(tenant.client, null, null);
    expect(before.stock).toBe(100);

    // The version the pick confirmations left behind, not the one the delivery was created at: the movement
    // is posted against the document as it now stands.
    const standing = await getDelivery(tenant.client, delivery);
    expect(standing!.version).toBeGreaterThan(deliveryVersion);
    const posted = await postDeliveryGoodsIssue({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: delivery,
      expectedVersion: standing!.version, postingDate: DATE,
    });
    materialDocument = posted.materialDocumentNumber;
    expect(materialDocument).toMatch(/^MD-/);
    expect(posted.totalValue).toBe('40.00');
    expect(posted.creditBlockedForBilling).toBe(false);

    const issued = await getDelivery(tenant.client, delivery);
    expect(issued!.status).toBe('GOODS_ISSUED');
    expect(issued!.lines[0].goodsIssueQuantity).toBe('4.000');
    expect(issued!.materialDocumentNumber).toBe(materialDocument);
    expect(issued!.materialDocumentYear).toBe(2026);

    // Stock, valuation and the journal moved exactly once, for the picked quantity.
    const after = await stateOf(tenant.client, materialDocument, posted.journalDocumentNumber);
    expect(after.stock).toBe(96);
    expect(Number(after.valuation!.q)).toBe(96);
    expect(Number(after.valuation!.v)).toBe(960);
    expect(after.journalLines.map((row) => `${row.gl_account}:${row.debit_credit}:${row.amount}`)).toEqual([
      '120000:H:40.0000', '510300:S:40.0000',
    ]);
    expect(after.movement.map((row) => `${row.movement_type}:${row.quantity}`)).toEqual(['GI_CUSTOMER:4.000']);

    // A second goods issue of the same delivery is refused, and the movement is not taken twice.
    await expect(postDeliveryGoodsIssue({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: delivery,
      expectedVersion: issued!.version, postingDate: DATE,
    })).rejects.toThrow(/was already goods-issued with material document/);
    const again = await stateOf(tenant.client, materialDocument, null);
    expect(again.stock).toBe(96);

    // The picked delivery is no longer cancellable, and its pick is settled.
    await expect(cancelDelivery({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: delivery,
      expectedVersion: issued!.version, reason: 'A1',
    })).rejects.toThrow(/is goods-issued under material document/);
    await expect(confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: delivery,
      items: [{ lineNumber: 10, quantity: '1', storageLocation: STORE }], requestKey: key('late-pick'),
    })).rejects.toThrow(/is goods-issued/);

    // The order line keeps only what the chain has not already taken. A picked delivery holds its quantity even
    // before its movement posts, so the 1 unit on the second delivery counts here too — it is committed, and
    // nothing may promise it to a third document.
    const open = await listDeliverableOrderLines(tenant.client, { orderNumber: order });
    expect(open[0].deliveredQuantity).toBe('5.000');
    expect(open[0].remainingQuantity).toBe('1.000');

    // And the partial delivery stands as its own document, open and unposted.
    const other = await getDelivery(tenant.client, partialNumber);
    expect(other!.status).toBe('PICKED');
    expect(other!.materialDocumentNumber).toBeNull();
    await cancelDelivery({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: partialNumber,
      expectedVersion: other!.version, reason: 'A1',
    });
    const cancelled = await getDelivery(tenant.client, partialNumber);
    expect(cancelled!.status).toBe('CANCELLED');
    // A cancelled delivery does not hold the order line any more.
    const reopened = await listDeliverableOrderLines(tenant.client, { orderNumber: order });
    expect(reopened[0].remainingQuantity).toBe('2.000');
  });

  it('bills the goods-issued quantity once, priced from the order line and its condition record', async () => {
    const result = await postBillingDocument({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: delivery, billingDate: DATE,
      requestKey: key('bill'),
    });
    billing = result.billing.billingNumber;
    expect(billing).toMatch(/^INV-\d+$/);
    expect(result.posted).toBe(true);
    expect(result.heldForCredit).toBe(false);
    expect(result.billing.status).toBe('POSTED');
    expect(result.billing.lines).toHaveLength(1);
    const line = result.billing.lines[0];
    expect(line.billingQuantity).toBe('4.000');
    expect(line.netPrice).toBe('25.0000');
    expect(line.priceUnit).toBe(1);
    expect(Number(line.netAmount)).toBe(100);
    expect(line.taxCode).toBe('T10');
    expect(Number(line.taxAmount)).toBe(10);
    // The provenance the order established survives the whole chain.
    const orderView = await getSalesOrder(tenant.client, order);
    expect(line.conditionNumber).toBe(orderView!.lines[0].conditionNumber);
    expect(Number(result.billing.netValue)).toBe(100);
    expect(Number(result.billing.grossValue)).toBe(110);
    expect(result.invoice).not.toBeNull();
    expect(Number(result.invoice!.grossAmount)).toBe(110);
    expect(result.billing.customerInvoiceNumber).toBe(result.invoice!.invoiceNumber);
    expect(result.billing.journalDocumentNumber).toBe(result.invoice!.journalDocumentNumber);

    // One receivable, and it is the customer's own open item.
    const openItem = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select je.document_number, jl.gl_account, jl.debit_credit, jl.amount_local::text as amount, jl.business_partner
        from journal_entry_line jl join journal_entry je
          on je.client = jl.client and je.document_number = jl.document_number and je.fiscal_year = jl.fiscal_year
       where jl.client = ${tenant.client} and je.document_number = ${result.invoice!.journalDocumentNumber}
         and jl.gl_account = '110000'
    `) as unknown as Array<{ document_number: string; gl_account: string; debit_credit: string; amount: string; business_partner: string }>);
    expect(openItem).toHaveLength(1);
    expect(openItem[0]).toMatchObject({ debit_credit: 'S', amount: '110.0000', business_partner: CUSTOMER });

    // The delivery is billed, so the strict entry point refuses a second document, and the screen's button
    // answers with the standing one instead of drawing another number: a repeat is a replay, never a second
    // receivable.
    await expect(createBillingFromDelivery({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: delivery, billingDate: DATE,
      requestKey: key('bill-again'),
    })).rejects.toThrow(new RegExp(`is already billed as ${billing}`));
    const repeat = await postBillingDocument({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: delivery, billingDate: DATE,
      requestKey: key('bill-repeat'),
    });
    expect(repeat.replayed).toBe(true);
    expect(repeat.posted).toBe(true);
    expect(repeat.billing.billingNumber).toBe(billing);
    const counted = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select count(*)::int as n from billing_document where client = ${tenant.client} and delivery_number = ${delivery}
    `) as unknown as Array<{ n: number }>);
    expect(counted[0].n).toBe(1);
    const held = await getBilling(tenant.client, billing);
    expect(held!.status).toBe('POSTED');
    // The delivery's own determination passed, and the view says so rather than hiding it.
    expect(held!.credit?.status).toBe('PASSED');
  });

  it('reverses a customer goods issue with the one movement that undoes it, once', async () => {
    const partial = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: order, deliveryDate: DATE,
      items: [{ orderLineNumber: 10, quantity: '2' }], requestKey: key('to-reverse'),
    });
    const number = partial.deliveryNumber;
    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: number,
      items: [{ lineNumber: 10, quantity: '2', storageLocation: STORE }], requestKey: key('reverse-pick'),
    });
    const issued = await postDeliveryGoodsIssue({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: number,
      // The confirmation moved the document on; the movement is posted against the version it now carries.
      expectedVersion: (await getDelivery(tenant.client, number))!.version, postingDate: DATE,
    });
    expect(await stateOf(tenant.client, null, null)).toMatchObject({ stock: 94 });

    const reversal = await reverseMaterialDocument({
      client: tenant.client, changedBy: ACTOR, materialDocumentNumber: issued.materialDocumentNumber,
      fiscalYear: issued.materialDocumentYear, postingDate: DATE, documentDate: DATE,
      // The material document keeps a 25-character header, and the reversal service enforces it.
      headerText: 'Shipment withdrawn', requestKey: key('reverse'),
    });
    expect(reversal.materialDocumentNumber).not.toBe(issued.materialDocumentNumber);
    const reversed = await stateOf(tenant.client, reversal.materialDocumentNumber, null);
    expect(reversed.stock).toBe(96);
    expect(reversed.movement.map((row) => `${row.movement_type}:${row.quantity}`)).toEqual(['GI_CUSTOMER_REVERSAL:2.000']);

    // A line is reversed once: the second attempt is refused, and the stock does not swing back a second time.
    await expect(reverseMaterialDocument({
      client: tenant.client, changedBy: ACTOR, materialDocumentNumber: issued.materialDocumentNumber,
      fiscalYear: issued.materialDocumentYear, postingDate: DATE, documentDate: DATE, requestKey: key('twice'),
    })).rejects.toThrow(/already been (cancelled|reversed)/);
    expect(await stateOf(tenant.client, null, null)).toMatchObject({ stock: 96 });

    // A reversed issue is not a delivered quantity, so the delivery it shipped cannot be billed.
    await expect(createBillingFromDelivery({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: number, billingDate: DATE,
      requestKey: key('bill-reversed'),
    })).rejects.toThrow(/has been reversed/);
  });

  it('refuses a delivery, a pick and a goods issue on a blocked document, and holds the invoice', async () => {
    const blocked = await createSalesOrder({
      ...base, customerNumber: EXPOSED_CUSTOMER, requestKey: key('exposed'),
      lines: [{ lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT, orderQuantity: 6, quantityUnit: 'UNT', taxCode: 'T10' }],
    });
    expect(blocked.credit?.status).toBe('BLOCKED');
    expect(blocked.credit?.reason).toMatch(/limit|manual hold|block/i);

    // §14.8's first three check points, in one sentence: nothing is created against a blocked order.
    await expect(createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: blocked.orderNumber, deliveryDate: DATE,
      items: [{ orderLineNumber: 10, quantity: '4' }], requestKey: key('blocked-delivery'),
    })).rejects.toThrow(/is credit-blocked.*: nothing was delivered/);

    const refused = await releaseSalesOrderCredit({
      client: tenant.client, changedBy: ACTOR, orderNumber: blocked.orderNumber, canOverride: false,
    });
    expect(refused.ok).toBe(false);
    const released = await releaseSalesOrderCredit({
      client: tenant.client, changedBy: ACTOR, orderNumber: blocked.orderNumber,
      canOverride: true, justification: 'Settlement received this morning.', approvalRef: 'CFO-9191',
    });
    expect(released.ok).toBe(true);

    // A released order delivers — and the delivery is judged on its own, so a fresh breach blocks it again.
    const built = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: blocked.orderNumber, deliveryDate: DATE,
      items: [{ orderLineNumber: 10, quantity: '4' }], requestKey: key('released-delivery'),
    });
    const number = built.deliveryNumber;
    expect(built.status).toBe('OPEN');
    expect(built.credit?.status).toBe('BLOCKED');

    // The pick readies a posting, so a block stands in its way too.
    await expect(confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: number,
      items: [{ lineNumber: 10, quantity: '4', storageLocation: STORE }], requestKey: key('block-pick'),
    })).rejects.toThrow(/is credit-blocked.*: nothing was picked/);

    const allowed = await releaseDocument({
      client: tenant.client, changedBy: ACTOR, salesDocument: number, canOverride: true,
      override: { justification: 'Credit committee cleared the shipment.', approvalRef: 'CFO-9191-A' },
    });
    expect(allowed.status).toBe('RELEASED');
    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: number,
      items: [{ lineNumber: 10, quantity: '4', storageLocation: STORE }], requestKey: key('pick-after-release'),
    });
    expect((await getDelivery(tenant.client, number))!.status).toBe('PICKED');

    // A block raised again after the pick holds the shipment itself: the movement is not posted around it.
    await checkSalesDocumentCredit({
      client: tenant.client, changedBy: ACTOR, salesDocument: number, documentDate: DATE,
      salesOrg: '1000', customer: EXPOSED_CUSTOMER, creditControlArea: AREA,
      orderValue: '999.00', orderCurrency: 'USD',
    });
    await expect(postDeliveryGoodsIssue({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: number,
      expectedVersion: (await getDelivery(tenant.client, number))!.version, postingDate: DATE,
    })).rejects.toThrow(/is credit-blocked.*: nothing was issued/);
    expect((await stateOf(tenant.client, null, null)).stock).toBe(96);

    // Once released, the movement posts; the breach it causes then holds the receivable, never the stock.
    await releaseDocument({
      client: tenant.client, changedBy: ACTOR, salesDocument: number, canOverride: true,
      override: { justification: 'Same committee, the shipment is going out.', approvalRef: 'CFO-9191-C' },
    });
    const issue = await postDeliveryGoodsIssue({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: number,
      expectedVersion: (await getDelivery(tenant.client, number))!.version, postingDate: DATE,
    });
    expect(issue.delivery.status).toBe('GOODS_ISSUED');
    expect(issue.creditBlockedForBilling).toBe(true);
    expect((await stateOf(tenant.client, issue.materialDocumentNumber, null)).stock).toBe(92);

    const held = await postBillingDocument({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: number, billingDate: DATE,
      requestKey: key('hold-bill'),
    });
    expect(held.heldForCredit).toBe(true);
    expect(held.posted).toBe(false);
    expect(held.billing.status).toBe('OPEN');
    expect(held.billing.customerInvoiceNumber).toBeNull();
    expect(held.billing.credit?.status).toBe('BLOCKED');
    expect(held.billing.credit?.blockReason).toMatch(/limit|manual hold|block/i);
    expect(await getBilling(tenant.client, held.billing.billingNumber)).not.toBeNull();

    // A second submission while the block stands repeats the hold; it does not post behind the block.
    const again = await postBillingDocument({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: number, billingDate: DATE,
      requestKey: key('hold-bill-2'),
    });
    // Re-submitting under a block repeats the refusal; it is not a replay of a finished act.
    expect(again.heldForCredit).toBe(true);
    expect(again.replayed).toBe(false);
    expect(again.posted).toBe(false);
    expect(again.billing.billingNumber).toBe(held.billing.billingNumber);

    // The release is the act that lets the held document post, and the same document posts — not a second one.
    const allow = await releaseDocument({
      client: tenant.client, changedBy: ACTOR, salesDocument: number, canOverride: true,
      override: { justification: 'Credit committee cleared the account.', approvalRef: 'CFO-9191-B' },
    });
    expect(allow.status).toBe('RELEASED');
    const posted = await postBillingDocument({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: number, billingDate: DATE,
      requestKey: key('post-after-release'),
    });
    expect(posted.billing.billingNumber).toBe(held.billing.billingNumber);
    expect(posted.posted).toBe(true);
    expect(posted.billing.status).toBe('POSTED');
    expect(posted.billing.customerInvoiceNumber).toMatch(/^CI-\d+$/);
    // One receivable for the whole shipment, and it is the billing document's own.
    const invoices = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select count(*)::text as n from billing_document where client = ${tenant.client} and delivery_number = ${number}
    `) as unknown as Array<{ n: string }>);
    expect(invoices[0].n).toBe('1');
  });

  it('refuses to rewrite an order line the chain has drawn on, or to cancel under a delivery', async () => {
    const view = await getSalesOrder(tenant.client, order);
    orderVersion = view!.version;
    expect(view!.lines[0].orderQuantity).toBe('6.000');

    // Dropping the delivered item is a refusal, not a deletion — and it is the order service's own error.
    // The change submits a new item and says nothing about item 10: neither submitted nor rejected, which is
    // exactly the silence the guard refuses — and it refuses it because the item has been delivered, not
    // because the change forgot it.
    const dropped = await changeSalesOrder({
      ...base, orderNumber: order, expectedVersion: orderVersion, requestKey: key('drop'),
      lines: [{ lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT, orderQuantity: 1, quantityUnit: 'UNT' }],
      rejectLines: [],
    }).then(() => null, (error: unknown) => error);
    expect(dropped).toBeInstanceOf(SalesOrderError);
    expect((dropped as SalesOrderError).message)
      .toMatch(/delivered on it, so it cannot be dropped from the order or rejected/);

    // The ordered quantity and the material of a delivered item are frozen.
    await expect(changeSalesOrder({
      ...base, orderNumber: order, expectedVersion: orderVersion, requestKey: key('reduce'),
      lines: [{ lineNumber: 10, materialNumber: MATERIAL, plant: PLANT, orderQuantity: 4, quantityUnit: 'UNT', taxCode: 'T10' }],
      rejectLines: [],
    })).rejects.toThrow(/its material and its ordered quantity are frozen/);

    // The new item is still allowed: an extension does not disturb what has gone out.
    const extended = await changeSalesOrder({
      ...base, orderNumber: order, expectedVersion: orderVersion, requestKey: key('extend'),
      lines: [
        { lineNumber: 10, materialNumber: MATERIAL, plant: PLANT, orderQuantity: 6, quantityUnit: 'UNT', taxCode: 'T10' },
        { lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT, orderQuantity: 1, quantityUnit: 'UNT', taxCode: 'T10' },
      ],
      rejectLines: [],
    });
    expect(extended.lines).toHaveLength(2);
    expect(Number(extended.netValue)).toBe(175);

    await expect(cancelSalesOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: order,
      expectedVersion: extended.version, reason: 'The customer withdrew the order',
    })).rejects.toThrow(/cannot be cancelled while it is being fulfilled: delivery/);
  });

  it('cancels a billing document by mirroring the receivable it raised', async () => {
    const cancelled = await cancelBillingDocument({
      client: tenant.client, changedBy: ACTOR, billingNumber: billing, postingDate: DATE,
      reason: 'Priced against the wrong contract', requestKey: key('cancel-bill'),
    });
    expect(cancelled.billing.status).toBe('CANCELLED');
    // The view the cancellation answers with is the mirror document it posted; the receivable leaves the
    // account through it, and the original stands CANCELLED with its mirror named on it.
    expect(cancelled.invoice).not.toBeNull();
    expect(cancelled.invoice!.status).toBe('POSTED');
    const billed = await getBilling(tenant.client, billing);
    expect(billed!.status).toBe('CANCELLED');
    expect(billed!.customerInvoiceNumber).not.toBeNull();
    const original = await getCustomerInvoice(tenant.client, billed!.customerInvoiceNumber!);
    expect(original!.status).toBe('CANCELLED');
    expect(original!.cancelledBy).toBe(cancelled.invoice!.invoiceNumber);

    // The row stays behind so the chain remembers it.
    // Re-billing the delivery answers with the cancelled document by name and points at the memo path: the
    // screen's button cannot quietly draw a second invoice behind a cancellation.
    await expect(postBillingDocument({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: delivery, billingDate: DATE,
      requestKey: key('rebilled'),
    })).rejects.toThrow(new RegExp(`Billing document ${billing} stands CANCELLED`));
    await expect(createBillingFromDelivery({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: delivery, billingDate: DATE,
      requestKey: key('rebilled-strict'),
    })).rejects.toThrow(new RegExp(`is already billed as ${billing}`));
  });
});
