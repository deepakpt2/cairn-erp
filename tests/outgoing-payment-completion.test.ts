import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postVendorInvoice } from '../src/modules/finance/vendor-invoice';
import { getPayables, postOutgoingPayment } from '../src/modules/finance/outgoing-payment';
import { createTenant, dateFromToday, defineTestRanges, destroyTenant } from './helpers';

// The terms give 2 percent within ten days of the document date, and `getReceivables` judges that
// window against today (`incoming-payment.ts:100`, `outgoing-payment.ts:154`), so the fixture dates
// are counted from the run rather than fixed. Four days back keeps every case inside the window
// and inside the fiscal year the ranges in the fixture define.
const INVOICE_DATE = dateFromToday(-4);
const POSTING_DATE = dateFromToday(-2);
const PAYMENT_DATE = dateFromToday(0);
const CLEARING_DATE = dateFromToday(1);

const ACTOR = 'SCR080_F53_TEST';

/**
 * SCR-080 acceptance: the outgoing payment completes — cash
 * discount received judged by terms and tolerance, residual and
 * partial outcomes standing on the journal lines, on-account
 * amounts and tolerated differences posted by name.
 */
describe('SCR-080 outgoing payment completion (F-53)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr080-outgoing-completion');
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
          insert into payment_terms (
            client, terms_code, description, baseline_source, net_days,
            discount1_days, discount1_percent, created_by
          )
          values (${client}, 'D10', '2 percent 10 days, net 30', 'DOCUMENT_DATE', 30, 10, 2, ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into supplier_company_code (
            client, partner_number, role_code, company_code, chart_of_accounts,
            reconciliation_account, payment_terms_code, created_by
          )
          values (${client}, 'V10000', 'SUPPLIER', '1000', 'CA01', '200000', 'D10', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
          values (${client}, 'KW', 'T10', 'Input tax 10 percent', 'VAT', 10, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
          values
            (${client}, 'CA01', 'TAX', '', '', '240000', ${ACTOR}),
            (${client}, 'CA01', 'CASH_DISCOUNT', '', 'REV', '300000', ${ACTOR}),
            (${client}, 'CA01', 'PAYMENT_DIFFERENCE', '', 'EXP', '400000', ${ACTOR}),
            (${client}, 'CA01', 'PAYMENT_DIFFERENCE', '', 'REV', '300000', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into employee_tolerance_group (
            client, company_code, group_key, max_document_amount, max_line_amount,
            max_cash_discount_percent, payment_diff_revenue_amount, payment_diff_expense_amount,
            payment_diff_revenue_percent, payment_diff_expense_percent, created_by
          )
          values (${client}, '', '', 0, 0, 5, 5, 5, 5, 5, ${ACTOR})
          on conflict do nothing
        `);
      });

      await postVendorInvoice({
        client, changedBy: ACTOR, vendorNumber: 'V10000', companyCode: '1000',
        documentDate: INVOICE_DATE, postingDate: POSTING_DATE,
        reference: 'INV-COMP-1', currency: 'USD', grossAmount: 550, requestKey: 'comp-vinv-1',
        lines: [{ glAccount: '400000', netAmount: 500, taxCode: 'T10' }],
      });
      await postVendorInvoice({
        client, changedBy: ACTOR, vendorNumber: 'V10000', companyCode: '1000',
        documentDate: INVOICE_DATE, postingDate: POSTING_DATE,
        reference: 'INV-COMP-2', currency: 'USD', grossAmount: 300, requestKey: 'comp-vinv-2',
        lines: [{ glAccount: '400000', netAmount: 300 }],
      });
    }
    return client;
  }

  const refOf = async (signedWanted: number) => {
    const view = await getPayables(client, 'V10000', '1000');
    const item = view.openItems.find((i) => i.signed === signedWanted) ?? view.openItems[0];
    return { documentNumber: item.documentNumber, fiscalYear: item.fiscalYear, lineNumber: item.lineNumber };
  };

  const payment = (patch: Partial<Parameters<typeof postOutgoingPayment>[0]> = {}) => ({
    client, changedBy: ACTOR,
    vendorNumber: 'V10000', companyCode: '1000',
    documentDate: PAYMENT_DATE, postingDate: PAYMENT_DATE, clearingDate: CLEARING_DATE,
    bankGlAccount: '101000', amount: 0, currency: 'USD',
    requestKey: `comp-${Math.random()}`,
    items: [] as Parameters<typeof postOutgoingPayment>[0]['items'],
    ...patch,
  });

  it('suggests the terms discount and refuses a discount beyond the eligible amount', async () => {
    await standingClient();
    const view = await getPayables(client, 'V10000', '1000');
    const taxed = view.openItems.find((i) => i.signed === 550);
    expect(taxed?.discountPercent).toBe(2);
    expect(taxed?.discountAmount).toBe(11);
    await expect(postOutgoingPayment(payment({
      amount: 530, items: [{ ...(await refOf(550)), discount: 20 }],
    }))).rejects.toThrow('exceeds the eligible 11.00');
  });

  it('posts the discount received, clearing the item at its full open amount', async () => {
    const c = await standingClient();
    const posted = await postOutgoingPayment(payment({
      amount: 539, requestKey: 'comp-pay-discount',
      items: [{ ...(await refOf(550)), discount: 11 }],
    }));
    expect(posted.itemsCleared).toBe(1);
    const lines = await withTenant(c, (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_local::text as amount, line_text from journal_entry_line
      where client = ${c} and document_number = ${posted.journalDocumentNumber} order by line_number
    `));
    const rows = lines as unknown as Array<Record<string, string>>;
    expect(rows.find((l) => l.line_text === 'Cash discount received'))
      .toMatchObject({ gl_account: '300000', debit_credit: 'H', amount: '11.0000' });
    expect(rows.find((l) => l.line_text?.startsWith('Settles')))
      .toMatchObject({ gl_account: '200000', debit_credit: 'S', amount: '550.0000' });
    expect(rows.find((l) => l.gl_account === '101000'))
      .toMatchObject({ debit_credit: 'H', amount: '539.0000' });
    const record = await withTenant(c, (tx) => tx.execute(sql`
      select discount_amount::text as d from outgoing_payment
      where client = ${c} and payment_number = ${posted.paymentNumber}
    `));
    expect((record as unknown as Array<{ d: string }>)[0].d).toBe('11.0000');
    const view = await getPayables(c, 'V10000', '1000');
    expect(view.openItems.map((i) => i.signed)).toEqual([300]);
  });

  it('leaves a residual open item and, for a partial payment, both items standing', async () => {
    const c = await standingClient();
    const posted = await postOutgoingPayment(payment({
      amount: 200, items: [{ ...(await refOf(300)), applied: 200, outcome: 'RESIDUAL' }],
    }));
    expect(posted.itemsCleared).toBe(1);
    let view = await getPayables(c, 'V10000', '1000');
    expect(view.openItems.map((i) => i.signed)).toEqual([100]);

    const residualRef = await refOf(100);
    const partial = await postOutgoingPayment(payment({
      amount: 40, items: [{ ...residualRef, applied: 40, outcome: 'PARTIAL' }],
    }));
    expect(partial.itemsCleared).toBe(0);
    view = await getPayables(c, 'V10000', '1000');
    // The original 100 stands beside the payment's own 40 debit line.
    expect(view.openItems.map((i) => i.signed)).toEqual([100, -40]);
    expect(view.openBalance).toBe(60);
    const partialLine = await withTenant(c, (tx) => tx.execute(sql`
      select debit_credit, clearing_document from journal_entry_line
      where client = ${c} and document_number = ${partial.journalDocumentNumber}
        and business_partner = 'V10000'
    `));
    const prow = (partialLine as unknown as Array<Record<string, unknown>>)[0];
    expect(prow.debit_credit).toBe('S');
    expect(prow.clearing_document).toBeNull();
  });

  it('posts an on-account amount with a tolerated difference, and on-account alone', async () => {
    const c = await standingClient();
    const view = await getPayables(c, 'V10000', '1000');
    const last = view.openItems[0];
    const ref = { documentNumber: last.documentNumber, fiscalYear: last.fiscalYear, lineNumber: last.lineNumber };
    const posted = await postOutgoingPayment(payment({
      amount: 150, onAccountAmount: 45, items: [ref],
    }));
    const lines = await withTenant(c, (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_local::text as amount, line_text from journal_entry_line
      where client = ${c} and document_number = ${posted.journalDocumentNumber}
    `));
    const rows = lines as unknown as Array<Record<string, string>>;
    expect(rows.find((l) => l.line_text === 'On account'))
      .toMatchObject({ gl_account: '200000', debit_credit: 'S', amount: '45.0000' });
    expect(rows.find((l) => l.line_text === 'Payment difference'))
      .toMatchObject({ gl_account: '400000', debit_credit: 'S', amount: '5.0000' });
    const record = await withTenant(c, (tx) => tx.execute(sql`
      select on_account_amount::text as oa from outgoing_payment
      where client = ${c} and payment_number = ${posted.paymentNumber}
    `));
    expect((record as unknown as Array<{ oa: string }>)[0].oa).toBe('45.0000');

    const alone = await postOutgoingPayment(payment({ amount: 25, onAccountAmount: 25, items: [] }));
    expect(alone.itemsCleared).toBe(0);
    await expect(postOutgoingPayment(payment({ amount: 10, items: [] })))
      .rejects.toThrow('Select at least one open item');
  });
});
