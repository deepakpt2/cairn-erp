import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { suggestConstrainedValues } from '../src/modules/foundation/constrained-values';
import { postGoodsReceipt } from '../src/modules/inventory/goods-receipt';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { createOrder } from '../src/modules/purchasing/orders';
import { postSupplierInvoice } from '../src/modules/purchasing/invoice-verification';
import {
  ParkedInvoiceError,
  changeParkedInvoice,
  deleteParkedInvoice,
  getParkedInvoice,
  parkSupplierInvoice,
  postParkedInvoice,
  previewParkedInvoice,
} from '../src/modules/purchasing/parked-invoice';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR160_PARK';
const DATES = { invoiceDate: '2026-10-22', postingDate: '2026-10-22' };

/**
 * SCR-160 — a parked supplier invoice is not a posted invoice.
 *
 * A check writes nothing. A park draws PARKINV and does not draw VENDINV.
 * Received and invoiced quantities are unchanged. A later posted invoice
 * still sees the receipt. A closed period is not read.
 */
describe('SCR-160 parked supplier invoice', () => {
  let client = '';
  let other = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
    if (other) await destroyTenant(other);
  });

  async function standing(): Promise<string> {
    if (client) return client;
    const tenant = await createTenant('scr160-parked-invoice');
    client = tenant.client;
    other = (await createTenant('scr160-parked-invoice-other')).client;
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
      client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'Parked invoice acceptance',
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
    assignments: [] as never[],
  });

  async function counts(c: string) {
    const [row] = await withTenant(c, (tx) => tx.execute(sql`
      select
        (select count(*)::int from parked_supplier_invoice where client = ${c}) as parked,
        (select count(*)::int from supplier_invoice where client = ${c}) as posted,
        (select count(*)::int from journal_entry where client = ${c}) as journals,
        (select count(*)::int from material_document where client = ${c}) as movements,
        (select current_number::int from number_range where client = ${c} and object_code = 'PARKINV') as park_drawn,
        (select current_number::int from number_range where client = ${c} and object_code = 'VENDINV') as invoice_drawn
    `)) as unknown as Array<{
      parked: number; posted: number; journals: number; movements: number; park_drawn: number; invoice_drawn: number;
    }>;
    return row;
  }

  function line(quantity: number, netAmount: number) {
    return { itemNumber: 10, quantity, netAmount };
  }

  it('checks without writing, then parks without posting or consuming the order', async () => {
    const c = await standing();
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [item(5, 100)] });
    const before = await counts(c);
    const preview = await previewParkedInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, supplierReference: 'PARK-1',
      ...DATES, grossAmount: 800, lines: [line(8, 800)],
    });
    expect(preview.parkedNumber).toBeNull();
    expect(preview.notes.some((note) => note.includes('nothing has been received'))).toBe(true);
    expect(preview.paymentTerms).toBe('NET30');
    expect(preview.dueDate).toBe('2026-11-21');
    expect(await counts(c)).toEqual(before);

    const parked = await parkSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, supplierReference: 'PARK-1',
      ...DATES, grossAmount: 800, headerText: 'Held for the receipt', lines: [line(8, 800)],
      requestKey: 'park-1',
    });
    expect(parked.parkedNumber).toMatch(/^PV-/);
    expect(parked.currency).toBe('USD');
    expect(parked.lines[0].invoiced).toBe('0');
    expect(parked.history.some((entry) => entry.changeType === 'CREATE')).toBe(true);
    const after = await counts(c);
    expect(after.parked).toBe(before.parked + 1);
    expect(after.posted).toBe(before.posted);
    expect(after.journals).toBe(before.journals);
    expect(after.movements).toBe(before.movements);
    expect(after.park_drawn).toBe(before.park_drawn + 1);
    expect(after.invoice_drawn).toBe(before.invoice_drawn);

    const replay = await parkSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, supplierReference: 'PARK-1',
      ...DATES, grossAmount: 800, lines: [line(8, 800)], requestKey: 'park-1',
    });
    expect(replay.parkedNumber).toBe(parked.parkedNumber);
    expect((await counts(c)).parked).toBe(after.parked);
    expect(await getParkedInvoice(other, parked.parkedNumber)).toBeNull();
  });

  it('does not consume a receipt, and invoice verification can still post it', async () => {
    const c = await standing();
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [item(5, 100)] });
    await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      documentDate: '2026-10-22', postingDate: '2026-10-22',
      requestKey: `gr-${order.orderNumber}`, lines: [{ itemNumber: 10, quantity: 5 }],
    });
    const parked = await parkSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, supplierReference: `OVER-${order.orderNumber}`,
      ...DATES, grossAmount: 800, lines: [line(8, 800)], requestKey: `over-${order.orderNumber}`,
    });
    expect(parked.notes.some((note) => note.includes('above the invoiceable quantity'))).toBe(true);
    expect(parked.lines[0].invoiced).toBe('0');
    expect(parked.lines[0].received).toBe('5');
    await expect(postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, supplierReference: `OVER-${order.orderNumber}`,
      invoiceDate: '2026-10-22', postingDate: '2026-10-22', grossAmount: 500,
      requestKey: `blocked-${order.orderNumber}`, lines: [line(5, 500)],
    })).rejects.toThrow(parked.parkedNumber);

    const posted = await postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, supplierReference: `POST-${order.orderNumber}`,
      invoiceDate: '2026-10-22', postingDate: '2026-10-22', grossAmount: 500,
      requestKey: `post-${order.orderNumber}`, lines: [line(5, 500)],
    });
    expect(posted.invoiceNumber).toBeTruthy();
    const again = await getParkedInvoice(c, parked.parkedNumber);
    expect(again?.lines[0].quantity).toBe('8');
    expect(again?.lines[0].invoiced).toBe('5');
    expect(again?.lines[0].invoiceable).toBe('0');
  });

  it('refuses a posted reference, a second parked reference, and a stale change', async () => {
    const c = await standing();
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [item(5, 100)] });
    await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      documentDate: '2026-10-22', postingDate: '2026-10-22',
      requestKey: `gr-dup-${order.orderNumber}`, lines: [{ itemNumber: 10, quantity: 5 }],
    });
    const posted = await postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, supplierReference: 'USED-REF',
      invoiceDate: '2026-10-22', postingDate: '2026-10-22', grossAmount: 100,
      requestKey: `used-${order.orderNumber}`, lines: [line(1, 100)],
    });
    await expect(parkSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, supplierReference: 'USED-REF',
      ...DATES, grossAmount: 100, lines: [line(1, 100)], requestKey: `dup-${order.orderNumber}`,
    })).rejects.toThrow(`invoice ${posted.invoiceNumber}`);

    const first = await parkSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, supplierReference: 'PARK-A',
      ...DATES, grossAmount: 100, lines: [line(1, 100)], requestKey: `a-${order.orderNumber}`,
    });
    await expect(parkSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, supplierReference: 'PARK-A',
      ...DATES, grossAmount: 100, lines: [line(1, 100)], requestKey: `b-${order.orderNumber}`,
    })).rejects.toThrow(first.parkedNumber);

    const changed = await changeParkedInvoice({
      client: c, changedBy: ACTOR, parkedNumber: first.parkedNumber, expectedChangedAt: first.changedAt,
      orderNumber: order.orderNumber, supplierReference: 'PARK-B', ...DATES, grossAmount: 200,
      lines: [line(2, 200)], reason: 'The supplier corrected the quantity.',
    });
    expect(changed.supplierReference).toBe('PARK-B');
    expect(changed.lines[0].quantity).toBe('2');
    expect(changed.history.some((entry) => entry.changeType === 'CHANGE')).toBe(true);
    await expect(changeParkedInvoice({
      client: c, changedBy: ACTOR, parkedNumber: first.parkedNumber, expectedChangedAt: first.changedAt,
      orderNumber: order.orderNumber, supplierReference: 'PARK-C', ...DATES, grossAmount: 300,
      lines: [line(3, 300)],
    })).rejects.toThrow('has changed since it was loaded');
    expect((await getParkedInvoice(c, first.parkedNumber))?.supplierReference).toBe('PARK-B');
  });

  it('refuses the named acts and writes nothing', async () => {
    const c = await standing();
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [item(5, 100)] });
    const before = await counts(c);
    const base = {
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, supplierReference: 'REFUSED',
      ...DATES, grossAmount: 100, lines: [line(1, 100)],
    };
    const refusals: Array<[Partial<typeof base> & Record<string, unknown>, string]> = [
      [{ category: 'CREDIT_MEMO' }, 'credit memo'],
      [{ category: 'SUBSEQUENT_DEBIT' }, 'subsequent debit'],
      [{ category: 'SUBSEQUENT_CREDIT' }, 'subsequent credit'],
      [{ currency: 'USD' }, 'currency'],
      [{ companyCode: '1000' }, 'company code'],
      [{ supplierNumber: 'V10000' }, 'supplier'],
      [{ paymentTerms: 'NET30' }, 'Payment terms'],
      [{ taxAmount: 10 }, 'tax'],
      [{ exchangeRate: '1' }, 'exchange rate'],
      [{ freight: '5' }, 'Freight'],
      [{ discount: '5' }, 'discount'],
      [{ status: 'PARKED' }, 'status'],
      [{ approval: 'YES' }, 'approval'],
      [{ posting: 'YES' }, 'Posting'],
      [{ award: 'YES' }, 'award'],
      [{ deletion: 'YES' }, 'not deleted'],
      [{ requestKey: 'check-key' }, 'request key'],
      [{ lines: [{ itemNumber: 10, quantity: 1, netAmount: 100, taxAmount: 10 }] }, 'tax'],
    ];
    for (const [extra, text] of refusals) {
      await expect(previewParkedInvoice({ ...base, ...extra })).rejects.toThrow(new RegExp(text, 'i'));
    }
    await expect(postParkedInvoice()).rejects.toBeInstanceOf(ParkedInvoiceError);
    await expect(deleteParkedInvoice()).rejects.toThrow('not deleted');
    expect(await counts(c)).toEqual(before);
  });

  it('suggests an order as it is typed, and an empty query returns nothing', async () => {
    const c = await standing();
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [item(1, 10)] });
    expect(await suggestConstrainedValues(c, 'purchase-order', '')).toEqual([]);
    const matches = await suggestConstrainedValues(c, 'purchase-order', order.orderNumber);
    expect(matches).toEqual([expect.objectContaining({ code: order.orderNumber, label: 'V10000' })]);
    const typed = await suggestConstrainedValues(c, 'purchase-order', 'POF');
    expect(typed.length).toBeGreaterThan(0);
    expect(typed.length).toBeLessThanOrEqual(5);
    expect(await suggestConstrainedValues(other, 'purchase-order', order.orderNumber)).toEqual([]);
  });
});
