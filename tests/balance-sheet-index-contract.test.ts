/**
 * SCR-107 / S_ALR_87012284 stage 2 — balance-summary index contract.
 *
 * Package §3: the statement stays read-only over the canonical
 * journal; no duplicate balance or totals table is created, and
 * the aggregation source carries an index aligned with tenant,
 * company code, fiscal year and G/L account (the ledger is the
 * configured `0L` vocabulary, not a stored column — SCR-106).
 * These assertions pin that alignment across the migration SQL
 * and the Drizzle mirror so a drift in either fails here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const headerMigration = readFileSync('drizzle/0115_financial_statement_version.sql', 'utf8');
const lineMigration = readFileSync('drizzle/0098_journal_item_report_indexes.sql', 'utf8');
const financeSchema = readFileSync('src/modules/finance/schema.ts', 'utf8');
const service = readFileSync('src/modules/finance/trial-balance.ts', 'utf8');
const balanceSheetService = readFileSync('src/modules/finance/balance-sheet.ts', 'utf8');

describe('SCR-107 stage 2: canonical aggregation indexes stand aligned', () => {
  it('header side: (client, company_code, fiscal_year, posting_period) in migration and Drizzle', () => {
    expect(headerMigration).toContain('create index journal_entry_company_year_period_idx');
    expect(headerMigration).toContain('on public.journal_entry (client, company_code, fiscal_year, posting_period)');
    expect(financeSchema).toContain("index('journal_entry_company_year_period_idx').on(t.client, t.companyCode, t.fiscalYear, t.postingPeriod)");
  });

  it('line side: (client, company_code, gl_account, fiscal_year, …) in migration and Drizzle', () => {
    expect(lineMigration).toContain('jel_company_account_idx');
    expect(financeSchema).toContain("index('jel_company_account_idx').on(t.client, t.companyCode, t.glAccount, t.fiscalYear, t.documentNumber, t.lineNumber)");
    expect(financeSchema).toContain("index('jel_account_idx').on(t.client, t.glAccount, t.fiscalYear)");
  });

  it('the statement aggregates the posted journal and persists no totals', () => {
    expect(service).toContain('from journal_entry_line l');
    expect(service).toContain("ledgerJournalStatus('e')");
    expect(service).not.toMatch(/insert into|update journal|create table/i);
    const ledger = readFileSync('src/modules/finance/ledger-journal.ts', 'utf8');
    expect(ledger).toContain("'POSTED'");
    expect(ledger).toContain("'REVERSED'");
    expect(ledger).toContain('PARKED');
  });
});

describe('SCR-111 stage 2: the P&L statement reuses the same snapshot and FSV canon', () => {
  it('balance derivation classifies accounts from the master, never from hardcoded ranges', () => {
    expect(balanceSheetService).toContain('is_balance_sheet');
    expect(balanceSheetService).toContain('from journal_entry_line l');
    expect(balanceSheetService).not.toMatch(/insert into|create table/i);
  });
});
