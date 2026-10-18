import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createOrder } from '../src/modules/purchasing/orders';
import { postGoodsReceipt } from '../src/modules/inventory/goods-receipt';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import {
  cancelSupplierInvoice, getInvoiceOrder, getSupplierInvoice, postSupplierInvoice,
} from '../src/modules/purchasing/invoice-verification';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR062_MIRO_TEST';
const DATES = { documentDate: '2026-10-18', postingDate: '2026-10-18' };

/**
 * SCR-062 acceptance: invoiceable quantity from posted GR and
 * invoice history, the gross judged against net plus standing-rate
 * tax, variance to the price-difference account, duplicates refused,
 * and cancellation as a linked mirror restoring the quantity.
 */
describe('SCR-062 invoice verification (MIRO)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr062-invoice-verification');
      client = tenant.client;
      await defineTestRanges(tenant, { fiscalYear: 2026 });
      await withTenant(client, async (tx) => {
        await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
        await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
        await defineRange(tx, { client, objectCode: 'VENDINV', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
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
          insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
          values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into supplier_company_code (
            client, partner_number, role_code, company_code, chart_of_accounts,
            reconciliation_account, payment_terms_code, created_by
          )
          values (${client}, 'V10000', 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
          values (${client}, 'KW', 'T10', 'Input tax 10 percent', 'VAT', 10, ${ACTOR}) on conflict do nothing
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
                 (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR}),
                 (${client}, 'CA01', 'PRICE_DIFFERENCE', 'RAW_INVENTORY', '', '410200', ${ACTOR}),
                 (${client}, 'CA01', 'TAX', '', '', '140000', ${ACTOR})
          on conflict do nothing
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

  async function receivedOrder(c: string, key: string) {
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [item(5, 100)] });
    await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...DATES,
      requestKey: key, lines: [{ itemNumber: 10, quantity: 5 }],
    });
    return order;
  }

  it('verifies against history, reconciles the gross, and posts the balanced payable', async () => {
    const c = await standingClient();
    const order = await receivedOrder(c, 'gr-1');
    expect((await getInvoiceOrder(c, order.orderNumber))?.items[0])
      .toMatchObject({ received: 5, invoiced: 0, invoiceable: 5 });

    // The gross is judged, not derived: a wrong gross refuses naming the difference.
    await expect(postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-1', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 999, requestKey: 'iv-bad-gross',
      lines: [{ itemNumber: 10, quantity: 5, netAmount: 500, taxCode: 'T10' }],
    })).rejects.toThrow('does not reconcile');

    const invoice = await postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-1', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 550, requestKey: 'iv-1',
      lines: [{ itemNumber: 10, quantity: 5, netAmount: 500, taxCode: 'T10' }],
    });
    expect(invoice).toMatchObject({
      status: 'POSTED', taxAmount: '50.0000', paymentTerms: 'NET30',
      baselineDate: '2026-10-16', dueDate: '2026-11-15',
    });
    expect(invoice.items[0]).toMatchObject({ expectedAmount: '500.0000', varianceAmount: '0.0000' });

    const journal = await withTenant(c, (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_local, business_partner from journal_entry_line
      where client = ${c} and document_number = ${invoice.journalDocumentNumber}
    `));
    const lines = journal as unknown as Array<Record<string, string>>;
    const sum = (side: string) => lines.filter((l) => l.debit_credit === side)
      .reduce((s, l) => s + Number(l.amount_local), 0);
    expect(sum('S')).toBe(550);
    expect(sum('H')).toBe(550);
    expect(lines.find((l) => l.gl_account === '200000')?.business_partner).toBe('V10000');

    // A retry returns the standing document; a duplicate reference refuses.
    const replay = await postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-1', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 550, requestKey: 'iv-1',
      lines: [{ itemNumber: 10, quantity: 5, netAmount: 500, taxCode: 'T10' }],
    });
    expect(replay.invoiceNumber).toBe(invoice.invoiceNumber);
    await expect(postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-1', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 550, requestKey: 'iv-duplicate',
      lines: [{ itemNumber: 10, quantity: 5, netAmount: 500, taxCode: 'T10' }],
    })).rejects.toThrow('already stands posted');
    // And nothing invoiceable remains.
    await expect(postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-2', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 110, requestKey: 'iv-over',
      lines: [{ itemNumber: 10, quantity: 1, netAmount: 100, taxCode: 'T10' }],
    })).rejects.toThrow('exceeds the invoiceable quantity');
  });

  it('posts price variance to the difference account and cancels as a linked mirror', async () => {
    const c = await standingClient();
    const order = await receivedOrder(c, 'gr-2');
    const invoice = await postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-VAR', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 572, requestKey: 'iv-var',
      lines: [{ itemNumber: 10, quantity: 5, netAmount: 520, taxCode: 'T10' }],
    });
    expect(invoice.items[0]).toMatchObject({ expectedAmount: '500.0000', varianceAmount: '20.0000' });
    const journal = await withTenant(c, (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_local from journal_entry_line
      where client = ${c} and document_number = ${invoice.journalDocumentNumber}
    `));
    const lines = journal as unknown as Array<Record<string, string>>;
    expect(lines.find((l) => l.gl_account === '410200')).toMatchObject({ debit_credit: 'S', amount_local: '20.0000' });

    const cancellation = await cancelSupplierInvoice({
      client: c, changedBy: ACTOR, invoiceNumber: invoice.invoiceNumber,
      postingDate: '2026-10-19', requestKey: 'iv-cancel-1',
    });
    expect(cancellation.cancellationOf).toBe(invoice.invoiceNumber);
    const original = await getSupplierInvoice(c, invoice.invoiceNumber);
    expect(original?.status).toBe('CANCELLED');
    expect(original?.cancelledBy).toBe(cancellation.invoiceNumber);
    expect((await getInvoiceOrder(c, order.orderNumber))?.items[0].invoiceable).toBe(5);
    const journalStatus = await withTenant(c, (tx) => tx.execute(sql`
      select status from journal_entry
      where client = ${c} and document_number = ${invoice.journalDocumentNumber}
    `));
    expect((journalStatus as unknown as Array<{ status: string }>)[0].status).toBe('REVERSED');
    await expect(cancelSupplierInvoice({
      client: c, changedBy: ACTOR, invoiceNumber: invoice.invoiceNumber,
      postingDate: '2026-10-19', requestKey: 'iv-cancel-2',
    })).rejects.toThrow('already been cancelled');
  });
});
