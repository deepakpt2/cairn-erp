import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveCustomerCredit } from '../src/modules/finance/credit';
import { saveSalesCondition } from '../src/modules/sales/conditions';
import {
  assignIncompletionProcedure, blockedFor, listIncompleteDocuments, readIncompletion,
  saveIncompletionProcedure, saveIncompletionProcedureField, saveIncompletionStatusGroup,
  withdrawIncompletionAssignment,
} from '../src/modules/sales/incompletion';
import {
  changeSalesOrder, createSalesOrder, getSalesOrder,
} from '../src/modules/sales/sales-order';
import {
  confirmDeliveryPicks, createDelivery, getDelivery, listDeliverableOrderLines,
  postDeliveryGoodsIssue,
} from '../src/modules/sales/delivery';
import { billingDueList, postBillingDocument } from '../src/modules/sales/billing';
import { listInbox } from '../src/platform/notification/notify';
import { assignSalesAreaDimensions, createTenant, destroyTenant, maintainMaterialSales, sql, type TestTenant } from './helpers';
import { createSalesActor, refreshSalesActor, type SalesActor } from './helpers/sales-actor';

const ACTOR = 'SD9255_INCOMPLETION_TEST';
const AREA = 'CCA1';
const CUSTOMER = 'SD9255CUST1';
const MATERIAL = 'SD9255MAT1';
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

/**
 * The incompletion procedure and the log it writes (§5.1, SAP's OVA2 and VBUV).
 *
 * The property worth protecting is the one the whole increment rests on: a document raised before
 * this is configured is not judged at all, and a document raised after is judged only by the fields
 * a tenant named. Everything here is either that, or the consequence a tenant chose — the named
 * function that stops, and the one that does not.
 */

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

describe('the incompletion procedure and the log it writes', () => {
  let tenant: TestTenant;
  let counter = 0;
  const key = (what: string) => `sd9255-${what}-${++counter}`;

  beforeAll(async () => {
    tenant = await createTenant('sd9255-incompletion');
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
        values (${tenant.client}, ${CUSTOMER}, 'ORGANIZATION', 'Incompletion test customer', ${ACTOR})
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
        values (${tenant.client}, ${MATERIAL}, 'Incompletion test material', 'RAW', 'UNT', ${ACTOR})
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
        values (${tenant.client}, 'MD-INC001', 2026, ${DATE}, ${DATE}, 'Opening balance', 'POSTED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (client, material_document_number, line_number, movement_type,
                                            material_number, plant, storage_location, stock_type,
                                            line_direction, entry_quantity, entry_unit, base_quantity,
                                            base_unit, created_by)
        values (${tenant.client}, 'MD-INC001', 1, 'OPENING_BALANCE', ${MATERIAL}, ${PLANT}, ${STORE},
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
    const area = { salesOrg: '1000', distributionChannel: '10', division: '01' };
    const period = { validityFrom: '2026-01-01', validityTo: '2026-12-31', supersedeStanding: false };
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, ...area, customerNumber: CUSTOMER, materialNumber: MATERIAL,
      currency: 'USD', amount: 25, priceUnit: 1, ...period,
    });
    await saveCustomerCredit({
      client: tenant.client, changedBy: ACTOR, customer: CUSTOMER, creditControlArea: AREA,
      creditLimit: '1000000.00', riskCategory: 'A', isBlocked: false,
      changeReason: 'Incompletion test credit data.',
    });
  });

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
  });

  /** Order units, deliver and issue them, and hand back the whole chain. */
  async function chain(label: string, ordered: number, shipped: number) {
    const placed = await createSalesOrder({
      ...base, requestKey: key(`${label}-order`),
      lines: [{
        lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: ordered, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    }, { authorization: await salesAuthority(tenant.client) });
    const open = await listDeliverableOrderLines(tenant.client, { orderNumber: placed.orderNumber });
    const delivery = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: placed.orderNumber, deliveryDate: DATE,
      items: [{ orderLineNumber: open[0].lineNumber, quantity: String(shipped) }],
      requestKey: key(`${label}-delivery`),
    }, { authorization: await salesAuthority(tenant.client) });
    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: delivery.deliveryNumber,
      items: [{ lineNumber: 10, quantity: String(shipped), storageLocation: STORE }],
      requestKey: key(`${label}-pick`),
    });
    const standing = await getDelivery(tenant.client, delivery.deliveryNumber);
    await postDeliveryGoodsIssue({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: delivery.deliveryNumber,
      expectedVersion: standing!.version, postingDate: DATE,
    }, { authorization: await salesAuthority(tenant.client) });
    return { orderNumber: placed.orderNumber, deliveryNumber: delivery.deliveryNumber };
  }

  it('judges nothing at all until a tenant says what a complete document is', async () => {
    // The promise the increment makes to everything that stands today. No procedure, no field, no
    // status group and no assignment is delivered, so a document raised in a tenant that has
    // configured nothing is not judged — and nothing anywhere in the chain stops because of it.
    const { orderNumber, deliveryNumber } = await chain('inert', 4, 4);
    expect(await readIncompletion(tenant.client, 'ORDER', orderNumber)).toEqual([]);
    expect(await readIncompletion(tenant.client, 'DELIVERY', deliveryNumber)).toEqual([]);
    expect(await listIncompleteDocuments(tenant.client)).toEqual([]);
    expect(await billingDueList(tenant.client, { deliveryNumber })).toHaveLength(1);
  });

  it('records the field a document is missing, and takes the entry back when it is filled in', async () => {
    await saveIncompletionStatusGroup({
      client: tenant.client, changedBy: ACTOR, statusGroup: '10', name: 'Stops everything',
      blocksDelivery: true, blocksBilling: true,
    });
    await saveIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, procedureCode: 'ZHD', groupCode: 'A',
      name: 'Order header completeness',
    });
    await saveIncompletionProcedureField({
      client: tenant.client, changedBy: ACTOR, procedureCode: 'ZHD',
      tableName: 'salesOrder', fieldName: 'purchaseOrderReference',
      sequence: 1, statusGroup: '10',
    });
    await assignIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, documentCategory: 'ORDER',
      documentType: 'OR', procedureCode: 'ZHD',
    });
    try {
      const placed = await createSalesOrder({
        ...base, requestKey: key('missing-order'),
        lines: [{
          lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
          orderQuantity: 2, quantityUnit: 'UNT', taxCode: 'T10',
        }],
      }, { authorization: await salesAuthority(tenant.client) });
      // It stands — that is the whole point — and the log says what it is missing.
      const missing = await readIncompletion(tenant.client, 'ORDER', placed.orderNumber);
      expect(missing).toHaveLength(1);
      expect(missing[0].fieldName).toBe('purchaseOrderReference');
      expect(missing[0].name).toBe("The customer's purchase order reference");
      expect(missing[0].lineNumber).toBe(0);
      expect(missing[0].statusGroup).toBe('10');
      expect(missing[0].isWarning).toBe(false);

      // Filled in by a change, and the entry goes with it: the log is what stands now, not what
      // stood the last time the document was judged.
      const before = (await getSalesOrder(tenant.client, placed.orderNumber))!;
      await changeSalesOrder({
        ...base, orderNumber: placed.orderNumber, expectedVersion: before.version,
        requestKey: key('filled-order'), rejectLines: [], purchaseOrderReference: 'PO-4471',
        lines: [{
          lineNumber: before.lines[0].lineNumber, materialNumber: MATERIAL, plant: PLANT,
          orderQuantity: 2, quantityUnit: 'UNT', taxCode: 'T10',
        }],
      });
      expect(await readIncompletion(tenant.client, 'ORDER', placed.orderNumber)).toEqual([]);
    } finally {
      await withdrawIncompletionAssignment({
        client: tenant.client, changedBy: ACTOR, documentCategory: 'ORDER',
        documentType: 'OR', procedureCode: 'ZHD',
      });
    }
  });

  it('stops delivery where the status group says so, and leaves the line out of the due list', async () => {
    await saveIncompletionStatusGroup({
      client: tenant.client, changedBy: ACTOR, statusGroup: '20', name: 'Stops delivery',
      blocksDelivery: true,
    });
    await saveIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, procedureCode: 'ZDL', groupCode: 'A',
      name: 'Deliverable header',
    });
    await saveIncompletionProcedureField({
      client: tenant.client, changedBy: ACTOR, procedureCode: 'ZDL',
      tableName: 'salesOrder', fieldName: 'requestedDate', sequence: 1, statusGroup: '20',
    });
    await assignIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, documentCategory: 'ORDER',
      documentType: 'OR', procedureCode: 'ZDL',
    });
    try {
      // Raised after the procedure was assigned, and with no date on it, so it is judged the moment
      // it stands.
      const placed = await createSalesOrder({
        ...base, requestKey: key('blocked-order'),
        lines: [{
          lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
          orderQuantity: 4, quantityUnit: 'UNT', taxCode: 'T10',
        }],
      }, { authorization: await salesAuthority(tenant.client) });
      expect(await blockedFor(tenant.client, {
        documentCategory: 'ORDER', documentNumber: placed.orderNumber, fn: 'DELIVERY',
      })).toHaveLength(1);
      // Not due: a line that cannot be delivered is not outstanding, and offering it would send a
      // clerk to raise a delivery the service is about to refuse.
      expect(await listDeliverableOrderLines(tenant.client, {
        orderNumber: placed.orderNumber,
      })).toEqual([]);
      await expect(createDelivery({
        client: tenant.client, changedBy: ACTOR, orderNumber: placed.orderNumber, deliveryDate: DATE,
        items: [{ orderLineNumber: 10, quantity: '4' }],
        requestKey: key('blocked-delivery'),
      }, { authorization: await salesAuthority(tenant.client) })).rejects.toThrow(/is incomplete: it is missing the date the goods were asked for/);

      // And the same document is still billable, because that is not what this group stops.
      expect(await blockedFor(tenant.client, {
        documentCategory: 'ORDER', documentNumber: placed.orderNumber, fn: 'BILLING',
      })).toEqual([]);
    } finally {
      await withdrawIncompletionAssignment({
        client: tenant.client, changedBy: ACTOR, documentCategory: 'ORDER',
        documentType: 'OR', procedureCode: 'ZDL',
      });
    }
  });

  it('stops billing alone where that is all the status group says', async () => {
    await saveIncompletionStatusGroup({
      client: tenant.client, changedBy: ACTOR, statusGroup: '30', name: 'Stops billing',
      blocksBilling: true,
    });
    await saveIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, procedureCode: 'ZBL', groupCode: 'G',
      name: 'Billable delivery header',
    });
    await saveIncompletionProcedureField({
      client: tenant.client, changedBy: ACTOR, procedureCode: 'ZBL',
      tableName: 'delivery', fieldName: 'shipToAddress', sequence: 1, statusGroup: '30',
    });
    await assignIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, documentCategory: 'DELIVERY',
      documentType: 'LF', procedureCode: 'ZBL',
    });
    try {
      // Raised after the procedure stood, so the delivery is judged the moment it is created — and
      // delivering and issuing goods are not what this group stops, so the chain completes.
      const { deliveryNumber } = await chain('billblock', 3, 3);
      const standing = await withTenant(tenant.client, async (tx) => tx.execute(sql`
        select ship_to_street, ship_to_city, ship_to_country from delivery
         where client = ${tenant.client} and delivery_number = ${deliveryNumber}
      `) as unknown as Promise<Array<{
        ship_to_street: string | null; ship_to_city: string | null; ship_to_country: string | null;
      }>>);
      // This customer was created with a name and nothing else, so the delivery carries no address —
      // which is what makes this the honest case rather than one arranged for the test.
      expect(standing[0].ship_to_street).toBeFalsy();
      expect(await readIncompletion(tenant.client, 'DELIVERY', deliveryNumber)).toHaveLength(1);
      expect(await billingDueList(tenant.client, { deliveryNumber })).toEqual([]);
      await expect(postBillingDocument({
        client: tenant.client, changedBy: ACTOR, deliveryNumber, billingDate: DATE,
        requestKey: key('billblock-invoice'),
      }, { authorization: await salesAuthority(tenant.client) })).rejects.toThrow(/cannot be billed: it is missing where the delivery is going/);
    } finally {
      await withdrawIncompletionAssignment({
        client: tenant.client, changedBy: ACTOR, documentCategory: 'DELIVERY',
        documentType: 'LF', procedureCode: 'ZBL',
      });
    }
  });

  it('records a warning and stops nothing', async () => {
    await saveIncompletionStatusGroup({
      client: tenant.client, changedBy: ACTOR, statusGroup: '40', name: 'Warned',
      blocksDelivery: true, blocksGoodsIssue: true, blocksBilling: true,
    });
    await saveIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, procedureCode: 'ZWN', groupCode: 'A',
      name: 'Warned header fields',
    });
    await saveIncompletionProcedureField({
      client: tenant.client, changedBy: ACTOR, procedureCode: 'ZWN',
      tableName: 'salesOrder', fieldName: 'headerText', sequence: 1, statusGroup: '40',
      isWarning: true,
    });
    await assignIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, documentCategory: 'ORDER',
      documentType: 'OR', procedureCode: 'ZWN',
    });
    try {
      const { orderNumber, deliveryNumber } = await chain('warning', 2, 2);
      const entries = await readIncompletion(tenant.client, 'ORDER', orderNumber);
      expect(entries).toHaveLength(1);
      expect(entries[0].isWarning).toBe(true);
      // Recorded, and stopping nothing: a warning is how a tenant asks to be told without being
      // stopped, and a document that can never be delivered is not what was asked for.
      for (const fn of ['DELIVERY', 'GOODS_ISSUE', 'BILLING'] as const) {
        expect(await blockedFor(tenant.client, {
          documentCategory: 'ORDER', documentNumber: orderNumber, fn,
        })).toEqual([]);
      }
      expect(await billingDueList(tenant.client, { deliveryNumber })).toHaveLength(1);
      const listed = await listIncompleteDocuments(tenant.client, { documentCategory: 'ORDER' });
      const view = listed.find((row) => row.documentNumber === orderNumber);
      expect(view?.missing).toBe(1);
      expect(view?.blocking).toBe(0);
    } finally {
      await withdrawIncompletionAssignment({
        client: tenant.client, changedBy: ACTOR, documentCategory: 'ORDER',
        documentType: 'OR', procedureCode: 'ZWN',
      });
    }
  });

  it('judges an item field line by line, and blocks only the line that is missing it', async () => {
    await saveIncompletionStatusGroup({
      client: tenant.client, changedBy: ACTOR, statusGroup: '50', name: 'Stops the line',
      blocksDelivery: true,
    });
    await saveIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, procedureCode: 'ZIT', groupCode: 'B',
      name: 'Order item completeness',
    });
    await saveIncompletionProcedureField({
      client: tenant.client, changedBy: ACTOR, procedureCode: 'ZIT',
      tableName: 'salesOrderLine', fieldName: 'requestedDeliveryDate', sequence: 1, statusGroup: '50',
    });
    await assignIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, documentCategory: 'ORDER',
      documentType: 'OR', procedureCode: 'ZIT',
    });
    try {
      const placed = await createSalesOrder({
        ...base, requestKey: key('lines-order'),
        lines: [
          {
            lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
            orderQuantity: 2, quantityUnit: 'UNT', taxCode: 'T10',
          },
          {
            lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
            orderQuantity: 3, quantityUnit: 'UNT', taxCode: 'T10',
            requestedDeliveryDate: '2026-04-30',
          },
        ],
      }, { authorization: await salesAuthority(tenant.client) });
      const entries = await readIncompletion(tenant.client, 'ORDER', placed.orderNumber);
      expect(entries.map((row) => row.lineNumber)).toEqual([10]);
      expect(await blockedFor(tenant.client, {
        documentCategory: 'ORDER', documentNumber: placed.orderNumber, lineNumber: 10, fn: 'DELIVERY',
      })).toHaveLength(1);
      expect(await blockedFor(tenant.client, {
        documentCategory: 'ORDER', documentNumber: placed.orderNumber, lineNumber: 20, fn: 'DELIVERY',
      })).toEqual([]);
      // The due list offers the line that is complete and not the one that is not.
      const open = await listDeliverableOrderLines(tenant.client, { orderNumber: placed.orderNumber });
      expect(open.map((row) => row.lineNumber)).toEqual([20]);
    } finally {
      await withdrawIncompletionAssignment({
        client: tenant.client, changedBy: ACTOR, documentCategory: 'ORDER',
        documentType: 'OR', procedureCode: 'ZIT',
      });
    }
  });

  it('lists what is incomplete with the field and the screen it is entered on', async () => {
    await saveIncompletionStatusGroup({
      client: tenant.client, changedBy: ACTOR, statusGroup: '60', name: 'Stops delivery',
      blocksDelivery: true,
    });
    await saveIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, procedureCode: 'ZWL', groupCode: 'A',
      name: 'Worklisted header',
    });
    await saveIncompletionProcedureField({
      client: tenant.client, changedBy: ACTOR, procedureCode: 'ZWL',
      tableName: 'salesOrder', fieldName: 'purchaseOrderReference', sequence: 1, statusGroup: '60',
    });
    await assignIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, documentCategory: 'ORDER',
      documentType: 'OR', procedureCode: 'ZWL',
    });
    try {
      const placed = await createSalesOrder({
        ...base, requestKey: key('worklist-order'),
        lines: [{
          lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
          orderQuantity: 1, quantityUnit: 'UNT', taxCode: 'T10',
        }],
      }, { authorization: await salesAuthority(tenant.client) });
      const listed = await listIncompleteDocuments(tenant.client, { customerNumber: CUSTOMER });
      const view = listed.find((row) => row.documentNumber === placed.orderNumber);
      expect(view).toBeDefined();
      expect(view!.documentCategory).toBe('ORDER');
      expect(view!.missing).toBe(1);
      expect(view!.blocking).toBe(1);
      // An entry is a link to the thing that is missing, which is the only shape in which a
      // worklist gets worked.
      expect(view!.entries[0].screen).toBe('/sales/orders');
      expect(view!.entries[0].name).toBe("The customer's purchase order reference");
      // And nobody else's customer is on the list.
      expect(await listIncompleteDocuments(tenant.client, { customerNumber: 'NOBODY' })).toEqual([]);
    } finally {
      await withdrawIncompletionAssignment({
        client: tenant.client, changedBy: ACTOR, documentCategory: 'ORDER',
        documentType: 'OR', procedureCode: 'ZWL',
      });
    }
  });

  it('refuses a field the evaluator does not know how to judge, and names the ones it does', async () => {
    await saveIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, procedureCode: 'ZUK', groupCode: 'A',
      name: 'Unknown field',
    });
    await saveIncompletionStatusGroup({
      client: tenant.client, changedBy: ACTOR, statusGroup: '70', name: 'Stops nothing',
    });
    await expect(saveIncompletionProcedureField({
      client: tenant.client, changedBy: ACTOR, procedureCode: 'ZUK',
      tableName: 'salesOrder', fieldName: 'madeUpColumn', sequence: 1, statusGroup: '70',
    })).rejects.toThrow(/is not a field this package can judge/);
  });

  it('refuses a field on a procedure that judges another group', async () => {
    await saveIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, procedureCode: 'ZMG', groupCode: 'A',
      name: 'Header only',
    });
    await expect(saveIncompletionProcedureField({
      client: tenant.client, changedBy: ACTOR, procedureCode: 'ZMG',
      tableName: 'salesOrderLine', fieldName: 'taxCode', sequence: 1, statusGroup: '70',
    })).rejects.toThrow(/is a B-group field, and procedure ZMG judges the A group/);
  });

  it('asks nothing of a line that was rejected', async () => {
    await saveIncompletionStatusGroup({
      client: tenant.client, changedBy: ACTOR, statusGroup: '80', name: 'Stops delivery',
      blocksDelivery: true,
    });
    await saveIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, procedureCode: 'ZRJ', groupCode: 'B',
      name: 'Item completeness',
    });
    await saveIncompletionProcedureField({
      client: tenant.client, changedBy: ACTOR, procedureCode: 'ZRJ',
      tableName: 'salesOrderLine', fieldName: 'requestedDeliveryDate', sequence: 1, statusGroup: '80',
    });
    await assignIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, documentCategory: 'ORDER',
      documentType: 'OR', procedureCode: 'ZRJ',
    });
    try {
      const placed = await createSalesOrder({
        ...base, requestKey: key('rejected-order'),
        lines: [
          {
            lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
            orderQuantity: 2, quantityUnit: 'UNT', taxCode: 'T10',
          },
          {
            lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
            orderQuantity: 3, quantityUnit: 'UNT', taxCode: 'T10',
            requestedDeliveryDate: '2026-11-30',
          },
        ],
      }, { authorization: await salesAuthority(tenant.client) });
      // The line with no date is the one the log names.
      expect((await readIncompletion(tenant.client, 'ORDER', placed.orderNumber))
        .map((row) => row.lineNumber)).toEqual([10]);
      const before = (await getSalesOrder(tenant.client, placed.orderNumber))!;
      await changeSalesOrder({
        ...base, orderNumber: placed.orderNumber, expectedVersion: before.version,
        requestKey: key('rejected-change'),
        rejectLines: [{ lineNumber: 10, reason: 'CANC' }],
        lines: [{
          lineNumber: 20, materialNumber: MATERIAL, plant: PLANT,
          orderQuantity: 3, quantityUnit: 'UNT', taxCode: 'T10',
          requestedDeliveryDate: '2026-11-30',
        }],
      });
      // A rejected line is finished, not incomplete. Asking a clerk to complete one would be
      // asking them to make a dead line look live.
      expect(await readIncompletion(tenant.client, 'ORDER', placed.orderNumber)).toEqual([]);
    } finally {
      await withdrawIncompletionAssignment({
        client: tenant.client, changedBy: ACTOR, documentCategory: 'ORDER',
        documentType: 'OR', procedureCode: 'ZRJ',
      });
    }
  });

  it('refuses a procedure assigned to a document type that does not stand, and names the screen', async () => {
    await expect(assignIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, documentCategory: 'ORDER',
      documentType: 'ZZZZ', procedureCode: 'ZHD',
    })).rejects.toThrow(/Document type ZZZZ does not stand/);
    await expect(assignIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, documentCategory: 'ORDER',
      documentType: 'OR', procedureCode: 'NOPE',
    })).rejects.toThrow(/Procedure NOPE does not stand/);
    // And a second assignment of the same procedure is refused rather than counted twice.
    await saveIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, procedureCode: 'ZAS', groupCode: 'A', name: 'Assigned once',
    });
    await assignIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, documentCategory: 'ORDER',
      documentType: 'OR', procedureCode: 'ZAS',
    });
    await expect(assignIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, documentCategory: 'ORDER',
      documentType: 'OR', procedureCode: 'ZAS',
    })).rejects.toThrow(new RegExp(`already judged by procedure ZAS`));
    await withdrawIncompletionAssignment({
      client: tenant.client, changedBy: ACTOR, documentCategory: 'ORDER',
      documentType: 'OR', procedureCode: 'ZAS',
    });
  });

  it('tells the person who raised it that their document is incomplete, and says so only once', async () => {
    // Somebody real, so there is somebody to tell: the order's own header names
    // whoever raised it, and a name that is not a person reaches nobody.
    const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
    const clerk = `u-clerk-${suffix}`;
    const clerkUsername = `clerk${suffix}`;
    const bystander = `u-bystander-${suffix}`;
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into app_user (id, client, username, full_name, password_hash, is_active)
      values
        (${clerk}, ${tenant.client}, ${clerkUsername}, 'Sales clerk', 'scrypt:x:x', true),
        (${bystander}, ${tenant.client}, ${'by' + suffix}, 'Another clerk', 'scrypt:x:x', true)
      on conflict (id) do nothing
    `));

    await saveIncompletionStatusGroup({
      client: tenant.client, changedBy: ACTOR, statusGroup: '30', name: 'Stops delivery for the notice test',
      blocksDelivery: true,
    });
    await saveIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, procedureCode: 'ZNT', groupCode: 'A',
      name: 'Notice test completeness',
    });
    await saveIncompletionProcedureField({
      client: tenant.client, changedBy: ACTOR, procedureCode: 'ZNT',
      tableName: 'salesOrder', fieldName: 'purchaseOrderReference',
      sequence: 1, statusGroup: '30',
    });
    await assignIncompletionProcedure({
      client: tenant.client, changedBy: ACTOR, documentCategory: 'ORDER',
      documentType: 'OR', procedureCode: 'ZNT',
    });
    try {
      const placed = await createSalesOrder({
        ...base, changedBy: clerkUsername, requestKey: key('notice-order'),
        lines: [{
          lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
          orderQuantity: 2, quantityUnit: 'UNT', taxCode: 'T10',
        }],
      }, { authorization: await salesAuthority(tenant.client) });
      expect(await readIncompletion(tenant.client, 'ORDER', placed.orderNumber)).toHaveLength(1);

      const told = await inboxOf(clerk, 'DOC.INCOMPLETE', placed.orderNumber);
      expect(told).toHaveLength(1);
      expect(told[0]!.objectClass).toBe('sales_order');
      expect(told[0]!.isUnseen).toBe(true);
      expect(told[0]!.title).toContain(placed.orderNumber);

      // Not a message to the world. Somebody who did not raise the document has
      // no missing field of theirs to fill in.
      expect(await inboxOf(bystander, 'DOC.INCOMPLETE', placed.orderNumber)).toHaveLength(0);

      // Saved again, still incomplete. That is the same episode: the clerk
      // already holds the message, unread, and a second copy of it would make
      // the inbox a change log instead of a list of things to do.
      const before = (await getSalesOrder(tenant.client, placed.orderNumber))!;
      await changeSalesOrder({
        ...base, changedBy: clerkUsername, orderNumber: placed.orderNumber,
        expectedVersion: before.version, requestKey: key('still-missing'),
        rejectLines: [], lines: [{
          lineNumber: before.lines[0].lineNumber, materialNumber: MATERIAL, plant: PLANT,
          orderQuantity: 2, quantityUnit: 'UNT', taxCode: 'T10',
        }],
      });
      expect(await readIncompletion(tenant.client, 'ORDER', placed.orderNumber)).toHaveLength(1);
      expect(await inboxOf(clerk, 'DOC.INCOMPLETE', placed.orderNumber)).toHaveLength(1);
    } finally {
      await withdrawIncompletionAssignment({
        client: tenant.client, changedBy: ACTOR, documentCategory: 'ORDER',
        documentType: 'OR', procedureCode: 'ZNT',
      });
    }
  });

  async function inboxOf(userId: string, kind: string, objectKey: string) {
    return listInbox(tenant.client, userId).then((rows) =>
      rows.filter((row) => row.kind === kind && row.objectKey === objectKey));
  }
});
