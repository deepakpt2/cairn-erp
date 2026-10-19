/**
 * SCR-116 / R-164 stage 2 — consolidation schema contract.
 *
 * The workbench stores normalized configuration only: areas,
 * the journal-bound data basis, units/groups with
 * time-dependent assignments, chart mappings, methods,
 * versions and dependency-carrying tasks. No results, no
 * postings, no SAP BW table names.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('drizzle/0119_consolidation_workbench.sql', 'utf8');
const financeSchema = readFileSync('src/modules/finance/schema.ts', 'utf8');
const vocabulary = readFileSync('src/modules/finance/consolidation-vocabulary.ts', 'utf8');

describe('SCR-116 stage 2: consolidation configuration schema stands aligned', () => {
  it('keys every entity tenant-first with foreign keys into canon', () => {
    for (const table of [
      'consolidation_data_basis', 'consolidation_dimension', 'consolidation_area',
      'consolidation_unit', 'consolidation_group', 'consolidation_unit_assignment',
      'consolidation_group_account', 'consolidation_account_mapping',
      'consolidation_method', 'consolidation_version', 'consolidation_task',
    ]) {
      expect(migration).toContain(`create table public.${table}`);
      expect(financeSchema).toContain(`pgTable('${table}'`);
    }
    expect(migration).toContain('references public.fiscal_year_variant (client, variant)');
    expect(migration).toContain('references public.company_code (client, company_code)');
    expect(migration).toContain("check (provider = 'JOURNAL')");
  });

  it('guards validity intervals and dependency kinds at the database', () => {
    expect(migration).toContain('check (valid_from <= valid_to)');
    expect(migration).toContain("'INTERCOMPANY_ELIMINATION'");
    expect(migration).toContain("check (status in ('DRAFT', 'ACTIVE'))");
    expect(migration).not.toContain('InfoCube');
    expect(migration).not.toContain('create table public.journal');
  });

  it('keeps the vocabulary configuration-only', () => {
    expect(vocabulary).toContain("export const CONSOLIDATION_CAPABILITY = 'FIN.RPT.CONSOLIDATE'");
    expect(vocabulary).toContain("export const DATA_PROVIDERS = ['JOURNAL'] as const");
    expect(vocabulary).toContain('Execution (the UCMON monitor)');
  });
});
