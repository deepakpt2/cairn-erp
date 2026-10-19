/**
 * SCR-113 / R-161 stage 2 — profit-centre index contract.
 *
 * KE5Z reads the journal itself; the one schema need is the
 * profit-centre line path. These assertions pin the index
 * across migration SQL and the Drizzle mirror, and the
 * vocabulary's read-only, single-ledger settlements.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('drizzle/0118_journal_profit_center_index.sql', 'utf8');
const financeSchema = readFileSync('src/modules/finance/schema.ts', 'utf8');
const vocabulary = readFileSync('src/modules/foundation/profit-center-report.ts', 'utf8');

describe('SCR-113 stage 2: profit-centre journal path stands aligned', () => {
  it('indexes tenant, profit centre, fiscal year and company on journal lines', () => {
    expect(migration).toContain('create index jel_profitcenter_idx');
    expect(migration).toContain('(client, profit_center, fiscal_year, company_code)');
    expect(financeSchema).toContain("index('jel_profitcenter_idx').on(t.client, t.profitCenter, t.fiscalYear, t.companyCode)");
    expect(financeSchema).toContain("index('journal_entry_company_year_period_idx')");
  });

  it('adds no report tables and keeps the vocabulary read-only', () => {
    expect(migration).not.toContain('create table');
    expect(vocabulary).toContain("export const LEADING_LEDGER = '0L'");
    expect(vocabulary).toContain('truncated: boolean');
    expect(vocabulary).toContain("export const PROFIT_CENTER_REPORT_CAPABILITY = 'FIN.RPT.PROFITCENTER'");
  });

  it('names the deferred partner profit centre instead of implying it', () => {
    expect(vocabulary).toContain('partner profit centre');
    expect(vocabulary).not.toContain('partnerProfitCenter');
  });
});
