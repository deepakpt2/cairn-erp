/**
 * SCR-118 / R-166 stage 2 — consolidated statements index check.
 *
 * The report is read-only: journal lines aggregate by company,
 * fiscal year and period through the UCWB mapping ranges, and
 * monitor standing reads the CX20 status table. No migration.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const financeSchema = readFileSync('src/modules/finance/schema.ts', 'utf8');
const vocabulary = readFileSync('src/modules/finance/consolidated-statements-vocabulary.ts', 'utf8');
const workbenchMigration = readFileSync('drizzle/0119_consolidation_workbench.sql', 'utf8');
const monitorMigration = readFileSync('drizzle/0120_consolidation_monitor.sql', 'utf8');

describe('SCR-118 stage 2: standing paths carry the statement read', () => {
  it('aggregates journal lines on the company/year/period paths', () => {
    expect(financeSchema).toContain("index('journal_entry_company_year_period_idx')");
    expect(financeSchema).toContain("index('jel_company_account_idx')");
    expect(financeSchema).toContain("'journal_entry_line'");
  });

  it('maps source accounts onto FS items through UCWB configuration', () => {
    expect(workbenchMigration).toContain('create table public.consolidation_account_mapping');
    expect(workbenchMigration).toContain('create table public.consolidation_group_account');
    expect(workbenchMigration).toContain('create table public.consolidation_unit');
    expect(financeSchema).toContain("pgTable('consolidation_account_mapping'");
  });

  it('reads monitor standing from the CX20 status table and stays read-only', () => {
    expect(monitorMigration).toContain('create table public.consolidation_task_status');
    expect(vocabulary).toContain("export const CONSOLIDATED_STATEMENTS_CAPABILITY = 'FIN.RPT.CONSOLIDATE.STMT'");
    expect(vocabulary).toContain('posts nothing and stores nothing');
    expect(vocabulary).not.toContain("from './schema'");
  });
});
