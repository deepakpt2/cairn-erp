/**
 * SCR-108 / R-156 stage 2 — reporting index contract.
 *
 * Package §4: the suite reuses the canonical journal and adds
 * no duplicate balance or line-item table; the three query
 * paths (balances by company/account/year, line items by
 * posting date, clearing by status) must be served by indexes
 * that already stand. These assertions pin them across the
 * migration SQL and the Drizzle mirror (the ledger is the
 * configured `0L` vocabulary, not a stored column).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const lineMigration = readFileSync('drizzle/0098_journal_item_report_indexes.sql', 'utf8');
const financeSchema = readFileSync('src/modules/finance/schema.ts', 'utf8');
const balances = readFileSync('src/modules/finance/gl-balances.ts', 'utf8');
const items = readFileSync('src/modules/finance/journal-items.ts', 'utf8');

describe('SCR-108 stage 2: canonical reporting indexes stand aligned', () => {
  it('balances: (client, company_code, gl_account, fiscal_year, …) in migration and Drizzle', () => {
    expect(lineMigration).toContain('jel_company_account_idx');
    expect(financeSchema).toContain("index('jel_company_account_idx').on(t.client, t.companyCode, t.glAccount, t.fiscalYear, t.documentNumber, t.lineNumber)");
  });

  it('line items by date and clearing: header date index and clearing indexes stand', () => {
    expect(financeSchema).toContain("index('journal_entry_company_date_idx').on(t.client, t.companyCode, t.postingDate)");
    expect(financeSchema).toContain("index('jel_clearing_idx').on(t.client, t.clearingDocument)");
    expect(financeSchema).toContain("index('journal_entry_line_partner_open_idx').on(t.client, t.businessPartner, t.clearingDocument)");
  });

  it('both reports read the posted journal and persist nothing', () => {
    expect(balances).toContain("eq(journalEntry.status, 'POSTED')");
    expect(items).toContain('from journal_entry_line l');
    for (const source of [balances, items]) {
      expect(source).not.toMatch(/insert into|create table|\.insert\(|\.update\(/i);
    }
  });
});
