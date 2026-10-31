import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { derivePosition, getCompanyCode } from '../src/platform/periods';
import { postJournalEntry } from '../src/platform/posting';
import { createOrder } from '../src/modules/purchasing/orders';

import { postGoodsReceipt } from './helpers/goods-receipt-authorized';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { postSupplierInvoice } from '../src/modules/purchasing/invoice-verification';
import { clearVendorItems, getVendorClearing } from '../src/modules/finance/vendor-clearing';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR064_F44_TEST';

/**
 * SCR-064 acceptance: a supplier's invoice and payment clear against
 * each other only at exactly zero, under three distinct dates, and
 * the cleared history is preserved.
 */
describe('SCR-064 vendor open-item clearing (F-44)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr064-vendor-clearing');
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
      });
      await initializeMaterialPeriodControl({
        client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'Stage 5 acceptance',
      });

      const order = await createOrder({
        client, changedBy: ACTOR,
        supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '',
        items: [{
          materialNumber: 'MAT-10001', shortText: 'Industrial steel plate', quantity: 5, unit: 'PC',
          netPrice: 100, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '',
          markedForDeletion: false,
          scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 5 }],
          assignments: [],
        }],
      });
      await postGoodsReceipt({
        client, changedBy: ACTOR, orderNumber: order.orderNumber,
        documentDate: '2026-10-18', postingDate: '2026-10-18',
        requestKey: 'gr-clr-1', lines: [{ itemNumber: 10, quantity: 5 }],
      });
      await postSupplierInvoice({
        client, changedBy: ACTOR, orderNumber: order.orderNumber,
        supplierReference: 'INV-CLR-1', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
        grossAmount: 500, requestKey: 'iv-clr-1',
        lines: [{ itemNumber: 10, quantity: 5, netAmount: 500 }],
      });

      // A manual payment standing as the supplier's debit item.
      await withTenant(client, async (tx) => {
        const company = await getCompanyCode(tx, client, '1000');
        const position = await derivePosition(tx, client, company!.fiscalYearVariant!, '2026-10-20');
        await postJournalEntry(tx, {
          client, companyCode: '1000', documentType: 'KZ',
          documentDate: '2026-10-20', postingDate: '2026-10-20',
          fiscalYear: position.fiscalYear, postingPeriod: position.period,
          currency: 'USD', localCurrency: company!.currency,
          reference: 'MANUAL-PAYMENT',
          lines: [
            { glAccount: '200000', debitCredit: 'S', amount: '500.00', businessPartner: 'V10000' },
            { glAccount: '101000', debitCredit: 'H', amount: '500.00' },
          ],
          postedBy: ACTOR, transactionCode: 'FIN.AP.CLEAR',
        });
      });
    }
    return client;
  }

  it('lists the open items and refuses a selection that does not balance', async () => {
    const c = await standingClient();
    const view = await getVendorClearing(c, 'V10000', '1000');
    expect(view.openItems).toHaveLength(2);
    expect(view.openBalance).toBe(0);
    const invoice = view.openItems.find((i) => i.signed < 0)!;
    await expect(clearVendorItems({
      client: c, changedBy: ACTOR, supplier: 'V10000', companyCode: '1000',
      clearingDate: '2026-11-20', postingDate: '2026-11-20', documentDate: '2026-11-19',
      items: [{ documentNumber: invoice.documentNumber, fiscalYear: invoice.fiscalYear, lineNumber: invoice.lineNumber }],
    })).rejects.toThrow('do not balance: the difference stands at 500.00 USD');
    await expect(getVendorClearing(c, 'V99999', '1000')).rejects.toThrow('does not stand extended');
  });

  it('clears at zero under three distinct dates and preserves the history', async () => {
    const c = await standingClient();
    const before = await getVendorClearing(c, 'V10000', '1000');
    const result = await clearVendorItems({
      client: c, changedBy: ACTOR, supplier: 'V10000', companyCode: '1000',
      clearingDate: '2026-11-20', postingDate: '2026-11-20', documentDate: '2026-11-19',
      items: before.openItems.map((i) => ({
        documentNumber: i.documentNumber, fiscalYear: i.fiscalYear, lineNumber: i.lineNumber,
      })),
    });
    expect(result.openItems).toHaveLength(0);
    // Two originals plus the clearing journal's own two lines.
    expect(result.clearedItems).toHaveLength(4);
    expect(result.clearedItems.every((i) => i.clearingDocument === result.clearingDocumentNumber)).toBe(true);
    expect(result.clearedItems.every((i) => i.clearingDate === '2026-11-20')).toBe(true);

    const journal = await withTenant(c, (tx) => tx.execute(sql`
      select document_date::text as dd, posting_date::text as pd, document_type from journal_entry
      where client = ${c} and document_number = ${result.clearingDocumentNumber}
    `));
    const row = (journal as unknown as Array<{ dd: string; pd: string; document_type: string }>)[0];
    expect(row.dd).toBe('2026-11-19');
    expect(row.pd).toBe('2026-11-20');
    expect(row.document_type).toBe('KZ');

    await expect(clearVendorItems({
      client: c, changedBy: ACTOR, supplier: 'V10000', companyCode: '1000',
      clearingDate: '2026-11-21', postingDate: '2026-11-21', documentDate: '2026-11-21',
      items: before.openItems.map((i) => ({
        documentNumber: i.documentNumber, fiscalYear: i.fiscalYear, lineNumber: i.lineNumber,
      })),
    })).rejects.toThrow('already stands cleared');
  });
});
