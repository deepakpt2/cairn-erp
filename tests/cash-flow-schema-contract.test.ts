/**
 * SCR-119 / R-167 stage 2 — cash flow statement index check.
 *
 * The report is read-only over the posted journal: balance
 * movements aggregate by company, fiscal year and period on
 * the standing journal paths; account classification derives
 * from standing configuration (house-bank G/L accounts,
 * reconciliation types, account determination, asset-class
 * determination). No migration.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const financeSchema = readFileSync('src/modules/finance/schema.ts', 'utf8');
const foundationSchema = readFileSync('src/modules/foundation/schema.ts', 'utf8');
const determination = readFileSync('src/modules/foundation/account-determination.ts', 'utf8');
const vocabulary = readFileSync('src/modules/finance/cash-flow-vocabulary.ts', 'utf8');

describe('SCR-119 stage 2: standing paths carry the cash-flow read', () => {
  it('aggregates journal lines on the company/year/period and company/account paths', () => {
    expect(financeSchema).toContain("index('journal_entry_company_year_period_idx')");
    expect(financeSchema).toContain("index('jel_company_account_idx')");
    expect(financeSchema).toContain("'journal_entry_line'");
    expect(financeSchema).toContain('POSTED');
  });

  it('defines cash from the house-bank G/L accounts', () => {
    expect(foundationSchema).toContain("'bank_account'");
    expect(foundationSchema).toContain("glAccount: varchar('gl_account'");
  });

  it('classifies receivables and payables from the reconciliation vocabulary', () => {
    expect(financeSchema).toContain("in ('CUSTOMERS', 'VENDORS', 'ASSETS', 'MATERIAL')");
    expect(financeSchema).toContain("reconciliationType: varchar('reconciliation_type'");
  });

  it('classifies inventories from BSX account determination', () => {
    expect(foundationSchema).toContain("index('account_determination_chart_event_idx')");
    expect(foundationSchema).toContain("'account_determination'");
    expect(determination).toContain("event: 'INVENTORY', referenceAlias: 'BSX'");
  });

  it('classifies fixed assets from asset-class account determination', () => {
    expect(financeSchema).toContain("reconAccount: varchar('recon_account'");
    expect(financeSchema).toContain("accumDeprAccount: varchar('accum_depr_account'");
    expect(financeSchema).toContain("depreciationExpenseAccount: varchar('depreciation_expense_account'");
  });

  it('judges periods per company fiscal-year variant and stays read-only', () => {
    expect(foundationSchema).toContain("fiscalYearVariant: varchar('fiscal_year_variant'");
    expect(foundationSchema).toContain("regularPeriods: smallint('regular_periods')");
    expect(vocabulary).toContain("export const CASHFLOW_CAPABILITY = 'FIN.RPT.CASHFLOW'");
    expect(vocabulary).toContain('posts nothing and stores nothing');
    expect(vocabulary).not.toContain("from './schema'");
  });
});
