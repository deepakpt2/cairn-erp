import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveCustomerCredit } from '../src/modules/finance/credit';
import { saveSalesCondition } from '../src/modules/sales/conditions';
import { listSerialNumbers, saveSerialNumber, serialsOfPick } from '../src/modules/inventory/serial-number';
import {
  confirmDeliveryPicks, createDelivery, listDeliverableOrderLines,
} from '../src/modules/sales/delivery';
import { createSalesOrder } from '../src/modules/sales/sales-order';
import {
  assignSalesAreaDimensions, createTenant, destroyTenant, maintainMaterialSales,
  type TestTenant,
} from './helpers';
import { createSalesActor, refreshSalesActor, type SalesActor } from './helpers/sales-actor';

/**
 * §5.5b — serial numbers.
 *
 * A batch is a kind of goods; a serial is one thing. Where batch determination answers "which boxes
 * come off the shelf", a serial answers "which one of these", and it keeps its identity afterwards.
 *
 * This canon has had no serial master at all until now, and three places said so by name: a transfer
 * posting refused a movement requiring serials, an inventory posting refused the same, and the
 * material document list answered that a serial number is not on the material document. What is
 * proved here is the master they were telling the truth about the absence of.
 *
 * Four promises, and the first is the one the whole increment rests on:
 *
 * **A material that is not counted in serials is untouched.** The column defaults to false, so every
 * material that stands picks exactly as it did the day before. Serials are not a default a tenant
 * has to switch off; they are an answer they have to ask for.
 *
 * **A pick has to say which units.** A serialised item is counted in whole units, so naming two for
 * three leaves one unaccounted for, and the only honest answer to "which one" is the one the picker
 * did not give.
 *
 * **A unit goes out once.** A serial already out is out; a unit created but not put away is not on a
 * shelf; a scrapped unit is not coming back.
 *
 * **Goods that came back are goods that never went.** A correction has to name the units it takes
 * back — putting them back by number alone would leave the master claiming a customer holds units it
 * does not hold — and a unit that comes back is put back in stock with nothing written against it.
 */
const ACTOR = 'SD9261_SERIAL';
const AREA = 'CCA1';
const CUSTOMER = 'SD9261CUST1';
const MATERIAL = 'SD9261MAT1';
/** The one you count one at a time. */
const SERIALISED = 'SD9261MAT2';
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

describe('serial numbers (§5.5b)', () => {
  let tenant: TestTenant;
  let counter = 0;
  const key = (what: string) => `sd9261-${what}-${++counter}`;

  beforeAll(async () => {
    tenant = await createTenant('sd9261-serial');
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
        values (${tenant.client}, ${CUSTOMER}, 'ORGANIZATION', 'Serial test customer', ${ACTOR})
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
        values (${tenant.client}, ${MATERIAL}, 'Serial test material', 'RAW', 'UNT', ${ACTOR})
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
        values (${tenant.client}, 'MD-SER001', 2026, ${DATE}, ${DATE}, 'Opening balance', 'POSTED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (client, material_document_number, line_number, movement_type,
                                            material_number, plant, storage_location, stock_type,
                                            line_direction, entry_quantity, entry_unit, base_quantity,
                                            base_unit, created_by)
        values (${tenant.client}, 'MD-SER001', 1, 'OPENING_BALANCE', ${MATERIAL}, ${PLANT}, ${STORE},
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
      // The second material, counted in serials, so the two behaviours can be read side by side.
      await tx.execute(sql`
        insert into material (client, material_number, description, base_unit, material_type,
                              batch_managed, serial_managed, created_by)
        values (${tenant.client}, ${SERIALISED}, 'A thing you count one at a time', 'UNT', 'RAW',
                false, true, ${ACTOR})
        on conflict (client, material_number) do update set serial_managed = excluded.serial_managed
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        values (${tenant.client}, ${SERIALISED}, ${PLANT}, ${ACTOR}) on conflict do nothing
      `);
      // Six units: four standing in the store, one created and never put away, and one scrapped.
      // More than this test ever picks, so a pick is never short for want of units.
      for (const [serial, status] of [
        ['SN-0001', 'IN_STOCK'], ['SN-0002', 'IN_STOCK'], ['SN-0003', 'IN_STOCK'],
        ['SN-0004', 'IN_STOCK'], ['SN-9001', 'AVAILABLE'], ['SN-9999', 'SCRAPPED'],
      ] as const) {
        await tx.execute(sql`
          insert into serial_number (client, material_number, serial_number, plant,
                                     storage_location, stock_type, status, created_by, changed_by)
          values (${tenant.client}, ${SERIALISED}, ${serial}, ${PLANT}, ${STORE},
                  'UNRESTRICTED', ${status}, ${ACTOR}, ${ACTOR})
          on conflict (client, material_number, serial_number) do nothing
        `);
      }
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type,
                                    batch_number, quantity, created_by)
        values (${tenant.client}, ${SERIALISED}, ${PLANT}, ${STORE}, 'UNRESTRICTED', '', 4, ${ACTOR})
        on conflict (client, material_number, plant, storage_location, stock_type, batch_number)
        do update set quantity = excluded.quantity
      `);
    });

    await maintainMaterialSales(tenant, { materialNumber: MATERIAL, deliveringPlant: PLANT });
    await maintainMaterialSales(tenant, { materialNumber: SERIALISED, deliveringPlant: PLANT });
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10',
      division: '01', customerNumber: CUSTOMER, materialNumber: MATERIAL, currency: 'USD',
      amount: 25, priceUnit: 1, validityFrom: '2026-01-01', validityTo: '2026-12-31',
      supersedeStanding: false,
    });
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10',
      division: '01', customerNumber: CUSTOMER, materialNumber: SERIALISED, currency: 'USD',
      amount: 250, priceUnit: 1, validityFrom: '2026-01-01', validityTo: '2026-12-31',
      supersedeStanding: false,
    });
    await saveCustomerCredit({
      client: tenant.client, changedBy: ACTOR, customer: CUSTOMER, creditControlArea: AREA,
      creditLimit: '1000000.00', riskCategory: 'A', isBlocked: false,
      changeReason: 'Serial test credit data.',
    });
  });

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
  });

  /** An order delivered but not picked, which is the state a pick is confirmed from. */
  async function forPicking(units: number, materialNumber = SERIALISED) {
    const created = await createSalesOrder({
      ...base, requestKey: key('order'),
      lines: [{
        lineNumber: undefined, materialNumber, plant: PLANT,
        orderQuantity: units, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    }, { authorization: await salesAuthority(tenant.client) });
    const open = await listDeliverableOrderLines(tenant.client, { orderNumber: created.orderNumber });
    const built = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.orderNumber, deliveryDate: DATE,
      goodsMovementDate: DATE, headerText: 'Serial fixture',
      items: [{ orderLineNumber: open[0].lineNumber, quantity: String(units) }],
      requestKey: key('delivery'),
    }, { authorization: await salesAuthority(tenant.client) });
    return { orderNumber: created.orderNumber, deliveryNumber: built.deliveryNumber };
  }

  const pick = (deliveryNumber: string, quantity: number, serials?: string[]) =>
    confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber,
      items: [{ lineNumber: 10, quantity: String(quantity), storageLocation: STORE, ...(serials ? { serialNumbers: serials } : {}) }],
      requestKey: key('pick'),
    });

  /**
   * Fresh units standing in the store, so no test inherits another's.
   *
   * The master is state that outlives a test: a unit that went out in one is still out in the next.
   * Every test therefore asks for its own rather than borrowing a number from a fixture, which is how
   * a suite ends up asserting about whichever test happened to run first.
   */
  let pool = 100;
  async function units(count: number): Promise<string[]> {
    const made: string[] = [];
    await withTenant(tenant.client, async (tx) => {
      for (let i = 0; i < count; i += 1) {
        const serial = `SN-${String(++pool).padStart(4, '0')}`;
        await tx.execute(sql`
          insert into serial_number (client, material_number, serial_number, plant,
                                     storage_location, stock_type, status, created_by, changed_by)
          values (${tenant.client}, ${SERIALISED}, ${serial}, ${PLANT}, ${STORE},
                  'UNRESTRICTED', 'IN_STOCK', ${ACTOR}, ${ACTOR})
          on conflict (client, material_number, serial_number) do nothing
        `);
        made.push(serial);
      }
    });
    return made;
  }

  const unitAfter = async (serial: string) =>
    (await listSerialNumbers(tenant.client, { materialNumber: SERIALISED, startsWith: serial }))
      .find((row) => row.serialNumber === serial);

  it('does not ask a material that is not counted in serials', async () => {
    // The promise the increment rests on. `serial_managed` defaults to false, so every material that
    // stands picks exactly as it did the day before — no serials named, nothing refused.
    const { deliveryNumber } = await forPicking(3, MATERIAL);
    await pick(deliveryNumber, 3);
    expect(await serialsOfPick(tenant.client, deliveryNumber)).toEqual([]);
  });

  it('refuses a pick that does not say which units came off the shelf', async () => {
    const { deliveryNumber } = await forPicking(3);
    const [one, two] = await units(2);
    await expect(pick(deliveryNumber, 3)).rejects.toThrow(/names 0/);
    // And the refusal counts as well as complains, because "some serials are missing" is not a thing
    // a picker can act on: it has to say three were asked for and two were named.
    await expect(pick(deliveryNumber, 3, [one, two]))
      .rejects.toThrow(/takes 3 units but names 2/);
  });

  it('records which units went out, and which customer holds them', async () => {
    const [one, two, three] = await units(3);
    const { orderNumber, deliveryNumber } = await forPicking(2);
    await pick(deliveryNumber, 2, [one, three]);
    // The pick history says which units, not merely how many.
    expect((await serialsOfPick(tenant.client, deliveryNumber)).map((row) => row.serialNumber))
      .toEqual([one, three]);
    // And the master names the customer holding this particular piece of this order, which is the
    // thing nothing else in this canon can do.
    expect(await unitAfter(one)).toMatchObject({
      status: 'DELIVERED', deliveryNumber, orderNumber, customerNumber: CUSTOMER,
    });
    expect(await unitAfter(two)).toMatchObject({ status: 'IN_STOCK', customerNumber: '' });
  });

  it('a unit that has already gone out cannot go out again', async () => {
    const [one] = await units(1);
    const first = await forPicking(1);
    await pick(first.deliveryNumber, 1, [one]);
    const second = await forPicking(1);
    await expect(pick(second.deliveryNumber, 1, [one])).rejects.toThrow(/has already gone out/);
    // Still out on the first delivery, and not quietly moved to the second.
    expect(await unitAfter(one)).toMatchObject({
      status: 'DELIVERED', deliveryNumber: first.deliveryNumber,
    });
  });

  it('a unit that is not standing in a store cannot be picked', async () => {
    const [one] = await units(1);
    const { deliveryNumber } = await forPicking(2);
    // SN-9001 was created and never put away: it is not on a shelf, so it cannot be taken off one.
    await expect(pick(deliveryNumber, 2, [one, 'SN-9001']))
      .rejects.toThrow(/not standing in a store/);
    // SN-9999 is scrapped, and a scrapped unit is not coming back.
    await expect(pick(deliveryNumber, 2, [one, 'SN-9999'])).rejects.toThrow(/is scrapped/);
  });

  it('one unit goes out once, so a serial named twice is refused', async () => {
    const [one] = await units(1);
    const { deliveryNumber } = await forPicking(2);
    await expect(pick(deliveryNumber, 2, [one, one])).rejects.toThrow(/named twice/);
  });

  it('goods that came back are goods that never went', async () => {
    const [one, two] = await units(2);
    const { deliveryNumber } = await forPicking(2);
    await pick(deliveryNumber, 2, [one, two]);
    // A correction has to say which units are coming back: putting them back by number alone would
    // leave the master claiming a customer holds units it does not hold.
    await expect(confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber,
      items: [{ lineNumber: 10, quantity: '-2', storageLocation: STORE, reason: 'wrong units' }],
      requestKey: key('correct'),
    })).rejects.toThrow(/names 0/);

    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber,
      items: [{
        lineNumber: 10, quantity: '-2', storageLocation: STORE, reason: 'wrong units',
        serialNumbers: [one, two],
      }],
      requestKey: key('correct'),
    });
    // Back in stock with nothing written against them — not "delivered and returned", but as though
    // they had never gone.
    expect(await unitAfter(one)).toMatchObject({
      status: 'IN_STOCK', deliveryNumber: '', orderNumber: '', customerNumber: '',
    });
  });

  it('a correction cannot take back a unit another delivery took out', async () => {
    const [one, two] = await units(2);
    const first = await forPicking(1);
    await pick(first.deliveryNumber, 1, [one]);
    const other = await forPicking(1);
    await pick(other.deliveryNumber, 1, [two]);
    await expect(confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: other.deliveryNumber,
      items: [{
        lineNumber: 10, quantity: '-1', storageLocation: STORE, reason: 'wrong delivery',
        serialNumbers: [one],
      }],
      requestKey: key('correct'),
    })).rejects.toThrow(/not on/);
    // The unit is still out on the delivery that took it.
    expect(await unitAfter(one)).toMatchObject({
      status: 'DELIVERED', deliveryNumber: first.deliveryNumber,
    });
  });

  it('the master is where a unit is recorded, and recording one twice moves it', async () => {
    await saveSerialNumber({
      client: tenant.client, changedBy: ACTOR,
      materialNumber: SERIALISED, serialNumber: 'SN-NEW', plant: PLANT, status: 'AVAILABLE',
    });
    expect(await unitAfter('SN-NEW')).toMatchObject({ status: 'AVAILABLE', plant: PLANT });
    // A serial is the identity of a thing, and there is only one of it: a second save moves the unit
    // rather than making another.
    await saveSerialNumber({
      client: tenant.client, changedBy: ACTOR, materialNumber: SERIALISED,
      serialNumber: 'SN-NEW', plant: PLANT, storageLocation: STORE, status: 'IN_STOCK',
    });
    const all = await listSerialNumbers(tenant.client, { materialNumber: SERIALISED, startsWith: 'SN-NEW' });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'IN_STOCK', storageLocation: STORE });
    // And a unit cannot be recorded as delivered by hand: the pick is what writes the delivery it
    // went on, so a delivered unit with no delivery would have lost one.
    await expect(saveSerialNumber({
      client: tenant.client, changedBy: ACTOR, materialNumber: SERIALISED,
      serialNumber: 'SN-NEW', plant: PLANT, status: 'DELIVERED',
    })).rejects.toThrow(/cannot be recorded as delivered/);
  });
});
