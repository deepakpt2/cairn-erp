import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postCustomerInvoice } from '../src/modules/finance/customer-invoice';
import { postCustomerDownPayment } from '../src/modules/finance/customer-down-payment';
import { getReceivables, postIncomingPayment as postIncomingPaymentRaw } from '../src/modules/finance/incoming-payment';
import {
  clearCustomerDownPayments,
  getCustomerDownPaymentClearing,
  type ClearingAllocation,
  type ClearingItemRef,
} from '../src/modules/finance/customer-down-payment-clearing';
import {
  cancelDunningRun,
  DunningError,
  finalizeDunningRun as finalizeDunningRunService,
  proposeDunningRun as proposeDunningRunService,
} from '../src/modules/finance/dunning';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';
import { financeInputPoster, financePoster } from './helpers/finance-actor';

const finalizeDunningRun = financePoster(finalizeDunningRunService);
const proposeDunningRun = financePoster(proposeDunningRunService);
const postIncomingPayment = financeInputPoster(postIncomingPaymentRaw);

const ACTOR = 'DUNNING_STALE_TEST';
const COMPANY = '1000';

/**
 * A notice must demand the amount the customer owes when it is finalized, not the amount that stood
 * overdue when the run was proposed.
 *
 * The original defect: an advance applied to an overdue invoice *after* the run was proposed left
 * the original invoice line open (only a full application stamps it clear), so finalization's "is
 * the line still open" check passed and the proposal's stored 1,200 was written as the notice
 * unchanged — while the customer owed 400.
 *
 * The follow-on defect: the proposal read its amounts **as of `postedThrough`** while finalization
 * reads the ledger **now**. An application dated after the cutoff therefore made a run permanently
 * unfinalizable — re-proposing on the same cutoff reproduced the same stale figure. Both paths now
 * read one basis (open balance as of now); the cutoff decides only which items are in scope and how
 * far they stand overdue.
 *
 * Regression tests run against the real services and a real database, and assert the whole result
 * set. Each case uses its own customer so a run never picks up another case's items.
 */
describe('dunning finalization revalidates the net amount under the settlement lock', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('dunning-stale-amount');
      client = tenant.client;
      await defineTestRanges(tenant, { fiscalYear: 2026 });
      await withTenant(client, async (tx) => {
        await defineRange(tx, {
          client, objectCode: 'CUSTINV', subObject: '*', prefix: 'CI', numberLength: 7, createdBy: ACTOR,
        });
        await tx.execute(sql`
          insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
          values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into special_gl_config (
            client, company_code, account_type, indicator,
            alternative_reconciliation_account, description, created_by
          )
          values (${client}, '', 'AR', 'A', '230000', 'Customer advances', ${ACTOR})
          on conflict do nothing
        `);
      });
    }
    return client;
  }

  /** A customer of its own, extended to the company with a dunning procedure. */
  async function customer(number: string): Promise<string> {
    await standingClient();
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${client}, ${number}, 'ORGANIZATION', ${`Stale Amount ${number}`}, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${client}, ${number}, 'CUSTOMER', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into customer_company_code (
          client, partner_number, role_code, company_code, chart_of_accounts,
          reconciliation_account, payment_terms_code, dunning_procedure, created_by
        )
        values (${client}, ${number}, 'CUSTOMER', ${COMPANY}, 'CA01', '110000', 'NET30', 'DUN1', ${ACTOR})
        on conflict do nothing
      `);
    });
    return number;
  }

  const ref = (i: ClearingItemRef): ClearingItemRef => ({
    documentNumber: i.documentNumber, fiscalYear: i.fiscalYear, lineNumber: i.lineNumber,
  });

  /** An invoice due 2026-10-16 (document date + NET30), so overdue at every dunning date below. */
  async function overdueInvoice(partner: string, key: string, amount: number) {
    return postCustomerInvoice({
      client, changedBy: ACTOR, customerNumber: partner, companyCode: COMPANY,
      documentDate: '2026-09-16', postingDate: '2026-09-18',
      reference: key, currency: 'USD', grossAmount: amount, requestKey: key,
      lines: [{ glAccount: '300000', netAmount: amount }],
    });
  }

  async function advance(partner: string, key: string, amount: number, postingDate: string) {
    return postCustomerDownPayment({
      client, changedBy: ACTOR, customerNumber: partner, companyCode: COMPANY,
      documentDate: postingDate, postingDate,
      bankGlAccount: '101000', amount, currency: 'USD',
      specialGlIndicator: 'A', requestKey: key,
    });
  }

  /** Apply an advance to an invoice through the real clearing service, dated by the caller. */
  async function applyAdvance(
    partner: string, invoiceNumber: string, advanceNumber: string,
    amount: number, key: string, date: string,
  ) {
    const before = await getCustomerDownPaymentClearing(client, partner, COMPANY, 'A');
    const advanceItem = before.downPayments.find((d) => d.documentNumber === advanceNumber)!;
    const invoiceItem = before.invoices.find((i) => i.documentNumber === invoiceNumber)!;
    const allocations: ClearingAllocation[] = [
      { downPayment: ref(advanceItem), invoice: ref(invoiceItem), amount },
    ];
    return clearCustomerDownPayments({
      client, changedBy: ACTOR, customerNumber: partner, companyCode: COMPANY, indicator: 'A',
      documentDate: date, postingDate: date, clearingDate: date,
      currency: 'USD', reference: key.slice(0, 16), requestKey: key, allocations,
    });
  }

  const propose = (
    partner: string, runId: string,
    window: { runDate: string; dunningDate: string; postedThrough: string },
  ) => proposeDunningRun({
    client, changedBy: ACTOR, runId,
    runDate: window.runDate, dunningDate: window.dunningDate, postedThrough: window.postedThrough,
    companyCodes: [COMPANY], customerFrom: partner, customerTo: partner,
  });

  const finalize = (runDate: string, runId: string) => finalizeDunningRun({
    client, changedBy: ACTOR, runDate, runId, confirmed: true,
  });

  /**
   * The whole refusal as the operator reads it: the page renders `message` then `remedy`
   * (`page.tsx:108`), so a test that only checked `message` would miss half the text.
   */
  const refusal = async (runDate: string, runId: string): Promise<{ message: string; remedy: string; text: string }> => {
    const error = await finalize(runDate, runId).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(DunningError);
    const { message, remedy } = error as DunningError;
    return { message, remedy: remedy ?? '', text: `${message} ${remedy ?? ''}` };
  };

  const notices = (runId: string) => withTenant(client, (tx) => tx.execute(sql`
    select notice_number, customer, currency, amount::text as amount, dunning_level
      from dunning_notice where client = ${client} and run_id = ${runId}
     order by notice_number
  `)) as Promise<Array<{ notice_number: string; customer: string; currency: string; amount: string; dunning_level: number }>>;

  it('refuses to finalize a 1,200 proposal after an 800 advance was applied, and writes no notice', async () => {
    const partner = await customer('C10010');
    const invoice = await overdueInvoice(partner, 'stale-inv-1', 1200);
    const invoiceNumber = invoice.journalDocumentNumber!;

    const proposed = await propose(partner, 'STL001', {
      runDate: '2026-12-31', dunningDate: '2026-12-31', postedThrough: '2026-12-20',
    });
    expect(proposed.items.map((i) => [i.documentNumber, i.overdueAmount, i.currency, i.status]))
      .toEqual([[invoiceNumber, '1200.0000', 'USD', 'PROPOSED']]);
    expect(proposed.accounts.map((a) => [a.currency, a.totalOverdue, a.status]))
      .toEqual([['USD', '1200.0000', 'PROPOSED']]);

    // An 800 advance lands after the proposal. A partial application leaves the invoice line open.
    const advancePosted = await advance(partner, 'stale-dp-1', 800, '2026-12-26');
    await applyAdvance(partner, invoiceNumber, advancePosted.journalDocumentNumber, 800, 'stale-apply-1', '2026-12-28');

    const collectible = (await getReceivables(client, partner, COMPANY)).openItems
      .find((i) => i.documentNumber === invoiceNumber)!;
    expect(collectible.amount).toBe('400.0000');
    const stillOpen = await withTenant(client, (tx) => tx.execute(sql`
      select clearing_document from journal_entry_line
       where client = ${client} and document_number = ${invoiceNumber}
         and gl_account = '110000' and debit_credit = 'S'
    `));
    expect((stillOpen as unknown as Array<{ clearing_document: string | null }>)[0].clearing_document).toBeNull();

    await expect(finalize('2026-12-31', 'STL001')).rejects.toThrow(
      'stands open at 400.0000 USD since the proposal was made, not the 1200.0000 USD it states',
    );

    expect(await notices('STL001')).toHaveLength(0);
    const runStatus = await withTenant(client, (tx) => tx.execute(sql`
      select status from dunning_run where client = ${client} and run_id = 'STL001'
    `));
    expect((runStatus as unknown as Array<{ status: string }>)[0].status).toBe('PROPOSED');
  });

  it('proposes and finalizes on one basis: an 800 advance dated after the cutoff still nets, and 400 is issued', async () => {
    const partner = await customer('C10015');
    const invoice = await overdueInvoice(partner, 'stale-inv-c1', 1200);
    const invoiceNumber = invoice.journalDocumentNumber!;
    // The application is posted *after* the cutoff (2026-12-20) but before the dunning date.
    const advancePosted = await advance(partner, 'stale-dp-c1', 800, '2026-12-26');
    await applyAdvance(partner, invoiceNumber, advancePosted.journalDocumentNumber, 800, 'stale-apply-c1', '2026-12-28');

    const window = { runDate: '2026-12-31', dunningDate: '2026-12-31', postedThrough: '2026-12-20' };

    // The proposal reads the ledger as it stands now, so it already states 400 — not the 1,200 that
    // stood at the cutoff. Before the fix this said 1,200 and the run could never be finalized.
    const proposed = await propose(partner, 'STL010', window);
    expect(proposed.items.map((i) => [i.documentNumber, i.overdueAmount]))
      .toEqual([[invoiceNumber, '400.0000']]);
    expect(proposed.accounts.map((a) => [a.currency, a.totalOverdue]))
      .toEqual([['USD', '400.0000']]);

    // Finalization agrees with the proposal on an unchanged ledger and issues 400.
    const done = await finalize('2026-12-31', 'STL010');
    expect(done.notices.map((n) => [n.customer, n.currency, n.amount, n.dunningLevel]))
      .toEqual([[partner, 'USD', '400.0000', 1]]);
    expect(await notices('STL010')).toEqual([
      {
        notice_number: done.notices[0].noticeNumber, customer: partner,
        currency: 'USD', amount: '400.0000', dunning_level: 1,
      },
    ]);
    // The account row carries the notice's figure, never the proposal's superseded total.
    expect(done.accounts.map((a) => [a.currency, a.totalOverdue, a.status]))
      .toEqual([['USD', '400.0000', 'COMPLETED']]);
  });

  it('refuses after an application made between proposal and finalize, and a re-proposal on the same cutoff succeeds', async () => {
    const partner = await customer('C10020');
    const invoice = await overdueInvoice(partner, 'stale-inv-2', 1200);
    const invoiceNumber = invoice.journalDocumentNumber!;
    const window = { runDate: '2026-12-31', dunningDate: '2026-12-31', postedThrough: '2026-12-20' };

    const proposed = await propose(partner, 'STL011', window);
    expect(proposed.items.map((i) => i.overdueAmount)).toEqual(['1200.0000']);

    // 800 applied after the proposal: the ledger moved underneath it.
    const advancePosted = await advance(partner, 'stale-dp-2', 800, '2026-12-29');
    await applyAdvance(partner, invoiceNumber, advancePosted.journalDocumentNumber, 800, 'stale-apply-2', '2026-12-29');

    await expect(finalize('2026-12-31', 'STL011')).rejects.toThrow('the proposal is stale');
    expect(await notices('STL011')).toHaveLength(0);

    // Re-proposing with the *same* cutoff is not stuck at 1,200: the basis is now, so it states 400
    // and finalizes. That is the property the old as-of-cutoff proposal lacked.
    const reproposed = await propose(partner, 'STL012', window);
    expect(reproposed.items.map((i) => [i.documentNumber, i.overdueAmount]))
      .toEqual([[invoiceNumber, '400.0000']]);
    const done = await finalize('2026-12-31', 'STL012');
    expect(done.notices.map((n) => [n.currency, n.amount])).toEqual([['USD', '400.0000']]);
  });

  it('refuses the whole run and lists every stale item, not only the first', async () => {
    const partner = await customer('C10025');
    const first = await overdueInvoice(partner, 'stale-multi-1', 600);
    const second = await overdueInvoice(partner, 'stale-multi-2', 500);
    const window = { runDate: '2026-12-31', dunningDate: '2026-12-31', postedThrough: '2026-12-20' };

    const proposed = await propose(partner, 'STL020', window);
    expect(proposed.items.map((i) => [i.documentNumber, i.overdueAmount]).sort())
      .toEqual([[first.journalDocumentNumber!, '600.0000'], [second.journalDocumentNumber!, '500.0000']].sort());

    // Both items move: 100 applied to each, so both proposals go stale together.
    const advancePosted = await advance(partner, 'stale-dp-multi', 200, '2026-12-28');
    await applyAdvance(partner, first.journalDocumentNumber!, advancePosted.journalDocumentNumber, 100, 'stale-apply-m1', '2026-12-28');
    await applyAdvance(partner, second.journalDocumentNumber!, advancePosted.journalDocumentNumber, 100, 'stale-apply-m2', '2026-12-28');

    const failure = await refusal('2026-12-31', 'STL020');
    expect(failure.message).toContain('2 proposed item(s) stand stale');
    expect(failure.message).toContain(first.journalDocumentNumber!);
    expect(failure.message).toContain(second.journalDocumentNumber!);
    // Both are named in one error, not just the first.
    expect(failure.message.match(/since the proposal was made, not the/g)).toHaveLength(2);
    expect(failure.remedy).toContain('Nothing has been written');

    // All-or-nothing: no notice was issued for either item.
    expect(await notices('STL020')).toHaveLength(0);
  });

  it('refuses when a payment was posted between proposal and finalize, and never issues the stale notice', async () => {
    const partner = await customer('C10030');
    const invoice = await overdueInvoice(partner, 'stale-inv-3', 700);
    const invoiceNumber = invoice.journalDocumentNumber!;
    const window = { runDate: '2026-12-31', dunningDate: '2026-12-31', postedThrough: '2026-12-20' };

    const proposed = await propose(partner, 'STL030', window);
    expect(proposed.items.map((i) => i.overdueAmount)).toEqual(['700.0000']);

    // A real incoming payment arrives between proposal and finalization.
    const item = (await getReceivables(client, partner, COMPANY)).openItems
      .find((i) => i.documentNumber === invoiceNumber)!;
    await postIncomingPayment({
      client, changedBy: ACTOR, customerNumber: partner, companyCode: COMPANY,
      documentDate: '2026-12-30', postingDate: '2026-12-30', clearingDate: '2026-12-30',
      bankGlAccount: '101000', amount: 700, currency: 'USD',
      reference: 'STALE-PAY', requestKey: 'stale-pay-1',
      items: [{ documentNumber: item.documentNumber, fiscalYear: item.fiscalYear, lineNumber: item.lineNumber }],
    });

    const failure = await finalize('2026-12-31', 'STL030').then(
      () => null,
      (error: Error) => error.message,
    );
    expect(failure).toContain('no longer stands open; the proposal is stale');
    expect(await notices('STL030')).toHaveLength(0);

    // A fresh run no longer proposes the settled invoice.
    const fresh = await propose(partner, 'STL031', { runDate: '2026-12-31', dunningDate: '2026-12-31', postedThrough: '2026-12-31' });
    expect(fresh.items.some((i) => i.documentNumber === invoiceNumber)).toBe(false);
  });

  it('reports over-application as a data-integrity fault, not a stale proposal', async () => {
    const partner = await customer('C10040');
    const invoice = await overdueInvoice(partner, 'stale-inv-4', 1200);
    const invoiceNumber = invoice.journalDocumentNumber!;
    const window = { runDate: '2026-12-31', dunningDate: '2026-12-31', postedThrough: '2026-12-20' };

    // A partial application leaves the invoice open, so finalization reaches the recompute.
    const advancePosted = await advance(partner, 'stale-dp-4', 1000, '2026-12-28');
    await applyAdvance(partner, invoiceNumber, advancePosted.journalDocumentNumber, 1000, 'stale-apply-4', '2026-12-28');
    await propose(partner, 'STL040', window);

    // Corrupt the ledger the way only a non-settlement writer could: push the application past the
    // invoice it settles. Every settlement path refuses this at posting time, so this state is an
    // integrity fault that dunning must name as one — not "cancel and re-propose".
    await withTenant(client, (tx) => tx.execute(sql`
      update journal_entry_line set amount_document = 1300
       where client = ${client} and line_text = ${`Settles ${invoiceNumber}`}
         and debit_credit = 'H'
    `));

    const failure = await refusal('2026-12-31', 'STL040');
    expect(failure.message).toContain('data-integrity fault');
    expect(failure.message).toContain(`Document ${invoiceNumber} line`);
    expect(failure.message).toContain('beyond its amount');
    expect(failure.text).not.toContain('proposal is stale');
    expect(failure.remedy).toContain('every settlement path refuses them at posting time');
    expect(await notices('STL040')).toHaveLength(0);
  });

  it('finalizes an unchanged proposal at the recomputed amount and stays duplicate-safe', async () => {
    const partner = await customer('C10050');
    const invoice = await overdueInvoice(partner, 'stale-inv-5', 700);
    const invoiceNumber = invoice.journalDocumentNumber!;
    const window = { runDate: '2027-03-20', dunningDate: '2027-03-20', postedThrough: '2027-03-20' };
    const proposed = await propose(partner, 'STL050', window);
    expect(proposed.items.map((i) => [i.documentNumber, i.overdueAmount]))
      .toEqual([[invoiceNumber, '700.0000']]);

    const done = await finalize('2027-03-20', 'STL050');
    expect(done.status).toBe('COMPLETED');
    expect(done.notices.map((n) => [n.customer, n.currency, n.amount, n.dunningLevel]))
      .toEqual([[partner, 'USD', '700.0000', 1]]);
    expect(done.accounts.find((a) => a.customer === partner)?.status).toBe('COMPLETED');
    expect(await notices('STL050')).toEqual([
      {
        notice_number: done.notices[0].noticeNumber, customer: partner,
        currency: 'USD', amount: '700.0000', dunning_level: 1,
      },
    ]);

    const again = await finalize('2027-03-20', 'STL050');
    expect(again.notices).toHaveLength(1);
    expect(await notices('STL050')).toHaveLength(1);
  });

  it('lets a stale proposal be cancelled and re-proposed at the reduced amount', async () => {
    const partner = await customer('C10060');
    const invoice = await overdueInvoice(partner, 'stale-inv-6', 1200);
    const invoiceNumber = invoice.journalDocumentNumber!;
    const window = { runDate: '2026-12-31', dunningDate: '2026-12-31', postedThrough: '2026-12-20' };
    await propose(partner, 'STL060', window);

    const advancePosted = await advance(partner, 'stale-dp-6', 800, '2026-12-29');
    await applyAdvance(partner, invoiceNumber, advancePosted.journalDocumentNumber, 800, 'stale-apply-6', '2026-12-29');
    await expect(finalize('2026-12-31', 'STL060')).rejects.toThrow('the proposal is stale');

    const cancelled = await cancelDunningRun({ client, changedBy: ACTOR, runDate: '2026-12-31', runId: 'STL060' });
    expect(cancelled.status).toBe('CANCELLED');

    const fresh = await propose(partner, 'STL061', window);
    expect(fresh.items.map((i) => [i.documentNumber, i.currency, i.overdueAmount]))
      .toEqual([[invoiceNumber, 'USD', '400.0000']]);
    expect(fresh.accounts.map((a) => [a.currency, a.totalOverdue, a.status]))
      .toEqual([['USD', '400.0000', 'PROPOSED']]);

    const done = await finalize('2026-12-31', 'STL061');
    expect(done.notices.map((n) => [n.currency, n.amount])).toEqual([['USD', '400.0000']]);
  });
});
