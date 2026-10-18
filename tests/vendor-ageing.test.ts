import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { derivePosition, getCompanyCode } from '../src/platform/periods';
import { postJournalEntry } from '../src/platform/posting';
import { createOrder } from '../src/modules/purchasing/orders';
import { postGoodsReceipt } from '../src/modules/inventory/goods-receipt';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { postSupplierInvoice } from '../src/modules/purchasing/invoice-verification';
import { getVendorAgeing } from '../src/modules/finance/vendor-ageing';
import { clearVendorItems, getVendorClearing } from '../src/modules/finance/vendor-clearing';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR066_AGEING_TEST';

/**
 * SCR-066 acceptance: ageing reconstructs standing as of the key
 * date — not yet due apart, overdue bucketed by the due date, an
 * item cleared after the key date still standing at that date.
 */
describe('SCR-066 vendor ageing (S_ALR_87012085)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr066-vendor-ageing');
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

      const order2 = await createOrder({
        client, changedBy: ACTOR,
        supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '',
        items: [{
          materialNumber: 'MAT-10001', shortText: 'Industrial steel plate', quantity: 3, unit: 'PC',
          netPrice: 100, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '',
          markedForDeletion: false,
          scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 3 }],
          assignments: [],
        }],
      });
      await postGoodsReceipt({
        client, changedBy: ACTOR, orderNumber: order2.orderNumber,
        documentDate: '2026-10-18', postingDate: '2026-10-18',
        requestKey: 'gr-bal-2', lines: [{ itemNumber: 10, quantity: 3 }],
      });
      await postSupplierInvoice({
        client, changedBy: ACTOR, orderNumber: order2.orderNumber,
        supplierReference: 'INV-BAL-2', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
        grossAmount: 300, requestKey: 'iv-bal-2',
        lines: [{ itemNumber: 10, quantity: 3, netAmount: 300 }],
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

  it('ages the standing as of the key date, not yet due apart', async () => {
    const c = await standingClient();
    const early = await getVendorAgeing(c, { companyCode: '1000', keyDate: '2026-10-18' });
    // Both invoices posted by the 18th, due 2026-11-15: not yet due.
    // The payment posted on the 20th does not stand yet.
    expect(early.totals).toEqual([-800, 0, 0, 0, 0]);
    expect(early.grandTotal).toBe(-800);

    const later = await getVendorAgeing(c, { companyCode: '1000', keyDate: '2026-12-20' });
    // Invoices 35 days overdue (31–60); the payment 61 days (61–90).
    expect(later.totals).toEqual([0, 0, -800, 500, 0]);
    expect(later.grandTotal).toBe(-300);
    const row = later.suppliers.find((s) => s.supplier === 'V10000')!;
    expect(row.total).toBe(-300);
  });

  it('reconstructs historical standing around a clearing and judges thresholds', async () => {
    const c = await standingClient();
    const open = await getVendorClearing(c, 'V10000', '1000');
    const invoice = open.openItems.find((i) => i.signed === -500)!;
    const payment = open.openItems.find((i) => i.signed === 500)!;
    await clearVendorItems({
      client: c, changedBy: ACTOR, supplier: 'V10000', companyCode: '1000',
      clearingDate: '2026-12-01', postingDate: '2026-12-01', documentDate: '2026-12-01',
      items: [invoice, payment].map((i) => ({
        documentNumber: i.documentNumber, fiscalYear: i.fiscalYear, lineNumber: i.lineNumber,
      })),
    });
    // At 2026-11-30 the pair still stands (cleared later); at 2026-12-20 it is gone.
    const before = await getVendorAgeing(c, { companyCode: '1000', keyDate: '2026-11-30' });
    expect(before.grandTotal).toBe(-300);
    expect(before.items.some((i) => i.documentNumber === invoice.documentNumber)).toBe(true);
    const after = await getVendorAgeing(c, { companyCode: '1000', keyDate: '2026-12-20' });
    expect(after.items).toHaveLength(1);
    expect(after.grandTotal).toBe(-300);
    expect(after.items[0].amount).toBe('300.0000');

    await expect(getVendorAgeing(c, {
      companyCode: '1000', keyDate: '2026-12-20', thresholds: [30, 30, 90],
    })).rejects.toThrow('do not increase');
  });
});
