import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postCustomerInvoice } from '../src/modules/finance/customer-invoice';
import { getReceivables, postIncomingPayment } from '../src/modules/finance/incoming-payment';
import { createTenant, dateFromToday, defineTestRanges, destroyTenant } from './helpers';

// The terms give 2 percent within ten days of the document date, and `getReceivables` judges that
// window against today (`incoming-payment.ts:100`, `outgoing-payment.ts:154`), so the fixture dates
// are counted from the run rather than fixed. Four days back keeps every case inside the window
// and inside the fiscal year the ranges in the fixture define.
const INVOICE_DATE = dateFromToday(-4);
const POSTING_DATE = dateFromToday(-2);
const PAYMENT_DATE = dateFromToday(0);
const CLEARING_DATE = dateFromToday(1);

const ACTOR = 'SCR079_F28_TEST';

/**
 * SCR-079 acceptance: the incoming payment completes — cash
 * discount judged by terms and tolerance, residual and partial
 * outcomes standing on the journal lines, on-account amounts and
 * tolerated differences posted by name.
 */
describe('SCR-079 incoming payment completion (F-28)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr079-incoming-completion');
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
          insert into payment_terms (
            client, terms_code, description, baseline_source, net_days,
            discount1_days, discount1_percent, created_by
          )
          values (${client}, 'D10', '2 percent 10 days, net 30', 'DOCUMENT_DATE', 30, 10, 2, ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into customer_company_code (
            client, partner_number, role_code, company_code, chart_of_accounts,
            reconciliation_account, payment_terms_code, created_by
          )
          values (${client}, 'C10000', 'CUSTOMER', '1000', 'CA01', '110000', 'D10', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
          values (${client}, 'KW', 'T10', 'Output tax 10 percent', 'VAT', 10, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
          values
            (${client}, 'CA01', 'TAX', '', '', '240000', ${ACTOR}),
            (${client}, 'CA01', 'CASH_DISCOUNT', '', '', '400000', ${ACTOR}),
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

      await postCustomerInvoice({
        client, changedBy: ACTOR, customerNumber: 'C10000', companyCode: '1000',
        documentDate: INVOICE_DATE, postingDate: POSTING_DATE,
        reference: 'INV-COMP-1', currency: 'USD', grossAmount: 550, requestKey: 'comp-inv-1',
        lines: [{ glAccount: '300000', netAmount: 500, taxCode: 'T10' }],
      });
      await postCustomerInvoice({
        client, changedBy: ACTOR, customerNumber: 'C10000', companyCode: '1000',
        documentDate: INVOICE_DATE, postingDate: POSTING_DATE,
        reference: 'INV-COMP-2', currency: 'USD', grossAmount: 300, requestKey: 'comp-inv-2',
        lines: [{ glAccount: '300000', netAmount: 300 }],
      });
    }
    return client;
  }

  const refOf = async (signedWanted: number) => {
    const view = await getReceivables(client, 'C10000', '1000');
    const item = view.openItems.find((i) => i.signed === signedWanted) ?? view.openItems[0];
    return { documentNumber: item.documentNumber, fiscalYear: item.fiscalYear, lineNumber: item.lineNumber };
  };

  const payment = (patch: Partial<Parameters<typeof postIncomingPayment>[0]> = {}) => ({
    client, changedBy: ACTOR,
    customerNumber: 'C10000', companyCode: '1000',
    documentDate: PAYMENT_DATE, postingDate: PAYMENT_DATE, clearingDate: CLEARING_DATE,
    bankGlAccount: '101000', amount: 0, currency: 'USD',
    requestKey: `comp-${Math.random()}`,
    items: [] as Parameters<typeof postIncomingPayment>[0]['items'],
    ...patch,
  });

  it('suggests the terms discount and refuses a discount beyond the eligible amount', async () => {
    await standingClient();
    const view = await getReceivables(client, 'C10000', '1000');
    const taxed = view.openItems.find((i) => i.signed === 550);
    expect(taxed?.discountPercent).toBe(2);
    await expect(postIncomingPayment(payment({
      amount: 530, items: [{ ...(await refOf(550)), discount: 20 }],
    }))).rejects.toThrow('exceeds the eligible 11.00');
  });

  it('posts the discount, clearing the item at its full open amount', async () => {
    const c = await standingClient();
    const posted = await postIncomingPayment(payment({
      amount: 539, requestKey: 'comp-pay-discount',
      items: [{ ...(await refOf(550)), discount: 11 }],
    }));
    expect(posted.itemsCleared).toBe(1);
    const lines = await withTenant(c, (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_local::text as amount, line_text from journal_entry_line
      where client = ${c} and document_number = ${posted.journalDocumentNumber} order by line_number
    `));
    const rows = lines as unknown as Array<Record<string, string>>;
    expect(rows.find((l) => l.line_text === 'Cash discount granted'))
      .toMatchObject({ gl_account: '400000', debit_credit: 'S', amount: '11.0000' });
    expect(rows.find((l) => l.line_text?.startsWith('Settles')))
      .toMatchObject({ gl_account: '110000', debit_credit: 'H', amount: '550.0000' });
    const record = await withTenant(c, (tx) => tx.execute(sql`
      select discount_amount::text as d from incoming_payment
      where client = ${c} and payment_number = ${posted.paymentNumber}
    `));
    expect((record as unknown as Array<{ d: string }>)[0].d).toBe('11.0000');
    const view = await getReceivables(c, 'C10000', '1000');
    expect(view.openItems.map((i) => i.signed)).toEqual([300]);
  });

  it('leaves a residual open item and, for a partial payment, both items standing', async () => {
    const c = await standingClient();
    // Residual: 300 open, 200 applied → original clears, 100 stands open.
    const posted = await postIncomingPayment(payment({
      amount: 200, items: [{ ...(await refOf(300)), applied: 200, outcome: 'RESIDUAL' }],
    }));
    expect(posted.itemsCleared).toBe(1);
    let view = await getReceivables(c, 'C10000', '1000');
    expect(view.openItems.map((i) => i.signed)).toEqual([100]);

    // Partial: 40 against the residual 100 → both stand; nothing clears.
    const residualRef = await refOf(100);
    const partial = await postIncomingPayment(payment({
      amount: 40, items: [{ ...residualRef, applied: 40, outcome: 'PARTIAL' }],
    }));
    expect(partial.itemsCleared).toBe(0);
    view = await getReceivables(c, 'C10000', '1000');
    expect(view.openItems.map((i) => i.signed)).toEqual([100]);
    const partialLine = await withTenant(c, (tx) => tx.execute(sql`
      select debit_credit, clearing_document from journal_entry_line
      where client = ${c} and document_number = ${partial.journalDocumentNumber}
        and business_partner = 'C10000'
    `));
    const prow = (partialLine as unknown as Array<Record<string, unknown>>)[0];
    expect(prow.debit_credit).toBe('H');
    expect(prow.clearing_document).toBeNull();
  });

  it('posts an on-account amount and a tolerated difference, refusing beyond tolerance', async () => {
    const c = await standingClient();
    const view = await getReceivables(c, 'C10000', '1000');
    const last = view.openItems[0];
    const ref = { documentNumber: last.documentNumber, fiscalYear: last.fiscalYear, lineNumber: last.lineNumber };
    // Settle the last 100 in full, 45 on account, 5 unassigned within tolerance.
    const posted = await postIncomingPayment(payment({
      amount: 150, onAccountAmount: 45, items: [ref],
    }));
    const lines = await withTenant(c, (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_local::text as amount, line_text from journal_entry_line
      where client = ${c} and document_number = ${posted.journalDocumentNumber}
    `));
    const rows = lines as unknown as Array<Record<string, string>>;
    expect(rows.find((l) => l.line_text === 'On account'))
      .toMatchObject({ gl_account: '110000', debit_credit: 'H', amount: '45.0000' });
    expect(rows.find((l) => l.line_text === 'Payment difference'))
      .toMatchObject({ gl_account: '300000', debit_credit: 'H', amount: '5.0000' });
    const record = await withTenant(c, (tx) => tx.execute(sql`
      select on_account_amount::text as oa from incoming_payment
      where client = ${c} and payment_number = ${posted.paymentNumber}
    `));
    expect((record as unknown as Array<{ oa: string }>)[0].oa).toBe('45.0000');

    await expect(postIncomingPayment(payment({
      amount: 999, items: [],
    }))).rejects.toThrow('Select at least one open item');
  });
});
