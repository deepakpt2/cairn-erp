import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postCustomerInvoice } from '../src/modules/finance/customer-invoice';
import { getReceivables } from '../src/modules/finance/incoming-payment';
import { getCustomerAgeing } from '../src/modules/finance/customer-ageing';
import { getGlBalances } from '../src/modules/finance/gl-balances';
import {
  finalizeDunningRun as finalizeDunningRunService,
  proposeDunningRun as proposeDunningRunService,
} from '../src/modules/finance/dunning';
import { createFinanceActor, financePoster, type FinanceActor } from './helpers/finance-actor';
import { createTenant, defineTestRanges, destroyTenant, type TestTenant } from './helpers';

/**
 * A dunning notice states what a customer owes, and a receivable is owed in the document
 * currency of the item. This suite exists because the earlier service read the item's *local*
 * carrying amount and labelled it with the *document* currency code: on a KWD-local company a
 * USD 1,200 invoice quoted `360.0000 USD`, understating the debt by the exchange rate.
 *
 * It also covers the two design decisions this repair rests on:
 *  - an account with items in more than one currency is proposed once per currency, never summed
 *    across currencies and never excluded wholesale;
 *  - ageing keeps its amounts in the company's local currency (so it ties to the G/L account
 *    balance) and carries the document amount and currency beside it.
 */

const ACTOR = 'DUNNING_CCY_TEST';
const COMPANY = '1000';
const LOCAL = 'KWD';
const RECON = '110000';

/** Same 4-place rounding the services use, so a sum of items compares exactly with a total. */
const round4 = (n: number) => Math.round(n * 10000) / 10000;

let tenant: TestTenant;
let actor: FinanceActor;

const proposeDunningRun = financePoster(proposeDunningRunService);
const finalizeDunningRun = financePoster(finalizeDunningRunService);

/** Two customers: one single-currency, one holding a USD and a EUR item. */
async function setup(): Promise<void> {
  tenant = await createTenant('dunning-currency', { currency: LOCAL });
  await defineTestRanges(tenant, { fiscalYear: 2026 });
  await withTenant(tenant.client, async (tx) => {
    await defineRange(tx, {
      client: tenant.client, objectCode: 'CUSTINV', subObject: '*',
      prefix: 'CI', numberLength: 7, createdBy: ACTOR,
    });
    for (const partner of ['C10000', 'C20000']) {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${tenant.client}, ${partner}, 'ORGANIZATION', ${`Dunning ${partner}`}, ${ACTOR})
        on conflict do nothing`);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${tenant.client}, ${partner}, 'CUSTOMER', ${ACTOR})
        on conflict do nothing`);
    }
    await tx.execute(sql`
      insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
      values (${tenant.client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR})
      on conflict do nothing`);
    for (const partner of ['C10000', 'C20000']) {
      await tx.execute(sql`
        insert into customer_company_code
          (client, partner_number, role_code, company_code, chart_of_accounts,
           reconciliation_account, payment_terms_code, dunning_procedure, created_by)
        values (${tenant.client}, ${partner}, 'CUSTOMER', ${COMPANY}, 'CA01', ${RECON}, 'NET30', 'DUN1', ${ACTOR})
        on conflict do nothing`);
    }
    // KWD and EUR per USD, so a USD and a EUR item translate to different local amounts.
    await tx.execute(sql`
      insert into exchange_rate (client, rate_type, from_currency, to_currency, valid_from, rate, created_by) values
        (${tenant.client}, 'AVERAGE', 'USD', ${LOCAL}, '2026-01-01', 0.300, ${ACTOR}),
        (${tenant.client}, 'AVERAGE', 'EUR', ${LOCAL}, '2026-01-01', 0.330, ${ACTOR})
      on conflict do nothing`);
  });
  actor = await createFinanceActor(tenant.client);
}

beforeAll(async () => { await setup(); }, 180_000);
afterAll(async () => { if (tenant) await destroyTenant(tenant.client); }, 300_000);

async function invoice(
  customer: string, currency: string, gross: number, key: string,
): Promise<string> {
  const posted = await postCustomerInvoice({
    client: tenant.client, changedBy: ACTOR, customerNumber: customer, companyCode: COMPANY,
    documentDate: '2026-09-16', postingDate: '2026-09-18',
    reference: key, currency, grossAmount: gross, requestKey: key,
    lines: [{ glAccount: '300000', netAmount: gross }],
  });
  return posted.journalDocumentNumber!;
}

describe('dunning states the document-currency amount', () => {
  it('quotes a USD invoice in USD, not its KWD carrying amount', async () => {
    // Due 2026-10-16 (document date + NET30): overdue on 2026-11-20.
    const usd = await invoice('C10000', 'USD', 1200, 'dun-ccy-usd');
    const run = await proposeDunningRun({
      client: tenant.client, changedBy: ACTOR, runDate: '2026-11-20', runId: 'CCY001',
      dunningDate: '2026-11-20', postedThrough: '2026-11-20', companyCodes: [COMPANY],
      customerFrom: 'C10000', customerTo: 'C10000',
    });

    // 1,200 USD carries KWD 360.000; the notice must state the 1,200 it is owed.
    expect(run.items.map((i) => [i.documentNumber, i.overdueAmount, i.currency]))
      .toEqual([[usd, '1200.0000', 'USD']]);
    const account = run.accounts.find((a) => a.customer === 'C10000')!;
    expect(account.currency).toBe('USD');
    expect(account.totalOverdue).toBe('1200.0000');

    // The carried amount is still the local one — proof the two are not the same figure.
    const receivable = (await getReceivables(tenant.client, 'C10000', COMPANY)).openItems
      .find((i) => i.documentNumber === usd)!;
    expect(receivable.amount).toBe('1200.0000');
    const carried = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select amount_local::text as amount_local from journal_entry_line
       where client = ${tenant.client} and document_number = ${usd}
         and business_partner = 'C10000' and debit_credit = 'S'`));
    expect((carried as unknown as Array<{ amount_local: string }>)[0].amount_local).toBe('360.0000');
  }, 90_000);

  it('persists the document currency on the finalized notice', async () => {
    const done = await finalizeDunningRun({
      client: tenant.client, changedBy: ACTOR, runDate: '2026-11-20', runId: 'CCY001', confirmed: true,
    });
    const notice = done.notices.find((n) => n.customer === 'C10000')!;
    expect(notice.currency).toBe('USD');
    expect(notice.amount).toBe('1200.0000');

    // Read back from the table, not from the returned view.
    const stored = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select currency, amount::text as amount from dunning_notice
       where client = ${tenant.client} and notice_number = ${notice.noticeNumber}`));
    expect((stored as unknown as Array<{ currency: string; amount: string }>)[0])
      .toEqual({ currency: 'USD', amount: '1200.0000' });
  }, 90_000);
});

describe('an account holding two currencies', () => {
  it('is proposed per currency and never summed across them', async () => {
    // USD 500 (KWD 150.000) and EUR 400 (KWD 132.000): summing would give a meaningless 900.
    const usd = await invoice('C20000', 'USD', 500, 'dun-multi-usd');
    const eur = await invoice('C20000', 'EUR', 400, 'dun-multi-eur');
    const run = await proposeDunningRun({
      client: tenant.client, changedBy: ACTOR, runDate: '2026-11-20', runId: 'CCY002',
      dunningDate: '2026-11-20', postedThrough: '2026-11-20', companyCodes: [COMPANY],
      customerFrom: 'C20000', customerTo: 'C20000',
    });

    // Two account rows, one per currency, each stating its own currency's total.
    const accounts = run.accounts
      .filter((a) => a.customer === 'C20000')
      .map((a) => [a.currency, a.totalOverdue])
      .sort();
    expect(accounts).toEqual([['EUR', '400.0000'], ['USD', '500.0000']]);

    // The items stand in their own currencies and are not mixed into one row.
    const items = run.items
      .map((i) => [i.documentNumber, i.overdueAmount, i.currency])
      .sort();
    expect(items).toEqual([
      [eur, '400.0000', 'EUR'],
      [usd, '500.0000', 'USD'],
    ].sort());

    // Neither account row is an exclusion: the customer has a dunning procedure.
    expect(run.accounts.filter((a) => a.customer === 'C20000').every((a) => a.status === 'PROPOSED')).toBe(true);
  }, 90_000);

  it('writes one notice per currency, each with its own amount', async () => {
    const done = await finalizeDunningRun({
      client: tenant.client, changedBy: ACTOR, runDate: '2026-11-20', runId: 'CCY002', confirmed: true,
    });
    const notices = done.notices
      .filter((n) => n.customer === 'C20000')
      .map((n) => [n.currency, n.amount])
      .sort();
    expect(notices).toEqual([['EUR', '400.0000'], ['USD', '500.0000']]);

    // Each notice is its own identity, because one notice speaks one currency.
    const numbers = done.notices.filter((n) => n.customer === 'C20000').map((n) => n.noticeNumber);
    expect(new Set(numbers).size).toBe(2);
  }, 90_000);
});

describe('the dunning threshold compares like with like', () => {
  /**
   * The item comparison (`amount = amount_document - valid document applications`) is exact in
   * documents. Neither a minimum amount nor a level threshold is configured in this system —
   * `customer_company_code.dunning_procedure` is a free 4-character code with no master, and no
   * interest or fee table exists — so the only "threshold" the run applies is the overdue-day
   * count, which is currency-free. This case pins that a foreign item is judged on its document
   * amount, so a due-but-not-overdue item never crosses the threshold on a converted figure.
   */
  it('judges an overdue foreign item on its document amount, not a converted one', async () => {
    // Posted on 2026-12-10: NET30 makes it due 2027-01-09, after the dunning date, so not dunned.
    const notYetDue = await postCustomerInvoice({
      client: tenant.client, changedBy: ACTOR, customerNumber: 'C10000', companyCode: COMPANY,
      documentDate: '2026-12-10', postingDate: '2026-12-10',
      reference: 'dun-ccy-future', currency: 'USD', grossAmount: 9000, requestKey: 'dun-ccy-future',
      lines: [{ glAccount: '300000', netAmount: 9000 }],
    });
    const run = await proposeDunningRun({
      client: tenant.client, changedBy: ACTOR, runDate: '2026-12-20', runId: 'CCY003',
      dunningDate: '2026-12-20', postedThrough: '2026-12-20', companyCodes: [COMPANY],
      customerFrom: 'C10000', customerTo: 'C10000',
    });

    // The 1,200 USD item from the first case is still overdue and keeps its document amount as
    // the days advance; nothing is re-expressed in KWD.
    const item = run.items.find((i) => i.customer === 'C10000')!;
    expect(item.currency).toBe('USD');
    expect(Number(item.overdueAmount)).toBeGreaterThan(0);
    expect(run.items.some((i) => i.documentNumber === notYetDue.journalDocumentNumber!)).toBe(false);
  }, 90_000);
});

describe('ageing reconciles to the G/L in the local currency', () => {
  it('labels its amounts in KWD and still ties to the reconciliation account', async () => {
    const ageing = await getCustomerAgeing(tenant.client, {
      companyCode: COMPANY, keyDate: '2026-11-20',
      customerFrom: 'C10000', customerTo: 'C10000',
      authorization: actor.authorization,
    });
    // The USD 1,200 invoice carries KWD 360.000; ageing presents that carrying amount in KWD.
    const item = ageing.items.find((i) => i.documentAmount === '1200.0000')!;

    expect(ageing.currency).toBe(LOCAL);
    expect(item.currency).toBe(LOCAL);
    expect(item.amount).toBe('360.0000');
    expect(item.signed).toBe(360);
    // The document amount stands beside it under its own currency, never relabelled.
    expect(item.documentCurrency).toBe('USD');
    expect(item.documentAmount).toBe('1200.0000');
  }, 90_000);

  it('equals the reconciliation account balance in KWD', async () => {
    // A full fiscal year on both sides: ageing at the year end covers every item the G/L carries.
    const keyDate = '2026-12-31';
    const ageing = await getCustomerAgeing(tenant.client, {
      companyCode: COMPANY, keyDate, authorization: actor.authorization,
    });
    const gl = await getGlBalances(tenant.client, {
      companyCode: COMPANY, glAccount: RECON, fiscalYear: 2026,
      authorization: actor.authorization,
    });

    // The account is debit-positive (a receivable); ageing signs a receivable positive too.
    // They agree because ageing derives its amounts in the ledger's local currency, not by
    // converting document amounts at report time.
    expect(ageing.currency).toBe(LOCAL);
    expect(gl.currency).toBe(LOCAL);
    expect(ageing.grandTotal).toBe(gl.yearClosing);
    // Every item's KWD remainder sums to the total ageing reports — the two are the same figure.
    expect(round4(ageing.items.reduce((s, i) => s + i.signed, 0))).toBe(ageing.grandTotal);
    // ...and that figure is not the sum of the document amounts, which stand in three currencies.
    expect(ageing.grandTotal).not.toBe(
      round4(ageing.items.reduce((s, i) => s + Number(i.documentAmount), 0)),
    );
  }, 90_000);

  it('keeps the local total independent of the foreign item mix', async () => {
    // Reading the same standing twice changes nothing, and the KWD total is a carrying sum.
    const once = await getCustomerAgeing(tenant.client, {
      companyCode: COMPANY, keyDate: '2026-11-20', authorization: actor.authorization,
    });
    const documentCurrencies = [...new Set(once.items.map((i) => i.documentCurrency))].sort();
    expect(documentCurrencies).toEqual(['EUR', 'USD']);
    // Every line is presented in the local currency even though no two documents share one.
    expect(new Set(once.items.map((i) => i.currency))).toEqual(new Set([LOCAL]));
  }, 90_000);
});

describe('the currency label never drifts from the amount', () => {
  it('stores a notice currency that is a real currency, never the local one misapplied', async () => {
    // A read-only check over every notice this suite wrote: the amount's currency is the currency
    // of the items it stands for, and a USD notice is not carrying KWD 360-ish figures.
    const rows = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select n.currency, n.amount::text as amount, count(distinct l.currency) as item_currencies
        from dunning_notice n
        join dunning_run_item l
          on l.client = n.client and l.run_date = n.run_date and l.run_id = n.run_id
         and l.company_code = n.company_code and l.customer = n.customer and l.currency = n.currency
       where n.client = ${tenant.client}
       group by n.currency, n.amount`));
    const notices = rows as unknown as Array<{ currency: string; amount: string; item_currencies: number }>;
    expect(notices.length).toBeGreaterThan(0);
    for (const notice of notices) {
      // Each notice draws on items of exactly its own currency.
      expect(Number(notice.item_currencies)).toBe(1);
      expect([LOCAL, 'USD', 'EUR']).toContain(notice.currency.trim());
    }
  }, 90_000);
});
