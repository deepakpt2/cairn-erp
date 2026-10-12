import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('drizzle/0018_company_code_assignments_nullable.sql', 'utf8');
const referenceTrigger = readFileSync('drizzle/9021_company_code_refs_allow_unassigned.sql', 'utf8');

describe('Company Code assignment migration contract', () => {
  it('makes only the three §6.2 assignment columns nullable without rewriting existing values', () => {
    expect(migration).toContain('ALTER COLUMN "chart_of_accounts" DROP NOT NULL');
    expect(migration).toContain('ALTER COLUMN "fiscal_year_variant" DROP NOT NULL');
    expect(migration).toContain('ALTER COLUMN "posting_period_variant" DROP NOT NULL');
    expect(migration).not.toMatch(/UPDATE\s+"?company_code"?/i);
    expect(migration.match(/DROP NOT NULL/g)).toHaveLength(3);
  });

  it('retains tenant-local reference validation for each non-null assignment', () => {
    expect(referenceTrigger).toContain('IF NEW.chart_of_accounts IS NOT NULL AND NOT EXISTS');
    expect(referenceTrigger).toContain('IF NEW.fiscal_year_variant IS NOT NULL AND NOT EXISTS');
    expect(referenceTrigger).toContain('IF NEW.posting_period_variant IS NOT NULL AND NOT EXISTS');
    expect(referenceTrigger.match(/NEW\.(chart_of_accounts|fiscal_year_variant|posting_period_variant) IS NOT NULL/g)).toHaveLength(3);
  });
});
