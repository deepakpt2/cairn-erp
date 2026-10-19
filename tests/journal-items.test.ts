import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { postJournalEntry } from '../src/platform/posting';
import { getJournalItems, JournalItemsError } from '../src/modules/finance/journal-items';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'ITEMS-TEST';
let client = '';
let otherClient = '';
const company = '1000';

async function post(lines: { glAccount: string; debitCredit: 'S' | 'H'; amount: string; businessPartner?: string }[], postingDate: string, reference?: string) {
  return withTenant(client, (tx) => postJournalEntry(tx, {
    client, companyCode: company, documentType: 'SA',
    documentDate: postingDate, postingDate, fiscalYear: 2026,
    postingPeriod: Number(postingDate.slice(5, 7)),
    currency: 'USD', localCurrency: 'USD', reference,
    lines, postedBy: ACTOR, transactionCode: 'FIN.JOURNAL.POST',
  }));
}

beforeAll(async () => {
  const fx = await createTenant('journal-items');
  client = fx.client;
  await defineTestRanges(fx, { fiscalYear: 2026 });
  const other = await createTenant('journal-items-other');
  otherClient = other.client;

  await post([
    { glAccount: '400000', debitCredit: 'S', amount: '500.00' },
    { glAccount: '101000', debitCredit: 'H', amount: '500.00' },
  ], '2026-03-15', 'ITEMS-REF-1');
  await post([
    { glAccount: '400000', debitCredit: 'S', amount: '250.00' },
    { glAccount: '101000', debitCredit: 'H', amount: '250.00' },
  ], '2026-04-10');
  await post([
    { glAccount: '101000', debitCredit: 'S', amount: '900.00' },
    { glAccount: '200000', debitCredit: 'H', amount: '900.00', businessPartner: 'V10000' },
  ], '2026-03-20');
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
  if (otherClient) await destroyTenant(otherClient);
}, 180_000);

describe('SCR-088 G/L line items (R-136)', () => {
  it('returns the account range with per-currency subtotals, and judges the selection', async () => {
    const result = await getJournalItems(client, {
      accountFrom: '400000', companyCodes: [company], status: 'ALL',
    });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.amountDocument)).toEqual([500, 250]);
    expect(result.subtotals).toEqual([expect.objectContaining({
      glAccount: '400000', currency: 'USD', debitDocument: 750, creditDocument: 0,
    })]);
    expect(result.truncated).toBe(false);

    const ranged = await getJournalItems(client, {
      accountFrom: '100000', accountTo: '499999', companyCodes: [company],
      status: 'ALL', postingDateFrom: '2026-04-01',
    });
    expect(ranged.rows).toHaveLength(2);

    await expect(getJournalItems(client, {
      accountFrom: '999999', companyCodes: [company], status: 'ALL',
    })).rejects.toThrowError(/does not stand/);
    await expect(getJournalItems(client, {
      accountFrom: '400000', companyCodes: ['9999'], status: 'ALL',
    })).rejects.toThrowError(/not configured/);
    await expect(getJournalItems(client, {
      accountFrom: '400000', companyCodes: [company], status: 'ALL',
      postingDateFrom: '2026-05-01', postingDateTo: '2026-04-01',
    })).rejects.toBeInstanceOf(JournalItemsError);
  });

  it('judges open and cleared from the clearing document on open-item accounts only', async () => {
    const open = await getJournalItems(client, {
      accountFrom: '200000', companyCodes: [company], status: 'OPEN',
    });
    expect(open.rows).toHaveLength(1);
    expect(open.rows[0].itemStatus).toBe('OPEN');

    await withTenant(client, (tx) => tx.execute(sql`
      update journal_entry_line set clearing_document = 'CLR-1', clearing_date = '2026-05-01'
      where client = ${client} and gl_account = '200000'
    `));
    const cleared = await getJournalItems(client, {
      accountFrom: '200000', companyCodes: [company], status: 'CLEARED',
    });
    expect(cleared.rows).toHaveLength(1);
    expect(cleared.rows[0].itemStatus).toBe('CLEARED');
    expect(cleared.rows[0].clearingDocument).toBe('CLR-1');
    const stillOpen = await getJournalItems(client, {
      accountFrom: '200000', companyCodes: [company], status: 'OPEN',
    });
    expect(stillOpen.rows).toHaveLength(0);

    const nonOi = await getJournalItems(client, {
      accountFrom: '400000', companyCodes: [company], status: 'OPEN',
    });
    expect(nonOi.rows).toHaveLength(0);
    const all = await getJournalItems(client, {
      accountFrom: '400000', companyCodes: [company], status: 'ALL',
    });
    expect(all.rows[0].itemStatus).toBeNull();
  });

  it('caps hits server-side with a truncation signal, and never crosses tenants', async () => {
    const capped = await getJournalItems(client, {
      accountFrom: '100000', accountTo: '499999', companyCodes: [company],
      status: 'ALL', maxHits: 2,
    });
    expect(capped.rows).toHaveLength(2);
    expect(capped.truncated).toBe(true);
    expect(capped.cap).toBe(2);

    const foreign = await getJournalItems(otherClient, {
      accountFrom: '400000', companyCodes: [company], status: 'ALL',
    });
    expect(foreign.rows).toHaveLength(0);
  });
});
