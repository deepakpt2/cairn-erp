import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postJournalEntry, PostingError } from '../src/platform/posting';
import { cancelCustomerInvoice, CustomerInvoiceError, postCustomerInvoice } from '../src/modules/finance/customer-invoice';
import { postVendorInvoice, VendorInvoiceError } from '../src/modules/finance/vendor-invoice';
import { getReceivables, postIncomingPayment, IncomingPaymentError } from '../src/modules/finance/incoming-payment';
import { getPayables, postOutgoingPayment as postOutgoingPaymentService } from '../src/modules/finance/outgoing-payment';
import { postGlDocument as postGlDocumentService, GlDocumentError } from '../src/modules/finance/gl-document';
import { getJournalDocument as getJournalDocumentService } from '../src/modules/finance/document-display';
import { getGlBalanceReport as getGlBalanceReportService } from '../src/modules/finance/gl-balances';
import { createTenant, defineTestRanges, destroyTenant, type TestTenant } from './helpers';
import { createSalesActor, refreshSalesActor } from './helpers/sales-actor';
import { financePoster } from './helpers/finance-actor';
import { withClientAuth } from './helpers/finance-actor';

const getGlBalanceReport = withClientAuth(getGlBalanceReportService);
const getJournalDocument = withClientAuth(getJournalDocumentService);

const ACTOR = 'CURRENCY-PRECISION-TEST';
const postGlDocument = financePoster(postGlDocumentService);
const postOutgoingPayment = financePoster(postOutgoingPaymentService);

interface Fixture { tenant: TestTenant; client: string }
const fixtures: Fixture[] = [];

/** A tenant whose company currency is `currency`, with a customer, a vendor, a 10 % tax code and a 2 %/10-day discount term. */
async function fixture(seed: string, currency: string): Promise<Fixture> {
  const tenant = await createTenant(seed, { currency });
  const client = tenant.client;
  await defineTestRanges(tenant, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'CUSTINV', subObject: '*', prefix: 'CI', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'VENDINV', subObject: '*', prefix: 'VI', numberLength: 7, createdBy: ACTOR });
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by) values
        (${client}, 'C10000', 'ORGANIZATION', 'Test Customer', ${ACTOR}), (${client}, 'V10000', 'ORGANIZATION', 'Test Vendor', ${ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by) values
        (${client}, 'C10000', 'CUSTOMER', ${ACTOR}), (${client}, 'V10000', 'SUPPLIER', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`
      insert into payment_terms (client, terms_code, description, baseline_source, net_days, discount1_days, discount1_percent, created_by)
      values (${client}, 'D10', '2 percent 10 days, net 30', 'DOCUMENT_DATE', 30, 10, 2, ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`
      insert into customer_company_code (client, partner_number, role_code, company_code, chart_of_accounts, reconciliation_account, payment_terms_code, created_by)
      values (${client}, 'C10000', 'CUSTOMER', '1000', 'CA01', '110000', 'D10', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`
      insert into supplier_company_code (client, partner_number, role_code, company_code, chart_of_accounts, reconciliation_account, payment_terms_code, created_by)
      values (${client}, 'V10000', 'SUPPLIER', '1000', 'CA01', '200000', 'D10', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`
      insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
      values (${client}, 'KW', 'T10', 'Tax 10 percent', 'VAT', 10, ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by) values
        (${client}, 'CA01', 'TAX', '', '', '240000', ${ACTOR}), (${client}, 'CA01', 'CASH_DISCOUNT', '', '', '400000', ${ACTOR}),
        (${client}, 'CA01', 'PAYMENT_DIFFERENCE', '', 'EXP', '400000', ${ACTOR}), (${client}, 'CA01', 'PAYMENT_DIFFERENCE', '', 'REV', '300000', ${ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      insert into employee_tolerance_group (client, company_code, group_key, max_document_amount, max_line_amount, max_cash_discount_percent,
        payment_diff_revenue_amount, payment_diff_expense_amount, payment_diff_revenue_percent, payment_diff_expense_percent, created_by)
      values (${client}, '', '', 0, 0, 5, 0.005, 0.005, 5, 5, ${ACTOR}) on conflict do nothing`);
  });
  const made = { tenant, client };
  fixtures.push(made);
  return made;
}
afterAll(async () => { for (const f of fixtures) await destroyTenant(f.client); }, 180_000);

const lines = async (client: string, journal: string) => withTenant(client, async (tx) => (await tx.execute(sql`
  select gl_account, debit_credit, amount_document::text as doc, amount_local::text as local, line_text, clearing_document
    from journal_entry_line where client = ${client} and document_number = ${journal} order by line_number`)) as unknown as Array<Record<string, string | null>>);

const authority = async (client: string) => {
  const actor = await createSalesActor(client);
  await refreshSalesActor(client, actor);
  return actor.authorization;
};
const customerInvoice = (client: string, currency: string, reference: string, net: number, gross: number, over: Record<string, unknown> = {}) => ({
  client, changedBy: ACTOR, customerNumber: 'C10000', companyCode: '1000', documentDate: '2026-10-16', postingDate: '2026-10-18',
  reference, currency, grossAmount: gross, requestKey: `ci-${reference}`,
  lines: [{ glAccount: '300000', netAmount: net, taxCode: 'T10' }], ...over,
});
const receipt = async (client: string, currency: string, over: Record<string, unknown>) => ({
  client, changedBy: ACTOR, customerNumber: 'C10000', companyCode: '1000',
  documentDate: '2026-10-20', postingDate: '2026-10-20', clearingDate: '2026-10-21', bankGlAccount: '101000',
  currency, authorization: await authority(client), ...over,
}) as Parameters<typeof postIncomingPayment>[0];

describe('KWD (3 decimals): customer invoice → partial and final receipt, with discount, reversal and retry', () => {
  let fx: Fixture;
  it('posts 1.237 net + 10 % tax as 1.237 / 0.124 / 1.361, with the tax calculated once and rounded half up', async () => {
    fx = await fixture('currency-kwd', 'KWD');
    const invoice = await postCustomerInvoice(customerInvoice(fx.client, 'KWD', 'KWD-1', 1.237, 1.361));
    expect(invoice).toMatchObject({ currency: 'KWD', grossAmount: '1.3610', taxAmount: '0.1240' });
    const posted = await lines(fx.client, invoice.journalDocumentNumber!);
    expect(posted.map((l) => [l.gl_account, l.debit_credit, l.doc, l.local])).toEqual([
      ['110000', 'S', '1.3610', '1.3610'], ['300000', 'H', '1.2370', '1.2370'], ['240000', 'H', '0.1240', '0.1240'],
    ]);
  });

  it('refuses a gross that does not reconcile exactly, and an amount with a lost digit', async () => {
    await expect(postCustomerInvoice(customerInvoice(fx.client, 'KWD', 'KWD-2', 1.237, 1.36))).rejects.toThrow(/does not reconcile: lines net 1\.237 plus tax 0\.124 is 1\.361/);
    await expect(postCustomerInvoice(customerInvoice(fx.client, 'KWD', 'KWD-3', 1.2371, 1.361))).rejects.toThrow(/has more decimal places than KWD allows \(3\)/);
    // The old half-cent tolerance would have passed 1.36 against 1.361; nothing is posted for either refusal.
    const open = await getReceivables(fx.client, 'C10000', '1000');
    expect(open.openItems).toHaveLength(1);
  });

  it('settles it by a partial and then a final receipt, each exact to the fils', async () => {
    const before = await getReceivables(fx.client, 'C10000', '1000');
    expect(before.openBalance).toBe(1.361);
    const item = before.openItems[0]!;
    const ref = { documentNumber: item.documentNumber, fiscalYear: item.fiscalYear, lineNumber: item.lineNumber };

    // Partial: 0.500 of 1.361 (the discount is not asked for), leaving a residual open item of 0.861.
    const partial = await postIncomingPayment(await receipt(fx.client, 'KWD', {
      amount: 0.5, requestKey: 'kwd-pay-1', items: [{ ...ref, applied: 0.5, outcome: 'RESIDUAL' }],
    }));
    expect(partial.itemsCleared).toBe(1);
    expect((await lines(fx.client, partial.journalDocumentNumber)).map((l) => [l.gl_account, l.debit_credit, l.doc])).toEqual(expect.arrayContaining([
      ['101000', 'S', '0.5000'], ['110000', 'H', '1.3610'], ['110000', 'S', '0.8610'],
    ]));
    const mid = await getReceivables(fx.client, 'C10000', '1000');
    expect(mid.openItems.map((i) => i.signed)).toEqual([0.861]);

    // Excess precision on the amount is refused, nothing posts.
    const residual = mid.openItems[0]!;
    const rref = { documentNumber: residual.documentNumber, fiscalYear: residual.fiscalYear, lineNumber: residual.lineNumber };
    await expect(postIncomingPayment(await receipt(fx.client, 'KWD', { amount: 0.8611, requestKey: 'kwd-pay-bad', items: [rref] })))
      .rejects.toThrow(/more decimal places than KWD allows/);

    // Final: exactly the residual. Nothing is left open, and the retry under the same key posts nothing new.
    const finalPay = await postIncomingPayment(await receipt(fx.client, 'KWD', { amount: 0.861, requestKey: 'kwd-pay-2', items: [rref] }));
    expect(finalPay.itemsCleared).toBe(1);
    expect((await getReceivables(fx.client, 'C10000', '1000')).openItems).toEqual([]);
    const again = await postIncomingPayment(await receipt(fx.client, 'KWD', { amount: 0.861, requestKey: 'kwd-pay-2', items: [rref] }));
    expect(again.journalDocumentNumber).toBe(finalPay.journalDocumentNumber);
    const count = await withTenant(fx.client, async (tx) => (await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${fx.client}`)) as unknown as Array<{ n: number }>);
    expect(count[0]!.n).toBe(3); // invoice, partial receipt, final receipt
  });

  it('judges the cash discount exactly: 2 % of 2.750 is 0.055 (0.056 is refused), posted at the posting date', async () => {
    const invoice = await postCustomerInvoice(customerInvoice(fx.client, 'KWD', 'KWD-4', 2.5, 2.75));
    const open = (await getReceivables(fx.client, 'C10000', '1000')).openItems.find((i) => i.documentNumber === invoice.journalDocumentNumber)!;
    const ref = { documentNumber: open.documentNumber, fiscalYear: open.fiscalYear, lineNumber: open.lineNumber };
    await expect(postIncomingPayment(await receipt(fx.client, 'KWD', { amount: 2.694, requestKey: 'kwd-disc-bad', items: [{ ...ref, discount: 0.056 }] })))
      .rejects.toThrow(/exceeds the eligible 0\.055/);
    const paid = await postIncomingPayment(await receipt(fx.client, 'KWD', { amount: 2.695, requestKey: 'kwd-disc', items: [{ ...ref, discount: 0.055 }] }));
    const rows = await lines(fx.client, paid.journalDocumentNumber);
    expect(rows.find((l) => l.line_text === 'Cash discount granted')).toMatchObject({ debit_credit: 'S', doc: '0.0550' });
    expect(rows.find((l) => l.gl_account === '101000')).toMatchObject({ doc: '2.6950' });
  });

  it('applies the configured tolerance exactly: 0.005 is within it, 0.006 is not', async () => {
    const invoice = await postCustomerInvoice(customerInvoice(fx.client, 'KWD', 'KWD-5', 4, 4.4));
    const open = (await getReceivables(fx.client, 'C10000', '1000')).openItems.find((i) => i.documentNumber === invoice.journalDocumentNumber)!;
    const ref = { documentNumber: open.documentNumber, fiscalYear: open.fiscalYear, lineNumber: open.lineNumber };
    await expect(postIncomingPayment(await receipt(fx.client, 'KWD', { amount: 4.406, requestKey: 'kwd-tol-bad', items: [{ ...ref, applied: 4.4 }] })))
      .rejects.toThrow(/unassigned difference of 0\.006/);
    const ok = await postIncomingPayment(await receipt(fx.client, 'KWD', { amount: 4.405, requestKey: 'kwd-tol', items: [{ ...ref, applied: 4.4 }] }));
    expect((await lines(fx.client, ok.journalDocumentNumber)).find((l) => l.line_text === 'Payment difference')).toMatchObject({ debit_credit: 'H', doc: '0.0050' });
  });

  it('cancels with the original posted values exactly, once, and the cancel retried posts nothing twice', async () => {
    const invoice = await postCustomerInvoice(customerInvoice(fx.client, 'KWD', 'KWD-6', 7.777, 8.555));
    expect(invoice.taxAmount).toBe('0.7780'); // 0.7777 → 0.778
    const cancel = await cancelCustomerInvoice({ client: fx.client, changedBy: ACTOR, invoiceNumber: invoice.invoiceNumber, postingDate: '2026-10-25', requestKey: 'cancel-6' });
    const original = await lines(fx.client, invoice.journalDocumentNumber!);
    const mirror = await lines(fx.client, cancel.journalDocumentNumber!);
    expect(mirror.map((l) => [l.gl_account, l.debit_credit === 'S' ? 'H' : 'S', l.doc, l.local]))
      .toEqual(original.map((l) => [l.gl_account, l.debit_credit, l.doc, l.local]));
    const replay = await cancelCustomerInvoice({ client: fx.client, changedBy: ACTOR, invoiceNumber: invoice.invoiceNumber, postingDate: '2026-10-25', requestKey: 'cancel-6' });
    expect(replay.journalDocumentNumber).toBe(cancel.journalDocumentNumber);
    await expect(cancelCustomerInvoice({ client: fx.client, changedBy: ACTOR, invoiceNumber: invoice.invoiceNumber, postingDate: '2026-10-26', requestKey: 'cancel-6b' })).rejects.toBeInstanceOf(CustomerInvoiceError);
  });

  it('the displayed document and the balances report tie to the journal in fils', async () => {
    const invoice = await postCustomerInvoice(customerInvoice(fx.client, 'KWD', 'KWD-7', 3.333, 3.666));
    const [doc] = invoice.journalDocumentNumber!.split('/').slice(0, 1);
    void doc;
    const shown = await getJournalDocument(fx.client, { documentNumber: invoice.journalDocumentNumber!, companyCode: '1000', fiscalYear: 2026 });
    expect(shown.kind).toBe('FOUND');
    if (shown.kind !== 'FOUND') return;
    expect(shown.document.debitDocument).toBe(3.666);
    expect(shown.document.creditDocument).toBe(3.666);
    expect(shown.document.debitLocal).toBe(shown.document.creditLocal);
    const report = await getGlBalanceReport(fx.client, { companyCodes: ['1000'], accountFrom: '110000', accountTo: '110000', fiscalYear: 2026, periodFrom: 1, periodTo: 12, includeSpecialPeriods: false, ledger: '0L' });
    const total = report.rows.reduce((sum, r) => sum + r.closingBalance, 0);
    const ledger = await withTenant(fx.client, async (tx) => (await tx.execute(sql`
      select coalesce(sum(case when debit_credit = 'S' then amount_local else -amount_local end), 0)::text as bal
        from journal_entry_line where client = ${fx.client} and gl_account = '110000'`)) as unknown as Array<{ bal: string }>);
    expect(total.toFixed(3)).toBe(Number(ledger[0]!.bal).toFixed(3));
  });
});

describe('KWD: supplier invoice → outgoing payment', () => {
  it('posts 1.237 net + 0.124 input tax and pays it in full and in part, to the fils', async () => {
    const fx = await fixture('currency-kwd-ap', 'KWD');
    const invoice = await postVendorInvoice({
      client: fx.client, changedBy: ACTOR, vendorNumber: 'V10000', companyCode: '1000', documentDate: '2026-10-16', postingDate: '2026-10-18',
      reference: 'SUP-1', currency: 'KWD', grossAmount: 1.361, requestKey: 'vi-1', lines: [{ glAccount: '400000', netAmount: 1.237, taxCode: 'T10' }],
    });
    expect(invoice).toMatchObject({ grossAmount: '1.3610', taxAmount: '0.1240' });
    expect((await lines(fx.client, invoice.journalDocumentNumber!)).map((l) => [l.gl_account, l.debit_credit, l.doc]))
      .toEqual([['400000', 'S', '1.2370'], ['240000', 'S', '0.1240'], ['200000', 'H', '1.3610']]);
    await expect(postVendorInvoice({
      client: fx.client, changedBy: ACTOR, vendorNumber: 'V10000', companyCode: '1000', documentDate: '2026-10-16', postingDate: '2026-10-18',
      reference: 'SUP-2', currency: 'KWD', grossAmount: 1.3611, requestKey: 'vi-2', lines: [{ glAccount: '400000', netAmount: 1.237, taxCode: 'T10' }],
    })).rejects.toBeInstanceOf(VendorInvoiceError);

    const view = await getPayables(fx.client, 'V10000', '1000');
    expect(view.openBalance).toBe(1.361);
    const item = view.openItems[0]!;
    const ref = { documentNumber: item.documentNumber, fiscalYear: item.fiscalYear, lineNumber: item.lineNumber };
    const pay = (over: Record<string, unknown>) => ({
      client: fx.client, changedBy: ACTOR, vendorNumber: 'V10000', companyCode: '1000', documentDate: '2026-10-20', postingDate: '2026-10-20',
      clearingDate: '2026-10-21', bankGlAccount: '101000', currency: 'KWD', ...over,
    }) as Parameters<typeof postOutgoingPayment>[0];
    const part = await postOutgoingPayment(pay({ amount: 0.6, requestKey: 'ap-1', items: [{ ...ref, applied: 0.6, outcome: 'RESIDUAL' }] }));
    expect((await lines(fx.client, part.journalDocumentNumber)).map((l) => [l.gl_account, l.debit_credit, l.doc])).toEqual(expect.arrayContaining([
      ['200000', 'S', '1.3610'], ['200000', 'H', '0.7610'], ['101000', 'H', '0.6000'],
    ]));
    const rest = (await getPayables(fx.client, 'V10000', '1000')).openItems[0]!;
    expect(rest.signed).toBe(0.761);
    const final = await postOutgoingPayment(pay({ amount: 0.761, requestKey: 'ap-2', items: [{ documentNumber: rest.documentNumber, fiscalYear: rest.fiscalYear, lineNumber: rest.lineNumber }] }));
    expect(final.itemsCleared).toBe(1);
    expect((await getPayables(fx.client, 'V10000', '1000')).openItems).toEqual([]);
  });
});

describe('manual G/L posting and reversal', () => {
  it('posts 1.237 KWD and refuses 1.2371; a zero-decimal ledger refuses a fraction', async () => {
    const fx = await fixture('currency-kwd-gl', 'KWD');
    const base = (amount: string, key: string) => ({
      client: fx.client, changedBy: ACTOR, requestKey: key, companyCode: '1000', documentDate: '2026-10-01', postingDate: '2026-10-01',
      documentType: 'SA', currency: 'KWD', reference: key,
      lines: [{ glAccount: '400000', debitCredit: 'S' as const, amount }, { glAccount: '101000', debitCredit: 'H' as const, amount }],
    }) as never;
    const posted = await postGlDocument(base('1.237', 'gl-kwd-1'));
    expect((await lines(fx.client, posted.documentNumber)).map((l) => [l.debit_credit, l.doc, l.local])).toEqual([['S', '1.2370', '1.2370'], ['H', '1.2370', '1.2370']]);
    await expect(postGlDocument(base('1.2371', 'gl-kwd-2'))).rejects.toThrow(/more decimal places than KWD allows \(3\)/);
    await expect(postGlDocument(base('1.2371', 'gl-kwd-2'))).rejects.toBeInstanceOf(GlDocumentError);

    const { reverseJournalEntry } = await import('../src/platform/posting');
    const reversal = await withTenant(fx.client, (tx) => reverseJournalEntry(tx, {
      client: fx.client, documentNumber: posted.documentNumber, fiscalYear: posted.fiscalYear, reversalDate: '2026-10-02', reason: 'precision test', reversedBy: ACTOR,
    }));
    expect((await lines(fx.client, reversal.documentNumber)).map((l) => [l.debit_credit, l.doc, l.local])).toEqual([['H', '1.2370', '1.2370'], ['S', '1.2370', '1.2370']]);

    const yen = await fixture('currency-jpy-gl', 'JPY');
    const jbase = (amount: string, key: string) => ({
      client: yen.client, changedBy: ACTOR, requestKey: key, companyCode: '1000', documentDate: '2026-10-01', postingDate: '2026-10-01',
      documentType: 'SA', currency: 'JPY', reference: key,
      lines: [{ glAccount: '400000', debitCredit: 'S' as const, amount }, { glAccount: '101000', debitCredit: 'H' as const, amount }],
    }) as never;
    await expect(postGlDocument(jbase('1500.5', 'gl-jpy-1'))).rejects.toThrow(/more decimal places than JPY allows \(0\)/);
    const whole = await postGlDocument(jbase('1500.00', 'gl-jpy-2')); // trailing zeros are harmless
    expect((await lines(yen.client, whole.documentNumber)).map((l) => l.doc)).toEqual(['1500.0000', '1500.0000']);
  });
});

describe('zero decimals (JPY): entry, calculated rounding and rejection of a fraction', () => {
  it('rounds a calculated tax half away from zero and refuses a fractional net', async () => {
    const fx = await fixture('currency-jpy', 'JPY');
    const ok = await postCustomerInvoice(customerInvoice(fx.client, 'JPY', 'JPY-1', 15, 17)); // tax 1.5 → 2
    expect(ok).toMatchObject({ grossAmount: '17.0000', taxAmount: '2.0000' });
    await expect(postCustomerInvoice(customerInvoice(fx.client, 'JPY', 'JPY-2', 15, 16))).rejects.toThrow(/does not reconcile/);
    await expect(postCustomerInvoice(customerInvoice(fx.client, 'JPY', 'JPY-3', 15.5, 17))).rejects.toThrow(/no minor unit|more decimal places than JPY allows \(0\)/);
    const whole = await postCustomerInvoice(customerInvoice(fx.client, 'JPY', 'JPY-4', 1000, 1100));
    expect(whole.grossAmount).toBe('1100.0000');
  });
});

describe('two decimals (USD): unchanged behaviour', () => {
  it('invoice → residual receipt → final receipt, as before', async () => {
    const fx = await fixture('currency-usd', 'USD');
    const invoice = await postCustomerInvoice(customerInvoice(fx.client, 'USD', 'USD-1', 100.01, 110.01)); // tax 10.001 → 10.00
    expect(invoice).toMatchObject({ grossAmount: '110.0100', taxAmount: '10.0000' });
    await expect(postCustomerInvoice(customerInvoice(fx.client, 'USD', 'USD-2', 100.001, 110.01))).rejects.toThrow(/more decimal places than USD allows \(2\)/);
    const item = (await getReceivables(fx.client, 'C10000', '1000')).openItems[0]!;
    const ref = { documentNumber: item.documentNumber, fiscalYear: item.fiscalYear, lineNumber: item.lineNumber };
    await postIncomingPayment(await receipt(fx.client, 'USD', { amount: 50, requestKey: 'usd-1', items: [{ ...ref, applied: 50, outcome: 'RESIDUAL' }] }));
    const rest = (await getReceivables(fx.client, 'C10000', '1000')).openItems[0]!;
    expect(rest.signed).toBe(60.01);
    const done = await postIncomingPayment(await receipt(fx.client, 'USD', {
      amount: 60.01, requestKey: 'usd-2', items: [{ documentNumber: rest.documentNumber, fiscalYear: rest.fiscalYear, lineNumber: rest.lineNumber }],
    }));
    expect(done.itemsCleared).toBe(1);
  });
});

describe('configuration: unknown currency and unstorable precision fail clearly', () => {
  it('refuses a currency that is not defined, and one with more decimals than the columns store', async () => {
    const fx = await fixture('currency-config', 'USD');
    await expect(postCustomerInvoice(customerInvoice(fx.client, 'QQQ', 'CFG-1', 10, 11))).rejects.toThrow(/Currency QQQ is not defined/);
    await withTenant(fx.client, async (tx) => {
      await tx.execute(sql`insert into currency (code, name, decimal_places, is_active) values ('QQ5', 'Five decimals', 5, true) on conflict (code) do update set decimal_places = 5`);
    });
    try {
      await expect(postCustomerInvoice(customerInvoice(fx.client, 'QQ5', 'CFG-2', 10, 11))).rejects.toThrow(/has 5 decimal places, but amounts are stored with at most 4/);
    } finally {
      await withTenant(fx.client, async (tx) => { await tx.execute(sql`delete from currency where code = 'QQ5'`); });
    }
  });
});

describe('currency separation: the posting engine rounds each amount at its own currency', () => {
  const post = (client: string, over: Record<string, unknown>) => withTenant(client, (tx) => postJournalEntry(tx, {
    client, companyCode: '1000', documentType: 'SA', documentDate: '2026-10-01', postingDate: '2026-10-01', fiscalYear: 2026, postingPeriod: 10,
    currency: 'KWD', localCurrency: 'USD', exchangeRate: '3.25000000', postedBy: ACTOR, precision: 'CURRENCY',
    lines: [{ glAccount: '400000', debitCredit: 'S', amount: '1.237' }, { glAccount: '101000', debitCredit: 'H', amount: '1.237' }],
    ...over,
  } as never));

  it('keeps 1.237 KWD in the document and 4.02 USD (4.02025) in the ledger, with the rate supplied', async () => {
    const fx = await fixture('currency-fx', 'USD');
    const posted = await post(fx.client, {});
    expect((await lines(fx.client, posted.documentNumber)).map((l) => [l.doc, l.local])).toEqual([['1.2370', '4.0200'], ['1.2370', '4.0200']]);
    await expect(post(fx.client, { lines: [{ glAccount: '400000', debitCredit: 'S', amount: '1.2371' }, { glAccount: '101000', debitCredit: 'H', amount: '1.2371' }] }))
      .rejects.toBeInstanceOf(PostingError);
    // A stated local amount is judged at the LOCAL currency's decimals (USD: two), not the document's.
    await expect(post(fx.client, { lines: [
      { glAccount: '400000', debitCredit: 'S', amount: '1.237', amountLocal: '4.021' }, { glAccount: '101000', debitCredit: 'H', amount: '1.237', amountLocal: '4.021' },
    ] })).rejects.toThrow(/local amount 4\.021 has more decimal places than USD allows \(2\)/);
    // KWD into a zero-decimal local currency: 1.237 × 487.5 = 603.0375 → 603
    const jpy = await post(fx.client, { localCurrency: 'JPY', exchangeRate: '487.50000000' });
    expect((await lines(fx.client, jpy.documentNumber)).map((l) => l.local)).toEqual(['603.0000', '603.0000']);
  });
});
