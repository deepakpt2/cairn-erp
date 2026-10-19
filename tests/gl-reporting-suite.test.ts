import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { getGlBalanceReport, type GlBalanceReportSelection } from '../src/modules/finance/gl-balances';
import { getJournalItems } from '../src/modules/finance/journal-items';
import { postGlDocument } from '../src/modules/finance/gl-document';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'GR-TEST';
let client = '';
let company = '';

const reportSelection = (overrides: Partial<GlBalanceReportSelection> = {}): GlBalanceReportSelection => ({
  companyCodes: [company], accountFrom: '100000', accountTo: '499999',
  fiscalYear: 2026, periodFrom: 1, periodTo: 12,
  includeSpecialPeriods: false, ledger: '0L', ...overrides,
});

beforeAll(async () => {
  const fx = await createTenant('glreport');
  client = fx.client;
  company = fx.companyCode;
  await defineTestRanges(fx, { fiscalYear: 2025 });
  await defineTestRanges(fx, { fiscalYear: 2026 });
  await postGlDocument({
    client, changedBy: ACTOR, requestKey: 'gr-2025-1', companyCode: company,
    documentDate: '2025-05-10', postingDate: '2025-05-10', documentType: 'SA', currency: 'USD',
    lines: [
      { glAccount: '101000', debitCredit: 'S', amount: '7000' },
      { glAccount: '300000', debitCredit: 'H', amount: '7000' },
    ],
  });
  await postGlDocument({
    client, changedBy: ACTOR, requestKey: 'gr-2026-1', companyCode: company,
    documentDate: '2026-04-10', postingDate: '2026-04-10', documentType: 'SA', currency: 'USD',
    lines: [
      { glAccount: '101000', debitCredit: 'S', amount: '5000', assignment: 'INV-100' },
      { glAccount: '300000', debitCredit: 'H', amount: '5000' },
    ],
  });
  await postGlDocument({
    client, changedBy: ACTOR, requestKey: 'gr-2026-2', companyCode: company,
    documentDate: '2026-04-11', postingDate: '2026-04-11', documentType: 'SA', currency: 'USD',
    lines: [
      { glAccount: '400000', debitCredit: 'S', amount: '1500' },
      { glAccount: '101000', debitCredit: 'H', amount: '1500' },
    ],
  });
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
}, 180_000);

describe('SCR-108 G/L reporting suite (R-156)', () => {
  it('balance report derives opening, range turnover, closing and split balances with group subtotals', async () => {
    const report = await getGlBalanceReport(client, reportSelection());
    const cash = report.rows.find((r) => r.glAccount === '101000');
    expect(cash?.openingBalance).toBe(7000);
    expect(cash?.debitTurnover).toBe(5000);
    expect(cash?.creditTurnover).toBe(1500);
    expect(cash?.netChange).toBe(3500);
    expect(cash?.closingBalance).toBe(10500);
    expect(cash?.debitBalance).toBe(10500);
    expect(cash?.creditBalance).toBe(0);
    const revenue = report.rows.find((r) => r.glAccount === '300000');
    expect(revenue?.closingBalance).toBe(-12000);
    expect(revenue?.creditBalance).toBe(12000);
    expect(revenue?.debitBalance).toBe(0);
    // Selected accounts without postings stand as zero rows.
    expect(report.rows.some((r) => r.closingBalance === 0 && r.openingBalance === 0)).toBe(true);
    // Subtotals reconcile to the account rows.
    const closingSum = report.rows.reduce((sum, r) => sum + r.closingBalance, 0);
    const subtotalSum = report.subtotals.reduce((sum, s) => sum + s.closingBalance, 0);
    expect(subtotalSum).toBeCloseTo(closingSum, 2);
    expect(report.subtotals.length).toBeGreaterThan(0);
  });

  it('balance report judges ledger, ranges and companies', async () => {
    await expect(getGlBalanceReport(client, reportSelection({ ledger: 'ZZ' }))).rejects.toThrow('not configured');
    await expect(getGlBalanceReport(client, reportSelection({ companyCodes: [] }))).rejects.toThrow('at least one company');
    await expect(getGlBalanceReport(client, reportSelection({ accountFrom: '400000', accountTo: '100000' }))).rejects.toThrow('inverted');
    await expect(getGlBalanceReport(client, reportSelection({ periodFrom: 9, periodTo: 2 }))).rejects.toThrow('period range is invalid');
  });

  it('line items carry assignment and paginate with a total', async () => {
    const page1 = await getJournalItems(client, {
      accountFrom: '101000', companyCodes: [company], fiscalYear: 2026, status: 'ALL', page: 1, pageSize: 1,
    });
    expect(page1.total).toBe(2);
    expect(page1.rows).toHaveLength(1);
    expect(page1.truncated).toBe(true);
    const page2 = await getJournalItems(client, {
      accountFrom: '101000', companyCodes: [company], fiscalYear: 2026, status: 'ALL', page: 2, pageSize: 1,
    });
    expect(page2.rows).toHaveLength(1);
    expect(page2.truncated).toBe(false);
    const documents = new Set([...page1.rows, ...page2.rows].map((r) => r.documentNumber));
    expect(documents.size).toBe(2); // disjoint pages
    const all = await getJournalItems(client, {
      accountFrom: '101000', companyCodes: [company], fiscalYear: 2026, status: 'ALL',
    });
    expect(all.rows.find((r) => r.assignment === 'INV-100')).toBeDefined();
  });

  it('open/cleared status judges from canonical clearing data on managed accounts', async () => {
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        update gl_account set is_open_item_managed = true
        where client = ${client} and account_number = '101000'
      `);
      await tx.execute(sql`
        update journal_entry_line set clearing_document = 'CLR-1', clearing_date = '2026-04-12'
        where client = ${client} and gl_account = '101000' and debit_credit = 'S' and fiscal_year = 2026
      `);
    });
    const open = await getJournalItems(client, {
      accountFrom: '101000', companyCodes: [company], fiscalYear: 2026, status: 'OPEN',
    });
    expect(open.rows).toHaveLength(1);
    expect(open.rows[0]?.itemStatus).toBe('OPEN');
    const cleared = await getJournalItems(client, {
      accountFrom: '101000', companyCodes: [company], fiscalYear: 2026, status: 'CLEARED',
    });
    expect(cleared.rows).toHaveLength(1);
    expect(cleared.rows[0]?.clearingDocument).toBe('CLR-1');
    const all = await getJournalItems(client, {
      accountFrom: '101000', companyCodes: [company], fiscalYear: 2026, status: 'ALL', postingDateFrom: '2026-04-11', postingPeriod: 4,
    });
    expect(all.rows.every((r) => r.postingDate >= '2026-04-11')).toBe(true); // both filters apply
  });
});
