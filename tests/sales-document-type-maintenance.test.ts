/**
 * 9236 — a sales document type is maintained rather than deployed.
 *
 * 9226 moved what a document *is* out of three constants and into a row, and then left the row writable by
 * nothing but a migration: the refusals told the reader to restore the type "in the sales document type
 * configuration", and there was no such screen to go to. The increment that closes the gap is not the
 * screen itself — it is the proof that a change made on the screen is what the chain then reads, which is
 * the whole reason the facts were moved into a table.
 *
 * So this file does two things. It asserts the maintenance rules a configuration screen must hold: a type
 * is not defined twice, a type cannot cancel into a type that does not stand or into itself, and a type
 * whose number range has no interval is refused here — where the fault is a configuration error — rather
 * than later, where the same fault would present as a document that cannot be numbered. And it asserts the
 * other half: withdraw the standard order type through the maintenance service and the order service
 * refuses to create, offer it again and the same call succeeds. Nothing here goes through a screen; the
 * services are called directly, because a screen is a way of reaching a service and not a place where
 * rules live.
 *
 * There is deliberately no test that a type can be deleted. The application role is granted no DELETE on
 * the table, and the screen offers no way to try: history keeps reading the type a document was created
 * with, and a deactivation that can be undone is the only withdrawal a configuration needs.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveCustomerCredit } from '../src/modules/finance/credit';
import { saveSalesCondition } from '../src/modules/sales/conditions';
import { SalesOrderError, createSalesOrder } from '../src/modules/sales/sales-order';
import { STANDARD_ORDER_TYPE, salesDocumentTypeFor } from '../src/modules/sales/document-type';
import {
  changeSalesDocumentType,
  defineSalesDocumentType,
  listSalesDocumentTypes,
  setSalesDocumentTypeActive,
} from '../src/modules/sales/document-type-maintenance';
import {
  assignSalesAreaDimensions,
  createTenant,
  destroyTenant,
  type TestTenant,
  maintainMaterialSales,
} from './helpers';
import { createSalesActor, refreshSalesActor, type SalesActor } from './helpers/sales-actor';

const ACTOR = 'SD9236_DOCTYPE_MAINTAIN';
const AREA = 'CCA1';
const CUSTOMER = 'SD9236CUST1';
const MATERIAL = 'SD9236MAT1';
const PLANT = '1000';
const DATE = '2026-10-15';

/** The type the tenant adds for its own process, and the type it cancels into. */
const RUSH = 'ZOR';
const RUSH_CANCELS = 'ZRZ';

let counter = 0;
const key = (label: string) => `${label}-${ACTOR}-${++counter}`;

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

async function placeOrder(client: string, requestKey: string) {
  return createSalesOrder({
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
  }, { authorization: await salesAuthority(client) });
}

describe('a sales document type is maintained rather than deployed (9236)', () => {
  let tenant: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    tenant = await createTenant('sd9236-doctype-maintenance');
    other = await createTenant('sd9236-doctype-isolation');

    await withTenant(tenant.client, async (tx) => {
      for (const range of [
        { objectCode: 'SALESORD', subObject: 'OR', prefix: 'SO', numberLength: 7 },
        { objectCode: 'BILLING', subObject: 'F2', prefix: 'INV', numberLength: 7 },
        // What the two types defined on the screen will draw from. They stand before the types are
        // defined, because a type is refused without them.
        { objectCode: 'SALESORD', subObject: RUSH, prefix: 'ZO', numberLength: 7 },
        { objectCode: 'SALESORD', subObject: RUSH_CANCELS, prefix: 'ZZ', numberLength: 7 },
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
        insert into credit_control_area (client, credit_control_area, name, currency, warning_threshold_percent, created_by)
        values (${tenant.client}, ${AREA}, 'Test credit area', 'USD', 90, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        update company_code set credit_control_area = ${AREA}
        where client = ${tenant.client} and company_code = '1000'
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
        values (${tenant.client}, ${PLANT}, '0001', 'Main store', true, false, ${ACTOR})
        on conflict (client, plant, storage_location) do update set is_active = excluded.is_active
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
        values (${tenant.client}, ${MATERIAL}, 'Maintained type test material', 'RAW', 'UNT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        values (${tenant.client}, ${MATERIAL}, ${PLANT}, ${ACTOR}) on conflict do nothing
      `);
    });
    // The material stands for sale in the sales area, as every material an order is raised against
    // has to; the document type is what these tests are about.
    await maintainMaterialSales(tenant, { materialNumber: MATERIAL, deliveringPlant: PLANT });
    await saveCustomerCredit({
      client: tenant.client, changedBy: ACTOR, customer: CUSTOMER, creditControlArea: AREA,
      creditLimit: '1000000.00', riskCategory: 'A', isBlocked: false,
      changeReason: 'Maintained document type test fixture.',
    });
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      customerNumber: '', materialNumber: MATERIAL, currency: 'USD', amount: 25, priceUnit: 1,
      validityFrom: '2026-01-01', validityTo: '2026-12-31', supersedeStanding: false,
    });
  }, 120_000);

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
    if (other) await destroyTenant(other.client);
  });

  it('defines a type, and the chain offers it', async () => {
    const defined = await defineSalesDocumentType({
      client: tenant.client, changedBy: ACTOR, documentType: RUSH,
      name: 'Rush order', numberRangeObject: 'SALESORD', numberRangeSubObject: RUSH,
    });
    expect(defined.documentType).toBe(RUSH);

    const read = await withTenant(tenant.client, (tx) => salesDocumentTypeFor(tx, tenant.client, RUSH));
    expect(read?.name).toBe('Rush order');
    expect(read?.numberRangeObject).toBe('SALESORD');
    expect(read?.numberRangeSubObject).toBe(RUSH);
    // The resolver carries only what a document needs, and `isActive` is not among it: a withdrawn type
    // is not returned at all, which is the assertion the withdrawal test makes.

    const listed = await listSalesDocumentTypes(tenant.client);
    const rush = listed.find((row) => row.documentType === RUSH);
    expect(rush?.isActive).toBe(true);
    expect(rush?.rangeStands).toBe(true);
    expect(rush?.documentsStanding).toBe(0);
  });

  it('refuses a type whose documents could never be numbered', async () => {
    await expect(defineSalesDocumentType({
      client: tenant.client, changedBy: ACTOR, documentType: 'ZQ1',
      name: 'Type with no range', numberRangeObject: 'SALESORD', numberRangeSubObject: 'NOPE',
    })).rejects.toMatchObject({
      message: expect.stringContaining('No active number range interval stands for SALESORD / NOPE'),
      remedy: expect.stringContaining('Define the number range interval for SALESORD / NOPE first'),
    });
    // Nothing was written: the refusal is a configuration error, not a half-created type.
    const listed = await listSalesDocumentTypes(tenant.client);
    expect(listed.some((row) => row.documentType === 'ZQ1')).toBe(false);
  });

  it('does not define the same type twice', async () => {
    await expect(defineSalesDocumentType({
      client: tenant.client, changedBy: ACTOR, documentType: RUSH,
      name: 'Rush order again', numberRangeObject: 'SALESORD', numberRangeSubObject: RUSH,
    })).rejects.toMatchObject({
      message: expect.stringContaining(`Document type ${RUSH} stands for this tenant already`),
    });
  });

  it('refuses a name that is not a document type, and a type that cancels into itself', async () => {
    await expect(defineSalesDocumentType({
      client: tenant.client, changedBy: ACTOR, documentType: 'lower',
      name: 'Lower case', numberRangeObject: 'SALESORD', numberRangeSubObject: RUSH,
    })).rejects.toMatchObject({
      message: expect.stringContaining('two to four characters of capital letters or digits'),
    });
    await expect(defineSalesDocumentType({
      client: tenant.client, changedBy: ACTOR, documentType: 'ZS1',
      name: 'Self-cancelling', numberRangeObject: 'SALESORD', numberRangeSubObject: RUSH,
      cancellationDocumentType: 'ZS1',
    })).rejects.toMatchObject({
      message: expect.stringContaining('cannot cancel into itself'),
    });
  });

  it('names a cancellation type that stands first, and reads it back', async () => {
    // The counterpart must stand: a cancellation that names a type no one has defined is a loop with a
    // missing end.
    await expect(defineSalesDocumentType({
      client: tenant.client, changedBy: ACTOR, documentType: RUSH_CANCELS,
      name: 'Rush cancellation', numberRangeObject: 'SALESORD', numberRangeSubObject: RUSH_CANCELS,
      cancellationDocumentType: 'ZNE',
    })).rejects.toMatchObject({
      message: expect.stringContaining('Document type ZNE does not stand'),
    });

    await defineSalesDocumentType({
      client: tenant.client, changedBy: ACTOR, documentType: RUSH_CANCELS,
      name: 'Rush cancellation', numberRangeObject: 'SALESORD', numberRangeSubObject: RUSH_CANCELS,
    });
    const changed = await changeSalesDocumentType({
      client: tenant.client, changedBy: ACTOR, documentType: RUSH,
      name: 'Rush order', cancellationDocumentType: RUSH_CANCELS,
    });
    expect(changed.documentType).toBe(RUSH);

    const read = await withTenant(tenant.client, (tx) => salesDocumentTypeFor(tx, tenant.client, RUSH));
    expect(read?.cancellationDocumentType).toBe(RUSH_CANCELS);
  });

  it('withdraws a type, and the chain stops offering it — until it is offered again', async () => {
    // The point of the increment. The order service reads the configuration; it does not carry a constant
    // of its own. Withdrawing the type is a maintenance act, and the refusal that follows is the chain
    // reading what the maintenance wrote.
    const placed = await placeOrder(tenant.client, key('order-before'));
    expect(placed.orderNumber).toBeTruthy();

    const standing = await listSalesDocumentTypes(tenant.client);
    const order = standing.find((row) => row.documentType === STANDARD_ORDER_TYPE);
    expect(order?.documentsStanding).toBe(1);

    await setSalesDocumentTypeActive({
      client: tenant.client, changedBy: ACTOR, documentType: STANDARD_ORDER_TYPE, isActive: false,
    });
    await expect(placeOrder(tenant.client, key('order-withdrawn')))
      .rejects.toBeInstanceOf(SalesOrderError);

    // The documents already created keep reading the type: withdrawal is not deletion, and the history
    // is not rewritten by a configuration change.
    const withdrawn = await listSalesDocumentTypes(tenant.client);
    const orderAfter = withdrawn.find((row) => row.documentType === STANDARD_ORDER_TYPE);
    expect(orderAfter?.isActive).toBe(false);
    expect(orderAfter?.documentsStanding).toBe(1);
    expect(await withTenant(tenant.client, (tx) => salesDocumentTypeFor(tx, tenant.client, STANDARD_ORDER_TYPE)))
      .toBeUndefined();

    const restored = await setSalesDocumentTypeActive({
      client: tenant.client, changedBy: ACTOR, documentType: STANDARD_ORDER_TYPE, isActive: true,
    });
    expect(restored.isActive).toBe(true);
    expect(restored.documentsStanding).toBe(1);
    const again = await placeOrder(tenant.client, key('order-after'));
    expect(again.orderNumber).toBeTruthy();
    expect(again.orderNumber).not.toBe(placed.orderNumber);
  }, 120_000);

  it('keeps one tenant’s types out of another’s', async () => {
    const listed = await listSalesDocumentTypes(other.client);
    expect(listed.some((row) => row.documentType === RUSH)).toBe(false);
    const read = await withTenant(other.client, (tx) => salesDocumentTypeFor(tx, other.client, RUSH));
    expect(read).toBeUndefined();
    // And the standard set the other tenant was delivered with is untouched by what was defined here.
    expect(listed.some((row) => row.documentType === STANDARD_ORDER_TYPE)).toBe(true);
  });
});
