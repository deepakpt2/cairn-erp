import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createOrder, getOrder } from '../src/modules/purchasing/orders';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import {
  getMaterialDocument, getReceiptOrder, postGoodsReceipt, reverseGoodsReceipt,
} from '../src/modules/inventory/goods-receipt';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR061_MIGO_TEST';
const POSTING = { documentDate: '2026-10-18', postingDate: '2026-10-18' };

/**
 * SCR-061 acceptance: the goods receipt posts document, stock,
 * valuation and balanced journal in one transaction; open quantity
 * comes from posted history and judges the tolerance; a released
 * order is required where a strategy claimed it; a flagged material
 * refuses; reversal is a new document and nothing is edited.
 */
describe('SCR-061 goods receipt (MIGO)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr061-goods-receipt');
      client = tenant.client;
      await defineTestRanges(tenant, { fiscalYear: 2026 });
      await withTenant(client, async (tx) => {
        await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
        await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
        await tx.execute(sql`
          insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
          values (${client}, '1000', 'Test purchasing organization', '1000', ${ACTOR}) on conflict do nothing
        `);
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
          values (${client}, 'MAT-10001', 'Industrial steel plate', 'RAW', 'PC', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into material_plant (client, material_number, plant, overdelivery_tolerance, created_by)
          values (${client}, 'MAT-10001', '1000', 0, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into material_valuation (
            client, material_number, valuation_area, valuation_class, price_control,
            standard_price, moving_average_price, price_unit, currency, created_by
          )
          values (${client}, 'MAT-10001', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
          values (${client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', ${ACTOR}),
                 (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR})
          on conflict do nothing
        `);
        // A release strategy claiming orders of 1000 and above, unreleased at first.
        await tx.execute(sql`
          insert into characteristic (client, characteristic_name, description, data_format, value_length, decimal_places, lifecycle_status, created_by)
          values (${client}, 'TOTAL_VALUE', 'Total document value', 'NUM', 13, 2, 'ACTIVE', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into class_type (client, class_type, description, object_category, created_by)
          values (${client}, 'PURCHASE_ORDER', 'Purchase order release classes', 'PURCHASING', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into classification_class (client, class_type, class_name, description, lifecycle_status, created_by)
          values (${client}, 'PURCHASE_ORDER', 'PO_RELEASE', 'Purchase order release', 'ACTIVE', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into class_assignment (client, class_type, class_name, position, characteristic_name, created_by)
          values (${client}, 'PURCHASE_ORDER', 'PO_RELEASE', 1, 'TOTAL_VALUE', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into release_group (client, group_code, document_category, description, created_by)
          values (${client}, 'PO', 'PURCHASE_ORDER', 'Purchase order releases', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into release_code (client, group_code, code, description, created_by)
          values (${client}, 'PO', 'MGR', 'Purchasing manager', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into release_strategy (client, group_code, strategy_code, description, class_type, class_name, priority, lifecycle_status, created_by)
          values (${client}, 'PO', 'HIGH', 'High value orders', 'PURCHASE_ORDER', 'PO_RELEASE', 100, 'ACTIVE', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into release_strategy_criterion (client, group_code, strategy_code, characteristic_name, operator, value_from, created_by)
          values (${client}, 'PO', 'HIGH', 'TOTAL_VALUE', 'GE', '1000', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into release_strategy_step (client, group_code, strategy_code, step, release_code, created_by)
          values (${client}, 'PO', 'HIGH', 1, 'MGR', ${ACTOR}) on conflict do nothing
        `);
      });
      await initializeMaterialPeriodControl({
        client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'Stage 5 acceptance',
      });
    }
    return client;
  }

  const header = {
    supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '',
  };
  const item = (quantity: number, netPrice: number) => ({
    materialNumber: 'MAT-10001', shortText: 'Industrial steel plate', quantity, unit: 'PC',
    netPrice, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '',
    markedForDeletion: false,
    scheduleLines: [{ deliveryDate: '2026-11-15', quantity }],
    assignments: [] as never[],
  });

  async function stockAndValuation(c: string) {
    return withTenant(c, async (tx) => {
      const stock = await tx.execute(sql`
        select quantity from stock_quantity
        where client = ${c} and material_number = 'MAT-10001' and plant = '1000'
      `);
      const valuation = await tx.execute(sql`
        select total_stock_quantity, stock_value, moving_average_price from material_valuation
        where client = ${c} and material_number = 'MAT-10001' and valuation_area = '1000'
      `);
      return {
        stock: stock as unknown as Array<{ quantity: string }>,
        valuation: (valuation as unknown as Array<Record<string, string>>)[0],
      };
    });
  }

  it('posts the document, stock, valuation and balanced journal in one transaction, idempotently', async () => {
    const c = await standingClient();
    // Below the release threshold: no strategy claims this order.
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [item(5, 100)] });
    const doc = await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'req-full-1', lines: [{ itemNumber: 10, quantity: 5 }],
    });
    expect(doc.status).toBe('POSTED');
    expect(doc.lines[0]).toMatchObject({ movementType: 'GOODS_RECEIPT_PO', quantity: '5.000', value: '500.0000' });
    const { stock, valuation } = await stockAndValuation(c);
    expect(Number(stock[0].quantity)).toBe(5);
    expect(Number(valuation.total_stock_quantity)).toBe(5);
    expect(Number(valuation.stock_value)).toBe(500);
    expect(Number(valuation.moving_average_price)).toBe(100);
    expect((await getReceiptOrder(c, order.orderNumber))?.items[0]).toMatchObject({ received: 5, remaining: 0 });

    const journal = await withTenant(c, (tx) => tx.execute(sql`
      select debit_credit, amount_local from journal_entry_line
      where client = ${c} and document_number = ${doc.journalDocumentNumber}
    `));
    const lines = journal as unknown as Array<{ debit_credit: string; amount_local: string }>;
    const debit = lines.filter((l) => l.debit_credit === 'S').reduce((s, l) => s + Number(l.amount_local), 0);
    const credit = lines.filter((l) => l.debit_credit === 'H').reduce((s, l) => s + Number(l.amount_local), 0);
    expect(debit).toBe(500);
    expect(credit).toBe(500);

    // A retried submission returns the standing document; nothing posts twice.
    const replay = await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'req-full-1', lines: [{ itemNumber: 10, quantity: 5 }],
    });
    expect(replay.materialDocumentNumber).toBe(doc.materialDocumentNumber);
    expect(Number((await stockAndValuation(c)).stock[0].quantity)).toBe(5);

    // Open quantity now stands at zero: one more refuses beyond tolerance.
    await expect(postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'req-over-1', lines: [{ itemNumber: 10, quantity: 1 }],
    })).rejects.toThrow('exceeds the ordered 5');
    // And a closed material period refuses on its own rules.
    await expect(postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      documentDate: '2026-08-18', postingDate: '2026-08-18',
      requestKey: 'req-closed-1', lines: [{ itemNumber: 10, quantity: 1 }],
    })).rejects.toThrow('material posting period');
  });

  it('refuses an unreleased order, then posts once released; a flagged material refuses', async () => {
    const c = await standingClient();
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [item(10, 150)] });
    expect((await getOrder(c, order.orderNumber))?.releaseStatus).toBe('UNRELEASED');
    await expect(postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'req-unrel-1', lines: [{ itemNumber: 10, quantity: 10 }],
    })).rejects.toThrow('is not released');

    await withTenant(c, (tx) => tx.execute(sql`
      update document_release set status = 'RELEASED', current_step = 1
      where client = ${c} and document_number = ${order.orderNumber}
    `));
    const doc = await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'req-rel-1', lines: [{ itemNumber: 10, quantity: 4 }],
    });
    expect(doc.status).toBe('POSTED');

    // Reversal is a new document; the original is marked, never edited.
    const reversal = await reverseGoodsReceipt({
      client: c, changedBy: ACTOR, materialDocumentNumber: doc.materialDocumentNumber,
      ...POSTING, requestKey: 'req-rev-1',
    });
    expect(reversal.reversalOf).toBe(doc.materialDocumentNumber);
    expect((await getMaterialDocument(c, doc.materialDocumentNumber))?.status).toBe('REVERSED');
    expect((await getReceiptOrder(c, order.orderNumber))?.items[0].received).toBe(0);
    await expect(reverseGoodsReceipt({
      client: c, changedBy: ACTOR, materialDocumentNumber: doc.materialDocumentNumber,
      ...POSTING, requestKey: 'req-rev-2',
    })).rejects.toThrow('already been reversed');

    await withTenant(c, (tx) => tx.execute(sql`
      update material_plant set marked_for_deletion = true
      where client = ${c} and material_number = 'MAT-10001' and plant = '1000'
    `));
    await expect(postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'req-flag-1', lines: [{ itemNumber: 10, quantity: 1 }],
    })).rejects.toThrow('flagged for deletion');
  });
});
