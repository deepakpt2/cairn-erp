/**
 * Posting engine — CAIRN.md §5.2 (E6), §5.3, §14.1, D-017
 *
 * The claims under test:
 *   1. A balanced document posts, and leaves a complete trace behind it.
 *   2. An unbalanced document is refused by the engine, with a message that
 *      explains the difference rather than just rejecting.
 *   3. An unbalanced document is ALSO refused by the database — even when the
 *      engine is bypassed entirely. Two independent defences, because this is the
 *      one rule the whole ledger rests on.
 *   4. Reversal mirrors the original, links both ways, and deletes nothing.
 *   5. Money is exact: 0.1 + 0.2 behaves like 0.3, at four decimal places.
 */
import { describe, expect, it, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTenant, closeDb } from '@/platform/db/client';
import { postJournalEntry, reverseJournalEntry, PostingError } from '@/platform/posting';
import { documentFlow } from '@/platform/document';
import {
  createTenant,
  defineTestRanges,
  seedAccounts,
  destroyTenant,
  type TestTenant,
} from './helpers';

const tenant: TestTenant = await createTenant('posting');
await defineTestRanges(tenant);
await seedAccounts(tenant, ['100000', '200000', '400000', '600000']);
const fiscalYear = new Date().getUTCFullYear();

afterAll(async () => {
  await destroyTenant(tenant.client);
  await closeDb();
});

const basePosting = {
  client: tenant.client,
  companyCode: tenant.companyCode,
  documentType: 'SA',
  documentDate: `${fiscalYear}-03-15`,
  postingDate: `${fiscalYear}-03-15`,
  fiscalYear,
  postingPeriod: 3,
  currency: 'USD',
  localCurrency: 'USD',
  postedBy: 'TESTUSER',
};

describe('posting engine', () => {
  it('posts a balanced document and writes the full trace', async () => {
    const result = await withTenant(tenant.client, (tx) =>
      postJournalEntry(tx, {
        ...basePosting,
        headerText: 'Office supplies',
        reference: 'INV-001',
        lines: [
          { glAccount: '600000', debitCredit: 'S', amount: '250.0000', lineText: 'Expense' },
          { glAccount: '200000', debitCredit: 'H', amount: '250.0000', lineText: 'Payable' },
        ],
      }),
    );

    expect(result.debitTotal).toBe('250.0000');
    expect(result.creditTotal).toBe('250.0000');
    expect(result.lineCount).toBe(2);
    expect(result.displayNumber).toMatch(/^JE-\d{4}-\d{6}$/);

    // The document exists with its lines.
    const lines = await withTenant(tenant.client, (tx) =>
      tx.execute(sql`
        select line_number, gl_account, debit_credit, amount_local
        from journal_entry_line
        where client = ${tenant.client} and document_number = ${result.documentNumber}
        order by line_number
      `),
    );
    expect((lines as unknown as unknown[]).length).toBe(2);

    // It is in the cross-class index, so global search finds it.
    const indexed = await withTenant(tenant.client, (tx) =>
      tx.execute(sql`
        select display_number, status from document_index
        where client = ${tenant.client} and document_key = ${result.documentNumber}
      `),
    );
    expect((indexed as unknown as Array<{ status: string }>)[0]?.status).toBe('POSTED');

    // And its status transition is recorded.
    const history = await withTenant(tenant.client, (tx) =>
      tx.execute(sql`
        select new_status from document_status_history
        where client = ${tenant.client} and document_key = ${result.documentNumber}
      `),
    );
    expect((history as unknown as Array<{ new_status: string }>)[0]?.new_status).toBe('POSTED');
  });

  it('adds decimal amounts exactly, with no floating-point drift', async () => {
    // 0.1 + 0.2 === 0.30000000000000004 in binary floating point. It must not here.
    const result = await withTenant(tenant.client, (tx) =>
      postJournalEntry(tx, {
        ...basePosting,
        headerText: 'Exact decimal check',
        lines: [
          { glAccount: '600000', debitCredit: 'S', amount: '0.1000' },
          { glAccount: '600000', debitCredit: 'S', amount: '0.2000' },
          { glAccount: '200000', debitCredit: 'H', amount: '0.3000' },
        ],
      }),
    );
    expect(result.debitTotal).toBe('0.3000');
  });

  it('refuses an unbalanced document and says by how much', async () => {
    const error = (await withTenant(tenant.client, (tx) =>
      postJournalEntry(tx, {
        ...basePosting,
        headerText: 'Deliberately unbalanced',
        lines: [
          { glAccount: '600000', debitCredit: 'S', amount: '100.0000' },
          { glAccount: '200000', debitCredit: 'H', amount: '90.0000' },
        ],
      }),
    ).catch((e) => e)) as PostingError;

    expect(error).toBeInstanceOf(PostingError);
    expect(error.message).toContain('does not balance');
    // The message names the amount, not just the fact of failure.
    expect(error.message).toContain('10.0000');
    expect(error.remedy).toContain('total debits equal total credits');
  });

  it('refuses a zero-amount line', async () => {
    const error = (await withTenant(tenant.client, (tx) =>
      postJournalEntry(tx, {
        ...basePosting,
        lines: [
          { glAccount: '600000', debitCredit: 'S', amount: '0.0000' },
          { glAccount: '200000', debitCredit: 'H', amount: '0.0000' },
        ],
      }),
    ).catch((e) => e)) as PostingError;

    expect(error).toBeInstanceOf(PostingError);
    expect(error.message).toContain('zero amount');
  });

  it('refuses a negative amount, pointing the user at the debit/credit indicator', async () => {
    const error = (await withTenant(tenant.client, (tx) =>
      postJournalEntry(tx, {
        ...basePosting,
        lines: [
          { glAccount: '600000', debitCredit: 'S', amount: '-100.0000' },
          { glAccount: '200000', debitCredit: 'H', amount: '100.0000' },
        ],
      }),
    ).catch((e) => e)) as PostingError;

    expect(error).toBeInstanceOf(PostingError);
    expect(error.message).toContain('negative amount');
    expect(error.remedy).toContain('debit or credit');
  });

  it('refuses a single-line document', async () => {
    const error = (await withTenant(tenant.client, (tx) =>
      postJournalEntry(tx, {
        ...basePosting,
        lines: [{ glAccount: '600000', debitCredit: 'S', amount: '100.0000' }],
      }),
    ).catch((e) => e)) as PostingError;

    expect(error).toBeInstanceOf(PostingError);
    expect(error.message).toContain('at least two');
  });

  /**
   * The second line of defence. This test deliberately bypasses the posting
   * engine and writes raw SQL, exactly as a future migration or a hurried hotfix
   * might. The deferred constraint trigger must still refuse the commit.
   */
  it('the DATABASE refuses an unbalanced document even when the engine is bypassed', async () => {
    const documentNumber = `RAW-${Date.now()}`;

    const attempt = withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into journal_entry
          (client, document_number, fiscal_year, document_type, company_code,
           document_date, posting_date, posting_period, document_currency,
           local_currency, status, created_by)
        values
          (${tenant.client}, ${documentNumber}, ${fiscalYear}, 'SA', ${tenant.companyCode},
           ${`${fiscalYear}-04-01`}, ${`${fiscalYear}-04-01`}, 4, 'USD',
           'USD', 'POSTED', 'BYPASS_TEST')
      `);

      // Written directly, with no engine validation at all.
      await tx.execute(sql`
        insert into journal_entry_line
          (client, document_number, fiscal_year, line_number, gl_account,
           company_code, debit_credit, amount_local, amount_document, currency)
        values
          (${tenant.client}, ${documentNumber}, ${fiscalYear}, 1, '600000',
           ${tenant.companyCode}, 'S', 500.0000, 500.0000, 'USD'),
          (${tenant.client}, ${documentNumber}, ${fiscalYear}, 2, '200000',
           ${tenant.companyCode}, 'H', 400.0000, 400.0000, 'USD')
      `);
    });

    await expect(attempt).rejects.toThrow(/CAIRN_UNBALANCED|does not balance/);

    // And nothing survived the failure.
    const remaining = await withTenant(tenant.client, (tx) =>
      tx.execute(sql`
        select count(*)::int as count from journal_entry
        where client = ${tenant.client} and document_number = ${documentNumber}
      `),
    );
    const rows = remaining as unknown as Array<{ count: number }>;
    expect(rows[0]?.count).toBe(0);
  });

  it('reverses a document by mirroring it, deleting nothing', async () => {
    const original = await withTenant(tenant.client, (tx) =>
      postJournalEntry(tx, {
        ...basePosting,
        headerText: 'To be reversed',
        lines: [
          { glAccount: '600000', debitCredit: 'S', amount: '400.0000', costCenter: 'CC-1000' },
          { glAccount: '200000', debitCredit: 'H', amount: '400.0000' },
        ],
      }),
    );

    const reversal = await withTenant(tenant.client, (tx) =>
      reverseJournalEntry(tx, {
        client: tenant.client,
        documentNumber: original.documentNumber,
        fiscalYear,
        reversalDate: `${fiscalYear}-03-20`,
        reason: 'Posted to the wrong cost centre',
        reversedBy: 'APPROVER',
      }),
    );

    expect(reversal.documentNumber).not.toBe(original.documentNumber);

    // The original still exists — marked reversed, pointing at its reversal.
    const originalRow = await withTenant(tenant.client, (tx) =>
      tx.execute(sql`
        select status, reversed_by from journal_entry
        where client = ${tenant.client} and document_number = ${original.documentNumber}
      `),
    );
    const header = (originalRow as unknown as Array<{ status: string; reversed_by: string }>)[0];
    expect(header.status).toBe('REVERSED');
    expect(header.reversed_by).toBe(reversal.documentNumber);

    // The original's lines are untouched — no data was rewritten.
    const originalLines = await withTenant(tenant.client, (tx) =>
      tx.execute(sql`
        select debit_credit, amount_local, cost_center from journal_entry_line
        where client = ${tenant.client} and document_number = ${original.documentNumber}
        order by line_number
      `),
    );
    const lines = originalLines as unknown as Array<{
      debit_credit: string;
      cost_center: string | null;
    }>;
    expect(lines[0].debit_credit).toBe('S');
    expect(lines[0].cost_center).toBe('CC-1000');

    // The reversal has the indicators swapped, so the pair nets to zero.
    const reversalLines = await withTenant(tenant.client, (tx) =>
      tx.execute(sql`
        select debit_credit, amount_local, cost_center from journal_entry_line
        where client = ${tenant.client} and document_number = ${reversal.documentNumber}
        order by line_number
      `),
    );
    const reversed = reversalLines as unknown as Array<{
      debit_credit: string;
      amount_local: string;
      cost_center: string | null;
    }>;
    expect(reversed[0].debit_credit).toBe('H');
    expect(reversed[0].amount_local).toBe('400.0000');
    // Account assignments carry across, so the reversal lands in the same place.
    expect(reversed[0].cost_center).toBe('CC-1000');

    // The document flow links them in both directions.
    const flow = await withTenant(tenant.client, (tx) =>
      documentFlow(tx, {
        client: tenant.client,
        documentClass: 'journal_entry',
        documentKey: original.documentNumber,
      }),
    );
    expect(flow.children.map((c) => c.documentKey)).toContain(reversal.documentNumber);
  });

  it('refuses to reverse a document twice', async () => {
    const original = await withTenant(tenant.client, (tx) =>
      postJournalEntry(tx, {
        ...basePosting,
        lines: [
          { glAccount: '600000', debitCredit: 'S', amount: '50.0000' },
          { glAccount: '200000', debitCredit: 'H', amount: '50.0000' },
        ],
      }),
    );

    await withTenant(tenant.client, (tx) =>
      reverseJournalEntry(tx, {
        client: tenant.client,
        documentNumber: original.documentNumber,
        fiscalYear,
        reversalDate: `${fiscalYear}-03-21`,
        reason: 'First reversal',
        reversedBy: 'APPROVER',
      }),
    );

    const error = (await withTenant(tenant.client, (tx) =>
      reverseJournalEntry(tx, {
        client: tenant.client,
        documentNumber: original.documentNumber,
        fiscalYear,
        reversalDate: `${fiscalYear}-03-22`,
        reason: 'Second reversal',
        reversedBy: 'APPROVER',
      }),
    ).catch((e) => e)) as PostingError;

    expect(error).toBeInstanceOf(PostingError);
    expect(error.message).toContain('already been reversed');
  });

  it('links a posting to the document that caused it', async () => {
    const origin = { documentClass: 'goods_receipt', documentKey: 'GR-000123' };

    const result = await withTenant(tenant.client, (tx) =>
      postJournalEntry(tx, {
        ...basePosting,
        headerText: 'Goods receipt posting',
        origin,
        lines: [
          { glAccount: '100000', debitCredit: 'S', amount: '1200.0000' },
          { glAccount: '200000', debitCredit: 'H', amount: '1200.0000' },
        ],
      }),
    );

    const flow = await withTenant(tenant.client, (tx) =>
      documentFlow(tx, {
        client: tenant.client,
        documentClass: 'journal_entry',
        documentKey: result.documentNumber,
      }),
    );

    const parentKeys = flow.parents.map((p) => p.documentKey);
    expect(parentKeys).toContain('GR-000123');
  });
});
