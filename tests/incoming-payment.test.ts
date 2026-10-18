import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postCustomerInvoice } from '../src/modules/finance/customer-invoice';
import { getReceivables, postIncomingPayment } from '../src/modules/finance/incoming-payment';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR068_F28_TEST';

/**
 * SCR-068 acceptance: a receipt allocates in full against the
 * customer's open receivables, clears them in place under the
 * clearing date, and refuses any difference by name.
 */
describe('SCR-068 incoming payment (F-28)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr068-incoming-payment');
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
          insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
          values (${client}, 'KW', 'T10', 'Output tax 10 percent', 'VAT', 10, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
          values (${client}, 'CA01', 'TAX', '', '', '240000', ${ACTOR}) on conflict do nothing
        `);
      });
    }
    return client;
  }

  const invoice = (reference: string, key: string, gross: number, net: number) => ({
    client, changedBy: ACTOR,
    customerNumber: 'C10000', companyCode: '1000',
    documentDate: '2026-10-16', postingDate: '2026-10-18',
    reference, currency: 'USD', grossAmount: gross, requestKey: key,
    lines: [{ glAccount: '300000', netAmount: net, taxCode: net === 500 ? 'T10' : '' }],
  });

  async function twoInvoices() {
    const c = await standingClient();
    await postCustomerInvoice(invoice('INV-PAY-1', 'pay-inv-1', 550, 500));
    await postCustomerInvoice(invoice('INV-PAY-2', 'pay-inv-2', 300, 300));
    return c;
  }

  const payment = (patch: Partial<Parameters<typeof postIncomingPayment>[0]> = {}) => ({
    client, changedBy: ACTOR,
    customerNumber: 'C10000', companyCode: '1000',
    documentDate: '2026-11-20', postingDate: '2026-11-20', clearingDate: '2026-11-21',
    bankGlAccount: '101000', amount: 850, currency: 'USD',
    reference: 'BANK-REF-001', requestKey: 'pay-1',
    items: [] as Array<{ documentNumber: string; fiscalYear: number; lineNumber: number }>,
    ...patch,
  });

  it('lists the receivables with due dates and refuses a short allocation', async () => {
    const c = await twoInvoices();
    const view = await getReceivables(c, 'C10000', '1000');
    expect(view.openItems).toHaveLength(2);
    expect(view.openBalance).toBe(850);
    expect(view.openItems[0].dueDate).toBe('2026-11-15');
    const first = view.openItems[0];
    await expect(postIncomingPayment(payment({
      items: [{ documentNumber: first.documentNumber, fiscalYear: first.fiscalYear, lineNumber: first.lineNumber }],
    }))).rejects.toThrow('leaves an unassigned difference of 300.00 USD beyond the tolerance');
  });

  it('posts the payment, clears in place under the clearing date, and replays by request key', async () => {
    const c = await twoInvoices();
    const view = await getReceivables(c, 'C10000', '1000');
    const refs = view.openItems.map((i) => ({
      documentNumber: i.documentNumber, fiscalYear: i.fiscalYear, lineNumber: i.lineNumber,
    }));
    const posted = await postIncomingPayment(payment({ items: refs }));
    expect(posted.itemsCleared).toBe(2);
    expect(posted.clearingDate).toBe('2026-11-21');

    const journal = await withTenant(c, (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_local from journal_entry_line
      where client = ${c} and document_number = ${posted.journalDocumentNumber}
    `));
    const lines = journal as unknown as Array<Record<string, string>>;
    expect(lines.find((l) => l.gl_account === '101000')).toMatchObject({ debit_credit: 'S', amount_local: '850.0000' });
    expect(lines.filter((l) => l.gl_account === '110000')).toHaveLength(2);

    const cleared = await withTenant(c, (tx) => tx.execute(sql`
      select clearing_date::text as cd from journal_entry_line
      where client = ${c} and business_partner = 'C10000' and clearing_document = ${posted.journalDocumentNumber}
    `));
    const clearedRows = cleared as unknown as Array<{ cd: string }>;
    expect(clearedRows.length).toBeGreaterThanOrEqual(2);
    expect(clearedRows.every((r) => r.cd === '2026-11-21')).toBe(true);
    expect((await getReceivables(c, 'C10000', '1000')).openItems).toHaveLength(0);

    const replay = await postIncomingPayment(payment({ items: refs }));
    expect(replay.journalDocumentNumber).toBe(posted.journalDocumentNumber);
    await expect(postIncomingPayment(payment({ requestKey: 'pay-2', items: refs })))
      .rejects.toThrow('already stands cleared');
  });
});
