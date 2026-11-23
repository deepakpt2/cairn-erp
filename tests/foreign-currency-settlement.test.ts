import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postJournalEntry, reverseJournalEntry } from '../src/platform/posting';
import { createFinanceActor, type FinanceActor } from './helpers/finance-actor';
import { postCustomerInvoice } from '../src/modules/finance/customer-invoice';
import { postCustomerCreditMemo } from '../src/modules/finance/customer-credit-memo';
import { clearCustomerItems } from '../src/modules/finance/customer-clearing';
import { resetClearing } from '../src/modules/finance/clearing-reset';
import { postVendorInvoice } from '../src/modules/finance/vendor-invoice';
import { getReceivables, postIncomingPayment } from '../src/modules/finance/incoming-payment';
import { getPayables, postOutgoingPayment } from '../src/modules/finance/outgoing-payment';
import { executeFxValuation } from '../src/modules/finance/fx-valuation';
import {
  getBankReconciliation, matchBankStatement, saveBankStatement,
} from '../src/modules/finance/bank-reconciliation';
import { createTenant, defineTestRanges, destroyTenant, seedAccounts, type TestTenant } from './helpers';

const ACTOR = 'FX_E2E_TEST';
const COMPANY = '1000';

/**
 * End-to-end foreign-currency acceptance:
 *
 *   local currency KWD (3 decimals), USD receivable 100 at 0.300 KWD/USD then a receipt at
 *   0.310 — carrying 30.000, bank 31.000, realized gain 1.000; the vendor direction at the
 *   same movement produces a loss, not a gain.
 *
 * The suite exercises the service boundaries and the database effects: document and local
 * amounts, open-item release, the realized FX line, reversal, valuation conflict, and a
 * foreign-currency bank statement.
 */

let tenant: TestTenant;
let actor: FinanceActor;

async function setup(): Promise<void> {
  tenant = await createTenant('fx-e2e', { currency: 'KWD' });
  await defineTestRanges(tenant, { fiscalYear: 2026 });
  await seedAccounts(tenant, ['590100', '590200', '102000']);
  await withTenant(tenant.client, async (tx) => {
    await defineRange(tx, { client: tenant.client, objectCode: 'CUSTINV', subObject: '*', prefix: 'CI', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client: tenant.client, objectCode: 'VENDINV', subObject: '*', prefix: 'VI', numberLength: 7, createdBy: ACTOR });
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by) values
        (${tenant.client}, 'C10000', 'ORGANIZATION', 'FX Customer', ${ACTOR}),
        (${tenant.client}, 'V10000', 'ORGANIZATION', 'FX Vendor', ${ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by) values
        (${tenant.client}, 'C10000', 'CUSTOMER', ${ACTOR}),
        (${tenant.client}, 'V10000', 'SUPPLIER', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`
      insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
      values (${tenant.client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`
      insert into customer_company_code
        (client, partner_number, role_code, company_code, chart_of_accounts, reconciliation_account, payment_terms_code, created_by)
      values (${tenant.client}, 'C10000', 'CUSTOMER', '1000', 'CA01', '110000', 'NET30', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`
      insert into supplier_company_code
        (client, partner_number, role_code, company_code, chart_of_accounts, reconciliation_account, payment_terms_code, created_by)
      values (${tenant.client}, 'V10000', 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by) values
        (${tenant.client}, 'CA01', 'FXGAIN', '', '', '590100', ${ACTOR}),
        (${tenant.client}, 'CA01', 'FXLOSS', '', '', '590200', ${ACTOR}),
        (${tenant.client}, 'CA01', 'PAYMENT_DIFFERENCE', '', 'EXP', '400000', ${ACTOR}),
        (${tenant.client}, 'CA01', 'PAYMENT_DIFFERENCE', '', 'REV', '300000', ${ACTOR})
      on conflict do nothing`);
    // The AR control is open-item managed and valued.
    await tx.execute(sql`
      update gl_account set account_type = 'ASSET', gl_account_type = 'BALANCE_SHEET',
        is_balance_sheet = true, is_open_item_managed = true
      where client = ${tenant.client} and chart_of_accounts = 'CA01' and account_number = '110000'`);
    // Rates: 0.300 until 2026-10-15, 0.310 then, 0.320 from the 20th, and a future 0.500 that must
    // never hide an earlier valid row. EUR is quoted indirectly; SAR is an explicit maintained 1.
    await tx.execute(sql`
      insert into exchange_rate (client, rate_type, from_currency, to_currency, valid_from, rate, created_by) values
        (${tenant.client}, 'AVERAGE', 'USD', 'KWD', '2026-01-01', 0.300, ${ACTOR}),
        (${tenant.client}, 'AVERAGE', 'USD', 'KWD', '2026-10-15', 0.310, ${ACTOR}),
        (${tenant.client}, 'AVERAGE', 'USD', 'KWD', '2026-10-20', 0.320, ${ACTOR}),
        (${tenant.client}, 'AVERAGE', 'USD', 'KWD', '2027-01-01', 0.500, ${ACTOR}),
        (${tenant.client}, 'AVERAGE', 'EUR', 'KWD', '2026-01-01', 3.33333333, ${ACTOR}),
        (${tenant.client}, 'AVERAGE', 'SAR', 'KWD', '2026-01-01', 1.000, ${ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      update exchange_rate set is_indirect_quote = true
      where client = ${tenant.client} and from_currency = 'EUR' and to_currency = 'KWD'`);
    // A bank account held in USD while the company keeps KWD books.
    await tx.execute(sql`
      insert into bank_master (bank_country, bank_key, name, created_by)
      values ('KW', 'NBK001', 'Test National Bank', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`
      insert into house_bank (client, company_code, house_bank_key, bank_country, bank_key, created_by)
      values (${tenant.client}, '1000', 'HB02', 'KW', 'NBK001', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`
      insert into bank_account
        (client, company_code, house_bank_key, account_id, account_number, currency, gl_account, created_by)
      values (${tenant.client}, '1000', 'HB02', 'USD1', '87654321', 'USD', '102000', ${ACTOR})
      on conflict do nothing`);
  });
  actor = await createFinanceActor(tenant.client);
}

beforeAll(async () => { await setup(); }, 180_000);

afterAll(async () => {
  if (tenant?.client) await destroyTenant(tenant.client);
}, 300_000);

async function journalLines(client: string, documentNumber: string) {
  return withTenant(client, async (tx) => (await tx.execute(sql`
    select gl_account, debit_credit, amount_document::text as doc, amount_local::text as local,
           currency, is_local_only, line_text
      from journal_entry_line where client = ${client} and document_number = ${documentNumber}
     order by line_number`)) as unknown as Array<Record<string, string | boolean | null>>);
}

async function journalHeader(client: string, documentNumber: string) {
  const rows = await withTenant(client, async (tx) => (await tx.execute(sql`
    select exchange_rate::text as rate, rate_source, rate_valid_from::text as valid_from,
           rate_type, rate_is_indirect_quote
      from journal_entry where client = ${client} and document_number = ${documentNumber}`)) as unknown as Array<Record<string, unknown>>);
  return rows[0]!;
}

function invoice(currency: string, reference: string, date: string, gross = 100) {
  return {
    client: tenant.client, changedBy: ACTOR, customerNumber: 'C10000', companyCode: COMPANY,
    documentDate: date, postingDate: date, reference, currency, grossAmount: gross,
    requestKey: `ci-${reference}`,
    lines: [{ glAccount: '300000', netAmount: gross }],
  };
}

function receive(currency: string, date: string, amount: number, items: Array<{ documentNumber: string; fiscalYear: number; lineNumber: number }>, key: string, bankGlAccount = '101000') {
  return {
    client: tenant.client, changedBy: ACTOR, customerNumber: 'C10000', companyCode: COMPANY,
    documentDate: date, postingDate: date, clearingDate: date,
    bankGlAccount, amount, currency, requestKey: key, items,
    authorization: actor.authorization,
  };
}

describe('foreign-currency invoice, settlement and realized FX', () => {
  let receivableDoc = '';
  let receivableItem: { documentNumber: string; fiscalYear: number; lineNumber: number };
  let receiptJournal = '';

  it('posts a USD receivable at the latest valid rate and snapshots its provenance', async () => {
    const posted = await postCustomerInvoice(invoice('USD', 'FX-INV-1', '2026-06-01', 100));
    receivableDoc = posted.journalDocumentNumber!;
    const header = await journalHeader(tenant.client, receivableDoc);
    expect(Number(header.rate)).toBeCloseTo(0.3, 8);
    expect(header.rate_source).toBe('EXCHANGE_RATE_MASTER');
    expect(header.valid_from).toBe('2026-01-01');
    const lines = await journalLines(tenant.client, receivableDoc);
    const ar = lines.find((l) => l.gl_account === '110000')!;
    expect(ar).toMatchObject({ debit_credit: 'S', doc: '100.0000', local: '30.0000' });
    const view = await getReceivables(tenant.client, 'C10000', COMPANY);
    receivableItem = { documentNumber: view.openItems[0]!.documentNumber, fiscalYear: view.openItems[0]!.fiscalYear, lineNumber: view.openItems[0]!.lineNumber };
  });

  it('receives at 0.310 and posts the realized gain, not a rate-1 conversion', async () => {
    const receipt = await postIncomingPayment(receive('USD', '2026-10-16', 100, [receivableItem], 'fx-receipt-1'));
    receiptJournal = receipt.journalDocumentNumber;
    const lines = await journalLines(tenant.client, receiptJournal);
    expect(lines.find((l) => l.gl_account === '101000')).toMatchObject({ debit_credit: 'S', doc: '100.0000', local: '31.0000' });
    expect(lines.find((l) => l.gl_account === '110000')).toMatchObject({ debit_credit: 'H', doc: '100.0000', local: '30.0000' });
    const gain = lines.find((l) => l.gl_account === '590100')!;
    expect(gain).toMatchObject({ debit_credit: 'H', doc: '0.0000', local: '1.0000', is_local_only: true });
    expect((await getReceivables(tenant.client, 'C10000', COMPANY)).openItems).toEqual([]);
    const header = await journalHeader(tenant.client, receiptJournal);
    expect(Number(header.rate)).toBeCloseTo(0.31, 8);
  });

  it('reverses the receipt exactly, keeping the original rate and the FX line', async () => {
    const reversal = await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
      client: tenant.client, documentNumber: receiptJournal, fiscalYear: 2026,
      reversalDate: '2026-10-17', reason: 'FX reversal test', reversedBy: ACTOR,
    }));
    const lines = await journalLines(tenant.client, reversal.documentNumber);
    expect(lines.find((l) => l.gl_account === '101000')).toMatchObject({ debit_credit: 'H', doc: '100.0000', local: '31.0000' });
    expect(lines.find((l) => l.gl_account === '110000')).toMatchObject({ debit_credit: 'S', doc: '100.0000', local: '30.0000' });
    expect(lines.find((l) => l.gl_account === '590100')).toMatchObject({ debit_credit: 'S', doc: '0.0000', local: '1.0000', is_local_only: true });
    const header = await journalHeader(tenant.client, reversal.documentNumber);
    expect(Number(header.rate)).toBeCloseTo(0.31, 8);
    // The original open item is restored, not re-priced.
    expect((await getReceivables(tenant.client, 'C10000', COMPANY)).openItems).toHaveLength(1);
  });

  it('posts a vendor payment at the same movement as a loss, not a gain', async () => {
    const posted = await postVendorInvoice({
      client: tenant.client, changedBy: ACTOR, vendorNumber: 'V10000', companyCode: COMPANY,
      documentDate: '2026-06-01', postingDate: '2026-06-01', reference: 'FX-VI-1',
      currency: 'USD', grossAmount: 100, requestKey: 'fx-vi-1',
      lines: [{ glAccount: '400000', netAmount: 100 }],
    });
    expect((await journalLines(tenant.client, posted.journalDocumentNumber!)).find((l) => l.gl_account === '200000'))
      .toMatchObject({ debit_credit: 'H', doc: '100.0000', local: '30.0000' });
    const view = await getPayables(tenant.client, 'V10000', COMPANY);
    const item = view.openItems[0]!;
    const payment = await postOutgoingPayment({
      client: tenant.client, changedBy: ACTOR, vendorNumber: 'V10000', companyCode: COMPANY,
      documentDate: '2026-10-16', postingDate: '2026-10-16', clearingDate: '2026-10-16',
      bankGlAccount: '101000', amount: 100, currency: 'USD', requestKey: 'fx-ap-1',
      items: [{ documentNumber: item.documentNumber, fiscalYear: item.fiscalYear, lineNumber: item.lineNumber }],
    }, { authorization: actor.authorization });
    const lines = await journalLines(tenant.client, payment.journalDocumentNumber);
    expect(lines.find((l) => l.gl_account === '200000')).toMatchObject({ debit_credit: 'S', doc: '100.0000', local: '30.0000' });
    expect(lines.find((l) => l.gl_account === '101000')).toMatchObject({ debit_credit: 'H', doc: '100.0000', local: '31.0000' });
    expect(lines.find((l) => l.gl_account === '590200')).toMatchObject({ debit_credit: 'S', doc: '0.0000', local: '1.0000', is_local_only: true });
  });

  it('settles multiple invoice rates in one receipt with one exact gain', async () => {
    const a = await postCustomerInvoice(invoice('USD', 'FX-INV-A', '2026-06-01', 100));
    const b = await postCustomerInvoice(invoice('USD', 'FX-INV-B', '2026-10-16', 50));
    const view = await getReceivables(tenant.client, 'C10000', COMPANY);
    const refs = view.openItems
      .filter((i) => [a.journalDocumentNumber, b.journalDocumentNumber].includes(i.documentNumber))
      .map((i) => ({ documentNumber: i.documentNumber, fiscalYear: i.fiscalYear, lineNumber: i.lineNumber }));
    // a carries 30.000 at 0.300; b carries 15.500 at 0.310; the receipt is 48.000 at 0.320.
    const receipt = await postIncomingPayment(receive('USD', '2026-10-25', 150, refs, 'fx-receipt-multi'));
    const lines = await journalLines(tenant.client, receipt.journalDocumentNumber);
    expect(lines.find((l) => l.gl_account === '101000')).toMatchObject({ doc: '150.0000', local: '48.0000' });
    expect(lines.filter((l) => l.gl_account === '110000')).toHaveLength(2);
    expect(lines.find((l) => l.gl_account === '590100')).toMatchObject({ local: '2.5000', is_local_only: true });
  });

  it('honours ratios and an indirect quotation', async () => {
    const eur = await postCustomerInvoice(invoice('EUR', 'FX-INV-EUR', '2026-06-01', 100));
    expect((await journalLines(tenant.client, eur.journalDocumentNumber!)).find((l) => l.gl_account === '110000'))
      .toMatchObject({ doc: '100.0000', local: '30.0000' });
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into exchange_rate (client, rate_type, from_currency, to_currency, valid_from, rate, ratio_from, ratio_to, created_by)
        values (${tenant.client}, 'AVERAGE', 'GBP', 'KWD', '2026-01-01', 300, 1000, 1, ${ACTOR})
        on conflict do nothing`);
    });
    const gbp = await postCustomerInvoice(invoice('GBP', 'FX-INV-GBP', '2026-06-01', 100));
    expect((await journalLines(tenant.client, gbp.journalDocumentNumber!)).find((l) => l.gl_account === '110000'))
      .toMatchObject({ doc: '100.0000', local: '30.0000' });
  });

  it('realizes the difference on a customer clearing and reverse it exactly on reset', async () => {
    // Invoice at 0.310 (carrying 31) cleared against a credit memo posted at 0.300 (carrying 30):
    // the 1.000 debit is a realized loss, and reset must reverse the clearing journal exactly.
    const inv = await postCustomerInvoice(invoice('USD', 'FX-CLR-INV', '2026-10-16', 100));
    const memo = await postCustomerCreditMemo({
      client: tenant.client, changedBy: ACTOR, customerNumber: 'C10000', companyCode: COMPANY,
      documentDate: '2026-06-01', postingDate: '2026-06-01', reference: 'FX-CLR-CM',
      currency: 'USD', grossAmount: 100, requestKey: 'fx-clr-cm',
      lines: [{ glAccount: '300000', netAmount: 100 }],
    });
    const refs = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select document_number, fiscal_year, line_number
        from journal_entry_line
       where client = ${tenant.client} and gl_account = '110000' and clearing_document is null
         and document_number in (${inv.journalDocumentNumber}, ${memo.journalDocumentNumber})`)) as unknown as Array<{
      document_number: string; fiscal_year: number; line_number: number;
    }>);
    expect(refs).toHaveLength(2);
    const clearing = await clearCustomerItems({
      client: tenant.client, changedBy: ACTOR, customer: 'C10000', companyCode: COMPANY,
      clearingDate: '2026-10-25', postingDate: '2026-10-25', documentDate: '2026-10-25',
      confirmed: true, requestKey: 'fx-clr-1',
      items: refs.map((r) => ({ documentNumber: r.document_number, fiscalYear: r.fiscal_year, lineNumber: r.line_number })),
    });
    const lines = await journalLines(tenant.client, clearing.clearingDocumentNumber);
    expect(lines.find((l) => l.gl_account === '590200')).toMatchObject({
      debit_credit: 'S', doc: '0.0000', local: '1.0000', is_local_only: true,
    });

    await resetClearing({
      client: tenant.client, changedBy: ACTOR, companyCode: COMPANY,
      clearingDocument: clearing.clearingDocumentNumber, fiscalYear: 2026,
      reason: 'FX clearing reset test', requestKey: 'fx-clr-reset-1',
    });
    const clearingStatus = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select status from journal_entry where client = ${tenant.client}
        and document_number = ${clearing.clearingDocumentNumber} and fiscal_year = 2026`)) as unknown as Array<{ status: string }>);
    expect(clearingStatus[0]!.status).toBe('REVERSED');
    const reversal = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select document_number from journal_entry where client = ${tenant.client}
        and reversal_of = ${clearing.clearingDocumentNumber}`)) as unknown as Array<{ document_number: string }>);
    const mirrored = await journalLines(tenant.client, reversal[0]!.document_number);
    expect(mirrored.find((l) => l.gl_account === '590200')).toMatchObject({
      debit_credit: 'H', doc: '0.0000', local: '1.0000', is_local_only: true,
    });
    // The items stand open again.
    const openRefs = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select count(*)::int as n from journal_entry_line
       where client = ${tenant.client} and gl_account = '110000' and clearing_document is null
         and document_number in (${inv.journalDocumentNumber}, ${memo.journalDocumentNumber})`)) as unknown as Array<{ n: number }>);
    expect(openRefs[0]!.n).toBe(2);
  });

  it('accepts an explicitly maintained foreign rate of 1', async () => {
    const sar = await postCustomerInvoice(invoice('SAR', 'FX-INV-SAR', '2026-06-01', 100));
    expect((await journalLines(tenant.client, sar.journalDocumentNumber!)).find((l) => l.gl_account === '110000'))
      .toMatchObject({ doc: '100.0000', local: '100.0000' });
  });

  it('refuses a foreign document with no maintained rate, atomically', async () => {
    const before = await withTenant(tenant.client, async (tx) => ((await tx.execute(sql`
      select count(*)::int as n from journal_entry where client = ${tenant.client}`)) as unknown as Array<{ n: number }>)[0]!.n);
    await expect(postCustomerInvoice(invoice('JPY', 'FX-INV-JPY', '2026-06-01', 100)))
      .rejects.toThrow(/No AVERAGE exchange rate stands from JPY to KWD/);
    const after = await withTenant(tenant.client, async (tx) => ((await tx.execute(sql`
      select count(*)::int as n from journal_entry where client = ${tenant.client}`)) as unknown as Array<{ n: number }>)[0]!.n);
    expect(after).toBe(before);
  });
});

describe('foreign-currency bank reconciliation', () => {
  let bankDocument = '';

  it('posts a USD-bank receipt and reconciles the statement in USD while preserving KWD carrying', async () => {
    const inv = await postCustomerInvoice(invoice('USD', 'FX-BANK-INV', '2026-06-01', 100));
    const open = (await getReceivables(tenant.client, 'C10000', COMPANY)).openItems
      .find((i) => i.documentNumber === inv.journalDocumentNumber)!;
    const receipt = await postIncomingPayment(receive('USD', '2026-10-16', 100, [
      { documentNumber: open.documentNumber, fiscalYear: open.fiscalYear, lineNumber: open.lineNumber },
    ], 'fx-bank-receipt', '102000'));
    bankDocument = receipt.journalDocumentNumber;
    const saved = await saveBankStatement({
      client: tenant.client, companyCode: COMPANY, houseBankKey: 'HB02', accountId: 'USD1',
      currency: 'USD', statementReference: 'FX-STMT-1',
      fromDate: '2026-10-01', toDate: '2026-10-31', openingBalance: '0', closingBalance: '100',
      lines: [{ direction: 'IN', amount: '100', valueDate: '2026-10-16', transactionDate: '2026-10-16', bankReference: 'FX-BANK' }],
    }, { authorization: actor.authorization });
    const view = await getBankReconciliation({
      client: tenant.client, companyCode: COMPANY, houseBankKey: 'HB02', accountId: 'USD1',
      statementId: saved.statementId,
    }, { authorization: actor.authorization });
    expect(view.currency).toBe('USD');
    const ledger = view.ledgerLines.find((l) => l.documentNumber === bankDocument)!;
    expect(ledger).toMatchObject({ amount: '100.00', localCurrency: 'KWD', localAmount: '31.000' });
    expect(view.issues.filter((i) => i.blocking)).toEqual([]);
    expect(view.statement!.lines[0]!.lineId).toBeTruthy();
    const lineId = view.statement!.lines[0]!.lineId;
    const matched = await matchBankStatement({
      client: tenant.client, statementId: saved.statementId, requestKey: 'fx-match-1',
      allocations: [{
        statementLineId: lineId, ledgerDocumentNumber: bankDocument, ledgerFiscalYear: 2026,
        ledgerLineNumber: 1, amount: '100',
      }],
    }, { authorization: actor.authorization });
    expect(matched.matchIds).toHaveLength(1);
    const after = await getBankReconciliation({
      client: tenant.client, companyCode: COMPANY, houseBankKey: 'HB02', accountId: 'USD1',
      statementId: saved.statementId,
    }, { authorization: actor.authorization });
    const match = after.statement!.lines[0]!.matches[0]!;
    expect(match).toMatchObject({ amount: '100.0000', localAmount: '31.0000' });
  });

  it('flags a legacy line with no account-currency evidence instead of inventing a rate', async () => {
    // A KWD movement on a USD bank G/L: neither the line nor the local currency is USD.
    const legacy = await withTenant(tenant.client, (tx) => postJournalEntry(tx, {
      client: tenant.client, companyCode: COMPANY, documentType: 'SA',
      documentDate: '2026-10-20', postingDate: '2026-10-20', fiscalYear: 2026, postingPeriod: 10,
      currency: 'KWD', localCurrency: 'KWD', postedBy: ACTOR,
      lines: [
        { glAccount: '102000', debitCredit: 'S', amount: '5.000' },
        { glAccount: '400000', debitCredit: 'H', amount: '5.000' },
      ],
    }));
    const statements = (await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select statement_id from bank_statement where client = ${tenant.client} and statement_reference = 'FX-STMT-1'`)) as unknown as Array<{ statement_id: string }>));
    const view = await getBankReconciliation({
      client: tenant.client, companyCode: COMPANY, houseBankKey: 'HB02', accountId: 'USD1',
      statementId: statements[0]!.statement_id,
    }, { authorization: actor.authorization });
    expect(view.issues.some((i) => i.code === 'LEDGER_CURRENCY' && i.blocking)).toBe(true);
    const legacyLine = view.ledgerLines.find((l) => l.documentNumber === legacy.documentNumber)!;
    expect(legacyLine.amount).toBe('0.00');
  });
});

describe('period-end valuation and settlement', () => {
  it('refuses settlement over an active valuation, then settles after the valuation is reversed', async () => {
    const inv = await postCustomerInvoice(invoice('USD', 'FX-VAL-INV', '2026-06-01', 100));
    const open = (await getReceivables(tenant.client, 'C10000', COMPANY)).openItems
      .find((i) => i.documentNumber === inv.journalDocumentNumber)!;
    const item = { documentNumber: open.documentNumber, fiscalYear: open.fiscalYear, lineNumber: open.lineNumber };

    const valuation = await executeFxValuation({
      client: tenant.client, changedBy: ACTOR, authorization: actor.authorization,
      selection: {
        companyCode: COMPANY, valuationArea: 'FXTEST', valuationKeyDate: '2026-10-25',
        postingDate: '2026-10-25', fiscalYear: 2026, valuationMethod: 'AVERAGE',
        includeOpenItems: true, includeBalances: false, testRun: false,
        documentType: 'SA', requestKey: 'fx-val-1',
      },
    });
    expect(valuation.postingDocument).toBeTruthy();
    expect(valuation.totalGain).toBeGreaterThan(0);

    await expect(postIncomingPayment(receive('USD', '2026-10-26', 100, [item], 'fx-val-pay-1')))
      .rejects.toThrow(/valued at period end/);

    // Reverse the valuation document: it is an ordinary posted journal, and its mirror restores the
    // unrealized difference. The run's item no longer counts as active.
    await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
      client: tenant.client, documentNumber: valuation.postingDocument!, fiscalYear: 2026,
      reversalDate: '2026-10-26', reason: 'reverse valuation before settlement', reversedBy: ACTOR,
    }));
    const receipt = await postIncomingPayment(receive('USD', '2026-10-27', 100, [item], 'fx-val-pay-2'));
    const lines = await journalLines(tenant.client, receipt.journalDocumentNumber);
    // The invoice carried 30; the receipt is at 0.320 -> bank 32, gain 2. The valuation is gone.
    expect(lines.find((l) => l.gl_account === '101000')).toMatchObject({ local: '32.0000' });
    expect(lines.find((l) => l.gl_account === '590100')).toMatchObject({ local: '2.0000', is_local_only: true });
  });
});
