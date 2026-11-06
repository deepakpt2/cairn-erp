import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createOrder } from '../src/modules/purchasing/orders';
import { postVendorDownPayment } from '../src/modules/finance/vendor-down-payment';
import { getOrderAdvances } from '../src/modules/finance/vendor-down-payment-clearing';
import {
  cancelSupplierInvoice, getSupplierInvoice, postSupplierInvoice,
} from '../src/modules/purchasing/invoice-verification';

import { postGoodsReceipt } from './helpers/goods-receipt-authorized';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'INV_ADVANCE_TEST';
const DATES = { documentDate: '2026-10-18', postingDate: '2026-10-18' };

/**
 * An advance settled in the invoice workflow.
 *
 * The rules that matter all concern value that must not appear or disappear:
 *
 *   * the invoice is worth what it says it is worth. Clearing an advance against
 *     it moves money that was already paid; it is not a discount, so neither the
 *     gross nor the taxable base changes.
 *
 *   * an advance can only be spent once, and never for more than it stands at.
 *
 *   * when the invoice is cancelled, the settlement comes off with it. An advance
 *     left cleared against an invoice that no longer stands would be spent twice.
 */
describe('an advance cleared against a supplier invoice', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (client) return client;
    const tenant = await createTenant('invoice-advance-clearing');
    client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'VENDINV', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'VENDDPREQ', subObject: '*', prefix: 'VR', numberLength: 7, createdBy: ACTOR });
      await tx.execute(sql`
        insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
        values (${client}, '1000', 'Advance clearing organization', '1000', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
        values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
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
        insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
        values (${client}, 'KW', 'T10', 'Input tax 10 percent', 'VAT', 10, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${client}, 'MAT-ADV', 'Advance clearing material', 'RAW', 'PC', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, procurement_type, overdelivery_tolerance, created_by)
        values (${client}, 'MAT-ADV', '1000', 'BUY', 0, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (
          client, material_number, valuation_area, valuation_class, price_control,
          standard_price, moving_average_price, price_unit, currency, created_by
        )
        values (${client}, 'MAT-ADV', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', ${ACTOR})
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
      client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'Advance clearing acceptance',
    });
    return client;
  }

  /**
   * Each case gets its own supplier, so the balance a case reads is the balance
   * its own documents created and nothing else's.
   */
  async function supplier(c: string, partnerNumber: string): Promise<string> {
    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${c}, ${partnerNumber}, 'ORGANIZATION', ${`Supplier ${partnerNumber}`}, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${c}, ${partnerNumber}, 'SUPPLIER', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
        values (${c}, ${partnerNumber}, 'SUPPLIER', '1000', 'USD', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_company_code (
          client, partner_number, role_code, company_code, chart_of_accounts,
          reconciliation_account, payment_terms_code, created_by
        )
        values (${c}, ${partnerNumber}, 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', ${ACTOR})
        on conflict do nothing
      `);
    });
    return partnerNumber;
  }

  const header = (supplierNumber: string) => ({
    supplierNumber, purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '',
  });
  const item = {
    materialNumber: 'MAT-ADV', shortText: 'Advance clearing material', quantity: 100, unit: 'PC',
    netPrice: 1000, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '',
    markedForDeletion: false,
    scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 100 }],
    assignments: [] as never[],
  };

  let sequence = 0;
  const next = (name: string) => `${name}-${(sequence += 1)}`;

  /** An order whose goods have all arrived, so the whole quantity is invoiceable. */
  async function receivedOrder(c: string, vendorNumber: string) {
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header(vendorNumber), items: [item] });
    await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...DATES,
      requestKey: next('gr'), lines: [{ itemNumber: 10, quantity: 100 }],
    });
    return order;
  }

  async function advanceFor(c: string, vendorNumber: string, orderNumber: string, amount: number) {
    return postVendorDownPayment({
      client: c, changedBy: ACTOR,
      vendorNumber, companyCode: '1000',
      documentDate: '2026-10-10', postingDate: '2026-10-10',
      bankGlAccount: '101000', amount, currency: 'USD',
      specialGlIndicator: 'A', purchaseOrder: orderNumber,
      requestKey: next('advance'),
    });
  }

  /**
   * What the supplier still stands to be paid: the net of the open items on the
   * reconciliation account. A reversed document is not excluded here — its lines
   * are cancelled by the reversal document's own lines, which are open too, and
   * dropping one side of that pair would count the undoing twice.
   */
  async function payableTo(c: string, vendorNumber: string): Promise<number> {
    const rows = await withTenant(c, (tx) => tx.execute(sql`
      select coalesce(sum(
        case when l.debit_credit = 'H' then l.amount_local else -l.amount_local end
      ), 0) as total
      from journal_entry_line l
      where l.client = ${c} and l.gl_account = '200000' and l.business_partner = ${vendorNumber}
        and l.clearing_document is null
    `));
    return Math.round(Number((rows as unknown as Array<{ total: string }>)[0].total) * 100) / 100;
  }

  it('settles what was already paid and leaves the rest standing as a liability', async () => {
    const c = await standingClient();
    const vendor = await supplier(c, 'V10010');
    const order = await receivedOrder(c, vendor);
    // Money out of the bank, and nothing yet owed to the supplier: an advance is
    // not a payable, it is a payment waiting for the invoice that earns it.
    const advance = await advanceFor(c, vendor, order.orderNumber, 30000);
    expect(await payableTo(c, vendor)).toBe(0);

    const invoice = await postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-ADV-1', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 100000, requestKey: next('invoice'),
      lines: [{ itemNumber: 10, quantity: 100, netAmount: 100000 }],
      advances: [{ paymentNumber: advance.journalDocumentNumber }],
    });

    // The invoice is still worth what it says. Nothing was discounted.
    expect(invoice.grossAmount).toBe('100000.0000');
    expect(invoice.taxAmount).toBe('0.0000');
    expect(invoice.advanceApplied).toBe('30000.00');
    expect(invoice.remainingPayable).toBe('70000.00');
    expect(invoice.settlements).toHaveLength(1);
    expect(invoice.settlements[0]).toMatchObject({
      indicator: 'A', totalApplied: '30000.0000', reversed: false,
    });

    // The supplier is owed the difference, not the whole.
    expect(await payableTo(c, vendor)).toBe(70000);
    // And the advance is spent: its open line stands cleared, for the whole of it.
    const spent = await withTenant(c, (tx) => tx.execute(sql`
      select clearing_document, amount_local from journal_entry_line
      where client = ${c} and document_number = ${advance.journalDocumentNumber} and gl_account = '230000'
    `)) as unknown as Array<{ clearing_document: string | null; amount_local: string }>;
    expect(spent).toHaveLength(1);
    expect(spent[0].clearing_document).toBe(invoice.settlements[0].journalDocumentNumber);
    expect(Number(spent[0].amount_local)).toBe(30000);
    // What is spent no longer stands on offer.
    expect(await getOrderAdvances(c, order.orderNumber)).toEqual([]);

    // The clearing names both documents, so the trail answers in either direction.
    const rows = await withTenant(c, (tx) => tx.execute(sql`
      select invoice_number, purchase_order, total_applied, journal_document_number
      from vendor_down_payment_clearing where client = ${c}
    `)) as unknown as Array<Record<string, string>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      invoice_number: invoice.invoiceNumber,
      purchase_order: order.orderNumber,
      total_applied: '30000.0000',
      journal_document_number: invoice.settlements[0].journalDocumentNumber,
    });
  });

  it('leaves the taxable base alone: tax is charged on the invoice, not on what is left', async () => {
    const c = await standingClient();
    const vendor = await supplier(c, 'V10020');
    const order = await receivedOrder(c, vendor);
    const advance = await advanceFor(c, vendor, order.orderNumber, 30000);

    const invoice = await postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-ADV-TAX', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 110000, requestKey: next('invoice'),
      lines: [{ itemNumber: 10, quantity: 100, netAmount: 100000, taxCode: 'T10' }],
      advances: [{ paymentNumber: advance.journalDocumentNumber, amount: 30000 }],
    });
    // Ten percent of the full 100,000 — the advance is not a price reduction.
    expect(invoice.taxAmount).toBe('10000.0000');
    expect(invoice.advanceApplied).toBe('30000.00');
    expect(invoice.remainingPayable).toBe('80000.00');
    expect(await payableTo(c, vendor)).toBe(80000);
  });

  it('clears part of an advance and keeps the rest of it for later', async () => {
    const c = await standingClient();
    const vendor = await supplier(c, 'V10030');
    const order = await receivedOrder(c, vendor);
    const advance = await advanceFor(c, vendor, order.orderNumber, 30000);

    const invoice = await postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-ADV-PART', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 100000, requestKey: next('invoice'),
      lines: [{ itemNumber: 10, quantity: 100, netAmount: 100000 }],
      advances: [{ paymentNumber: advance.journalDocumentNumber, amount: 10000 }],
    });
    expect(invoice.advanceApplied).toBe('10000.00');
    expect(invoice.remainingPayable).toBe('90000.00');
    expect(await payableTo(c, vendor)).toBe(90000);
    const [left] = await getOrderAdvances(c, order.orderNumber);
    expect(left).toMatchObject({ applied: 10000, remaining: 20000 });
  });

  it('refuses to clear more than the invoice is worth', async () => {
    const c = await standingClient();
    const vendor = await supplier(c, 'V10040');
    const order = await receivedOrder(c, vendor);
    const advance = await advanceFor(c, vendor, order.orderNumber, 30000);

    await expect(postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-ADV-OVER', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 10000, requestKey: next('invoice'),
      lines: [{ itemNumber: 10, quantity: 10, netAmount: 10000 }],
      advances: [{ paymentNumber: advance.journalDocumentNumber }],
    })).rejects.toThrow('exceeds the invoice gross');

    // Nothing posted: neither an invoice nor a settlement came of it.
    expect(await payableTo(c, vendor)).toBe(0);
    const [left] = await getOrderAdvances(c, order.orderNumber);
    expect(left).toMatchObject({ remaining: 30000 });
  });

  it('refuses to spend an advance twice', async () => {
    const c = await standingClient();
    const vendor = await supplier(c, 'V10050');
    const first = await receivedOrder(c, vendor);
    const advance = await advanceFor(c, vendor, first.orderNumber, 30000);

    await postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: first.orderNumber,
      supplierReference: 'INV-ADV-TWICE-1', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 100000, requestKey: next('invoice'),
      lines: [{ itemNumber: 10, quantity: 100, netAmount: 100000 }],
      advances: [{ paymentNumber: advance.journalDocumentNumber }],
    });

    const second = await receivedOrder(c, vendor);
    await expect(postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: second.orderNumber,
      supplierReference: 'INV-ADV-TWICE-2', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 100000, requestKey: next('invoice'),
      lines: [{ itemNumber: 10, quantity: 100, netAmount: 100000 }],
      advances: [{ paymentNumber: advance.journalDocumentNumber }],
    })).rejects.toThrow('stands fully cleared already');
  });

  it('refuses an advance named twice, and one that does not stand', async () => {
    const c = await standingClient();
    const vendor = await supplier(c, 'V10060');
    const order = await receivedOrder(c, vendor);
    const advance = await advanceFor(c, vendor, order.orderNumber, 30000);

    // Naming the same advance twice says nothing about value; it is simply refused.
    await expect(postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-ADV-DUP', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 100000, requestKey: next('invoice'),
      lines: [{ itemNumber: 10, quantity: 100, netAmount: 100000 }],
      advances: [
        { paymentNumber: advance.journalDocumentNumber, amount: 1000 },
        { paymentNumber: advance.journalDocumentNumber, amount: 1000 },
      ],
    })).rejects.toThrow('is named twice');

    await expect(postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-ADV-GHOST', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 100000, requestKey: next('invoice'),
      lines: [{ itemNumber: 10, quantity: 100, netAmount: 100000 }],
      advances: [{ paymentNumber: 'NOT-A-PAYMENT' }],
    })).rejects.toThrow('does not stand');

    expect(await payableTo(c, vendor)).toBe(0);
  });

  it('takes the settlement off again when the invoice is cancelled', async () => {
    const c = await standingClient();
    const vendor = await supplier(c, 'V10070');
    const order = await receivedOrder(c, vendor);
    const advance = await advanceFor(c, vendor, order.orderNumber, 30000);
    const invoice = await postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-ADV-CANCEL', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 100000, requestKey: next('invoice'),
      lines: [{ itemNumber: 10, quantity: 100, netAmount: 100000 }],
      advances: [{ paymentNumber: advance.journalDocumentNumber }],
    });
    expect(await payableTo(c, vendor)).toBe(70000);

    const cancelled = await cancelSupplierInvoice({
      client: c, changedBy: ACTOR, invoiceNumber: invoice.invoiceNumber,
      postingDate: '2026-10-20', requestKey: next('cancel'),
    });
    // The cancellation is its own posted document; the original stands cancelled.
    expect(cancelled.cancellationOf).toBe(invoice.invoiceNumber);
    const original = await getSupplierInvoice(c, invoice.invoiceNumber);
    expect(original).toMatchObject({ status: 'CANCELLED', cancelledBy: cancelled.invoiceNumber });
    expect(Number(original?.advanceApplied)).toBe(0);
    expect(original?.settlements[0]).toMatchObject({ reversed: true });

    // The advance stands open again: it was never spent, because the invoice is gone.
    const [restored] = await getOrderAdvances(c, order.orderNumber);
    expect(restored).toMatchObject({ applied: 0, remaining: 30000 });
    // And nothing is owed to the supplier any more.
    expect(await payableTo(c, vendor)).toBe(0);

    const standing = await withTenant(c, (tx) => tx.execute(sql`
      select c.clearing_number, j.status
      from vendor_down_payment_clearing c
      join journal_entry j
        on j.client = c.client and j.document_number = c.journal_document_number
           and j.fiscal_year = c.fiscal_year
      where c.client = ${c} and c.invoice_number = ${invoice.invoiceNumber}
    `)) as unknown as Array<{ clearing_number: string; status: string }>;
    expect(standing).toHaveLength(1);
    expect(standing[0].status).toBe('REVERSED');
  });

  it('posts once: the same request key returns the standing document and clears nothing twice', async () => {
    const c = await standingClient();
    const vendor = await supplier(c, 'V10080');
    const order = await receivedOrder(c, vendor);
    const advance = await advanceFor(c, vendor, order.orderNumber, 30000);
    const key = next('invoice');
    const request = {
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-ADV-REPLAY', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 100000, requestKey: key,
      lines: [{ itemNumber: 10, quantity: 100, netAmount: 100000 }],
      advances: [{ paymentNumber: advance.journalDocumentNumber }],
    };

    const first = await postSupplierInvoice(request);
    const again = await postSupplierInvoice(request);
    expect(again.invoiceNumber).toBe(first.invoiceNumber);
    expect(Number(again.advanceApplied)).toBe(30000);

    const rows = await withTenant(c, (tx) => tx.execute(sql`
      select count(*)::int as n from vendor_down_payment_clearing
      where client = ${c} and invoice_number = ${first.invoiceNumber}
    `)) as unknown as Array<{ n: number }>;
    expect(rows[0].n).toBe(1);
    expect(await payableTo(c, vendor)).toBe(70000);
  });
});
