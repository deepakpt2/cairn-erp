import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { postJournalEntry } from '../src/platform/posting';
import { getGlBalances } from '../src/modules/finance/gl-balances';
import { getJournalItems } from '../src/modules/finance/journal-items';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'BALANCE-TEST';
let client = '';
const company = '1000';

async function post(lines: { glAccount: string; debitCredit: 'S' | 'H'; amount: string }[], fiscalYear: number, period: number, date: string) {
  return withTenant(client, (tx) => postJournalEntry(tx, {
    client, companyCode: company, documentType: 'SA',
    documentDate: date, postingDate: date, fiscalYear,
    postingPeriod: period, currency: 'USD', localCurrency: 'USD',
    lines, postedBy: ACTOR, transactionCode: 'FIN.JOURNAL.POST',
  }));
}

beforeAll(async () => {
  const fx = await createTenant('gl-balances');
  client = fx.client;
  await defineTestRanges(fx, { fiscalYear: 2025 });
  await defineTestRanges(fx, { fiscalYear: 2026 });

  await post([
    { glAccount: '400000', debitCredit: 'S', amount: '1000.00' },
    { glAccount: '101000', debitCredit: 'H', amount: '1000.00' },
  ], 2025, 12, '2025-12-20');
  await post([
    { glAccount: '400000', debitCredit: 'S', amount: '500.00' },
    { glAccount: '101000', debitCredit: 'H', amount: '500.00' },
  ], 2026, 3, '2026-03-15');
  await post([
    { glAccount: '101000', debitCredit: 'S', amount: '200.00' },
    { glAccount: '400000', debitCredit: 'H', amount: '200.00' },
  ], 2026, 4, '2026-04-10');
  // The posting engine has no special-period entry path yet (deferred
  // by name at R-137 closure); a stored period-13 document is inserted
  // directly so the report's special-period reading is proven.
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into journal_entry (
        client, document_number, fiscal_year, document_type, company_code,
        document_date, posting_date, posting_period, document_currency, local_currency, status, created_by
      ) values (${client}, 'JE-SP-1', 2026, 'SA', ${company}, '2026-12-31', '2026-12-31', 13, 'USD', 'USD', 'POSTED', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into journal_entry_line (
        client, document_number, fiscal_year, line_number, gl_account, company_code,
        debit_credit, amount_local, amount_document, currency
      ) values
        (${client}, 'JE-SP-1', 2026, 1, '400000', ${company}, 'S', 50, 50, 'USD'),
        (${client}, 'JE-SP-1', 2026, 2, '101000', ${company}, 'H', 50, 50, 'USD')
    `);
  });
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
}, 180_000);

describe('SCR-089 G/L balances by period (R-137)', () => {
  it('chains opening, turnover and closing, with the opening never period 1 turnover', async () => {
    const view = await getGlBalances(client, { glAccount: '400000', companyCode: company, fiscalYear: 2026 });
    expect(view.openingBalance).toBe(1000);
    expect(view.periods).toHaveLength(12);
    const p1 = view.periods[0];
    expect(p1.opening).toBe(1000);
    expect(p1.debitTurnover).toBe(0);
    expect(p1.closing).toBe(1000);
    const p3 = view.periods[2];
    expect(p3).toMatchObject({ debitTurnover: 500, creditTurnover: 0, netChange: 500, closing: 1500, itemCount: 1 });
    const p4 = view.periods[3];
    expect(p4).toMatchObject({ debitTurnover: 0, creditTurnover: 200, netChange: -200, closing: 1300 });
    expect(view.yearClosing).toBe(1300);
  });

  it('keeps special periods apart, and drills into them by stored period', async () => {
    const view = await getGlBalances(client, {
      glAccount: '400000', companyCode: company, fiscalYear: 2026, includeSpecialPeriods: true,
    });
    expect(view.periods).toHaveLength(16);
    const special = view.periods[12];
    expect(special).toMatchObject({ period: 13, special: true, debitTurnover: 50, closing: 1350 });
    expect(view.yearClosing).toBe(1350);
    expect(view.periods[11].closing).toBe(1300);

    const items = await getJournalItems(client, {
      accountFrom: '400000', companyCodes: [company], fiscalYear: 2026, postingPeriod: 13, status: 'ALL',
    });
    expect(items.rows).toHaveLength(1);
    expect(items.rows[0].amountDocument).toBe(50);
  });

  it('refuses unknown accounts and currencies it cannot display without conversion', async () => {
    await expect(getGlBalances(client, { glAccount: '999999', companyCode: company, fiscalYear: 2026 }))
      .rejects.toThrowError(/does not stand/);
    await expect(getGlBalances(client, { glAccount: '400000', companyCode: company, fiscalYear: 2026, currency: 'EUR' }))
      .rejects.toThrowError(/cannot display in EUR/);
    const docView = await getGlBalances(client, { glAccount: '400000', companyCode: company, fiscalYear: 2026, currency: 'USD' });
    expect(docView.currency).toBe('USD');
    expect(docView.yearClosing).toBe(1300);
  });
});
