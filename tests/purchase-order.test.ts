import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { changeHistory } from '../src/platform/change';
import { defineRange } from '../src/platform/numbering';
import { createRequisition } from '../src/modules/purchasing/requisitions';
import { changeOrder, createOrder, getOrder } from '../src/modules/purchasing/orders';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR056_ME21N_TEST';

/**
 * SCR-056 / ME21N acceptance: the order drawn from the PURCHORD range
 * and judged through the supplier's purchasing data, schedule lines
 * reconciling, the baseline net value, requisition conversion judged
 * across standing orders, and stable item numbers under change.
 */
describe('SCR-056 purchase orders (ME21N)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr056-purchase-order');
      client = tenant.client;
      await withTenant(client, async (tx) => {
        await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
        await defineRange(tx, { client, objectCode: 'PURCHREQ', subObject: 'NB', prefix: 'PR', numberLength: 7, createdBy: ACTOR });
        await tx.execute(sql`
          insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
          values (${client}, '1000', 'Test purchasing organization', '1000', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into business_partner (client, partner_number, category, name, created_by)
          values (${client}, 'V10000', 'ORGANIZATION', 'Test Supplier', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into bp_role (client, partner_number, role_code, created_by)
          values (${client}, 'V10000', 'SUPPLIER', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
          values (${client}, 'V10000', 'SUPPLIER', '1000', 'KWD', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
          select ${client}, controlling_area, 'CC1000', '2020-01-01', '2099-12-31', 'Test cost centre', 'ADMINISTRATION', '1000', ${ACTOR}
          from controlling_area_company
          where client = ${client} and company_code = '1000'
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into gl_account_group (client, chart_of_accounts, account_group, description, from_account_number, to_account_number, created_by)
          select ${client}, chart_of_accounts, 'OPEX', 'Operating expenses', '400000', '499999', ${ACTOR}
          from company_code where client = ${client} and company_code = '1000'
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into gl_account (client, chart_of_accounts, account_number, name, account_type, account_group, gl_account_type, is_balance_sheet, language_key, sort_key, created_by)
          select ${client}, chart_of_accounts, '400000', 'Consumption expense', 'EXPENSE', 'OPEX', 'PL_STATEMENT', false, 'EN', '001', ${ACTOR}
          from company_code where client = ${client} and company_code = '1000'
          on conflict do nothing
        `);
      });
    }
    return client;
  }

  const header = {
    supplierNumber: 'V10000',
    purchasingOrg: '1000',
    purchasingGroup: '001',
    companyCode: '1000',
    currency: '',
  };

  const stockItem = {
    materialNumber: '',
    shortText: 'Industrial steel plate',
    quantity: 10,
    unit: 'PC',
    netPrice: 150,
    priceUnit: 1,
    taxCode: '',
    plant: '1000',
    storageLocation: '',
    markedForDeletion: false,
    scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 10 }],
    assignments: [] as never[],
  };

  it('creates an order through the supplier purchasing data, with the baseline net value', async () => {
    const c = await standingClient();
    await expect(createOrder({
      client: c, changedBy: ACTOR,
      ...header, supplierNumber: 'V99999', items: [{ ...stockItem }],
    })).rejects.toThrow('Supplier V99999 does not exist');
    await expect(createOrder({
      client: c, changedBy: ACTOR, ...header,
      items: [{ ...stockItem, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 4 }] }],
    })).rejects.toThrow('Schedule lines total 4.000, not the order quantity 10.000');

    const created = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [{ ...stockItem }] });
    expect(created.orderNumber).toMatch(/^POF-\d{7}$/);
    const doc = await getOrder(c, created.orderNumber);
    expect(doc).toMatchObject({ currency: 'KWD', releaseStatus: 'UNRELEASED', supplierNumber: 'V10000' });
    expect(doc?.items[0]).toMatchObject({
      itemNumber: 10, netPrice: '150.00', netValue: '1500.00', quantity: '10.000',
    });
    expect(doc?.items[0].scheduleLines).toHaveLength(1);
    const history = await withTenant(c, (tx) => changeHistory(tx, c, 'purchase_order', created.orderNumber));
    expect(history.length).toBeGreaterThanOrEqual(1);
  });

  it('converts a requisition without ever exceeding its quantity', async () => {
    const c = await standingClient();
    const requisition = await createRequisition({
      client: c, changedBy: ACTOR,
      items: [{
        materialNumber: '', shortText: 'Industrial steel plate', quantity: 10, unit: 'PC',
        deliveryDate: '2026-11-15', plant: '1000', storageLocation: '', purchasingGroup: '001',
        priceUnit: 1, currency: '', markedForDeletion: false, assignments: [],
      }],
    });
    const reference = { requisitionNumber: requisition.requisitionNumber, requisitionItem: 10 };
    const first = await createOrder({
      client: c, changedBy: ACTOR, ...header,
      items: [{ ...stockItem, quantity: 6, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 6 }], ...reference }],
    });
    expect(first.orderNumber).toMatch(/^POF-/);
    await expect(createOrder({
      client: c, changedBy: ACTOR, ...header,
      items: [{ ...stockItem, quantity: 5, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 5 }], ...reference }],
    })).rejects.toThrow('already ordered');
    const second = await createOrder({
      client: c, changedBy: ACTOR, ...header,
      items: [{ ...stockItem, quantity: 4, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 4 }], ...reference }],
    });
    const doc = await getOrder(c, second.orderNumber);
    expect(doc?.items[0]).toMatchObject({ requisitionNumber: requisition.requisitionNumber, requisitionItem: 10 });
  });

  it('changes keep item numbers stable and carry the deletion mark', async () => {
    const c = await standingClient();
    const created = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [{ ...stockItem }] });
    await changeOrder({
      client: c, changedBy: ACTOR, ...header, orderNumber: created.orderNumber,
      items: [
        { ...stockItem, itemNumber: 10, quantity: 8, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 8 }], markedForDeletion: true },
        { ...stockItem, shortText: 'Second item', quantity: 2, netPrice: 25, scheduleLines: [{ deliveryDate: '2026-11-20', quantity: 2 }] },
      ],
    });
    const doc = await getOrder(c, created.orderNumber);
    expect(doc?.items.map((i) => i.itemNumber)).toEqual([10, 20]);
    expect(doc?.items[0]).toMatchObject({ quantity: '8.000', markedForDeletion: true });
    expect(doc?.items[1]).toMatchObject({ shortText: 'Second item', netValue: '50.00' });
    const history = await withTenant(c, (tx) => changeHistory(tx, c, 'purchase_order', created.orderNumber));
    expect(history.length).toBeGreaterThanOrEqual(2);
  });
});
