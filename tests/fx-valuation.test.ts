import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { postJournalEntry } from '../src/platform/posting';
import { executeFxValuation } from '../src/modules/finance/fx-valuation';
import { createTenant, defineTestRanges, destroyTenant, seedAccounts } from './helpers';

const ACTOR = 'FXVAL-TEST';
let client = '';
let company = '';

async function journalCount(): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`);
    return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
  });
}

function selection(overrides: Record<string, unknown> = {}) {
  return {
    companyCode: company, valuationArea: 'LOCAL', valuationKeyDate: '2026-04-30',
    postingDate: '2026-04-30', fiscalYear: 2026, valuationMethod: 'AVERAGE' as const,
    includeOpenItems: true, includeBalances: true, testRun: true,
    documentType: 'SA', requestKey: `fx-${Math.random().toString(36).slice(2)}`,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function post(lines: Array<Record<string, unknown>>, currency: string, rate: string, date: string) {
  return withTenant(client, async (tx) => postJournalEntry(tx, {
    client, companyCode: company, documentType: 'SA', documentDate: date, postingDate: date,
    fiscalYear: 2026, postingPeriod: 4, currency, localCurrency: 'USD', exchangeRate: rate,
    postedBy: ACTOR, transactionCode: 'FIN.JOURNAL.POST',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lines: lines as any,
  }));
}

beforeAll(async () => {
  const fx = await createTenant('fx-valuation');
  client = fx.client;
  company = fx.companyCode;
  await defineTestRanges(fx, { fiscalYear: 2026 });
  await seedAccounts(fx, ['113000', '210000', '590100', '590200']);
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      update gl_account set account_type = 'ASSET', gl_account_type = 'BALANCE_SHEET',
        is_balance_sheet = true, is_open_item_managed = true
      where client = ${client} and account_number = '113000'
    `);
    await tx.execute(sql`
      update gl_account set account_type = 'LIABILITY', gl_account_type = 'BALANCE_SHEET',
        is_balance_sheet = true, is_open_item_managed = false
      where client = ${client} and account_number = '210000'
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values (${client}, 'CA01', 'FXGAIN', '', '', '590100', ${ACTOR}),
             (${client}, 'CA01', 'FXLOSS', '', '', '590200', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into exchange_rate (client, rate_type, from_currency, to_currency, valid_from, rate, created_by)
      values (${client}, 'AVERAGE', 'EUR', 'USD', '2026-03-01', 1.0, ${ACTOR})
      on conflict do nothing
    `);
  });

  // Receivable: EUR 1,000 carried at 0.9 -> USD 900. Liability: EUR 500 at 0.9 -> USD 450.
  await post([
    { glAccount: '113000', debitCredit: 'S', amount: '1000.00' },
    { glAccount: '400000', debitCredit: 'H', amount: '1000.00' },
  ], 'EUR', '0.9', '2026-04-10');
  await post([
    { glAccount: '400000', debitCredit: 'S', amount: '500.00' },
    { glAccount: '210000', debitCredit: 'H', amount: '500.00' },
  ], 'EUR', '0.9', '2026-04-12');
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
}, 180_000);

describe('SCR-098 FX valuation FAGL_FC_VAL (R-146)', () => {
  it('values items in test mode with gain and loss classified, posting nothing', async () => {
    const journals = await journalCount();
    const result = await executeFxValuation({ client, changedBy: ACTOR, selection: selection() });
    const receivable = result.items.find((i) => i.accountNumber === '113000');
    const liability = result.items.find((i) => i.accountNumber === '210000');
    expect(receivable).toMatchObject({
      sourceKind: 'OPEN_ITEM', foreignAmount: 1000, carryingAmount: 900,
      valuationRate: 1, requiredAmount: 1000, adjustmentAmount: 100, classification: 'GAIN',
    });
    expect(liability).toMatchObject({
      sourceKind: 'BALANCE', foreignAmount: 500, carryingAmount: 450,
      requiredAmount: 500, adjustmentAmount: -50, classification: 'LOSS',
    });
    expect(result.totalGain).toBe(100);
    expect(result.totalLoss).toBe(50);
    expect(result.postingDocument).toBeNull();
    expect(await journalCount()).toBe(journals);
  });

  it('posts live with reversal, frees the items, then refuses a third valuation', async () => {
    const journals = await journalCount();
    const live = await executeFxValuation({
      client, changedBy: ACTOR,
      selection: selection({ testRun: false, reversalDate: '2026-05-01' }),
    });
    expect(live.status).toBe('REVERSED');
    expect(live.postingDocument).toBeTruthy();
    expect(live.reversalDocument).toBeTruthy();
    expect(live.items.every((i) => i.status === 'POSTED')).toBe(true);
    expect(await journalCount()).toBe(journals + 2);

    const rerun = await executeFxValuation({
      client, changedBy: ACTOR, selection: selection({ testRun: false }),
    });
    expect(rerun.status).toBe('COMPLETED');
    expect(rerun.postingDocument).toBeTruthy();

    const journalsAfterRerun = await journalCount();
    const third = await executeFxValuation({
      client, changedBy: ACTOR, selection: selection({ testRun: false }),
    });
    expect(third.items.every((i) => i.status === 'SKIPPED')).toBe(true);
    expect(third.postingDocument).toBeNull();
    expect(await journalCount()).toBe(journalsAfterRerun);
  });

  it('names a missing rate as an error and blocks the live post', async () => {
    await post([
      { glAccount: '113000', debitCredit: 'S', amount: '100.00' },
      { glAccount: '400000', debitCredit: 'H', amount: '100.00' },
    ], 'GBP', '0.8', '2026-04-15');
    const test = await executeFxValuation({ client, changedBy: ACTOR, selection: selection() });
    const gbp = test.items.find((i) => i.currency === 'GBP');
    expect(gbp?.status).toBe('ERROR');
    expect(gbp?.error).toContain('No AVERAGE rate for GBP/USD');
    await expect(executeFxValuation({
      client, changedBy: ACTOR, selection: selection({ testRun: false }),
    })).rejects.toThrow('cannot post');
  });

  it('refuses an unknown method, an empty scope and a wrong fiscal year', async () => {
    await expect(executeFxValuation({
      client, changedBy: ACTOR, selection: selection({ valuationMethod: 'SPOT' }),
    })).rejects.toThrow('not a configured rate type');
    await expect(executeFxValuation({
      client, changedBy: ACTOR, selection: selection({ includeOpenItems: false, includeBalances: false }),
    })).rejects.toThrow('Select open items');
    await expect(executeFxValuation({
      client, changedBy: ACTOR, selection: selection({ fiscalYear: 2025 }),
    })).rejects.toThrow('belongs to fiscal year 2026');
  });
});
