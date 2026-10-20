import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SCR-134 / MB03 UI contract: the display is gated on INV.DISPLAY (the frozen
 * roadmap capability) rather than the list's, takes its tenant scope from the
 * session, asks for a required document number with the fiscal year and an
 * optional item beside it, shows the header with its poster and derived company
 * code, and shows every line with movement, material description, quantities,
 * value and reference — with no write of any kind.
 */
const capability = 'INV.DISPLAY';
const page = readFileSync('src/app/inventory/material-documents/page.tsx', 'utf8');
const service = readFileSync('src/modules/inventory/material-document-display.ts', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');
const registry = readFileSync('scripts/seed.ts', 'utf8');

describe('SCR-134 material document display UI contract', () => {
  it('gates the screen on the roadmap capability and takes tenant scope from the session', () => {
    expect(service).toContain(`export const MATERIAL_DOC_DISPLAY_CAPABILITY = '${capability}'`);
    expect(page).toContain('can(session, MATERIAL_DOC_DISPLAY_CAPABILITY)');
    expect(page).toContain('session.user.client');
    expect(page).not.toContain('params.client');
  });

  it('asks for a required document number, with the year and the item beside it', () => {
    expect(page).toContain('name="document"');
    expect(page).toMatch(/required/);
    expect(page).toContain('mdDoc.year');
    expect(page).toContain('name="fiscalYear"');
    expect(page).toContain('name="item"');
    expect(page).toContain('mdDoc.lookupHint');
  });

  it('shows the header with its poster, entry time and derived company code', () => {
    expect(page).toContain('data-posted-by={document.postedBy}');
    expect(page).toContain('document.enteredAt');
    expect(page).toContain('data-company-codes={document.companyCodes.join(');
    expect(service).toContain('Derived from the plants the lines stand in');
  });

  it('shows every line with movement, material description, quantities, value and reference', () => {
    expect(page).toContain('data-item={line.lineNumber}');
    expect(page).toContain('data-direction={line.lineDirection}');
    expect(page).toContain('line.movementDescription');
    expect(page).toContain('line.materialDescription');
    expect(page).toContain('mdDoc.columnValue');
    expect(page).toContain('line.purchaseOrderNumber');
  });

  it('refuses a missing or foreign document in the SAP shape and says why', () => {
    expect(service).toContain('does not exist.');
    expect(page).toContain('role="alert"');
    expect(page).toContain('remedy');
    expect(messages).toContain("'mdDoc.numberRequired'");
  });

  it('cross-checks the fiscal year instead of ignoring it', () => {
    expect(service).toContain('does not exist in fiscal year');
    expect(page).toContain('name="fiscalYear"');
    expect(service).toContain('A fiscal year that disagrees with the document is refused rather than ignored.');
  });

  it('narrows to one item when one is named', () => {
    expect(service).toContain('carries no item');
    expect(page).toContain('mdDoc.itemNarrowed');
  });

  it('writes nothing: a display has no posting, no reversal and no period check', () => {
    expect(service).not.toMatch(/postGoodsReceipt|reverseGoodsReceipt/);
    expect(service).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(page).not.toMatch(/postGoodsReceipt|reverseGoodsReceipt/);
    expect(service).toContain('no period check');
  });

  it('drills to the accounting document and names only the drill still deferred', () => {
    // SCR-137 delivered FIN.JOURNAL.DISPLAY: the journal number is a link now, and
    // the "shown as text" note it used to carry is gone with the deferral.
    expect(page).toContain('/finance/journal/document?document=');
    expect(service).not.toContain('FIN.JOURNAL.DISPLAY` is still Roadmap');
    expect(service).toContain('FIN.JOURNAL.DISPLAY');
    expect(messages).not.toContain("'mdDoc.journalDeferred'");
    expect(messages).toContain("'mdDoc.reservationDeferred'");
  });

  it('registers INV.DISPLAY with its route and its alias', () => {
    expect(registry).toContain(`'${capability}'`);
    expect(registry).toContain("aliases: ['MB03']");
    expect(registry).toContain("route: '/inventory/material-documents'");
    expect(messages).toContain("'mdDoc.title': 'Display Material Document'");
  });
});
