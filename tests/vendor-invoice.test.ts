import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import {
  cancelVendorInvoice, getVendorInvoice, postVendorInvoice,
} from '../src/modules/finance/vendor-invoice';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR075_FB60_TEST';

/**
 * SCR-075 acceptance: a direct vendor invoice posts with tax,
 * stands as the vendor's payable, refuses an unreconciled gross
 * and a duplicate reference, and cancels by mirror.
 */
describe('SCR-075 vendor invoice (FB60)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr075-vendor-invoice');
      client = tenant.client;
      await defineTestRanges(tenant, { fiscalYear: 2026 });
      await withTenant(client, async (tx) => {
        await defineRange(tx, { client, objectCode: 'VENDINV', subObject: '*', prefix: 'VI', numberLength: 7, createdBy: ACTOR });
        await tx.execute(sql`
          insert into business_partner (client, partner_number, category, name, created_by)
          values (${client}, 'V10000', 'ORGANIZATION', 'Test Vendor', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into bp_role (client, partner_number, role_code, created_by)
          values (${client}, 'V10000', 'SUPPLIER', ${ACTOR}) on conflict do nothing
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
          insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
          values (${client}, 'CA01', 'TAX', '', '', '240000', ${ACTOR}) on conflict do nothing
        `);
      });
    }
    return client;
  }

  const base = () => ({
    client, changedBy: ACTOR,
    vendorNumber: 'V10000', companyCode: '1000',
    documentDate: '2026-10-16', postingDate: '2026-10-18',
    reference: 'INV-2026-999', currency: 'USD',
    grossAmount: 550, requestKey: 'vi-1',
    lines: [{ glAccount: '400000', netAmount: 500, taxCode: 'T10' }],
  });

  it('posts with tax, the payable standing as an open item with its due date', async () => {
    const c = await standingClient();
    const view = await postVendorInvoice(base());
    expect(view.status).toBe('POSTED');
    expect(Number(view.taxAmount)).toBe(50);
    expect(view.dueDate).toBe('2026-11-15');
    expect(view.invoiceNumber).toMatch(/^VI/);

    const journal = await withTenant(c, (tx) => tx.execute(sql`
      select document_type, status from journal_entry
      where client = ${c} and document_number = ${view.journalDocumentNumber}
    `));
    expect((journal as unknown as Array<{ document_type: string; status: string }>)[0])
      .toEqual({ document_type: 'KR', status: 'POSTED' });

    const lines = await withTenant(c, (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_local::text as amount, business_partner
      from journal_entry_line
      where client = ${c} and document_number = ${view.journalDocumentNumber}
      order by line_number
    `));
    const rows = lines as unknown as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.debit_credit)).toEqual(['S', 'S', 'H']);
    expect(rows[2].gl_account).toBe('200000');
    expect(rows[2].business_partner).toBe('V10000');
    expect(rows[2].amount).toBe('550.0000');

    const replay = await postVendorInvoice(base());
    expect(replay.invoiceNumber).toBe(view.invoiceNumber);
  });

  it('refuses by name: unreconciled gross, duplicate reference, standing judges', async () => {
    const c = await standingClient();
    await expect(postVendorInvoice({ ...base(), grossAmount: 500, requestKey: 'vi-bad-gross' }))
      .rejects.toThrow('already stands posted for this vendor');
    const fresh = { ...base(), reference: 'INV-2026-1000', requestKey: 'vi-2' };
    await expect(postVendorInvoice({ ...fresh, grossAmount: 500 }))
      .rejects.toThrow('does not reconcile');
    await expect(postVendorInvoice({ ...fresh, vendorNumber: 'V99999' }))
      .rejects.toThrow('does not stand extended');
    await expect(postVendorInvoice({ ...fresh, lines: [{ glAccount: '400000', netAmount: 500, taxCode: 'ZZ' }] }))
      .rejects.toThrow('Tax code ZZ does not stand');
    await expect(postVendorInvoice({ ...fresh, lines: [{ glAccount: '400000', netAmount: 500, costCenter: 'CC-NONE' }] }))
      .rejects.toThrow('Cost centre CC-NONE does not stand');
    await expect(postVendorInvoice({ ...fresh, lines: [] }))
      .rejects.toThrow('Enter at least one expense line');
  });

  it('cancels by linked mirror and refuses a second cancellation', async () => {
    const c = await standingClient();
    const view = await postVendorInvoice({
      ...base(), reference: 'INV-2026-1001', requestKey: 'vi-3',
    });
    const cancellation = await cancelVendorInvoice({
      client: c, changedBy: ACTOR, invoiceNumber: view.invoiceNumber,
      postingDate: '2026-11-02', requestKey: 'vi-3-cancel',
    });
    expect(cancellation.cancellationOf).toBe(view.invoiceNumber);
    const original = await getVendorInvoice(c, view.invoiceNumber);
    expect(original!.status).toBe('CANCELLED');
    expect(original!.cancelledBy).toBe(cancellation.invoiceNumber);

    const journals = await withTenant(c, (tx) => tx.execute(sql`
      select document_number, status, reversal_of from journal_entry
      where client = ${c} and document_number in (${view.journalDocumentNumber}, ${cancellation.journalDocumentNumber})
    `));
    const rows = journals as unknown as Array<{ status: string; reversal_of: string | null }>;
    expect(rows.find((r) => r.status === 'REVERSED')).toBeTruthy();
    expect(rows.find((r) => r.reversal_of === view.journalDocumentNumber)).toBeTruthy();

    await expect(cancelVendorInvoice({
      client: c, changedBy: ACTOR, invoiceNumber: view.invoiceNumber,
      postingDate: '2026-11-03', requestKey: 'vi-3-cancel-2',
    })).rejects.toThrow('already been cancelled');
    await expect(cancelVendorInvoice({
      client: c, changedBy: ACTOR, invoiceNumber: cancellation.invoiceNumber,
      postingDate: '2026-11-03', requestKey: 'vi-3-cancel-3',
    })).rejects.toThrow('cannot itself be cancelled');
  });
});
