import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postGoodsReceipt } from '../src/modules/inventory/goods-receipt';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { cancelSupplierInvoice, postSupplierInvoice } from '../src/modules/purchasing/invoice-verification';
import {
  InvoiceOverviewError,
  listInvoiceOverview,
  readInvoiceOverviewDocument,
} from '../src/modules/purchasing/invoice-overview';
import { parkSupplierInvoice } from '../src/modules/purchasing/parked-invoice';
import { createOrder } from '../src/modules/purchasing/orders';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR161_LIST';
const DATES = { invoiceDate: '2026-10-22', postingDate: '2026-10-22' };

/**
 * SCR-161 — the invoice list reads, and it does not post.
 *
 * A parked invoice has no accounting document. A posted invoice keeps its
 * journal. The fiscal year is the stored year. A closed period is not read.
 */
describe('SCR-161 invoice overview', () => {
  let client = '';
  let other = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
    if (other) await destroyTenant(other);
  });

  async function standing(): Promise<string> {
    if (client) return client;
    const tenant = await createTenant('scr161-invoice-overview');
    client = tenant.client;
    other = (await createTenant('scr161-invoice-overview-other')).client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'PARKINV', subObject: '*', prefix: 'PV', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'VENDINV', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
      await tx.execute(sql`
        insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
        values (${client}, '1000', 'Test purchasing organization', '1000', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchasing_group (client, purchasing_group, name, purchasing_org, created_by)
        values (${client}, '001', 'Buyer', '1000', ${ACTOR}) on conflict do nothing
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
        ) values (${client}, 'V10000', 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', ${ACTOR})
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
        ) values (${client}, 'MAT-10001', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', ${ACTOR})
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
      client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'Invoice overview acceptance',
    });
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
    assignments: [],
  });
  const line = (quantity: number, netAmount: number) => ({ itemNumber: 10, quantity, netAmount });

  async function counts(c: string) {
    const [row] = await withTenant(c, (tx) => tx.execute(sql`
      select
        (select count(*)::int from parked_supplier_invoice where client = ${c}) as parked,
        (select count(*)::int from supplier_invoice where client = ${c}) as posted,
        (select count(*)::int from journal_entry where client = ${c}) as journals,
        (select count(*)::int from change_document where client = ${c}) as changes
    `)) as unknown as Array<{ parked: number; posted: number; journals: number; changes: number }>;
    return row;
  }

  it('lists a park without a journal, and a posted invoice with one', async () => {
    const c = await standing();
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [item(5, 100)] });
    const parked = await parkSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, supplierReference: 'PARK-LIST',
      ...DATES, grossAmount: 800, lines: [line(8, 800)], requestKey: `park-${order.orderNumber}`,
    });
    await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      documentDate: '2026-10-22', postingDate: '2026-10-22',
      requestKey: `gr-${order.orderNumber}`, lines: [{ itemNumber: 10, quantity: 5 }],
    });
    const posted = await postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, supplierReference: 'POST-LIST',
      invoiceDate: '2026-10-22', postingDate: '2026-10-22', grossAmount: 500,
      requestKey: `post-${order.orderNumber}`, lines: [line(5, 500)],
    });
    const cancelled = await cancelSupplierInvoice({
      client: c, changedBy: ACTOR, invoiceNumber: posted.invoiceNumber,
      postingDate: '2026-10-22', requestKey: `cancel-${order.orderNumber}`,
    });
    await withTenant(c, (tx) => tx.execute(sql`
      insert into supplier_invoice (
        client, invoice_number, fiscal_year, category, supplier_number, company_code,
        purchase_order_number, invoice_date, posting_date, supplier_reference, currency,
        gross_amount, tax_amount, status, created_by
      ) values (
        ${c}, 'HIST-2025', 2025, 'INVOICE', 'V10000', '1000',
        ${order.orderNumber}, '2026-04-01', '2026-04-01', 'YEAR-2025', 'USD',
        40, 0, 'POSTED', ${ACTOR}
      )
    `));
    await withTenant(c, (tx) => tx.execute(sql`
      insert into supplier_invoice_item (
        client, invoice_number, line_number, purchase_order_number, purchase_order_item,
        quantity, unit, net_amount, expected_amount, tax_amount, created_by
      ) values
        (${c}, 'HIST-2025', 1, ${order.orderNumber}, 10, 1, 'PC', 20, 20, 0, ${ACTOR}),
        (${c}, 'HIST-2025', 2, ${order.orderNumber}, 10, 1, 'PC', 20, 20, 0, ${ACTOR})
    `));

    const before = await counts(c);
    const listed = await listInvoiceOverview({
      client: c,
      selection: { companyFrom: '1000', fiscalYear: '2026' },
    });
    expect(listed.wrote).toBe(false);
    expect(await counts(c)).toEqual(before);
    const park = listed.rows.find((row) => row.documentNumber === parked.parkedNumber);
    expect(park?.lifecycle).toBe('PARKED');
    expect(park?.postingDate).toBeNull();
    expect(park?.journalDocumentNumber).toBeNull();
    expect(park?.journalHref).toBeNull();
    expect(park?.paymentState).toBe('NOT_APPLICABLE');
    expect(park?.companyCurrencyAmount).toBeNull();
    expect(park?.category).toBeNull();
    expect(listed.rows.some((row) => row.documentNumber === 'HIST-2025')).toBe(false);

    const original = listed.rows.find((row) => row.documentNumber === posted.invoiceNumber);
    expect(original?.lifecycle).toBe('CANCELLED');
    expect(original?.cancelledBy).toBe(cancelled.invoiceNumber);
    expect(original?.postingDate).toBe('2026-10-22');
    expect(decodeURIComponent(original?.journalHref ?? '')).toContain(original?.journalDocumentNumber ?? 'missing');
    expect(original?.paymentState).toBe('OPEN');
    expect(original?.companyCurrencyAmount).toBeTruthy();
    const reversal = listed.rows.find((row) => row.documentNumber === cancelled.invoiceNumber);
    expect(reversal?.lifecycle).toBe('POSTED');
    expect(reversal?.cancellationOf).toBe(posted.invoiceNumber);
    expect(reversal?.category).toBe('INVOICE');
    expect(park?.currency).toBe(original?.currency);
    expect(listed.totals.every((total) => total.currency === park?.currency)).toBe(true);
    expect(listed.totals.some((total) => total.lifecycle === 'PARKED' && total.grossAmount === '800.0000')).toBe(true);
    const currencies = new Set(listed.totals.map((total) => `${total.lifecycle}:${total.currency}`));
    expect(currencies.size).toBe(listed.totals.length);

    const historical = await listInvoiceOverview({
      client: c,
      selection: { companyFrom: '1000', fiscalYear: '2025' },
    });
    expect(historical.rows).toHaveLength(1);
    expect(historical.rows[0].documentNumber).toBe('HIST-2025');
    expect(historical.rows[0].fiscalYear).toBe(2025);
    expect(historical.rows[0].postingDate).toBe('2026-04-01');
    expect(historical.rows[0].grossAmount).toBe('40.0000');
    expect(historical.counts.posted).toBe(1);

    const dated = await listInvoiceOverview({
      client: c,
      selection: { companyFrom: '1000', fiscalYear: '2026', postingDateFrom: '2026-10-22', postingDateTo: '2026-10-22' },
    });
    expect(dated.rows.some((row) => row.documentNumber === parked.parkedNumber)).toBe(false);
    expect(dated.warnings.some((warning) => warning.includes('no recorded posting date'))).toBe(true);
    expect(dated.rows.some((row) => row.documentNumber === posted.invoiceNumber)).toBe(true);

    const detail = await readInvoiceOverviewDocument(c, parked.parkedNumber);
    expect(detail?.wrote).toBe(false);
    expect(detail?.row.journalDocumentNumber).toBeNull();
    expect(detail?.lines).toHaveLength(1);
    expect(detail?.lines[0].quantity).toBe('8.000');
    expect(await readInvoiceOverviewDocument(other, parked.parkedNumber)).toBeNull();
    expect(await counts(c)).toEqual(before);
  });

  it('refuses what this list does not have, and an empty year is an empty list', async () => {
    const c = await standing();
    const base = { companyFrom: '1000', fiscalYear: '2026' };
    await expect(listInvoiceOverview({ client: c, selection: { ...base, draft: '1' } })).rejects.toThrow(/draft/i);
    await expect(listInvoiceOverview({ client: c, selection: { ...base, paymentBlock: 'BLOCKED' } })).rejects.toThrow(/payment block/i);
    await expect(listInvoiceOverview({ client: c, selection: { ...base, reversed: '1' } })).rejects.toThrow(/reversal/i);
    await expect(listInvoiceOverview({ client: c, selection: { ...base, export: '1' } })).rejects.toThrow(/export/i);
    await expect(listInvoiceOverview({ client: c, selection: { ...base, withoutOrder: '1' } })).rejects.toThrow(/without a purchase order/i);
    await expect(listInvoiceOverview({ client: c, selection: { ...base, companyAuthorization: '1' } })).rejects.toThrow(/no company-code authorization/i);
    await expect(listInvoiceOverview({ client: c, selection: { ...base, purchasingAuthorization: '1' } })).rejects.toThrow(/no purchasing-organisation authorization/i);
    await expect(listInvoiceOverview({ client: c, selection: { ...base, exchangeRate: '1' } })).rejects.toThrow(/does not convert/i);
    await expect(listInvoiceOverview({ client: c, selection: { ...base, post: '1' } })).rejects.toThrow(/does not post/i);
    await expect(listInvoiceOverview({ client: c, selection: { companyFrom: '1099', fiscalYear: '2026' } })).rejects.toThrow(/1099 does not stand/);
    await expect(listInvoiceOverview({ client: c, selection: { companyFrom: '1000' } })).rejects.toThrow(/fiscal year/i);
    const credit = await listInvoiceOverview({ client: c, selection: { ...base, category: 'CREDIT_MEMO' } });
    expect(credit.rows).toHaveLength(0);
    expect(credit.rows.some((row) => row.lifecycle === 'PARKED')).toBe(false);
    const missingYear = await listInvoiceOverview({ client: c, selection: { companyFrom: '1000', fiscalYear: '1999' } });
    expect(missingYear.rows).toHaveLength(0);
    await expect(listInvoiceOverview({ client: c, selection: { ...base, lifecycle: 'DRAFT' } })).rejects.toBeInstanceOf(InvoiceOverviewError);
  });
});
