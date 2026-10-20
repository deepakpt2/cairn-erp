import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { postJournalEntry } from '../src/platform/posting';
import { defineRange } from '../src/platform/numbering';
import {
  FIN_JOURNAL_DISPLAY_CAPABILITY,
  getJournalDocument,
} from '../src/modules/finance/document-display';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

/**
 * SCR-137 / FB03 — the universal drill-down anchor.
 *
 * The document is read by number and year; the company code, when given, must agree
 * and a disagreement refuses in SAP's wording rather than returning a bare "not
 * found". Each line carries its KOART derived from what the data supports: S by
 * default, D where the partner stands as a supplier in this company, K where it
 * stands as a customer. Nothing is written.
 */
const ACTOR = 'SCR137_FB03_TEST';
const COMPANY = '1000';
const OTHER = '2000';

describe('SCR-137 journal document display (FB03)', () => {
  let client = '';
  let plainDoc = '';
  let partnerDoc = '';

  const post = (amount: string, date: string, lines: Array<{
    glAccount: string; debitCredit: 'S' | 'H'; amount: string;
    businessPartner?: string; costCenter?: string;
  }>) => withTenant(client, (tx) => postJournalEntry(tx, {
    client, companyCode: COMPANY, documentType: 'SA',
    documentDate: date, postingDate: date, fiscalYear: 2026,
    postingPeriod: Number(date.slice(5, 7)), currency: 'USD', localCurrency: 'USD',
    lines,
    postedBy: ACTOR, transactionCode: 'FIN.JOURNAL.POST',
  }));

  beforeAll(async () => {
    const fx = await createTenant('scr137-fb03');
    client = fx.client;
    await defineTestRanges(fx, { fiscalYear: 2026 });
    await withTenant(client, async (tx) => {
      await defineRange(tx, {
        client, objectCode: 'RF_BELEG', companyCode: COMPANY, subObject: 'GENERAL',
        fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: ACTOR,
      });
      await tx.execute(sql`
        insert into company_code (client, company_code, name, country, currency, chart_of_accounts, created_by)
        select ${client}, ${OTHER}, 'Second company', 'KW', ${fx.currency}, c.chart_of_accounts, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        on conflict do nothing
      `);
      // Partners: one supplier and one customer of the company, both business partners.
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by) values
          (${client}, 'V70001', 'ORGANIZATION', 'Supplier Seven', ${ACTOR}),
          (${client}, 'C70002', 'ORGANIZATION', 'Customer Seven', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by) values
          (${client}, 'V70001', 'SUPPLIER', ${ACTOR}),
          (${client}, 'C70002', 'CUSTOMER', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_company_code (client, partner_number, role_code, company_code, chart_of_accounts,
                                           reconciliation_account, company_status, is_blocked, created_by)
        select ${client}, 'V70001', 'SUPPLIER', ${COMPANY}, c.chart_of_accounts, '210000', 'MAINTAINED', false, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into customer_company_code (client, partner_number, role_code, company_code, chart_of_accounts,
                                           reconciliation_account, company_status, is_blocked, created_by)
        select ${client}, 'C70002', 'CUSTOMER', ${COMPANY}, c.chart_of_accounts, '120000', 'MAINTAINED', false, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        on conflict do nothing
      `);
    });

    plainDoc = (await post('300.00', '2026-06-10', [
      { glAccount: '400000', debitCredit: 'S', amount: '300.00', costCenter: 'CC1000' },
      { glAccount: '101000', debitCredit: 'H', amount: '300.00' },
    ])).documentNumber;

    partnerDoc = (await post('120.00', '2026-06-11', [
      { glAccount: '210000', debitCredit: 'H', amount: '90.00', businessPartner: 'V70001' },
      { glAccount: '120000', debitCredit: 'S', amount: '30.00', businessPartner: 'C70002' },
      { glAccount: '400000', debitCredit: 'S', amount: '90.00' },
      { glAccount: '101000', debitCredit: 'H', amount: '30.00' },
    ])).documentNumber;
  }, 180_000);

  afterAll(async () => {
    if (client) await destroyTenant(client);
  }, 180_000);

  it('exposes FIN.JOURNAL.DISPLAY as the document capability, apart from the flow', () => {
    expect(FIN_JOURNAL_DISPLAY_CAPABILITY).toBe('FIN.JOURNAL.DISPLAY');
  });

  it('reads a document by its number and year, with every line and both totals', async () => {
    const found = await getJournalDocument(client, { documentNumber: plainDoc, companyCode: COMPANY, fiscalYear: 2026 });
    expect(found.kind).toBe('FOUND');
    if (found.kind !== 'FOUND') return;
    expect(found.document.companyCode).toBe(COMPANY);
    expect(found.document.lines).toHaveLength(2);
    expect(found.document.debitDocument).toBe(300);
    expect(found.document.creditDocument).toBe(300);
    expect(found.document.lines[0].costCenter).toBe('CC1000');
    expect(found.document.lines[0].debitCredit).toBe('S');
    expect(found.document.lines[1].debitCredit).toBe('H');
  });

  it('derives KOART per line: S for a G/L line, D for a supplier, K for a customer', async () => {
    const found = await getJournalDocument(client, { documentNumber: partnerDoc, companyCode: COMPANY, fiscalYear: 2026 });
    expect(found.kind).toBe('FOUND');
    if (found.kind !== 'FOUND') return;
    const byAccount = new Map(found.document.lines.map((l) => [l.glAccount, l.accountType]));
    expect(byAccount.get('210000')).toBe('D');
    expect(byAccount.get('120000')).toBe('K');
    expect(byAccount.get('400000')).toBe('S');
  });

  it('refuses a company code that disagrees, in SAP’s words, and names where it stands', async () => {
    const mismatch = await getJournalDocument(client, {
      documentNumber: plainDoc, companyCode: OTHER, fiscalYear: 2026,
    });
    expect(mismatch.kind).toBe('COMPANY_MISMATCH');
    if (mismatch.kind !== 'COMPANY_MISMATCH') return;
    expect(mismatch.standsIn).toBe(COMPANY);
    expect(mismatch.documentNumber).toBe(plainDoc);
  });

  it('refuses a year that carries no such document, and a number that stands nowhere', async () => {
    const wrongYear = await getJournalDocument(client, {
      documentNumber: plainDoc, companyCode: COMPANY, fiscalYear: 2025,
    });
    expect(wrongYear.kind).toBe('NOT_FOUND');

    const nowhere = await getJournalDocument(client, {
      documentNumber: 'JE-999999', companyCode: COMPANY, fiscalYear: 2026,
    });
    expect(nowhere.kind).toBe('NOT_FOUND');
  });

  it('requires the whole key rather than guessing the year', async () => {
    await expect(getJournalDocument(client, {
      documentNumber: plainDoc, companyCode: '', fiscalYear: 2026,
    })).rejects.toThrow(/document number, company code and fiscal year/);
    await expect(getJournalDocument(client, {
      documentNumber: '', companyCode: COMPANY, fiscalYear: 2026,
    })).rejects.toThrow(/document number, company code and fiscal year/);
  });

  it('writes nothing: the display leaves the document and its lines exactly as they stood', async () => {
    const before = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as n,
               coalesce(sum(amount_local), 0)::text as total
        from journal_entry_line
        where client = ${client} and document_number = ${plainDoc}
      `) as unknown as Array<{ n: number; total: string }>;
      const headers = await tx.execute(sql`
        select count(*)::int as n from journal_entry where client = ${client}
      `) as unknown as Array<{ n: number }>;
      return { lines: rows[0], headers: headers[0].n };
    });
    await getJournalDocument(client, { documentNumber: plainDoc, companyCode: COMPANY, fiscalYear: 2026 });
    const after = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as n, coalesce(sum(amount_local), 0)::text as total
        from journal_entry_line
        where client = ${client} and document_number = ${plainDoc}
      `) as unknown as Array<{ n: number; total: string }>;
      const headers = await tx.execute(sql`
        select count(*)::int as n from journal_entry where client = ${client}
      `) as unknown as Array<{ n: number }>;
      return { lines: rows[0], headers: headers[0].n };
    });
    expect(after.lines.n).toBe(before.lines.n);
    expect(after.lines.total).toBe(before.lines.total);
    expect(after.headers).toBe(before.headers);
  });

  it('never reaches another tenant’s document', async () => {
    const other = await createTenant('scr137-other');
    try {
      const lookup = await getJournalDocument(other.client, {
        documentNumber: plainDoc, companyCode: COMPANY, fiscalYear: 2026,
      });
      expect(lookup.kind).toBe('NOT_FOUND');
    } finally {
      await destroyTenant(other.client);
    }
  }, 180_000);
});
