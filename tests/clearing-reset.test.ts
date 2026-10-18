import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { getClearingDocument, resetClearing } from '../src/modules/finance/clearing-reset';
import { postCustomerInvoice } from '../src/modules/finance/customer-invoice';
import { getReceivables, postIncomingPayment } from '../src/modules/finance/incoming-payment';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR071_FBRA_TEST';

/**
 * SCR-071 acceptance: a clearing displays what it cleared, then —
 * on explicit confirmation with a mandatory reason — the stamps
 * lift from every item so the items stand open again, the reset
 * standing on its own retained record. Nothing posts, nothing is
 * edited, and a repeated request returns the standing reset.
 */
describe('SCR-071 reset cleared items (FBRA)', () => {
  let client = '';
  let clearingDocument = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr071-clearing-reset');
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
      await postCustomerInvoice({
        client, changedBy: ACTOR, customerNumber: 'C10000', companyCode: '1000',
        documentDate: '2026-10-16', postingDate: '2026-10-18',
        reference: 'INV-RST-1', currency: 'USD', grossAmount: 550, requestKey: 'rst-inv-1',
        lines: [{ glAccount: '300000', netAmount: 500, taxCode: 'T10' }],
      });
      await postCustomerInvoice({
        client, changedBy: ACTOR, customerNumber: 'C10000', companyCode: '1000',
        documentDate: '2026-10-16', postingDate: '2026-10-18',
        reference: 'INV-RST-2', currency: 'USD', grossAmount: 300, requestKey: 'rst-inv-2',
        lines: [{ glAccount: '300000', netAmount: 300, taxCode: '' }],
      });
      const view = await getReceivables(client, 'C10000', '1000');
      const posted = await postIncomingPayment({
        client, changedBy: ACTOR, customerNumber: 'C10000', companyCode: '1000',
        documentDate: '2026-11-20', postingDate: '2026-11-20', clearingDate: '2026-11-21',
        bankGlAccount: '101000', amount: 850, currency: 'USD',
        reference: 'BANK-RST-001', requestKey: 'rst-pay-1',
        items: view.openItems.map((i) => ({
          documentNumber: i.documentNumber, fiscalYear: i.fiscalYear, lineNumber: i.lineNumber,
        })),
      });
      clearingDocument = posted.journalDocumentNumber;
    }
    return client;
  }

  const sel = () => ({ companyCode: '1000', clearingDocument, fiscalYear: 2026 });

  it('displays the clearing, requires a reason, and refuses a non-clearing document by name', async () => {
    const c = await standingClient();
    const view = await getClearingDocument(c, sel());
    expect(view.clearingDate).toBe('2026-11-21');
    expect(view.alreadyResetBy).toBeNull();
    expect(view.items).toHaveLength(2);
    expect(view.items.map((i) => Number(i.amount)).sort((a, b) => a - b)).toEqual([300, 550]);

    await expect(resetClearing({
      client: c, changedBy: ACTOR, ...sel(), reason: '   ', requestKey: 'rst-reset-1',
    })).rejects.toThrow('reason stands required');

    const invoices = await withTenant(c, (tx) => tx.execute(sql`
      select document_number from journal_entry_line
      where client = ${c} and business_partner = 'C10000' and debit_credit = 'S' limit 1
    `));
    const invoiceDoc = (invoices as unknown as Array<{ document_number: string }>)[0].document_number;
    await expect(getClearingDocument(c, { companyCode: '1000', clearingDocument: invoiceDoc, fiscalYear: 2026 }))
      .rejects.toThrow('cleared no items');
    await expect(getClearingDocument(c, { companyCode: '1000', clearingDocument: '1000/2026/999', fiscalYear: 2026 }))
      .rejects.toThrow('does not stand in company');
  });

  it('resets the clearing so the items stand open again, and replays by request key', async () => {
    const c = await standingClient();
    expect((await getReceivables(c, 'C10000', '1000')).openItems).toHaveLength(0);

    const reset = await resetClearing({
      client: c, changedBy: ACTOR, ...sel(),
      reason: 'Payment allocated to the wrong customer account', requestKey: 'rst-reset-1',
    });
    expect(reset.clearingDocument).toBe(clearingDocument);
    expect(reset.clearingDate).toBe('2026-11-21');
    expect(reset.itemsReset).toBeGreaterThanOrEqual(2);

    const open = await getReceivables(c, 'C10000', '1000');
    expect(open.openItems).toHaveLength(2);
    expect(open.openBalance).toBe(850);

    const stamps = await withTenant(c, (tx) => tx.execute(sql`
      select count(*)::int as n from journal_entry_line
      where client = ${c} and clearing_document = ${clearingDocument}
    `));
    expect((stamps as unknown as Array<{ n: number }>)[0].n).toBe(0);

    const record = await withTenant(c, (tx) => tx.execute(sql`
      select reset_number, clearing_date::text as cd, items_reset, reason from clearing_reset
      where client = ${c} and clearing_document = ${clearingDocument}
    `));
    const rows = record as unknown as Array<{ reset_number: string; cd: string; items_reset: number; reason: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].cd).toBe('2026-11-21');
    expect(rows[0].items_reset).toBe(reset.itemsReset);
    expect(rows[0].reason).toContain('wrong customer account');

    // The clearing document itself stands unchanged.
    const journal = await withTenant(c, (tx) => tx.execute(sql`
      select status from journal_entry
      where client = ${c} and document_number = ${clearingDocument} and fiscal_year = 2026
    `));
    expect((journal as unknown as Array<{ status: string }>)[0].status).toBe('POSTED');

    const after = await getClearingDocument(c, sel());
    expect(after.alreadyResetBy).toBe(reset.resetNumber);

    const replay = await resetClearing({
      client: c, changedBy: ACTOR, ...sel(), reason: 'anything', requestKey: 'rst-reset-1',
    });
    expect(replay.resetNumber).toBe(reset.resetNumber);
    await expect(resetClearing({
      client: c, changedBy: ACTOR, ...sel(), reason: 'again', requestKey: 'rst-reset-2',
    })).rejects.toThrow('already stands reset by');
  });
});
