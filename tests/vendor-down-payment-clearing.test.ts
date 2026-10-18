import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postVendorInvoice } from '../src/modules/finance/vendor-invoice';
import { postVendorDownPayment } from '../src/modules/finance/vendor-down-payment';
import {
  clearDownPayments, getDownPaymentClearing,
} from '../src/modules/finance/vendor-down-payment-clearing';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR082_F54_TEST';

/**
 * SCR-082 acceptance: a down payment clears against vendor
 * invoices by transfer posting — full application stamps the
 * items, partial application leaves the netting pair standing,
 * and the two applied totals must always agree.
 */
describe('SCR-082 vendor down payment clearing (F-54)', () => {
  let client = '';
  let dpDoc = '';
  const invDocs: string[] = [];

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr082-dp-clearing');
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
          insert into special_gl_config (
            client, company_code, account_type, indicator,
            alternative_reconciliation_account, description, created_by
          )
          values (${client}, '', 'AP', 'A', '230000', 'Down payments', ${ACTOR})
          on conflict do nothing
        `);
      });
      for (const [i, gross] of [550, 300, 9150].entries()) {
        const inv = await postVendorInvoice({
          client, changedBy: ACTOR, vendorNumber: 'V10000', companyCode: '1000',
          documentDate: '2026-10-16', postingDate: '2026-10-18',
          reference: `INV-CLR-${i + 1}`, currency: 'USD', grossAmount: gross,
          requestKey: `clr-inv-${i + 1}`,
          lines: [{ glAccount: '400000', netAmount: gross }],
        });
        invDocs.push(inv.journalDocumentNumber!);
      }
      const dp = await postVendorDownPayment({
        client, changedBy: ACTOR, vendorNumber: 'V10000', companyCode: '1000',
        documentDate: '2026-10-19', postingDate: '2026-10-19',
        bankGlAccount: '101000', amount: 10000, currency: 'USD',
        specialGlIndicator: 'A', requestKey: 'clr-dp-1',
      });
      dpDoc = dp.journalDocumentNumber;
    }
    return client;
  }

  const clearing = (patch: Partial<Parameters<typeof clearDownPayments>[0]> = {}) => ({
    client, changedBy: ACTOR,
    vendorNumber: 'V10000', companyCode: '1000', indicator: 'A',
    documentDate: '2026-10-25', postingDate: '2026-10-25', clearingDate: '2026-10-26',
    currency: 'USD', requestKey: `clr-${Math.random()}`,
    downPayments: [] as Parameters<typeof clearDownPayments>[0]['downPayments'],
    invoices: [] as Parameters<typeof clearDownPayments>[0]['invoices'],
    ...patch,
  });

  async function view() {
    return getDownPaymentClearing(client, 'V10000', '1000', 'A');
  }

  const refs = async () => {
    const v = await view();
    return {
      dp: v.downPayments[0],
      inv: (n: number) => v.invoices.find((i) => i.amount === n)!,
    };
  };

  it('shows both sides with remainders and refuses unequal totals or over-application', async () => {
    await standingClient();
    const v = await view();
    expect(v.downPayments.map((d) => [d.amount, d.remaining])).toEqual([[10000, 10000]]);
    expect(v.invoices.map((i) => i.remaining).sort((a, b) => a - b)).toEqual([300, 550, 9150]);

    const { dp, inv } = await refs();
    const dpRef = { documentNumber: dp.documentNumber, fiscalYear: dp.fiscalYear, lineNumber: dp.lineNumber };
    await expect(clearDownPayments(clearing({
      downPayments: [{ ...dpRef, applied: 550 }],
      invoices: [{ documentNumber: inv(300).documentNumber, fiscalYear: inv(300).fiscalYear, lineNumber: inv(300).lineNumber, applied: 300 }],
    }))).rejects.toThrow('applied totals do not agree');

    await expect(clearDownPayments(clearing({
      downPayments: [{ ...dpRef, applied: 10050 }],
      invoices: [550, 300, 9200].map((n) => {
        const item = v.invoices.find((i) => i.amount === (n === 9200 ? 9150 : n))!;
        return { documentNumber: item.documentNumber, fiscalYear: item.fiscalYear, lineNumber: item.lineNumber, applied: n };
      }),
    }))).rejects.toThrow('exceeds its remaining 10000.00');
  });

  it('clears an invoice in full while the advance stands partially open', async () => {
    const c = await standingClient();
    const { dp, inv } = await refs();
    const posted = await clearDownPayments(clearing({
      requestKey: 'clr-post-1',
      downPayments: [{ documentNumber: dp.documentNumber, fiscalYear: dp.fiscalYear, lineNumber: dp.lineNumber, applied: 550 }],
      invoices: [{ documentNumber: inv(550).documentNumber, fiscalYear: inv(550).fiscalYear, lineNumber: inv(550).lineNumber, applied: 550 }],
    }));
    expect(posted.itemsCleared).toBe(1);
    expect(Number(posted.totalApplied)).toBe(550);

    const header = await withTenant(c, (tx) => tx.execute(sql`
      select document_type from journal_entry
      where client = ${c} and document_number = ${posted.journalDocumentNumber}
    `));
    expect((header as unknown as Array<{ document_type: string }>)[0].document_type).toBe('KZ');

    const lines = await withTenant(c, (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_local::text as amount, line_text, clearing_document from journal_entry_line
      where client = ${c} and document_number = ${posted.journalDocumentNumber} order by line_number
    `));
    const rows = lines as unknown as Array<Record<string, string | null>>;
    expect(rows[0]).toMatchObject({ gl_account: '200000', debit_credit: 'S', amount: '550.0000' });
    expect(rows[0].line_text).toContain('Settles');
    expect(rows[0].clearing_document).toBe(posted.journalDocumentNumber);
    expect(rows[1]).toMatchObject({ gl_account: '230000', debit_credit: 'H', amount: '550.0000' });
    expect(rows[1].line_text).toBe(`Applied from ${dpDoc}`);
    expect(rows[1].clearing_document).toBeNull();

    // The invoice line itself stands cleared; the advance stands open.
    const stamped = await withTenant(c, (tx) => tx.execute(sql`
      select clearing_document from journal_entry_line
      where client = ${c} and document_number = ${invDocs[0]} and business_partner = 'V10000'
    `));
    expect((stamped as unknown as Array<{ clearing_document: string }>)[0].clearing_document)
      .toBe(posted.journalDocumentNumber);

    const v = await view();
    expect(v.downPayments.map((d) => [d.applied, d.remaining])).toEqual([[550, 9450]]);
    expect(v.invoices.map((i) => i.remaining).sort((a, b) => a - b)).toEqual([300, 9150]);

    const replay = await clearDownPayments(clearing({
      requestKey: 'clr-post-1',
      downPayments: [{ documentNumber: dp.documentNumber, fiscalYear: dp.fiscalYear, lineNumber: dp.lineNumber, applied: 550 }],
      invoices: [{ documentNumber: inv(550).documentNumber, fiscalYear: inv(550).fiscalYear, lineNumber: inv(550).lineNumber, applied: 550 }],
    }));
    expect(replay.journalDocumentNumber).toBe(posted.journalDocumentNumber);
  });

  it('completes both sides, stamping the advance when it is fully applied', async () => {
    const c = await standingClient();
    const { dp, inv } = await refs();
    const dpRef = { documentNumber: dp.documentNumber, fiscalYear: dp.fiscalYear, lineNumber: dp.lineNumber };
    await clearDownPayments(clearing({
      downPayments: [{ ...dpRef, applied: 300 }],
      invoices: [{ documentNumber: inv(300).documentNumber, fiscalYear: inv(300).fiscalYear, lineNumber: inv(300).lineNumber, applied: 300 }],
    }));
    const posted = await clearDownPayments(clearing({
      downPayments: [{ ...dpRef, applied: 9150 }],
      invoices: [{ documentNumber: inv(9150).documentNumber, fiscalYear: inv(9150).fiscalYear, lineNumber: inv(9150).lineNumber, applied: 9150 }],
    }));
    expect(posted.itemsCleared).toBe(2);

    const dpLine = await withTenant(c, (tx) => tx.execute(sql`
      select clearing_document from journal_entry_line
      where client = ${c} and document_number = ${dpDoc} and business_partner = 'V10000'
    `));
    expect((dpLine as unknown as Array<{ clearing_document: string }>)[0].clearing_document)
      .toBe(posted.journalDocumentNumber);

    const v = await view();
    expect(v.downPayments).toHaveLength(0);
    expect(v.invoices).toHaveLength(0);

    const record = await withTenant(c, (tx) => tx.execute(sql`
      select total_applied::text as total from vendor_down_payment_clearing
      where client = ${c} and clearing_number = ${posted.clearingNumber}
    `));
    expect((record as unknown as Array<{ total: string }>)[0].total).toBe('9150.0000');
  });
});
