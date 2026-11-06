/**
 * The accounting document screen, as the reference for how the app sets out
 * data and explanation.
 *
 * Totals used to be written under the line items as a sentence that also
 * carried a policy statement and a legend for the account-type codes, and
 * printed the same figures twice whenever the document currency was the local
 * one. These contracts keep totals in the table and explanation in a hint.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  new URL('../src/app/finance/journal/document/DocumentDisplay.tsx', import.meta.url),
  'utf8',
);

const HINTS = [...SOURCE.matchAll(/<p className="field-hint">([\s\S]*?)<\/p>/g)].map((m) => m[1]);
// the hint under the line items, not the one under the lookup fields
const HINT = HINTS.find((hint) => hint.includes('Totals')) ?? '';

describe('totals', () => {
  it('stand in the table, not in a sentence beneath it', () => {
    expect(SOURCE).toContain('<tfoot>');
    expect(SOURCE).not.toMatch(/<p[^>]*>\s*Totals in/);
  });

  it('total the debit and the credit side in their own rows', () => {
    const foot = /<tfoot>([\s\S]*?)<\/tfoot>/.exec(SOURCE)?.[1] ?? '';
    expect(foot).toContain('Debit');
    expect(foot).toContain('Credit');
    expect(foot).toContain('document.debitDocument');
    expect(foot).toContain('document.creditDocument');
  });

  it('sit on the right edge with aligned figures', () => {
    const foot = /<tfoot>([\s\S]*?)<\/tfoot>/.exec(SOURCE)?.[1] ?? '';
    expect(foot).toContain('className="num"');
  });

  it('name the currency once when the document and local currencies agree', () => {
    expect(SOURCE).toContain('document.documentCurrency === document.localCurrency');
    expect(HINT).toContain('Totals in ${document.documentCurrency}');
    expect(HINT).toContain('document ${document.documentCurrency}, local ${document.localCurrency}');
  });
});

describe('explanation', () => {
  it('keeps the posting policy, in a hint rather than the body', () => {
    expect(HINT).toContain('stand as posted');
    expect(HINT).toContain('nothing is recalculated here');
  });

  it('keeps the account-type legend, and repeats it on the column header', () => {
    expect(SOURCE).toContain('ACCOUNT_TYPE_LEGEND');
    expect(HINT).toContain('ACCOUNT_TYPE_LEGEND');
    expect(SOURCE).toContain('title={ACCOUNT_TYPE_LEGEND}');
  });

  it('explains the document key in a hint, not a paragraph', () => {
    expect(SOURCE).not.toContain('must agree with the one it was posted in');
    expect(SOURCE).toContain('The number and the fiscal year identify the document.');
  });
});

describe('the house screen language', () => {
  it('uses the house field and label classes', () => {
    expect(SOURCE).toContain("const inputCls = 'field-input'");
    expect(SOURCE).toContain("const labelCls = 'field-label'");
  });

  it('heads each section with a rule, and counts what it lists', () => {
    expect(SOURCE).toContain('className="section-head"');
    expect(SOURCE).toContain('className="count"');
  });

  it('puts the line items on the shared table treatment', () => {
    expect(SOURCE).toContain('<table className="grid-table">');
  });

  it('leaves the empty states of flow and history alone', () => {
    // These are content, not explanation: they say what is not there.
    expect(SOURCE).toContain('No related documents stand linked.');
    expect(SOURCE).toContain('No change documents stand retained for this document.');
  });
});
