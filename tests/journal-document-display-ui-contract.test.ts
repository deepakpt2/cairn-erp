import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SCR-137 / FB03 UI contract: the display's base is FIN.JOURNAL.DISPLAY and the flow
 * panel keeps FIN.DOC.FLOW — two questions, two capabilities. The company code is a
 * cross-check rather than a second key, a disagreement refuses in SAP's own words,
 * every line carries its derived account type, and the three anchors that used to show
 * a journal number as text now link here.
 */
const page = readFileSync('src/app/finance/journal/document/page.tsx', 'utf8');
const display = readFileSync('src/app/finance/journal/document/DocumentDisplay.tsx', 'utf8');
const service = readFileSync('src/modules/finance/document-display.ts', 'utf8');
const registry = readFileSync('scripts/seed.ts', 'utf8');

describe('SCR-137 accounting document display UI contract', () => {
  it('gates the document on FIN.JOURNAL.DISPLAY and the flow panel on FIN.DOC.FLOW', () => {
    expect(service).toContain("export const FIN_JOURNAL_DISPLAY_CAPABILITY = 'FIN.JOURNAL.DISPLAY'");
    expect(service).toContain("export const DOCUMENT_FLOW_CAPABILITY = 'FIN.DOC.FLOW'");
    expect(page).toContain('can(session, FIN_JOURNAL_DISPLAY_CAPABILITY)');
    expect(page).toContain('can(session, DOCUMENT_FLOW_CAPABILITY)');
    expect(display).toContain('canFlow');
    expect(display).toContain('{!canFlow ? (');
    expect(page).toContain('session.user.client');
  });

  it('treats the company code as a cross-check, not a second key', () => {
    expect(display).toContain('name="company"');
    expect(display).not.toMatch(/name="company"[^>]*required/);
    expect(display).toMatch(/name="document"[^>]*required/);
    expect(display).toMatch(/name="year"[^>]*required/);
    expect(display).toContain('must agree');
    expect(service).toContain('COMPANY_MISMATCH');
  });

  it('refuses a disagreeing company in SAP\'s wording, beside the other refusals', () => {
    expect(page).toContain('does not exist in company code');
    expect(display).toContain('data-company-mismatch');
    expect(display).toContain('role="alert"');
  });

  it('shows the derived account type as a column on every line and as an attribute', () => {
    expect(display).toContain('data-account-type={line.accountType}');
    expect(display).toContain('{line.accountType}');
    expect(service).toContain("type AccountType = 'S' | 'D' | 'K'");
    expect(service).toContain('supplierCompany');
    expect(service).toContain('customerCompany');
  });

  it('links the three anchors that used to show the journal number as text', () => {
    const journalList = readFileSync('src/app/finance/journal/page.tsx', 'utf8');
    const mb03 = readFileSync('src/app/inventory/material-documents/page.tsx', 'utf8');
    const goodsIssue = readFileSync('src/app/inventory/goods-issue/GoodsIssue.tsx', 'utf8');
    for (const anchor of [journalList, mb03, goodsIssue]) {
      expect(anchor).toContain('/finance/journal/document?document=');
    }
    expect(mb03).toContain('encodeURIComponent(document.journalDocumentNumber)');
    expect(goodsIssue).toContain('encodeURIComponent(state.document.journalDocumentNumber)');
    expect(journalList).toContain('&company=${encodeURIComponent(row.company_code)}&year=${row.fiscal_year}');
  });

  it('writes nothing: no posting, no reversal, no period check', () => {
    expect(service).not.toMatch(/postJournalEntry|reverseJournalEntry/);
    expect(service).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(service).toContain('applies no period check');
    expect(page).not.toMatch(/postJournalEntry|reverseJournalEntry/);
  });

  it('registers FIN.JOURNAL.DISPLAY on the display route with FB03 as its alias', () => {
    expect(registry).toContain("'FIN.JOURNAL.DISPLAY'");
    expect(registry).toContain("route: '/finance/journal/document'");
    expect(registry).toMatch(/FIN\.JOURNAL\.DISPLAY[\s\S]{0,400}aliases: \['FB03'\]/);
  });
});
