import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import {
  cancelCustomerInvoice, getCustomerInvoice, postCustomerInvoice,
} from '../src/modules/finance/customer-invoice';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR067_FB70_TEST';

/**
 * SCR-067 acceptance: a direct customer invoice posts with tax,
 * stands as the customer's receivable, refuses an unreconciled
 * gross and a duplicate reference, and cancels by mirror.
 */
describe('SCR-067 customer invoice (FB70)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr067-customer-invoice');
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

  const base = () => ({
    client, changedBy: ACTOR,
    customerNumber: 'C10000', companyCode: '1000',
    documentDate: '2026-10-16', postingDate: '2026-10-18',
    reference: 'INV-2026-001', currency: 'USD',
    grossAmount: 550, requestKey: 'ci-1',
    lines: [{ glAccount: '300000', netAmount: 500, taxCode: 'T10' }],
  });

  it('posts with tax, the receivable standing as an open item with its due date', async () => {
    const c = await standingClient();
    const view = await postCustomerInvoice(base());
    expect(view.status).toBe('POSTED');
    expect(Number(view.taxAmount)).toBe(50);
    expect(view.dueDate).toBe('2026-11-15');
    expect(view.lines).toHaveLength(1);

    const journal = await withTenant(c, (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_local, business_partner from journal_entry_line
      where client = ${c} and document_number = ${view.journalDocumentNumber}
      order by line_number
    `));
    const lines = journal as unknown as Array<Record<string, string>>;
    expect(lines.find((l) => l.gl_account === '110000')).toMatchObject({
      debit_credit: 'S', amount_local: '550.0000', business_partner: 'C10000',
    });
    expect(lines.find((l) => l.gl_account === '300000')).toMatchObject({ debit_credit: 'H', amount_local: '500.0000' });
    expect(lines.find((l) => l.gl_account === '240000')).toMatchObject({ debit_credit: 'H', amount_local: '50.0000' });

    // A retry with the same request key returns the standing document.
    const replay = await postCustomerInvoice(base());
    expect(replay.invoiceNumber).toBe(view.invoiceNumber);
  });

  it('refuses an unreconciled gross, a duplicate reference and an unknown customer', async () => {
    const c = await standingClient();
    await expect(postCustomerInvoice({ ...base(), requestKey: 'ci-2', reference: 'INV-2026-002', grossAmount: 500 }))
      .rejects.toThrow('does not reconcile');
    await expect(postCustomerInvoice({ ...base(), requestKey: 'ci-3' }))
      .rejects.toThrow('already stands posted');
    await expect(postCustomerInvoice({ ...base(), requestKey: 'ci-4', customerNumber: 'C99999', reference: 'INV-2026-003' }))
      .rejects.toThrow('does not stand extended');
  });

  it('cancels by linked mirror and restores nothing twice', async () => {
    const c = await standingClient();
    const original = await getCustomerInvoice(c, (await postCustomerInvoice({
      ...base(), requestKey: 'ci-5', reference: 'INV-2026-005',
    })).invoiceNumber);
    const cancellation = await cancelCustomerInvoice({
      client: c, changedBy: ACTOR, invoiceNumber: original!.invoiceNumber,
      postingDate: '2026-10-20', requestKey: 'ci-5-cancel',
    });
    expect(cancellation.cancellationOf).toBe(original!.invoiceNumber);
    expect((await getCustomerInvoice(c, original!.invoiceNumber))?.status).toBe('CANCELLED');
    await expect(cancelCustomerInvoice({
      client: c, changedBy: ACTOR, invoiceNumber: original!.invoiceNumber,
      postingDate: '2026-10-21', requestKey: 'ci-5-cancel-2',
    })).rejects.toThrow('already been cancelled');
  });
});
