import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import {
  cancelVendorInvoice, postVendorInvoice,
} from '../src/modules/finance/vendor-invoice';
import { postVendorCreditMemo } from '../src/modules/finance/vendor-credit-memo';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR076_FB65_TEST';

/**
 * SCR-076 acceptance: a vendor credit memo posts a KG journal
 * debiting the vendor at the judged gross credit, partial credits
 * against an original cap at its gross, a reference standing posted
 * across invoices and memos refuses, and cancellation reuses the
 * invoice's linked mirror carrying the memo's link.
 */
describe('SCR-076 vendor credit memo (FB65)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr076-vendor-credit');
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

  const invoiceInput = () => ({
    client, changedBy: ACTOR,
    vendorNumber: 'V10000', companyCode: '1000',
    documentDate: '2026-10-16', postingDate: '2026-10-18',
    reference: 'INV-2026-999', currency: 'USD',
    grossAmount: 550, requestKey: 'vm-inv-1',
    lines: [{ glAccount: '400000', netAmount: 500, taxCode: 'T10' }],
  });

  const memoInput = (invoiceNumber: string) => ({
    client, changedBy: ACTOR,
    vendorNumber: 'V10000', companyCode: '1000',
    documentDate: '2026-10-20', postingDate: '2026-10-20',
    reference: 'CM-2026-001', currency: 'USD',
    grossAmount: 220, creditOf: invoiceNumber, requestKey: 'vm-1',
    lines: [{ glAccount: '400000', netAmount: 200, taxCode: 'T10' }],
  });

  it('posts a linked partial credit as a balanced KG journal', async () => {
    const c = await standingClient();
    const invoice = await postVendorInvoice(invoiceInput());
    const memo = await postVendorCreditMemo(memoInput(invoice.invoiceNumber));
    expect(memo.status).toBe('POSTED');
    expect(memo.category).toBe('CREDIT_MEMO');
    expect(memo.creditOf).toBe(invoice.invoiceNumber);
    expect(Number(memo.taxAmount)).toBe(20);

    const journal = await withTenant(c, (tx) => tx.execute(sql`
      select document_type, status from journal_entry
      where client = ${c} and document_number = ${memo.journalDocumentNumber}
    `));
    expect((journal as unknown as Array<{ document_type: string; status: string }>)[0])
      .toEqual({ document_type: 'KG', status: 'POSTED' });

    const lines = await withTenant(c, (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_local::text as amount, business_partner
      from journal_entry_line
      where client = ${c} and document_number = ${memo.journalDocumentNumber}
      order by line_number
    `));
    const rows = lines as unknown as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.debit_credit)).toEqual(['S', 'H', 'H']);
    expect(rows[0].gl_account).toBe('200000');
    expect(rows[0].business_partner).toBe('V10000');
    expect(rows[0].amount).toBe('220.0000');

    const replay = await postVendorCreditMemo(memoInput(invoice.invoiceNumber));
    expect(replay.invoiceNumber).toBe(memo.invoiceNumber);
  });

  it('refuses by name: cross-kind duplicate reference, cap excess, bad original', async () => {
    const c = await standingClient();
    const invoice = await postVendorInvoice(invoiceInput());
    const memo1 = await postVendorCreditMemo(memoInput(invoice.invoiceNumber));

    await expect(postVendorCreditMemo({
      ...memoInput(invoice.invoiceNumber), reference: 'INV-2026-999', requestKey: 'vm-dup',
    })).rejects.toThrow('already stands posted for this vendor');
    await expect(postVendorCreditMemo({
      ...memoInput(invoice.invoiceNumber), reference: 'CM-2026-002', requestKey: 'vm-cap',
      grossAmount: 440, lines: [{ glAccount: '400000', netAmount: 400, taxCode: 'T10' }],
    })).rejects.toThrow('would stand at 660.00 against its gross of 550.00');
    await expect(postVendorCreditMemo({
      ...memoInput(memo1.invoiceNumber), reference: 'CM-2026-003', requestKey: 'vm-memo-of',
    })).rejects.toThrow('does not stand posted for this vendor and company');
    await expect(postVendorCreditMemo({
      ...memoInput(invoice.invoiceNumber), reference: 'CM-2026-004', requestKey: 'vm-bad-gross',
      grossAmount: 200,
    })).rejects.toThrow('does not reconcile');
    await expect(postVendorCreditMemo({
      ...memoInput(invoice.invoiceNumber), reference: 'CM-2026-005', requestKey: 'vm-none',
      vendorNumber: 'V99999',
    })).rejects.toThrow('does not stand extended');
  });

  it('cancels through the invoice mirror carrying category and link, freeing the cap', async () => {
    const c = await standingClient();
    const invoice = await postVendorInvoice(invoiceInput());
    const memo = await postVendorCreditMemo(memoInput(invoice.invoiceNumber));
    const cancellation = await cancelVendorInvoice({
      client: c, changedBy: ACTOR, invoiceNumber: memo.invoiceNumber,
      postingDate: '2026-11-02', requestKey: 'vm-1-cancel',
    });
    expect(cancellation.cancellationOf).toBe(memo.invoiceNumber);
    expect(cancellation.category).toBe('CREDIT_MEMO');
    expect(cancellation.creditOf).toBe(invoice.invoiceNumber);

    const freed = await postVendorCreditMemo({
      ...memoInput(invoice.invoiceNumber), reference: 'CM-2026-009', requestKey: 'vm-9',
      grossAmount: 440, lines: [{ glAccount: '400000', netAmount: 400, taxCode: 'T10' }],
    });
    expect(freed.status).toBe('POSTED');
  });
});
