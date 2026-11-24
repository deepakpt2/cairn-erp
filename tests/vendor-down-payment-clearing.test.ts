import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { reverseJournalEntry } from '../src/platform/posting';
import { postVendorInvoice } from '../src/modules/finance/vendor-invoice';
import { getVendorDownPayments, postVendorDownPayment } from '../src/modules/finance/vendor-down-payment';
import { getPayables, postOutgoingPayment } from '../src/modules/finance/outgoing-payment';
import { resetClearing } from '../src/modules/finance/clearing-reset';
import { getVendorAgeing } from '../src/modules/finance/vendor-ageing';
import {
  clearDownPayments, getDownPaymentClearing,
} from '../src/modules/finance/vendor-down-payment-clearing';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';
import { createFinanceActor } from './helpers/finance-actor';

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

  it('nets a partial advance and keeps it applied when the balancing payment is reset', async () => {
    const c = await standingClient();
    const actor = await createFinanceActor(c);

    const invoice = await postVendorInvoice({
      client: c, changedBy: ACTOR, vendorNumber: 'V10000', companyCode: '1000',
      documentDate: '2026-11-01', postingDate: '2026-11-02',
      reference: 'NET-PART-INV', currency: 'USD', grossAmount: 1200,
      requestKey: 'net-part-inv', lines: [{ glAccount: '400000', netAmount: 1200 }],
    });
    const advance = await postVendorDownPayment({
      client: c, changedBy: ACTOR, vendorNumber: 'V10000', companyCode: '1000',
      documentDate: '2026-11-03', postingDate: '2026-11-03',
      bankGlAccount: '101000', amount: 5000, currency: 'USD',
      specialGlIndicator: 'A', requestKey: 'net-part-dp',
    });

    const before = await view();
    const advanceItem = before.downPayments.find((d) => d.documentNumber === advance.journalDocumentNumber)!;
    const invoiceItem = before.invoices.find((i) => i.documentNumber === invoice.journalDocumentNumber)!;
    await clearDownPayments(clearing({
      requestKey: 'net-part-apply',
      downPayments: [{
        documentNumber: advanceItem.documentNumber, fiscalYear: advanceItem.fiscalYear,
        lineNumber: advanceItem.lineNumber, applied: 1000,
      }],
      invoices: [{
        documentNumber: invoiceItem.documentNumber, fiscalYear: invoiceItem.fiscalYear,
        lineNumber: invoiceItem.lineNumber, applied: 1000,
      }],
    }));

    // The invoice stands at its remainder; the advance shows what is left of it.
    const payable = (await getPayables(c, 'V10000', '1000')).openItems
      .find((i) => i.documentNumber === invoice.journalDocumentNumber)!;
    expect(payable.amount).toBe('200.0000');
    expect((await view()).downPayments
      .find((d) => d.documentNumber === advance.journalDocumentNumber)?.remaining).toBe(4000);
    expect((await getVendorDownPayments(c, 'V10000', '1000'))
      .find((d) => d.documentNumber === advance.journalDocumentNumber)?.amount).toBe('4000.0000');

    const paid = await postOutgoingPayment({
      client: c, changedBy: ACTOR, vendorNumber: 'V10000', companyCode: '1000',
      documentDate: '2026-11-10', postingDate: '2026-11-10', clearingDate: '2026-11-10',
      bankGlAccount: '101000', amount: 200, currency: 'USD',
      reference: 'NET-PART-PAY', requestKey: 'net-part-pay',
      items: [{
        documentNumber: payable.documentNumber, fiscalYear: payable.fiscalYear,
        lineNumber: payable.lineNumber,
      }],
    }, { authorization: actor.authorization });
    // `outgoing_payment.amount` is numeric(23,4); the service reads it back at the stored scale.
    expect(paid.amount).toBe('200.0000');

    await resetClearing({
      client: c, changedBy: ACTOR, companyCode: '1000',
      clearingDocument: paid.journalDocumentNumber, fiscalYear: 2026,
      reason: 'partial advance lifecycle', requestKey: 'net-part-reset',
    });

    // For payment purposes the reset payment still nets the invoice (it must not be paid
    // twice), while the advance application remains effective: the invoice's own remaining
    // is 200 and the reset payment shows as an unapplied credit beside it.
    expect((await getPayables(c, 'V10000', '1000')).openItems
      .some((i) => i.documentNumber === invoice.journalDocumentNumber)).toBe(false);
    expect((await view()).downPayments
      .find((d) => d.documentNumber === advance.journalDocumentNumber)?.remaining).toBe(4000);
    // Key date after the reset was recorded: a reset made after the key date is not effective as of
    // it, so the balancing payment would still read as clearing the invoice then.
    const ageing = await getVendorAgeing(c, {
      companyCode: '1000', keyDate: '2026-12-31', supplierFrom: 'V10000', supplierTo: 'V10000',
      authorization: actor.authorization,
    });
    expect(ageing.items.find((i) => i.documentNumber === invoice.journalDocumentNumber))
      .toMatchObject({ amount: '200.0000' });
    expect(ageing.grandTotal).toBe(0);
  }, 90_000);

  it('Scenario 1 — fully applied advance: payable 200, available advance 0', async () => {
    const c = await standingClient();
    const actor = await createFinanceActor(c);
    const invoice = await postVendorInvoice({
      client: c, changedBy: ACTOR, vendorNumber: 'V10000', companyCode: '1000',
      documentDate: '2026-11-01', postingDate: '2026-11-02',
      reference: 'SC1-INV', currency: 'USD', grossAmount: 1200,
      requestKey: 'sc1-inv', lines: [{ glAccount: '400000', netAmount: 1200 }],
    });
    const advance = await postVendorDownPayment({
      client: c, changedBy: ACTOR, vendorNumber: 'V10000', companyCode: '1000',
      documentDate: '2026-11-03', postingDate: '2026-11-03',
      bankGlAccount: '101000', amount: 1000, currency: 'USD',
      specialGlIndicator: 'A', requestKey: 'sc1-dp',
    });
    const before = await view();
    const dp = before.downPayments.find((d) => d.documentNumber === advance.journalDocumentNumber)!;
    const inv = before.invoices.find((i) => i.documentNumber === invoice.journalDocumentNumber)!;
    await clearDownPayments(clearing({
      requestKey: 'sc1-apply',
      downPayments: [{
        documentNumber: dp.documentNumber, fiscalYear: dp.fiscalYear, lineNumber: dp.lineNumber, applied: 1000,
      }],
      invoices: [{
        documentNumber: inv.documentNumber, fiscalYear: inv.fiscalYear, lineNumber: inv.lineNumber, applied: 1000,
      }],
    }));

    // Open invoice liability 200; no unapplied payment credit, so payable is also 200.
    const payable = (await getPayables(c, 'V10000', '1000')).openItems
      .find((i) => i.documentNumber === invoice.journalDocumentNumber)!;
    expect(payable.amount).toBe('200.0000');
    // Fully applied: the advance is no longer available.
    expect((await getVendorDownPayments(c, 'V10000', '1000'))
      .some((d) => d.documentNumber === advance.journalDocumentNumber)).toBe(false);
    const ageing = await getVendorAgeing(c, {
      companyCode: '1000', keyDate: '2026-11-20', supplierFrom: 'V10000', supplierTo: 'V10000',
      authorization: actor.authorization,
    });
    expect(ageing.items.find((i) => i.documentNumber === invoice.journalDocumentNumber)?.amount)
      .toBe('200.0000');
  }, 90_000);

  it('Scenario 2 — partially applied advance: payable 400, available advance 200', async () => {
    const c = await standingClient();
    const actor = await createFinanceActor(c);
    const invoice = await postVendorInvoice({
      client: c, changedBy: ACTOR, vendorNumber: 'V10000', companyCode: '1000',
      documentDate: '2026-11-01', postingDate: '2026-11-02',
      reference: 'SC2-INV', currency: 'USD', grossAmount: 1200,
      requestKey: 'sc2-inv', lines: [{ glAccount: '400000', netAmount: 1200 }],
    });
    const advance = await postVendorDownPayment({
      client: c, changedBy: ACTOR, vendorNumber: 'V10000', companyCode: '1000',
      documentDate: '2026-11-03', postingDate: '2026-11-03',
      bankGlAccount: '101000', amount: 1000, currency: 'USD',
      specialGlIndicator: 'A', requestKey: 'sc2-dp',
    });
    const before = await view();
    const dp = before.downPayments.find((d) => d.documentNumber === advance.journalDocumentNumber)!;
    const inv = before.invoices.find((i) => i.documentNumber === invoice.journalDocumentNumber)!;
    await clearDownPayments(clearing({
      requestKey: 'sc2-apply',
      downPayments: [{
        documentNumber: dp.documentNumber, fiscalYear: dp.fiscalYear, lineNumber: dp.lineNumber, applied: 800,
      }],
      invoices: [{
        documentNumber: inv.documentNumber, fiscalYear: inv.fiscalYear, lineNumber: inv.lineNumber, applied: 800,
      }],
    }));

    // The payable is the invoice liability (400); the unapplied advance (200) is separate
    // and is not netted against it.
    const payable = (await getPayables(c, 'V10000', '1000')).openItems
      .find((i) => i.documentNumber === invoice.journalDocumentNumber)!;
    expect(payable.amount).toBe('400.0000');
    expect((await view()).downPayments
      .find((d) => d.documentNumber === advance.journalDocumentNumber)?.remaining).toBe(200);
    expect((await getVendorDownPayments(c, 'V10000', '1000'))
      .find((d) => d.documentNumber === advance.journalDocumentNumber)?.amount).toBe('200.0000');
    const ageing = await getVendorAgeing(c, {
      companyCode: '1000', keyDate: '2026-11-20', supplierFrom: 'V10000', supplierTo: 'V10000',
      authorization: actor.authorization,
    });
    expect(ageing.items.find((i) => i.documentNumber === invoice.journalDocumentNumber)?.amount)
      .toBe('400.0000');

    // Execution independently recalculates the eligible amount and pays exactly it.
    const paid = await postOutgoingPayment({
      client: c, changedBy: ACTOR, vendorNumber: 'V10000', companyCode: '1000',
      documentDate: '2026-11-10', postingDate: '2026-11-10', clearingDate: '2026-11-10',
      bankGlAccount: '101000', amount: 400, currency: 'USD',
      reference: 'SC2-PAY', requestKey: 'sc2-pay',
      items: [{
        documentNumber: payable.documentNumber, fiscalYear: payable.fiscalYear, lineNumber: payable.lineNumber,
      }],
    }, { authorization: actor.authorization });
    // `outgoing_payment.amount` is numeric(23,4); the service reads it back at the stored scale.
    expect(paid.amount).toBe('400.0000');
  }, 90_000);

  it('advance clearing reset restores the invoice liability and the available advance', async () => {
    const c = await standingClient();
    const invoice = await postVendorInvoice({
      client: c, changedBy: ACTOR, vendorNumber: 'V10000', companyCode: '1000',
      documentDate: '2026-11-01', postingDate: '2026-11-02',
      reference: 'SC-RST-INV', currency: 'USD', grossAmount: 1200,
      requestKey: 'sc-rst-inv', lines: [{ glAccount: '400000', netAmount: 1200 }],
    });
    const advance = await postVendorDownPayment({
      client: c, changedBy: ACTOR, vendorNumber: 'V10000', companyCode: '1000',
      documentDate: '2026-11-03', postingDate: '2026-11-03',
      bankGlAccount: '101000', amount: 1200, currency: 'USD',
      specialGlIndicator: 'A', requestKey: 'sc-rst-dp',
    });
    const before = await view();
    const dp = before.downPayments.find((d) => d.documentNumber === advance.journalDocumentNumber)!;
    const inv = before.invoices.find((i) => i.documentNumber === invoice.journalDocumentNumber)!;
    const posted = await clearDownPayments(clearing({
      requestKey: 'sc-rst-apply',
      downPayments: [{
        documentNumber: dp.documentNumber, fiscalYear: dp.fiscalYear, lineNumber: dp.lineNumber, applied: 1200,
      }],
      invoices: [{
        documentNumber: inv.documentNumber, fiscalYear: inv.fiscalYear, lineNumber: inv.lineNumber, applied: 1200,
      }],
    }));
    // Fully applied: the invoice and the advance stand closed.
    expect((await getPayables(c, 'V10000', '1000')).openItems
      .some((i) => i.documentNumber === invoice.journalDocumentNumber)).toBe(false);
    expect((await getVendorDownPayments(c, 'V10000', '1000'))
      .some((d) => d.documentNumber === advance.journalDocumentNumber)).toBe(false);

    await resetClearing({
      client: c, changedBy: ACTOR, companyCode: '1000',
      clearingDocument: posted.journalDocumentNumber, fiscalYear: 2026,
      reason: 'advance clearing reset', requestKey: 'sc-rst-reset',
    });

    // The reset application is undone: the invoice liability and the advance are both restored.
    const payable = (await getPayables(c, 'V10000', '1000')).openItems
      .find((i) => i.documentNumber === invoice.journalDocumentNumber)!;
    expect(payable.amount).toBe('1200.0000');
    expect((await getVendorDownPayments(c, 'V10000', '1000'))
      .find((d) => d.documentNumber === advance.journalDocumentNumber)?.amount).toBe('1200.0000');
  }, 90_000);

  it('reversing an advance clearing removes its application', async () => {
    const c = await standingClient();
    const invoice = await postVendorInvoice({
      client: c, changedBy: ACTOR, vendorNumber: 'V10000', companyCode: '1000',
      documentDate: '2026-11-01', postingDate: '2026-11-02',
      reference: 'SC-REV-INV', currency: 'USD', grossAmount: 1200,
      requestKey: 'sc-rev-inv', lines: [{ glAccount: '400000', netAmount: 1200 }],
    });
    const advance = await postVendorDownPayment({
      client: c, changedBy: ACTOR, vendorNumber: 'V10000', companyCode: '1000',
      documentDate: '2026-11-03', postingDate: '2026-11-03',
      bankGlAccount: '101000', amount: 1000, currency: 'USD',
      specialGlIndicator: 'A', requestKey: 'sc-rev-dp',
    });
    const before = await view();
    const dp = before.downPayments.find((d) => d.documentNumber === advance.journalDocumentNumber)!;
    const inv = before.invoices.find((i) => i.documentNumber === invoice.journalDocumentNumber)!;
    const posted = await clearDownPayments(clearing({
      requestKey: 'sc-rev-apply',
      downPayments: [{
        documentNumber: dp.documentNumber, fiscalYear: dp.fiscalYear, lineNumber: dp.lineNumber, applied: 800,
      }],
      invoices: [{
        documentNumber: inv.documentNumber, fiscalYear: inv.fiscalYear, lineNumber: inv.lineNumber, applied: 800,
      }],
    }));

    await withTenant(c, (tx) => reverseJournalEntry(tx, {
      client: c, documentNumber: posted.journalDocumentNumber, fiscalYear: 2026,
      reversalDate: '2026-11-15', reason: 'advance clearing reversal', reversedBy: ACTOR,
    }));

    const payable = (await getPayables(c, 'V10000', '1000')).openItems
      .find((i) => i.documentNumber === invoice.journalDocumentNumber)!;
    expect(payable.amount).toBe('1200.0000');
    expect((await getVendorDownPayments(c, 'V10000', '1000'))
      .find((d) => d.documentNumber === advance.journalDocumentNumber)?.amount).toBe('1000.0000');
  }, 90_000);
});
