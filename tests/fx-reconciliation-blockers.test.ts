import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postJournalEntry, reverseJournalEntry } from '../src/platform/posting';
import { createFinanceActor, type FinanceActor } from './helpers/finance-actor';
import { postCustomerInvoice } from '../src/modules/finance/customer-invoice';
import { postVendorInvoice } from '../src/modules/finance/vendor-invoice';
import { getReceivables, postIncomingPayment } from '../src/modules/finance/incoming-payment';
import { getPayables, postOutgoingPayment } from '../src/modules/finance/outgoing-payment';
import { clearCustomerItems } from '../src/modules/finance/customer-clearing';
import { clearVendorItems } from '../src/modules/finance/vendor-clearing';
import { resetClearing } from '../src/modules/finance/clearing-reset';
import { executeFxValuation, type FxValuationSelection } from '../src/modules/finance/fx-valuation';
import {
  finalizeBankStatement, getBankReconciliation, matchBankStatement, saveBankStatement,
  unmatchBankStatement,
} from '../src/modules/finance/bank-reconciliation';
import {
  createPaymentRun, executePaymentRun, generateProposal, getPaymentRun,
} from '../src/modules/finance/payment-run';
import {
  PAYMENT_RUN_RELEASE_CATEGORY, releasePaymentRunForProvisioning,
} from '../src/modules/finance/payment-run-release';
import { lockValuationSettlement } from '../src/modules/finance/fx-settlement';
import { createTenant, defineTestRanges, destroyTenant, seedAccounts, type TestTenant } from './helpers';
import { defineReleaseStrategy } from './helpers/release-config';

const ACTOR = 'FX_BLOCKER_TEST';
const COMPANY = '1000';

let tenant: TestTenant;
let actor: FinanceActor;

async function setup(): Promise<void> {
  tenant = await createTenant('fx-blockers', { currency: 'KWD' });
  await defineTestRanges(tenant, { fiscalYear: 2026 });
  await defineTestRanges(tenant, { fiscalYear: 2027 });
  await seedAccounts(tenant, [
    '590100', '590200', '102000', '103000', '104000', '105000', '106000', '107000', '108000',
    '109000', '111000', '112000', '113000', '114000', '115000', '116000', '117000', '118000', '119000', '120000', '121000',
  ]);
  await withTenant(tenant.client, async (tx) => {
    await defineRange(tx, { client: tenant.client, objectCode: 'CUSTINV', subObject: '*', prefix: 'CI', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client: tenant.client, objectCode: 'VENDINV', subObject: '*', prefix: 'VI', numberLength: 7, createdBy: ACTOR });
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by) values
        (${tenant.client}, 'C10000', 'ORGANIZATION', 'Blocker Customer', ${ACTOR}),
        (${tenant.client}, 'V10000', 'ORGANIZATION', 'Blocker Vendor', ${ACTOR}),
        (${tenant.client}, 'V20000', 'ORGANIZATION', 'Second Vendor', ${ACTOR}),
        (${tenant.client}, 'C20000', 'ORGANIZATION', 'Balance-Valuation Customer', ${ACTOR}),
        (${tenant.client}, 'C30000', 'ORGANIZATION', 'Reset Safety Customer', ${ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by) values
        (${tenant.client}, 'C10000', 'CUSTOMER', ${ACTOR}),
        (${tenant.client}, 'C20000', 'CUSTOMER', ${ACTOR}),
        (${tenant.client}, 'C30000', 'CUSTOMER', ${ACTOR}),
        (${tenant.client}, 'V10000', 'SUPPLIER', ${ACTOR}),
        (${tenant.client}, 'V20000', 'SUPPLIER', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`
      insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
      values (${tenant.client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`
      insert into customer_company_code
        (client, partner_number, role_code, company_code, chart_of_accounts, reconciliation_account, payment_terms_code, created_by)
      values (${tenant.client}, 'C10000', 'CUSTOMER', '1000', 'CA01', '110000', 'NET30', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`
      insert into customer_company_code
        (client, partner_number, role_code, company_code, chart_of_accounts, reconciliation_account, payment_terms_code, created_by)
      values (${tenant.client}, 'C20000', 'CUSTOMER', '1000', 'CA01', '108000', 'NET30', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`
      insert into customer_company_code
        (client, partner_number, role_code, company_code, chart_of_accounts, reconciliation_account, payment_terms_code, created_by)
      values (${tenant.client}, 'C30000', 'CUSTOMER', '1000', 'CA01', '110000', 'NET30', ${ACTOR}) on conflict do nothing`);
    for (const vendor of ['V10000', 'V20000']) {
      await tx.execute(sql`
        insert into supplier_company_code
          (client, partner_number, role_code, company_code, chart_of_accounts, reconciliation_account, payment_terms_code, payment_methods, created_by)
        values (${tenant.client}, ${vendor}, 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', 'T', ${ACTOR}) on conflict do nothing`);
    }
    await tx.execute(sql`
      insert into payment_method (client, country, method_code, description, allowed_direction, created_by)
      values (${tenant.client}, 'KW', 'T', 'Bank transfer', 'OUTGOING', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by) values
        (${tenant.client}, 'CA01', 'FXGAIN', '', '', '590100', ${ACTOR}),
        (${tenant.client}, 'CA01', 'FXLOSS', '', '', '590200', ${ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      update gl_account set account_type = 'ASSET', gl_account_type = 'BALANCE_SHEET',
        is_balance_sheet = true, is_open_item_managed = true
      where client = ${tenant.client} and chart_of_accounts = 'CA01' and account_number in ('110000', '200000')`);
    await tx.execute(sql`
      update gl_account set account_type = 'ASSET', gl_account_type = 'BALANCE_SHEET',
        is_balance_sheet = true, is_open_item_managed = false
      where client = ${tenant.client} and chart_of_accounts = 'CA01'
        and account_number in ('102000', '103000', '104000', '105000', '106000', '107000', '108000',
          '109000', '111000', '112000', '113000', '114000', '115000', '116000', '117000', '118000', '119000', '120000', '121000')`);
    // 0.300 until 15 Oct, 0.310 then, 0.320 from 20 Oct, 0.330 from December, and a dedicated
    // 0.30001 row used to carry exactly KWD 30.001 on USD 100.
    await tx.execute(sql`
      insert into exchange_rate (client, rate_type, from_currency, to_currency, valid_from, rate, created_by) values
        (${tenant.client}, 'AVERAGE', 'USD', 'KWD', '2026-01-01', 0.300, ${ACTOR}),
        (${tenant.client}, 'AVERAGE', 'USD', 'KWD', '2026-10-15', 0.310, ${ACTOR}),
        (${tenant.client}, 'AVERAGE', 'USD', 'KWD', '2026-10-20', 0.320, ${ACTOR}),
        (${tenant.client}, 'AVERAGE', 'USD', 'KWD', '2026-12-01', 0.330, ${ACTOR}),
        (${tenant.client}, 'AVERAGE', 'USD', 'KWD', '2026-12-04', 0.320, ${ACTOR}),
        (${tenant.client}, 'AVERAGE', 'USD', 'KWD', '2026-11-01', 0.30001, ${ACTOR}),
        (${tenant.client}, 'AVERAGE', 'EUR', 'KWD', '2026-01-01', 3.33333333, ${ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      update exchange_rate set is_indirect_quote = true
      where client = ${tenant.client} and from_currency = 'EUR' and to_currency = 'KWD'`);
    await tx.execute(sql`
      insert into bank_master (bank_country, bank_key, name, created_by)
      values ('KW', 'NBK001', 'Blocker National Bank', ${ACTOR}) on conflict do nothing`);
    // HB01 pays from a local-currency account; HB02 is a USD account; HB03 is a third-currency
    // (EUR) account; HB04/HB05 are isolated USD accounts for valuation and as-of tests.
    for (const [key, account, currency, gl] of [
      ['HB01', 'KWD1', 'KWD', '103000'],
      ['HB02', 'USD1', 'USD', '102000'],
      ['HB03', 'EUR1', 'EUR', '104000'],
      ['HB04', 'USD2', 'USD', '105000'],
      ['HB05', 'USD3', 'USD', '106000'],
      ['HB06', 'KWD4', 'KWD', '107000'],
      ['HB07', 'USD4', 'USD', '109000'],
      ['HB08', 'USD5', 'USD', '111000'],
      ['HB09', 'USD6', 'USD', '112000'],
      ['HB10', 'USD7', 'USD', '112000'],
      ['HB11', 'USD8', 'USD', '113000'],
      ['HB12', 'USD9', 'USD', '114000'],
      ['HB13', 'USD10', 'USD', '115000'],
      ['HB14', 'USD11', 'USD', '116000'],
      ['HB15', 'KWD5', 'KWD', '117000'],
      ['HB16', 'KWD6', 'KWD', '118000'],
      ['HB17', 'USD12', 'USD', '119000'],
      ['HB18', 'USD13', 'USD', '120000'],
      ['HB19', 'KWD7', 'KWD', '121000'],
    ] as const) {
      await tx.execute(sql`
        insert into house_bank (client, company_code, house_bank_key, bank_country, bank_key, created_by)
        values (${tenant.client}, '1000', ${key}, 'KW', 'NBK001', ${ACTOR}) on conflict do nothing`);
      await tx.execute(sql`
        insert into bank_account
          (client, company_code, house_bank_key, account_id, account_number, currency, gl_account, created_by)
        values (${tenant.client}, '1000', ${key}, ${account}, ${`${Math.floor(Math.random() * 1e8)}`}, ${currency}, ${gl}, ${ACTOR})
        on conflict do nothing`);
    }
  });
  await defineReleaseStrategy({
    client: tenant.client, actor: ACTOR, category: PAYMENT_RUN_RELEASE_CATEGORY,
    group: 'RUN_STD', codes: ['TRS'], strategy: 'RUN_STD', from: '0', steps: ['TRS'],
  });
  actor = await createFinanceActor(tenant.client);
}

beforeAll(async () => { await setup(); }, 180_000);
afterAll(async () => { if (tenant?.client) await destroyTenant(tenant.client); }, 300_000);

function customerInvoiceFor(
  customerNumber: string, currency: string, reference: string, date: string, gross = 100,
) {
  return {
    client: tenant.client, changedBy: ACTOR, customerNumber, companyCode: COMPANY,
    documentDate: date, postingDate: date, reference, currency, grossAmount: gross,
    requestKey: `ci-${reference}`,
    lines: [{ glAccount: '300000', netAmount: gross }],
  };
}

function customerInvoice(currency: string, reference: string, date: string, gross = 100) {
  return customerInvoiceFor('C10000', currency, reference, date, gross);
}

function vendorInvoice(currency: string, reference: string, date: string, vendor = 'V10000', gross = 100) {
  return {
    client: tenant.client, changedBy: ACTOR, vendorNumber: vendor, companyCode: COMPANY,
    documentDate: date, postingDate: date, reference, currency, grossAmount: gross,
    requestKey: `vi-${reference}`,
    lines: [{ glAccount: '400000', netAmount: gross }],
  };
}

function receiveFor(
  customerNumber: string, currency: string, date: string, amount: number,
  items: Array<{
    documentNumber: string; fiscalYear: number; lineNumber: number;
    applied?: number; discount?: number; outcome?: 'RESIDUAL' | 'PARTIAL';
  }>,
  key: string, bankGlAccount = '101000', extra: Record<string, unknown> = {},
) {
  return {
    client: tenant.client, changedBy: ACTOR, customerNumber, companyCode: COMPANY,
    documentDate: date, postingDate: date, clearingDate: date,
    bankGlAccount, amount, currency, requestKey: key, items,
    authorization: actor.authorization, ...extra,
  };
}

function receive(
  currency: string, date: string, amount: number,
  items: Array<{
    documentNumber: string; fiscalYear: number; lineNumber: number;
    applied?: number; discount?: number; outcome?: 'RESIDUAL' | 'PARTIAL';
  }>,
  key: string, bankGlAccount = '101000', extra: Record<string, unknown> = {},
) {
  return receiveFor('C10000', currency, date, amount, items, key, bankGlAccount, extra);
}

function pay(
  vendor: string, currency: string, date: string, amount: number,
  item: { documentNumber: string; fiscalYear: number; lineNumber: number },
  key: string, bankGlAccount: string, extra: Record<string, unknown> = {},
) {
  return {
    client: tenant.client, changedBy: ACTOR, vendorNumber: vendor, companyCode: COMPANY,
    documentDate: date, postingDate: date, clearingDate: date,
    bankGlAccount, amount, currency, requestKey: key, items: [item], ...extra,
  };
}

async function journalCount(): Promise<number> {
  return withTenant(tenant.client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${tenant.client}`);
    return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
  });
}

async function journalLines(documentNumber: string) {
  return withTenant(tenant.client, async (tx) => (await tx.execute(sql`
    select l.gl_account, l.line_number, l.debit_credit, l.amount_document::text as doc,
           l.amount_local::text as local, l.currency, l.is_local_only, l.line_text, h.is_fx_valuation
      from journal_entry_line l
      join journal_entry h on h.client = l.client and h.document_number = l.document_number and h.fiscal_year = l.fiscal_year
     where l.client = ${tenant.client} and l.document_number = ${documentNumber}
     order by l.line_number`)) as unknown as Array<Record<string, string | boolean | null>>);
}

async function openRefs(partner: string, glAccount: string, documentNumbers: string[]) {
  const rows = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
    select l.document_number, l.fiscal_year, l.line_number, l.debit_credit, l.amount_local::text as local
      from journal_entry_line l
      join journal_entry e
        on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
     where l.client = ${tenant.client} and l.business_partner = ${partner}
       and l.gl_account = ${glAccount} and l.clearing_document is null
       and e.status = 'POSTED' and e.reversal_of is null`)) as unknown as Array<{
    document_number: string; fiscal_year: number; line_number: number; debit_credit: string; local: string;
  }>);
  return rows.filter((r) => documentNumbers.includes(r.document_number));
}

async function manualEntry(input: {
  currency: string; date: string; fiscalYear?: number; reference: string;
  lines: Array<{ glAccount: string; debitCredit: 'S' | 'H'; amount: string; amountLocal: string; businessPartner?: string }>;
}) {
  return withTenant(tenant.client, (tx) => postJournalEntry(tx, {
    client: tenant.client, companyCode: COMPANY, documentType: 'SA',
    documentDate: input.date, postingDate: input.date,
    fiscalYear: input.fiscalYear ?? 2026, postingPeriod: Number(input.date.slice(5, 7)),
    currency: input.currency, localCurrency: 'KWD',
    reference: input.reference, postedBy: ACTOR, precision: 'CURRENCY', lines: input.lines,
  }));
}

async function statement(input: {
  houseBankKey: string; accountId: string; currency: string; reference: string;
  fromDate: string; toDate: string; opening: string; closing: string;
  lines?: Array<{ direction: 'IN' | 'OUT'; amount: string; valueDate: string }>;
}) {
  return saveBankStatement({
    client: tenant.client, companyCode: COMPANY, houseBankKey: input.houseBankKey,
    accountId: input.accountId, currency: input.currency, statementReference: input.reference,
    fromDate: input.fromDate, toDate: input.toDate,
    openingBalance: input.opening, closingBalance: input.closing,
    lines: (input.lines ?? []).map((line) => ({
      ...line, transactionDate: line.valueDate, bankReference: input.reference,
    })),
  }, { authorization: actor.authorization });
}

async function reconciliation(input: { houseBankKey: string; accountId: string; statementId: string }) {
  return getBankReconciliation({
    client: tenant.client, companyCode: COMPANY,
    houseBankKey: input.houseBankKey, accountId: input.accountId, statementId: input.statementId,
  }, { authorization: actor.authorization });
}

describe('1. as-of treatment of reversed bank journals', () => {
  let receiptDoc = '';
  let statementId = '';
  let item: { documentNumber: string; fiscalYear: number; lineNumber: number };

  it('counts the receipt before its reversal and nets it to zero after, across fiscal years', async () => {
    const inv = await postCustomerInvoice(customerInvoice('USD', 'ASOF-INV', '2026-12-01', 100));
    const open = (await getReceivables(tenant.client, 'C10000', COMPANY)).openItems
      .find((i) => i.documentNumber === inv.journalDocumentNumber)!;
    item = { documentNumber: open.documentNumber, fiscalYear: open.fiscalYear, lineNumber: open.lineNumber };
    const receipt = await postIncomingPayment(receive('USD', '2026-12-20', 100, [item], 'asof-receipt', '106000'));
    receiptDoc = receipt.journalDocumentNumber;
    const saved = await statement({
      houseBankKey: 'HB05', accountId: 'USD3', currency: 'USD', reference: 'ASOF-2026-12',
      fromDate: '2026-12-01', toDate: '2026-12-31', opening: '0', closing: '100',
      lines: [{ direction: 'IN', amount: '100', valueDate: '2026-12-20' }],
    });
    statementId = saved.statementId;
    const view = await reconciliation({ houseBankKey: 'HB05', accountId: 'USD3', statementId });
    expect(view.bridge!.ledgerClosing).toBe('100.00');
    expect(view.ledgerLines.some((l) => l.documentNumber === receiptDoc)).toBe(true);
    const lineId = view.statement!.lines[0]!.lineId;
    await matchBankStatement({
      client: tenant.client, statementId, requestKey: 'asof-match-1',
      allocations: [{
        statementLineId: lineId, ledgerDocumentNumber: receiptDoc, ledgerFiscalYear: 2026,
        ledgerLineNumber: 1, amount: '100',
      }],
    }, { authorization: actor.authorization });
    await finalizeBankStatement({ client: tenant.client, statementId, confirmed: true }, { authorization: actor.authorization });

    // The reversal posts in fiscal year 2027; the December as-of balance must not change, and a
    // reversal dated after the statement must not invalidate the signed historical match.
    const reversal = await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
      client: tenant.client, documentNumber: receiptDoc, fiscalYear: 2026,
      reversalDate: '2027-01-05', reason: 'as-of reversal test', reversedBy: ACTOR,
    }));
    const december = await reconciliation({ houseBankKey: 'HB05', accountId: 'USD3', statementId });
    expect(december.bridge!.ledgerClosing).toBe('100.00');
    expect(december.issues.some((i) => i.code === 'INVALID_MATCH')).toBe(false);
    expect(december.ledgerLines.find((l) => l.documentNumber === receiptDoc))
      .toMatchObject({ kind: 'BANK', matchable: true, matchedAmount: '100.00' });

    const january = await statement({
      houseBankKey: 'HB05', accountId: 'USD3', currency: 'USD', reference: 'ASOF-2027-01',
      fromDate: '2027-01-01', toDate: '2027-01-31', opening: '100', closing: '0',
      lines: [{ direction: 'OUT', amount: '100', valueDate: '2027-01-05' }],
    });
    const after = await reconciliation({ houseBankKey: 'HB05', accountId: 'USD3', statementId: january.statementId });
    // Opening +100, the dated mirror -100, closing zero. Both identities remain visible.
    expect(after.bridge!.ledgerOpening).toBe('100.00');
    expect(after.bridge!.ledgerClosing).toBe('0.00');
    expect(after.ledgerLines.find((l) => l.documentNumber === receiptDoc))
      .toMatchObject({ kind: 'BANK', amount: '100.00', matchable: false });
    expect(after.ledgerLines.find((l) => l.documentNumber === reversal.documentNumber))
      .toMatchObject({ kind: 'REVERSAL', amount: '100.00', matchable: true });
    // The real refund line and the dated mirror are both outstanding and in the right direction;
    // explicit matching resolves the bridge. Nothing was inferred from the reversal alone.
    expect(after.issues.some((i) => i.code === 'UNEXPLAINED' && i.blocking)).toBe(false);
    expect(after.bridge!.unexplainedDifference).toBe('0.00');
    const matched = await matchBankStatement({
      client: tenant.client, statementId: january.statementId, requestKey: 'asof-jan-match',
      allocations: [{
        statementLineId: after.statement!.lines[0]!.lineId,
        ledgerDocumentNumber: reversal.documentNumber, ledgerFiscalYear: reversal.fiscalYear,
        ledgerLineNumber: 1, amount: '100',
      }],
    }, { authorization: actor.authorization });
    expect(matched.matchIds).toHaveLength(1);
    const completed = await reconciliation({ houseBankKey: 'HB05', accountId: 'USD3', statementId: january.statementId });
    expect(completed.bridge!.unexplainedDifference).toBe('0.00');
    expect(completed.issues.some((i) => i.code === 'INVALID_MATCH')).toBe(false);
    await finalizeBankStatement({
      client: tenant.client, statementId: january.statementId, confirmed: true,
    }, { authorization: actor.authorization });
  });

  it('applies the same as-of rule to a local-currency bank account', async () => {
    const inv = await postCustomerInvoice(customerInvoice('KWD', 'ASOF-KWD', '2026-12-01', 100));
    const open = (await getReceivables(tenant.client, 'C10000', COMPANY)).openItems
      .find((i) => i.documentNumber === inv.journalDocumentNumber)!;
    const receipt = await postIncomingPayment(receive('KWD', '2026-12-20', 100, [open], 'asof-kwd-receipt', '107000'));
    const december = await statement({
      houseBankKey: 'HB06', accountId: 'KWD4', currency: 'KWD', reference: 'ASOF-KWD-DEC',
      fromDate: '2026-12-01', toDate: '2026-12-31', opening: '0', closing: '100',
      lines: [{ direction: 'IN', amount: '100', valueDate: '2026-12-20' }],
    });
    expect((await reconciliation({ houseBankKey: 'HB06', accountId: 'KWD4', statementId: december.statementId }))
      .bridge!.ledgerClosing).toBe('100.000');
    const reversal = await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
      client: tenant.client, documentNumber: receipt.journalDocumentNumber, fiscalYear: 2026,
      reversalDate: '2027-01-05', reason: 'local bank as-of reversal', reversedBy: ACTOR,
    }));
    const january = await statement({
      houseBankKey: 'HB06', accountId: 'KWD4', currency: 'KWD', reference: 'ASOF-KWD-JAN',
      fromDate: '2027-01-01', toDate: '2027-01-31', opening: '100', closing: '0',
      lines: [{ direction: 'OUT', amount: '100', valueDate: '2027-01-05' }],
    });
    const view = await reconciliation({ houseBankKey: 'HB06', accountId: 'KWD4', statementId: january.statementId });
    expect(view.bridge!.ledgerOpening).toBe('100.000');
    expect(view.bridge!.ledgerClosing).toBe('0.000');
    expect(view.ledgerLines.find((l) => l.documentNumber === reversal.documentNumber))
      .toMatchObject({ kind: 'REVERSAL', matchable: true });
    expect(view.issues.some((i) => i.code === 'UNEXPLAINED' && i.blocking)).toBe(false);
    expect(view.bridge!.unexplainedDifference).toBe('0.000');
    await matchBankStatement({
      client: tenant.client, statementId: january.statementId, requestKey: 'asof-kwd-jan-match',
      allocations: [{
        statementLineId: view.statement!.lines[0]!.lineId,
        ledgerDocumentNumber: reversal.documentNumber, ledgerFiscalYear: reversal.fiscalYear,
        ledgerLineNumber: 1, amount: '100',
      }],
    }, { authorization: actor.authorization });
  });

  it('shows a backdated reversal inside a finalized period as a change and an invalid match', async () => {
    const inv = await postCustomerInvoice(customerInvoiceFor('C30000', 'USD', 'BACKDATE-INV', '2026-12-01', 100));
    const item = (await getReceivables(tenant.client, 'C30000', COMPANY)).openItems
      .find((i) => i.documentNumber === inv.journalDocumentNumber)!;
    const receipt = await postIncomingPayment(receiveFor('C30000', 'USD', '2026-12-10', 100, [item], 'backdate-receipt', '119000'));
    const saved = await statement({
      houseBankKey: 'HB17', accountId: 'USD12', currency: 'USD', reference: 'BACKDATE-STMT',
      fromDate: '2026-12-01', toDate: '2026-12-31', opening: '0', closing: '100',
      lines: [{ direction: 'IN', amount: '100', valueDate: '2026-12-10' }],
    });
    const view = await reconciliation({ houseBankKey: 'HB17', accountId: 'USD12', statementId: saved.statementId });
    await matchBankStatement({
      client: tenant.client, statementId: saved.statementId, requestKey: 'backdate-match',
      allocations: [{
        statementLineId: view.statement!.lines[0]!.lineId,
        ledgerDocumentNumber: receipt.journalDocumentNumber, ledgerFiscalYear: 2026,
        ledgerLineNumber: 1, amount: '100',
      }],
    }, { authorization: actor.authorization });
    await finalizeBankStatement({ client: tenant.client, statementId: saved.statementId, confirmed: true }, { authorization: actor.authorization });

    await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
      client: tenant.client, documentNumber: receipt.journalDocumentNumber, fiscalYear: 2026,
      reversalDate: '2026-12-20', reason: 'backdated reversal', reversedBy: ACTOR,
    }));
    const changed = await reconciliation({ houseBankKey: 'HB17', accountId: 'USD12', statementId: saved.statementId });
    expect(changed.changedSinceSnapshot).toBe(true);
    expect(changed.bridge!.ledgerClosing).toBe('0.00');
    expect(changed.issues.some((i) => i.code === 'INVALID_MATCH' && i.blocking)).toBe(true);
    // The mirror is the dated outstanding movement and explains the ledger/bank difference; the
    // blocker is the active match that was invalidated by the backdated reversal.
    expect(changed.issues.some((i) => i.code === 'UNEXPLAINED' && i.blocking)).toBe(false);
  });
});

describe('2. period-end FX valuation on a foreign bank G/L', () => {
  it('shows a proven local-only adjustment, never a bank movement or a currency blocker', async () => {
    // A USD balance on the isolated USD bank G/L.
    await manualEntry({
      currency: 'USD', date: '2026-10-16', reference: 'VALBANK-OPEN',
      lines: [
        { glAccount: '105000', debitCredit: 'S', amount: '100', amountLocal: '30.000' },
        { glAccount: '400000', debitCredit: 'H', amount: '100', amountLocal: '30.000' },
      ],
    });
    const valuation = await executeFxValuation({
      client: tenant.client, changedBy: ACTOR, authorization: actor.authorization,
      selection: {
        companyCode: COMPANY, valuationArea: 'VALBNK', valuationKeyDate: '2026-12-31',
        postingDate: '2026-12-31', fiscalYear: 2026, valuationMethod: 'AVERAGE',
        includeOpenItems: false, includeBalances: true, testRun: false,
        documentType: 'SA', requestKey: 'valbank-1',
      },
    });
    expect(valuation.postingDocument).toBeTruthy();
    const valLines = await journalLines(valuation.postingDocument!);
    expect(valLines.every((l) => l.is_fx_valuation === true)).toBe(true);

    const saved = await statement({
      houseBankKey: 'HB04', accountId: 'USD2', currency: 'USD', reference: 'VALBANK-STMT',
      fromDate: '2026-10-01', toDate: '2026-12-31', opening: '0', closing: '100',
      lines: [{ direction: 'IN', amount: '100', valueDate: '2026-10-16' }],
    });
    const view = await reconciliation({ houseBankKey: 'HB04', accountId: 'USD2', statementId: saved.statementId });
    const valuationLine = view.ledgerLines.find((l) => l.documentNumber === valuation.postingDocument)!;
    expect(valuationLine).toMatchObject({ kind: 'FX_VALUATION', matchable: false, amount: '0.00' });
    expect(Number(valuationLine.localAmount)).toBeGreaterThan(0);
    expect(view.bridge!.ledgerClosing).toBe('100.00');
    expect(view.issues.some((i) => i.code === 'LEDGER_CURRENCY')).toBe(false);
    // It cannot be matched as a bank movement.
    const lineId = view.statement!.lines[0]!.lineId;
    const valuationLineNumber = Number(valLines.find((l) => l.gl_account === '105000')!.line_number);
    await expect(matchBankStatement({
      client: tenant.client, statementId: saved.statementId, requestKey: 'valbank-match',
      allocations: [{
        statementLineId: lineId, ledgerDocumentNumber: valuation.postingDocument!,
        ledgerFiscalYear: 2026, ledgerLineNumber: valuationLineNumber, amount: '1',
      }],
    }, { authorization: actor.authorization })).rejects.toThrow(/FX valuation adjustment/);

    // Reversal: both dated valuation movements stay visible, net to zero in local carrying, and
    // neither creates an account-currency movement or a permanent blocker.
    const reversal = await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
      client: tenant.client, documentNumber: valuation.postingDocument!, fiscalYear: 2026,
      reversalDate: '2026-12-31', reason: 'reverse bank valuation', reversedBy: ACTOR,
    }));
    const reversed = await reconciliation({ houseBankKey: 'HB04', accountId: 'USD2', statementId: saved.statementId });
    const valuationMovements = reversed.ledgerLines.filter((l) => l.kind === 'FX_VALUATION');
    expect(valuationMovements.map((l) => l.documentNumber).sort())
      .toEqual([valuation.postingDocument!, reversal.documentNumber].sort());
    expect(valuationMovements.every((l) => l.matchable === false && l.amount === '0.00')).toBe(true);
    expect(reversed.bridge!.ledgerClosing).toBe('100.00');
    expect(reversed.issues.some((i) => i.code === 'LEDGER_CURRENCY')).toBe(false);
  });
});

describe('3. actual bank-account-currency movements', () => {
  it('posts the stated local bank amount, not the master-rate conversion', async () => {
    const inv = await postCustomerInvoice(customerInvoice('USD', 'ACT-INV', '2026-06-01', 100));
    const item = (await getReceivables(tenant.client, 'C10000', COMPANY)).openItems
      .find((i) => i.documentNumber === inv.journalDocumentNumber)!;
    const receipt = await postIncomingPayment(receive('USD', '2026-10-16', 100, [item], 'act-receipt-1', '103000', {
      bankAmount: '32.500',
    }));
    expect(receipt).toMatchObject({ bankAmount: '32.5000', bankCurrency: 'KWD', bankAmountSource: 'USER_ACTUAL' });
    const lines = await journalLines(receipt.journalDocumentNumber);
    expect(lines.find((l) => l.gl_account === '103000')).toMatchObject({ doc: '100.0000', local: '32.5000' });
    expect(lines.find((l) => l.gl_account === '110000')).toMatchObject({ local: '30.0000' });
    expect(lines.find((l) => l.gl_account === '590100')).toMatchObject({ local: '2.5000', is_local_only: true });

    // The statement and the ledger agree in the account currency (KWD).
    const saved = await statement({
      houseBankKey: 'HB01', accountId: 'KWD1', currency: 'KWD', reference: 'ACT-STMT',
      fromDate: '2026-10-01', toDate: '2026-10-31', opening: '0', closing: '32.500',
      lines: [{ direction: 'IN', amount: '32.500', valueDate: '2026-10-16' }],
    });
    const view = await reconciliation({ houseBankKey: 'HB01', accountId: 'KWD1', statementId: saved.statementId });
    expect(view.ledgerLines.find((l) => l.documentNumber === receipt.journalDocumentNumber))
      .toMatchObject({ amount: '32.500', kind: 'BANK' });
    await matchBankStatement({
      client: tenant.client, statementId: saved.statementId, requestKey: 'act-match-1',
      allocations: [{
        statementLineId: view.statement!.lines[0]!.lineId,
        ledgerDocumentNumber: receipt.journalDocumentNumber, ledgerFiscalYear: 2026,
        ledgerLineNumber: 1, amount: '32.500',
      }],
    }, { authorization: actor.authorization });

    // A replay with a different actual amount is refused rather than silently reused.
    await expect(postIncomingPayment(receive('USD', '2026-10-16', 100, [item], 'act-receipt-1', '103000', {
      bankAmount: '33.000',
    }))).rejects.toThrow(/already used with actual bank amount/);
  });

  it('flags a historical foreign line on a local-currency bank without actual evidence', async () => {
    const legacy = await manualEntry({
      currency: 'USD', date: '2026-10-18', reference: 'ACT-LEGACY',
      lines: [
        { glAccount: '103000', debitCredit: 'S', amount: '10', amountLocal: '3.000' },
        { glAccount: '400000', debitCredit: 'H', amount: '10', amountLocal: '3.000' },
      ],
    });
    const saved = await statement({
      houseBankKey: 'HB01', accountId: 'KWD1', currency: 'KWD', reference: 'ACT-LEGACY-STMT',
      fromDate: '2026-10-01', toDate: '2026-10-31', opening: '0', closing: '35.500',
      lines: [
        { direction: 'IN', amount: '32.500', valueDate: '2026-10-16' },
        { direction: 'IN', amount: '3.000', valueDate: '2026-10-18' },
      ],
    });
    const view = await reconciliation({ houseBankKey: 'HB01', accountId: 'KWD1', statementId: saved.statementId });
    expect(view.issues.some((i) => i.code === 'BANK_EVIDENCE' && i.blocking)).toBe(true);
    expect(view.ledgerLines.find((l) => l.documentNumber === legacy.documentNumber))
      .toMatchObject({ amount: '0.000', matchable: false });
    // The actual receipt on the same account still counts.
    expect(view.ledgerLines.find((l) => l.matchable && l.amount === '32.500')).toBeTruthy();
  });

  it('requires a positive, precision-valid actual amount for a local-currency bank', async () => {
    const inv = await postCustomerInvoice(customerInvoice('USD', 'ACT-MISS', '2026-06-01', 100));
    const item = (await getReceivables(tenant.client, 'C10000', COMPANY)).openItems
      .find((i) => i.documentNumber === inv.journalDocumentNumber)!;
    await expect(postIncomingPayment(receive('USD', '2026-10-16', 100, [item], 'act-miss-1', '103000')))
      .rejects.toThrow(/actual bank amount is required/);
    await expect(postIncomingPayment(receive('USD', '2026-10-16', 100, [item], 'act-bad-1', '103000', {
      bankAmount: '32.5001',
    }))).rejects.toThrow(/more decimal places than KWD/);
    await expect(postIncomingPayment(receive('USD', '2026-10-16', 100, [item], 'act-zero-1', '103000', {
      bankAmount: '0',
    }))).rejects.toThrow(/must stand above zero/);
  });

  it('applies the same actual amount to an outgoing payment', async () => {
    const inv = await postVendorInvoice(vendorInvoice('USD', 'ACT-VI', '2026-06-01'));
    const item = (await getPayables(tenant.client, 'V10000', COMPANY)).openItems
      .find((i) => i.documentNumber === inv.journalDocumentNumber)!;
    const payment = await postOutgoingPayment(pay('V10000', 'USD', '2026-10-16', 100, item, 'act-pay-1', '103000', {
      bankAmount: '32.500',
    }), { authorization: actor.authorization });
    expect(payment).toMatchObject({ bankAmount: '32.5000', bankCurrency: 'KWD', bankAmountSource: 'USER_ACTUAL' });
    const lines = await journalLines(payment.journalDocumentNumber);
    expect(lines.find((l) => l.gl_account === '103000')).toMatchObject({ doc: '100.0000', local: '32.5000' });
    expect(lines.find((l) => l.gl_account === '200000')).toMatchObject({ local: '30.0000' });
    expect(lines.find((l) => l.gl_account === '590200')).toMatchObject({ local: '2.5000', is_local_only: true });
  });

  it('keeps same-currency movement unchanged and refuses a third-currency bank', async () => {
    const kwd = await postCustomerInvoice(customerInvoice('KWD', 'ACT-KWD', '2026-10-16', 100));
    const item = (await getReceivables(tenant.client, 'C10000', COMPANY)).openItems
      .find((i) => i.documentNumber === kwd.journalDocumentNumber)!;
    const receipt = await postIncomingPayment(receive('KWD', '2026-10-16', 100, [item], 'act-kwd-1', '103000'));
    expect(receipt.bankAmountSource).toBe('SAME_CURRENCY');
    expect(receipt.bankAmount).toBe('100.0000');

    const eur = await postCustomerInvoice(customerInvoice('EUR', 'ACT-EUR', '2026-10-16', 100));
    const eurItem = (await getReceivables(tenant.client, 'C10000', COMPANY)).openItems
      .find((i) => i.documentNumber === eur.journalDocumentNumber)!;
    await expect(postIncomingPayment(receive('EUR', '2026-10-16', 100, [eurItem], 'act-eur-1', '102000')))
      .rejects.toThrow(/neither the payment currency \(EUR\) nor the company local currency/);
  });

  it('refuses a payment run with incomplete actual evidence, then posts every group exactly', async () => {
    await postVendorInvoice(vendorInvoice('USD', 'ACT-RUN-V1', '2026-09-01', 'V10000', 100));
    await postVendorInvoice(vendorInvoice('USD', 'ACT-RUN-V2', '2026-09-01', 'V20000', 100));
    await createPaymentRun({
      client: tenant.client, changedBy: ACTOR, runDate: '2026-10-05', runId: 'FXR1',
      postingDate: '2026-10-16', documentCutoffDate: '2026-10-16', nextPaymentDate: '2026-11-16',
      companies: [{ companyCode: COMPANY, payingCompanyCode: COMPANY }], methods: ['T'],
    });
    const proposal = await generateProposal({
      client: tenant.client, changedBy: ACTOR, runDate: '2026-10-05', runId: 'FXR1',
    });
    expect(proposal.proposal.filter((p) => !p.exceptionCode)).toHaveLength(2);
    await releasePaymentRunForProvisioning({
      client: tenant.client, changedBy: 'RUN-APPROVER', runDate: '2026-10-05', runId: 'FXR1', releaseCode: 'TRS',
    });

    await expect(executePaymentRun({
      client: tenant.client, changedBy: ACTOR, runDate: '2026-10-05', runId: 'FXR1',
      houseBankKey: 'HB01', bankAccountId: 'KWD1',
      bankAmounts: [{ companyCode: COMPANY, supplier: 'V10000', currency: 'USD', amount: '32.500' }],
    })).rejects.toThrow(/actual bank amount is required/);
    expect((await getPaymentRun(tenant.client, '2026-10-05', 'FXR1'))!.payments).toEqual([]);
    expect((await getPaymentRun(tenant.client, '2026-10-05', 'FXR1'))!.status).toBe('PROPOSAL');

    const executed = await executePaymentRun({
      client: tenant.client, changedBy: ACTOR, runDate: '2026-10-05', runId: 'FXR1',
      houseBankKey: 'HB01', bankAccountId: 'KWD1',
      bankAmounts: [
        { companyCode: COMPANY, supplier: 'V10000', currency: 'USD', amount: '32.500' },
        { companyCode: COMPANY, supplier: 'V20000', currency: 'USD', amount: '31.500' },
      ],
    });
    expect(executed.status).toBe('EXECUTED');
    expect(executed.payments).toHaveLength(2);
    const bySupplier = new Map(executed.payments.map((p) => [p.accountId, p]));
    expect(bySupplier.get('V10000')).toMatchObject({ bankAmount: '32.5000', bankCurrency: 'KWD', bankAmountSource: 'USER_ACTUAL' });
    expect(bySupplier.get('V20000')).toMatchObject({ bankAmount: '31.5000', bankCurrency: 'KWD', bankAmountSource: 'USER_ACTUAL' });
    for (const [supplier, amount] of [['V10000', '32.5000'], ['V20000', '31.5000']] as const) {
      const lines = await journalLines(bySupplier.get(supplier)!.journalDocumentNumber);
      expect(lines.find((l) => l.gl_account === '103000')).toMatchObject({ local: amount });
    }
  });
});

describe('4. local-currency precision of partial and residual carrying amounts', () => {
  it('splits KWD 30.001 at three decimals and conserves the carrying through residual and partials', async () => {
    const openDoc = await manualEntry({
      currency: 'USD', date: '2026-11-01', reference: 'KWD-30001',
      lines: [
        { glAccount: '110000', debitCredit: 'S', amount: '100', amountLocal: '30.001', businessPartner: 'C10000' },
        { glAccount: '300000', debitCredit: 'H', amount: '100', amountLocal: '30.001' },
      ],
    });
    const item = { documentNumber: openDoc.documentNumber, fiscalYear: openDoc.fiscalYear, lineNumber: 1 };
    // Half of 30.001 is 15.0005; the allocated part must be 15.001 (three decimals), not rejected.
    const first = await postIncomingPayment(receive('USD', '2026-11-05', 50,
      [{ ...item, applied: 50, outcome: 'RESIDUAL' }], 'kwd-split-1', '103000', { bankAmount: '15.550' }));
    const firstLines = await journalLines(first.journalDocumentNumber);
    expect(firstLines.find((l) => l.gl_account === '110000' && l.debit_credit === 'H')).toMatchObject({ local: '30.0010' });
    expect(firstLines.find((l) => l.gl_account === '110000' && l.debit_credit === 'S')).toMatchObject({ local: '15.0000' });
    expect(firstLines.find((l) => l.gl_account === '590100')).toMatchObject({ local: '0.5490', is_local_only: true });

    const residual = (await getReceivables(tenant.client, 'C10000', COMPANY)).openItems
      .find((i) => i.documentNumber === first.journalDocumentNumber && i.signed > 0)!;
    expect(residual.amount).toBe('50.0000');
    const second = await postIncomingPayment(receive('USD', '2026-11-10', 25, [{
      documentNumber: residual.documentNumber, fiscalYear: residual.fiscalYear, lineNumber: residual.lineNumber,
      applied: 25, outcome: 'PARTIAL',
    }], 'kwd-split-2', '103000', { bankAmount: '7.750' }));
    const secondLines = await journalLines(second.journalDocumentNumber);
    // The 50 residual is closed at its 15.000 carrying; the unpaid 25 stands as a new 7.500 residual.
    expect(secondLines.find((l) => l.gl_account === '110000' && l.debit_credit === 'H'))
      .toMatchObject({ local: '15.0000' });
    expect(secondLines.find((l) => l.gl_account === '110000' && l.debit_credit === 'S'))
      .toMatchObject({ local: '7.5000' });
    const remaining = (await getReceivables(tenant.client, 'C10000', COMPANY)).openItems
      .find((i) => i.documentNumber === second.journalDocumentNumber && i.signed > 0)!;
    expect(remaining.amount).toBe('25.0000');
    const third = await postIncomingPayment(receive('USD', '2026-11-15', 25, [remaining], 'kwd-split-3', '103000', {
      bankAmount: '7.750',
    }));
    expect((await journalLines(third.journalDocumentNumber)).find((l) => l.gl_account === '110000'))
      .toMatchObject({ local: '7.5000' });
    expect((await getReceivables(tenant.client, 'C10000', COMPANY)).openItems
      .some((i) => i.documentNumber === third.journalDocumentNumber)).toBe(false);
  }, 60_000);
});

describe('4b. valuation uses the key-date clearing position', () => {
  const valuation = (keyDate: string, area: string, requestKey: string) => executeFxValuation({
    client: tenant.client, changedBy: ACTOR, authorization: actor.authorization,
    selection: {
      companyCode: COMPANY, valuationArea: area, valuationKeyDate: keyDate,
      postingDate: keyDate, fiscalYear: 2026, valuationMethod: 'AVERAGE',
      includeOpenItems: true, includeBalances: false, testRun: false,
      documentType: 'SA', requestKey,
    },
  });

  it('values an invoice before its later clearing and excludes it after', async () => {
    const inv = await postCustomerInvoice(customerInvoiceFor('C10000', 'USD', 'VAL-ASOF-INV', '2026-01-10', 100));
    const item = (await getReceivables(tenant.client, 'C10000', COMPANY)).openItems
      .find((i) => i.documentNumber === inv.journalDocumentNumber)!;
    await postIncomingPayment(receive('USD', '2026-02-10', 100, [item], 'val-asof-receipt', '116000'));

    const jan = await valuation('2026-01-31', 'ASOFCL', 'asofcl-jan');
    expect(jan.items.find((i) => i.sourceDocument === inv.journalDocumentNumber)).toMatchObject({
      currency: 'USD', carryingAmount: 30,
    });
    if (jan.postingDocument) {
      await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
        client: tenant.client, documentNumber: jan.postingDocument!, fiscalYear: 2026,
        reversalDate: '2026-01-31', reason: 'release key-date clearing test', reversedBy: ACTOR,
      }));
    }

    const feb = await valuation('2026-02-28', 'ASOFFB', 'asoffb-feb');
    expect(feb.items.some((i) => i.sourceDocument === inv.journalDocumentNumber)).toBe(false);
    if (feb.postingDocument) {
      await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
        client: tenant.client, documentNumber: feb.postingDocument!, fiscalYear: 2026,
        reversalDate: '2026-02-28', reason: 'release key-date clearing test', reversedBy: ACTOR,
      }));
    }
  }, 90_000);

  it('uses reset history to exclude an item that was cleared as of the key date, even after a later reset', async () => {
    const inv = await postCustomerInvoice(customerInvoiceFor('C10000', 'USD', 'VAL-RESET-INV', '2026-01-10', 100));
    const item = (await getReceivables(tenant.client, 'C10000', COMPANY)).openItems
      .find((i) => i.documentNumber === inv.journalDocumentNumber)!;
    const receipt = await postIncomingPayment(receive('USD', '2026-02-10', 100, [item], 'val-reset-receipt', '116000'));
    await resetClearing({
      client: tenant.client, changedBy: ACTOR, companyCode: COMPANY,
      clearingDocument: receipt.journalDocumentNumber, fiscalYear: 2026,
      reason: 'history test', requestKey: 'val-reset-1',
    });
    const result = await valuation('2026-02-28', 'RESETH', 'reseth-feb');
    // It is open now (the reset lifted the stamp) but was cleared as of 28 February.
    expect(result.items.some((i) => i.sourceDocument === inv.journalDocumentNumber)).toBe(false);
    if (result.postingDocument) {
      await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
        client: tenant.client, documentNumber: result.postingDocument!, fiscalYear: 2026,
        reversalDate: '2026-02-28', reason: 'release reset-history test', reversedBy: ACTOR,
      }));
    }
  }, 90_000);
});

describe('5. active valuation blocks customer and vendor clearing, and locks serialize', () => {
  let customerInvoiceDoc = '';
  let customerCreditDoc = '';
  let customerRefs: Array<{ documentNumber: string; fiscalYear: number; lineNumber: number }> = [];

  it('refuses customer clearing while the valuation stands, then clears after reversal', async () => {
    customerInvoiceDoc = (await postCustomerInvoice(customerInvoice('USD', 'CLR-VAL-INV', '2026-06-01', 100))).journalDocumentNumber!;
    customerCreditDoc = (await manualEntry({
      currency: 'USD', date: '2026-10-16', reference: 'CLR-VAL-CM',
      lines: [
        { glAccount: '110000', debitCredit: 'H', amount: '100', amountLocal: '31.000', businessPartner: 'C10000' },
        { glAccount: '300000', debitCredit: 'S', amount: '100', amountLocal: '31.000' },
      ],
    })).documentNumber;
    customerRefs = (await openRefs('C10000', '110000', [customerInvoiceDoc, customerCreditDoc]))
      .map((r) => ({ documentNumber: r.document_number, fiscalYear: r.fiscal_year, lineNumber: r.line_number }));
    expect(customerRefs).toHaveLength(2);

    const valuation = await executeFxValuation({
      client: tenant.client, changedBy: ACTOR, authorization: actor.authorization,
      selection: {
        companyCode: COMPANY, valuationArea: 'CLRVAL', valuationKeyDate: '2026-12-31',
        postingDate: '2026-12-31', fiscalYear: 2026, valuationMethod: 'AVERAGE',
        includeOpenItems: true, includeBalances: false, testRun: false,
        documentType: 'SA', requestKey: 'clrval-1',
      },
    });
    expect(valuation.postingDocument).toBeTruthy();

    const before = await withTenant(tenant.client, async (tx) => ((await tx.execute(sql`
      select count(*)::int as n from journal_entry where client = ${tenant.client}`)) as unknown as Array<{ n: number }>)[0]!.n);
    await expect(clearCustomerItems({
      client: tenant.client, changedBy: ACTOR, customer: 'C10000', companyCode: COMPANY,
      clearingDate: '2027-01-10', postingDate: '2027-01-10', documentDate: '2027-01-10',
      confirmed: true, requestKey: 'clrval-refuse', items: customerRefs,
    })).rejects.toThrow(/valued at period end/);
    const after = await withTenant(tenant.client, async (tx) => ((await tx.execute(sql`
      select count(*)::int as n from journal_entry where client = ${tenant.client}`)) as unknown as Array<{ n: number }>)[0]!.n);
    expect(after).toBe(before);
    const stillOpen = await openRefs('C10000', '110000', [customerInvoiceDoc, customerCreditDoc]);
    expect(stillOpen).toHaveLength(2);

    await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
      client: tenant.client, documentNumber: valuation.postingDocument!, fiscalYear: 2026,
      reversalDate: '2027-01-05', reason: 'release clearing valuation', reversedBy: ACTOR,
    }));
    const clearing = await clearCustomerItems({
      client: tenant.client, changedBy: ACTOR, customer: 'C10000', companyCode: COMPANY,
      clearingDate: '2027-01-10', postingDate: '2027-01-10', documentDate: '2027-01-10',
      confirmed: true, requestKey: 'clrval-ok', items: customerRefs,
    });
    expect((await journalLines(clearing.clearingDocumentNumber)).find((l) => l.gl_account === '590100'))
      .toMatchObject({ debit_credit: 'H', local: '1.0000', is_local_only: true });
  }, 90_000);

  it('refuses vendor clearing while the valuation stands, then clears after reversal', async () => {
    const inv = await postVendorInvoice(vendorInvoice('USD', 'CLR-VAL-VI', '2026-06-01'));
    const debit = await manualEntry({
      currency: 'USD', date: '2026-10-16', reference: 'CLR-VAL-VD',
      lines: [
        { glAccount: '200000', debitCredit: 'S', amount: '100', amountLocal: '31.000', businessPartner: 'V10000' },
        { glAccount: '400000', debitCredit: 'H', amount: '100', amountLocal: '31.000' },
      ],
    });
    const refs = (await openRefs('V10000', '200000', [inv.journalDocumentNumber!, debit.documentNumber]))
      .map((r) => ({ documentNumber: r.document_number, fiscalYear: r.fiscal_year, lineNumber: r.line_number }));
    expect(refs).toHaveLength(2);
    // The customer valuation's reversal is effective 2027-01-05, so this later run can value the
    // same basis without double counting.
    const valuation = await executeFxValuation({
      client: tenant.client, changedBy: ACTOR, authorization: actor.authorization,
      selection: {
        companyCode: COMPANY, valuationArea: 'CLRVL2', valuationKeyDate: '2027-01-08',
        postingDate: '2027-01-08', fiscalYear: 2027, valuationMethod: 'AVERAGE',
        includeOpenItems: true, includeBalances: false, testRun: false,
        documentType: 'SA', requestKey: 'clrval-2',
      },
    });
    expect(valuation.postingDocument).toBeTruthy();
    await expect(clearVendorItems({
      client: tenant.client, changedBy: ACTOR, supplier: 'V10000', companyCode: COMPANY,
      clearingDate: '2027-01-10', postingDate: '2027-01-10', documentDate: '2027-01-10',
      items: refs,
    })).rejects.toThrow(/valued at period end/);
    expect(await openRefs('V10000', '200000', [inv.journalDocumentNumber!, debit.documentNumber])).toHaveLength(2);
    await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
      client: tenant.client, documentNumber: valuation.postingDocument!, fiscalYear: 2027,
      reversalDate: '2027-01-09', reason: 'release vendor clearing valuation', reversedBy: ACTOR,
    }));
    const clearing = await clearVendorItems({
      client: tenant.client, changedBy: ACTOR, supplier: 'V10000', companyCode: COMPANY,
      clearingDate: '2027-01-10', postingDate: '2027-01-10', documentDate: '2027-01-10',
      items: refs,
    });
    expect((await journalLines(clearing.clearingDocumentNumber)).find((l) => l.gl_account === '590200'))
      .toMatchObject({ local: '1.0000', is_local_only: true });
  }, 90_000);

  it('refuses clearing over an account/currency balance valuation', async () => {
    const debit = await manualEntry({
      currency: 'USD', date: '2026-10-16', reference: 'BALCLR-D',
      lines: [
        { glAccount: '108000', debitCredit: 'S', amount: '100', amountLocal: '30.000', businessPartner: 'C20000' },
        { glAccount: '300000', debitCredit: 'H', amount: '100', amountLocal: '30.000' },
      ],
    });
    const credit = await manualEntry({
      currency: 'USD', date: '2026-10-16', reference: 'BALCLR-C',
      lines: [
        { glAccount: '108000', debitCredit: 'H', amount: '100', amountLocal: '31.000', businessPartner: 'C20000' },
        { glAccount: '300000', debitCredit: 'S', amount: '100', amountLocal: '31.000' },
      ],
    });
    const refs = (await openRefs('C20000', '108000', [debit.documentNumber, credit.documentNumber]))
      .map((r) => ({ documentNumber: r.document_number, fiscalYear: r.fiscal_year, lineNumber: r.line_number }));
    expect(refs).toHaveLength(2);

    const valuation = await executeFxValuation({
      client: tenant.client, changedBy: ACTOR, authorization: actor.authorization,
      selection: {
        companyCode: COMPANY, valuationArea: 'BALCLR', valuationKeyDate: '2026-12-31',
        postingDate: '2026-12-31', fiscalYear: 2026, valuationMethod: 'AVERAGE',
        includeOpenItems: false, includeBalances: true, testRun: false,
        documentType: 'SA', requestKey: 'balclr-1',
      },
    });
    expect(valuation.postingDocument).toBeTruthy();
    expect((await journalLines(valuation.postingDocument!)).some((l) => l.gl_account === '108000')).toBe(true);

    const before = await withTenant(tenant.client, async (tx) => ((await tx.execute(sql`
      select count(*)::int as n from journal_entry where client = ${tenant.client}`)) as unknown as Array<{ n: number }>)[0]!.n);
    await expect(clearCustomerItems({
      client: tenant.client, changedBy: ACTOR, customer: 'C20000', companyCode: COMPANY,
      clearingDate: '2027-01-10', postingDate: '2027-01-10', documentDate: '2027-01-10',
      confirmed: true, requestKey: 'balclr-refuse', items: refs,
    })).rejects.toThrow(/valued at period end/);
    const after = await withTenant(tenant.client, async (tx) => ((await tx.execute(sql`
      select count(*)::int as n from journal_entry where client = ${tenant.client}`)) as unknown as Array<{ n: number }>)[0]!.n);
    expect(after).toBe(before);
    expect(await openRefs('C20000', '108000', [debit.documentNumber, credit.documentNumber])).toHaveLength(2);

    await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
      client: tenant.client, documentNumber: valuation.postingDocument!, fiscalYear: 2026,
      reversalDate: '2026-12-31', reason: 'release balance valuation clearing', reversedBy: ACTOR,
    }));
    const clearing = await clearCustomerItems({
      client: tenant.client, changedBy: ACTOR, customer: 'C20000', companyCode: COMPANY,
      clearingDate: '2027-01-10', postingDate: '2027-01-10', documentDate: '2027-01-10',
      confirmed: true, requestKey: 'balclr-ok', items: refs,
    });
    expect((await journalLines(clearing.clearingDocumentNumber)).find((l) => l.gl_account === '590100'))
      .toMatchObject({ debit_credit: 'H', local: '1.0000', is_local_only: true });
  }, 90_000);

  it('serializes settlement with the company valuation lock', async () => {
    const inv = await postCustomerInvoice(customerInvoice('USD', 'LOCK-INV', '2026-11-01', 100));
    const item = (await getReceivables(tenant.client, 'C10000', COMPANY)).openItems
      .find((i) => i.documentNumber === inv.journalDocumentNumber)!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let acquired!: () => void;
    const gotLock = new Promise<void>((resolve) => { acquired = resolve; });
    const holder = withTenant(tenant.client, async (tx) => {
      await lockValuationSettlement(tx, tenant.client, COMPANY);
      acquired();
      await held;
    });
    await gotLock;
    const payment = postIncomingPayment(receive('USD', '2026-11-05', 100, [item], 'lock-pay-1', '103000', {
      bankAmount: '31.000',
    }));
    const outcome = await Promise.race([
      payment.then(() => 'done', () => 'failed'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 400)),
    ]);
    expect(outcome).toBe('blocked');
    release();
    await holder;
    const posted = await payment;
    expect(posted.journalDocumentNumber).toBeTruthy();
  }, 60_000);
});

describe('6. configured document precision in clearing', () => {
  it('clears KWD 1.234 and 1.235 exactly, not at two decimals', async () => {
    const a = await manualEntry({
      currency: 'KWD', date: '2026-11-01', reference: 'KWD-CLR-A',
      lines: [
        { glAccount: '110000', debitCredit: 'S', amount: '1.234', amountLocal: '1.234', businessPartner: 'C10000' },
        { glAccount: '300000', debitCredit: 'H', amount: '1.234', amountLocal: '1.234' },
      ],
    });
    const b = await manualEntry({
      currency: 'KWD', date: '2026-11-01', reference: 'KWD-CLR-B',
      lines: [
        { glAccount: '110000', debitCredit: 'S', amount: '1.235', amountLocal: '1.235', businessPartner: 'C10000' },
        { glAccount: '300000', debitCredit: 'H', amount: '1.235', amountLocal: '1.235' },
      ],
    });
    const c = await manualEntry({
      currency: 'KWD', date: '2026-11-01', reference: 'KWD-CLR-C',
      lines: [
        { glAccount: '110000', debitCredit: 'H', amount: '2.469', amountLocal: '2.469', businessPartner: 'C10000' },
        { glAccount: '300000', debitCredit: 'S', amount: '2.469', amountLocal: '2.469' },
      ],
    });
    const refs = (await openRefs('C10000', '110000', [a.documentNumber, b.documentNumber, c.documentNumber]))
      .map((r) => ({ documentNumber: r.document_number, fiscalYear: r.fiscal_year, lineNumber: r.line_number }));
    expect(refs).toHaveLength(3);
    const clearing = await clearCustomerItems({
      client: tenant.client, changedBy: ACTOR, customer: 'C10000', companyCode: COMPANY,
      clearingDate: '2026-11-10', postingDate: '2026-11-10', documentDate: '2026-11-10',
      confirmed: true, requestKey: 'kwd-clr-1', items: refs,
    });
    const lines = await journalLines(clearing.clearingDocumentNumber);
    const ar = lines.filter((l) => l.gl_account === '110000').map((l) => l.doc).sort();
    expect(ar).toEqual(['1.2340', '1.2350', '2.4690']);
    expect(lines.some((l) => l.gl_account === '590100' || l.gl_account === '590200')).toBe(false);

    await resetClearing({
      client: tenant.client, changedBy: ACTOR, companyCode: COMPANY,
      clearingDocument: clearing.clearingDocumentNumber, fiscalYear: 2026,
      reason: 'KWD precision reset', requestKey: 'kwd-clr-reset',
    });
    expect(await openRefs('C10000', '110000', [a.documentNumber, b.documentNumber, c.documentNumber]))
      .toHaveLength(3);
  }, 60_000);
});

describe('7. legacy evidence remains blocking', () => {
  it('flags an ordinary local-currency line on a foreign bank G/L', async () => {
    await manualEntry({
      currency: 'KWD', date: '2026-12-28', reference: 'VALBANK-LEGACY',
      lines: [
        { glAccount: '105000', debitCredit: 'S', amount: '5.000', amountLocal: '5.000' },
        { glAccount: '400000', debitCredit: 'H', amount: '5.000', amountLocal: '5.000' },
      ],
    });
    const saved = await statement({
      houseBankKey: 'HB04', accountId: 'USD2', currency: 'USD', reference: 'VALBANK-LEGACY-STMT',
      fromDate: '2026-10-01', toDate: '2026-12-31', opening: '0', closing: '100',
      lines: [{ direction: 'IN', amount: '100', valueDate: '2026-10-16' }],
    });
    const legacy = await reconciliation({ houseBankKey: 'HB04', accountId: 'USD2', statementId: saved.statementId });
    expect(legacy.issues.some((i) => i.code === 'LEDGER_CURRENCY' && i.blocking)).toBe(true);
  });
});

describe('8. valuation exposure, repeated runs and precision', () => {
  const valuation = (
    area: string, keyDate: string, overrides: Partial<FxValuationSelection> = {},
  ) => executeFxValuation({
    client: tenant.client, changedBy: ACTOR, authorization: actor.authorization,
    selection: {
      companyCode: COMPANY, valuationArea: area, valuationKeyDate: keyDate,
      postingDate: keyDate, fiscalYear: 2026, valuationMethod: 'AVERAGE',
      includeOpenItems: false, includeBalances: true, testRun: false,
      documentType: 'SA', requestKey: `${area}-${keyDate}`, ...overrides,
    },
  });

  it('does not revalue a local-currency bank because its payment document is foreign', async () => {
    // A USD document line on the KWD bank must not create USD exposure; a genuine USD bank beside
    // it must still be valued.
    await manualEntry({
      currency: 'USD', date: '2026-10-16', reference: 'EXPO-LOCAL-BANK',
      lines: [
        { glAccount: '103000', debitCredit: 'S', amount: '10', amountLocal: '3.000' },
        { glAccount: '400000', debitCredit: 'H', amount: '10', amountLocal: '3.000' },
      ],
    });
    await manualEntry({
      currency: 'USD', date: '2026-10-16', reference: 'EXPO-USD-BANK',
      lines: [
        { glAccount: '115000', debitCredit: 'S', amount: '100', amountLocal: '30.000' },
        { glAccount: '400000', debitCredit: 'H', amount: '100', amountLocal: '30.000' },
      ],
    });
    const result = await valuation('EXPO', '2026-10-31');
    expect(result.items.some((i) => i.accountNumber === '103000')).toBe(false);
    const usdBank = result.items.find((i) => i.accountNumber === '115000')!;
    expect(usdBank).toMatchObject({ sourceKind: 'BALANCE', currency: 'USD', adjustmentAmount: 2 });
    const lines = await journalLines(result.postingDocument!);
    expect(lines.some((l) => l.gl_account === '103000')).toBe(false);
    expect(lines.some((l) => l.gl_account === '115000')).toBe(true);
    await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
      client: tenant.client, documentNumber: result.postingDocument!, fiscalYear: 2026,
      reversalDate: '2026-10-31', reason: 'release exposure test', reversedBy: ACTOR,
    }));
  }, 60_000);

  it('values a December bank receipt after its January reversal from the key-date position', async () => {
    const entry = await manualEntry({
      currency: 'USD', date: '2026-12-20', reference: 'ASOFREV-BANK',
      lines: [
        { glAccount: '120000', debitCredit: 'S', amount: '100', amountLocal: '31.000' },
        { glAccount: '400000', debitCredit: 'H', amount: '100', amountLocal: '31.000' },
      ],
    });
    await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
      client: tenant.client, documentNumber: entry.documentNumber, fiscalYear: 2026,
      reversalDate: '2027-01-05', reason: 'as-of reversal before valuation', reversedBy: ACTOR,
    }));
    const result = await valuation('ASOFRE', '2026-12-20');
    expect(result.items.find((i) => i.accountNumber === '120000')).toMatchObject({
      currency: 'USD', foreignAmount: 100, carryingAmount: 31,
      requiredAmount: 32, adjustmentAmount: 1,
    });
    await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
      client: tenant.client, documentNumber: result.postingDocument!, fiscalYear: 2026,
      reversalDate: '2026-12-20', reason: 'release as-of bank valuation', reversedBy: ACTOR,
    }));
  }, 90_000);

  it('refuses a second live valuation before the earlier one is effective-reversed, then values incrementally', async () => {
    await manualEntry({
      currency: 'USD', date: '2026-10-16', reference: 'REPEAT-BANK',
      lines: [
        { glAccount: '109000', debitCredit: 'S', amount: '100', amountLocal: '30.000' },
        { glAccount: '400000', debitCredit: 'H', amount: '100', amountLocal: '30.000' },
      ],
    });
    const first = await valuation('REPEAT', '2026-10-31');
    expect(first.items.find((i) => i.accountNumber === '109000')).toMatchObject({ adjustmentAmount: 2 });
    const before = await journalCount();
    await expect(valuation('REPEAT', '2026-11-30')).rejects.toThrow(/overlaps valuation run/);
    // A different area cannot bypass the conflict on the same accounting basis.
    await expect(valuation('OTHER', '2026-11-05')).rejects.toThrow(/overlaps valuation run/);
    expect(await journalCount()).toBe(before);

    await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
      client: tenant.client, documentNumber: first.postingDocument!, fiscalYear: 2026,
      reversalDate: '2026-10-31', reason: 'release repeat valuation', reversedBy: ACTOR,
    }));
    // The carrying stands back at 30; a later valuation to 33 posts 3, not an incremental double.
    const second = await valuation('REPEAT', '2026-12-02');
    expect(second.items.find((i) => i.accountNumber === '109000')).toMatchObject({
      carryingAmount: 30, requiredAmount: 33, adjustmentAmount: 3,
    });
    expect((await journalLines(second.postingDocument!)).find((l) => l.gl_account === '109000'))
      .toMatchObject({ local: '3.0000' });
    // A backdated run cannot slip underneath the still-effective later valuation.
    await expect(valuation('BKDATE', '2026-10-31')).rejects.toThrow(/overlaps valuation run/);
    await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
      client: tenant.client, documentNumber: second.postingDocument!, fiscalYear: 2026,
      reversalDate: '2026-12-03', reason: 'release second valuation', reversedBy: ACTOR,
    }));
  }, 60_000);

  it('posts the valuation adjustment at KWD minor units (30.003 carrying, USD 100.01 at 0.32)', async () => {
    await manualEntry({
      currency: 'USD', date: '2026-10-16', reference: 'ROUND-BANK',
      lines: [
        { glAccount: '111000', debitCredit: 'S', amount: '100.01', amountLocal: '30.003' },
        { glAccount: '400000', debitCredit: 'H', amount: '100.01', amountLocal: '30.003' },
      ],
    });
    const result = await valuation('ROUND', '2026-12-04');
    expect(result.items.find((i) => i.accountNumber === '111000')).toMatchObject({
      foreignAmount: 100.01, carryingAmount: 30.003,
      requiredAmount: 32.003, adjustmentAmount: 2, classification: 'GAIN',
    });
    expect((await journalLines(result.postingDocument!)).find((l) => l.gl_account === '111000'))
      .toMatchObject({ local: '2.0000' });
    await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
      client: tenant.client, documentNumber: result.postingDocument!, fiscalYear: 2026,
      reversalDate: '2026-12-04', reason: 'release rounding valuation', reversedBy: ACTOR,
    }));
  }, 60_000);

  it('handles a negative balance and a value that rounds to zero', async () => {
    await manualEntry({
      currency: 'USD', date: '2026-10-16', reference: 'NEG-BANK',
      lines: [
        { glAccount: '113000', debitCredit: 'H', amount: '100.01', amountLocal: '30.003' },
        { glAccount: '400000', debitCredit: 'S', amount: '100.01', amountLocal: '30.003' },
      ],
    });
    await manualEntry({
      currency: 'USD', date: '2026-10-16', reference: 'ZERO-BANK',
      lines: [
        { glAccount: '114000', debitCredit: 'S', amount: '0.01', amountLocal: '0.003' },
        { glAccount: '400000', debitCredit: 'H', amount: '0.01', amountLocal: '0.003' },
      ],
    });
    const result = await valuation('SIGNS', '2026-12-04');
    expect(result.items.find((i) => i.accountNumber === '113000')).toMatchObject({
      adjustmentAmount: -2, classification: 'LOSS',
    });
    expect(result.items.find((i) => i.accountNumber === '114000')).toMatchObject({
      requiredAmount: 0.003, adjustmentAmount: 0, classification: 'NONE',
    });
    const lines = await journalLines(result.postingDocument!);
    expect(lines.find((l) => l.gl_account === '113000')).toMatchObject({ debit_credit: 'H', local: '2.0000' });
    expect(lines.some((l) => l.gl_account === '114000')).toBe(false);
    await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
      client: tenant.client, documentNumber: result.postingDocument!, fiscalYear: 2026,
      reversalDate: '2026-12-04', reason: 'release sign valuation', reversedBy: ACTOR,
    }));
  }, 60_000);

  it('refuses a shared bank G/L and a third-currency line on a foreign bank G/L', async () => {
    await manualEntry({
      currency: 'USD', date: '2026-10-16', reference: 'SHARED-BANK',
      lines: [
        { glAccount: '112000', debitCredit: 'S', amount: '100', amountLocal: '30.000' },
        { glAccount: '400000', debitCredit: 'H', amount: '100', amountLocal: '30.000' },
      ],
    });
    await expect(valuation('SHARED', '2026-12-04')).rejects.toThrow(/shared by 2 bank accounts/);

    await manualEntry({
      currency: 'KWD', date: '2026-10-16', reference: 'THIRD-BANK',
      lines: [
        { glAccount: '109000', debitCredit: 'S', amount: '5.000', amountLocal: '5.000' },
        { glAccount: '400000', debitCredit: 'H', amount: '5.000', amountLocal: '5.000' },
      ],
    });
    await expect(valuation('THIRD', '2026-12-04')).rejects.toThrow(/held in USD, but line .* KWD/);
  }, 60_000);
});

describe('9. clearing reset and reversal safety', () => {
  it('refuses an FX payment reset behind an active bank match, then permits it after unmatch', async () => {
    const inv = await postCustomerInvoice(customerInvoiceFor('C30000', 'USD', 'RESET-MATCH-INV', '2026-06-01', 100));
    const item = (await getReceivables(tenant.client, 'C30000', COMPANY)).openItems
      .find((i) => i.documentNumber === inv.journalDocumentNumber)!;
    const receipt = await postIncomingPayment(receiveFor('C30000', 'USD', '2026-10-16', 100, [item], 'reset-match-receipt', '116000'));
    const saved = await statement({
      houseBankKey: 'HB14', accountId: 'USD11', currency: 'USD', reference: 'RESET-MATCH-STMT',
      fromDate: '2026-10-01', toDate: '2026-10-31', opening: '0', closing: '100',
      lines: [{ direction: 'IN', amount: '100', valueDate: '2026-10-16' }],
    });
    const view = await reconciliation({ houseBankKey: 'HB14', accountId: 'USD11', statementId: saved.statementId });
    const matched = await matchBankStatement({
      client: tenant.client, statementId: saved.statementId, requestKey: 'reset-match-link',
      allocations: [{
        statementLineId: view.statement!.lines[0]!.lineId,
        ledgerDocumentNumber: receipt.journalDocumentNumber, ledgerFiscalYear: 2026,
        ledgerLineNumber: 1, amount: '100',
      }],
    }, { authorization: actor.authorization });

    await expect(resetClearing({
      client: tenant.client, changedBy: ACTOR, companyCode: COMPANY,
      clearingDocument: receipt.journalDocumentNumber, fiscalYear: 2026,
      reason: 'should be blocked by the bank match', requestKey: 'reset-match-1',
    })).rejects.toThrow(/bank reconciliation match/);
    const noReset = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select count(*)::int as n from clearing_reset
       where client = ${tenant.client} and clearing_document = ${receipt.journalDocumentNumber}`)) as unknown as Array<{ n: number }>);
    expect(noReset[0]!.n).toBe(0);
    const stillPosted = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select status from journal_entry where client = ${tenant.client}
        and document_number = ${receipt.journalDocumentNumber} and fiscal_year = 2026`)) as unknown as Array<{ status: string }>);
    expect(stillPosted[0]!.status).toBe('POSTED');
    expect(await openRefs('C30000', '110000', [inv.journalDocumentNumber!])).toHaveLength(0);

    await unmatchBankStatement({
      client: tenant.client, matchId: matched.matchIds[0]!, reason: 'reviewed before reset',
    }, { authorization: actor.authorization });
    await resetClearing({
      client: tenant.client, changedBy: ACTOR, companyCode: COMPANY,
      clearingDocument: receipt.journalDocumentNumber, fiscalYear: 2026,
      reason: 'unmatched and authorised reset', requestKey: 'reset-match-2',
    });
    const reversed = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select status from journal_entry where client = ${tenant.client}
        and document_number = ${receipt.journalDocumentNumber} and fiscal_year = 2026`)) as unknown as Array<{ status: string }>);
    expect(reversed[0]!.status).toBe('REVERSED');
    expect(await openRefs('C30000', '110000', [inv.journalDocumentNumber!])).toHaveLength(1);
    // Neither the payment's self-stamped line nor its mirror becomes a second open item.
    expect(await openRefs('C30000', '110000', [receipt.journalDocumentNumber])).toHaveLength(0);
    const reversalDoc = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select document_number from journal_entry where client = ${tenant.client}
        and reversal_of = ${receipt.journalDocumentNumber}`)) as unknown as Array<{ document_number: string }>);
    const reversalLines = await journalLines(reversalDoc[0]!.document_number);
    expect(reversalLines.find((l) => l.gl_account === '116000'))
      .toMatchObject({ debit_credit: 'H', local: '31.0000' });
  }, 90_000);

  it('reopens a downstream-settled payment residual without duplicating mirrored items or bank movement', async () => {
    const inv = await postCustomerInvoice(customerInvoiceFor('C30000', 'USD', 'RESET-RES-INV', '2026-06-02', 100));
    const item = (await getReceivables(tenant.client, 'C30000', COMPANY)).openItems
      .find((i) => i.documentNumber === inv.journalDocumentNumber)!;
    const receipt = await postIncomingPayment(receiveFor('C30000', 'USD', '2026-10-16', 60, [{
      ...item, applied: 60, outcome: 'RESIDUAL',
    }], 'reset-residual-receipt', '103000', { bankAmount: '18.600' }));
    const residual = (await getReceivables(tenant.client, 'C30000', COMPANY)).openItems
      .find((i) => i.documentNumber === receipt.journalDocumentNumber && i.signed > 0)!;
    expect(residual.amount).toBe('40.0000');
    const credit = await manualEntry({
      currency: 'USD', date: '2026-10-20', reference: 'RESET-RES-CREDIT',
      lines: [
        { glAccount: '110000', debitCredit: 'H', amount: '40', amountLocal: '12.800', businessPartner: 'C30000' },
        { glAccount: '300000', debitCredit: 'S', amount: '40', amountLocal: '12.800' },
      ],
    });
    const residualRef = { documentNumber: residual.documentNumber, fiscalYear: residual.fiscalYear, lineNumber: residual.lineNumber };
    const creditRef = { documentNumber: credit.documentNumber, fiscalYear: credit.fiscalYear, lineNumber: 1 };
    const clearing = await clearCustomerItems({
      client: tenant.client, changedBy: ACTOR, customer: 'C30000', companyCode: COMPANY,
      clearingDate: '2026-10-25', postingDate: '2026-10-25', documentDate: '2026-10-25',
      confirmed: true, requestKey: 'reset-residual-clear', items: [residualRef, creditRef],
    });
    expect((await journalLines(clearing.clearingDocumentNumber)).find((l) => l.gl_account === '590100'))
      .toMatchObject({ debit_credit: 'H', local: '0.8000', is_local_only: true });

    await resetClearing({
      client: tenant.client, changedBy: ACTOR, companyCode: COMPANY,
      clearingDocument: clearing.clearingDocumentNumber, fiscalYear: 2026,
      reason: 'downstream residual reset', requestKey: 'reset-residual-reset',
    });
    const reopened = await openRefs('C30000', '110000', [residual.documentNumber, credit.documentNumber]);
    expect(reopened).toHaveLength(2);
    expect(reopened.find((r) => r.document_number === residual.documentNumber)).toMatchObject({ local: '12.0000' });
    expect(reopened.find((r) => r.document_number === credit.documentNumber)).toMatchObject({ local: '12.8000' });
    // The clearing journal's self-stamp and its mirror are not additional open items.
    expect(await openRefs('C30000', '110000', [clearing.clearingDocumentNumber])).toHaveLength(0);

    // The payment and its genuine bank movement stay posted.
    const receiptHeader = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select status from journal_entry where client = ${tenant.client}
        and document_number = ${receipt.journalDocumentNumber} and fiscal_year = 2026`)) as unknown as Array<{ status: string }>);
    expect(receiptHeader[0]!.status).toBe('POSTED');
    const receiptLines = await journalLines(receipt.journalDocumentNumber);
    expect(receiptLines.find((l) => l.gl_account === '103000')).toMatchObject({ local: '18.6000' });
    expect(receiptLines.find((l) => l.gl_account === '590100')).toMatchObject({ local: '0.6000', is_local_only: true });
  }, 90_000);

  it('serializes a reset with the journal-scoped bank-match lock', async () => {
    const inv = await postCustomerInvoice(customerInvoiceFor('C30000', 'USD', 'RESET-LOCK-INV', '2026-06-03', 100));
    const item = (await getReceivables(tenant.client, 'C30000', COMPANY)).openItems
      .find((i) => i.documentNumber === inv.journalDocumentNumber)!;
    const receipt = await postIncomingPayment(receiveFor('C30000', 'USD', '2026-10-16', 100, [item], 'reset-lock-receipt', '116000'));

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let acquired!: () => void;
    const gotLock = new Promise<void>((resolve) => { acquired = resolve; });
    const holder = withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${tenant.client}/bankline/${receipt.journalDocumentNumber}/2026`}, 0))`);
      acquired();
      await held;
    });
    await gotLock;
    const reset = resetClearing({
      client: tenant.client, changedBy: ACTOR, companyCode: COMPANY,
      clearingDocument: receipt.journalDocumentNumber, fiscalYear: 2026,
      reason: 'concurrent reset', requestKey: 'reset-lock-1',
    });
    const outcome = await Promise.race([
      reset.then(() => 'done', () => 'failed'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 400)),
    ]);
    expect(outcome).toBe('blocked');
    release();
    await holder;
    const result = await reset;
    expect(result.clearingDocument).toBe(receipt.journalDocumentNumber);
    const status = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select status from journal_entry where client = ${tenant.client}
        and document_number = ${receipt.journalDocumentNumber} and fiscal_year = 2026`)) as unknown as Array<{ status: string }>);
    expect(status[0]!.status).toBe('REVERSED');
  }, 60_000);

  it('reopens a full customer payment source and its own offset without reversing the payment', async () => {
    const inv = await postCustomerInvoice(customerInvoiceFor('C30000', 'USD', 'RESET-NOFX-INV', '2026-10-16', 100));
    const item = (await getReceivables(tenant.client, 'C30000', COMPANY)).openItems
      .find((i) => i.documentNumber === inv.journalDocumentNumber)!;
    const receipt = await postIncomingPayment(receiveFor('C30000', 'USD', '2026-10-16', 100, [item], 'reset-nofx-receipt', '116000'));
    const reset = await resetClearing({
      client: tenant.client, changedBy: ACTOR, companyCode: COMPANY,
      clearingDocument: receipt.journalDocumentNumber, fiscalYear: 2026,
      reason: 'full payment without FX', requestKey: 'reset-nofx-1',
    });
    expect(reset.itemsReset).toBe(1);
    const status = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select status from journal_entry where client = ${tenant.client}
        and document_number = ${receipt.journalDocumentNumber} and fiscal_year = 2026`)) as unknown as Array<{ status: string }>);
    expect(status[0]!.status).toBe('POSTED');
    expect(await openRefs('C30000', '110000', [inv.journalDocumentNumber!])).toHaveLength(1);
    const offset = await openRefs('C30000', '110000', [receipt.journalDocumentNumber]);
    expect(offset).toHaveLength(1);
    expect(offset[0]).toMatchObject({ debit_credit: 'H' });
    expect((await journalLines(receipt.journalDocumentNumber)).find((l) => l.gl_account === '116000'))
      .toMatchObject({ local: '31.0000' });
    const reversalCount = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select count(*)::int as n from journal_entry where client = ${tenant.client}
        and reversal_of = ${receipt.journalDocumentNumber}`)) as unknown as Array<{ n: number }>);
    expect(reversalCount[0]!.n).toBe(0);
  }, 90_000);

  it('reopens a full vendor payment source and its own offset without reversing the payment', async () => {
    const inv = await postVendorInvoice(vendorInvoice('USD', 'VEND-NOFX-INV', '2026-10-16'));
    const item = (await getPayables(tenant.client, 'V10000', COMPANY)).openItems
      .find((i) => i.documentNumber === inv.journalDocumentNumber)!;
    const payment = await postOutgoingPayment(
      pay('V10000', 'USD', '2026-10-16', 100, item, 'vend-nofx-pay', '116000'),
      { authorization: actor.authorization },
    );
    await resetClearing({
      client: tenant.client, changedBy: ACTOR, companyCode: COMPANY,
      clearingDocument: payment.journalDocumentNumber, fiscalYear: 2026,
      reason: 'full vendor payment without FX', requestKey: 'vend-nofx-reset',
    });
    const status = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select status from journal_entry where client = ${tenant.client}
        and document_number = ${payment.journalDocumentNumber} and fiscal_year = 2026`)) as unknown as Array<{ status: string }>);
    expect(status[0]!.status).toBe('POSTED');
    expect(await openRefs('V10000', '200000', [inv.journalDocumentNumber!])).toHaveLength(1);
    const offset = await openRefs('V10000', '200000', [payment.journalDocumentNumber]);
    expect(offset).toHaveLength(1);
    expect(offset[0]).toMatchObject({ debit_credit: 'S' });
    expect((await journalLines(payment.journalDocumentNumber)).find((l) => l.gl_account === '116000'))
      .toMatchObject({ local: '31.0000' });
  }, 90_000);

  it('refuses reversing an FX payment under a settled residual until the downstream clearing is reset', async () => {
    const inv = await postCustomerInvoice(customerInvoiceFor('C30000', 'USD', 'RESET-DEP-INV', '2026-06-06', 100));
    const item = (await getReceivables(tenant.client, 'C30000', COMPANY)).openItems
      .find((i) => i.documentNumber === inv.journalDocumentNumber)!;
    const receipt = await postIncomingPayment(receiveFor('C30000', 'USD', '2026-10-16', 60, [{
      ...item, applied: 60, outcome: 'RESIDUAL',
    }], 'reset-dep-receipt', '103000', { bankAmount: '18.600' }));
    const residual = (await getReceivables(tenant.client, 'C30000', COMPANY)).openItems
      .find((i) => i.documentNumber === receipt.journalDocumentNumber && i.signed > 0)!;
    const credit = await manualEntry({
      currency: 'USD', date: '2026-10-20', reference: 'RESET-DEP-CR',
      lines: [
        { glAccount: '110000', debitCredit: 'H', amount: '40', amountLocal: '12.800', businessPartner: 'C30000' },
        { glAccount: '300000', debitCredit: 'S', amount: '40', amountLocal: '12.800' },
      ],
    });
    const clearing = await clearCustomerItems({
      client: tenant.client, changedBy: ACTOR, customer: 'C30000', companyCode: COMPANY,
      clearingDate: '2026-10-25', postingDate: '2026-10-25', documentDate: '2026-10-25',
      confirmed: true, requestKey: 'reset-dep-clear', items: [
        { documentNumber: residual.documentNumber, fiscalYear: residual.fiscalYear, lineNumber: residual.lineNumber },
        { documentNumber: credit.documentNumber, fiscalYear: credit.fiscalYear, lineNumber: 1 },
      ],
    });

    await expect(resetClearing({
      client: tenant.client, changedBy: ACTOR, companyCode: COMPANY,
      clearingDocument: receipt.journalDocumentNumber, fiscalYear: 2026,
      reason: 'blocked by downstream residual clearing', requestKey: 'reset-dep-1',
    })).rejects.toThrow(/subsequently settled by/);
    const receiptHeader = async () => withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select status from journal_entry where client = ${tenant.client}
        and document_number = ${receipt.journalDocumentNumber} and fiscal_year = 2026`)) as unknown as Array<{ status: string }>);
    expect((await receiptHeader())[0]!.status).toBe('POSTED');
    const noReset = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select count(*)::int as n from clearing_reset where client = ${tenant.client}
        and clearing_document = ${receipt.journalDocumentNumber}`)) as unknown as Array<{ n: number }>);
    expect(noReset[0]!.n).toBe(0);

    // Reset the downstream clearing first, then the original payment can be reversed safely.
    await resetClearing({
      client: tenant.client, changedBy: ACTOR, companyCode: COMPANY,
      clearingDocument: clearing.clearingDocumentNumber, fiscalYear: 2026,
      reason: 'release downstream residual first', requestKey: 'reset-dep-clear-reset',
    });
    await resetClearing({
      client: tenant.client, changedBy: ACTOR, companyCode: COMPANY,
      clearingDocument: receipt.journalDocumentNumber, fiscalYear: 2026,
      reason: 'now reverse the original payment', requestKey: 'reset-dep-2',
    });
    expect((await receiptHeader())[0]!.status).toBe('REVERSED');
    expect(await openRefs('C30000', '110000', [inv.journalDocumentNumber!])).toHaveLength(1);
    expect(await openRefs('C30000', '110000', [credit.documentNumber])).toHaveLength(1);
    // The payment's own Settles/residual lines are reversed and its mirror is filtered out.
    expect(await openRefs('C30000', '110000', [receipt.journalDocumentNumber])).toHaveLength(0);
    expect(await openRefs('C30000', '110000', [clearing.clearingDocumentNumber])).toHaveLength(0);
  }, 120_000);
});

describe('10. match-service evidence', () => {
  it('refuses unverified, wrong-account and wrong-currency lines before inserting any match', async () => {
    const inv = await postCustomerInvoice(customerInvoiceFor('C30000', 'KWD', 'MATCH-EVID-INV', '2026-11-01', 100));
    const item = (await getReceivables(tenant.client, 'C30000', COMPANY)).openItems
      .find((i) => i.documentNumber === inv.journalDocumentNumber)!;
    const receipt = await postIncomingPayment(receiveFor('C30000', 'KWD', '2026-11-05', 100, [item], 'match-evidence-receipt', '117000'));
    const unverified = await manualEntry({
      currency: 'USD', date: '2026-11-05', reference: 'MATCH-EVID-USD',
      lines: [
        { glAccount: '117000', debitCredit: 'S', amount: '10', amountLocal: '3.000' },
        { glAccount: '400000', debitCredit: 'H', amount: '10', amountLocal: '3.000' },
      ],
    });
    const saved = await statement({
      houseBankKey: 'HB15', accountId: 'KWD5', currency: 'KWD', reference: 'MATCH-EVIDENCE-STMT',
      fromDate: '2026-11-01', toDate: '2026-11-30', opening: '0', closing: '103',
      lines: [
        { direction: 'IN', amount: '100', valueDate: '2026-11-05' },
        { direction: 'IN', amount: '3', valueDate: '2026-11-05' },
      ],
    });
    const view = await reconciliation({ houseBankKey: 'HB15', accountId: 'KWD5', statementId: saved.statementId });
    const line100 = view.statement!.lines.find((l) => l.amount === '100.000')!;
    const line3 = view.statement!.lines.find((l) => l.amount === '3.000')!;

    const matchRows = async (requestKey: string) => withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select match_id from bank_reconciliation_match
       where client = ${tenant.client} and request_key = ${requestKey}`)) as unknown as Array<{ match_id: string }>);

    // A mixed batch with one valid and one invalid allocation inserts nothing.
    await expect(matchBankStatement({
      client: tenant.client, statementId: saved.statementId, requestKey: 'match-mixed',
      allocations: [
        {
          statementLineId: line100.lineId, ledgerDocumentNumber: receipt.journalDocumentNumber,
          ledgerFiscalYear: 2026, ledgerLineNumber: 1, amount: '100',
        },
        {
          statementLineId: line3.lineId, ledgerDocumentNumber: unverified.documentNumber,
          ledgerFiscalYear: 2026, ledgerLineNumber: 1, amount: '3',
        },
      ],
    }, { authorization: actor.authorization })).rejects.toThrow(/no actual KWD bank movement/);
    expect(await matchRows('match-mixed')).toHaveLength(0);

    // The genuine same-currency movement still matches.
    const valid = await matchBankStatement({
      client: tenant.client, statementId: saved.statementId, requestKey: 'match-valid',
      allocations: [{
        statementLineId: line100.lineId, ledgerDocumentNumber: receipt.journalDocumentNumber,
        ledgerFiscalYear: 2026, ledgerLineNumber: 1, amount: '100',
      }],
    }, { authorization: actor.authorization });
    expect(valid.matchIds).toHaveLength(1);
    const replay = await matchBankStatement({
      client: tenant.client, statementId: saved.statementId, requestKey: 'match-valid',
      allocations: [{
        statementLineId: line100.lineId, ledgerDocumentNumber: receipt.journalDocumentNumber,
        ledgerFiscalYear: 2026, ledgerLineNumber: 1, amount: '100',
      }],
    }, { authorization: actor.authorization });
    expect(replay.matchIds).toEqual(valid.matchIds);
    await expect(matchBankStatement({
      client: tenant.client, statementId: saved.statementId, requestKey: 'match-valid',
      allocations: [{
        statementLineId: line100.lineId, ledgerDocumentNumber: receipt.journalDocumentNumber,
        ledgerFiscalYear: 2026, ledgerLineNumber: 1, amount: '1',
      }],
    }, { authorization: actor.authorization })).rejects.toThrow(/different match request/);

    await expect(matchBankStatement({
      client: tenant.client, statementId: saved.statementId, requestKey: 'match-invalid',
      allocations: [{
        statementLineId: line3.lineId, ledgerDocumentNumber: unverified.documentNumber,
        ledgerFiscalYear: 2026, ledgerLineNumber: 1, amount: '3',
      }],
    }, { authorization: actor.authorization })).rejects.toThrow(/no actual KWD bank movement/);
    expect(await matchRows('match-invalid')).toHaveLength(0);

    // A line on another bank G/L is refused before any evidence comparison.
    const otherBank = await manualEntry({
      currency: 'USD', date: '2026-11-05', reference: 'MATCH-EVID-OTH',
      lines: [
        { glAccount: '114000', debitCredit: 'S', amount: '1', amountLocal: '0.300' },
        { glAccount: '400000', debitCredit: 'H', amount: '1', amountLocal: '0.300' },
      ],
    });
    await expect(matchBankStatement({
      client: tenant.client, statementId: saved.statementId, requestKey: 'match-wrong-account',
      allocations: [{
        statementLineId: line3.lineId, ledgerDocumentNumber: otherBank.documentNumber,
        ledgerFiscalYear: 2026, ledgerLineNumber: 1, amount: '3',
      }],
    }, { authorization: actor.authorization })).rejects.toThrow(/does not stand on bank G\/L/);

    // A third-currency line on a foreign bank G/L is refused rather than converted.
    const eur = await manualEntry({
      currency: 'EUR', date: '2026-10-16', reference: 'MATCH-EVID-EUR',
      lines: [
        { glAccount: '116000', debitCredit: 'S', amount: '10', amountLocal: '3.000' },
        { glAccount: '400000', debitCredit: 'H', amount: '10', amountLocal: '3.000' },
      ],
    });
    const fxStatement = await statement({
      houseBankKey: 'HB14', accountId: 'USD11', currency: 'USD', reference: 'MATCH-EVIDENCE-FX',
      fromDate: '2026-10-01', toDate: '2026-10-31', opening: '0', closing: '10',
      lines: [{ direction: 'IN', amount: '10', valueDate: '2026-10-16' }],
    });
    await expect(matchBankStatement({
      client: tenant.client, statementId: fxStatement.statementId, requestKey: 'match-wrong-currency',
      allocations: [{
        statementLineId: (await reconciliation({
          houseBankKey: 'HB14', accountId: 'USD11', statementId: fxStatement.statementId,
        })).statement!.lines[0]!.lineId,
        ledgerDocumentNumber: eur.documentNumber, ledgerFiscalYear: 2026,
        ledgerLineNumber: 1, amount: '1',
      }],
    }, { authorization: actor.authorization })).rejects.toThrow(/carries no amount in the account currency USD/);
    expect(await matchRows('match-wrong-currency')).toHaveLength(0);

    // A finalized statement still refuses matching outright.
    const finalStatement = await statement({
      houseBankKey: 'HB16', accountId: 'KWD6', currency: 'KWD', reference: 'MATCH-FINAL-STMT',
      fromDate: '2026-11-01', toDate: '2026-11-30', opening: '0', closing: '0',
    });
    await finalizeBankStatement({
      client: tenant.client, statementId: finalStatement.statementId, confirmed: true,
    }, { authorization: actor.authorization });
    await expect(matchBankStatement({
      client: tenant.client, statementId: finalStatement.statementId, requestKey: 'match-finalized',
      allocations: [{
        statementLineId: 'none', ledgerDocumentNumber: 'none', ledgerFiscalYear: 2026,
        ledgerLineNumber: 1, amount: '1',
      }],
    }, { authorization: actor.authorization })).rejects.toThrow(/finalized/);
  }, 90_000);

  it('serializes two statements competing for the same ledger movement', async () => {
    const bank = await manualEntry({
      currency: 'KWD', date: '2026-11-01', reference: 'CONC-BANK',
      lines: [
        { glAccount: '121000', debitCredit: 'S', amount: '100', amountLocal: '100.000' },
        { glAccount: '400000', debitCredit: 'H', amount: '100', amountLocal: '100.000' },
      ],
    });
    const makeStatement = (reference: string) => statement({
      houseBankKey: 'HB19', accountId: 'KWD7', currency: 'KWD', reference,
      fromDate: '2026-11-01', toDate: '2026-11-30', opening: '0', closing: '100',
      lines: [{ direction: 'IN', amount: '100', valueDate: '2026-11-01' }],
    });
    const a = await makeStatement('CONC-A');
    const b = await makeStatement('CONC-B');
    const viewA = await reconciliation({ houseBankKey: 'HB19', accountId: 'KWD7', statementId: a.statementId });
    const viewB = await reconciliation({ houseBankKey: 'HB19', accountId: 'KWD7', statementId: b.statementId });

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let acquired!: () => void;
    const gotLock = new Promise<void>((resolve) => { acquired = resolve; });
    const holder = withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${tenant.client}/bankline/${bank.documentNumber}/2026`}, 0))`);
      acquired();
      await held;
    });
    await gotLock;
    const match = (statementId: string, statementLineId: string, requestKey: string) => matchBankStatement({
      client: tenant.client, statementId, requestKey,
      allocations: [{
        statementLineId, ledgerDocumentNumber: bank.documentNumber,
        ledgerFiscalYear: 2026, ledgerLineNumber: 1, amount: '100',
      }],
    }, { authorization: actor.authorization });
    const first = match(a.statementId, viewA.statement!.lines[0]!.lineId, 'conc-a');
    const second = match(b.statementId, viewB.statement!.lines[0]!.lineId, 'conc-b');
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await holder;
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult | undefined;
    expect(String((rejected?.reason as { message?: string } | undefined)?.message ?? rejected?.reason))
      .toMatch(/exceeds the ledger line's remaining/);
    const totals = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select count(*)::int as n, coalesce(sum(allocated_amount), 0)::numeric::text as total
        from bank_reconciliation_match
       where client = ${tenant.client} and ledger_document_number = ${bank.documentNumber}
         and ledger_fiscal_year = 2026 and ledger_line_number = 1 and is_active
    `)) as unknown as Array<{ n: number; total: string }>);
    expect(totals[0]!.n).toBe(1);
    expect(Number(totals[0]!.total)).toBe(100);
  }, 60_000);
});
