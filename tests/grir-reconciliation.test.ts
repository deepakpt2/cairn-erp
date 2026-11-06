import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createOrder } from '../src/modules/purchasing/orders';
import { postSupplierInvoice } from '../src/modules/purchasing/invoice-verification';
import { listGrIrExceptions } from '../src/modules/purchasing/grir-reconciliation';

import { postGoodsReceipt } from './helpers/goods-receipt-authorized';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'GRIR_RECON_TEST';
const DATES = { documentDate: '2026-10-18', postingDate: '2026-10-18' };
const PRICE = 1000;

/**
 * The GR/IR exception worklist.
 *
 * A balance on the GR/IR account is not a fault: goods arrive before the invoice
 * as a matter of course, and a balance is then the ordinary state of a healthy
 * order. What the worklist has to get right is which balances still explain
 * themselves and which do not — and in particular that the two completion
 * indicators are reporting, never accounting:
 *
 *   * delivery completed with everything invoiced creates no balance, and must
 *     not appear to.
 *
 *   * delivery completed with goods still uninvoiced leaves a real balance that
 *     has to stay visible.
 *
 *   * a final invoice with everything received reconciles, and must not appear.
 *
 *   * a final invoice ahead of the goods leaves a balance that waits for the
 *     goods. It is never netted off because invoicing happens to be finished.
 *
 * The list itself writes nothing.
 */
describe('the GR/IR reconciliation worklist', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (client) return client;
    const tenant = await createTenant('grir-reconciliation');
    client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'VENDINV', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
      await tx.execute(sql`
        insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
        values (${client}, '1000', 'Reconciliation purchasing organization', '1000', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${client}, 'V10000', 'ORGANIZATION', 'Reconciliation Supplier', ${ACTOR}) on conflict do nothing
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
        insert into supplier_company_code (
          client, partner_number, role_code, company_code, chart_of_accounts,
          reconciliation_account, payment_terms_code, created_by
        )
        values (${client}, 'V10000', 'SUPPLIER', '1000', 'CA01', '200000', null, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${client}, 'MAT-REC', 'Reconciliation material', 'RAW', 'PC', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, procurement_type, overdelivery_tolerance, created_by)
        values (${client}, 'MAT-REC', '1000', 'BUY', 0, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (
          client, material_number, valuation_area, valuation_class, price_control,
          standard_price, moving_average_price, price_unit, currency, created_by
        )
        values (${client}, 'MAT-REC', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        values (${client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', ${ACTOR}),
               (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR}),
               (${client}, 'CA01', 'PRICE_DIFFERENCE', 'RAW_INVENTORY', '', '410200', ${ACTOR}),
               (${client}, 'CA01', 'TAX', '', '', '140000', ${ACTOR})
        on conflict do nothing
      `);
    });
    await initializeMaterialPeriodControl({
      client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'GR/IR reconciliation acceptance',
    });
    return client;
  }

  const header = {
    supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '',
  };

  const line = (quantity: number, patch: Record<string, unknown> = {}) => ({
    materialNumber: 'MAT-REC', shortText: 'Reconciliation material', quantity, unit: 'PC',
    netPrice: PRICE, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '',
    markedForDeletion: false,
    scheduleLines: [{ deliveryDate: '2026-11-15', quantity }],
    assignments: [] as never[],
    ...patch,
  });

  /** Set a completion indicator directly: this is a fixture, not a bypass. */
  async function mark(c: string, orderNumber: string, itemNumber: number, column: 'delivery_completed' | 'final_invoice_indicator') {
    await withTenant(c, (tx) => tx.execute(
      sql.raw(`update purchase_order_item set ${column} = true where client = '${c}'`
        + ` and order_number = '${orderNumber}' and item_number = ${itemNumber}`),
    ));
  }

  async function position(c: string, keyDate = '2026-10-31') {
    return listGrIrExceptions({ client: c, companyFrom: '1000', keyDate });
  }

  it('says which balances still explain themselves and which do not', async () => {
    const c = await standingClient();

    const order = await createOrder({
      client: c, changedBy: ACTOR, ...header,
      items: [
        line(100),                                              // 10: 90 received,  90 invoiced,  delivery complete
        line(100),                                              // 20: 100 received, 90 invoiced,  delivery complete
        line(100),                                              // 30: 100 received, 100 invoiced, final invoice
        line(100, { grBasedInvoiceVerification: false }),       // 40:  90 received, 100 invoiced, final invoice
        line(100),                                              // 50:  50 received,   0 invoiced, nothing closed
        line(10),                                               // 60:  10 received,  10 invoiced, price rose after receipt
      ],
    });

    await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...DATES,
      requestKey: 'recon-gr',
      lines: [
        { itemNumber: 10, quantity: 90 },
        { itemNumber: 20, quantity: 100 },
        { itemNumber: 30, quantity: 100 },
        { itemNumber: 40, quantity: 90 },
        { itemNumber: 50, quantity: 50 },
        { itemNumber: 60, quantity: 10 },
      ],
    });

    // The goods stand received at the old price; the invoice comes in at the new one.
    await withTenant(c, (tx) => tx.execute(sql`
      update purchase_order_item set net_price = 1200
      where client = ${c} and order_number = ${order.orderNumber} and item_number = 60
    `));

    const invoice = await postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-RECON', invoiceDate: '2026-10-20', postingDate: '2026-10-20',
      grossAmount: 392000, requestKey: 'recon-invoice',
      lines: [
        { itemNumber: 10, quantity: 90, netAmount: 90000 },
        { itemNumber: 20, quantity: 90, netAmount: 90000 },
        { itemNumber: 30, quantity: 100, netAmount: 100000 },
        { itemNumber: 40, quantity: 100, netAmount: 100000 },
        { itemNumber: 60, quantity: 10, netAmount: 12000 },
      ],
    });

    await mark(c, order.orderNumber, 10, 'delivery_completed');
    await mark(c, order.orderNumber, 20, 'delivery_completed');
    await mark(c, order.orderNumber, 30, 'final_invoice_indicator');
    await mark(c, order.orderNumber, 40, 'final_invoice_indicator');

    const result = await position(c);
    const byItem = new Map(result.rows.map((row) => [row.itemNumber, row]));

    // (i) delivery complete, all invoiced: no balance, so nothing artificial appears.
    expect(byItem.has(10)).toBe(false);
    // (iii) final invoice, all received: reconciled, and it says nothing.
    expect(byItem.has(30)).toBe(false);

    // (ii) delivery complete with goods still uninvoiced: a real balance, still visible.
    expect(byItem.get(20)).toMatchObject({
      category: 'COMPLETED_WITH_RESIDUAL',
      deliveryCompleted: true,
      finalInvoiceIndicator: false,
      grIrBalance: 10000,
      invoicedQuantity: 90,
      receivedQuantity: 100,
      outstandingInvoiceQuantity: 10,
      outstandingGrQuantity: 0,
    });

    // (iv) final invoice ahead of the goods: it waits for the goods, and is not netted off.
    expect(byItem.get(40)).toMatchObject({
      category: 'INVOICE_BEFORE_GR',
      deliveryCompleted: false,
      finalInvoiceIndicator: true,
      grIrBalance: -10000,
      invoicedQuantity: 100,
      receivedQuantity: 90,
      // Ten units of goods still to come. Nothing more may be invoiced: this item
      // invoices against the quantity ordered, and all of that stands invoiced.
      outstandingGrQuantity: 10,
      outstandingInvoiceQuantity: 0,
    });

    // Neither delivery nor invoicing is finished, so the balance is still moving.
    expect(byItem.get(50)).toMatchObject({
      category: 'EXPECTED_OUTSTANDING',
      grIrBalance: 50000,
      receivedQuantity: 50,
      invoicedQuantity: 0,
    });

    // Quantities agree; the difference is the price the goods were received at.
    expect(byItem.get(60)).toMatchObject({
      category: 'VALUE_VARIANCE',
      grIrBalance: -2000,
      receivedQuantity: 10,
      invoicedQuantity: 10,
    });

    expect(result.totals.rows).toBe(4);
    expect(result.totals.balance).toBe(72000);
    expect(result.totals.byCategory).toMatchObject({
      COMPLETED_WITH_RESIDUAL: 1, INVOICE_BEFORE_GR: 1,
      EXPECTED_OUTSTANDING: 1, VALUE_VARIANCE: 1, UNRESOLVED: 0,
    });

    // The worklist can be walked back to the documents that made the position.
    expect(byItem.get(20)?.documents.invoices).toEqual([invoice.invoiceNumber]);
    expect(byItem.get(20)?.documents.goodsReceipts).toHaveLength(1);
    expect(byItem.get(50)?.documents.invoices).toEqual([]);
  });

  it('writes nothing, whatever it finds', async () => {
    const c = await standingClient();
    const before = await withTenant(c, (tx) => tx.execute(sql`
      select
        (select count(*)::int from journal_entry where client = ${c}) as journals,
        (select count(*)::int from gr_ir_maintenance_link where client = ${c}) as clearings,
        (select count(*)::int from material_document where client = ${c}) as movements
    `)) as unknown as Array<Record<string, number>>;

    const first = await position(c);
    const again = await position(c);
    expect(again.totals).toEqual(first.totals);

    const after = await withTenant(c, (tx) => tx.execute(sql`
      select
        (select count(*)::int from journal_entry where client = ${c}) as journals,
        (select count(*)::int from gr_ir_maintenance_link where client = ${c}) as clearings,
        (select count(*)::int from material_document where client = ${c}) as movements
    `)) as unknown as Array<Record<string, number>>;
    expect(after[0]).toEqual(before[0]);
  });

  it('answers a selection, and refuses one it cannot judge', async () => {
    const c = await standingClient();
    const all = await position(c);
    const one = await listGrIrExceptions({
      client: c, companyFrom: '1000', keyDate: '2026-10-31', categories: ['COMPLETED_WITH_RESIDUAL'],
    });
    expect(one.rows.length).toBeGreaterThan(0);
    expect(one.rows.every((row) => row.category === 'COMPLETED_WITH_RESIDUAL')).toBe(true);
    expect(one.rows.length).toBeLessThan(all.rows.length);

    await expect(listGrIrExceptions({ client: c, companyFrom: '', keyDate: '2026-10-31' }))
      .rejects.toThrow('company code');
  });
});
