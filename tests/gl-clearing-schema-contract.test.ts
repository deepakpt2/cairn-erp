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
