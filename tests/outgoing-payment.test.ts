import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postVendorInvoice } from '../src/modules/finance/vendor-invoice';
import { postVendorCreditMemo } from '../src/modules/finance/vendor-credit-memo';
import { getPayables, postOutgoingPayment } from '../src/modules/finance/outgoing-payment';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR078_F53_TEST';

/**
 * SCR-078 acceptance: a payment allocates in full against the
 * vendor's open payables, credit items netting against it, clears
 * them in place under the clearing date, and refuses any
 * difference by name.
 */
describe('SCR-078 outgoing payment (F-53)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr078-outgoing-payment');
      client = tenant.client;
      await defineTestRanges(tenant, { fiscalYear: 2026 });
      await withTenant(client, async (tx) => {
        await defineRange(tx, { client, objectCode: 'VENDINV', subObject: '*', prefix: 'VI', numberLength: 7, createdBy: ACTOR });
        await tx.execute(sql`
          insert into business_partner (client, partner_number, category, name, created_by)
          values (${client}, 'V10000', 'ORGANIZATION', 'Test Vendor', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into bp_role (client, partner_number, role_code, created_by)
          values (${client}, 'V10000', 'SUPPLIER', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
          values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into supplier_company_code (
            client, partner_number, role_code, company_code, chart_of_accounts,
            reconciliation_account, payment_terms_code, created_by
          )
          values (${client}, 'V10000', 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
          values (${client}, 'KW', 'T10', 'Input tax 10 percent', 'VAT', 10, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
          values (${client}, 'CA01', 'TAX', '', '', '240000', ${ACTOR}) on conflict do nothing
        `);
      });

      const invoice = await postVendorInvoice({
        client, changedBy: ACTOR,
        vendorNumber: 'V10000', companyCode: '1000',
        documentDate: '2026-10-16', postingDate: '2026-10-18',
        reference: 'INV-2026-999', currency: 'USD', grossAmount: 550,
        requestKey: 'op-inv-1',
        lines: [{ glAccount: '400000', netAmount: 500, taxCode: 'T10' }],
      });
      await postVendorCreditMemo({
        client, changedBy: ACTOR,
        vendorNumber: 'V10000', companyCode: '1000',
        documentDate: '2026-10-20', postingDate: '2026-10-20',
        reference: 'CM-2026-001', currency: 'USD', grossAmount: 110,
        creditOf: invoice.invoiceNumber, requestKey: 'op-cm-1',
        lines: [{ glAccount: '400000', netAmount: 100, taxCode: 'T10' }],
      });
    }
    return client;
  }

  const payment = (patch: Partial<Parameters<typeof postOutgoingPayment>[0]> = {}) => ({
    client, changedBy: ACTOR,
    vendorNumber: 'V10000', companyCode: '1000',
    documentDate: '2026-11-20', postingDate: '2026-11-20', clearingDate: '2026-11-21',
    bankGlAccount: '101000', amount: 440, currency: 'USD',
    reference: 'CHQ-998877', requestKey: 'op-pay-1',
    items: [] as Array<{ documentNumber: string; fiscalYear: number; lineNumber: number }>,
    ...patch,
  });

  const refs = (view: Awaited<ReturnType<typeof getPayables>>) => view.openItems.map((i) => ({
    documentNumber: i.documentNumber, fiscalYear: i.fiscalYear, lineNumber: i.lineNumber,
  }));

  it('lists the payables net of the credit item and refuses a gross allocation', async () => {
    const c = await standingClient();
    const view = await getPayables(c, 'V10000', '1000');
    expect(view.openItems).toHaveLength(2);
    expect(view.openBalance).toBe(440);
    expect(view.openItems.map((i) => i.signed).sort((a, b) => a - b)).toEqual([-110, 550]);
    const payableOnly = view.openItems.filter((i) => i.signed > 0);
    await expect(postOutgoingPayment(payment({
      items: refs({ ...view, openItems: payableOnly }),
    }))).rejects.toThrow('leaves an unassigned difference of -110.00 USD beyond the tolerance');
    await expect(postOutgoingPayment(payment({ vendorNumber: 'V99999', items: refs(view) })))
      .rejects.toThrow('does not stand extended');
  });

  it('posts the netting payment, clears in place, and replays by request key', async () => {
    const c = await standingClient();
    const view = await getPayables(c, 'V10000', '1000');
    const items = refs(view);
    const posted = await postOutgoingPayment(payment({ items, valueDate: '2026-11-22' }));
    expect(posted.itemsCleared).toBe(2);
    expect(posted.clearingDate).toBe('2026-11-21');

    const journal = await withTenant(c, (tx) => tx.execute(sql`
      select document_type from journal_entry
      where client = ${c} and document_number = ${posted.journalDocumentNumber}
    `));
    expect((journal as unknown as Array<{ document_type: string }>)[0].document_type).toBe('KZ');

    const lines = await withTenant(c, (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_local::text as amount from journal_entry_line
      where client = ${c} and document_number = ${posted.journalDocumentNumber}
      order by line_number
    `));
    const rows = lines as unknown as Array<Record<string, string>>;
    expect(rows.find((l) => l.gl_account === '101000'))
      .toMatchObject({ debit_credit: 'H', amount: '440.0000' });
    expect(rows.filter((l) => l.gl_account === '200000').map((l) => l.debit_credit).sort())
      .toEqual(['H', 'S']);

    const record = await withTenant(c, (tx) => tx.execute(sql`
      select reference, value_date::text as vd, items_cleared from outgoing_payment
      where client = ${c} and payment_number = ${posted.paymentNumber}
    `));
    expect((record as unknown as Array<Record<string, unknown>>)[0])
      .toMatchObject({ reference: 'CHQ-998877', vd: '2026-11-22', items_cleared: 2 });

    const cleared = await withTenant(c, (tx) => tx.execute(sql`
      select clearing_date::text as cd from journal_entry_line
      where client = ${c} and business_partner = 'V10000' and clearing_document = ${posted.journalDocumentNumber}
    `));
    const clearedRows = cleared as unknown as Array<{ cd: string }>;
    expect(clearedRows.length).toBeGreaterThanOrEqual(2);
    expect(clearedRows.every((r) => r.cd === '2026-11-21')).toBe(true);
    expect((await getPayables(c, 'V10000', '1000')).openItems).toHaveLength(0);

    const replay = await postOutgoingPayment(payment({ items }));
    expect(replay.journalDocumentNumber).toBe(posted.journalDocumentNumber);
    await expect(postOutgoingPayment(payment({ requestKey: 'op-pay-2', items })))
      .rejects.toThrow('already stands cleared');
  });
});
