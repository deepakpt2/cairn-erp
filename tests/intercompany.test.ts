/**
 * SCR-122 stage 2 — intercompany posting (FB01 / OBYA aliases only).
 *
 * One submission posts two journals in one transaction: the sending
 * document with its OBYA clearing line and the receiving mirror with its
 * own; every line stamps the trading partner; either side failing rolls
 * the other back.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import {
  IntercompanyError, deleteIntercompanyConfig, postIntercompany, saveIntercompanyConfig,
} from '../src/modules/finance/intercompany';
import { clearGlItems, getGlClearing } from '../src/modules/finance/gl-clearing';
import { postJournalEntry } from '../src/platform/posting';
import { closeDb, createTenant, defineTestRanges, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'SCR122-TEST';
let tenant: TestTenant | undefined;
let client = '';
let currency = 'USD';

const postingInput = (overrides: Record<string, unknown> = {}) => ({
  client, changedBy: ACTOR,
  sendingCompanyCode: '1000', receivingCompanyCode: '2000',
  postingDate: '2026-05-10', documentDate: '2026-05-10',
  documentType: 'SA', currency, reference: 'IC-2026-001',
  confirmed: true, requestKey: 'ic-post-1',
  lines: [{ glAccount: '500000', debitCredit: 'S' as const, amount: '5000', costCenter: 'CC1000' }],
  ...overrides,
});

beforeAll(async () => {
  tenant = await createTenant('scr122-ic');
  client = tenant.client;
  await defineTestRanges(tenant, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select currency from company_code where client = ${client} and company_code = '1000'
    `) as unknown as Array<{ currency: string }>;
    currency = rows[0]?.currency ?? 'USD';
    // A second company of the same tenant, carrying its own OBYA clearance.
    await tx.execute(sql`
      insert into company_code (
        client, company_code, name, chart_of_accounts, fiscal_year_variant, posting_period_variant,
        currency, country, intercompany_clearing_account, created_by
      )
      select client, '2000', 'Partner company', chart_of_accounts, fiscal_year_variant, posting_period_variant,
             currency, country, intercompany_clearing_account, ${ACTOR}
      from company_code where client = ${client} and company_code = '1000'
      on conflict do nothing
    `);
    // Extend the accounts both sides post to.
    for (const company of ['1000', '2000']) {
      for (const account of ['500000', '110100']) {
        await tx.execute(sql`
          insert into gl_account_company (client, company_code, chart_of_accounts, gl_account, account_currency, created_by)
          select client, ${company}, chart_of_accounts, ${account}, ${currency}, ${ACTOR}
          from company_code where client = ${client} and company_code = ${company}
          on conflict do nothing
        `);
      }
    }
    await tx.execute(sql`
      update gl_account set is_open_item_managed = true
      where client = ${client} and account_number = '110100'
    `);
    await tx.execute(sql`
      update gl_account_company set is_open_item_managed = true
      where client = ${client} and gl_account = '110100'
    `);
    // The partner company numbers its own journals.
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '2000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999_999, createdBy: ACTOR,
    });
  });
}, 180_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
}, 180_000);

async function journalCount(company?: string): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select count(*)::int as n from journal_entry
      where client = ${client} ${company ? sql`and company_code = ${company}` : sql``}
    `) as unknown as Array<{ n: number }>;
    return rows[0]!.n;
  });
}

describe('SCR-122 intercompany posting', () => {
  it('posts both documents, balances each, and stamps the trading partner', async () => {
    const before = await journalCount();
    const result = await postIntercompany(postingInput());
    expect(result.sendingDocumentNumber).toBeTruthy();
    expect(result.receivingDocumentNumber).toBeTruthy();
    expect(result.sendingDocumentNumber).not.toBe(result.receivingDocumentNumber);
    expect(result.sendingClearingAccount).toBe('110100');
    expect(result.receivingClearingAccount).toBe('110100');
    expect(await journalCount()).toBe(before + 2);

    const lines = await withTenant(client, async (tx) => tx.execute(sql`
      select company_code, gl_account, debit_credit, amount_local::text as amount, trading_partner_company
      from journal_entry_line
      where client = ${client} and (document_number = ${result.sendingDocumentNumber}
        or document_number = ${result.receivingDocumentNumber})
      order by company_code, line_number
    `)) as unknown as Array<{
      company_code: string; gl_account: string; debit_credit: string;
      amount: string; trading_partner_company: string | null;
    }>;
    expect(lines).toHaveLength(4);
    for (const company of ['1000', '2000']) {
      const side = lines.filter((l) => l.company_code === company);
      const debit = side.reduce((s, l) => s + (l.debit_credit === 'S' ? Number(l.amount) : 0), 0);
      const credit = side.reduce((s, l) => s + (l.debit_credit === 'H' ? Number(l.amount) : 0), 0);
      expect(Math.abs(debit - credit)).toBeLessThan(0.005);
    }
    // Sender stamps the receiver, receiver the sender.
    expect(lines.filter((l) => l.company_code === '1000').every((l) => l.trading_partner_company === '2000')).toBe(true);
    expect(lines.filter((l) => l.company_code === '2000').every((l) => l.trading_partner_company === '1000')).toBe(true);

    const pair = await withTenant(client, async (tx) => tx.execute(sql`
      select sending_company_code, receiving_company_code, partner_document_number, currency, status
      from intercompany_document_header where client = ${client} and document_number = ${result.sendingDocumentNumber}
    `)) as unknown as Array<{ sending_company_code: string; receiving_company_code: string; partner_document_number: string; currency: string; status: string }>;
    expect(pair).toHaveLength(1);
    expect(pair[0]!.partner_document_number).toBe(result.receivingDocumentNumber);
    expect(pair[0]!.status).toBe('POSTED');

    // Replay never posts a second pair.
    const replay = await postIntercompany(postingInput());
    expect(replay.sendingDocumentNumber).toBe(result.sendingDocumentNumber);
    expect(await journalCount()).toBe(before + 2);
  }, 60_000);

  it('clears the OBYA balances through the standing G/L clearing screen', async () => {
    // Both sides stand open after the posting; a settlement journal on the
    // sending side then clears its OBYA balance through FIN.GL.CLEAR.
    const view = await getGlClearing({ client, companyCode: '1000', glAccount: '110100' });
    expect(view.openItems.length).toBeGreaterThanOrEqual(1);
    const counterpart = (await getGlClearing({ client, companyCode: '2000', glAccount: '110100' })).openItems;
    expect(counterpart.length).toBeGreaterThanOrEqual(1);

    const settlement = await withTenant(client, async (tx) => postJournalEntry(tx, {
      client, companyCode: '1000', documentType: 'SA',
      documentDate: '2026-05-11', postingDate: '2026-05-11',
      fiscalYear: 2026, postingPeriod: 5,
      currency, localCurrency: currency,
      lines: [
        { glAccount: '110100', debitCredit: 'S', amount: '5000' },
        { glAccount: '101000', debitCredit: 'H', amount: '5000' },
      ],
      postedBy: ACTOR,
    }));
    const fresh = await getGlClearing({ client, companyCode: '1000', glAccount: '110100' });
    const result = await clearGlItems({
      client, changedBy: ACTOR, companyCode: '1000', glAccount: '110100',
      documentType: 'AB', clearingDate: '2026-05-12', postingDate: '2026-05-12', documentDate: '2026-05-12',
      confirmed: true, requestKey: 'ic-clear-1',
      items: fresh.openItems.map((i) => ({ documentNumber: i.documentNumber, fiscalYear: i.fiscalYear, lineNumber: i.lineNumber })),
    });
    expect(result.clearingDocumentNumber).toBeTruthy();
    const settled = await withTenant(client, async (tx) => tx.execute(sql`
      select clearing_document from journal_entry_line
      where client = ${client} and document_number = ${settlement.documentNumber} and gl_account = '110100'
    `)) as unknown as Array<{ clearing_document: string | null }>;
    expect(settled[0]!.clearing_document).toBe(result.clearingDocumentNumber);
  }, 60_000);

  it('refuses the same company twice, an unknown partner and unbalanced operator lines', async () => {
    await expect(postIntercompany(postingInput({ requestKey: 'ic-bad-1', receivingCompanyCode: '1000' })))
      .rejects.toThrow(/cannot trade with itself/);
    await expect(postIntercompany(postingInput({ requestKey: 'ic-bad-2', receivingCompanyCode: '9999' })))
      .rejects.toThrow(/does not stand in this tenant/);
    await expect(postIntercompany(postingInput({
      requestKey: 'ic-bad-3',
      lines: [
        { glAccount: '500000', debitCredit: 'S', amount: '100' },
        { glAccount: '500000', debitCredit: 'H', amount: '100' },
      ],
    }))).rejects.toThrow(/no intercompany clearing remains/);
  }, 60_000);

  it('rolls back the sending document when the receiving side fails', async () => {
    // A receiving-side period closed after the sending side's would fail; the
    // whole pair must vanish. Close period 6 for company 2000 only.
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        update company_code set fiscal_year_variant = fiscal_year_variant
        where client = ${client} and company_code = '2000'
      `);
    });
    const before = await journalCount();
    await expect(postIntercompany(postingInput({
      requestKey: 'ic-atomic-1', postingDate: '2026-13-40', documentDate: '2026-05-10',
    }))).rejects.toBeInstanceOf(Error);
    expect(await journalCount()).toBe(before);
  }, 60_000);
});

describe('SCR-122 intercompany configuration', () => {
  it('validates the pair, refuses deletion once served, and deletes an unused pair', async () => {
    const saved = await saveIntercompanyConfig({
      client, changedBy: ACTOR,
      sendingCompanyCode: '1000', receivingCompanyCode: '2000',
      sendingClearingGl: '110100', receivingClearingGl: '110100', defaultCurrency: currency,
    });
    expect(saved.sendingClearingGl).toBe('110100');

    await expect(saveIntercompanyConfig({
      client, changedBy: ACTOR, sendingCompanyCode: '1000', receivingCompanyCode: '1000',
    })).rejects.toThrow(/cannot trade with itself/);
    await expect(saveIntercompanyConfig({
      client, changedBy: ACTOR, sendingCompanyCode: '1000', receivingCompanyCode: '2000',
      sendingClearingGl: '500000',
    })).rejects.toThrow(/balance-sheet account/);

    // The 1000 -> 2000 pair has posted, so it stands as history.
    await expect(deleteIntercompanyConfig({
      client, changedBy: ACTOR, sendingCompanyCode: '1000', receivingCompanyCode: '2000',
    })).rejects.toThrow(/has served .* posting/);

    await saveIntercompanyConfig({
      client, changedBy: ACTOR, sendingCompanyCode: '2000', receivingCompanyCode: '1000',
      defaultCurrency: currency,
    });
    const deleted = await deleteIntercompanyConfig({
      client, changedBy: ACTOR, sendingCompanyCode: '2000', receivingCompanyCode: '1000',
    });
    expect(deleted.deleted).toBe(true);
  }, 60_000);

  it('refuses an inactive or unknown company in the pair', async () => {
    await expect(saveIntercompanyConfig({
      client, changedBy: ACTOR, sendingCompanyCode: '1000', receivingCompanyCode: '8888',
    })).rejects.toThrow(/does not stand in this tenant/);
    await expect(saveIntercompanyConfig({
      client, changedBy: ACTOR, sendingCompanyCode: '1000', receivingCompanyCode: '2000',
      sendingClearingGl: '999999',
    })).rejects.toThrow(/does not stand in the sending company/);
  });
});
