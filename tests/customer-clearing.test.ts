import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postCustomerInvoice } from '../src/modules/finance/customer-invoice';
import { clearCustomerItems, getCustomerClearing } from '../src/modules/finance/customer-clearing';
import { postJournalEntry } from '../src/platform/posting';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR073_F32_TEST';

/**
 * SCR-073 acceptance: a customer's invoice and payment clear against
 * each other only at exactly zero, under three distinct dates, a
 * retried submission returns the standing clearing, and the cleared
 * history is preserved.
 */
describe('SCR-073 customer open-item clearing (F-32)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr073-customer-clearing');
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
        reference: 'CLR-INV-1', currency: 'USD', grossAmount: 550, requestKey: 'cc-inv-1',
        lines: [{ glAccount: '300000', netAmount: 500, taxCode: 'T10' }],
      });

      // A manual receipt standing as the customer's credit item, and a
      // foreign-currency item that must never join a USD clearing.
      await withTenant(client, async (tx) => {
        await postJournalEntry(tx, {
          client, companyCode: '1000', documentType: 'DZ',
          documentDate: '2026-10-20', postingDate: '2026-10-20',
          fiscalYear: 2026, postingPeriod: 10,
          currency: 'USD', localCurrency: 'USD', reference: 'MANUAL-RECEIPT',
          lines: [
            { glAccount: '101000', debitCredit: 'S', amount: '550.00' },
            { glAccount: '110000', debitCredit: 'H', amount: '550.00', businessPartner: 'C10000' },
          ],
          postedBy: ACTOR, transactionCode: 'FIN.AR.CLEAR',
        });
        await postJournalEntry(tx, {
          client, companyCode: '1000', documentType: 'DR',
          documentDate: '2026-10-21', postingDate: '2026-10-21',
          fiscalYear: 2026, postingPeriod: 10,
          currency: 'EUR', localCurrency: 'USD', exchangeRate: '1.2000', reference: 'EUR-ITEM',
          lines: [
            { glAccount: '110000', debitCredit: 'S', amount: '100.00', businessPartner: 'C10000' },
            { glAccount: '300000', debitCredit: 'H', amount: '100.00' },
          ],
          postedBy: ACTOR, transactionCode: 'FIN.AR.CLEAR',
        });
      });
    }
    return client;
  }

  const dates = { clearingDate: '2026-11-21', postingDate: '2026-11-20', documentDate: '2026-11-19' };

  it('lists the open items and refuses by name', async () => {
    const c = await standingClient();
    const view = await getCustomerClearing(c, 'C10000', '1000');
    expect(view.openItems).toHaveLength(3);
    expect(view.openBalance).toBe(120);

    await expect(getCustomerClearing(c, 'C99999', '1000')).rejects.toThrow('does not stand extended');

    const usd = view.openItems.filter((i) => i.currency === 'USD');
    const eur = view.openItems.find((i) => i.currency === 'EUR')!;
    const refs = (list: typeof view.openItems) => list.map((i) => ({
      documentNumber: i.documentNumber, fiscalYear: i.fiscalYear, lineNumber: i.lineNumber,
    }));

    await expect(clearCustomerItems({
      client: c, changedBy: ACTOR, customer: 'C10000', companyCode: '1000', ...dates,
      confirmed: false, requestKey: 'cc-clear-1', items: refs(usd),
    })).rejects.toThrow('stands unconfirmed');
    await expect(clearCustomerItems({
      client: c, changedBy: ACTOR, customer: 'C10000', companyCode: '1000', ...dates,
      confirmed: true, requestKey: 'cc-clear-1', items: refs([usd[0]]),
    })).rejects.toThrow('do not balance: the difference stands at 550.00 USD');
    await expect(clearCustomerItems({
      client: c, changedBy: ACTOR, customer: 'C10000', companyCode: '1000', ...dates,
      confirmed: true, requestKey: 'cc-clear-1', items: refs([usd[0], eur]),
    })).rejects.toThrow('stand in USD and EUR');
  });

  it('clears at zero under three distinct dates, replays, and preserves the history', async () => {
    const c = await standingClient();
    const before = await getCustomerClearing(c, 'C10000', '1000');
    const usd = before.openItems.filter((i) => i.currency === 'USD');
    const refs = usd.map((i) => ({
      documentNumber: i.documentNumber, fiscalYear: i.fiscalYear, lineNumber: i.lineNumber,
    }));

    const result = await clearCustomerItems({
      client: c, changedBy: ACTOR, customer: 'C10000', companyCode: '1000', ...dates,
      confirmed: true, requestKey: 'cc-clear-1', items: refs,
    });
    expect(result.openItems).toHaveLength(1);
    expect(result.openItems[0].currency).toBe('EUR');
    // Two originals plus the clearing journal's own two lines.
    expect(result.clearedItems).toHaveLength(4);
    expect(result.clearedItems.every((i) => i.clearingDocument === result.clearingDocumentNumber)).toBe(true);
    expect(result.clearedItems.every((i) => i.clearingDate === '2026-11-21')).toBe(true);

    const journal = await withTenant(c, (tx) => tx.execute(sql`
      select document_date::text as dd, posting_date::text as pd, posting_period, document_type from journal_entry
      where client = ${c} and document_number = ${result.clearingDocumentNumber}
    `));
    const row = (journal as unknown as Array<{ dd: string; pd: string; posting_period: number; document_type: string }>)[0];
    expect(row.document_type).toBe('DZ');
    expect(row.dd).toBe('2026-11-19');
    expect(row.pd).toBe('2026-11-20');
    expect(row.posting_period).toBe(11);

    const replay = await clearCustomerItems({
      client: c, changedBy: ACTOR, customer: 'C10000', companyCode: '1000', ...dates,
      confirmed: true, requestKey: 'cc-clear-1', items: refs,
    });
    expect(replay.clearingDocumentNumber).toBe(result.clearingDocumentNumber);

    await expect(clearCustomerItems({
      client: c, changedBy: ACTOR, customer: 'C10000', companyCode: '1000', ...dates,
      confirmed: true, requestKey: 'cc-clear-2', items: refs,
    })).rejects.toThrow('already stands cleared');
  });
});
