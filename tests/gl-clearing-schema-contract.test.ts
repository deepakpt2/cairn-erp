/**
 * SCR-114 / R-162 stage 2 — G/L clearing schema contract.
 *
 * F-03 needs no new tables: clearing references already stand
 * on the canonical line, open-item management stands on the
 * chart and company segment, and the company/account index
 * path serves the open-item read. These assertions pin that.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const financeSchema = readFileSync('src/modules/finance/schema.ts', 'utf8');
const vocabulary = readFileSync('src/modules/finance/gl-clearing.ts', 'utf8');

describe('SCR-114 stage 2: clearing canon stands, nothing added', () => {
  it('keeps clearing references on the canonical journal line', () => {
    expect(financeSchema).toContain("clearingDocument: varchar('clearing_document'");
    expect(financeSchema).toContain("clearingDate: date('clearing_date')");
    expect(financeSchema).toContain("index('jel_clearing_idx').on(t.client, t.clearingDocument)");
  });

  it('stands open-item management on chart and company segment', () => {
    const occurrences = financeSchema.split("isOpenItemManaged: boolean('is_open_item_managed')").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(financeSchema).toContain("index('jel_company_account_idx').on(t.client, t.companyCode, t.glAccount, t.fiscalYear, t.documentNumber, t.lineNumber)");
  });

  it('names the delivered tolerance posting and the still-deferred partial clearing', () => {
    expect(vocabulary).toContain("export const GL_CLEARING_CAPABILITY = 'FIN.GL.CLEAR'");
    expect(vocabulary).toContain('within the default tolerance group');
    expect(vocabulary).toContain('silently discarded');
    expect(vocabulary).toContain('Partial/residual clearing remains deferred');
  });
});

describe('SCR-114 advanced clearing (B-808): normalized allocation and residual lineage', () => {
  const migration = readFileSync('drizzle/9062_gl_clearing_advanced.sql', 'utf8');

  it('adds the allocation record, the residual lineage and the reason master', () => {
    expect(migration).toContain('create table public.gl_clearing_allocation');
    expect(migration).toContain('create table public.gl_clearing_residual');
    expect(migration).toContain('create table public.residual_reason');
    expect(migration).toContain('gl_clearing_allocation_amount_positive');
    expect(migration).toContain('check (clearing_method in');
    expect(migration).toContain('gl_clearing_allocation_source_idx');
    expect(migration).toContain('gl_clearing_residual_original_idx');
  });

  it('forces tenant isolation on every new table', () => {
    for (const table of ['gl_clearing_allocation', 'gl_clearing_residual', 'residual_reason']) {
      expect(migration).toContain(`alter table public.${table} enable row level security`);
      expect(migration).toContain(`alter table public.${table} force row level security`);
      expect(migration).toContain(`create policy tenant_isolation on public.${table}`);
      expect(migration).toContain(`grant select, insert, update, delete on public.${table} to cairn_app`);
    }
  });

  it('carries the columns the derivation reads', () => {
    expect(financeSchema).toContain("export const glClearingAllocation = pgTable('gl_clearing_allocation'");
    expect(financeSchema).toContain("export const glClearingResidual = pgTable('gl_clearing_residual'");
    expect(financeSchema).toContain("export const residualReason = pgTable('residual_reason'");
    expect(financeSchema).toContain("allocatedAmount: numeric('allocated_amount'");
    expect(financeSchema).toContain("generatedAmount: numeric('generated_amount'");
    expect(financeSchema).toContain("reasonCode: varchar('reason_code', { length: 3 })");
    expect(financeSchema).toContain("isActive: boolean('is_active')");
  });
});

describe('SCR-114 follow-up (B-816): line-level terms for residual items', () => {
  const termMigration = readFileSync('drizzle/9063_journal_line_terms.sql', 'utf8');

  it('adds payment terms and baseline date to the canonical journal line', () => {
    expect(termMigration).toContain('alter table public.journal_entry_line');
    expect(termMigration).toContain('add column payment_terms varchar(12)');
    expect(termMigration).toContain('add column baseline_date date');
    expect(financeSchema).toContain("paymentTerms: varchar('payment_terms', { length: 12 })");
    expect(financeSchema).toContain("baselineDate: date('baseline_date', { mode: 'string' })");
  });

  it('carries the fields through the posting engine, not around it', () => {
    const posting = readFileSync('src/platform/posting/index.ts', 'utf8');
    expect(posting).toContain('paymentTerms?: string;');
    expect(posting).toContain('baselineDate?: string;');
    expect(posting).toContain('paymentTerms: line.paymentTerms,');
    expect(posting).toContain('baselineDate: line.baselineDate,');
  });
});
