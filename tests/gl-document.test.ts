import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { reverseJournalEntry } from '../src/platform/posting';
import { postGlDocument } from '../src/modules/finance/gl-document';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'FB50-TEST';
let client = '';
let company = '';
let postedDocument = '';
let postedYear = 0;

async function journalCount(): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`);
    return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
  });
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    client, changedBy: ACTOR, requestKey: `fb50-${Math.random().toString(36).slice(2)}`,
    companyCode: company, documentDate: '2026-04-01', postingDate: '2026-04-01',
    documentType: 'SA', currency: 'USD',
    reference: 'JE-2026-001', headerText: 'Monthly accrual',
    lines: [
      {
        glAccount: '400000', debitCredit: 'S' as const, amount: '1500.00',
        costCenter: 'CC100', profitCenter: 'PC100', assignment: 'ASSIGN-01', lineText: 'Office expense',
      },
      { glAccount: '101000', debitCredit: 'H' as const, amount: '1500.00', lineText: 'Cash' },
    ],
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeAll(async () => {
  const fx = await createTenant('gl-document');
  client = fx.client;
  company = fx.companyCode;
  await defineTestRanges(fx, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
      values (${client}, 'A000', 'CC100', '2020-01-01', '9999-12-31', 'Test cost centre', 'PRODUCTION', ${company}, ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into profit_center (client, controlling_area, profit_center, valid_from, valid_to, name, created_by)
      values (${client}, 'A000', 'PC100', '2020-01-01', '9999-12-31', 'Test profit centre', ${ACTOR})
      on conflict do nothing
    `);
  });
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
}, 180_000);

describe('SCR-096 FB50 G/L document entry (R-144)', () => {
  it('posts a balanced document with assignments, and a duplicate submission returns it', async () => {
    const before = await journalCount();
    const requestKey = 'fb50-main-1';
    const posted = await postGlDocument(base({ requestKey }));
    postedDocument = posted.documentNumber;
    postedYear = posted.fiscalYear;
    expect(posted.fiscalYear).toBe(2026);
    expect(posted.lineCount).toBe(2);

    const lines = await withTenant(client, async (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_document, cost_center, profit_center, assignment
      from journal_entry_line
      where client = ${client} and document_number = ${posted.documentNumber}
      order by line_number
    `));
    const rows = lines as unknown as Array<Record<string, string>>;
    expect(rows[0]).toMatchObject({
      gl_account: '400000', debit_credit: 'S', cost_center: 'CC100',
      profit_center: 'PC100', assignment: 'ASSIGN-01',
    });
    expect(Number(rows[0].amount_document)).toBe(1500);

    const replay = await postGlDocument(base({ requestKey }));
    expect(replay.documentNumber).toBe(posted.documentNumber);
    expect(await journalCount()).toBe(before + 1); // exactly one document
  });

  it('rejects the package validation scenarios and leaves nothing behind', async () => {
    const before = await journalCount();
    await expect(postGlDocument(base({
      lines: [
        { glAccount: '400000', debitCredit: 'S', amount: '100.00' },
        { glAccount: '101000', debitCredit: 'H', amount: '90.00' },
      ],
    }))).rejects.toThrow('does not balance');
    await expect(postGlDocument(base({
      lines: [
        { glAccount: '400000', debitCredit: 'S', amount: '0.00' },
        { glAccount: '101000', debitCredit: 'H', amount: '0.00' },
      ],
    }))).rejects.toThrow('non-positive');
    await expect(postGlDocument(base({
      lines: [
        { glAccount: '999999', debitCredit: 'S', amount: '100.00' },
        { glAccount: '101000', debitCredit: 'H', amount: '100.00' },
      ],
    }))).rejects.toThrow('does not stand in company');
    await expect(postGlDocument(base({
      lines: [
        { glAccount: '400000', debitCredit: 'S', amount: '100.00', costCenter: 'NOPE' },
        { glAccount: '101000', debitCredit: 'H', amount: '100.00' },
      ],
    }))).rejects.toThrow('cost centre NOPE');
    await expect(postGlDocument(base({
      lines: [
        { glAccount: '400000', debitCredit: 'S', amount: '100.00', profitCenter: 'NOPE' },
        { glAccount: '101000', debitCredit: 'H', amount: '100.00' },
      ],
    }))).rejects.toThrow('profit centre NOPE');
    await expect(postGlDocument(base({ currency: 'EUR' }))).rejects.toThrow('Foreign-currency');
    await expect(postGlDocument(base({
      lines: [
        { glAccount: '400000', debitCredit: 'S', amount: '100.234' },
        { glAccount: '101000', debitCredit: 'H', amount: '100.234' },
      ],
    }))).rejects.toThrow('decimal places');
    await expect(postGlDocument(base({ documentType: 'ZZ' }))).rejects.toThrow('not active or does not exist');
    await expect(postGlDocument(base({ documentDate: '2026-02-30' }))).rejects.toThrow('not a calendar date');
    expect(await journalCount()).toBe(before); // failed postings wrote nothing
  });

  it('reverses through the canonical workflow, mirroring the assignment', async () => {
    const reversal = await withTenant(client, async (tx) => reverseJournalEntry(tx, {
      client, documentNumber: postedDocument, fiscalYear: postedYear,
      reversalDate: '2026-04-15', reason: 'Entered in error', reversedBy: ACTOR,
      reversalDocumentType: 'AB',
    }));
    const rows = await withTenant(client, async (tx) => tx.execute(sql`
      select status from journal_entry
      where client = ${client} and document_number = ${postedDocument}
    `));
    expect((rows as unknown as Array<{ status: string }>)[0]?.status).toBe('REVERSED');
    const mirror = await withTenant(client, async (tx) => tx.execute(sql`
      select debit_credit, assignment from journal_entry_line
      where client = ${client} and document_number = ${reversal.documentNumber}
      order by line_number
    `));
    expect((mirror as unknown as Array<Record<string, string>>)[0])
      .toMatchObject({ debit_credit: 'H', assignment: 'ASSIGN-01' });

    // Posted balances reconcile with the canonical ledger: the pair nets to zero.
    const net = await withTenant(client, async (tx) => tx.execute(sql`
      select coalesce(sum(case when debit_credit = 'S' then amount_document else -amount_document end), 0) as net
      from journal_entry_line where client = ${client} and gl_account = '400000'
    `));
    expect(Number((net as unknown as Array<{ net: string }>)[0]?.net)).toBe(0);
  });
});
