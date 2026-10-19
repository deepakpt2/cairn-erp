import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { postJournalEntry, reverseJournalEntry } from '../src/platform/posting';
import { executeTaxReport } from '../src/modules/finance/tax-report';
import { createTenant, defineTestRanges, destroyTenant, seedAccounts } from './helpers';

const ACTOR = 'TAXRPT-TEST';
let client = '';
let company = '';
let country = '';
let inputDocument = '';

async function journalCount(): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`);
    return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
  });
}

async function stampedCount(): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select count(*)::int as n from journal_entry_line
      where client = ${client} and tax_return_run_id is not null
    `);
    return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
  });
}

function selection(overrides: Record<string, unknown> = {}) {
  return {
    companyCode: company, postingDateFrom: '2026-04-01', postingDateTo: '2026-04-30',
    taxReturnCountry: country, testRun: true, doNotUpdateDocuments: false,
    electronicReturn: false, correctedReturn: false,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function post(lines: Array<Record<string, unknown>>, postingDate: string) {
  return withTenant(client, async (tx) => postJournalEntry(tx, {
    client, companyCode: company, documentType: 'SA', documentDate: postingDate,
    postingDate, fiscalYear: 2026, postingPeriod: 4, currency: 'USD', localCurrency: 'USD',
    postedBy: ACTOR, transactionCode: 'FIN.JOURNAL.POST',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lines: lines as any,
  }));
}

beforeAll(async () => {
  const fx = await createTenant('tax-report');
  client = fx.client;
  company = fx.companyCode;
  await defineTestRanges(fx, { fiscalYear: 2026 });
  await seedAccounts(fx, ['170000']);
  await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select country from company_code where client = ${client} and company_code = ${company}`);
    country = (rows as unknown as Array<{ country: string }>)[0]?.country ?? '';
    await tx.execute(sql`
      insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, account_key, created_by)
      values (${client}, ${country}, 'I1', 'Input tax 10', 'VST', 10, 'VST', ${ACTOR}),
             (${client}, ${country}, 'O1', 'Output tax 20', 'MWS', 20, 'MWS', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values (${client}, 'CA01', 'TAX', '', '', '240000', ${ACTOR}) on conflict do nothing
    `);
  });

  const input = await post([
    { glAccount: '240000', debitCredit: 'S', amount: '100.00', taxCode: 'I1' },
    { glAccount: '101000', debitCredit: 'H', amount: '100.00' },
  ], '2026-04-10');
  inputDocument = input.documentNumber;
  await post([
    { glAccount: '400000', debitCredit: 'S', amount: '200.00' },
    { glAccount: '240000', debitCredit: 'H', amount: '200.00', taxCode: 'O1' },
  ], '2026-04-20');
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
}, 180_000);

describe('SCR-097 advance tax return S_ALR_87012357 (R-145)', () => {
  it('extracts by code in test mode and changes no source document', async () => {
    const journals = await journalCount();
    const result = await executeTaxReport({ client, changedBy: ACTOR, selection: selection() });
    const i1 = result.lines.find((l) => l.taxCode === 'I1');
    const o1 = result.lines.find((l) => l.taxCode === 'O1');
    expect(i1).toMatchObject({ inputTax: 100, outputTax: 0, taxBase: 1000, accountKey: 'VST', ratePercent: 10 });
    expect(o1).toMatchObject({ inputTax: 0, outputTax: 200, taxBase: 1000, accountKey: 'MWS', ratePercent: 20 });
    expect(result.netTax).toBe(100);
    expect(result.runId).toBeTruthy(); // the audit log records test runs too
    expect(await stampedCount()).toBe(0);
    expect(await journalCount()).toBe(journals);
  });

  it('stamps on update, excludes stamped lines, and re-includes them when corrected', async () => {
    const updated = await executeTaxReport({
      client, changedBy: ACTOR, selection: selection({ testRun: false }),
    });
    expect(updated.lines.reduce((s, l) => s + l.documentCount, 0)).toBe(2);
    expect(await stampedCount()).toBe(2);

    const again = await executeTaxReport({
      client, changedBy: ACTOR, selection: selection({ testRun: false }),
    });
    expect(again.lines).toEqual([]);
    expect(again.warnings.join(' ')).toContain('already stand reported');

    const corrected = await executeTaxReport({
      client, changedBy: ACTOR, selection: selection({ testRun: false, correctedReturn: true }),
    });
    expect(corrected.lines).toHaveLength(2);
    expect(corrected.netTax).toBe(100);
  });

  it('posts the clearing transfer on a corrected update run and nets reversals', async () => {
    const journals = await journalCount();
    const result = await executeTaxReport({
      client, changedBy: ACTOR,
      selection: selection({ testRun: false, correctedReturn: true, clearingAccount: '170000' }),
    });
    expect(result.transferDocumentNumber).toBeTruthy();
    expect(await journalCount()).toBe(journals + 1);
    const transfer = await withTenant(client, async (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_document from journal_entry_line
      where client = ${client} and document_number = ${result.transferDocumentNumber}
      order by line_number
    `));
    const rows = transfer as unknown as Array<Record<string, string>>;
    expect(rows[0]).toMatchObject({ gl_account: '240000', debit_credit: 'S' });
    expect(rows[1]).toMatchObject({ gl_account: '170000', debit_credit: 'H' });
    expect(Number(rows[0].amount_document)).toBe(100);

    await withTenant(client, async (tx) => reverseJournalEntry(tx, {
      client, documentNumber: inputDocument, fiscalYear: 2026,
      reversalDate: '2026-04-25', reason: 'Supplier credit note', reversedBy: ACTOR,
      reversalDocumentType: 'AB',
    }));
    const after = await executeTaxReport({
      client, changedBy: ACTOR, selection: selection({ correctedReturn: true }),
    });
    const i1 = after.lines.find((l) => l.taxCode === 'I1');
    expect(i1?.inputTax).toBe(0); // the mirror nets, never reclassifies
    expect(i1?.outputTax).toBe(0);
    expect(after.netTax).toBe(200);
  });

  it('refuses a mismatched country and an inverted window', async () => {
    await expect(executeTaxReport({
      client, changedBy: ACTOR, selection: selection({ taxReturnCountry: 'ZZ' }),
    })).rejects.toThrow('does not match company');
    await expect(executeTaxReport({
      client, changedBy: ACTOR,
      selection: selection({ postingDateFrom: '2026-05-01', postingDateTo: '2026-04-01' }),
    })).rejects.toThrow('not a valid range');
  });
});
