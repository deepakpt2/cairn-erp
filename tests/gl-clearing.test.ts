/**
 * SCR-114 / R-162 stage 5 — clear G/L account (F-03).
 *
 * Open items of an open-item-managed account clear under one
 * balanced clearing journal through the posting engine; the
 * cleared lines are stamped in place. Unbalanced selections,
 * non-open-item accounts and items taken by another clearing
 * are refused; a retried request replays, never re-clears.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { postGlDocument } from '../src/modules/finance/gl-document';
import { postJournalEntry } from '../src/platform/posting';
import { resetClearing } from '../src/modules/finance/clearing-reset';
import {
  clearGlItems, getGlClearing, GlClearingError,
  type GlClearingItemRef,
} from '../src/modules/finance/gl-clearing';
import { closeDb, createTenant, defineTestRanges, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'SCR114-TEST';
const TODAY = '2026-05-20';
let tenant: TestTenant | undefined;
let client = '';
let currency = 'USD';
let refs: GlClearingItemRef[] = [];

async function post(amount: string, debit: string, credit: string, key: string, date: string) {
  const doc = await postGlDocument({
    client, changedBy: ACTOR, requestKey: key, companyCode: '1000',
    documentDate: date, postingDate: date, documentType: 'SA', currency,
    lines: [
      { glAccount: debit, debitCredit: 'S', amount },
      { glAccount: credit, debitCredit: 'H', amount },
    ],
  });
  return doc;
}

async function journalCount(): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
    return rows[0]!.n;
  });
}

beforeAll(async () => {
  tenant = await createTenant('scr114-glclear');
  client = tenant.client;
  await defineTestRanges(tenant, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select currency from company_code where client = ${client} and company_code = '1000'
    `) as unknown as Array<{ currency: string }>;
    currency = rows[0]?.currency ?? 'USD';
    await tx.execute(sql`
      update gl_account set is_open_item_managed = true
      where client = ${client} and account_number = '400000'
    `);
  });
  const first = await post('5000', '400000', '101000', 'gl-2026-1', '2026-04-10');
  const second = await post('5000', '101000', '400000', 'gl-2026-2', '2026-04-12');
  refs = [
    { documentNumber: first.documentNumber, fiscalYear: 2026, lineNumber: 1 },
    { documentNumber: second.documentNumber, fiscalYear: 2026, lineNumber: 2 },
  ];
}, 180_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
}, 180_000);

const clearingInput = (overrides: Record<string, unknown> = {}) => ({
  client, changedBy: ACTOR, companyCode: '1000', glAccount: '400000',
  documentType: 'AB', clearingDate: TODAY, postingDate: TODAY, documentDate: TODAY,
  confirmed: true, requestKey: 'scr114-clear-1', items: refs, ...overrides,
});

describe('SCR-114 clear G/L account (R-162)', () => {
  it('refuses accounts that do not stand open-item managed', async () => {
    await expect(getGlClearing({ client, companyCode: '1000', glAccount: '300000' }))
      .rejects.toThrow(/open-item managed/);
  });

  it('lists the open items with a zero standing balance', async () => {
    const view = await getGlClearing({ client, companyCode: '1000', glAccount: '400000' });
    expect(view.openItems).toHaveLength(2);
    expect(view.openBalance).toBe(0);
    expect(view.clearedItems).toHaveLength(0);
  });

  it('refuses an unbalanced selection and an unconfigured document type', async () => {
    await expect(clearGlItems(clearingInput({ items: [refs[0]!] })))
      .rejects.toThrow(/do not balance/);
    await expect(clearGlItems(clearingInput({ documentType: 'ZZ' })))
      .rejects.toBeInstanceOf(GlClearingError);
  });

  it('posts the clearing journal, stamps the lines, and replays on retry', async () => {
    const before = await journalCount();
    const result = await clearGlItems(clearingInput());
    expect(result.clearingDocumentNumber).toBeTruthy();
    expect(result.clearingFiscalYear).toBe(2026);
    expect(await journalCount()).toBe(before + 1);
    expect(result.openItems).toHaveLength(0);
    expect(result.clearedItems.length).toBeGreaterThanOrEqual(2);

    const replay = await clearGlItems(clearingInput());
    expect(replay.clearingDocumentNumber).toBe(result.clearingDocumentNumber);
    expect(await journalCount()).toBe(before + 1); // no second clearing

    await expect(clearGlItems(clearingInput({ requestKey: 'scr114-clear-2' })))
      .rejects.toThrow(/already stands cleared by/);
  });
});

describe('SCR-114 follow-up: tolerance difference posting (B-805)', () => {
  async function postPair(debitAmount: string, creditAmount: string, key: string) {
    const debit = await post(debitAmount, '400000', '101000', `${key}-d`, '2026-04-15');
    const credit = await post(creditAmount, '101000', '400000', `${key}-c`, '2026-04-16');
    return [
      { documentNumber: debit.documentNumber, fiscalYear: 2026, lineNumber: 1 },
      { documentNumber: credit.documentNumber, fiscalYear: 2026, lineNumber: 2 },
    ] as GlClearingItemRef[];
  }

  it('refuses a difference while no default tolerance group stands', async () => {
    const pair = await postPair('100', '95', 'tol-none');
    const err = await clearGlItems(clearingInput({ requestKey: 'tol-none-clear', items: pair })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GlClearingError);
    expect(`${(err as GlClearingError).message} ${(err as GlClearingError).remedy ?? ''}`)
      .toMatch(/maintain the default tolerance group/);
  });

  it('posts a within-tolerance difference to the determined account and clears in full', async () => {
    await withTenant(client, async (tx) => {
      const [company] = await tx.execute(sql`
        select chart_of_accounts as chart from company_code where client = ${client} and company_code = '1000'
      `) as unknown as [{ chart: string }];
      await tx.execute(sql`
        insert into employee_tolerance_group
          (client, company_code, group_key, max_document_amount, max_line_amount, max_cash_discount_percent,
           payment_diff_revenue_amount, payment_diff_expense_amount, payment_diff_revenue_percent, payment_diff_expense_percent,
           created_by)
        values (${client}, '', '', 0, 0, 0, 10, 10, 50, 50, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        values (${client}, ${company.chart}, 'PAYMENT_DIFFERENCE', '', 'EXP', '310000', ${ACTOR}),
               (${client}, ${company.chart}, 'PAYMENT_DIFFERENCE', '', 'REV', '320000', ${ACTOR})
      `);
    });

    const view = await getGlClearing({ client, companyCode: '1000', glAccount: '400000' });
    expect(view.differenceTolerance?.expenseAmount).toBe(10);

    const pair = await postPair('1000', '995', 'tol-within');
    const before = await journalCount();
    const result = await clearGlItems(clearingInput({ requestKey: 'tol-within-clear', items: pair }));
    expect(await journalCount()).toBe(before + 1);

    const lines = await withTenant(client, async (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_local::text as amount, clearing_document
      from journal_entry_line
      where client = ${client} and document_number = ${result.clearingDocumentNumber}
      order by line_number
    `)) as unknown as Array<{ gl_account: string; debit_credit: string; amount: string; clearing_document: string | null }>;
    const difference = lines.find((l) => l.gl_account === '310000');
    expect(difference?.debit_credit).toBe('S');
    expect(Number(difference?.amount)).toBe(5);
    expect(difference?.clearing_document).toBeNull(); // stands as an ordinary expense line
    expect(result.clearedItems.some((i) => i.documentNumber === pair[0]!.documentNumber)).toBe(true);
  });

  it('refuses a difference beyond the tolerance of the default group', async () => {
    const pair = await postPair('1000', '900', 'tol-beyond');
    const before = await journalCount();
    const err = await clearGlItems(clearingInput({ requestKey: 'tol-beyond-clear', items: pair })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GlClearingError);
    expect(`${(err as GlClearingError).message} ${(err as GlClearingError).remedy ?? ''}`)
      .toMatch(/beyond the tolerance of the default group/);
    expect(await journalCount()).toBe(before);
  });
});

describe('SCR-114 advanced clearing B-808: partial clearing', () => {
  async function postBoth(debitAmount: string, creditAmount: string, key: string) {
    const debit = await post(debitAmount, '400000', '101000', `${key}-d`, '2026-04-18');
    const credit = await post(creditAmount, '101000', '400000', `${key}-c`, '2026-04-19');
    return [
      { documentNumber: debit.documentNumber, fiscalYear: 2026, lineNumber: 1 },
      { documentNumber: credit.documentNumber, fiscalYear: 2026, lineNumber: 2 },
    ];
  }

  it('settles part of an item, keeps it open for the balance, and clears later', async () => {
    const [a, b] = await postBoth('1000', '600', 'part-1');
    const result = await clearGlItems(clearingInput({
      requestKey: 'part-clear-1', method: 'PARTIAL',
      items: [
        { ...a!, settlementAmount: '600' },
        { ...b!, settlementAmount: '600' },
      ],
    }));
    // A stays open for 400; B settles in full and stands cleared.
    const open = result.openItems.filter((i) => i.documentNumber === a!.documentNumber);
    expect(open).toHaveLength(1);
    expect(open[0]!.remaining).toBe(400);
    expect(open[0]!.applied).toBe(600);
    expect(result.openItems.some((i) => i.documentNumber === b!.documentNumber)).toBe(false);
    expect(result.openBalance).toBeGreaterThanOrEqual(400); // residual items from earlier cases stand open too

    const allocations = await withTenant(client, async (tx) => tx.execute(sql`
      select clearing_method, allocated_amount::text as amount, source_document
      from gl_clearing_allocation where client = ${client} and source_document = ${a!.documentNumber}
    `)) as unknown as Array<{ clearing_method: string; amount: string; source_document: string }>;
    expect(allocations).toHaveLength(1);
    expect(allocations[0]!.clearing_method).toBe('PARTIAL');
    expect(Number(allocations[0]!.amount)).toBe(600);

    // A second clearing settles the remaining 400 against a fresh credit item.
    const c = await post('400', '101000', '400000', 'part-2-fresh', '2026-04-20');
    const final = await clearGlItems(clearingInput({
      requestKey: 'part-clear-2', method: 'STANDARD',
      items: [a!, { documentNumber: c.documentNumber, fiscalYear: 2026, lineNumber: 2 }],
    }));
    expect(final.openItems.some((i) => i.documentNumber === a!.documentNumber)).toBe(false);
  }, 60_000);

  it('refuses a settlement above the remaining balance and zero settlement', async () => {
    const [a, b] = await postBoth('100', '50', 'part-3');
    await expect(clearGlItems(clearingInput({
      requestKey: 'part-bad-1', method: 'PARTIAL',
      items: [{ ...a!, settlementAmount: '150' }, b!],
    }))).rejects.toThrow(/exceeds its remaining/);
    await expect(clearGlItems(clearingInput({
      requestKey: 'part-bad-2', method: 'PARTIAL',
      items: [{ ...a!, settlementAmount: '0' }, b!],
    }))).rejects.toThrow(/must stand positive/);
    await expect(clearGlItems(clearingInput({
      requestKey: 'part-bad-3', method: 'PARTIAL',
      items: [{ ...a!, settlementAmount: '75' }, b!],
    }))).rejects.toThrow(/do not balance/);
  });
});

describe('SCR-114 advanced clearing B-808: residual clearing', () => {
  it('closes the original item and re-stands exactly one reasoned residual item', async () => {
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into residual_reason (client, reason_code, description, created_by)
        values (${client}, 'R01', 'Underpayment remainder', ${ACTOR})
      `);
    });
    const a = await post('1000', '400000', '101000', 'res-1-a', '2026-04-22');
    const b = await post('400', '101000', '400000', 'res-1-b', '2026-04-23');
    const result = await clearGlItems(clearingInput({
      requestKey: 'res-clear-1', method: 'RESIDUAL', residualReasonCode: 'R01',
      items: [
        { documentNumber: a.documentNumber, fiscalYear: 2026, lineNumber: 1, settlementAmount: '400' },
        { documentNumber: b.documentNumber, fiscalYear: 2026, lineNumber: 2, settlementAmount: '400' },
      ],
    }));
    // The original item is closed; exactly one residual line stands open.
    expect(result.residualItems).toHaveLength(1);
    expect(result.residualItems[0]!.amount).toBe('600.00');
    const open = result.openItems.filter((i) => i.documentNumber === result.clearingDocumentNumber);
    expect(open).toHaveLength(1);
    expect(open[0]!.debitCredit).toBe('S');
    expect(open[0]!.remaining).toBe(600);
    expect(result.openItems.some((i) => i.documentNumber === a.documentNumber)).toBe(false);
    expect(result.openItems.some((i) => i.documentNumber === b.documentNumber)).toBe(false);

    const lineage = await withTenant(client, async (tx) => tx.execute(sql`
      select reason_code, generated_amount::text as amount, original_document, residual_line_number
      from gl_clearing_residual where client = ${client} and original_document = ${a.documentNumber}
    `)) as unknown as Array<{ reason_code: string; amount: string; original_document: string; residual_line_number: number }>;
    expect(lineage).toHaveLength(1);
    expect(lineage[0]!.reason_code).toBe('R01');
    expect(Number(lineage[0]!.amount)).toBe(600);
    expect(lineage[0]!.residual_line_number).toBe(open[0]!.lineNumber);
  }, 60_000);

  it('refuses an unconfigured reason and a residual with no remainder', async () => {
    const a = await post('100', '400000', '101000', 'res-2-a', '2026-04-24');
    const b = await post('100', '101000', '400000', 'res-2-b', '2026-04-24');
    await expect(clearGlItems(clearingInput({
      requestKey: 'res-bad-1', method: 'RESIDUAL', residualReasonCode: 'ZZZ',
      items: [{ documentNumber: a.documentNumber, fiscalYear: 2026, lineNumber: 1, settlementAmount: '50' }, { documentNumber: b.documentNumber, fiscalYear: 2026, lineNumber: 2, settlementAmount: '50' }],
    }))).rejects.toThrow(/does not stand configured/);
    await expect(clearGlItems(clearingInput({
      requestKey: 'res-bad-2', method: 'RESIDUAL', residualReasonCode: 'R01',
      items: [{ documentNumber: a.documentNumber, fiscalYear: 2026, lineNumber: 1 }, { documentNumber: b.documentNumber, fiscalYear: 2026, lineNumber: 2 }],
    }))).rejects.toThrow(/no remainder to re-stand/);
    await expect(clearGlItems(clearingInput({
      requestKey: 'res-bad-3', method: 'RESIDUAL',
      items: [{ documentNumber: a.documentNumber, fiscalYear: 2026, lineNumber: 1 }, { documentNumber: b.documentNumber, fiscalYear: 2026, lineNumber: 2 }],
    }))).rejects.toThrow(/requires a residual reason code/);
  });
});

describe('SCR-114 advanced clearing B-808: multi-currency clearing', () => {
  async function postForeign(currencyCode: string, rate: string, debit: string, credit: string, amount: string, key: string) {
    void key;
    return withTenant(client, async (tx) => postJournalEntry(tx, {
      client, companyCode: '1000', documentType: 'SA',
      documentDate: '2026-04-25', postingDate: '2026-04-25',
      fiscalYear: 2026, postingPeriod: 4,
      currency: currencyCode, localCurrency: currency, exchangeRate: rate,
      lines: [
        { glAccount: debit, debitCredit: 'S', amount },
        { glAccount: credit, debitCredit: 'H', amount },
      ],
      postedBy: ACTOR,
    }));
  }

  it('clears across currencies at the clearing-date rates and posts the realized difference', async () => {
    const chart = await withTenant(client, async (tx) => {
      const [company] = await tx.execute(sql`
        select chart_of_accounts as chart from company_code where client = ${client} and company_code = '1000'
      `) as unknown as [{ chart: string }];
      for (const [from, rate] of [['EUR', '0.30'], ['GBP', '0.30']] as const) {
        await tx.execute(sql`
          insert into exchange_rate (client, rate_type, from_currency, to_currency, valid_from, rate, created_by)
          values (${client}, 'AVERAGE', ${from}, ${currency}, '2026-01-01', ${rate}, ${ACTOR})
          on conflict do nothing
        `);
      }
      for (const [event, account] of [['FXGAIN', '310000'], ['FXLOSS', '320000']] as const) {
        await tx.execute(sql`
          insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
          values (${client}, ${company.chart}, ${event}, '', '', ${account}, ${ACTOR})
          on conflict do nothing
        `);
      }
      return company.chart;
    });
    void chart;

    // Same foreign amount, differing historical carrying rates: 100 EUR at 0.30
    // (30 local) against 100 GBP at 0.31 (31 local).
    const usd = await postForeign('EUR', '0.30', '400000', '101000', '100', 'fx-eur');
    const eur = await postForeign('GBP', '0.31', '101000', '400000', '100', 'fx-gbp');

    await expect(clearGlItems(clearingInput({
      requestKey: 'fx-no-flag',
      items: [
        { documentNumber: usd.documentNumber, fiscalYear: 2026, lineNumber: 1 },
        { documentNumber: eur.documentNumber, fiscalYear: 2026, lineNumber: 2 },
      ],
    }))).rejects.toThrow(/one clearing settles one currency/);

    const result = await clearGlItems(clearingInput({
      requestKey: 'fx-clear-1', crossCurrency: true,
      items: [
        { documentNumber: usd.documentNumber, fiscalYear: 2026, lineNumber: 1 },
        { documentNumber: eur.documentNumber, fiscalYear: 2026, lineNumber: 2 },
      ],
    }));
    expect(result.openItems.some((i) => i.documentNumber === usd.documentNumber)).toBe(false);
    expect(result.openItems.some((i) => i.documentNumber === eur.documentNumber)).toBe(false);

    const doc = await withTenant(client, async (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_local::text as amount
      from journal_entry_line
      where client = ${client} and document_number = ${result.clearingDocumentNumber}
      order by line_number
    `)) as unknown as Array<{ gl_account: string; debit_credit: string; amount: string }>;
    // Credits 30 (USD carrying) + 1 (gain); debits 31 (EUR carrying).
    expect(doc).toHaveLength(3);
    const gain = doc.find((l) => l.gl_account === '310000');
    expect(gain?.debit_credit).toBe('H');
    expect(Number(gain?.amount)).toBe(1);
    const debit = doc.reduce((s, l) => s + (l.debit_credit === 'S' ? Number(l.amount) : 0), 0);
    const credit = doc.reduce((s, l) => s + (l.debit_credit === 'H' ? Number(l.amount) : 0), 0);
    expect(Math.abs(debit - credit)).toBeLessThan(0.005);

    // A currency with no rate to the local currency refuses by name.
    const jpy = await postForeign('JPY', '1', '400000', '101000', '100', 'fx-jpy');
    const eur2 = await postForeign('EUR', '0.30', '101000', '400000', '100', 'fx-eur-2');
    await expect(clearGlItems(clearingInput({
      requestKey: 'fx-missing-rate', crossCurrency: true,
      items: [
        { documentNumber: jpy.documentNumber, fiscalYear: 2026, lineNumber: 1 },
        { documentNumber: eur2.documentNumber, fiscalYear: 2026, lineNumber: 2 },
      ],
    }))).rejects.toThrow(/No AVERAGE rate stands from JPY/);
  }, 60_000);
});

describe('SCR-114 advanced clearing B-808: reset of partial and residual clearings', () => {
  it('lifts partial allocations and restores the original remaining balance', async () => {
    const a = await post('300', '400000', '101000', 'rst-1-a', '2026-04-26');
    const b = await post('200', '101000', '400000', 'rst-1-b', '2026-04-26');
    const cleared = await clearGlItems(clearingInput({
      requestKey: 'rst-clear-1', method: 'PARTIAL',
      items: [
        { documentNumber: a.documentNumber, fiscalYear: 2026, lineNumber: 1, settlementAmount: '200' },
        { documentNumber: b.documentNumber, fiscalYear: 2026, lineNumber: 2, settlementAmount: '200' },
      ],
    }));
    let view = await getGlClearing({ client, companyCode: '1000', glAccount: '400000' });
    const partial = view.openItems.find((i) => i.documentNumber === a.documentNumber);
    expect(partial?.remaining).toBe(100);

    await resetClearing({
      client, changedBy: ACTOR, companyCode: '1000',
      clearingDocument: cleared.clearingDocumentNumber, fiscalYear: cleared.clearingFiscalYear,
      reason: 'Settled wrongly',
    });
    view = await getGlClearing({ client, companyCode: '1000', glAccount: '400000' });
    const restored = view.openItems.find((i) => i.documentNumber === a.documentNumber);
    expect(restored?.remaining).toBe(300);
    expect(restored?.applied).toBe(0);
    expect(view.openItems.some((i) => i.documentNumber === b.documentNumber)).toBe(true);
  }, 60_000);

  it('refuses a plain reset of a residual clearing, naming the reversal', async () => {
    const a = await post('500', '400000', '101000', 'rst-2-a', '2026-04-27');
    const b = await post('200', '101000', '400000', 'rst-2-b', '2026-04-27');
    const cleared = await clearGlItems(clearingInput({
      requestKey: 'rst-clear-2', method: 'RESIDUAL', residualReasonCode: 'R01',
      items: [
        { documentNumber: a.documentNumber, fiscalYear: 2026, lineNumber: 1, settlementAmount: '200' },
        { documentNumber: b.documentNumber, fiscalYear: 2026, lineNumber: 2, settlementAmount: '200' },
      ],
    }));
    const err = await resetClearing({
      client, changedBy: ACTOR, companyCode: '1000',
      clearingDocument: cleared.clearingDocumentNumber, fiscalYear: cleared.clearingFiscalYear,
      reason: 'Attempt',
    }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/residual item/);
    expect((err as { remedy?: string }).remedy).toMatch(/Reverse the clearing document/);
  }, 60_000);
});

describe('SCR-114 follow-up B-816: residual terms inheritance', () => {
  it('stamps the source invoice terms, baseline and assignment onto the residual line', async () => {
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
        values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into vendor_invoice (
          client, invoice_number, fiscal_year, category, vendor_number, company_code,
          document_date, posting_date, reference, currency, gross_amount, tax_amount,
          payment_terms, baseline_date, due_date, status, created_by
        ) values (
          ${client}, 'VI-T1', 2026, 'INVOICE', 'V20000', '1000',
          '2026-04-28', '2026-04-28', 'VI-T1', ${currency}, 1000, 0,
          'NET30', '2026-04-28', '2026-05-28', 'POSTED', ${ACTOR}
        ) on conflict do nothing
      `);
    });
    const origin = await withTenant(client, async (tx) => postJournalEntry(tx, {
      client, companyCode: '1000', documentType: 'SA',
      documentDate: '2026-04-28', postingDate: '2026-04-28',
      fiscalYear: 2026, postingPeriod: 4,
      currency, localCurrency: currency,
      lines: [
        { glAccount: '400000', debitCredit: 'S', amount: '800', businessPartner: 'V20000', assignment: 'PO-778' },
        { glAccount: '101000', debitCredit: 'H', amount: '800' },
      ],
      origin: { documentClass: 'vendor_invoice', documentKey: 'VI-T1' },
      postedBy: ACTOR,
    }));
    const credit = await post('200', '101000', '400000', 'inh-1-b', '2026-04-29');

    const result = await clearGlItems(clearingInput({
      requestKey: 'inh-clear-1', method: 'RESIDUAL', residualReasonCode: 'R01',
      items: [
        { documentNumber: origin.documentNumber, fiscalYear: 2026, lineNumber: 1, settlementAmount: '200' },
        { documentNumber: credit.documentNumber, fiscalYear: 2026, lineNumber: 2, settlementAmount: '200' },
      ],
    }));
    expect(result.residualItems).toHaveLength(1);
    expect(result.residualItems[0]!.amount).toBe('600.00');

    const residualLine = await withTenant(client, async (tx) => tx.execute(sql`
      select payment_terms, baseline_date::text as baseline_date, assignment
      from journal_entry_line
      where client = ${client} and document_number = ${result.residualItems[0]!.documentNumber}
        and line_number = ${result.residualItems[0]!.lineNumber}
    `)) as unknown as Array<{ payment_terms: string | null; baseline_date: string | null; assignment: string | null }>;
    expect(residualLine[0]!.payment_terms).toBe('NET30');
    expect(residualLine[0]!.baseline_date).toBe('2026-04-28');
    expect(residualLine[0]!.assignment).toBe('PO-778');
  }, 60_000);

  it('honours the inheritance switches when they stand off', async () => {
    const origin = await withTenant(client, async (tx) => postJournalEntry(tx, {
      client, companyCode: '1000', documentType: 'SA',
      documentDate: '2026-04-30', postingDate: '2026-04-30',
      fiscalYear: 2026, postingPeriod: 4,
      currency, localCurrency: currency,
      lines: [
        { glAccount: '400000', debitCredit: 'S', amount: '400', businessPartner: 'V20000', assignment: 'PO-999' },
        { glAccount: '101000', debitCredit: 'H', amount: '400' },
      ],
      origin: { documentClass: 'vendor_invoice', documentKey: 'VI-T1' },
      postedBy: ACTOR,
    }));
    const credit = await post('150', '101000', '400000', 'inh-2-b', '2026-04-30');
    const result = await clearGlItems(clearingInput({
      requestKey: 'inh-clear-2', method: 'RESIDUAL', residualReasonCode: 'R01',
      inheritPaymentTerms: false, inheritAssignment: false,
      items: [
        { documentNumber: origin.documentNumber, fiscalYear: 2026, lineNumber: 1, settlementAmount: '150' },
        { documentNumber: credit.documentNumber, fiscalYear: 2026, lineNumber: 2, settlementAmount: '150' },
      ],
    }));
    const residualLine = await withTenant(client, async (tx) => tx.execute(sql`
      select payment_terms, baseline_date::text as baseline_date, assignment
      from journal_entry_line
      where client = ${client} and document_number = ${result.residualItems[0]!.documentNumber}
        and line_number = ${result.residualItems[0]!.lineNumber}
    `)) as unknown as Array<{ payment_terms: string | null; baseline_date: string | null; assignment: string | null }>;
    expect(residualLine[0]!.payment_terms).toBeNull();
    expect(residualLine[0]!.baseline_date).toBeNull();
    expect(residualLine[0]!.assignment).toBeNull();
  }, 60_000);
});

describe('SCR-114 follow-up B-816: cross-currency partial clearing', () => {
  it('settles part of a foreign item and posts the realized difference on the settled portion', async () => {
    const [company] = await withTenant(client, async (tx) => tx.execute(sql`
      select chart_of_accounts as chart from company_code where client = ${client} and company_code = '1000'
    `)) as unknown as [{ chart: string }];
    void company;
    const eur = await withTenant(client, async (tx) => postJournalEntry(tx, {
      client, companyCode: '1000', documentType: 'SA',
      documentDate: '2026-05-02', postingDate: '2026-05-02',
      fiscalYear: 2026, postingPeriod: 5,
      currency: 'EUR', localCurrency: currency, exchangeRate: '0.30',
      lines: [
        { glAccount: '400000', debitCredit: 'S', amount: '1000' },
        { glAccount: '101000', debitCredit: 'H', amount: '1000' },
      ],
      postedBy: ACTOR,
    }));
    const gbp = await withTenant(client, async (tx) => postJournalEntry(tx, {
      client, companyCode: '1000', documentType: 'SA',
      documentDate: '2026-05-02', postingDate: '2026-05-02',
      fiscalYear: 2026, postingPeriod: 5,
      currency: 'GBP', localCurrency: currency, exchangeRate: '0.30',
      lines: [
        { glAccount: '101000', debitCredit: 'S', amount: '600' },
        { glAccount: '400000', debitCredit: 'H', amount: '600' },
      ],
      postedBy: ACTOR,
    }));
    const result = await clearGlItems(clearingInput({
      requestKey: 'xcur-partial-1', method: 'PARTIAL', crossCurrency: true,
      items: [
        { documentNumber: eur.documentNumber, fiscalYear: 2026, lineNumber: 1, settlementAmount: '600' },
        { documentNumber: gbp.documentNumber, fiscalYear: 2026, lineNumber: 2, settlementAmount: '600' },
      ],
    }));
    const open = result.openItems.find((i) => i.documentNumber === eur.documentNumber)!;
    expect(open.remaining).toBe(120); // 1,000 EUR at 0.30 carrying; 600 settled leaves 400 EUR = 120 local
    expect(open.applied).toBe(600);
    expect(result.openItems.some((i) => i.documentNumber === gbp.documentNumber)).toBe(false);

    const lines = await withTenant(client, async (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_local::text as amount
      from journal_entry_line
      where client = ${client} and document_number = ${result.clearingDocumentNumber}
    `)) as unknown as Array<{ gl_account: string; debit_credit: string; amount: string }>;
    const debit = lines.reduce((s, l) => s + (l.debit_credit === 'S' ? Number(l.amount) : 0), 0);
    const credit = lines.reduce((s, l) => s + (l.debit_credit === 'H' ? Number(l.amount) : 0), 0);
    expect(Math.abs(debit - credit)).toBeLessThan(0.005);
  }, 60_000);

  it('refuses cross-currency residual clearing by name', async () => {
    const eur = await withTenant(client, async (tx) => postJournalEntry(tx, {
      client, companyCode: '1000', documentType: 'SA',
      documentDate: '2026-05-03', postingDate: '2026-05-03',
      fiscalYear: 2026, postingPeriod: 5,
      currency: 'EUR', localCurrency: currency, exchangeRate: '0.30',
      lines: [
        { glAccount: '400000', debitCredit: 'S', amount: '500' },
        { glAccount: '101000', debitCredit: 'H', amount: '500' },
      ],
      postedBy: ACTOR,
    }));
    const gbp = await withTenant(client, async (tx) => postJournalEntry(tx, {
      client, companyCode: '1000', documentType: 'SA',
      documentDate: '2026-05-03', postingDate: '2026-05-03',
      fiscalYear: 2026, postingPeriod: 5,
      currency: 'GBP', localCurrency: currency, exchangeRate: '0.30',
      lines: [
        { glAccount: '101000', debitCredit: 'S', amount: '300' },
        { glAccount: '400000', debitCredit: 'H', amount: '300' },
      ],
      postedBy: ACTOR,
    }));
    await expect(clearGlItems(clearingInput({
      requestKey: 'xcur-res-1', method: 'RESIDUAL', residualReasonCode: 'R01', crossCurrency: true,
      items: [
        { documentNumber: eur.documentNumber, fiscalYear: 2026, lineNumber: 1, settlementAmount: '300' },
        { documentNumber: gbp.documentNumber, fiscalYear: 2026, lineNumber: 2, settlementAmount: '300' },
      ],
    }))).rejects.toThrow(/Cross-currency residual clearing is not supported/);
  }, 60_000);
});
