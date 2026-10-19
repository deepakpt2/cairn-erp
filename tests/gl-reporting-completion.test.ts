import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { getGlBalanceReport, type GlBalanceReportSelection } from '../src/modules/finance/gl-balances';
import { getJournalItems } from '../src/modules/finance/journal-items';
import { postGlDocument } from '../src/modules/finance/gl-document';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'GC-TEST';
let client = '';
let company = '';

const reportSelection = (overrides: Partial<GlBalanceReportSelection> = {}): GlBalanceReportSelection => ({
  companyCodes: [company], accountFrom: '100000', accountTo: '499999',
  fiscalYear: 2026, periodFrom: 1, periodTo: 12,
  includeSpecialPeriods: false, ledger: '0L', ...overrides,
});

beforeAll(async () => {
  const fx = await createTenant('glcomplete');
  client = fx.client;
  company = fx.companyCode;
  await defineTestRanges(fx, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into exchange_rate (client, rate_type, from_currency, to_currency, valid_from, rate, ratio_from, ratio_to, created_by)
      values (${client}, 'AVERAGE', 'USD', 'EUR', '2026-01-01', 0.9, 1, 1, ${ACTOR})
      on conflict (client, rate_type, from_currency, to_currency, valid_from)
      do update set rate = excluded.rate
    `);
  });
  await postGlDocument({
    client, changedBy: ACTOR, requestKey: 'gc-2026-1', companyCode: company,
    documentDate: '2026-04-09', postingDate: '2026-04-10', documentType: 'SA', currency: 'USD', reference: 'REF-9',
    lines: [
      { glAccount: '101000', debitCredit: 'S', amount: '5000', assignment: 'INV-100' },
      { glAccount: '300000', debitCredit: 'H', amount: '5000' },
    ],
  });
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
}, 180_000);

describe('SCR-109 G/L reporting suite completion (R-157)', () => {
  it('converts into a validated output currency and splits subtotals by company', async () => {
    const report = await getGlBalanceReport(client, reportSelection({ outputCurrency: 'EUR' }));
    const cash = report.rows.find((r) => r.glAccount === '101000');
    expect(cash?.closingBalance).toBe(4500); // 5000 × 0.9
    expect(cash?.currency).toBe('EUR');
    expect(report.outputCurrency).toBe('EUR');
    expect(report.subtotals.length).toBeGreaterThan(0);
    expect(report.subtotals.every((s) => s.companyCode === company && s.currency === 'EUR')).toBe(true);
  });

  it('keeps company currency with a warning when the rate is missing, and judges bad codes', async () => {
    const report = await getGlBalanceReport(client, reportSelection({ outputCurrency: 'JPY' }));
    const cash = report.rows.find((r) => r.glAccount === '101000');
    expect(cash?.currency).toBe('USD');
    expect(cash?.closingBalance).toBe(5000);
    expect(report.warnings.some((w) => w.includes('No AVERAGE rate from USD to JPY'))).toBe(true);
    await expect(getGlBalanceReport(client, reportSelection({ outputCurrency: 'EU' })))
      .rejects.toThrow('not a configured currency code');
  });

  it('line items expose document date and reference', async () => {
    const items = await getJournalItems(client, {
      accountFrom: '101000', companyCodes: [company], fiscalYear: 2026, status: 'ALL',
    });
    expect(items.rows).toHaveLength(1);
    expect(items.rows[0]?.documentDate).toBe('2026-04-09');
    expect(items.rows[0]?.postingDate).toBe('2026-04-10');
    expect(items.rows[0]?.reference).toBe('REF-9');
  });
});
