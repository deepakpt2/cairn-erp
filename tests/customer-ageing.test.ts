import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postCustomerInvoice } from '../src/modules/finance/customer-invoice';
import { getReceivables, postIncomingPayment } from '../src/modules/finance/incoming-payment';
import { getCustomerAgeing } from '../src/modules/finance/customer-ageing';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR070_AGEING_TEST';

/**
 * SCR-070 acceptance: ageing reconstructs standing as of the key
 * date — not yet due apart, overdue bucketed by the due date, an
 * item cleared after the key date still standing at that date.
 */
describe('SCR-070 customer ageing (S_ALR_87012178)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr070-customer-ageing');
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
        reference: 'AGE-1', currency: 'USD', grossAmount: 550, requestKey: 'age-inv-1',
        lines: [{ glAccount: '300000', netAmount: 500, taxCode: 'T10' }],
      });
      await postCustomerInvoice({
        client, changedBy: ACTOR, customerNumber: 'C10000', companyCode: '1000',
        documentDate: '2026-10-16', postingDate: '2026-10-18',
        reference: 'AGE-2', currency: 'USD', grossAmount: 300, requestKey: 'age-inv-2',
        lines: [{ glAccount: '300000', netAmount: 300, taxCode: '' }],
      });
    }
    return client;
  }

  it('ages the standing as of the key date, not yet due apart', async () => {
    const c = await standingClient();
    const early = await getCustomerAgeing(c, { companyCode: '1000', keyDate: '2026-10-18' });
    // Both invoices posted by the 18th, due 2026-11-15: not yet due.
    expect(early.totals).toEqual([850, 0, 0, 0, 0]);
    expect(early.grandTotal).toBe(850);

    const later = await getCustomerAgeing(c, { companyCode: '1000', keyDate: '2026-12-20' });
    // Both invoices 35 days overdue (31–60).
    expect(later.totals).toEqual([0, 0, 850, 0, 0]);
    expect(later.grandTotal).toBe(850);
    const row = later.customers.find((r) => r.customer === 'C10000')!;
    expect(row.total).toBe(850);
  });

  it('reconstructs historical standing around a clearing and judges thresholds', async () => {
    const c = await standingClient();
    const open = await getReceivables(c, 'C10000', '1000');
    const invoice = open.openItems.find((i) => i.signed === 550)!;
    await postIncomingPayment({
      client: c, changedBy: ACTOR, customerNumber: 'C10000', companyCode: '1000',
      documentDate: '2026-12-01', postingDate: '2026-12-01', clearingDate: '2026-12-01',
      bankGlAccount: '101000', amount: 550, currency: 'USD',
      reference: 'AGE-PAY-1', requestKey: 'age-pay-1',
      items: [{ documentNumber: invoice.documentNumber, fiscalYear: invoice.fiscalYear, lineNumber: invoice.lineNumber }],
    });
    // At 2026-11-30 both invoices still stand (one cleared later); at 2026-12-20 the paid one is gone.
    const before = await getCustomerAgeing(c, { companyCode: '1000', keyDate: '2026-11-30' });
    expect(before.grandTotal).toBe(850);
    expect(before.items.some((i) => i.documentNumber === invoice.documentNumber)).toBe(true);
    const after = await getCustomerAgeing(c, { companyCode: '1000', keyDate: '2026-12-20' });
    expect(after.items).toHaveLength(1);
    expect(after.grandTotal).toBe(300);
    expect(after.items[0].amount).toBe('300.0000');

    await expect(getCustomerAgeing(c, {
      companyCode: '1000', keyDate: '2026-12-20', thresholds: [30, 30, 90],
    })).rejects.toThrow('do not increase');
  });
});

/**
 * SCR-120 mirror acceptance: the repaired derivation on the customer
 * side — vendor payable lines never age as customer items, and an
 * AR special G/L item joins only when selected.
 */
describe('SCR-120 customer ageing mirror repair (S_ALR_87012178)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  it('ages only customer reconciliation items and honours the special G/L selection', async () => {
    const tenant = await createTenant('scr120-customer-ageing-repair');
    client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${client}, 'C20000', 'ORGANIZATION', 'Repair Customer', ${ACTOR}),
               (${client}, 'V10000', 'ORGANIZATION', 'Noise Vendor', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into special_gl_config (
          client, company_code, account_type, indicator,
          alternative_reconciliation_account, target_special_gl_indicator, description, created_by
        ) values (${client}, '', 'AR', 'A', '110100', null, 'Repair customer advances', ${ACTOR})
        on conflict do nothing
      `);
      // A customer receivable on the reconciliation account.
      await tx.execute(sql`
        insert into journal_entry (
          client, document_number, fiscal_year, document_type, company_code,
          document_date, posting_date, posting_period, document_currency,
          local_currency, status, created_by
        ) values (${client}, 'MIR-1', 2026, 'SA', '1000',
          '2026-10-05', '2026-10-05', 10, 'USD', 'USD', 'POSTED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into journal_entry_line (
          client, document_number, fiscal_year, line_number, gl_account,
          company_code, debit_credit, amount_local, amount_document, currency, business_partner
        ) values
          (${client}, 'MIR-1', 2026, 1, '110000', '1000', 'S', 800, 800, 'USD', 'C20000'),
          (${client}, 'MIR-1', 2026, 2, '300000', '1000', 'H', 800, 800, 'USD', null)
      `);
      // A vendor payable carrying the vendor partner: never a customer item.
      await tx.execute(sql`
        insert into journal_entry (
          client, document_number, fiscal_year, document_type, company_code,
          document_date, posting_date, posting_period, document_currency,
          local_currency, status, created_by
        ) values (${client}, 'MIR-2', 2026, 'SA', '1000',
          '2026-10-06', '2026-10-06', 10, 'USD', 'USD', 'POSTED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into journal_entry_line (
          client, document_number, fiscal_year, line_number, gl_account,
          company_code, debit_credit, amount_local, amount_document, currency, business_partner
        ) values
          (${client}, 'MIR-2', 2026, 1, '500000', '1000', 'S', 600, 600, 'USD', 'V10000'),
          (${client}, 'MIR-2', 2026, 2, '200000', '1000', 'H', 600, 600, 'USD', 'V10000')
      `);
      // A customer advance standing on the indicator's alternative account
      // (110100 also reconciles normally, but while the account stands
      // configured as an alternative account its lines are special G/L
      // items and leave the plain derivation).
      await tx.execute(sql`
        insert into journal_entry (
          client, document_number, fiscal_year, document_type, company_code,
          document_date, posting_date, posting_period, document_currency,
          local_currency, status, created_by
        ) values (${client}, 'MIR-3', 2026, 'SA', '1000',
          '2026-10-07', '2026-10-07', 10, 'USD', 'USD', 'POSTED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into journal_entry_line (
          client, document_number, fiscal_year, line_number, gl_account,
          company_code, debit_credit, amount_local, amount_document, currency, business_partner
        ) values
          (${client}, 'MIR-3', 2026, 1, '101000', '1000', 'S', 300, 300, 'USD', null),
          (${client}, 'MIR-3', 2026, 2, '110100', '1000', 'H', 300, 300, 'USD', 'C20000')
      `);
    });

    const plain = await getCustomerAgeing(client, { companyCode: '1000', keyDate: '2026-11-20' });
    expect(plain.customers.map((c) => c.customer)).toEqual(['C20000']);
    expect(plain.items.every((i) => i.customer === 'C20000')).toBe(true);
    expect(plain.grandTotal).toBe(800); // the special G/L advance is excluded unselected

    const withSpecial = await getCustomerAgeing(client, {
      companyCode: '1000', keyDate: '2026-11-20', includeSpecialGl: true,
    });
    expect(withSpecial.grandTotal).toBe(500); // 800 receivable − 300 advance, once selected
    const advance = withSpecial.items.find((i) => i.documentNumber === 'MIR-3')!;
    expect(advance.specialGlIndicator).toBe('A');
    expect(advance.customerName).toBe('Repair Customer');
  });
});
