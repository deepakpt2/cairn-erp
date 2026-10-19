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
