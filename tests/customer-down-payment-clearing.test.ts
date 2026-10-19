import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postCustomerInvoice } from '../src/modules/finance/customer-invoice';
import { postCustomerDownPayment } from '../src/modules/finance/customer-down-payment';
import {
  clearCustomerDownPayments, getCustomerDownPaymentClearing,
  type ClearingAllocation, type ClearingItemRef,
} from '../src/modules/finance/customer-down-payment-clearing';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR084_F39_TEST';

/**
 * SCR-084 acceptance: clearing a customer down payment is a real
 * DZ transfer — the alternative account debits, the ordinary
 * receivable account credits per pairwise allocation, mapping
 * rows remember what settled what, and remainders stand open.
 */
describe('SCR-084 customer down payment clearing (F-39)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr084-customer-dp-clearing');
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
            client, partner_number, role_code, company_code, chart_of_accounts,
            reconciliation_account, payment_terms_code, created_by
          )
          values (${client}, 'C10000', 'CUSTOMER', '1000', 'CA01', '110000', 'NET30', ${ACTOR})
          on conflict do nothing
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
      const invoice = (amount: number, key: string) => postCustomerInvoice({
        client, changedBy: ACTOR, customerNumber: 'C10000', companyCode: '1000',
        documentDate: '2026-10-16', postingDate: '2026-10-18',
        reference: key, currency: 'USD', grossAmount: amount, requestKey: key,
        lines: [{ glAccount: '300000', netAmount: amount }],
      });
      await invoice(550, 'cdc-inv-1');
      await invoice(1200, 'cdc-inv-2');
      await invoice(450, 'cdc-inv-3');
      const receipt = (amount: number, key: string) => postCustomerDownPayment({
        client, changedBy: ACTOR, customerNumber: 'C10000', companyCode: '1000',
        documentDate: '2026-10-20', postingDate: '2026-10-20',
        bankGlAccount: '101000', amount, currency: 'USD', specialGlIndicator: 'A',
        requestKey: key,
      });
      await receipt(8000, 'cdc-dp-1');
      await receipt(500, 'cdc-dp-2');
    }
    return client;
  }

  const ref = (i: ClearingItemRef): ClearingItemRef => ({
    documentNumber: i.documentNumber, fiscalYear: i.fiscalYear, lineNumber: i.lineNumber,
  });

  const clearing = (allocations: ClearingAllocation[], patch: Record<string, unknown> = {}) => ({
    client, changedBy: ACTOR,
    customerNumber: 'C10000', companyCode: '1000', indicator: 'A',
    documentDate: '2026-10-21', postingDate: '2026-10-21', clearingDate: '2026-10-21',
    currency: 'USD', reference: 'CLR-2026-002',
    requestKey: `cdc-clr-${Math.random()}`,
    allocations,
    ...patch,
  });

  async function view() {
    return getCustomerDownPaymentClearing(client, 'C10000', '1000', 'A');
  }

  it('refuses unconfigured indicators, strangers and impossible allocations', async () => {
    await standingClient();
    await expect(getCustomerDownPaymentClearing(client, 'C10000', '1000', 'Z'))
      .rejects.toThrow('Special G/L indicator Z is not configured for customers');
    await expect(getCustomerDownPaymentClearing(client, 'C99999', '1000', 'A'))
      .rejects.toThrow('does not stand extended');
    await expect(clearCustomerDownPayments(clearing([])))
      .rejects.toThrow('Allocate at least one down payment to an invoice');

    const v = await view();
    const dp = v.downPayments.find((i) => i.amount === 8000)!;
    const inv = v.invoices.find((i) => i.amount === 550)!;
    await expect(clearCustomerDownPayments(clearing([
      { downPayment: ref(dp), invoice: ref(inv), amount: 9000 },
    ]))).rejects.toThrow('exceeds its remaining');
    // An invoice offered as the advance is refused by role.
    await expect(clearCustomerDownPayments(clearing([
      { downPayment: ref(inv), invoice: ref(inv), amount: 10 },
    ]))).rejects.toThrow('is not an open down payment');
    // One clearing settles one currency.
    await expect(clearCustomerDownPayments(clearing([
      { downPayment: ref(dp), invoice: ref(inv), amount: 10 },
    ], { currency: 'EUR' }))).rejects.toThrow('one clearing settles one currency');
  });

  it('transfers pairwise allocations by DZ and remembers them on the mapping rows', async () => {
    const c = await standingClient();
    const v = await view();
    expect(v.alternativeAccount).toBe('230000');
    expect(v.reconciliationAccount).toBe('110000');
    const dp1 = v.downPayments.find((i) => i.amount === 8000)!;
    const inv1 = v.invoices.find((i) => i.amount === 550)!;
    const inv2 = v.invoices.find((i) => i.amount === 1200)!;

    const posted = await clearCustomerDownPayments(clearing([
      { downPayment: ref(dp1), invoice: ref(inv1), amount: 550 },
      { downPayment: ref(dp1), invoice: ref(inv2), amount: 1000 },
    ], { requestKey: 'cdc-clr-1' }));
    expect(posted.itemsCleared).toBe(1);

    const header = await withTenant(c, (tx) => tx.execute(sql`
      select document_type from journal_entry
      where client = ${c} and document_number = ${posted.journalDocumentNumber}
    `));
    expect((header as unknown as Array<{ document_type: string }>)[0].document_type).toBe('DZ');

    const lines = await withTenant(c, (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_local::text as amount, line_text from journal_entry_line
      where client = ${c} and document_number = ${posted.journalDocumentNumber} order by line_number
    `));
    const rows = lines as unknown as Array<Record<string, string>>;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ gl_account: '230000', debit_credit: 'S', amount: '1550.0000', line_text: `Applied from ${dp1.documentNumber}` });
    expect(rows[1]).toMatchObject({ gl_account: '110000', debit_credit: 'H', amount: '550.0000', line_text: `Settles ${inv1.documentNumber}` });
    expect(rows[2]).toMatchObject({ gl_account: '110000', debit_credit: 'H', amount: '1000.0000', line_text: `Settles ${inv2.documentNumber}` });

    const record = await withTenant(c, (tx) => tx.execute(sql`
      select total_applied::text as total, alternative_reconciliation_account as alt
      from customer_down_payment_clearing
      where client = ${c} and clearing_number = ${posted.clearingNumber}
    `));
    expect((record as unknown as Array<Record<string, string>>)[0])
      .toMatchObject({ total: '1550.0000', alt: '230000' });

    const mapping = await withTenant(c, (tx) => tx.execute(sql`
      select down_payment_document_number as dp, invoice_document_number as inv,
             allocated_amount::text as amount, allocation_currency as cur
      from customer_down_payment_clearing_item
      where client = ${c} and clearing_number = ${posted.clearingNumber} order by mapping_number
    `));
    const pairs = mapping as unknown as Array<Record<string, string>>;
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toMatchObject({ dp: dp1.documentNumber, inv: inv1.documentNumber, amount: '550.0000', cur: 'USD' });
    expect(pairs[1]).toMatchObject({ dp: dp1.documentNumber, inv: inv2.documentNumber, amount: '1000.0000', cur: 'USD' });

    // The settled invoice is stamped; the partly settled one is not,
    // and every remainder derives from the journal lines.
    const stamps = await withTenant(c, (tx) => tx.execute(sql`
      select document_number, clearing_document from journal_entry_line
      where client = ${c} and document_number in (${inv1.documentNumber}, ${inv2.documentNumber})
        and gl_account = '110000' and debit_credit = 'S' order by document_number
    `));
    const stampRows = stamps as unknown as Array<{ document_number: string; clearing_document: string | null }>;
    expect(stampRows.find((r) => r.document_number === inv1.documentNumber)?.clearing_document)
      .toBe(posted.journalDocumentNumber);
    expect(stampRows.find((r) => r.document_number === inv2.documentNumber)?.clearing_document).toBeNull();

    const after = await view();
    expect(after.invoices.map((i) => [i.amount, i.remaining])).toEqual([[1200, 200], [450, 450]]);
    expect(after.downPayments.find((i) => i.amount === 8000)?.remaining).toBe(6450);
    expect(after.downPayments.find((i) => i.amount === 500)?.remaining).toBe(500);

    const replay = await clearCustomerDownPayments(clearing([
      { downPayment: ref(dp1), invoice: ref(inv1), amount: 550 },
      { downPayment: ref(dp1), invoice: ref(inv2), amount: 1000 },
    ], { requestKey: 'cdc-clr-1' }));
    expect(replay.clearingNumber).toBe(posted.clearingNumber);
  });

  it('a later clearing consumes an advance in full and stamps it', async () => {
    const c = await standingClient();
    const v = await view();
    const dp2 = v.downPayments.find((i) => i.amount === 500)!;
    const inv3 = v.invoices.find((i) => i.amount === 450)!;
    const inv2 = v.invoices.find((i) => i.amount === 1200)!;
    const posted = await clearCustomerDownPayments(clearing([
      { downPayment: ref(dp2), invoice: ref(inv3), amount: 450 },
      { downPayment: ref(dp2), invoice: ref(inv2), amount: 50 },
    ], { requestKey: 'cdc-clr-2' }));
    expect(posted.itemsCleared).toBe(2);

    const stamp = await withTenant(c, (tx) => tx.execute(sql`
      select clearing_document from journal_entry_line
      where client = ${c} and document_number = ${dp2.documentNumber}
        and gl_account = '230000' and debit_credit = 'H'
    `));
    expect((stamp as unknown as Array<{ clearing_document: string | null }>)[0].clearing_document)
      .toBe(posted.journalDocumentNumber);

    const after = await view();
    expect(after.downPayments.map((i) => i.amount)).toEqual([8000]);
    expect(after.invoices.map((i) => i.remaining)).toEqual([150]);
  });
});
