import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createOrder } from '../src/modules/purchasing/orders';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';

import { postGoodsReceipt } from './helpers/goods-receipt-authorized';
import { postGoodsIssue } from './helpers/goods-issue-authorized';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SLOC_POSTING_TEST';
const POSTING = { documentDate: '2026-10-18', postingDate: '2026-10-18' };

describe('storage location on a stock movement', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standing(): Promise<string> {
    if (client) return client;
    const tenant = await createTenant('storage-location-posting');
    client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${client}, 'V10000', 'ORGANIZATION', 'Test Supplier', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${client}, 'V10000', 'SUPPLIER', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
        values (${client}, 'V10000', 'SUPPLIER', '1000', 'USD', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${client}, 'MAT-SLOC', 'Stored part', 'RAW', 'PC', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        values (${client}, 'MAT-SLOC', '1000', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (
          client, material_number, valuation_area, valuation_class, price_control,
          standard_price, moving_average_price, price_unit, currency, created_by
        ) values (${client}, 'MAT-SLOC', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        values (${client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', ${ACTOR}),
               (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR}),
               (${client}, 'CA01', 'CONSUMPTION', 'RAW_INVENTORY', '', '500000', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, is_posting_locked, created_by)
        values (${client}, 'A000', 'CC1100', '2026-01-01', '2026-12-31', 'Line centre', 'PRODUCTION', '1000', false, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${client}, '2000', 'Other plant', '1000', 'KW', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, created_by)
        values (${client}, '2000', 'ONLY2', 'Other plant store', ${ACTOR}) on conflict do nothing
      `);
    });
    await initializeMaterialPeriodControl({
      client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'Storage location posting',
    });
    return client;
  }

  const header = {
    supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '',
  };
  const item = (storageLocation = '') => ({
    materialNumber: 'MAT-SLOC', shortText: 'Stored part', quantity: 4, unit: 'PC',
    netPrice: 10, priceUnit: 1, taxCode: '', plant: '1000', storageLocation,
    markedForDeletion: false,
    scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 4 }],
    assignments: [] as never[],
  });

  async function stockAt(c: string, location: string) {
    return withTenant(c, async (tx) => {
      const rows = await tx.execute(sql`
        select quantity from stock_quantity
        where client = ${c} and material_number = 'MAT-SLOC' and plant = '1000' and storage_location = ${location}
      `);
      return Number((rows as unknown as Array<{ quantity: string }>)[0]?.quantity ?? 0);
    });
  }

  it('uses the plant default when the line and the order name none, and refuses a blank key', async () => {
    const c = await standing();
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [item('')] });
    const doc = await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'sloc-default', lines: [{ itemNumber: 10, quantity: 2 }],
    });
    expect(doc.lines[0].storageLocation).toBe('0001');
    expect(await stockAt(c, '0001')).toBe(2);
    expect(await stockAt(c, '')).toBe(0);
  });

  it('keeps a typed location, and does not replace a wrong one with the default', async () => {
    const c = await standing();
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [item('0002')] });
    const doc = await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'sloc-typed', lines: [{ itemNumber: 10, quantity: 1, storageLocation: '0003' }],
    });
    expect(doc.lines[0].storageLocation).toBe('0003');
    const fromOrder = await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'sloc-order-default', lines: [{ itemNumber: 10, quantity: 1 }],
    });
    expect(fromOrder.lines[0].storageLocation).toBe('0002');

    const foreign = await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'sloc-foreign', lines: [{ itemNumber: 10, quantity: 1, storageLocation: 'ONLY2' }],
    }).catch((error: unknown) => error);
    expect((foreign as Error).message).toMatch(/Storage location ONLY2 does not stand in plant 1000/);

    const missing = await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'sloc-missing', lines: [{ itemNumber: 10, quantity: 1, storageLocation: '7777' }],
    }).catch((error: unknown) => error);
    expect((missing as Error).message).toMatch(/Storage location 7777 does not stand in plant 1000/);
  });

  it('refuses an inactive location and a plant default that is not assigned', async () => {
    const c = await standing();
    await withTenant(c, (tx) => tx.execute(sql`
      update storage_location set is_active = false
      where client = ${c} and plant = '1000' and storage_location = '0099'
    `));
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [item('')] });
    const blocked = await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'sloc-blocked', lines: [{ itemNumber: 10, quantity: 1, storageLocation: '0099' }],
    }).catch((error: unknown) => error);
    expect((blocked as Error).message).toMatch(/0099 in plant 1000 is blocked for postings/);

    await withTenant(c, (tx) => tx.execute(sql`
      update plant set default_storage_location = 'NOPE' where client = ${c} and plant = '1000'
    `));
    const badDefault = await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'sloc-bad-default', lines: [{ itemNumber: 10, quantity: 1 }],
    }).catch((error: unknown) => error);
    expect((badDefault as Error).message).toMatch(/Plant 1000 default storage location NOPE does not stand/);

    await withTenant(c, (tx) => tx.execute(sql`
      update plant set default_storage_location = null where client = ${c} and plant = '1000'
    `));
    const required = await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'sloc-required', lines: [{ itemNumber: 10, quantity: 1 }],
    }).catch((error: unknown) => error);
    expect((required as Error).message).toMatch(/A storage location is required in plant 1000/);

    await withTenant(c, (tx) => tx.execute(sql`
      update plant set default_storage_location = '0001' where client = ${c} and plant = '1000'
    `));
  });

  it('issues from the plant default when the line names no location', async () => {
    const c = await standing();
    const issued = await postGoodsIssue({
      client: c, changedBy: ACTOR, movementTypeCode: '201',
      postingDate: '2026-10-18', documentDate: '2026-10-18', requestKey: 'sloc-issue',
      lines: [{ materialNumber: 'MAT-SLOC', plant: '1000', quantity: 1, costCenter: 'CC1100' }],
    });
    expect(issued.lines[0].storageLocation).toBe('0001');
  });
});
