import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createOrder } from '../src/modules/purchasing/orders';
import { createVendorDownPaymentRequest } from '../src/modules/finance/vendor-down-payment-request';
import { postVendorDownPayment } from '../src/modules/finance/vendor-down-payment';
import { getOrderAdvances } from '../src/modules/finance/vendor-down-payment-clearing';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'PO_ADVANCE_TEST';

/**
 * An advance raised against a purchase order belongs to that order. The rules that matter
 * are the ones that stop the same money being spent twice: the order has to be the
 * supplier's own, in the company the advance is posted in, and a payment cannot fulfil
 * requests raised against two different orders at once.
 */
describe('a vendor advance raised against a purchase order', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (client) return client;
    const tenant = await createTenant('purchase-order-advance');
    client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
      await tx.execute(sql`
        insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
        values (${client}, '1000', 'Advance purchasing organization', '1000', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${client}, 'V10000', 'ORGANIZATION', 'Advance supplier', ${ACTOR}),
               (${client}, 'V20000', 'ORGANIZATION', 'Other supplier', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${client}, 'V10000', 'SUPPLIER', ${ACTOR}),
               (${client}, 'V20000', 'SUPPLIER', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
        values (${client}, 'V10000', 'SUPPLIER', '1000', 'USD', ${ACTOR}),
               (${client}, 'V20000', 'SUPPLIER', '1000', 'USD', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
        values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_company_code (
          client, partner_number, role_code, company_code, chart_of_accounts,
          reconciliation_account, payment_terms_code, created_by
        )
        values (${client}, 'V10000', 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', ${ACTOR}),
               (${client}, 'V20000', 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into special_gl_config (
          client, company_code, account_type, indicator,
          alternative_reconciliation_account, target_special_gl_indicator, description, created_by
        )
        values
          (${client}, '', 'AP', 'A', '230000', null, 'Advances to suppliers', ${ACTOR}),
          (${client}, '', 'AP', 'F', '230000', 'A', 'Advance requests', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${client}, 'MAT-ADV', 'Advance material', 'RAW', 'PC', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, procurement_type, created_by)
        values (${client}, 'MAT-ADV', '1000', 'BUY', ${ACTOR}) on conflict do nothing
      `);
    });
    return client;
  }

  const item = {
    materialNumber: 'MAT-ADV', shortText: 'Advance material', quantity: 10, unit: 'PC',
    netPrice: 100, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '',
    markedForDeletion: false,
    scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 10 }],
    assignments: [] as never[],
  };

  const orderFor = async (c: string, supplierNumber: string) => createOrder({
    client: c, changedBy: ACTOR, supplierNumber, purchasingOrg: '1000',
    purchasingGroup: '001', companyCode: '1000', currency: '', items: [item],
  });

  const payment = (patch: Partial<Parameters<typeof postVendorDownPayment>[0]>) => ({
    client, changedBy: ACTOR,
    vendorNumber: 'V10000', companyCode: '1000',
    documentDate: '2026-10-20', postingDate: '2026-10-20',
    bankGlAccount: '101000', amount: 2000, currency: 'USD',
    specialGlIndicator: 'A',
    requestKey: `adv-${Math.random()}`,
    ...patch,
  });

  it('stands on the order it was raised against, and says how much is unspent', async () => {
    const c = await standingClient();
    const order = await orderFor(c, 'V10000');
    expect(await getOrderAdvances(c, order.orderNumber)).toEqual([]);

    const posted = await postVendorDownPayment(payment({ purchaseOrder: order.orderNumber }));
    const advances = await getOrderAdvances(c, order.orderNumber);
    expect(advances).toHaveLength(1);
    expect(advances[0]).toMatchObject({
      documentNumber: posted.journalDocumentNumber,
      amount: 2000, applied: 0, remaining: 2000, indicator: 'A',
    });

    // An advance against another order does not appear on this one.
    const other = await orderFor(c, 'V10000');
    expect(await getOrderAdvances(c, other.orderNumber)).toEqual([]);
  });

  it('refuses an order that is not the supplier’s own, and one that does not stand', async () => {
    const c = await standingClient();
    const theirs = await orderFor(c, 'V20000');

    await expect(postVendorDownPayment(payment({
      purchaseOrder: theirs.orderNumber, requestKey: 'adv-wrong-supplier',
    }))).rejects.toThrow(/was placed with supplier V20000/);

    await expect(postVendorDownPayment(payment({
      purchaseOrder: 'POF-9999999', requestKey: 'adv-no-order',
    }))).rejects.toThrow(/does not stand/);
  });

  it('takes the order from the request it fulfils, and refuses two requests that disagree', async () => {
    const c = await standingClient();
    const first = await orderFor(c, 'V10000');
    const second = await orderFor(c, 'V10000');

    const request = (orderNumber: string, reference: string) => createVendorDownPaymentRequest({
      client: c, changedBy: ACTOR,
      vendorNumber: 'V10000', companyCode: '1000',
      documentDate: '2026-10-18', postingDate: '2026-10-18', dueDate: '2026-11-01',
      amount: 1000, currency: 'USD', specialGlIndicator: 'F', documentType: 'KA',
      reference, purchaseOrder: orderNumber,
      requestKey: `req-${reference}`,
    });

    const raised = await request(first.orderNumber, 'ADV-REQ-1');
    expect(raised.purchaseOrder).toBe(first.orderNumber);

    // A payment that only names a request still belongs to the order the request named.
    await postVendorDownPayment(payment({
      amount: 1000, requestKey: 'adv-fulfils',
      requestAllocations: [{ requestNumber: raised.requestNumber }],
    }));
    const advances = await getOrderAdvances(c, first.orderNumber);
    expect(advances).toHaveLength(1);
    expect(advances[0]).toMatchObject({ amount: 1000, remaining: 1000 });

    const other = await request(second.orderNumber, 'ADV-REQ-2');
    await expect(postVendorDownPayment(payment({
      amount: 500, requestKey: 'adv-two-orders',
      requestAllocations: [
        { requestNumber: raised.requestNumber },
        { requestNumber: other.requestNumber },
      ],
    }))).rejects.toThrow(/was raised against/);

    // Naming the same order twice is not a disagreement.
    await postVendorDownPayment(payment({
      amount: 500, requestKey: 'adv-same-order', purchaseOrder: first.orderNumber,
      requestAllocations: [{ requestNumber: raised.requestNumber }],
    }));
    expect(await getOrderAdvances(c, first.orderNumber)).toHaveLength(2);
  });

  it('leaves a general advance to the vendor and not to any order', async () => {
    const c = await standingClient();
    await postVendorDownPayment(payment({ requestKey: 'adv-general' }));
    const rows = await withTenant(c, (tx) => tx.execute(sql`
      select purchase_order from vendor_down_payment
      where client = ${c} and request_key = 'adv-general'
    `));
    expect((rows as unknown as Array<{ purchase_order: string | null }>)[0].purchase_order).toBeNull();
  });
});
