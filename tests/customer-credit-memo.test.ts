import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import {
  postCustomerInvoice, cancelCustomerInvoice, type CustomerInvoiceView,
} from '../src/modules/finance/customer-invoice';
import { postCustomerCreditMemo } from '../src/modules/finance/customer-credit-memo';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'DI020_CM_TEST';

describe('DI-020 customer credit memo', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('di020-customer-credit-memo');
      client = tenant.client;
      await defineTestRanges(tenant, { fiscalYear: 2026 });
      await withTenant(client, async (tx) => {
        await defineRange(tx, { client, objectCode: 'CUSTINV', subObject: '*', prefix: 'CI', numberLength: 7, createdBy: ACTOR });
        await tx.execute(sql`
          insert into business_partner (client, partner_number, category, name, created_by)
          values (${client}, 'C10000', 'ORGANIZATION', 'Test Customer', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into bp_role (client, partner_number, role_code, created_by)
          values (${client}, 'C10000', 'CUSTOMER', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
          values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into customer_company_code (
            client, partner_number, company_code, chart_of_accounts,
            reconciliation_account, payment_terms_code, created_by
          )
          values (${client}, 'C10000', '1000', 'CA01', '100000', 'NET30', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
          values (${client}, 'KW', 'T10', 'Output tax 10 percent', 'VAT', 10, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
          values (${client}, 'CA01', 'TAX', '', '', '240000', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
          values (${client}, 'CA01', 'SALES_REVENUE', '', '', '400000', ${ACTOR}) on conflict do nothing
        `);
      });
    }
    return client;
  }

  const invoiceInput = () => ({
    client, changedBy: ACTOR,
    customerNumber: 'C10000', companyCode: '1000',
    documentDate: '2026-10-16', postingDate: '2026-10-18',
    reference: 'INV-2026-999', currency: 'USD',
    grossAmount: 550, requestKey: 'ci-inv-1',
    lines: [{ glAccount: '400000', netAmount: 500, taxCode: 'T10' }],
  });

  const memoInput = (invoiceNumber: string) => ({
    client, changedBy: ACTOR,
    customerNumber: 'C10000', companyCode: '1000',
    documentDate: '2026-10-20', postingDate: '2026-10-20',
    reference: 'CM-2026-001', currency: 'USD',
    grossAmount: 220, creditOfInvoice: invoiceNumber, requestKey: 'cm-1',
    lines: [{ glAccount: '400000', netAmount: 200, taxCode: 'T10' }],
  });

  it('posts a linked partial credit as a balanced DR journal', async () => {
    const c = await standingClient();
    const invoice = await postCustomerInvoice(invoiceInput());
    expect(invoice.category).toBe('INVOICE');

    const memo = await postCustomerCreditMemo(memoInput(invoice.invoiceNumber));
    expect(memo.status).toBe('POSTED');
    expect(memo.category).toBe('CREDIT_MEMO');
    expect(memo.creditOf).toBe(invoice.invoiceNumber);
    expect(Number(memo.taxAmount)).toBe(20);

    const journal = await withTenant(c, (tx) => tx.execute(sql`
      select document_type, status from journal_entry
      where client = ${c} and document_number = ${memo.journalDocumentNumber}
    `));
    expect((journal as unknown as Array<{ document_type: string; status: string }>)[0])
      .toEqual({ document_type: 'DR', status: 'POSTED' });

    const lines = await withTenant(c, (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_local::text as amount, business_partner
      from journal_entry_line
      where client = ${c} and document_number = ${memo.journalDocumentNumber}
      order by line_number
    `));
    const rows = lines as unknown as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.debit_credit)).toEqual(['H', 'S', 'S']);
    expect(rows[0].gl_account).toBe('100000');
    expect(rows[0].business_partner).toBe('C10000');
    expect(rows[0].amount).toBe('220.0000');

    const replay = await postCustomerCreditMemo(memoInput(invoice.invoiceNumber));
    expect(replay.invoiceNumber).toBe(memo.invoiceNumber);
  });

  it('refuses by name: cross-kind duplicate reference, cap excess, bad original', async () => {
    const c = await standingClient();
    const invoice = await postCustomerInvoice(invoiceInput());
    const memo1 = await postCustomerCreditMemo(memoInput(invoice.invoiceNumber));

    await expect(postCustomerCreditMemo({
      ...memoInput(invoice.invoiceNumber), reference: 'INV-2026-999', requestKey: 'cm-dup',
    })).rejects.toThrow('already stands posted for this customer');
    await expect(postCustomerCreditMemo({
      ...memoInput(invoice.invoiceNumber), reference: 'CM-2026-002', requestKey: 'cm-cap',
      grossAmount: 440, lines: [{ glAccount: '400000', netAmount: 400, taxCode: 'T10' }],
    })).rejects.toThrow('would stand at 660.00 against its gross of 550.00');
    await expect(postCustomerCreditMemo({
      ...memoInput(memo1.invoiceNumber), reference: 'CM-2026-003', requestKey: 'cm-memo-of',
    })).rejects.toThrow('does not stand posted for this customer and company');
    await expect(postCustomerCreditMemo({
      ...memoInput(invoice.invoiceNumber), reference: 'CM-2026-004', requestKey: 'cm-bad-gross',
      grossAmount: 200,
    })).rejects.toThrow('does not reconcile');
    await expect(postCustomerCreditMemo({
      ...memoInput(invoice.invoiceNumber), reference: 'CM-2026-005', requestKey: 'cm-none',
      customerNumber: 'C99999',
    })).rejects.toThrow('does not stand extended');
  });

  it('supports multiple partial credits up to the original gross', async () => {
    const c = await standingClient();
    const invoice = await postCustomerInvoice(invoiceInput());

    const memo1 = await postCustomerCreditMemo({
      ...memoInput(invoice.invoiceNumber), reference: 'CM-2026-010', requestKey: 'cm-10',
      grossAmount: 110, lines: [{ glAccount: '400000', netAmount: 100, taxCode: 'T10' }],
    });
    expect(memo1.status).toBe('POSTED');

    const memo2 = await postCustomerCreditMemo({
      ...memoInput(invoice.invoiceNumber), reference: 'CM-2026-011', requestKey: 'cm-11',
      grossAmount: 110, lines: [{ glAccount: '400000', netAmount: 100, taxCode: 'T10' }],
    });
    expect(memo2.status).toBe('POSTED');

    const memo3 = await postCustomerCreditMemo({
      ...memoInput(invoice.invoiceNumber), reference: 'CM-2026-012', requestKey: 'cm-12',
      grossAmount: 220, lines: [{ glAccount: '400000', netAmount: 200, taxCode: 'T10' }],
    });
    expect(memo3.status).toBe('POSTED');

    await expect(postCustomerCreditMemo({
      ...memoInput(invoice.invoiceNumber), reference: 'CM-2026-013', requestKey: 'cm-13',
      grossAmount: 220, lines: [{ glAccount: '400000', netAmount: 200, taxCode: 'T10' }],
    })).rejects.toThrow('would stand at 660.00 against its gross of 550.00');
  });

  it('cancels through the invoice mirror carrying category and link, freeing the cap', async () => {
    const c = await standingClient();
    const invoice = await postCustomerInvoice(invoiceInput());
    const memo = await postCustomerCreditMemo(memoInput(invoice.invoiceNumber));
    const cancellation = await cancelCustomerInvoice({
      client: c, changedBy: ACTOR, invoiceNumber: memo.invoiceNumber,
      postingDate: '2026-11-02', requestKey: 'cm-1-cancel',
    });
    expect(cancellation.cancellationOf).toBe(memo.invoiceNumber);
    expect(cancellation.category).toBe('CREDIT_MEMO');
    expect(cancellation.creditOf).toBe(invoice.invoiceNumber);

    const freed = await postCustomerCreditMemo({
      ...memoInput(invoice.invoiceNumber), reference: 'CM-2026-009', requestKey: 'cm-9',
      grossAmount: 440, lines: [{ glAccount: '400000', netAmount: 400, taxCode: 'T10' }],
    });
    expect(freed.status).toBe('POSTED');
  });

  it('rejects wrong currency', async () => {
    const c = await standingClient();
    const invoice = await postCustomerInvoice(invoiceInput());

    await expect(postCustomerCreditMemo({
      ...memoInput(invoice.invoiceNumber), reference: 'CM-2026-020', requestKey: 'cm-20',
      currency: 'EUR',
    })).rejects.toThrow('in currency USD, not EUR');
  });

  it('rejects cancelled original invoice', async () => {
    const c = await standingClient();
    const invoice = await postCustomerInvoice(invoiceInput());
    await cancelCustomerInvoice({
      client: c, changedBy: ACTOR, invoiceNumber: invoice.invoiceNumber,
      postingDate: '2026-11-02', requestKey: 'ci-inv-1-cancel',
    });

    await expect(postCustomerCreditMemo({
      ...memoInput(invoice.invoiceNumber), reference: 'CM-2026-021', requestKey: 'cm-21',
    })).rejects.toThrow('does not stand posted for this customer and company');
  });
});
