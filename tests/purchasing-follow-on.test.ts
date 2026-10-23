import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { orderDraftFromRequisition } from '../src/modules/purchasing/follow-on';
import { createOrder } from '../src/modules/purchasing/orders';
import { createQuotation } from '../src/modules/purchasing/quotation';
import { createRequestForQuotation, getRequestForQuotation } from '../src/modules/purchasing/rfq';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'FOLLOW_ON';

describe('purchasing follow-on chain', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  it('copies a requisition, prices it, and lets only the order consume it', async () => {
    const tenant = await createTenant('purchasing-follow-on');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'RFQEVENT', subObject: '*', prefix: 'EV', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'RFQ', subObject: '*', prefix: 'RQ', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'QUOTATION', subObject: '*', prefix: 'QT', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'INFOREC', subObject: '*', prefix: 'IR', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, general_status, created_by)
        values
          (${client}, 'V-FO', 'ORGANIZATION', 'Follow-on supplier', 'CREATED', ${ACTOR}),
          (${client}, 'V-OUT', 'ORGANIZATION', 'Outside quota', 'CREATED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${client}, 'V-FO', 'SUPPLIER', ${ACTOR}), (${client}, 'V-OUT', 'SUPPLIER', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into supplier_purchasing_org
          (client, partner_number, role_code, purchasing_org, order_currency, purchasing_group, purchasing_status, created_by)
        values
          (${client}, 'V-FO', 'SUPPLIER', '1000', 'USD', '001', 'CREATED', ${ACTOR}),
          (${client}, 'V-OUT', 'SUPPLIER', '1000', 'USD', '001', 'CREATED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'MAT-FO', 'Follow-on material', t.material_type, 'EA', ${ACTOR}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, procurement_type, created_by)
        values (${client}, 'MAT-FO', '1000', 'BUY', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into purchase_requisition_item
          (client, requisition_number, item_number, material_number, short_text, quantity, unit, requisition_date, delivery_date, plant, purchasing_group, created_by)
        values (${client}, 'PR-FO', 10, 'MAT-FO', 'Asked', 5, 'EA', '2026-10-22', '2026-12-01', '1000', '001', ${ACTOR})
      `);
    });

    const asked = await createRequestForQuotation({
      client, changedBy: ACTOR,
      purchasingOrg: '1000', purchasingGroup: '001', rfqDate: '2026-10-22', quotationDeadline: '2026-12-31',
      suppliers: [{ partnerNumber: 'V-FO' }, { partnerNumber: 'V-OUT' }],
      lines: [{
        requisitionNumber: 'PR-FO', requisitionItem: 10,
        materialNumber: 'MAT-FO', quantity: 5, unit: 'EA', plant: '1000', deliveryDate: '2026-12-01',
      }],
    });
    const opened = await getRequestForQuotation(client, asked.eventNumber);
    expect(opened?.requests).toHaveLength(2);
    expect(opened?.requests[0].lines[0]).toMatchObject({ requisitionNumber: 'PR-FO', requisitionItem: 10, quantity: '5.000' });
    const [requisition] = await withTenant(client, (tx) => tx.execute(sql`
      select quantity::text as quantity from purchase_requisition_item
       where client = ${client} and requisition_number = 'PR-FO'
    `)) as unknown as Array<{ quantity: string }>;
    expect(requisition.quantity).toBe('5.000');

    const request = opened!.requests[0];
    const quotation = await createQuotation({
      client, changedBy: ACTOR, rfqNumber: request.rfqNumber,
      lines: [{ itemNumber: 10, quantity: '4', unit: 'EA', netPrice: '12', priceUnit: '1', deliveryDate: '2026-12-01', infoUpdate: true }],
    });
    const [beforeInfo] = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as n from purchasing_info_record where client = ${client}
    `)) as unknown as Array<{ n: number }>;
    expect(beforeInfo.n).toBe(0);

    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into purchasing_quota_arrangement
          (client, quota_number, material_number, plant, valid_from, valid_to, created_by)
        values (${client}, 'QA-FO', 'MAT-FO', '1000', '2020-01-01', '2099-12-31', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into purchasing_quota_arrangement_item
          (client, quota_number, item_number, partner_number, purchasing_org, quota, created_by)
        values (${client}, 'QA-FO', '001', 'V-FO', '1000', 100, ${ACTOR})
      `);
    });
    const order = await createOrder({
      client, changedBy: ACTOR,
      supplierNumber: 'V-FO', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000',
      items: [{
        materialNumber: 'MAT-FO', quantity: 4, unit: 'EA', plant: '1000',
        quotationNumber: quotation.quotationNumber, quotationItem: 10,
        scheduleLines: [{ deliveryDate: '2026-12-01', quantity: 4 }],
      }],
    });
    expect(order.orderNumber).toMatch(/^POF-/);
    const [afterInfo] = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as n from purchasing_info_record where client = ${client}
    `)) as unknown as Array<{ n: number }>;
    expect(afterInfo.n).toBe(1);
    const [still] = await withTenant(client, (tx) => tx.execute(sql`
      select quantity::text as quantity from purchase_requisition_item
       where client = ${client} and requisition_number = 'PR-FO'
    `)) as unknown as Array<{ quantity: string }>;
    expect(still.quantity).toBe('5.000');

    await expect(createOrder({
      client, changedBy: ACTOR,
      supplierNumber: 'V-FO', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000',
      items: [{
        materialNumber: 'MAT-FO', quantity: 2, unit: 'EA', plant: '1000', netPrice: 12, priceUnit: 1,
        quotationNumber: quotation.quotationNumber, quotationItem: 10,
        scheduleLines: [{ deliveryDate: '2026-12-01', quantity: 2 }],
      }],
    })).rejects.toThrow(/exceeds/);

    const outside = await createOrder({
      client, changedBy: ACTOR,
      supplierNumber: 'V-OUT', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000',
      items: [{
        materialNumber: 'MAT-FO', shortText: 'Outside', quantity: 1, unit: 'EA', plant: '1000', netPrice: 9, priceUnit: 1,
        scheduleLines: [{ deliveryDate: '2026-12-01', quantity: 1 }],
      }],
    });
    expect(outside.warnings.join(' ')).toMatch(/not in quota QA-FO/);
    const [base] = await withTenant(client, (tx) => tx.execute(sql`
      select quota_base_quantity::text as base
        from purchasing_quota_arrangement_item
       where client = ${client} and quota_number = 'QA-FO' and item_number = '001'
    `)) as unknown as Array<{ base: string }>;
    expect(base.base).toBe('4.000');

    const fromRequisition = await orderDraftFromRequisition(client, 'PR-FO');
    expect(fromRequisition?.items).toHaveLength(1);
    expect(fromRequisition?.items[0]).toMatchObject({
      quantity: 1,
      requisitionNumber: 'PR-FO',
      requisitionItem: 10,
      quotationNumber: '',
    });
    const direct = await createOrder({
      client, changedBy: ACTOR,
      supplierNumber: 'V-FO', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000',
      items: [{
        materialNumber: 'MAT-FO', quantity: 1, unit: 'EA', plant: '1000', netPrice: 8, priceUnit: 1,
        requisitionNumber: 'PR-FO', requisitionItem: 10,
        scheduleLines: [{ deliveryDate: '2026-12-01', quantity: 1 }],
      }],
    });
    expect(direct.orderNumber).toMatch(/^POF-/);
  });
});
