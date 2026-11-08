/**
 * 9237 — the returns chain is configured rather than carried as constants.
 *
 * The chain worked, and it carried its own identity in code: `RE` for the returns order, `LR` for the
 * returns delivery, `CR` for the complaint a credit is requested on, `G2` for the credit memo, and
 * `RETURNS_RECEIPT` for the 651. Constants the way the order type was a constant before 9226, and wrong in
 * the same way — 9226 made the *types* configuration and left which of them the chain uses in the services,
 * so a tenant whose returns process numbers apart still had to ask for a deployment.
 *
 * Three things are asserted here, and they are the same three the document type was held to.
 *
 * The row is delivered with the tenant and read by the services: change the returns order type and the list
 * of returns orders follows it, which is the whole difference between a configuration and a constant.
 *
 * A tenant with no row is refused rather than guessed at. A silent fallback to the delivered standard would
 * make every tenant look configured, and none would know whether it had chosen anything.
 *
 * And the configuration is validated against what the posting will re-read: a receipt movement that carries
 * value, or does not land in returns stock, is refused here rather than at the goods-in door.
 *
 * The end-to-end proof that the chain still works through the configuration rather than beside it is
 * `tests/sales-delivery.test.ts`, whose returns and credit cases now run through this row on a tenant that
 * was given nothing but the delivered standard.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { listReturnsOrders } from '../src/modules/sales/returns';
import {
  defineSalesDocumentType,
  setSalesDocumentTypeActive,
} from '../src/modules/sales/document-type-maintenance';
import {
  ReturnsConfigurationError,
  getReturnsConfiguration,
  saveReturnsConfiguration,
} from '../src/modules/sales/returns-configuration';
import { assignSalesAreaDimensions, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'SD9237_RETURNS_CONFIG';
/** Two characters, because that is what the document carries: `sales_order.document_type` is two wide. */
const CUSTOM_RETURNS = 'ZR';
const CUSTOM_DELIVERY = 'ZD';
const CUSTOM_COMPLAINT = 'ZC';
const CUSTOM_MEMO = 'ZM';

let counter = 0;
const key = (label: string) => `${label}-${ACTOR}-${++counter}`;

async function order(client: string, orderNumber: string, documentType: string, raisedAgainst?: string) {
  // The reference is a pair or it is nothing: a returns order names the invoice it was raised against,
  // and an order raised against nothing names neither half.
  await withTenant(client, (tx) => tx.execute(sql`
    insert into sales_order (
      client, order_number, document_type, reference_document_type, reference_document_number,
      sales_org, distribution_channel, division,
      customer_number, company_code, currency, order_date, status, gross_value, request_key, created_by
    )
    values (${client}, ${orderNumber}, ${documentType}, ${raisedAgainst ? 'F2' : null}, ${raisedAgainst ?? null},
            '1000', '10', '01',
            'SD9237CUST', '1000', 'USD', '2026-10-15', 'OPEN', 0, ${key('order')}, ${ACTOR})
    on conflict (client, order_number) do nothing
  `));
}

const standard = {
  returnsOrderType: 'RE',
  returnsDeliveryType: 'LR',
  complaintType: 'CR',
  creditMemoType: 'G2',
  receiptMovementType: 'RETURNS_RECEIPT',
};

describe('the returns chain is configured rather than carried as constants (9237)', () => {
  let tenant: TestTenant;
  let other: TestTenant;
  let unconfigured: TestTenant;

  beforeAll(async () => {
    tenant = await createTenant('sd9237-returns-config');
    other = await createTenant('sd9237-returns-isolation');
    // A tenant the standard package was never applied to: it has no chain, and the services say so.
    unconfigured = await createTenant('sd9237-returns-unconfigured', { withConfiguration: false });

    await withTenant(tenant.client, async (tx) => {
      for (const range of [
        { objectCode: 'SALESORD', subObject: CUSTOM_RETURNS, prefix: 'ZR', numberLength: 7 },
        { objectCode: 'DELIVERY', subObject: CUSTOM_DELIVERY, prefix: 'ZD', numberLength: 7 },
        { objectCode: 'SALESORD', subObject: CUSTOM_COMPLAINT, prefix: 'ZC', numberLength: 7 },
        { objectCode: 'BILLING', subObject: CUSTOM_MEMO, prefix: 'ZM', numberLength: 7 },
      ]) {
        await defineRange(tx, { client: tenant.client, createdBy: ACTOR, ...range });
      }
    });
    // The types the tenant will configure its chain with. Each is defined the way the document types
    // screen defines it, because the chain names types that have to stand.
    await defineSalesDocumentType({
      client: tenant.client, changedBy: ACTOR, documentType: CUSTOM_RETURNS,
      name: 'Returns, our own', numberRangeObject: 'SALESORD', numberRangeSubObject: CUSTOM_RETURNS,
    });
    await defineSalesDocumentType({
      client: tenant.client, changedBy: ACTOR, documentType: CUSTOM_DELIVERY,
      name: 'Returns delivery, our own', numberRangeObject: 'DELIVERY', numberRangeSubObject: CUSTOM_DELIVERY,
    });
    await defineSalesDocumentType({
      client: tenant.client, changedBy: ACTOR, documentType: CUSTOM_COMPLAINT,
      name: 'Complaint, our own', numberRangeObject: 'SALESORD', numberRangeSubObject: CUSTOM_COMPLAINT,
    });
    await defineSalesDocumentType({
      client: tenant.client, changedBy: ACTOR, documentType: CUSTOM_MEMO,
      name: 'Credit memo, our own', numberRangeObject: 'BILLING', numberRangeSubObject: CUSTOM_MEMO,
    });
    // What an order row has to stand against: a customer, a sales area, and the company code the
    // standard structure delivered.
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${tenant.client}, 'SD9237CUST', 'ORGANIZATION', 'Returns configuration test customer', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into sales_org (client, sales_org, company_code, currency, created_by)
        values (${tenant.client}, '1000', '1000', 'USD', ${ACTOR}) on conflict do nothing
      `);
    });
    // A sales area is a sales org with a distribution channel and a division assigned to it, which is
    // what the helper does; the bare insert would fall at the assignment's foreign key.
    await assignSalesAreaDimensions(tenant, '1000', [{ distributionChannel: '10', division: '01' }]);
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into sales_area (client, sales_org, distribution_channel, division, name, created_by)
      values (${tenant.client}, '1000', '10', '01', 'Test sales area', ${ACTOR}) on conflict do nothing
    `));
    await order(tenant.client, 'SD9237-STD', 'RE', 'SD9237-INV');
    await order(tenant.client, 'SD9237-OWN', CUSTOM_RETURNS);
  }, 120_000);

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
    if (other) await destroyTenant(other.client);
    if (unconfigured) await destroyTenant(unconfigured.client);
  });

  it('delivers the chain with the tenant, as the standard it was built with', async () => {
    const view = await getReturnsConfiguration(tenant.client);
    expect(view.configured).toBe(true);
    expect(view.returnsOrderType.code).toBe('RE');
    expect(view.returnsDeliveryType.code).toBe('LR');
    expect(view.complaintType.code).toBe('CR');
    expect(view.creditMemoType.code).toBe('G2');
    expect(view.receiptMovementType.code).toBe('RETURNS_RECEIPT');
    // Every part stands: the delivered chain is not a promise about rows that may or may not be there.
    for (const part of [
      view.returnsOrderType, view.returnsDeliveryType, view.complaintType,
      view.creditMemoType, view.receiptMovementType,
    ]) {
      expect(part.stands, part.name).toBe(true);
    }
  });

  it('names the chain the services read, and not a constant they carry', async () => {
    // The list of returns orders reads the type this tenant named. Change it, and the list follows —
    // which is the whole difference between a configuration and a constant.
    const before = await listReturnsOrders(tenant.client);
    expect(before.map((row) => row.orderNumber)).toEqual(['SD9237-STD']);

    await saveReturnsConfiguration({
      client: tenant.client, changedBy: ACTOR,
      returnsOrderType: CUSTOM_RETURNS, returnsDeliveryType: CUSTOM_DELIVERY,
      complaintType: CUSTOM_COMPLAINT, creditMemoType: CUSTOM_MEMO,
      receiptMovementType: 'RETURNS_RECEIPT',
    });
    const after = await listReturnsOrders(tenant.client);
    expect(after.map((row) => row.orderNumber)).toEqual(['SD9237-OWN']);

    // And back, because a configuration is a thing a consultant can put back.
    await saveReturnsConfiguration({ client: tenant.client, changedBy: ACTOR, ...standard });
    expect((await listReturnsOrders(tenant.client)).map((row) => row.orderNumber)).toEqual(['SD9237-STD']);
  });

  it('refuses a tenant whose chain has never been configured, and says where to configure it', async () => {
    await expect(listReturnsOrders(unconfigured.client)).rejects.toMatchObject({
      name: 'ReturnsConfigurationError',
      message: expect.stringContaining('The returns chain is not configured for this tenant'),
      remedy: expect.stringContaining('/config/sales-returns'),
    });
  });

  it('refuses two parts of the chain on one document type', async () => {
    await expect(saveReturnsConfiguration({
      client: tenant.client, changedBy: ACTOR,
      returnsOrderType: 'RE', returnsDeliveryType: 'LR',
      complaintType: 'G2', creditMemoType: 'G2',
      receiptMovementType: 'RETURNS_RECEIPT',
    })).rejects.toMatchObject({
      message: expect.stringContaining('four documents with four fates'),
    });
  });

  it('refuses a type that does not stand, and one that has been withdrawn', async () => {
    await expect(saveReturnsConfiguration({
      client: tenant.client, changedBy: ACTOR,
      returnsOrderType: 'QQ', returnsDeliveryType: 'LR',
      complaintType: 'CR', creditMemoType: 'G2',
      receiptMovementType: 'RETURNS_RECEIPT',
    })).rejects.toMatchObject({
      message: expect.stringContaining('Sales document type QQ does not stand for this tenant'),
      remedy: expect.stringContaining('Define the type on the sales document types screen first'),
    });

    await setSalesDocumentTypeActive({
      client: tenant.client, changedBy: ACTOR, documentType: CUSTOM_RETURNS, isActive: false,
    });
    await expect(saveReturnsConfiguration({
      client: tenant.client, changedBy: ACTOR,
      returnsOrderType: CUSTOM_RETURNS, returnsDeliveryType: CUSTOM_DELIVERY,
      complaintType: CUSTOM_COMPLAINT, creditMemoType: CUSTOM_MEMO,
      receiptMovementType: 'RETURNS_RECEIPT',
    })).rejects.toMatchObject({
      message: expect.stringContaining(`Sales document type ${CUSTOM_RETURNS} has been withdrawn`),
    });
    await setSalesDocumentTypeActive({
      client: tenant.client, changedBy: ACTOR, documentType: CUSTOM_RETURNS, isActive: true,
    });
  });

  it('refuses a receipt movement that does not describe a return', async () => {
    // A movement that values the goods it receives back, and one that lands them somewhere else: both are
    // refusals the posting would repeat on every delivery that arrived, so they are refusals here.
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category,
                                 movement_kind, source_stock_type, destination_stock_type, valuation_relevant, created_by)
      values (${tenant.client}, 'ZRET_VALUED', 'Returns receipt that values the goods', 'RECEIPT',
              'SALES_DELIVERY', 'MATERIAL', null, 'RETURNS', true, ${ACTOR})
      on conflict (client, movement_type) do nothing
    `));
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category,
                                 movement_kind, source_stock_type, destination_stock_type, valuation_relevant, created_by)
      values (${tenant.client}, 'ZRET_WRONG', 'Returns receipt into unrestricted stock', 'RECEIPT',
              'SALES_DELIVERY', 'MATERIAL', null, 'UNRESTRICTED', false, ${ACTOR})
      on conflict (client, movement_type) do nothing
    `));

    await expect(saveReturnsConfiguration({
      client: tenant.client, changedBy: ACTOR, ...standard, receiptMovementType: 'ZRET_VALUED',
    })).rejects.toMatchObject({
      message: expect.stringContaining('is configured to carry value, and a return into returns stock carries none'),
    });
    await expect(saveReturnsConfiguration({
      client: tenant.client, changedBy: ACTOR, ...standard, receiptMovementType: 'ZRET_WRONG',
    })).rejects.toMatchObject({
      message: expect.stringContaining('and a customer return is received into returns stock'),
    });
    await expect(saveReturnsConfiguration({
      client: tenant.client, changedBy: ACTOR, ...standard, receiptMovementType: 'NO_SUCH_MOVEMENT',
    })).rejects.toMatchObject({
      message: expect.stringContaining('Movement type NO_SUCH_MOVEMENT does not stand for this tenant'),
    });
    // What was refused was refused: the chain still names the movement it named.
    expect((await getReturnsConfiguration(tenant.client)).receiptMovementType.code).toBe('RETURNS_RECEIPT');
  });

  it('refuses an empty part, and offers only what could receive a return', async () => {
    await expect(saveReturnsConfiguration({
      client: tenant.client, changedBy: ACTOR, ...standard, returnsOrderType: '  ',
    })).rejects.toBeInstanceOf(ReturnsConfigurationError);

    const view = await getReturnsConfiguration(tenant.client);
    const offered = view.choices.movements.map((movement) => movement.movementType);
    expect(offered).toContain('RETURNS_RECEIPT');
    // The two the tenant defined to prove the refusal are not choices: they are refusals with a name.
    expect(offered).not.toContain('ZRET_VALUED');
    expect(offered).not.toContain('ZRET_WRONG');
  });

  it('keeps one tenant’s chain out of another’s', async () => {
    const theirs = await getReturnsConfiguration(other.client);
    expect(theirs.configured).toBe(true);
    expect(theirs.returnsOrderType.code).toBe('RE');
    // The custom types defined against the first tenant are not there, and neither is the chain that
    // names them.
    expect(theirs.choices.documentTypes.some((type) => type.documentType === CUSTOM_RETURNS)).toBe(false);
  });
});
