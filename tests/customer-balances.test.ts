import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { derivePosition, getCompanyCode } from '../src/platform/periods';
import { postJournalEntry } from '../src/platform/posting';
import { postCustomerInvoice } from '../src/modules/finance/customer-invoice';
import { getCustomerBalances } from '../src/modules/finance/customer-balances';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR069_FD10N_TEST';

/**
 * SCR-069 acceptance: customer balances derive from the posted
 * ledger — turnover per period, closing chained, opening carried
 * from earlier years, drill-down to the items, currency judged.
 */
describe('SCR-069 customer balances (FD10N)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr069-customer-balances');
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
        reference: 'BAL-1', currency: 'USD', grossAmount: 550, requestKey: 'cb-inv-1',
        lines: [{ glAccount: '300000', netAmount: 500, taxCode: 'T10' }],
      });
      await postCustomerInvoice({
        client, changedBy: ACTOR, customerNumber: 'C10000', companyCode: '1000',
        documentDate: '2026-10-16', postingDate: '2026-10-18',
        reference: 'BAL-2', currency: 'USD', grossAmount: 300, requestKey: 'cb-inv-2',
        lines: [{ glAccount: '300000', netAmount: 300, taxCode: '' }],
      });

      // A manual receipt standing as the customer's credit item.
      await withTenant(client, async (tx) => {
        const company = await getCompanyCode(tx, client, '1000');
        const position = await derivePosition(tx, client, company!.fiscalYearVariant!, '2026-10-20');
        await postJournalEntry(tx, {
          client, companyCode: '1000', documentType: 'DZ',
          documentDate: '2026-10-20', postingDate: '2026-10-20',
          fiscalYear: position.fiscalYear, postingPeriod: position.period,
          currency: 'USD', localCurrency: company!.currency,
          reference: 'MANUAL-RECEIPT',
          lines: [
            { glAccount: '101000', debitCredit: 'S', amount: '550.00' },
            { glAccount: '110000', debitCredit: 'H', amount: '550.00', businessPartner: 'C10000' },
          ],
          postedBy: ACTOR, transactionCode: 'FIN.AR.BALANCE',
        });
      });
    }
    return client;
  }

  it('derives turnover and closing per period and drills to the items', async () => {
    const c = await standingClient();
    const view = await getCustomerBalances(c, { customer: 'C10000', companyCode: '1000', fiscalYear: 2026 });
    const october = view.periods.find((p) => p.period === 10)!;
    expect(october.debitTurnover).toBe(850);
    expect(october.creditTurnover).toBe(550);
    expect(october.closing).toBe(300);
    expect(october.itemCount).toBe(3);
    expect(view.yearClosing).toBe(300);
    expect(view.periods.find((p) => p.period === 9)!.closing).toBe(0);

    const drill = await getCustomerBalances(c, {
      customer: 'C10000', companyCode: '1000', fiscalYear: 2026, selectedPeriod: 10,
    });
    expect(drill.items).toHaveLength(3);
    expect(drill.items.filter((i) => i.debitCredit === 'S')).toHaveLength(2);
  });

  it('carries the opening from earlier years and judges the currency', async () => {
    const c = await standingClient();
    const next = await getCustomerBalances(c, { customer: 'C10000', companyCode: '1000', fiscalYear: 2027 });
    expect(next.periods[0].opening).toBe(300);
    expect(next.yearClosing).toBe(300);

    const usd = await getCustomerBalances(c, {
      customer: 'C10000', companyCode: '1000', fiscalYear: 2026, displayCurrency: 'USD',
    });
    expect(usd.currency).toBe('USD');
    expect(usd.periods.find((p) => p.period === 10)!.closing).toBe(300);
    await expect(getCustomerBalances(c, {
      customer: 'C10000', companyCode: '1000', fiscalYear: 2026, displayCurrency: 'EUR',
    })).rejects.toThrow('no conversion is performed');
    await expect(getCustomerBalances(c, { customer: 'C99999', companyCode: '1000', fiscalYear: 2026 }))
      .rejects.toThrow('does not stand extended');
  });
});
