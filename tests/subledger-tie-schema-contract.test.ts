/**
 * SCR-115 / R-163 stage 2 — tie-out schema and index contract.
 *
 * The tie-out needs no new tables: reconciliation types stand
 * on the chart account, and the account and partner journal
 * paths serve the two totals. These assertions pin that.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const financeSchema = readFileSync('src/modules/finance/schema.ts', 'utf8');
const glVocabulary = readFileSync('src/modules/finance/gl-account-vocabulary.ts', 'utf8');
const vocabulary = readFileSync('src/modules/finance/subledger-tie-out.ts', 'utf8');

describe('SCR-115 stage 2: tie-out canon stands, nothing added', () => {
  it('stands reconciliation types CUSTOMERS and VENDORS on the chart account', () => {
    expect(financeSchema).toContain("'CUSTOMERS', 'VENDORS', 'ASSETS', 'MATERIAL'");
    expect(glVocabulary).toContain("export const RECONCILIATION_TYPES = ['CUSTOMERS', 'VENDORS', 'ASSETS', 'MATERIAL']");
  });

  it('serves both totals from the journal account and partner paths', () => {
    expect(financeSchema).toContain("index('jel_account_idx').on(t.client, t.glAccount, t.fiscalYear)");
    expect(financeSchema).toContain("index('journal_entry_line_partner_open_idx').on(t.client, t.businessPartner, t.clearingDocument)");
    expect(financeSchema).toContain("index('journal_entry_company_year_period_idx')");
  });

  it('defers ASSETS and MATERIAL by name in the vocabulary', () => {
    expect(vocabulary).toContain('CUSTOMERS or VENDORS');
    expect(vocabulary).toContain('Deferred by name: ASSETS and');
    expect(vocabulary).toContain("export const SUBLEDGER_TIE_CAPABILITY = 'FIN.RPT.SUBLEDGER.TIE'");
  });
});
