import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { getDocumentForReversal, reverseDocument } from '../src/modules/finance/document-reversal';
import { reversalReason } from '../src/modules/finance/schema';
import { postingPeriodRule } from '../src/modules/foundation/schema';
import { withTenant } from '../src/platform/db/client';
import { buildPeriodRows } from '../src/platform/periods';
import { postJournalEntry, type PostedJournal } from '../src/platform/posting';
import { createTenant, defineTestRanges, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'SCR072_FB08_TEST';
const COMPANY = '1000';

async function postOriginal(
  tenant: TestTenant,
  input: {
    documentDate: string;
    postingDate: string;
    fiscalYear: number;
    postingPeriod: number;
    amount?: string;
    currency?: string;
    exchangeRate?: string;
  },
): Promise<PostedJournal> {
  return withTenant(tenant.client, (tx) => postJournalEntry(tx, {
    client: tenant.client,
    companyCode: COMPANY,
    documentType: 'SA',
    documentDate: input.documentDate,
    postingDate: input.postingDate,
    fiscalYear: input.fiscalYear,
    postingPeriod: input.postingPeriod,
    currency: input.currency ?? 'USD',
    localCurrency: 'USD',
    exchangeRate: input.exchangeRate,
    headerText: 'SCR-072 original document',
    postedBy: ACTOR,
    lines: [
      { glAccount: '100000', debitCredit: 'S', amount: input.amount ?? '400.0000' },
      { glAccount: '200000', debitCredit: 'H', amount: input.amount ?? '400.0000' },
    ],
  }));
}

async function journalRow(client: string, documentNumber: string, fiscalYear: number) {
  const rows = await withTenant(client, (tx) => tx.execute(sql`
    select document_type, status, reversal_of, reversed_by, reversal_reason,
           document_date::text as document_date, posting_date::text as posting_date, posting_period
      from journal_entry
     where client = ${client} and document_number = ${documentNumber} and fiscal_year = ${fiscalYear}
  `));
  return (rows as unknown as Array<Record<string, unknown>>)[0];
}

async function journalLines(client: string, documentNumber: string, fiscalYear: number) {
  const rows = await withTenant(client, (tx) => tx.execute(sql`
    select line_number, gl_account, debit_credit, amount_document::text as amount_document,
           amount_local::text as amount_local, clearing_document, clearing_date::text as clearing_date
      from journal_entry_line
     where client = ${client} and document_number = ${documentNumber} and fiscal_year = ${fiscalYear}
     order by line_number
  `));
  return rows as unknown as Array<Record<string, unknown>>;
}

describe('SCR-072 reverse accounting document (FB08)', () => {
  let tenant: TestTenant | null = null;
  let shifted: TestTenant | null = null;

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
    if (shifted) await destroyTenant(shifted.client);
  });

  async function standingTenant(): Promise<TestTenant> {
    if (!tenant) {
      tenant = await createTenant('scr072-document-reversal');
      await defineTestRanges(tenant, { fiscalYear: 2026 });
      await withTenant(tenant.client, async (tx) => {
        await tx.insert(reversalReason).values({
          client: tenant!.client,
          reasonCode: '09',
          reasonDescription: 'Inactive test reason',
          isActive: false,
          createdBy: ACTOR,
        });
      });
    }
    return tenant;
  }

  it('displays the original and posts a linked AB mirror with exact amounts', async () => {
    const t = await standingTenant();
    const original = await postOriginal(t, {
      documentDate: '2026-10-01', postingDate: '2026-10-02', fiscalYear: 2026, postingPeriod: 10,
      amount: '125.0000', currency: 'EUR', exchangeRate: '1.2500',
    });
    const sel = { companyCode: COMPANY, documentNumber: original.documentNumber, fiscalYear: 2026 };

    const view = await getDocumentForReversal(t.client, { ...sel, reversalPostingDate: '2026-11-20' });
    expect(view.status).toBe('POSTED');
    expect(view.documentType).toBe('SA');
    expect(view.lines).toHaveLength(2);
    expect(view.debitTotalDocument).toBe('125.0000');
    expect(view.debitTotalLocal).toBe('156.2500');
    expect(view.canReverse).toBe(true);
    expect(view.reasons.map((r) => r.code)).toEqual(['01', '02', '03', '04']);
    expect(view.reversalFiscalYear).toBe(2026);
    expect(view.reversalPostingPeriod).toBe(11);

    await expect(reverseDocument({
      client: t.client, changedBy: ACTOR, ...sel, reasonCode: '01',
      documentDate: '2026-11-05', postingDate: '2026-11-20', confirmed: false, requestKey: 'rev-main',
    })).rejects.toThrow('stands unconfirmed');
    await expect(reverseDocument({
      client: t.client, changedBy: ACTOR, ...sel, reasonCode: '99',
      documentDate: '2026-11-05', postingDate: '2026-11-20', confirmed: true, requestKey: 'rev-main',
    })).rejects.toThrow('does not stand configured');
    await expect(reverseDocument({
      client: t.client, changedBy: ACTOR, ...sel, reasonCode: '09',
      documentDate: '2026-11-05', postingDate: '2026-11-20', confirmed: true, requestKey: 'rev-main',
    })).rejects.toThrow('stands inactive');

    const noWrites = await withTenant(t.client, (tx) => tx.execute(sql`
      select count(*)::int as n from accounting_reversal_link
       where client = ${t.client} and original_document_number = ${original.documentNumber}
    `));
    expect((noWrites as unknown as Array<{ n: number }>)[0].n).toBe(0);

    const result = await reverseDocument({
      client: t.client, changedBy: ACTOR, ...sel, reasonCode: '01',
      documentDate: '2026-11-05', postingDate: '2026-11-20', confirmed: true, requestKey: 'rev-main',
    });
    expect(result.reversalDocumentType).toBe('AB');
    expect(result.reversalDocumentDate).toBe('2026-11-05');
    expect(result.reversalPostingDate).toBe('2026-11-20');
    expect(result.reversalFiscalYear).toBe(2026);
    expect(result.reversalPostingPeriod).toBe(11);
    expect(result.reversalAmountLocal).toBe('156.2500');
    expect(result.reversalDocumentNumber).not.toBe(original.documentNumber);

    const originalRow = await journalRow(t.client, original.documentNumber, 2026);
    expect(originalRow.status).toBe('REVERSED');
    expect(originalRow.reversed_by).toBe(result.reversalDocumentNumber);
    expect(originalRow.reversal_reason).toBe('01');

    const reversalRow = await journalRow(t.client, result.reversalDocumentNumber, result.reversalFiscalYear);
    expect(reversalRow.document_type).toBe('AB');
    expect(reversalRow.status).toBe('POSTED');
    expect(reversalRow.reversal_of).toBe(original.documentNumber);
    expect(reversalRow.document_date).toBe('2026-11-05');
    expect(reversalRow.posting_date).toBe('2026-11-20');
    expect(reversalRow.posting_period).toBe(11);

    const originalLines = await journalLines(t.client, original.documentNumber, 2026);
    const reversalLines = await journalLines(t.client, result.reversalDocumentNumber, result.reversalFiscalYear);
    expect(reversalLines.map((l) => l.debit_credit)).toEqual(['H', 'S']);
    expect(reversalLines.map((l) => l.amount_document)).toEqual(originalLines.map((l) => l.amount_document));
    expect(reversalLines.map((l) => l.amount_local)).toEqual(originalLines.map((l) => l.amount_local));

    const links = await withTenant(t.client, (tx) => tx.execute(sql`
      select reversal_reason, reversal_document_date::text as dd, reversal_posting_date::text as pd,
             reversal_posting_period, reversed_by, request_key
        from accounting_reversal_link
       where client = ${t.client} and original_document_number = ${original.documentNumber}
    `));
    expect(links as unknown as Array<Record<string, unknown>>).toEqual([expect.objectContaining({
      reversal_reason: '01', dd: '2026-11-05', pd: '2026-11-20', reversal_posting_period: 11,
      reversed_by: ACTOR, request_key: 'rev-main',
    })]);

    const replay = await reverseDocument({
      client: t.client, changedBy: ACTOR, ...sel, reasonCode: '01',
      documentDate: '2026-11-05', postingDate: '2026-11-20', confirmed: true, requestKey: 'rev-main',
    });
    expect(replay.reversalDocumentNumber).toBe(result.reversalDocumentNumber);

    await expect(reverseDocument({
      client: t.client, changedBy: ACTOR, ...sel, reasonCode: '01',
      documentDate: '2026-11-06', postingDate: '2026-11-21', confirmed: true, requestKey: 'rev-again',
    })).rejects.toThrow('already stands reversed by');

    const reversalView = await getDocumentForReversal(t.client, {
      companyCode: COMPANY, documentNumber: result.reversalDocumentNumber, fiscalYear: result.reversalFiscalYear,
    });
    expect(reversalView.canReverse).toBe(false);
    expect(reversalView.refusal).toContain('is itself a reversal');
    await expect(reverseDocument({
      client: t.client, changedBy: ACTOR, companyCode: COMPANY,
      documentNumber: result.reversalDocumentNumber, fiscalYear: result.reversalFiscalYear,
      reasonCode: '01', documentDate: '2026-11-07', postingDate: '2026-11-22',
      confirmed: true, requestKey: 'rev-of-rev',
    })).rejects.toThrow('is itself a reversal');
  });

  it('refuses cleared lines and a document standing as clearing document, naming FBRA', async () => {
    const t = await standingTenant();
    const cleared = await postOriginal(t, {
      documentDate: '2026-10-03', postingDate: '2026-10-04', fiscalYear: 2026, postingPeriod: 10,
    });
    const clearingDoc = await postOriginal(t, {
      documentDate: '2026-10-05', postingDate: '2026-10-06', fiscalYear: 2026, postingPeriod: 10,
    });
    const other = await postOriginal(t, {
      documentDate: '2026-10-07', postingDate: '2026-10-08', fiscalYear: 2026, postingPeriod: 10,
    });
    await withTenant(t.client, async (tx) => {
      await tx.execute(sql`
        update journal_entry_line set clearing_document = '1000/2026/999', clearing_date = '2026-11-21'
         where client = ${t.client} and document_number = ${cleared.documentNumber}
           and fiscal_year = 2026 and line_number = 1
      `);
      await tx.execute(sql`
        update journal_entry_line set clearing_document = ${clearingDoc.documentNumber}, clearing_date = '2026-11-21'
         where client = ${t.client} and document_number = ${other.documentNumber}
           and fiscal_year = 2026 and line_number = 1
      `);
    });

    const clearedView = await getDocumentForReversal(t.client, {
      companyCode: COMPANY, documentNumber: cleared.documentNumber, fiscalYear: 2026,
    });
    expect(clearedView.canReverse).toBe(false);
    expect(clearedView.clearedLineCount).toBe(1);
    expect(clearedView.refusal).toContain('stands cleared by 1000/2026/999');
    await expect(reverseDocument({
      client: t.client, changedBy: ACTOR, companyCode: COMPANY, documentNumber: cleared.documentNumber,
      fiscalYear: 2026, reasonCode: '01', documentDate: '2026-11-22', postingDate: '2026-11-22',
      confirmed: true, requestKey: 'rev-cleared',
    })).rejects.toThrow('stands cleared by 1000/2026/999');

    const clearingView = await getDocumentForReversal(t.client, {
      companyCode: COMPANY, documentNumber: clearingDoc.documentNumber, fiscalYear: 2026,
    });
    expect(clearingView.canReverse).toBe(false);
    expect(clearingView.clearsItemCount).toBe(1);
    expect(clearingView.refusal).toContain('stands as the clearing document');
    await expect(reverseDocument({
      client: t.client, changedBy: ACTOR, companyCode: COMPANY, documentNumber: clearingDoc.documentNumber,
      fiscalYear: 2026, reasonCode: '01', documentDate: '2026-11-22', postingDate: '2026-11-22',
      confirmed: true, requestKey: 'rev-clearing-doc',
    })).rejects.toThrow('stands as the clearing document');
  });

  it('refuses a closed reversal period and writes no link', async () => {
    const t = await standingTenant();
    const original = await postOriginal(t, {
      documentDate: '2026-10-09', postingDate: '2026-10-10', fiscalYear: 2026, postingPeriod: 10,
    });
    await withTenant(t.client, async (tx) => {
      await tx.update(postingPeriodRule).set({ periodTo: 10 }).where(sql`${postingPeriodRule.client} = ${t.client}`);
    });
    try {
      await expect(reverseDocument({
        client: t.client, changedBy: ACTOR, companyCode: COMPANY, documentNumber: original.documentNumber,
        fiscalYear: 2026, reasonCode: '01', documentDate: '2026-11-05', postingDate: '2026-11-20',
        confirmed: true, requestKey: 'rev-closed',
      })).rejects.toThrow('closed for');
    } finally {
      await withTenant(t.client, async (tx) => {
        await tx.update(postingPeriodRule).set({ periodTo: 12 }).where(sql`${postingPeriodRule.client} = ${t.client}`);
      });
    }
    const links = await withTenant(t.client, (tx) => tx.execute(sql`
      select count(*)::int as n from accounting_reversal_link
       where client = ${t.client} and original_document_number = ${original.documentNumber}
    `));
    expect((links as unknown as Array<{ n: number }>)[0].n).toBe(0);
    expect((await journalRow(t.client, original.documentNumber, 2026)).status).toBe('POSTED');
  });

  it('derives the reversal year and period through a shifted fiscal-year variant', async () => {
    shifted = await createTenant('scr072-document-reversal-shifted');
    await defineTestRanges(shifted, { fiscalYear: 2026 });
    await defineTestRanges(shifted, { fiscalYear: 2027 });
    await withTenant(shifted.client, async (tx) => {
      await tx.execute(sql`
        insert into fiscal_year_variant (client, variant, name, is_calendar_year, regular_periods, special_periods, is_year_dependent, created_by)
        values (${shifted!.client}, 'SF', 'April to March', false, 12, 0, false, ${ACTOR})
      `);
      for (const row of buildPeriodRows({ regularPeriods: 12, specialPeriods: 0, startMonth: 4 })) {
        await tx.execute(sql`
          insert into fiscal_year_period (client, variant, calendar_year, period, period_type, month, day, year_shift, created_by)
          values (${shifted!.client}, 'SF', 0, ${row.period}, ${row.periodType}, ${row.month}, ${row.day}, ${row.yearShift}, ${ACTOR})
        `);
      }
      await tx.execute(sql`
        update company_code set fiscal_year_variant = 'SF'
         where client = ${shifted!.client} and company_code = ${COMPANY}
      `);
    });

    const original = await postOriginal(shifted, {
      documentDate: '2026-10-14', postingDate: '2026-10-15', fiscalYear: 2026, postingPeriod: 7,
    });
    const result = await reverseDocument({
      client: shifted.client, changedBy: ACTOR, companyCode: COMPANY,
      documentNumber: original.documentNumber, fiscalYear: 2026, reasonCode: '02',
      documentDate: '2027-10-20', postingDate: '2027-10-15', confirmed: true, requestKey: 'rev-shifted',
    });
    expect(result.reversalFiscalYear).toBe(2027);
    expect(result.reversalPostingPeriod).toBe(7);
    const reversalRow = await journalRow(shifted.client, result.reversalDocumentNumber, result.reversalFiscalYear);
    expect(reversalRow.posting_period).toBe(7);
    expect(reversalRow.document_date).toBe('2027-10-20');
  });
});
