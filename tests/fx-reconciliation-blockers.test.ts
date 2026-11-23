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
import { executeFxValuation } from '../src/modules/finance/fx-valuation';
import {
  finalizeBankStatement, getBankReconciliation, matchBankStatement, saveBankStatement,
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
  ]);
  await withTenant(tenant.client, async (tx) => {
    await defineRange(tx, { client: tenant.client, objectCode: 'CUSTINV', subObject: '*', prefix: 'CI', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client: tenant.client, objectCode: 'VENDINV', subObject: '*', prefix: 'VI', numberLength: 7, createdBy: ACTOR });
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by) values
        (${tenant.client}, 'C10000', 'ORGANIZATION', 'Blocker Customer', ${ACTOR}),
        (${tenant.client}, 'V10000', 'ORGANIZATION', 'Blocker Vendor', ${ACTOR}),
        (${tenant.client}, 'V20000', 'ORGANIZATION', 'Second Vendor', ${ACTOR}),
        (${tenant.client}, 'C20000', 'ORGANIZATION', 'Balance-Valuation Customer', ${ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by) values
        (${tenant.client}, 'C10000', 'CUSTOMER', ${ACTOR}),
        (${tenant.client}, 'C20000', 'CUSTOMER', ${ACTOR}),
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
        and account_number in ('102000', '103000', '104000', '105000', '106000', '107000', '108000')`);
    // 0.300 until 15 Oct, 0.310 then, 0.320 from 20 Oct, 0.330 from December, and a dedicated
    // 0.30001 row used to carry exactly KWD 30.001 on USD 100.
    await tx.execute(sql`
      insert into exchange_rate (client, rate_type, from_currency, to_currency, valid_from, rate, created_by) values
        (${tenant.client}, 'AVERAGE', 'USD', 'KWD', '2026-01-01', 0.300, ${ACTOR}),
        (${tenant.client}, 'AVERAGE', 'USD', 'KWD', '2026-10-15', 0.310, ${ACTOR}),
        (${tenant.client}, 'AVERAGE', 'USD', 'KWD', '2026-10-20', 0.320, ${ACTOR}),
        (${tenant.client}, 'AVERAGE', 'USD', 'KWD', '2026-12-01', 0.330, ${ACTOR}),
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

function customerInvoice(currency: string, reference: string, date: string, gross = 100) {
  return {
    client: tenant.client, changedBy: ACTOR, customerNumber: 'C10000', companyCode: COMPANY,
    documentDate: date, postingDate: date, reference, currency, grossAmount: gross,
    requestKey: `ci-${reference}`,
    lines: [{ glAccount: '300000', netAmount: gross }],
  };
}

function vendorInvoice(currency: string, reference: string, date: string, vendor = 'V10000', gross = 100) {
  return {
    client: tenant.client, changedBy: ACTOR, vendorNumber: vendor, companyCode: COMPANY,
    documentDate: date, postingDate: date, reference, currency, grossAmount: gross,
    requestKey: `vi-${reference}`,
    lines: [{ glAccount: '400000', netAmount: gross }],
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
  return {
    client: tenant.client, changedBy: ACTOR, customerNumber: 'C10000', companyCode: COMPANY,
    documentDate: date, postingDate: date, clearingDate: date,
    bankGlAccount, amount, currency, requestKey: key, items,
    authorization: actor.authorization, ...extra,
  };
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
    select document_number, fiscal_year, line_number, debit_credit, amount_local::text as local
      from journal_entry_line
     where client = ${tenant.client} and business_partner = ${partner}
       and gl_account = ${glAccount} and clearing_document is null`)) as unknown as Array<{
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

    // The reversal posts in fiscal year 2027; the December as-of balance must not change.
    await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
      client: tenant.client, documentNumber: receiptDoc, fiscalYear: 2026,
      reversalDate: '2027-01-05', reason: 'as-of reversal test', reversedBy: ACTOR,
    }));
    const december = await reconciliation({ houseBankKey: 'HB05', accountId: 'USD3', statementId });
    expect(december.bridge!.ledgerClosing).toBe('100.00');
    expect(december.issues.some((i) => i.code === 'INVALID_MATCH' && i.blocking)).toBe(true);

    const january = await statement({
      houseBankKey: 'HB05', accountId: 'USD3', currency: 'USD', reference: 'ASOF-2027-01',
      fromDate: '2027-01-01', toDate: '2027-01-31', opening: '100', closing: '100',
    });
    const after = await reconciliation({ houseBankKey: 'HB05', accountId: 'USD3', statementId: january.statementId });
    // Before the reversal date it stood at +100; from the reversal date the pair cancels, never ?100.
    expect(after.bridge!.ledgerClosing).toBe('0.00');
    expect(after.ledgerLines.some((l) => l.documentNumber === receiptDoc)).toBe(false);
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
    await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
      client: tenant.client, documentNumber: receipt.journalDocumentNumber, fiscalYear: 2026,
      reversalDate: '2027-01-05', reason: 'local bank as-of reversal', reversedBy: ACTOR,
    }));
    const january = await statement({
      houseBankKey: 'HB06', accountId: 'KWD4', currency: 'KWD', reference: 'ASOF-KWD-JAN',
      fromDate: '2027-01-01', toDate: '2027-01-31', opening: '100', closing: '100',
    });
    expect((await reconciliation({ houseBankKey: 'HB06', accountId: 'KWD4', statementId: january.statementId }))
      .bridge!.ledgerClosing).toBe('0.000');
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

    // Reversal: the adjustment disappears as of its date, with no permanent blocker.
    await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
      client: tenant.client, documentNumber: valuation.postingDocument!, fiscalYear: 2026,
      reversalDate: '2026-12-31', reason: 'reverse bank valuation', reversedBy: ACTOR,
    }));
    const reversed = await reconciliation({ houseBankKey: 'HB04', accountId: 'USD2', statementId: saved.statementId });
    expect(reversed.ledgerLines.some((l) => l.documentNumber === valuation.postingDocument)).toBe(false);
    expect(reversed.bridge!.ledgerClosing).toBe('100.00');
    expect(reversed.issues.some((i) => i.code === 'LEDGER_CURRENCY')).toBe(false);

    // An ordinary local-currency manual line is still not evidence and still blocks.
    await manualEntry({
      currency: 'KWD', date: '2026-12-28', reference: 'VALBANK-LEGACY',
      lines: [
        { glAccount: '105000', debitCredit: 'S', amount: '5.000', amountLocal: '5.000' },
        { glAccount: '400000', debitCredit: 'H', amount: '5.000', amountLocal: '5.000' },
      ],
    });
    const legacy = await reconciliation({ houseBankKey: 'HB04', accountId: 'USD2', statementId: saved.statementId });
    expect(legacy.issues.some((i) => i.code === 'LEDGER_CURRENCY' && i.blocking)).toBe(true);
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
    const valuation = await executeFxValuation({
      client: tenant.client, changedBy: ACTOR, authorization: actor.authorization,
      selection: {
        companyCode: COMPANY, valuationArea: 'CLRVL2', valuationKeyDate: '2026-12-31',
        postingDate: '2026-12-31', fiscalYear: 2026, valuationMethod: 'AVERAGE',
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
      client: tenant.client, documentNumber: valuation.postingDocument!, fiscalYear: 2026,
      reversalDate: '2027-01-05', reason: 'release vendor clearing valuation', reversedBy: ACTOR,
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
      reversalDate: '2027-01-05', reason: 'release balance valuation clearing', reversedBy: ACTOR,
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
